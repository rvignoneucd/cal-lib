"""Persisted automatic-area review state, mirrored by src/utils/areaReview.js."""
import math
import re


def _close(a, b):
    try:
        a, b = float(a), float(b)
        return math.isfinite(a) and math.isfinite(b) and abs(a - b) <= 1e-9 * max(1, abs(a), abs(b))
    except (TypeError, ValueError):
        return False


def auto_area_needs_review(peak):
    if not isinstance(peak, dict):
        return False
    try:
        left, right = float(peak.get('rt_left')), float(peak.get('rt_right'))
        if not math.isfinite(left) or not math.isfinite(right) or right - left <= 1e-12:
            return False
    except (TypeError, ValueError):
        return False
    provenance = peak.get('auto_integration')
    provenance = provenance if isinstance(provenance, dict) else {}
    automatic = (provenance.get('method') or str(peak.get('kind') or '').lower() == 'auto'
                 or re.search(r'-auto-\d{10,}-', str(peak.get('annotationId') or '')))
    if not automatic:
        return False
    reviewed = provenance.get('reviewed_geometry')
    if not provenance.get('manual_reviewed_at') or not isinstance(reviewed, dict):
        return True
    if not _close(left, reviewed.get('left')) or not _close(right, reviewed.get('right')):
        return True
    anchors = peak.get('manual_baseline')
    anchors = anchors if isinstance(anchors, list) and len(anchors) == 2 else None
    saved = reviewed.get('anchors')
    if anchors is None or saved is None:
        return anchors != saved
    return not (isinstance(saved, list) and len(saved) == 2 and all(
        isinstance(a, dict) and isinstance(b, dict) and _close(a.get('x'), b.get('x')) and _close(a.get('y'), b.get('y'))
        for a, b in zip(anchors, saved)))
