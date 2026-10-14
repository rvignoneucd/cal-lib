import {useEffect,useState} from 'react'
import ActionNotice from './ActionNotice'
import {Copy,Check} from 'lucide-react'

export default function CopyCalibration({name,getText}){
  const [state,setState]=useState(''),[error,setError]=useState('')
  useEffect(()=>{if(state!=='copied')return;const timer=setTimeout(()=>setState(''),2000);return()=>clearTimeout(timer)},[state])
  async function copy(){
    setState('copying');setError('')
    try{const value=await getText();await navigator.clipboard.writeText(value);setState('copied')}
    catch{setState('');setError('Copy failed. Check clipboard permission and retry.')}
  }
  return <div className="cal-copy"><button className="icon-button" type="button" disabled={state==='copying'} aria-label={`Copy ${name} to Excel`} title={state==='copied'?'Copied to clipboard':'Copy calibration table to Excel'} onClick={copy}>{state==='copied'?<Check size={16}/>:<Copy size={16}/>}</button><span className="cal-copy-feedback" role="status">{state==='copied'?'Copied':''}</span>{error&&<ActionNotice error>{error}</ActionNotice>}</div>
}
