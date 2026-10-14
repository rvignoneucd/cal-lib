import ChevronDown from 'lucide-react/dist/esm/icons/chevron-down.mjs'
import ChevronUp from 'lucide-react/dist/esm/icons/chevron-up.mjs'
import ChevronLeft from 'lucide-react/dist/esm/icons/chevron-left.mjs'
import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right.mjs'
import './chevronIndicator.css'

const icons = {down: ChevronDown, up: ChevronUp, left: ChevronLeft, right: ChevronRight}

// Decorative indicator: the parent button owns its label and expanded state.
export default function ChevronIndicator({direction = 'down'}) {
  const Icon = icons[direction] || ChevronDown
  return <span className="atmos-chevron" aria-hidden="true"><Icon size={17.5} strokeWidth={2} /></span>
}
