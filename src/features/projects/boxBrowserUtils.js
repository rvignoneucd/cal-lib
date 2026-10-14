const DATA_EXTENSIONS = new Set([
  'csv', 'tsv', 'txt', 'xls', 'xlsx', 'd', 'raw', 'hps', 'cdf',
  'mzml', 'mzxml', 'ch', 'dx', 'jdx', 'vspd', 'spc', 'spa',
  'acg', 'ams', 'atdb', 'msp', 'mgf', 'sdf', 'mol', 'mol2',
])

export function isBoxDataEntry(entry, patterns = null) {
  if (entry.is_dir) return true
  const extension = String(entry.name || '').split('.').pop().toLowerCase()
  return patterns == null
    ? DATA_EXTENSIONS.has(extension)
    : patterns.some((pattern) => pattern.toLowerCase() === `.${extension}`)
}

export function selectBoxRows(rows, selectedIds, id, anchorId, { shiftKey, ctrlKey, metaKey, toggle } = {}) {
  const index = rows.findIndex((row) => String(row.id) === id)
  const anchor = rows.findIndex((row) => String(row.id) === anchorId)
  if (shiftKey && index >= 0 && anchor >= 0) {
    const next = new Set(ctrlKey || metaKey ? selectedIds : [])
    rows.slice(Math.min(index, anchor), Math.max(index, anchor) + 1).forEach((row) => next.add(String(row.id)))
    return next
  }
  if (ctrlKey || metaKey || toggle) {
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  }
  return new Set([id])
}
export function filterBoxEntries(entries, query) {
  const includes = [], excludes = []
  // An unfinished quote remains an exclusion while the user is typing.
  for (const match of String(query || '').toLowerCase().matchAll(/"([^"]*)"?|([^\s"]+)/g)) {
    const term = (match[1] ?? match[2]).trim()
    if (term) (match[1] !== undefined ? excludes : includes).push(term)
  }
  return entries.filter(entry => {
    const name = String(entry.name || '').toLowerCase()
    return includes.every(term => name.includes(term)) && excludes.every(term => !name.includes(term))
  })
}

export function selectBoxDatasetIds(entries, instrumentType) {
  return new Set(entries.filter(entry => String(instrumentType).toUpperCase() === 'GCMS'
    ? /\.d$/i.test(String(entry.name || ''))
    : !entry.is_dir).map(entry => String(entry.id)))
}

export function boxEntryExtension(entry) {
  const match = String(entry.name || '').match(/\.([^.\s]+)$/)
  return match ? `.${match[1].toUpperCase()}` : entry.is_dir ? 'Folders' : 'No extension'
}

export function defaultBoxExtensions(instrumentType, rules) {
  if (String(instrumentType).toUpperCase() === 'GCMS') return new Set(['.D'])
  const rule = rules.find(rule => rule.type === instrumentType)
  return new Set((rule?.patterns || []).map(pattern => String(pattern).toUpperCase()))
}
