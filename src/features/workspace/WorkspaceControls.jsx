import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Bookmark from 'lucide-react/dist/esm/icons/bookmark.mjs'
import Pentagon from 'lucide-react/dist/esm/icons/pentagon.mjs'
import { LoadingMark as AtmosLoadingMark } from '../../components/AtmosLoadingScreen'
import { InstrumentIcon } from '../../components/AppPrimitives'

function PlotInstrumentIcon({ type, size = 20 }) {
  if (!type) return null
  return <InstrumentIcon type={type} size={size} className="plot-title-instrument-icon" />
}

export function PlotPanel({ title, subtitle, actions = null, children, instrumentType = '', compactTitle = false, hideHeader = false }) {
  return (
    <section className="plot-panel">
      {!hideHeader && (
        <div className="plot-title">
          <div className={`plot-title-heading${compactTitle ? ' compact' : ''}`}>
            {compactTitle && instrumentType ? <PlotInstrumentIcon type={instrumentType} /> : null}
            <div className="plot-title-copy">
              <strong>{title}</strong>
              {subtitle ? <span>{subtitle}</span> : null}
            </div>
          </div>
          {actions && <div className="plot-title-actions">{actions}</div>}
        </div>
      )}
      <div className="plot-body">{children}</div>
    </section>
  )
}

export function TimeScrubber({
  formatPlotValue,
  massTimelineTypes = new Set(),
  selectedDataset,
  chromatogram,
  spectrum,
  viewport,
  onPick,
  onPreview,
  bookmarks = [],
  onAddBookmark,
  onSelectBookmark,
  onDeleteBookmark,
  reserveSpace = false,
  currentHost = null,
  followThumb = false,
}) {
  const instrumentType = selectedDataset?.instrument_type
  const enabled = massTimelineTypes.has(instrumentType) && typeof onPick === 'function'
  const range = useMemo(() => {
    const viewMin = Number(viewport?.start)
    const viewMax = Number(viewport?.end)
    if (Number.isFinite(viewMin) && Number.isFinite(viewMax) && Math.abs(viewMax - viewMin) > 0.000001) {
      return { min: Math.min(viewMin, viewMax), max: Math.max(viewMin, viewMax), zoomed: true }
    }
    const lodMin = Number(chromatogram?.lod?.window_start)
    const lodMax = Number(chromatogram?.lod?.window_end)
    if (Number.isFinite(lodMin) && Number.isFinite(lodMax) && lodMax > lodMin) {
      return { min: lodMin, max: lodMax }
    }
    const datasetMin = Number(selectedDataset?.rt_min)
    const datasetMax = Number(selectedDataset?.rt_max)
    if (Number.isFinite(datasetMin) && Number.isFinite(datasetMax) && datasetMax > datasetMin) {
      return { min: datasetMin, max: datasetMax }
    }
    const points = Array.isArray(chromatogram?.points) ? chromatogram.points : []
    let min = Infinity
    let max = -Infinity
    for (const point of points) {
      const x = Number(point?.x)
      if (!Number.isFinite(x)) continue
      if (x < min) min = x
      if (x > max) max = x
    }
    return Number.isFinite(min) && Number.isFinite(max) && max > min ? { min, max } : null
  }, [viewport?.start, viewport?.end, selectedDataset?.rt_min, selectedDataset?.rt_max, chromatogram?.lod?.window_start, chromatogram?.lod?.window_end, chromatogram?.points])
  const currentRt = Number(spectrum?.rt)
  const fallbackRt = range ? (range.min + range.max) / 2 : NaN
  const clampedRt = range
    ? Math.max(range.min, Math.min(range.max, Number.isFinite(currentRt) ? currentRt : fallbackRt))
    : NaN
  const [draftRt, setDraftRt] = useState(clampedRt)
  const draggingRef = useRef(false)
  const [dragging, setDragging] = useState(false)
  const trackRef = useRef(null)
  const [trackWidth, setTrackWidth] = useState(0)
  useEffect(() => {
    const track = trackRef.current
    if (!track) return
    const observer = new ResizeObserver(() => setTrackWidth(track.clientWidth))
    observer.observe(track)
    return () => observer.disconnect()
  }, [enabled, range?.min, range?.max])
  const lastCommittedRtRef = useRef(NaN)

  useEffect(() => {
    if (!Number.isFinite(clampedRt) || draggingRef.current) return
    setDraftRt(clampedRt)
  }, [clampedRt])

  const rangeMin = range?.min ?? 0
  const rangeMax = range?.max ?? 1
  const span = Math.max(0.000001, rangeMax - rangeMin)
  const step = Math.max(0.0005, span / 3000)
  const ready = enabled && !!range && Number.isFinite(draftRt)
  const clampRt = (value) => Math.max(rangeMin, Math.min(rangeMax, value))
  const scheduleLivePick = (value) => {
    if (!ready) return
    const rt = Number(value)
    if (!Number.isFinite(rt)) return
    const next = clampRt(rt)
    onPreview?.(next)
  }
  const commit = (value = draftRt) => {
    if (!ready) return
    const rt = Number(value)
    if (!Number.isFinite(rt)) return
    const next = clampRt(rt)
    if (Number.isFinite(lastCommittedRtRef.current) && Math.abs(lastCommittedRtRef.current - next) < step / 2) return
    lastCommittedRtRef.current = next
    onPick(next, { search: false, settleSearch: true })
  }

  if (!ready && !reserveSpace) return null
  const bookmarkList = ready && Array.isArray(bookmarks)
    ? bookmarks
        .map((bookmark) => ({ ...bookmark, rt: Number(bookmark?.rt) }))
        .filter((bookmark) => Number.isFinite(bookmark.rt) && bookmark.rt >= rangeMin && bookmark.rt <= rangeMax)
        .sort((a, b) => a.rt - b.rt)
    : []

  return (
    <div className={`time-scrubber${followThumb ? ' time-scrubber-follow' : ''}`} role="group" aria-label="Retention time scrubber" aria-busy={!ready}>
      <button
        type="button"
        className="time-scrubber-bookmark"
        disabled={!ready}
        onClick={() => onAddBookmark?.(draftRt)}
        aria-label="Bookmark current retention time"
        title="Bookmark current RT"
      >
        <Bookmark size={14} />
      </button>
      <span className="time-scrubber-edge">{ready ? formatPlotValue(rangeMin) : '--'}</span>
      <div className="time-scrubber-track-wrap" ref={trackRef}>
        <div className="time-scrubber-bookmarks" aria-hidden={!bookmarkList.length}>
          {bookmarkList.map((bookmark) => {
            const pct = Math.max(0, Math.min(100, ((bookmark.rt - rangeMin) / span) * 100))
            const proximity = trackWidth ? Math.max(0, 1 - Math.abs(bookmark.rt - draftRt) / span * trackWidth / 24) : 0
            return (
              <button
                key={bookmark.id || `${bookmark.rt}`}
                type="button"
                className="time-scrubber-bookmark-marker"
                style={{ left: `${pct}%`, translate: `0 ${-proximity * proximity * (3 - 2 * proximity) * 12}px`, pointerEvents: dragging ? 'none' : undefined }}
                title={bookmark.name || `RT ${bookmark.rt.toFixed(3)}`}
                aria-label={bookmark.name || `RT ${bookmark.rt.toFixed(3)}`}
                onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); onDeleteBookmark?.(bookmark) }}
                onKeyDown={(event) => { if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); onDeleteBookmark?.(bookmark) } }}
                onClick={() => {
                  setDraftRt(bookmark.rt)
                  commit(bookmark.rt)
                  onSelectBookmark?.(bookmark)
                }}
              ><Pentagon size={16} fill="currentColor" aria-hidden="true" /></button>
            )
          })}
        </div>
        <input
          type="range"
          min={rangeMin}
          max={rangeMax}
          step={step}
          value={ready ? draftRt : rangeMin}
          disabled={!ready}
          onPointerDown={(event) => {
            draggingRef.current = true
            setDragging(true)
            event.currentTarget.setPointerCapture?.(event.pointerId)
          }}
          onChange={(event) => {
            const next = Number(event.target.value)
            setDraftRt(next)
            scheduleLivePick(next)
          }}
          onPointerUp={(event) => {
            draggingRef.current = false
            setDragging(false)
            commit(event.currentTarget.value)
          }}
          onPointerCancel={() => {
            draggingRef.current = false
            setDragging(false)
            setDraftRt(clampedRt)
            onPreview?.(null)
          }}
          onKeyUp={(event) => commit(event.currentTarget.value)}
          onBlur={(event) => {
            draggingRef.current = false
            setDragging(false)
            commit(event.currentTarget.value)
          }}
          aria-label="Pick mass spectrum retention time"
        />
        {followThumb && <output className="time-scrubber-follow-rt" aria-label="Current retention time"
          style={{ '--rt-fraction': ready ? Math.max(0, Math.min(1, (draftRt - rangeMin) / span)) : 0 }}>
          RT {ready ? Number(draftRt).toFixed(3) : '--'}
        </output>}
      </div>
      <span className="time-scrubber-end">{ready ? formatPlotValue(rangeMax) : '--'}</span>
      {currentHost && createPortal(<span className="spectrum-scrub-rt">RT {ready ? Number(draftRt).toFixed(3) : '--'}</span>, currentHost)}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
export function XRangeControl({ formatPlotValue, range, value, onChange, onReset, reserveSpace = false, axis = 'X' }) {
  const sliderRef = useRef(null)
  const dragRef = useRef(null)
  const min = Number(range?.min)
  const max = Number(range?.max)
  const enabled = Number.isFinite(min) && Number.isFinite(max) && max > min && typeof onChange === 'function'
  const span = enabled ? max - min : 1
  const gap = span * 0.002
  const clamp = (next) => Math.max(min, Math.min(max, next))
  const rawStart = Number(value?.min)
  const rawEnd = Number(value?.max)
  const currentMin = enabled ? clamp(Number.isFinite(rawStart) ? rawStart : min) : min
  const currentMax = enabled ? clamp(Number.isFinite(rawEnd) ? rawEnd : max) : max
  const low = Math.min(currentMin, currentMax)
  const high = Math.max(currentMin, currentMax)
  const lowFrac = enabled ? Math.max(0, Math.min(1, (low - min) / span)) : 0
  const highFrac = enabled ? Math.max(0, Math.min(1, (high - min) / span)) : 1
  const active = enabled && (low > min + span * 0.001 || high < max - span * 0.001)

  const applyFraction = (event, dragState) => {
    if (!enabled) return
    const slider = sliderRef.current
    if (!slider) return
    const rect = slider.getBoundingClientRect()
    if (!rect.width) return
    const handle = typeof dragState === 'string' ? dragState : dragState?.handle
    if (handle === 'pan') {
      const width = dragState.high - dragState.low
      const start = Math.max(min, Math.min(max - width, dragState.low + (event.clientX - dragState.x) / rect.width * span))
      onChange(start, start + width)
      return
    }
    const grabOffset = typeof dragState === 'string' ? 0 : Number(dragState?.grabOffset) || 0
    const x = event.clientX - grabOffset
    const fraction = Math.max(0, Math.min(1, (x - rect.left) / rect.width))
    const nextValue = min + span * fraction
    if (handle === 'min') onChange(Math.min(nextValue, high - gap), high)
    else onChange(low, Math.max(nextValue, low + gap))
  }

  const startDrag = (event, handle = null) => {
    if (!enabled) return
    event.preventDefault()
    event.stopPropagation()
    const slider = sliderRef.current
    if (!slider) return
    const rect = slider.getBoundingClientRect()
    const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(rect.width, 1)))
    const nextHandle = handle || (Math.abs(fraction - lowFrac) <= Math.abs(fraction - highFrac) ? 'min' : 'max')
    const handleFraction = nextHandle === 'min' ? lowFrac : highFrac
    const handleCenterX = rect.left + handleFraction * rect.width
    dragRef.current = { handle: nextHandle, grabOffset: handle ? event.clientX - handleCenterX : 0, low, high, x: event.clientX }
    slider.setPointerCapture?.(event.pointerId)
    if (!handle) applyFraction(event, dragRef.current)
  }

  const drag = (event) => {
    if (!dragRef.current) return
    event.preventDefault()
    event.stopPropagation()
    applyFraction(event, dragRef.current)
  }

  const stopDrag = (event) => {
    if (!dragRef.current) return
    event.preventDefault()
    event.stopPropagation()
    dragRef.current = null
    sliderRef.current?.releasePointerCapture?.(event.pointerId)
  }

  if (!enabled && !reserveSpace) return null
  const adjustByKey = (event, handle) => {
    if (!enabled || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    const step = span * (event.shiftKey ? 0.1 : 0.01)
    if (handle === 'pan') {
      const width = high - low
      const start = Math.max(min, Math.min(max - width, event.key === 'Home' ? min : event.key === 'End' ? max - width
        : low + (['ArrowRight', 'ArrowUp'].includes(event.key) ? step : -step)))
      onChange(start, start + width)
      return
    }
    const current = handle === 'min' ? low : high
    const next = event.key === 'Home' ? min : event.key === 'End' ? max
      : clamp(current + (['ArrowRight', 'ArrowUp'].includes(event.key) ? step : -step))
    if (handle === 'min') onChange(Math.min(next, high - gap), high)
    else onChange(low, Math.max(next, low + gap))
  }
  return (
    <div className={`x-range-control${active ? ' active' : ''}`} role="group" aria-label={`Visible ${axis}-axis range`} aria-busy={!enabled}>
      <span className="x-range-value">{enabled ? formatPlotValue(low) : '--'}</span>
      <div
        ref={sliderRef}
        className="x-range-slider"
        style={{
          '--x-start-pct': `${Math.max(0, Math.min(100, lowFrac * 100))}%`,
          '--x-end-pct': `${Math.max(0, Math.min(100, highFrac * 100))}%`,
        }}
        onPointerDown={(event) => startDrag(event)}
        onPointerMove={drag}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
      >
        <button
          type="button"
          className="x-range-handle x-range-handle-pan"
          role="slider"
          aria-label={`Slide visible ${axis}-axis range`}
          title="Slide view without changing its width"
          aria-valuemin={min} aria-valuemax={max - (high - low)} aria-valuenow={low}
          disabled={!enabled || !active}
          style={{ left: `${(lowFrac + highFrac) * 50}%` }}
          onPointerDown={(event) => startDrag(event, 'pan')}
          onKeyDown={(event) => adjustByKey(event, 'pan')}
        />
        <button
          type="button"
          className="x-range-handle x-range-handle-min"
          role="slider"
          aria-valuemin={min} aria-valuemax={high - gap} aria-valuenow={low}
          onKeyDown={(event) => adjustByKey(event, 'min')}
          disabled={!enabled}
          style={{ left: 'var(--x-start-pct)' }}
          onPointerDown={(event) => startDrag(event, 'min')}
          onDoubleClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onReset?.()
          }}
          aria-label={`Visible ${axis}-axis minimum`}
        />
        <button
          type="button"
          className="x-range-handle x-range-handle-max"
          role="slider"
          aria-valuemin={low + gap} aria-valuemax={max} aria-valuenow={high}
          onKeyDown={(event) => adjustByKey(event, 'max')}
          disabled={!enabled}
          style={{ left: 'var(--x-end-pct)' }}
          onPointerDown={(event) => startDrag(event, 'max')}
          onDoubleClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onReset?.()
          }}
          aria-label={`Visible ${axis}-axis maximum`}
        />
      </div>
      <span className="x-range-value">{enabled ? formatPlotValue(high) : '--'}</span>
    </div>
  )
}


export function InstrumentSwitchLoader({ instrumentName = '', datasetName = '', label = 'Loading graph' }) {
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    let frame = 0
    let start = 0
    const duration = 1800
    const tick = (time) => {
      if (!start) start = time
      setProgress(((time - start) / duration) % 1)
      frame = window.requestAnimationFrame(tick)
    }
    frame = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frame)
  }, [])

  return (
    <div className="instrument-switch-loader" role="status" aria-live="polite">
      <div className="instrument-switch-loader-card">
        <AtmosLoadingMark progress={progress} />
        <div className="instrument-switch-loader-copy">
          <span>{label}</span>
          <strong>{instrumentName || 'Instrument'}</strong>
          {datasetName && <em>{datasetName}</em>}
        </div>
      </div>
    </div>
  )
}
