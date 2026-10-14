import {TriangleAlert} from 'lucide-react'
export default function WarningFlag({message}) {
  if(!message)return null
  return <details className="cal-warning-flag"><summary aria-label={message} title={message}><TriangleAlert size={16}/></summary><span role="tooltip">{message}</span></details>
}
