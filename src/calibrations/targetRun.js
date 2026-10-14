import { concentrationOrder, standardHint } from './standardHints.js'

export function targetRun(files, selected) {
  const usable = files.filter(file => selected.includes(file.id) && !file.source_error)
  const external = usable.filter(file => !standardHint(file.filename).internalStandard)
  // Mixtures containing an internal standard can still supply the analyte target.
  return [...(external.length ? external : usable)].sort(concentrationOrder).at(-1)
}
