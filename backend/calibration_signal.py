"""Atmos signal algorithms isolated for the lab service.

Extracted without algorithm changes; parity is checked against server.py.
"""
import math
from fastapi import HTTPException


def signal_endpoints(read_points, authorize, baseline=None):
    chromatogram_points_for_trace = read_points
    require_dataset_access = authorize
    get_global_baseline = baseline

    def integrate_peak_window(dataset_id, payload, user=None) -> dict:
        """Integrate a chromatographic peak using the full-resolution scan data
        cached on the server. The frontend's display chromatogram may be LOD-
        reduced; this endpoint always operates on the raw points so the area
        matches ChemStation regardless of the user's zoom level."""
        require_dataset_access(dataset_id, user)
        trace_kind, full_points = chromatogram_points_for_trace(dataset_id, payload.get("trace"))
        if not full_points:
            raise HTTPException(status_code=404, detail="No chromatogram for dataset")
    
        try:
            left = float(payload.get("left"))
            right = float(payload.get("right"))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="left and right (RT) required")
        if right < left:
            left, right = right, left
    
        import numpy as np
    
        # Preserve the exact bounds chosen on the chart. The previous implementation
        # only kept scans already inside the selection, which silently moved both
        # edges to nearby samples and made the visible fill disagree with the drag.
        full_xs = np.fromiter((point.x for point in full_points), dtype=np.float64, count=len(full_points))
        full_ys = np.fromiter((point.y for point in full_points), dtype=np.float64, count=len(full_points))
        if len(full_xs) < 2:
            raise HTTPException(status_code=400, detail="Chromatogram contains too few raw scans")
        if np.any(np.diff(full_xs) < 0):
            order = np.argsort(full_xs, kind="stable")
            full_xs = full_xs[order]
            full_ys = full_ys[order]
    
        data_left = float(full_xs[0])
        data_right = float(full_xs[-1])
        if right <= data_left or left >= data_right:
            raise HTTPException(status_code=400, detail="Window falls outside the chromatogram")
        left = max(left, data_left)
        right = min(right, data_right)
        if right <= left:
            raise HTTPException(status_code=400, detail="Window contains too few raw scans")
    
        interior = (full_xs > left) & (full_xs < right)
        xs = np.concatenate((
            np.asarray([left], dtype=np.float64),
            full_xs[interior],
            np.asarray([right], dtype=np.float64),
        ))
        ys = np.concatenate((
            np.asarray([np.interp(left, full_xs, full_ys)], dtype=np.float64),
            full_ys[interior],
            np.asarray([np.interp(right, full_xs, full_ys)], dtype=np.float64),
        ))
        if len(xs) < 2:
            raise HTTPException(status_code=400, detail="Window contains too few raw scans")
        trap = getattr(np, "trapezoid", None) or np.trapz
    
        # Integrate the chromatogram in three useful conventions so we can compare
        # against whatever the source software (ChemStation, MassHunter, etc.) reports.
        #   T      = ∫ y dt   with t in minutes — "counts·min" units
        #   T·60   = ∫ y dt   with t in seconds — "counts·s" (most common ChemStation default)
        #   Σ y   ≈ T / avg_dx — sum of intensities across scans (some methods)
        # net_* values subtract a straight-line baseline drawn between the endpoints.
        area_counts_min = float(trap(ys, xs))
        total_dx_min = float(xs[-1] - xs[0])
        avg_dx_min = total_dx_min / max(len(xs) - 1, 1) if total_dx_min > 0 else 0
        area_counts_s = area_counts_min * 60.0
        sum_intensity = area_counts_min / avg_dx_min if avg_dx_min > 0 else area_counts_min
    
        # Baseline construction. Modes:
        #   - `endpoints` (default) — straight line between ys[0] and ys[-1].
        #     Works for clean isolated peaks where the user drags right onto
        #     the baseline. For RIDER peaks (sitting on a larger neighbor's
        #     descending tail), this only works if the user drags with the
        #     endpoints ON the parent's tail at the rider's edges — then the
        #     diagonal baseline correctly approximates ChemStation's tangent
        #     skim. If the user drags too wide (endpoints down at the true
        #     floor while the rider sits high on the tail), ATMOS will
        #     report the rider PLUS tail mass — much bigger than ChemStation.
        #   - `zero` — flat baseline at y=0. Useful for chromatograms with
        #     a stable, near-zero baseline where ChemStation effectively
        #     does the same. Will *over-report* rider peaks because tail
        #     mass underneath the rider is now counted.
        #   - `valley` — flat baseline at min(ys) across the whole segment.
        #     Robust to drag imprecision but ignores baseline drift.
        baseline_mode = str(payload.get("baseline_mode") or "endpoints").lower()
        if baseline_mode == "zero":
            y_left = 0.0
            y_right = 0.0
        elif baseline_mode == "valley":
            floor = float(np.min(ys))
            y_left = floor
            y_right = floor
        elif baseline_mode == "global":
            # ChemStation-style polyline baseline. Pre-compute once per
            # (dataset, trace); look up the baseline at this peak's left
            # and right RTs. Between two adjacent anchor points the
            # baseline is straight, so trapezoidal area from y_left to
            # y_right approximates the integral under the polyline within
            # the peak segment.
            bl_xs, bl_ys = get_global_baseline(dataset_id, trace_kind, full_points)
            y_left = float(np.interp(float(xs[0]), bl_xs, bl_ys))
            y_right = float(np.interp(float(xs[-1]), bl_xs, bl_ys))
        else:
            y_left = float(ys[0])
            y_right = float(ys[-1])
    
        baseline_at_x = lambda x: y_left + ((x - xs[0]) / max(xs[-1] - xs[0], 1e-12)) * (y_right - y_left)
        baseline_area_min = ((y_left + y_right) / 2.0) * (xs[-1] - xs[0])
        baseline_area_s = baseline_area_min * 60.0
        baseline_sum_intensity = baseline_area_min / avg_dx_min if avg_dx_min > 0 else baseline_area_min
    
        # Reported `area` is `area_counts_s × area_multiplier`, where the
        # multiplier is the per-call "match the source software's reporting
        # units" knob. ChemStation MS-Quant historically defaults around 60
        # (giving ≈ T × 3600 from raw counts·min), so that's our default.
        # Different methods or different vendors may need a different value;
        # the caller can pass `area_multiplier` in the request body to override.
        try:
            area_multiplier = float(payload.get("area_multiplier"))
        except (TypeError, ValueError):
            area_multiplier = 60.0
        if not math.isfinite(area_multiplier) or area_multiplier == 0:
            area_multiplier = 60.0
        area = area_counts_s * area_multiplier
        baseline_area = baseline_area_s * area_multiplier
        net_area = area - baseline_area
    
        above_baseline = ys - np.fromiter((baseline_at_x(x) for x in xs), dtype=np.float64, count=len(xs))
        apex_idx = int(np.argmax(above_baseline))
        apex_x = float(xs[apex_idx])
        apex_y = float(ys[apex_idx])
        peak_height = float(above_baseline[apex_idx])
    
        # ── Peak-shape metrics (FWHM, tailing factor, plate count) ────────────
        # All derived from the baseline-subtracted segment. These are standard
        # chromatography KPIs used to gauge method efficiency and peak symmetry.
        # FWHM = full width at half max (baseline-corrected). Plate count N =
        # 5.54 × (RT/FWHM)² assuming Gaussian shape. Tailing factor (USP) at
        # 5% height = total_width_5pct / (2 × front_width_5pct).
        def _width_at_fraction(fraction: float) -> tuple[float, float, float]:
            """Return (front_half_width, back_half_width, total_width) at a
            given fraction of the apex height. Linear interpolation between
            adjacent scans for sub-scan precision."""
            target = peak_height * fraction
            if target <= 0 or above_baseline[apex_idx] <= target:
                return 0.0, 0.0, 0.0
            # Walk left from apex.
            left_x = float(xs[0])
            for i in range(apex_idx, 0, -1):
                if above_baseline[i] <= target:
                    # Interpolate between i and i+1.
                    y0, y1 = above_baseline[i], above_baseline[i + 1]
                    x0, x1 = xs[i], xs[i + 1]
                    if y1 != y0:
                        left_x = float(x0 + (target - y0) / (y1 - y0) * (x1 - x0))
                    else:
                        left_x = float(x0)
                    break
            # Walk right from apex.
            right_x = float(xs[-1])
            for i in range(apex_idx, len(xs) - 1):
                if above_baseline[i + 1] <= target:
                    y0, y1 = above_baseline[i], above_baseline[i + 1]
                    x0, x1 = xs[i], xs[i + 1]
                    if y1 != y0:
                        right_x = float(x0 + (target - y0) / (y1 - y0) * (x1 - x0))
                    else:
                        right_x = float(x1)
                    break
            front = apex_x - left_x
            back = right_x - apex_x
            return front, back, front + back
    
        fwhm_front, fwhm_back, fwhm = _width_at_fraction(0.5)
        width_5_front, width_5_back, width_5 = _width_at_fraction(0.05)
        width_10_front, width_10_back, width_10 = _width_at_fraction(0.10)
    
        # USP tailing factor at 5% height. If front width is zero (peak chops
        # off the left edge of the integration window) we report None — Inf is
        # technically correct but causes JSON serialization headaches and the
        # UI just hides the metric.
        tailing_factor = None
        if width_5 > 0 and width_5_front > 0:
            tailing_factor = width_5 / (2.0 * width_5_front)
    
        # Asymmetry factor (As, sometimes called As(EP)) at 10% height —
        # tailing in the front-vs-back sense. As = back_10% / front_10%
        asymmetry_factor = None
        if width_10_front > 0:
            asymmetry_factor = width_10_back / width_10_front
    
        # Plate count (theoretical plates) — Gaussian approximation N = 5.54 * (tR / W½)²
        # Some labs report N = 16 * (tR / Wb)² using baseline width; we use FWHM
        # which is more robust to baseline-drawing choices.
        plate_count = None
        if fwhm > 0 and apex_x > 0:
            plate_count = 5.54 * (apex_x / fwhm) ** 2
    
        # Keep the fill polygon dense enough to follow narrow, asymmetric peaks.
        # Integration windows are bounded, so this remains a modest response even
        # for high-resolution datasets.
        max_display_points = 1600
        if len(xs) > max_display_points:
            idx = np.unique(np.linspace(0, len(xs) - 1, max_display_points).round().astype(int))
            seg_out = [
                {"x": float(xs[i]), "y": float(ys[i])}
                for i in idx
            ]
        else:
            seg_out = [
                {"x": float(x), "y": float(y)}
                for x, y in zip(xs, ys)
            ]
    
        return {
            "left": float(xs[0]),
            "right": float(xs[-1]),
            "trace": trace_kind,
            "area": area,
            "baseline_area": baseline_area,
            "net_area": net_area,
            "apex_x": apex_x,
            "apex_y": apex_y,
            "peak_height": peak_height,
            "y_left": y_left,
            "y_right": y_right,
            "scans": int(len(xs)),
            "segment": seg_out,
            # Peak-shape metrics — see chromatography textbooks. Returned even
            # when undefined (front-cut peaks, single-scan windows) by sending
            # None values; the UI hides metrics that aren't present.
            "shape_metrics": {
                "fwhm": fwhm if fwhm > 0 else None,
                "fwhm_front": fwhm_front if fwhm_front > 0 else None,
                "fwhm_back": fwhm_back if fwhm_back > 0 else None,
                "width_5pct": width_5 if width_5 > 0 else None,
                "width_10pct": width_10 if width_10 > 0 else None,
                "tailing_factor": tailing_factor,
                "asymmetry_factor": asymmetry_factor,
                "plate_count": plate_count,
            },
            # Diagnostic block so the UI (or you in DevTools) can see every area
            # convention side-by-side and pick the one that matches the source.
            "area_breakdown": {
                "counts_min": area_counts_min,
                "counts_s": area_counts_s,
                "sum_intensity": sum_intensity,
                "net_counts_min": area_counts_min - baseline_area_min,
                "net_counts_s": area_counts_s - baseline_area_s,
                "net_sum_intensity": sum_intensity - baseline_sum_intensity,
                "avg_dx_min": avg_dx_min,
                "avg_dx_s": avg_dx_min * 60.0,
                "scans": int(len(xs)),
            },
        }

    def auto_peaks(dataset_id, payload, user=None) -> dict:
        """Tunable peak detector with on-the-fly integration.
    
        Pipeline:
          1. Pull full-resolution scan data for the requested trace in the requested
             RT window (defaults to the entire run).
          2. Optional Savitzky–Golay smoothing (off by default — most modern
             GC-MS data is already smooth enough that smoothing loses signal).
          3. Estimate noise using the MAD of the bottom-quartile points (robust
             to peak signal contamination, unlike a global std).
          4. scipy.signal.find_peaks with the user's prominence/height/distance
             /width thresholds. Prominence is the dominant tuning knob — Stein
             & Scott's MS Quant default is ~0.5% of max signal.
          5. For each detected peak, derive integration boundaries by either
             walking out to the nearest local minimum ('valley'), dropping to
             half of the prominence ('half_height'), or fixing a window around
             the apex ('fixed_window').
          6. Integrate every peak using the same counts·s × 60 convention as
             the manual /integrate endpoint so areas are directly comparable.
          7. Filter by SNR (peak height / noise) if requested.
    
        All thresholds have safe defaults so a request with empty payload still
        returns a reasonable peak list.
        """
        require_dataset_access(dataset_id, user)
        trace_kind, full_points = chromatogram_points_for_trace(dataset_id, payload.get("trace"))
        if not full_points:
            raise HTTPException(status_code=404, detail="No chromatogram for dataset")
    
        # ── Parse + clamp parameters ─────────────────────────────────────────
        def _f(key, default, lo=None, hi=None):
            try:
                value = float(payload.get(key, default))
            except (TypeError, ValueError):
                value = default
            if lo is not None:
                value = max(lo, value)
            if hi is not None:
                value = min(hi, value)
            return value
    
        prominence_pct = _f("prominence_pct", 0.5, 0.0, 100.0)   # % of max signal
        height_pct = _f("height_pct", 0.0, 0.0, 100.0)
        min_separation_s = _f("min_separation_s", 1.0, 0.0, 600.0)
        min_width_s = _f("min_width_s", 0.0, 0.0, 600.0)
        smoothing_window = int(_f("smoothing_window", 0, 0, 51))
        snr_threshold = _f("snr_threshold", 0.0, 0.0, 1000.0)
        baseline_over_pct = _f("baseline_over_pct", 0.0, 0.0, 1000.0)
        prominence_noise_mult = _f("prominence_noise_mult", 0.0, 0.0, 1000.0)
        max_peaks = int(_f("max_peaks", 200, 1, 2000))
        prominence_reference = str(payload.get("prominence_reference") or "max").strip().lower()
    
        boundary_mode = str(payload.get("boundary_mode") or "valley").lower()
        if boundary_mode not in {"valley", "half_height", "fixed_window"}:
            boundary_mode = "valley"
        fixed_window_s = _f("fixed_window_s", 6.0, 0.5, 120.0)
        # Reporting-unit multiplier — see /integrate for context.
        try:
            area_multiplier = float(payload.get("area_multiplier"))
        except (TypeError, ValueError):
            area_multiplier = 60.0
        if not math.isfinite(area_multiplier) or area_multiplier == 0:
            area_multiplier = 60.0
    
        start_raw = payload.get("start")
        end_raw = payload.get("end")
        rt_min_full = full_points[0].x
        rt_max_full = full_points[-1].x
        start = float(start_raw) if start_raw is not None else rt_min_full
        end = float(end_raw) if end_raw is not None else rt_max_full
        if end < start:
            start, end = end, start
    
        window = [point for point in full_points if start <= point.x <= end]
        if len(window) < 8:
            return {"peaks": [], "window": {"start": start, "end": end}, "noise": 0.0}
    
        import numpy as np
        from scipy.signal import find_peaks, peak_prominences, savgol_filter
    
        rt = np.fromiter((p.x for p in window), dtype=np.float64, count=len(window))
        tic = np.fromiter((p.y for p in window), dtype=np.float64, count=len(window))
    
        # Optional smoothing — only if window length is sensible (odd, >= 5,
        # at most 1/4 of the data length so we don't over-smooth short windows).
        smoothed = tic
        if smoothing_window >= 5 and smoothing_window < len(tic):
            win = smoothing_window if smoothing_window % 2 == 1 else smoothing_window + 1
            if win < len(tic):
                try:
                    smoothed = savgol_filter(tic, window_length=win, polyorder=min(3, win - 1))
                except Exception:
                    smoothed = tic
    
        # Robust noise estimate from the bottom quartile (peaks live in the top).
        sorted_signal = np.sort(smoothed)
        bottom_quartile = sorted_signal[: max(8, len(sorted_signal) // 4)]
        noise_median = float(np.median(bottom_quartile))
        noise_mad = float(np.median(np.abs(bottom_quartile - noise_median)))
        # 1.4826 is the standard scaling that makes MAD match σ for normal noise.
        noise = max(noise_mad * 1.4826, 1e-9)
    
        max_signal = float(smoothed.max())
        if max_signal <= 0:
            return {"peaks": [], "window": {"start": start, "end": end}, "noise": noise}
    
        avg_dx_s = float((rt[-1] - rt[0]) * 60.0 / max(len(rt) - 1, 1))
        distance_scans = max(1, int(round(min_separation_s / max(avg_dx_s, 1e-6))))
        width_scans = max(0, int(round(min_width_s / max(avg_dx_s, 1e-6))))
    
        height_threshold = (height_pct / 100.0) * max_signal
        prominence_signal = max_signal
        if prominence_reference in {"robust", "percentile", "p99"}:
            try:
                prominence_signal = float(np.percentile(smoothed, 99.0))
            except Exception:
                prominence_signal = max_signal
            prominence_signal = max(prominence_signal, noise_median + noise)
        prominence_threshold = (prominence_pct / 100.0) * prominence_signal
        if prominence_noise_mult > 0:
            noise_prominence = noise * prominence_noise_mult
            prominence_threshold = min(prominence_threshold, noise_prominence) if prominence_threshold > 0 else noise_prominence
    
        find_kwargs = {
            "distance": distance_scans,
            "prominence": prominence_threshold if prominence_threshold > 0 else None,
            "height": height_threshold if height_threshold > 0 else None,
        }
        if width_scans > 0:
            find_kwargs["width"] = width_scans
        # scipy.find_peaks rejects None values — strip them out.
        find_kwargs = {k: v for k, v in find_kwargs.items() if v is not None}
    
        peak_indices, properties = find_peaks(smoothed, **find_kwargs)
        if not len(peak_indices):
            return {"peaks": [], "window": {"start": start, "end": end}, "noise": noise}
    
        # ── Boundary derivation per peak ─────────────────────────────────────
        # Never walk through a neighboring higher peak while ignoring apex ripples.
        prominences, left_bases, right_bases = peak_prominences(smoothed, peak_indices)
        prominence_by_apex = dict(zip(peak_indices, prominences))
        prominence_bounds = {
            int(apex): (int(left), int(right))
            for apex, left, right in zip(peak_indices, left_bases, right_bases)
        }
        def _walk_to_valley(apex_idx: int) -> tuple[int, int]:
            """Walk left/right from apex until we hit a local minimum. A local
            minimum is where the signal is lower than both neighbors AND lower
            than 60% of the apex value (so we don't snap to tiny ripples)."""
            left_limit, right_limit = prominence_bounds[apex_idx]
            local_floor = max(smoothed[left_limit], smoothed[right_limit])
            threshold = local_floor + 0.05 * (smoothed[apex_idx] - local_floor)
            valley_ceiling = local_floor + 0.60 * (smoothed[apex_idx] - local_floor)
            left_idx = apex_idx
            for i in range(apex_idx - 1, left_limit - 1, -1):
                left_idx = i
                if smoothed[i] <= threshold:
                    break
                if i > 0 and smoothed[i] <= valley_ceiling and smoothed[i] < smoothed[i - 1] and smoothed[i] < smoothed[i + 1]:
                    break
            right_idx = apex_idx
            for i in range(apex_idx + 1, right_limit + 1):
                right_idx = i
                if smoothed[i] <= threshold:
                    break
                if i < len(smoothed) - 1 and smoothed[i] <= valley_ceiling and smoothed[i] < smoothed[i - 1] and smoothed[i] < smoothed[i + 1]:
                    break
            return max(0, left_idx), min(len(smoothed) - 1, right_idx)
    
        def _walk_to_half_height(apex_idx: int) -> tuple[int, int]:
            prominence = float(properties.get("prominences", [smoothed[apex_idx]])[
                list(peak_indices).index(apex_idx)
            ]) if "prominences" in properties else float(smoothed[apex_idx] - noise_median)
            threshold = smoothed[apex_idx] - 0.5 * prominence
            left_idx = apex_idx
            for i in range(apex_idx - 1, -1, -1):
                left_idx = i
                if smoothed[i] <= threshold:
                    break
            right_idx = apex_idx
            for i in range(apex_idx + 1, len(smoothed)):
                right_idx = i
                if smoothed[i] <= threshold:
                    break
            return left_idx, right_idx
    
        def _fixed_window(apex_idx: int) -> tuple[int, int]:
            half_min = (fixed_window_s / 60.0) / 2.0
            apex_x = rt[apex_idx]
            left_idx = int(np.searchsorted(rt, apex_x - half_min, side="left"))
            right_idx = int(np.searchsorted(rt, apex_x + half_min, side="right")) - 1
            return max(0, left_idx), min(len(rt) - 1, right_idx)
    
        boundary_fn = {
            "valley": _walk_to_valley,
            "half_height": _walk_to_half_height,
            "fixed_window": _fixed_window,
        }[boundary_mode]
    
        # ── Integrate each peak using the same conventions as /integrate ─────
        trap = getattr(np, "trapezoid", None) or np.trapz
        out: list[dict] = []
        for apex_idx in peak_indices:
            left_idx, right_idx = boundary_fn(int(apex_idx))
            if right_idx <= left_idx:
                continue
            seg_xs = rt[left_idx : right_idx + 1]
            seg_ys = tic[left_idx : right_idx + 1]  # use raw TIC for integration
            if seg_xs.size < 2:
                continue
            area_counts_min = float(trap(seg_ys, seg_xs))
            total_dx_min = float(seg_xs[-1] - seg_xs[0])
            area_counts_s = area_counts_min * 60.0
            # Reporting-unit multiplier — same knob as /integrate. The caller
            # passes `area_multiplier` to make ATMOS's reported area match
            # whatever software the lab compares against (ChemStation default
            # ~60 → effective counts·s × 60).
            area = area_counts_s * area_multiplier
    
            # Straight-line endpoint baseline. The auto-peak detector itself
            # chooses the segment bounds (valley / half-height / fixed-window),
            # so the endpoints should already sit at sensible baseline levels.
            # Manual /integrate honors the user's `baseline_mode` choice; this
            # path stays on endpoints for now.
            y_left = float(seg_ys[0])
            y_right = float(seg_ys[-1])
            baseline_area_min = ((y_left + y_right) / 2.0) * total_dx_min
            baseline_area_s = baseline_area_min * 60.0
            baseline_area = baseline_area_s * area_multiplier
            net_area = area - baseline_area
    
            baseline_at_x = lambda x, yL=y_left, yR=y_right, xL=seg_xs[0], xR=seg_xs[-1]: (
                yL + ((x - xL) / max(xR - xL, 1e-12)) * (yR - yL)
            )
            above_baseline = seg_ys - np.fromiter((baseline_at_x(x) for x in seg_xs), dtype=np.float64, count=seg_xs.size)
            local_apex_idx = int(apex_idx) - left_idx
            peak_height = min(float(above_baseline[local_apex_idx]), float(prominence_by_apex[apex_idx]))
            baseline_at_apex = float(baseline_at_x(float(seg_xs[local_apex_idx])))
    
            snr = peak_height / noise if noise > 0 else 0.0
            if snr < snr_threshold:
                continue
            if baseline_over_pct > 0:
                baseline_floor = max(abs(baseline_at_apex), noise, 1e-9)
                baseline_gain_pct = (peak_height / baseline_floor) * 100.0
                if baseline_gain_pct < baseline_over_pct:
                    continue
    
            # Cap segment payload size for transport (front-end just needs enough
            # vertices to draw the integration polygon — full scan list is wasteful).
            if seg_xs.size > 200:
                idx = np.linspace(0, seg_xs.size - 1, 200).astype(int)
                seg_out = [{"x": float(seg_xs[i]), "y": float(seg_ys[i])} for i in idx]
            else:
                seg_out = [{"x": float(x), "y": float(y)} for x, y in zip(seg_xs, seg_ys)]
    
            out.append({
                "rt_apex": float(rt[apex_idx]),
                "rt_left": float(seg_xs[0]),
                "rt_right": float(seg_xs[-1]),
                "apex_y": float(tic[apex_idx]),
                "peak_height": peak_height,
                "area": area,
                "baseline_area": baseline_area,
                "net_area": net_area,
                "snr": snr,
                "baseline_gain_pct": (peak_height / max(abs(baseline_at_apex), noise, 1e-9)) * 100.0,
                "y_left": y_left,
                "y_right": y_right,
                "segment": seg_out,
            })
    
        # Ripples on one peak can resolve to identical valley boundaries. Search
        # that region once, at its strongest raw-signal apex.
        if boundary_mode == "valley":
            regions: dict[tuple[float, float], dict] = {}
            for peak in out:
                key = (peak["rt_left"], peak["rt_right"])
                if key not in regions or peak["apex_y"] > regions[key]["apex_y"]:
                    regions[key] = peak
            out = list(regions.values())
    
        # Sort by area descending so the most prominent peaks come first; cap.
        out.sort(key=lambda p: -p["net_area"])
        out = out[:max_peaks]
    
        return {
            "peaks": out,
            "window": {"start": start, "end": end},
            "noise": noise,
            "max_signal": max_signal,
            "avg_dx_s": avg_dx_s,
            "trace": trace_kind,
            "params_used": {
                "prominence_pct": prominence_pct,
                "prominence_reference": prominence_reference,
                "prominence_noise_mult": prominence_noise_mult,
                "height_pct": height_pct,
                "min_separation_s": min_separation_s,
                "min_width_s": min_width_s,
                "smoothing_window": smoothing_window,
                "snr_threshold": snr_threshold,
                "baseline_over_pct": baseline_over_pct,
                "boundary_mode": boundary_mode,
                "fixed_window_s": fixed_window_s,
            },
        }

    return auto_peaks, integrate_peak_window

