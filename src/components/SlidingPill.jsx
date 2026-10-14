import './slidingPill.css'

export default function SlidingPill({value, options, onChange, label, iconOnly = false, vertical = false, role = 'radiogroup', disabled = false}) {
  const index = Math.max(0, options.findIndex(option => option.value === value))
  const enabledIndexes = options.flatMap((option, i) => disabled || option.disabled ? [] : [i])
  const focusIndex = enabledIndexes.includes(index) ? index : enabledIndexes[0]
  return <div className={`atmos-sliding-pill${iconOnly ? ' atmos-sliding-pill-icons' : ''}${vertical ? ' atmos-sliding-pill-vertical' : ''}`} role={role} aria-label={label} aria-orientation={vertical ? 'vertical' : 'horizontal'}
    style={{'--pill-count': options.length, '--pill-index': index}}>
    {options.map((option, i) => <button key={option.value} type="button" role={role === 'tablist' ? 'tab' : 'radio'}
      id={option.id} aria-controls={role === 'tablist' ? option.controls : undefined}
      aria-label={option.accessibleLabel} title={option.tooltip} disabled={disabled || option.disabled}
      aria-checked={role === 'tablist' ? undefined : option.value === value}
      aria-selected={role === 'tablist' ? option.value === value : undefined} tabIndex={i === focusIndex ? 0 : -1}
      onClick={() => onChange(option.value)} onKeyDown={event => {
        const previousKey = vertical ? 'ArrowUp' : 'ArrowLeft'
        const nextKey = vertical ? 'ArrowDown' : 'ArrowRight'
        if (![previousKey, nextKey, 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        if (!enabledIndexes.length) return
        const position = enabledIndexes.indexOf(i)
        const next = event.key === 'Home' ? enabledIndexes[0] : event.key === 'End' ? enabledIndexes.at(-1)
          : enabledIndexes[(position + (event.key === nextKey ? 1 : -1) + enabledIndexes.length) % enabledIndexes.length]
        onChange(options[next].value)
        event.currentTarget.parentElement.children[next].focus()
      }}>{option.label}</button>)}
  </div>
}
