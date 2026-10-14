import '../styles/toggleSwitch.css'

export default function ToggleSwitch({ checked, onChange, className = '', ...props }) {
  return <button {...props} type="button" role="switch" aria-checked={checked}
    className={`control-switch${checked ? ' on' : ''} ${className}`}
    onClick={() => onChange(!checked)}><span /></button>
}
