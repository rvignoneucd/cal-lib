"""Agilent ChemStation GC-MS .D folder parser.

Extracts:
- TIC (total ion chromatogram, sum across m/z per scan)
- BPC (base peak chromatogram, max across m/z per scan)
- Per-scan mass spectra (preserved for later XIC/spectrum lookup)
- Detected peaks on the TIC via scipy.signal.find_peaks

Uses the `rainbow-api` library to read the binary DATA.MS files. Results are
cached on disk by source mtime so we don't re-parse the binary on every request.
"""

from __future__ import annotations

import json
import struct
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional

import numpy as np
import rainbow as rb
from rainbow.agilent import chemstation as rb_chemstation
from scipy.signal import find_peaks, peak_widths


@dataclass(frozen=True)
class GcmsPeak:
    rt_apex: float
    rt_left: float
    rt_right: float
    height: float
    area: float
    base_mz: float
    base_intensity: float


@dataclass
class GcmsRun:
    name: str
    source_path: str
    rt_min: float
    rt_max: float
    scan_count: int
    mz_min: float
    mz_max: float
    method: str
    acquired_at: str
    rt: list[float]
    tic: list[float]
    bpc: list[float]
    mz_axis: list[float]
    peaks: list[dict]


@dataclass
class GcmsChromRun:
    name: str
    source_path: str
    rt_min: float
    rt_max: float
    scan_count: int
    mz_min: float
    mz_max: float
    method: str
    acquired_at: str
    rt: list[float]
    tic: list[float]
    bpc: list[float]


def _read_method(method_path: Path) -> str:
    """Resolve a ChemStation .D run's method name to the human-readable
    `.M` method file basename — e.g. `HP5_THCS_ANALYSIS2` — rather than
    the section heading that previously leaked through.

    The acqmeth.txt header typically looks like:

        INSTRUMENT CONTROL PARAMETERS:    Dept GC-MS
        --------------------------------------------

           C:\\MSDCHEM\\1\\METHODS\\HP5_THCS_ANALYSIS2.M
              Thu May 07 12:39:07 2026

    Prior versions of this function fell back to returning line 1 (the
    "INSTRUMENT CONTROL PARAMETERS" section heading) for every Agilent
    run in the project, which made the file browser useless for telling
    methods apart. We now scan the first ~20 lines for a `.M`-suffixed
    path and return its basename, stripping the extension.
    """
    candidates = [method_path / "acqmeth.txt", method_path.parent / "acqmeth.txt"]
    for candidate in candidates:
        if not candidate.exists():
            continue
        try:
            text = candidate.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        # Preferred: a `.M` file path near the top of the header.
        for line in text.splitlines()[:20]:
            stripped = line.strip()
            if stripped.lower().endswith(".m") and len(stripped) > 2:
                segment = stripped.replace("\\", "/").split("/")[-1]
                return segment[:-2] if segment.lower().endswith(".m") else segment
        # Fallback for older ChemStation exports that explicitly list
        # "Method Name : <name>" — match the label, not lines that just
        # happen to start with "Method".
        for line in text.splitlines():
            if "Method Name" in line:
                parts = line.split(":", 1)
                if len(parts) == 2 and parts[1].strip():
                    return parts[1].strip()
        return "Unknown"
    return "Unknown"


def _read_run_started(folder: Path) -> str:
    """Returns an ISO datetime ('2026-04-28T13:24:41') of the run
    start, parsed from runstart.txt's asctime-style timestamp line.
    ChemStation typically writes the timestamp on the LAST non-empty
    line — e.g. `Tue Apr 28 13:24:41 2026`. The previous parser took
    the first line, which is usually a header / file path, not a
    date. We scan from the bottom up so the *most* recently written
    line wins, and we try a few common asctime variants to handle
    locale differences.
    """
    runstart = folder / "runstart.txt"
    if not runstart.exists():
        return ""
    try:
        text = runstart.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if not lines:
        return ""
    asctime_formats = (
        "%a %b %d %H:%M:%S %Y",  # "Tue Apr 28 13:24:41 2026"
        "%a %b  %d %H:%M:%S %Y",  # double-space day variant (single-digit days)
    )
    # Scan from the bottom — the timestamp is the very last non-empty
    # line in every ChemStation runstart.txt I've inspected.
    for line in reversed(lines):
        for fmt in asctime_formats:
            try:
                return datetime.strptime(line, fmt).isoformat()
            except ValueError:
                continue
    # Fallback to the old first-line behavior so legacy datasets with
    # non-asctime headers still produce *something* (which the front
    # end will drop from the date filter dropdown).
    return lines[0]


def detect_tic_peaks(rt: np.ndarray, tic: np.ndarray, mz_axis: np.ndarray, mass_data: np.ndarray) -> list[GcmsPeak]:
    if len(tic) < 16:
        return []
    smoothed = tic.astype(float)
    median = float(np.median(smoothed))
    noise = float(np.std(smoothed[:max(20, len(smoothed) // 30)]))
    threshold = max(median + 4 * noise, 0.02 * float(smoothed.max()))
    indices, properties = find_peaks(
        smoothed,
        height=threshold,
        prominence=max(0.005 * float(smoothed.max()), noise),
        distance=max(3, len(smoothed) // 800),
    )
    if not len(indices):
        return []

    widths_result = peak_widths(smoothed, indices, rel_height=0.5)
    left_ips = widths_result[2]
    right_ips = widths_result[3]

    peaks: list[GcmsPeak] = []
    for index, left_ip, right_ip in zip(indices, left_ips, right_ips):
        left_index = max(0, int(np.floor(left_ip)))
        right_index = min(len(rt) - 1, int(np.ceil(right_ip)))
        if right_index <= left_index:
            continue
        segment_rt = rt[left_index : right_index + 1]
        segment_intensity = smoothed[left_index : right_index + 1]
        if segment_rt.size < 2:
            continue
        baseline = (segment_intensity[0] + segment_intensity[-1]) / 2.0
        net = np.maximum(segment_intensity - baseline, 0.0)
        trap = getattr(np, "trapezoid", None) or np.trapz
        area = float(trap(net, segment_rt))
        height = float(smoothed[index] - baseline)
        if mass_data.size and mass_data.shape[1] == mz_axis.size:
            scan = mass_data[index]
            base_idx = int(np.argmax(scan))
            base_mz = float(mz_axis[base_idx])
            base_intensity = float(scan[base_idx])
        else:
            base_mz = 0.0
            base_intensity = 0.0
        peaks.append(
            GcmsPeak(
                rt_apex=float(rt[index]),
                rt_left=float(rt[left_index]),
                rt_right=float(rt[right_index]),
                height=height,
                area=area,
                base_mz=base_mz,
                base_intensity=base_intensity,
            )
        )

    peaks.sort(key=lambda peak: peak.rt_apex)
    return peaks


def _decode_pair_stats(pair_bytes: bytes) -> tuple[float, float, float, float]:
    if not pair_bytes:
        return 0.0, 0.0, 0.0, 0.0
    words = np.frombuffer(pair_bytes, dtype=">u2")
    if words.size < 2:
        return 0.0, 0.0, 0.0, 0.0
    mz_words = words[0::2].astype(np.float64, copy=False)
    int_encs = words[1::2].astype(np.uint32, copy=False)
    int_heads = int_encs >> 14
    int_tails = int_encs & 0x3fff
    intensities = int_tails * np.power(8, int_heads, dtype=np.uint32)
    mzs = mz_words / 20.0
    return (
        float(np.sum(intensities, dtype=np.float64)),
        float(np.max(intensities)) if intensities.size else 0.0,
        float(np.min(mzs)) if mzs.size else 0.0,
        float(np.max(mzs)) if mzs.size else 0.0,
    )


def _parse_ms_chromatograms_partial(path: Path) -> tuple[np.ndarray, np.ndarray, np.ndarray, float, float, dict]:
    short_unpack = struct.Struct(">H").unpack
    int_unpack = struct.Struct(">I").unpack
    times: list[int] = []
    tic: list[float] = []
    bpc: list[float] = []
    mz_min: float | None = None
    mz_max: float | None = None
    with path.open("rb") as handle:
        handle.seek(0x10A)
        if short_unpack(handle.read(2))[0] != 0:
            raise ValueError(f"Not a supported Agilent partial MS file: {path.name}")
        handle.seek(0x2F2)
        while True:
            marker = handle.read(2)
            if len(marker) < 2:
                break
            raw_time = handle.read(4)
            if len(raw_time) < 4:
                break
            time_value = int_unpack(raw_time)[0]
            if len(handle.read(6)) < 6:
                break
            raw_count = handle.read(2)
            if len(raw_count) < 2:
                break
            pair_count = short_unpack(raw_count)[0]
            if len(handle.read(4)) < 4:
                break
            pair_bytes = handle.read(pair_count * 4)
            if len(pair_bytes) < pair_count * 4:
                break
            handle.read(10)
            scan_tic, scan_bpc, scan_mz_min, scan_mz_max = _decode_pair_stats(pair_bytes)
            times.append(time_value)
            tic.append(scan_tic)
            bpc.append(scan_bpc)
            if scan_mz_max > 0:
                mz_min = scan_mz_min if mz_min is None else min(mz_min, scan_mz_min)
                mz_max = scan_mz_max if mz_max is None else max(mz_max, scan_mz_max)
        metadata = rb_chemstation.read_header(handle, {"date": 0xB2, "method": 0xE4}, 1)
    return (
        np.asarray(times, dtype=np.float64) / 60000.0,
        np.asarray(tic, dtype=np.float64),
        np.asarray(bpc, dtype=np.float64),
        float(mz_min or 0.0),
        float(mz_max or 0.0),
        metadata,
    )


def _parse_ms_chromatograms(path: Path) -> tuple[np.ndarray, np.ndarray, np.ndarray, float, float, dict]:
    data_offsets = {
        "type": 0x4,
        "data_start": 0x10A,
        "lc_num_times": 0x116,
        "gc_num_times": 0x142,
    }
    short_unpack = struct.Struct(">H").unpack
    int_unpack = struct.Struct(">I").unpack
    with path.open("rb") as handle:
        head = int_unpack(handle.read(4))[0]
        if head != 0x01320000:
            return _parse_ms_chromatograms_partial(path)

        type_ms = rb_chemstation.read_string(handle, data_offsets["type"], 1)
        if type_ms == "MSD Spectral File":
            handle.seek(data_offsets["lc_num_times"])
            num_times = int_unpack(handle.read(4))[0]
        else:
            handle.seek(data_offsets["gc_num_times"])
            num_times = struct.unpack("<H", handle.read(2))[0]

        handle.seek(data_offsets["data_start"])
        handle.seek(short_unpack(handle.read(2))[0] * 2 - 2)

        times = np.empty(num_times, dtype=np.float64)
        tic = np.zeros(num_times, dtype=np.float64)
        bpc = np.zeros(num_times, dtype=np.float64)
        mz_min: float | None = None
        mz_max: float | None = None
        for index in range(num_times):
            handle.read(2)
            times[index] = int_unpack(handle.read(4))[0] / 60000.0
            handle.read(6)
            pair_count = short_unpack(handle.read(2))[0]
            handle.read(4)
            pair_bytes = handle.read(pair_count * 4)
            handle.read(10)
            scan_tic, scan_bpc, scan_mz_min, scan_mz_max = _decode_pair_stats(pair_bytes)
            tic[index] = scan_tic
            bpc[index] = scan_bpc
            if scan_mz_max > 0:
                mz_min = scan_mz_min if mz_min is None else min(mz_min, scan_mz_min)
                mz_max = scan_mz_max if mz_max is None else max(mz_max, scan_mz_max)

        metadata = rb_chemstation.read_header(handle, {"date": 0xB2, "method": 0xE4}, 1)

    return times, tic, bpc, float(mz_min or 0.0), float(mz_max or 0.0), metadata


def parse_chromatograms(folder: Path) -> GcmsChromRun:
    if not folder.exists() or not folder.is_dir():
        raise FileNotFoundError(f"Not a directory: {folder}")
    ms_files = sorted(path for path in folder.iterdir() if path.is_file() and path.suffix.lower() == ".ms")
    if not ms_files:
        raise ValueError(f"No MS data file in {folder.name}")

    last_error: Exception | None = None
    for ms_file in ms_files:
        try:
            rt, tic, bpc, mz_min, mz_max, metadata = _parse_ms_chromatograms(ms_file)
        except Exception as exc:
            last_error = exc
            continue
        if rt.size:
            method = _read_method(folder)
            if method == "Unknown" and metadata.get("method"):
                method = metadata.get("method", "Unknown")
            acquired_at = _read_run_started(folder) or metadata.get("date", "")
            return GcmsChromRun(
                name=folder.name,
                source_path=str(folder),
                rt_min=float(rt.min()),
                rt_max=float(rt.max()),
                scan_count=int(rt.size),
                mz_min=mz_min,
                mz_max=mz_max,
                method=method,
                acquired_at=acquired_at,
                rt=rt.tolist(),
                tic=tic.tolist(),
                bpc=bpc.tolist(),
            )
    if last_error:
        raise last_error
    raise ValueError(f"No readable MS chromatogram in {folder.name}")


def parse_d_folder(folder: Path) -> GcmsRun:
    if not folder.exists() or not folder.is_dir():
        raise FileNotFoundError(f"Not a directory: {folder}")
    dataset = rb.read(str(folder))
    if not dataset.datafiles:
        raise ValueError(f"No datafiles in {folder.name}")
    file = dataset.datafiles[0]
    rt = np.asarray(file.xlabels, dtype=float)
    mz_axis = np.asarray(file.ylabels, dtype=float) if file.ylabels is not None else np.array([])
    data = np.asarray(file.data, dtype=float)
    if data.ndim == 1:
        data = data.reshape(-1, 1)
    if data.shape[0] != rt.size and data.shape[1] == rt.size:
        data = data.T

    tic = data.sum(axis=1)
    bpc = data.max(axis=1) if data.size else np.zeros_like(tic)

    method = _read_method(folder)
    acquired_at = _read_run_started(folder)

    peaks = detect_tic_peaks(rt, tic, mz_axis, data)

    return GcmsRun(
        name=folder.name,
        source_path=str(folder),
        rt_min=float(rt.min()) if rt.size else 0.0,
        rt_max=float(rt.max()) if rt.size else 0.0,
        scan_count=int(rt.size),
        mz_min=float(mz_axis.min()) if mz_axis.size else 0.0,
        mz_max=float(mz_axis.max()) if mz_axis.size else 0.0,
        method=method,
        acquired_at=acquired_at,
        rt=rt.tolist(),
        tic=tic.tolist(),
        bpc=bpc.tolist(),
        mz_axis=mz_axis.tolist(),
        peaks=[asdict(peak) for peak in peaks],
    )


def cache_path_for(source: Path, cache_root: Path) -> Path:
    from ..source_identity import parser_cache_key
    safe = parser_cache_key(source)
    return cache_root / f"gcms_{safe}.json"


def chrom_cache_path_for(source: Path, cache_root: Path) -> Path:
    from ..source_identity import parser_cache_key
    safe = parser_cache_key(source)
    return cache_root / f"gcms_chrom_{safe}.json"


def _chrom_run_from_full_cache(folder: Path, cache_root: Path) -> GcmsChromRun | None:
    cache_file = cache_path_for(folder, cache_root)
    if not cache_file.exists():
        return None
    try:
        folder_mtime = folder.stat().st_mtime
        with cache_file.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
        cached_run = payload.get("run") or {}
        if (
            payload.get("schema_version") == 3
            and (
                payload.get("mtime") == folder_mtime
            )
        ):
            run = GcmsRun(**cached_run)
            return GcmsChromRun(
                name=run.name,
                source_path=run.source_path,
                rt_min=run.rt_min,
                rt_max=run.rt_max,
                scan_count=run.scan_count,
                mz_min=run.mz_min,
                mz_max=run.mz_max,
                method=run.method,
                acquired_at=run.acquired_at,
                rt=run.rt,
                tic=run.tic,
                bpc=run.bpc,
            )
    except Exception:
        return None
    return None


def parse_chromatograms_or_cached(folder: Path, cache_root: Optional[Path] = None) -> GcmsChromRun:
    if cache_root is None:
        return parse_chromatograms(folder)
    cache_root.mkdir(parents=True, exist_ok=True)

    full_cache = _chrom_run_from_full_cache(folder, cache_root)
    if full_cache is not None:
        return full_cache

    cache_file = chrom_cache_path_for(folder, cache_root)
    folder_mtime = folder.stat().st_mtime
    if cache_file.exists():
        try:
            with cache_file.open("r", encoding="utf-8") as handle:
                payload = json.load(handle)
            cached_run = payload.get("run") or {}
            if (
                payload.get("schema_version") == 1
                and (
                    payload.get("mtime") == folder_mtime
                )
            ):
                return GcmsChromRun(**cached_run)
        except Exception:
            pass

    run = parse_chromatograms(folder)
    with cache_file.open("w", encoding="utf-8") as handle:
        json.dump(
            {
                "schema_version": 1,
                "mtime": folder_mtime,
                "cached_at": datetime.now().isoformat(timespec="seconds"),
                "run": asdict(run),
            },
            handle,
        )
    return run


def parse_or_cached(folder: Path, cache_root: Optional[Path] = None) -> GcmsRun:
    if cache_root is None:
        return parse_d_folder(folder)
    cache_root.mkdir(parents=True, exist_ok=True)
    cache_file = cache_path_for(folder, cache_root)
    folder_mtime = folder.stat().st_mtime
    if cache_file.exists():
        try:
            with cache_file.open("r", encoding="utf-8") as handle:
                payload = json.load(handle)
            # schema_version 3: `_read_run_started` parses ChemStation's
            # asctime-style timestamp from the LAST line of runstart.txt
            # and returns an ISO datetime, so `acquired_at` actually
            # carries a date. v2 caches held first-line garbage; v1
            # caches held a different method-name format. Invalidate
            # anything older than v3.
            cached_run = payload.get("run") or {}
            if (
                payload.get("schema_version") == 3
                and (
                    payload.get("mtime") == folder_mtime
                )
            ):
                return GcmsRun(**payload["run"])
        except Exception:
            pass
    run = parse_d_folder(folder)
    with cache_file.open("w", encoding="utf-8") as handle:
        json.dump(
            {
                "schema_version": 3,
                "mtime": folder_mtime,
                "cached_at": datetime.now().isoformat(timespec="seconds"),
                "run": asdict(run),
            },
            handle,
        )
    return run


def discover_d_folders(root: Path) -> list[Path]:
    if not root.exists():
        return []
    return sorted(p for p in root.iterdir() if p.is_dir() and p.name.lower().endswith(".d"))
