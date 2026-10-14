const KEY = 'atmos.browserDiagnostics.v1'
let report
let previous = []

export function recordBrowserDiagnostic(kind, detail = {}) {
  if (!report) return
  report.events.push({at: new Date().toISOString(), kind, ...detail})
  report.events = report.events.slice(-80)
  try { localStorage.setItem(KEY, JSON.stringify({current: report, previous})) } catch { /* Storage may be unavailable. */ }
}

export function startBrowserDiagnostics() {
  if (report) return
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null')
    previous = [saved?.current, ...(saved?.previous || [])].filter(Boolean).slice(0, 2)
  } catch { previous = [] }
  report = {started: new Date().toISOString(), userAgent: navigator.userAgent,
    environment: new URLSearchParams(location.search).get('environment') || 'default', events: []}
  recordBrowserDiagnostic('started', {wasDiscarded: Boolean(document.wasDiscarded)})
  let lastInteraction = 0
  const interaction = event => {
    if (Date.now() - lastInteraction < 500) return
    lastInteraction = Date.now()
    const target = event.target?.closest?.('button, input, [role="slider"], .js-plotly-plot')
    recordBrowserDiagnostic('interaction', {type: event.type, tag: target?.tagName || event.target?.tagName,
      role: target?.getAttribute('role') || '', plot: Boolean(event.target?.closest?.('.js-plotly-plot'))})
  }
  document.addEventListener('pointerdown', interaction, true)
  document.addEventListener('wheel', interaction, {capture: true, passive: true})
  document.addEventListener('webglcontextlost', () => recordBrowserDiagnostic('webgl-context-lost'), true)
  document.addEventListener('visibilitychange', () => recordBrowserDiagnostic('visibility', {state: document.visibilityState}))
  window.addEventListener('pagehide', event => recordBrowserDiagnostic('pagehide', {persisted: event.persisted}))
  let lastTick = performance.now()
  window.setInterval(() => {
    const now = performance.now()
    const memory = performance.memory
    recordBrowserDiagnostic('sample', {tickDelayMs: Math.round(now - lastTick - 10000),
      heapBytes: memory?.usedJSHeapSize, heapLimitBytes: memory?.jsHeapSizeLimit,
      plots: document.querySelectorAll('.js-plotly-plot').length,
      canvases: [...document.querySelectorAll('canvas')].map(canvas => [canvas.width, canvas.height]).slice(0, 20),
      svgPaths: document.querySelectorAll('svg path').length})
    lastTick = now
  }, 10000)
}

export function downloadBrowserDiagnostics() {
  const stored = localStorage.getItem(KEY) || '{}'
  const url = URL.createObjectURL(new Blob([stored], {type: 'application/json'}))
  const link = document.createElement('a')
  link.href = url
  link.download = 'atmos-browser-diagnostics.json'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
