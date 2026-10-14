import {useEffect,useState} from 'react'
import {createPortal} from 'react-dom'
import {X} from 'lucide-react'

export default function ActionNotice({children,error=false}) {
  const [visible,setVisible]=useState(true)
  const [host]=useState(()=>{
    const parent=document.querySelector('dialog[open]')||document.body
    let node=parent.querySelector(':scope > .cal-notice-stack')
    if(!node){node=document.createElement('div');node.className='cal-notice-stack';parent.appendChild(node)}
    return node
  })
  useEffect(()=>{
    setVisible(true)
    if(error)return
    const timer=setTimeout(()=>setVisible(false),3000)
    return()=>clearTimeout(timer)
  },[children,error])
  if(!visible||!children)return null
  return createPortal(<div className="cal-action-notice atmos-controls" role={error?'alert':'status'}>
    <div>{children}</div><button type="button" className="icon-button" aria-label="Dismiss notification" onClick={()=>setVisible(false)}><X size={16}/></button>
  </div>,host)
}
