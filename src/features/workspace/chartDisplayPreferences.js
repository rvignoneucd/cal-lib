const hexColor = value => /^#[0-9a-f]{6}$/i.test(value || '') ? value.toLowerCase() : ''

export function chartDisplayPreferences(settings, theme) {
  const prefix = theme === 'dark' ? 'dark' : 'light'
  return {
    grid: hexColor(settings?.[`${prefix}_grid_color`]),
    background: hexColor(settings?.[`${prefix}_plot_background_color`]),
    text: hexColor(settings?.[`${prefix}_plot_text_color`]),
  }
}

// These are display overrides; never mutate authored layouts or saved styles.
export function applyChartDisplayPreferences(layout, preferences) {
  const grid = hexColor(preferences?.grid), background = hexColor(preferences?.background)
  const text = hexColor(preferences?.text)
  if (!layout || (!grid && !background && !text)) return layout
  const font = value => ({ ...value, color: text })
  const title = value => typeof value === 'string' ? { text: value, font: font() } : { ...value, font: font(value?.font) }
  const annotations = values => values?.map(value => ({ ...value, font: font(value.font) }))
  const axis = value => ({ ...value,
    ...(grid ? { gridcolor: grid, ...(value?.minor ? { minor: { ...value.minor, gridcolor: grid } } : {}) } : {}),
    ...(text ? { tickfont: font(value?.tickfont), title: title(value?.title) } : {}),
  })
  const out = { ...layout, ...(background ? { plot_bgcolor: background } : {}),
    ...(text ? { font: font(layout.font), title: title(layout.title),
      hoverlabel: { ...layout.hoverlabel, font: font(layout.hoverlabel?.font) },
      ...(layout.annotations ? { annotations: annotations(layout.annotations) } : {}),
    } : {}),
  }
  for (const key of Object.keys(layout)) {
    if (/^[xy]axis\d*$/.test(key)) out[key] = axis(layout[key])
    if (text && /^legend\d*$/.test(key)) out[key] = { ...layout[key], font: font(layout[key]?.font), title: title(layout[key]?.title) }
    if (/^scene\d*$/.test(key)) {
      // Projected 3D labels extend into the paper margins around the scene.
      if (background) out.paper_bgcolor = background
      out[key] = { ...layout[key], ...(background ? { bgcolor: background } : {}),
        ...(text && layout[key].annotations ? { annotations: annotations(layout[key].annotations) } : {}),
      }
      for (const name of ['xaxis', 'yaxis', 'zaxis']) out[key][name] = {
        ...axis(layout[key][name]), ...(background ? { backgroundcolor: background } : {}),
      }
    }
  }
  // Plotly also permits implicit primary axes.
  if ((grid || text) && !Object.keys(layout).some(key => /^scene\d*$/.test(key))) {
    out.xaxis = axis(layout.xaxis)
    out.yaxis = axis(layout.yaxis)
  }
  return out
}

export function applyChartTextPreferences(data, preferences) {
  const color = hexColor(preferences?.text)
  if (!color || !data) return data
  return data.map(trace => ({ ...trace, textfont: { ...trace.textfont, color },
    hoverlabel: { ...trace.hoverlabel, font: { ...trace.hoverlabel?.font, color } },
  }))
}
