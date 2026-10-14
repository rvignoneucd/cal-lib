export function baselineGuideTrace(points, style = {}) {
  if (!Array.isArray(points) || points.length < 2) return null
  const shift = (Number(style.x_shift_seconds) || 0) / 60
  const scale = Math.max(1, Math.min(10, Number(style.y_scale) || 1))
  return {
    x: points.map(point => point.x + shift),
    y: points.map(point => point.y * scale),
    type: 'scattergl', mode: 'lines',
    line: { width: 1, color: '#94a3b8', shape: 'linear' },
    meta: { role: 'baseline-guide' },
    hoverinfo: 'skip', showlegend: false,
    name: 'Estimated baseline',
  }
}

// Resolve after display preferences so the guide always matches the visible grid.
export function matchBaselineGuideGrid(data, layout) {
  if (!data?.some(trace => trace.meta?.role === 'baseline-guide')) return data
  return data.map(trace => trace.meta?.role === 'baseline-guide'
    ? { ...trace, line: { ...trace.line,
      color: layout?.yaxis?.gridcolor || layout?.xaxis?.gridcolor || trace.line.color,
    } }
    : trace)
}
