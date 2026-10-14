"""Black-box bridge for NIST MSPepSearch.

MSPepSearch is Windows-only, but it is useful as a parity oracle while ATMOS
grows a portable Python implementation. This module does not inspect or copy
the executable internals; it only writes a temporary MSP query, runs the public
command-line interface, and parses the tab-delimited output.

Two modes, same contract:

* **Local** - run MSPepSearch64.exe on this machine. What a Windows
  workstation does, unchanged.
* **Remote** - POST the query to an ATMOS NIST bridge running on a Windows
  host that has the library, and get the same hits back. This is what makes
  the engine usable from a Linux container, which otherwise cannot run the
  executable at all.

Remote is chosen only when ATMOS_MSPEPSEARCH_URL is set, so nothing changes
for an existing local install.
"""

from __future__ import annotations

import csv
import json
import os
import platform
import re
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Optional


@dataclass
class MSPepSearchHit:
    name: str
    formula: str = ""
    cas: str = ""
    nist_rn: str = ""
    mw: float = 0.0
    library: str = ""
    match_score: int = 0
    reverse_score: int = 0
    common_peaks: int = 0
    probability: float = 0.0
    rank: int = 0
    lib_id: str = ""
    in_lib: str = ""


_SEARCH_SEMAPHORE = threading.BoundedSemaphore(max(1, int(os.getenv("ATMOS_MSPEPSEARCH_CONCURRENCY", "1"))))


def _workspace_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _state_root() -> Path:
    configured = os.getenv("ATMOS_STATE_ROOT")
    if configured:
        path = Path(configured)
    else:
        path = Path(__file__).resolve().parents[2] / "server-state"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _bridge_log_path() -> Path:
    configured = os.getenv("ATMOS_NIST_BRIDGE_LOG")
    return Path(configured) if configured else _state_root() / "nist-bridge-searches.jsonl"


def _log_search_event(event: dict) -> None:
    payload = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        **event,
    }
    try:
        path = _bridge_log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, separators=(",", ":")) + "\n")
    except Exception:
        pass


def hit_to_dict(hit: MSPepSearchHit) -> dict:
    return asdict(hit)


def hits_to_dicts(hits: Iterable[MSPepSearchHit]) -> list[dict]:
    return [hit_to_dict(hit) for hit in hits]


def _nist_version_key(path: Path) -> tuple[int, str]:
    match = re.search(r"nist\D*(\d+)", path.name, re.IGNORECASE)
    return (int(match.group(1)) if match else -1, path.name.lower())


def _is_nist_root(path: Path) -> bool:
    if (path / "MSSEARCH").is_dir():
        return True
    return (path / "mainlib").is_dir() and (path / "replib").is_dir()


# Per-project override pushed by the server when a project is loaded.
# Takes precedence over env-var / workspace auto-discovery so a NIST
# install configured in the project editor (often outside the repo, e.g.
# C:\NIST23) is actually found instead of silently falling back to the
# Python engine. Cleared (None) for the demo project, so an operator's
# .env (ATMOS_NIST_*) stays the fallback. Mirrors msp_index's
# set_active_nist_root for the Python side.
_OVERRIDE_EXE: Optional[Path] = None
_OVERRIDE_ROOT: Optional[Path] = None


def set_active_nist_config(exe: object = None, nist_root: object = None) -> None:
    """Set (or clear, with None) the per-project MSPepSearch exe + NIST
    root override. Called from the server on every project load."""
    global _OVERRIDE_EXE, _OVERRIDE_ROOT
    _OVERRIDE_EXE = Path(str(exe)).expanduser() if exe else None
    _OVERRIDE_ROOT = Path(str(nist_root)).expanduser() if nist_root else None


def _configured_nist_roots() -> list[Path]:
    roots: list[Path] = []
    configured = os.getenv("ATMOS_NIST_ROOT")
    if configured:
        for part in configured.split(os.pathsep):
            if part.strip():
                roots.append(Path(part.strip()))
    return roots


def discover_nist_roots() -> list[Path]:
    """Return installed NIST roots, newest-looking version first."""
    roots: list[Path] = []
    seen: set[Path] = set()
    candidates: list[Path] = []
    if _OVERRIDE_ROOT is not None:
        candidates.append(_OVERRIDE_ROOT)
    candidates.extend(_configured_nist_roots())
    workspace = _workspace_root()
    if workspace.exists():
        candidates.extend(
            child
            for child in workspace.iterdir()
            if child.is_dir() and child.name.lower().startswith("nist")
        )
    candidates.append(workspace / "NIST20")
    candidates.extend([
        Path("C:/NIST23"),
        Path("C:/NIST23/MSSEARCH"),
        Path("C:/NIST20"),
        Path("C:/NIST20/MSSEARCH"),
    ])

    for candidate in candidates:
        resolved = candidate.resolve()
        if resolved in seen or not candidate.exists():
            continue
        if _is_nist_root(candidate):
            seen.add(resolved)
            roots.append(candidate)

    return sorted(roots, key=_nist_version_key, reverse=True)


def find_nist_root() -> Optional[Path]:
    roots = discover_nist_roots()
    return roots[0] if roots else None


def _mssearch_root_from_nist_root(root: Path) -> Optional[Path]:
    if (root / "MSSEARCH").is_dir():
        return root / "MSSEARCH"
    if (root / "mainlib").is_dir():
        return root
    return None


def find_mspepsearch_executable() -> Optional[Path]:
    if _OVERRIDE_EXE is not None and _OVERRIDE_EXE.is_file():
        return _OVERRIDE_EXE
    configured = os.getenv("ATMOS_NIST_PEPSEARCH")
    if configured:
        path = Path(configured)
        if path.is_file():
            return path
    for root in discover_nist_roots():
        candidates = [
            root / "2024_03_15_MSPepSearch_x64" / "2024_03_15_MSPepSearch_x64" / "MSPepSearch64.exe",
            root / "MSPepSearch64.exe",
            root / "MSSEARCH" / "MSPepSearch64.exe",
        ]
        candidates.extend(root.glob("**/MSPepSearch64.exe"))
        for candidate in candidates:
            if candidate.is_file():
                return candidate
    return None


def find_mspepsearch_in_dir(directory: Path) -> Optional[Path]:
    """Recursively search a user-provided directory (to ANY depth) for the
    MSPepSearch executable, preferring the 64-bit build. Returns the first
    match or None. Lets the project editor auto-fill the exe path from just
    the NIST library root (e.g. point at C:\\NIST23 and find the deeply
    nested MSSEARCH\\..\\MSPepSearch_x64\\MSPepSearch64.exe without
    hand-typing it).

    Uses os.walk with errors swallowed rather than Path.rglob: rglob
    propagates the first OSError it hits — an unreadable system folder, or
    a path over the Windows MAX_PATH limit — which aborts the whole walk
    before it can descend to the (often several-levels-deep) MSPepSearch
    folder. os.walk(onerror=...) skips the offending directory and keeps
    going, so a deep exe is still found."""
    if not directory.is_dir():
        return None
    fallback: Optional[Path] = None
    for current, _dirs, files in os.walk(str(directory), onerror=lambda _err: None):
        for filename in files:
            lowered = filename.lower()
            if lowered == "mspepsearch64.exe":
                return Path(current) / filename
            if lowered == "mspepsearch.exe" and fallback is None:
                fallback = Path(current) / filename
    return fallback


def find_mssearch_root() -> Optional[Path]:
    configured = os.getenv("ATMOS_NIST_LIBRARY_ROOT")
    if configured:
        path = Path(configured)
        if path.is_dir():
            return path
    for root in discover_nist_roots():
        candidate = _mssearch_root_from_nist_root(root)
        if candidate:
            return candidate
    return None


def remote_url() -> str:
    """Base URL of an ATMOS NIST bridge, or empty for local execution."""
    return (os.getenv("ATMOS_MSPEPSEARCH_URL") or "").strip().rstrip("/")


def _remote_post(path: str, payload: dict, timeout: int) -> dict:
    url = f"{remote_url()}{path}"
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": "application/json"})
    token = (os.getenv("ATMOS_MSPEPSEARCH_TOKEN") or "").strip()
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:400]
        raise RuntimeError(f"NIST bridge returned {error.code}: {detail}") from error
    except Exception as error:
        raise RuntimeError(f"NIST bridge at {remote_url()} unreachable: {error}") from error


def _hit_from_dict(row: dict) -> MSPepSearchHit:
    """Rebuild a hit from the bridge, ignoring fields this version does not know.

    Tolerating unknown keys means a newer bridge can add fields without
    breaking older clients.
    """
    fields = {f for f in MSPepSearchHit.__dataclass_fields__}
    return MSPepSearchHit(**{k: v for k, v in row.items() if k in fields})


def remote_status(timeout: int = 5) -> dict:
    """Ask the bridge what it has. Never raises - callers treat this as advisory."""
    if not remote_url():
        return {}
    try:
        request = urllib.request.Request(f"{remote_url()}/status")
        token = (os.getenv("ATMOS_MSPEPSEARCH_TOKEN") or "").strip()
        if token:
            request.add_header("Authorization", f"Bearer {token}")
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except Exception as error:
        return {"available": False, "error": str(error)}


def is_available() -> bool:
    # A configured bridge counts as available even though this host cannot run
    # the executable itself - that is the entire point of the remote mode.
    if remote_url():
        return True
    return platform.system().lower() == "windows" and bool(find_mspepsearch_executable() and find_mssearch_root())


def _library_kind(path: Path) -> str:
    lower = {child.name.lower() for child in path.iterdir() if child.is_file()}
    if "nist.db" in lower:
        return "main"
    if "nist.dbr" in lower:
        return "replicate"
    if "user.dbu" in lower:
        return "user"
    if any(name.endswith(".dbu") for name in lower):
        return "msms"
    return "unknown"


def _native_library_count(path: Path) -> int:
    readme = path / "README"
    if not readme.is_file():
        return 0
    try:
        text = readme.read_text(errors="ignore")
    except OSError:
        return 0
    patterns = (
        r"contain spectra of\s+([\d,]+)\s+compounds",
        r"contain\s+([\d,]+)\s+replicate spectra",
        r"contain\s+([\d,]+)\s+spectra",
    )
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if not match:
            continue
        try:
            return int(match.group(1).replace(",", ""))
        except ValueError:
            return 0
    return 0


def list_mspepsearch_libraries(mssearch_root: Optional[Path] = None) -> list[dict]:
    root = mssearch_root or find_mssearch_root()
    if not root or not root.is_dir():
        return []
    libraries: list[dict] = []
    for child in sorted(root.iterdir(), key=lambda item: item.name.lower()):
        if not child.is_dir():
            continue
        kind = _library_kind(child)
        if kind == "unknown":
            continue
        libraries.append({
            "name": child.name,
            "kind": kind,
            "path": str(child),
            "compound_count": _native_library_count(child),
        })
    return libraries


def bridge_status() -> dict:
    if remote_url():
        remote = remote_status()
        return {
            "available": bool(remote.get("available", False)),
            "mode": "remote",
            "remote_url": remote_url(),
            "platform": platform.system(),
            "executable": remote.get("executable", ""),
            "library_root": remote.get("library_root", ""),
            "installed_roots": remote.get("installed_roots", []),
            "libraries": remote.get("libraries", []),
            "concurrency": remote.get("concurrency", 1),
            "log_path": str(_bridge_log_path()),
            "remote_error": remote.get("error", ""),
        }
    exe = find_mspepsearch_executable()
    root = find_mssearch_root()
    return {
        "available": is_available(),
        "mode": "local",
        "platform": platform.system(),
        "executable": str(exe or ""),
        "library_root": str(root or ""),
        "installed_roots": [str(path) for path in discover_nist_roots()],
        "libraries": list_mspepsearch_libraries(root),
        "concurrency": max(1, int(os.getenv("ATMOS_MSPEPSEARCH_CONCURRENCY", "1"))),
        "log_path": str(_bridge_log_path()),
    }


def _write_query_msp(path: Path, mz_values: Iterable[float], intensity_values: Iterable[float], name: str) -> int:
    peaks = [
        (float(mz), float(intensity))
        for mz, intensity in zip(mz_values, intensity_values)
        if float(mz) > 0 and float(intensity) > 0
    ]
    if not peaks:
        raise ValueError("MSPepSearch query requires at least one positive mz/intensity peak")
    peaks.sort(key=lambda pair: pair[0])
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(f"Name: {name}\n")
        handle.write(f"Num Peaks: {len(peaks)}\n")
        for index, (mz, intensity) in enumerate(peaks, start=1):
            handle.write(f"{mz:g} {intensity:g}; ")
            if index % 5 == 0:
                handle.write("\n")
        handle.write("\n")
    return len(peaks)


def _to_int(value: str, default: int = 0) -> int:
    try:
        return int(round(float(value)))
    except (TypeError, ValueError):
        return default


def _to_float(value: str, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _parse_outtab(path: Path) -> list[MSPepSearchHit]:
    if not path.exists():
        return []
    rows: list[MSPepSearchHit] = []
    header: list[str] | None = None
    with path.open("r", encoding="utf-8", errors="ignore", newline="") as handle:
        for raw_line in handle:
            line = raw_line.rstrip("\r\n")
            if not line or line.startswith(">"):
                continue
            cells = next(csv.reader([line], delimiter="\t"))
            if header is None:
                if "Rank" in cells and "MF" in cells and "Name" in cells:
                    header = cells
                continue
            values = {key: cells[index] if index < len(cells) else "" for index, key in enumerate(header)}
            rows.append(
                MSPepSearchHit(
                    name=values.get("Name", ""),
                    formula=values.get("Formula", ""),
                    cas=values.get("CAS", ""),
                    nist_rn=values.get("NIST r.n.", ""),
                    mw=_to_float(values.get("Lib MW", "") or values.get("Mass", "")),
                    library=values.get("Library", ""),
                    match_score=_to_int(values.get("MF", "")),
                    reverse_score=_to_int(values.get("R.Match", "")),
                    common_peaks=_to_int(values.get("NumMP", "")),
                    probability=_to_float(values.get("Prob(%)", "")),
                    rank=_to_int(values.get("Rank", "")),
                    lib_id=values.get("Id", ""),
                    in_lib=values.get("InLib", ""),
                )
            )
    return rows


def search_spectrum_with_mspepsearch(
    mz_values: Iterable[float],
    intensity_values: Iterable[float],
    *,
    top_n: int = 10,
    min_score: int = 400,
    search_type: str = "I",
    library: str = "mainlib",
    query_name: str = "ATMOS unknown",
    executable: Optional[Path] = None,
    mssearch_root: Optional[Path] = None,
    timeout_seconds: int = 60,
    retries: int = 1,
    user_id: str = "",
    project_id: str = "",
    dataset_id: str = "",
) -> list[MSPepSearchHit]:
    peaks_in = [
        (float(mz), float(intensity))
        for mz, intensity in zip(mz_values, intensity_values)
        if float(mz) > 0 and float(intensity) > 0
    ]
    if not peaks_in:
        raise ValueError("MSPepSearch query requires at least one positive mz/intensity peak")

    # Remote first, and before the Windows-only guard below: a Linux container
    # can never run the executable, so on this host the guard would reject a
    # query the bridge is perfectly able to answer.
    if remote_url():
        started = time.perf_counter()
        payload = {
            "mz_values": [peak[0] for peak in peaks_in],
            "intensity_values": [peak[1] for peak in peaks_in],
            "top_n": int(top_n),
            "min_score": int(min_score),
            "search_type": search_type,
            "library": library,
            "query_name": query_name,
            "timeout_seconds": int(timeout_seconds),
            "retries": int(retries),
        }
        # Allow for the round trip on top of the search itself, so a query that
        # would just finish locally is not cut short by the transport.
        result = _remote_post("/search", payload, timeout=int(timeout_seconds) + 15)
        hits = [_hit_from_dict(row) for row in result.get("hits", [])]
        _log_search_event({
            "status": "ok",
            "engine": "mspepsearch",
            "mode": "remote",
            "remote_url": remote_url(),
            "duration_ms": round((time.perf_counter() - started) * 1000, 2),
            "query_name": query_name,
            "library": library,
            "search_type": search_type,
            "top_n": top_n,
            "hits": len(hits),
            "user_id": user_id,
            "project_id": project_id,
            "dataset_id": dataset_id,
        })
        return hits

    exe = executable or find_mspepsearch_executable()
    root = mssearch_root or find_mssearch_root()
    if platform.system().lower() != "windows":
        raise RuntimeError("MSPepSearch is Windows-only; set ATMOS_MSPEPSEARCH_URL "
                           "to use a remote NIST bridge, or use the Python engine")
    if not exe or not exe.is_file():
        raise RuntimeError("MSPepSearch64.exe not found")
    if not root or not root.is_dir():
        raise RuntimeError("NIST MSSEARCH library root not found")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", library):
        raise RuntimeError(f"Invalid NIST library name: {library}")
    library_path = root / library
    if not library_path.exists():
        raise RuntimeError(f"NIST library path not found: {library_path}")

    top_n = max(1, min(int(top_n), 200))
    min_score = max(0, min(int(min_score), 999))
    attempts = max(1, int(retries) + 1)
    last_error: Exception | None = None

    peaks = [
        (float(mz), float(intensity))
        for mz, intensity in zip(mz_values, intensity_values)
        if float(mz) > 0 and float(intensity) > 0
    ]
    if not peaks:
        raise ValueError("MSPepSearch query requires at least one positive mz/intensity peak")

    for attempt in range(1, attempts + 1):
        started = time.perf_counter()
        _SEARCH_SEMAPHORE.acquire()
        try:
            with tempfile.TemporaryDirectory(prefix="atmos_mspep_") as tmp_name:
                tmp = Path(tmp_name)
                inp = tmp / "query.msp"
                out = tmp / "hits.tsv"
                _write_query_msp(inp, [peak[0] for peak in peaks], [peak[1] for peak in peaks], query_name)
                command = [
                    str(exe),
                    search_type,
                    "/MAIN", str(library_path),
                    "/INP", str(inp),
                    "/OUTTAB", str(out),
                    "/HITS", str(top_n),
                    "/MinMF", str(min_score),
                    "/MaxNumSpec", "1",
                    "/OutChemForm",
                    "/OutCASrn",
                    "/OutNISTrn",
                    "/OutMW",
                    "/OutNumMP",
                    "v",
                ]
                result = subprocess.run(
                    command,
                    cwd=str(exe.parent),
                    capture_output=True,
                    text=True,
                    timeout=timeout_seconds,
                    check=False,
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                )
                if result.returncode != 0 and not out.exists():
                    message = (result.stderr or result.stdout or "MSPepSearch failed").strip()
                    raise RuntimeError(message)
                hits = _parse_outtab(out)
                _log_search_event({
                    "status": "ok",
                    "engine": "mspepsearch",
                    "attempt": attempt,
                    "duration_ms": round((time.perf_counter() - started) * 1000, 2),
                    "query_name": query_name,
                    "library": library,
                    "search_type": search_type,
                    "top_n": top_n,
                    "min_score": min_score,
                    "peak_count": len(peaks),
                    "hit_count": len(hits),
                    "user_id": user_id,
                    "project_id": project_id,
                    "dataset_id": dataset_id,
                })
                return hits
        except Exception as exc:
            last_error = exc
            _log_search_event({
                "status": "error",
                "engine": "mspepsearch",
                "attempt": attempt,
                "duration_ms": round((time.perf_counter() - started) * 1000, 2),
                "query_name": query_name,
                "library": library,
                "search_type": search_type,
                "top_n": top_n,
                "min_score": min_score,
                "peak_count": len(peaks),
                "hit_count": 0,
                "error": str(exc),
                "user_id": user_id,
                "project_id": project_id,
                "dataset_id": dataset_id,
            })
            if attempt >= attempts:
                break
            time.sleep(min(0.25 * attempt, 1.0))
        finally:
            _SEARCH_SEMAPHORE.release()

    raise RuntimeError(str(last_error or "MSPepSearch failed"))
