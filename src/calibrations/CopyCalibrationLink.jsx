import {useEffect,useState} from 'react'
import ActionNotice from './ActionNotice'
import {Link,Check} from 'lucide-react'
import {calibrationLink} from './calibrationLink.js'

export default function CopyCalibrationLink({id,name,instrument,manual=false,compound}){
  const [copied,setCopied]=useState(false),[fallback,setFallback]=useState('')
  useEffect(()=>{if(!copied)return;const timer=setTimeout(()=>setCopied(false),2000);return()=>clearTimeout(timer)},[copied])
  async function copy(){
    const url=calibrationLink({id,instrument,manual,compound})
    try{await navigator.clipboard.writeText(url);setCopied(true);setFallback('')}
    catch{setCopied(false);setFallback(url)}
  }
  return <div className="cal-copy"><button type="button" className="icon-button" aria-label={`Copy link to ${name}`} title="Copy calibration link" onClick={copy}>{copied?<Check size={16}/>:<Link size={16}/>}</button><span className="cal-copy-feedback" role="status">{copied?'Link copied':''}</span>{fallback&&<ActionNotice error><label>Copy link<input aria-label="Calibration link" readOnly value={fallback} onFocus={e=>e.target.select()}/></label></ActionNotice>}</div>
}
