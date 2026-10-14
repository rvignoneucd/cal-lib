// Draft timestamps change on save; they do not establish which areas were reviewed.
export function currentDraftPreview(data, preview) {
  const next = {...data, preview}
  if (preview.normalized || !preview.fit) {
    next.fit = null
    next.fit_error = preview.issue || 'Normalized preview requires a reviewed internal-standard calibration before publication.'
    return next
  }
  const current = (preview.points || []).filter(point => !point.excluded)
  const reviewed = data.fit?.points || []
  const sameNumber = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= Math.max(1, Math.abs(a), Math.abs(b)) * 1e-12
  if (data.fit && (current.length !== reviewed.length || current.some(point => {
    const old = reviewed.find(item => item.dataset_id === point.dataset_id)
    return !old || !sameNumber(old.area, point.area) || !sameNumber(old.concentration, point.concentration)
  }))) {
    next.fit = null
    next.fit_error = 'Saved measurements changed. The current areas are shown in the provisional preview and will be reviewed when publishing.'
  }
  return next
}
