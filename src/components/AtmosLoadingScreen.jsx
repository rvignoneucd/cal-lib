import { useEffect, useMemo, useRef, useState } from 'react'

const CURVES = [
  { h: 0.96, w: 16.5 },
  { h: 0.90, w: 14.8 },
  { h: 0.84, w: 13.2 },
  { h: 0.78, w: 12.0 },
  { h: 0.74, w: 11.0 },
  { h: 0.70, w: 10.2 },
  { h: 0.66, w: 9.6 },
  { h: 0.62, w: 9.0 },
  { h: 0.30, w: 8.5 },
  { h: 0.26, w: 7.8 },
]

const CURVE_COLORS = [
  '#a78bfa',
  '#22d3ee',
  '#34d399',
  '#22c55e',
  '#f97316',
  '#fbbf24',
  '#ef4444',
  '#a78bfa',
  '#34d399',
  '#22d3ee',
]

const STATUS_LINES = [
  ['init', 'allocating trace buffer'],
  ['compile', 'building bell kernels'],
  ['sample', 'drawing 1024 samples per curve'],
  ['fit', 'fitting sigma to upper cluster'],
  ['fit', 'fitting sigma to lower bowl'],
  ['shade', 'mapping color ramp cyan to lilac'],
  ['render', 'rasterizing 10 paths'],
  ['ready', 'plot ready, handing to renderer'],
]

const PHASE_LINES = {
  auth: ['auth', 'checking session'],
  project: ['project', 'loading project and instruments'],
  workspace: ['workspace', 'hydrating project workspace'],
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value))
}

function bellPath(h, w, plotL, plotR, plotT, plotB) {
  const peakY = plotT + (1 - h) * (plotB - plotT)
  const span = plotR - plotL
  const points = []
  for (let i = 0; i <= 96; i += 1) {
    const xNorm = (i / 96) * 100
    const x = plotL + (i / 96) * span
    const z = (xNorm - 50) / w
    const y = plotB - (plotB - peakY) * Math.exp(-0.5 * z * z)
    points.push(`${x.toFixed(2)},${y.toFixed(2)}`)
  }
  return `M ${points.join(' L ')}`
}

export function LoadingMark({ progress }) {
  const plotL = 8
  const plotR = 96
  const plotT = 9
  const plotB = 92
  const curveStart = 0.20
  const curveEnd = 0.95
  const curveSpan = (curveEnd - curveStart) / CURVES.length
  const gridOpacity = clamp01(progress / 0.15)
  const axisOpacity = clamp01((progress - 0.10) / 0.20)
  const paths = useMemo(() => CURVES.map((curve) => bellPath(curve.h, curve.w, plotL, plotR, plotT, plotB)), [])

  return (
    <svg className="atmos-loading-mark" viewBox="0 0 100 100" aria-hidden="true">
      <g opacity={gridOpacity} shapeRendering="crispEdges">
        {Array.from({ length: 37 }, (_, index) => {
          const x = plotL + (index / 36) * (plotR - plotL)
          if (index % 4 === 0) return null
          return <line key={`mv-${index}`} x1={x} y1={plotT} x2={x} y2={plotB} className="minor" />
        })}
        {Array.from({ length: 25 }, (_, index) => {
          const y = plotT + (index / 24) * (plotB - plotT)
          if (index % 4 === 0) return null
          return <line key={`mh-${index}`} x1={plotL} y1={y} x2={plotR} y2={y} className="minor" />
        })}
        {Array.from({ length: 10 }, (_, index) => {
          const x = plotL + (index / 9) * (plotR - plotL)
          return <line key={`v-${index}`} x1={x} y1={plotT} x2={x} y2={plotB} className="major" />
        })}
        {Array.from({ length: 7 }, (_, index) => {
          const y = plotT + (index / 6) * (plotB - plotT)
          return <line key={`h-${index}`} x1={plotL} y1={y} x2={plotR} y2={y} className="major" />
        })}
      </g>
      <g opacity={axisOpacity} className="axis" shapeRendering="crispEdges">
        <line x1={plotL} y1={plotT} x2={plotL} y2={plotB} />
        <line x1={plotL} y1={plotB} x2={plotR} y2={plotB} />
        {Array.from({ length: 29 }, (_, index) => {
          const x = plotL + (index / 28) * (plotR - plotL)
          const tick = index % 4 === 0 ? 1.4 : 0.8
          return <line key={`xt-${index}`} x1={x} y1={plotB} x2={x} y2={plotB + tick} />
        })}
        {Array.from({ length: 23 }, (_, index) => {
          const y = plotT + (index / 22) * (plotB - plotT)
          const tick = index % 4 === 0 ? 1.4 : 0.8
          return <line key={`yt-${index}`} x1={plotL - tick} y1={y} x2={plotL} y2={y} />
        })}
      </g>
      <g className="curves">
        {paths.map((path, index) => {
          const t0 = curveStart + index * curveSpan
          const t1 = t0 + curveSpan * 1.4
          const local = clamp01((progress - t0) / (t1 - t0))
          const eased = 1 - Math.pow(1 - local, 3)
          return (
            <path
              key={index}
              d={path}
              stroke={CURVE_COLORS[index % CURVE_COLORS.length]}
              pathLength="100"
              strokeDasharray="100 100"
              strokeDashoffset={100 - eased * 100}
            />
          )
        })}
      </g>
      <g>
        {CURVES.map((_, index) => {
          const x = plotL + ((index + 0.5) / CURVES.length) * (plotR - plotL)
          const t0 = curveStart + index * curveSpan
          const t1 = t0 + curveSpan * 1.4
          const local = clamp01((progress - t0) / (t1 - t0))
          const lit = clamp01(((1 - Math.pow(1 - local, 3)) - 0.92) / 0.08)
          return (
            <circle
              key={index}
              cx={x}
              cy="4"
              r={0.9 + lit * 0.35}
              fill={CURVE_COLORS[index % CURVE_COLORS.length]}
              opacity={lit}
            />
          )
        })}
      </g>
    </svg>
  )
}

function Chip({ color, label, value }) {
  return (
    <span className="atmos-loading-chip" style={{ '--chip-color': color }}>
      <span>{label}</span>
      <strong>{value}</strong>
    </span>
  )
}

export default function AtmosLoadingScreen({
  duration = 6500,
  loop = true,
  projectName = '',
  instrumentName = '',
  phase = '',
}) {
  const [progress, setProgress] = useState(0)
  const bootStartRef = useRef(
    typeof window !== 'undefined' && Number.isFinite(window.__ATMOS_BOOT_STARTED_AT__)
      ? window.__ATMOS_BOOT_STARTED_AT__
      : 0,
  )

  useEffect(() => {
    let frame = 0
    let start = bootStartRef.current || 0
    const tick = (time) => {
      if (!start) start = time
      const elapsed = (time - start) / duration
      setProgress(loop ? elapsed % 1 : Math.min(1, elapsed))
      frame = window.requestAnimationFrame(tick)
    }
    frame = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frame)
  }, [duration, loop])

  const lineIndex = Math.min(STATUS_LINES.length - 1, Math.floor(progress * STATUS_LINES.length))
  const [tag, message] = PHASE_LINES[phase] || STATUS_LINES[lineIndex]
  const contextLabel = [projectName, instrumentName].filter(Boolean).join(' / ')
  const cursorOn = Math.floor(progress * STATUS_LINES.length * 4) % 2 === 0

  return (
    <main className="atmos-loading-screen" aria-label="Atmos is loading">
      <div className="atmos-loading-top atmos-loading-top-left">
        <span className="atmos-loading-pill">Atmos loading</span>
        <span className="atmos-loading-version">v2.0 trace engine warming up</span>
      </div>
      <div className="atmos-loading-top atmos-loading-top-right">
        <span>session://{Math.floor(progress * 65535).toString(16).padStart(4, '0')}</span>
        <span className="atmos-loading-live-dot" />
      </div>
      <section className="atmos-loading-center">
        <LoadingMark progress={progress} />
        <div className="atmos-loading-copy">
          <div className="atmos-loading-kicker">PLOT / DESIGN / LAYOUT</div>
          <h1>Atmos</h1>
          <div className="atmos-loading-status">
            <span className="prompt">$</span>
            <span className="tag">{tag}</span>
            <span className="sep">/</span>
            <span className="message">{message}</span>
            <span className="cursor" style={{ opacity: cursorOn ? 1 : 0 }}>|</span>
          </div>
          {contextLabel && (
            <div className="atmos-loading-context">
              <span>opening</span>
              <strong>{contextLabel}</strong>
            </div>
          )}
          <div className="atmos-loading-chips">
            <Chip color="#ff2d8e" label="R2" value={(0.82 + progress * 0.16).toFixed(3)} />
            <Chip color="#22d3ee" label="SCAN" value={String(Math.floor(progress * 1024)).padStart(4, '0')} />
            <Chip color="#a78bfa" label="MU" value={(progress * 0.5 - 0.25).toFixed(2)} />
          </div>
        </div>
      </section>
      <div className="atmos-loading-bottom">
        <div className="atmos-loading-progress-label">
          <span>{contextLabel ? 'loading workspace context' : 'compiling trace pipeline'}</span>
          <span>{Math.floor(progress * 100).toString().padStart(3, '0')} <em>/ 100</em></span>
        </div>
        <div className="atmos-loading-track">
          <span style={{ width: `${progress * 100}%` }} />
        </div>
        <div className="atmos-loading-ticks">
          {Array.from({ length: 29 }, (_, index) => (
            <i
              key={index}
              className={index % 4 === 0 ? 'major' : ''}
              style={{ opacity: (index / 28) <= progress ? 1 : 0.2 }}
            />
          ))}
        </div>
      </div>
    </main>
  )
}
