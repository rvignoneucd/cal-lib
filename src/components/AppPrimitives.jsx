import { createPortal } from 'react-dom'
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import ChevronDown from 'lucide-react/dist/esm/icons/chevron-down.mjs'

let activeTipClose = null
const TIP_AUTO_CLOSE_MS = 5000

export function closeActiveTip() {
  activeTipClose?.()
}

const INSTRUMENT_ICON_TYPES = new Set(['GCMS', 'LCMS', 'HPLC', 'UVVIS', 'FTIR', 'GCFID', 'SMPS', 'HAPSITE', 'APLOT'])
const INSTRUMENT_ICON_FILES = {
  HAPSITE: 'hapsites.svg',
}

function HapsiteInlineIcon({ size, className }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={`instrument-icon ${className}`}
      aria-hidden="true"
    >
      <rect x="3" y="5" width="26" height="20" rx="4" fill="#4b5563" stroke="#111827" strokeWidth="1.4" />
      <rect x="6.5" y="8" width="17.5" height="8.5" rx="1.8" fill="#111827" stroke="#0f172a" strokeWidth="0.8" />
      <rect x="7.8" y="9.2" width="14.8" height="6" rx="1.1" fill="#0b1220" />
      <path d="M9.2 13.6 12 11.2l2.1 1.8 2.6-2.9 2.3 2.1 2.2-1.4" stroke="#34d399" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="7.9" y="18.7" width="2.5" height="2.2" rx="0.55" fill="#f8fafc" />
      <rect x="11.4" y="18.7" width="2.5" height="2.2" rx="0.55" fill="#f8fafc" />
      <rect x="7.9" y="21.7" width="2.5" height="2.2" rx="0.55" fill="#f8fafc" />
      <rect x="11.4" y="21.7" width="2.5" height="2.2" rx="0.55" fill="#f8fafc" />
      <rect x="16.2" y="18.7" width="8.2" height="5.2" rx="1.1" fill="#f8fafc" opacity="0.92" />
      <rect x="12.25" y="25.5" width="7.5" height="1.5" rx="0.75" fill="#475569" />
      <path d="M15 25V28.1M17 25V28.1" stroke="#475569" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}

function isEditableElement(node) {
  if (!node || node.nodeType !== 1) return false
  const el = node
  if (el.isContentEditable) return true
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(el.closest?.('[contenteditable="true"]'))
}

export function Tip({ text, children, placement = 'top', delay = 220, size = 'normal' }) {
  const [shown, setShown] = useState(false)
  const [coords, setCoords] = useState(null)
  const anchorRef = useRef(null)
  const timerRef = useRef(null)
  const autoCloseRef = useRef(null)
  const tipRef = useRef(null)
  const closeRef = useRef(null)

  useLayoutEffect(() => {
    if (!shown || !coords || !tipRef.current) return
    const el = tipRef.current
    const w = el.offsetWidth
    const margin = 8
    const left = Math.max(margin, Math.min(coords.x - w / 2, window.innerWidth - w - margin))
    el.style.left = `${left}px`
    const arrowLeft = Math.max(8, Math.min(coords.x - left, w - 8))
    el.style.setProperty('--tip-arrow-left', `${arrowLeft}px`)
  }, [shown, coords])

  const close = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (autoCloseRef.current) clearTimeout(autoCloseRef.current)
    timerRef.current = null
    autoCloseRef.current = null
    if (activeTipClose === closeRef.current) activeTipClose = null
    setShown(false)
  }, [])
  closeRef.current = close

  const open = useCallback(() => {
    if (isEditableElement(document.activeElement)) return
    if (timerRef.current) clearTimeout(timerRef.current)
    if (autoCloseRef.current) clearTimeout(autoCloseRef.current)
    if (activeTipClose && activeTipClose !== close) activeTipClose()
    activeTipClose = close
    timerRef.current = setTimeout(() => {
      const wrapper = anchorRef.current
      const target = wrapper?.firstElementChild || wrapper
      if (isEditableElement(document.activeElement) || isEditableElement(target)) return
      if (!target) return
      const rect = target.getBoundingClientRect()
      const wantTop = placement === 'top'
      const place = wantTop && rect.top < 64 ? 'bottom' : (wantTop ? 'top' : 'bottom')
      setCoords({
        x: rect.left + rect.width / 2,
        y: place === 'top' ? rect.top : rect.bottom,
        place,
      })
      setShown(true)
      autoCloseRef.current = setTimeout(close, TIP_AUTO_CLOSE_MS)
    }, delay)
  }, [close, delay, placement])

  useEffect(() => {
    if (!shown) return undefined
    const onKeyDown = (event) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    document.addEventListener('pointerdown', close, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
      document.removeEventListener('pointerdown', close, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [shown, close])

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (autoCloseRef.current) clearTimeout(autoCloseRef.current)
    if (activeTipClose === close) activeTipClose = null
  }, [close])

  if (!text) return children

  const lines = String(text).split('\n').filter((line, idx, arr) =>
    !(idx === arr.length - 1 && line.trim() === '')
  )

  return (
    <span
      ref={anchorRef}
      className="atmos-tip-anchor"
      onMouseEnter={open}
      onMouseLeave={close}
      onFocus={open}
      onBlur={close}
    >
      {children}
      {shown && coords && createPortal(
        <div
          ref={tipRef}
          className={`atmos-tip atmos-tip-${coords.place}${size === 'readable' ? ' atmos-tip-readable' : ''}`}
          style={{ left: 0, top: coords.y }}
          role="tooltip"
        >
          {lines.map((line, i) => (
            <div key={i} className={`atmos-tip-line ${i === 0 ? 'primary' : 'secondary'}`}>
              {line || ' '}
            </div>
          ))}
        </div>,
        document.body
      )}
    </span>
  )
}

export function Pill({ children, tone = 'neutral' }) {
  return <span className={`pill ${tone}`}>{children}</span>
}

export function EntryIcon({ kind, size = 14, className = '' }) {
  const props = {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round',
    strokeLinejoin: 'round', className: `entry-icon ${className}`, 'aria-hidden': true,
  }
  switch (kind) {
    case 'workbook':
      return (
        <svg {...props}>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
        </svg>
      )
    case 'sheet':
      return (
        <svg {...props}>
          <path d="M6 3h8l4 4v14H6z" />
          <path d="M14 3v4h4" />
          <path d="M9 13h6M9 16.5h5" />
        </svg>
      )
    case 'spectrum':
      return (
        <svg {...props}>
          <path d="M3 19h18" />
          <path d="M4 18c4 0 4-11 8-11s4 11 8 11" />
        </svg>
      )
    case 'run':
      return (
        <svg {...props}>
          <path d="M3 19h18" />
          <path d="M5 19c1.4 0 1.4-10 2.8-10s1.4 10 2.8 10" />
          <path d="M13 19c1.1 0 1.1-6 2.3-6s1.1 6 2.3 6" />
        </svg>
      )
    case 'file':
      return (
        <svg {...props}>
          <path d="M7 3h7l4 4v14H7z" />
          <path d="M14 3v4h4" />
        </svg>
      )
    case 'folder':
    default:
      return (
        <svg {...props}>
          <path d="M3 7a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
        </svg>
      )
  }
}

export function InstrumentIcon({ type, size = 16, className = '' }) {
  const t = (type || '').toUpperCase()
  if (t === 'HAPSITE') {
    return <HapsiteInlineIcon size={size} className={className} />
  }
  if (INSTRUMENT_ICON_TYPES.has(t)) {
    const iconFile = INSTRUMENT_ICON_FILES[t] || `${t.toLowerCase()}.svg`
    return (
      <img
        src={`/instrument-icons/${iconFile}`}
        width={size}
        height={size}
        alt={t}
        className={`instrument-icon ${className}`}
        aria-hidden="true"
        draggable={false}
      />
    )
  }
  return <EntryIcon kind="file" size={size - 2} className={className} />
}

export function Collapsible({ open, children, className = '' }) {
  return (
    <div className={`atmos-collapsible ${open ? '' : 'collapsed'} ${className}`}>
      <div className="atmos-collapsible-inner">{children}</div>
    </div>
  )
}

export function AnimatedPresence({ open, duration = 200, children }) {
  const [mounted, setMounted] = useState(open)
  const [state, setState] = useState(open ? 'open' : 'closed')

  useEffect(() => {
    if (open) {
      setMounted(true)
      const id = requestAnimationFrame(() => setState('open'))
      return () => cancelAnimationFrame(id)
    }
    setState('closed')
    const timer = window.setTimeout(() => setMounted(false), duration)
    return () => window.clearTimeout(timer)
  }, [open, duration])

  if (!mounted) return null
  return <div data-state={state} style={{ display: 'contents' }}>{children}</div>
}

export function Dropdown({ value, options, onChange, onDeleteOption, placeholder = '-', disabled, className = '', menuAlign = 'left', size = 'md', menuPortal = false, labelPrefix = '', renderTrigger, 'aria-label': ariaLabel }) {
  const menuId = useId()
  const pendingFocusRef = useRef(null)
  const [open, setOpen] = useState(false)
  const containerRef = useRef(null)
  const menuRef = useRef(null)
  const [menuPos, setMenuPos] = useState(null)

  const updatePos = useCallback(() => {
    if (!menuPortal || !containerRef.current) return
    const r = containerRef.current.getBoundingClientRect()
    const toolbar = containerRef.current.closest('.plot-overlay-mini-toolbar, .layout-asset-toolbar')?.getBoundingClientRect()
    const gap = parseFloat(getComputedStyle(containerRef.current).getPropertyValue('--control-popover-gap')) || 4
    const width = Math.min(r.width, window.innerWidth - 16)
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8))
    const anchor = toolbar || r
    const below = Math.max(0, window.innerHeight - anchor.bottom - gap - 8)
    const above = Math.max(0, anchor.top - gap - 8)
    const flip = below < Math.min(menuRef.current?.scrollHeight || 160, 160) && above > below
    setMenuPos({ top: flip ? 'auto' : anchor.bottom + gap,
      bottom: flip ? window.innerHeight - anchor.top + gap : 'auto',
      maxHeight: flip ? above : below, left, width, maxWidth: window.innerWidth - left - 8 })
  }, [menuPortal])

  useEffect(() => {
    if (!open) return undefined
    const handlePointer = (event) => {
      if (containerRef.current?.contains(event.target)) return
      if (menuRef.current?.contains(event.target)) return
      pendingFocusRef.current = null
      setOpen(false)
    }
    const handleEscape = (event) => {
      if (event.key === 'Escape') {
        // Dismiss the menu first, without also closing its native modal dialog.
        event.preventDefault()
        event.stopPropagation()
        pendingFocusRef.current = null
        setOpen(false)
        containerRef.current?.querySelector('input,button')?.focus()
      }
    }
    if (menuPortal) {
      updatePos()
      window.addEventListener('scroll', updatePos, true)
      window.addEventListener('resize', updatePos)
    }
    document.addEventListener('mousedown', handlePointer)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handlePointer)
      document.removeEventListener('keydown', handleEscape)
      window.removeEventListener('scroll', updatePos, true)
      window.removeEventListener('resize', updatePos)
    }
  }, [open, menuPortal, updatePos])

  const selected = options.find((option) => option.value === value)
  const label = selected?.label ?? selected?.value ?? placeholder

  const menu = (
    <AnimatedPresence open={open} duration={140}>
      <div
        ref={node => {
          menuRef.current = node
          if (node && pendingFocusRef.current) {
            const buttons = node.querySelectorAll('button[role="option"]:not(:disabled)')
            buttons[pendingFocusRef.current === 'ArrowUp' ? buttons.length - 1 : 0]?.focus()
            pendingFocusRef.current = null
          }
        }}
        id={menuId}
        className={`dropdown-menu align-${menuAlign}${menuPortal ? ' dropdown-menu-portal' : ''}`}
        role="listbox"
        style={menuPortal && menuPos ? { position: 'fixed', top: menuPos.top, bottom: menuPos.bottom, maxHeight: menuPos.maxHeight, overflowY: 'auto', left: menuPos.left, minWidth: menuPos.width, maxWidth: menuPos.maxWidth } : undefined}
      >
        {options.length === 0 && <div className="dropdown-empty">No options</div>}
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`dropdown-option ${option.value === value ? 'selected' : ''}`}
            role="option"
            aria-selected={option.value === value}
            disabled={option.disabled}
            onKeyDown={event => {
              const buttons = Array.from(menuRef.current?.querySelectorAll('button[role="option"]:not(:disabled)') || [])
              const index = buttons.indexOf(event.currentTarget)
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                event.stopPropagation()
                buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
              }
            }}
            onClick={() => {
              pendingFocusRef.current = null
              onChange(option.value)
              setOpen(false)
              containerRef.current?.querySelector('input,button')?.focus()
            }}
          >
            <span className="dropdown-option-label">{option.label ?? option.value}</span>
            {option.hint && <span className="dropdown-option-hint">{option.hint}</span>}
            {option.deletable && onDeleteOption && (
              <span
                className="dropdown-option-del"
                role="button"
                tabIndex={0}
                aria-label={`Delete ${option.label ?? option.value}`}
                title="Delete"
                onClick={(e) => { e.stopPropagation(); onDeleteOption(option.value) }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    e.stopPropagation()
                    onDeleteOption(option.value)
                  }
                }}
              >
                x
              </span>
            )}
          </button>
        ))}
      </div>
    </AnimatedPresence>
  )

  return (
    <div ref={containerRef} className={`dropdown size-${size} ${className} ${disabled ? 'disabled' : ''} ${open ? 'open' : ''}`}
      onKeyDown={event => {
        if (disabled || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return
        event.preventDefault()
        event.stopPropagation()
        pendingFocusRef.current = event.key
        setOpen(true)
        const buttons = menuRef.current?.querySelectorAll('button[role="option"]:not(:disabled)')
        if (buttons?.length) {
          buttons[event.key === 'ArrowUp' ? buttons.length - 1 : 0].focus()
          pendingFocusRef.current = null
        }
      }}>
      {renderTrigger ? renderTrigger({
        disabled, 'aria-label': ariaLabel, 'aria-haspopup': 'listbox', 'aria-expanded': open, 'aria-controls': menuId,
        openMenu: () => !disabled && setOpen(true),
        onClick: () => !disabled && setOpen(current => !current),
      }) : <button
        type="button"
        className="dropdown-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => !disabled && setOpen((current) => !current)}
        disabled={disabled}
      >
        <span className="dropdown-label">
          {labelPrefix ? <span className="dropdown-label-prefix">{labelPrefix}</span> : null}
          {label}
        </span>
        <ChevronDown size={14} />
      </button>}
      {menuPortal ? createPortal(menu, containerRef.current?.closest('dialog') || document.body) : menu}
    </div>
  )
}
