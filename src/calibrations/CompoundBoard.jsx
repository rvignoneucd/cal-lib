import ActionNotice from './ActionNotice'
import {useEffect,useState} from 'react'
import {ArrowLeft,ArrowRight,Scale,X,Undo2} from 'lucide-react'
import {apiGet,apiSend} from '../api/client'
import ToggleSwitch from '../components/ToggleSwitch'

export default function CompoundBoard({draftId,disabled,navigationDisabled=false,onOpen,onChanged}) {
  const [data,setData]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('')
  useEffect(()=>{let alive=true;apiGet(`/lab/compounds/${draftId}`).then(value=>{if(alive)setData(value)}).catch(e=>{if(alive)setError(e.message)});return()=>{alive=false}},[draftId])
  async function change(id,payload){
    setBusy(true);setError('')
    try{setData(await apiSend(`/lab/compounds/${id}`,'PUT',payload));await onChanged()}
    catch(e){setError(e.message)}finally{setBusy(false)}
  }
  const locked=disabled||busy
  const references=data?.items.filter(item=>item.role==='normalize')||[]
  const action=(item,role,label,Icon)=><button className="icon-button" title={label} aria-label={`${label}: ${item.compound}`} disabled={locked} onClick={()=>change(item.id,{role})}><Icon size={15}/></button>
  const row=item=><div className="cal-compound-row" key={item.id}>
    <div><button className="cal-text-link" disabled={locked||navigationDisabled} title={navigationDisabled?'Save or discard draft edits before opening another compound':undefined} onClick={()=>onOpen(item.id)}>{item.compound}</button>
      <small>{item.rt?.toFixed(3)} min · {item.qualification?.runs??'?'} runs · Match {item.candidate?.match_score??'-'}</small>
      {item.role==='calibration'&&<div className="cal-is-toggle"><label htmlFor={`normalize-${item.id}`}>Normalize by IS</label><ToggleSwitch id={`normalize-${item.id}`} aria-label={`Normalize by IS: ${item.compound}`} checked={!!item.normalization?.enabled} disabled={locked||(!item.normalization?.enabled&&references.length!==1)} onChange={normalization=>change(item.id,{normalization})}/><small>{references.length===1?references[0].compound:'Select one IS in Normalize List'}</small></div>}
    </div><div className="cal-compound-actions">
      {item.role!=='found'&&action(item,'found','Return to found',ArrowLeft)}
      {item.role!=='calibration'&&action(item,'calibration','Use for calibration',ArrowRight)}
      {item.role!=='normalize'&&action(item,'normalize','Use for normalization',Scale)}
      {action(item,'excluded','Exclude compound',X)}
    </div>
  </div>
  return <section className="cal-compound-board" aria-label="Compound assignment">
    {error&&<ActionNotice error>{error}</ActionNotice>}
    <div className="cal-compound-columns">{[['found','Found List'],['calibration','Calibration List'],['normalize','Normalize List']].map(([role,label])=><section key={role} aria-label={label}>
      <h2>{label} <small>{data?.items.filter(item=>item.role===role).length??0}</small></h2>
      <div className="cal-compound-items">{data?.items.filter(item=>item.role===role).map(row)}</div>
    </section>)}</div>
    {!!data?.items.some(item=>item.role==='excluded')&&<details><summary>Excluded compounds ({data.items.filter(item=>item.role==='excluded').length})</summary>{data.items.filter(item=>item.role==='excluded').map(item=><div className="cal-compound-row" key={item.id}><span>{item.compound}</span>{action(item,'found','Restore compound',Undo2)}</div>)}</details>}
  </section>
}
