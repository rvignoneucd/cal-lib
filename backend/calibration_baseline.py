import numpy as np
from scipy.signal import peak_prominences, savgol_filter


def baseline_bounds(points, peaks):
    """Extend provisional tails to local baseline without crossing adjacent peaks."""
    xs = np.asarray([p.x for p in points])
    ys = np.asarray([p.y for p in points])
    smooth = savgol_filter(ys, 5, 2) if len(ys) >= 5 else ys
    apexes = [int(np.argmin(abs(xs - peak['rt_apex']))) for peak in peaks]
    result = []
    for peak_index, apex in enumerate(apexes):
        # Find the nearby smoothed apex before asking for prominence bases.
        lo, hi = max(0, apex - 2), min(len(xs), apex + 3)
        apex = lo + int(np.argmax(smooth[lo:hi]))
        _, lefts, rights = peak_prominences(smooth, [apex])
        width = max(peaks[len(result)]['rt_right'] - peaks[len(result)]['rt_left'], float(xs[1]-xs[0]))
        # Prominence bases can lie minutes away on an almost flat background.
        # Limit tail extension to one detected peak width on either side.
        left = max(int(lefts[0]), int(np.searchsorted(xs, peaks[len(result)]['rt_left'] - width)))
        right = min(int(rights[0]), int(np.searchsorted(xs, peaks[len(result)]['rt_right'] + width)), len(xs)-1)
        left = left + int(np.argmin(smooth[left:apex+1]))
        right = apex + int(np.argmin(smooth[apex:right+1]))
        for other_index, other in enumerate(apexes):
            if other_index == peak_index:
                continue
            if other < apex and other > left:
                left = other + int(np.argmin(smooth[other:apex + 1]))
            if other > apex and other < right:
                right = apex + int(np.argmin(smooth[apex:other + 1]))
        # A 5% cutoff truncates visible tails. Use the local floor plus 0.1%
        # of height; retain valley boundaries for unresolved neighboring peaks.
        left_threshold = smooth[left] + max(0, smooth[apex] - smooth[left]) * 0.001
        right_threshold = smooth[right] + max(0, smooth[apex] - smooth[right]) * 0.001
        l, r = apex, apex
        while l > left and smooth[l] > left_threshold:
            l -= 1
        while r < right and smooth[r] > right_threshold:
            r += 1
        result.append((float(xs[l]), float(xs[r])))
    return result
