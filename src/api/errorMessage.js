export async function apiErrorMessage(response) {
  const text = await response.text().catch(() => '')
  const status = `${response.status} ${response.statusText || ''}`.trim()
  const isHtml = /text\/html/i.test(response.headers?.get?.('content-type') || '') || /^\s*(?:<!doctype\s+html|<html|<!--)/i.test(text)
  if (!isHtml && response.status === 503) {
    try {
      const detail = JSON.parse(text)?.detail
      if (detail?.code === 'pubchem_unavailable' && typeof detail.message === 'string') {
        return detail.message.slice(0, 300)
      }
    } catch { /* Gateway responses still use the generic fallback below. */ }
  }
  if (isHtml || [502, 503, 504, 520, 521, 522, 523, 524].includes(response.status)) {
    return `${status}: The server is temporarily unavailable. Please retry.`
  }
  if (!text) return status
  try {
    const detail = JSON.parse(text)?.detail
    if (typeof detail === 'string' && detail.trim()) return `${status} - ${detail.trim()}`
    if (Array.isArray(detail) && detail.length) {
      const first = detail[0]
      return `${status} - ${first?.msg || first?.message || JSON.stringify(first)}`
    }
  } catch {
    // Non-JSON API errors may contain a short plain-text explanation.
  }
  return `${status} - ${text.slice(0, 240)}`
}
