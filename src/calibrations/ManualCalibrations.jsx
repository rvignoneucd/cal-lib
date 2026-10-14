import ActionNotice from './ActionNotice'
import {useEffect,useRef,useState} from 'react'
import {createPortal} from 'react-dom'
import {Plus,Trash2,X,Save,Pencil} from 'lucide-react'
import {Dropdown} from '../components/AppPrimitives'
import SlidingPill from '../components/SlidingPill'
import {apiGet,apiSend} from '../api/client'
import Plot from '../components/LazyPlotlyPlot'
import CopyCalibration from './CopyCalibration'
import ExcelCalibration from './ExcelCalibration'
import CopyCalibrationLink from './CopyCalibrationLink'
import {manualClipboardRows} from './calibrationClipboard.js'

const instruments=['GC-MS','UV-VIS','LC-MS','Hapsite']
const units=['mg/mL','ug/mL','ng/mL','mg/L','ug/L','mol/L','mmol/L']
const options=values=>values.map(value=>({value,label:value}))
const row=()=>({key:crypto.randomUUID(),compound:'',identity:null,concentration:'',unit:'mg/mL',rt:'',wavelength:'',response:''})
const fresh=instrument=>({id:crypto.randomUUID(),instrument,source:'',method:'',date:'',notes:'',response_type:instrument==='UV-VIS'?'Absorbance':'Area',rows:[row()]})

function CompoundField({value,instrument,onChange,index,disabled}){
  const [matches,setMatches]=useState([]),[message,setMessage]=useState('')
  useEffect(()=>{
    let cancelled=false
    setMatches([]);setMessage('')
    if(value.compound.trim().length<2||value.identity)return
    const timer=setTimeout(()=>{
      setMessage('Looking up compounds...')
      apiGet(`/lab/compound-suggestions?q=${encodeURIComponent(value.compound)}&instrument=${encodeURIComponent(instrument)}`)
        .then(data=>{if(!cancelled){setMatches(data.results);setMessage(data.warning||'')}})
        .catch(()=>{if(!cancelled)setMessage('Lookup unavailable. Name can be saved as unverified.')})
    },400)
    return()=>{cancelled=true;clearTimeout(timer)}
  },[value.compound,value.identity,instrument])
  return <div><label>Compound name<input required maxLength={180} aria-label={`Compound ${index+1}`} value={value.compound} disabled={disabled} onChange={e=>onChange({compound:e.target.value,identity:null})}/></label>
    {!!matches.length&&<Dropdown aria-label={`Compound matches ${index+1}`} value="" disabled={disabled} placeholder="Select a known compound" options={matches.map((m,i)=>({value:String(i),label:`${m.name} (${m.source}${m.cid?` CID ${m.cid}`:''})`}))} onChange={key=>{const m=matches[Number(key)];onChange({compound:m.name,identity:{name:m.name,source:m.source,cid:m.cid||null}})}} menuPortal/>}
    <small>{value.identity?`${value.identity.source} selected${value.identity.cid?` · CID ${value.identity.cid}`:''}`:message||'Unverified name'}</small>
  </div>
}

function ManualPlot({curve,theme}){
  const fit=curve.fit,dark=theme==='dark'
  if(!fit)return <small>{curve.issue||'No fitted curve'}</small>
  return <div className="manual-fit"><strong>R² {fit.r2.toPrecision(5)} · Manual fit</strong><Plot useDisplayPreferences={false} data={[
    {type:'scatter',mode:'markers',x:fit.points.map(p=>p.concentration),y:fit.points.map(p=>p.area),marker:{color:dark?'#58d8c2':'#087f72'}},
    {type:'scatter',mode:'lines',x:[fit.min,fit.max],y:[fit.min*fit.slope+fit.intercept,fit.max*fit.slope+fit.intercept],line:{color:dark?'#fbbf67':'#a5510e'}}
  ]} layout={{width:256,height:256,margin:{l:54,r:12,t:12,b:45},showlegend:false,paper_bgcolor:'transparent',plot_bgcolor:'transparent',font:{color:dark?'#eee':'#242a29',size:11},xaxis:{title:{text:curve.unit}},yaxis:{tickformat:'.2e'}}} config={{displayModeBar:false}} style={{width:256,height:256}}/></div>
}

export default function ManualCalibrations({instrument,theme,onSaved,actionTarget,onMenuChange}){
  const [entries,setEntries]=useState([]),[error,setError]=useState(''),[editor,setEditor]=useState(()=>{try{return JSON.parse(sessionStorage.getItem('cal.manual.draft')||'null')}catch{return null}}),[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0)
  const dialog=useRef(null)
  const linkedRow=useRef(null)
  useEffect(()=>{
    const id=new URLSearchParams(window.location.search).get('manual')
    if(id&&entries.some(entry=>entry.id===id))linkedRow.current?.scrollIntoView({block:'center'})
  },[entries])
  useEffect(()=>{try{if(editor)sessionStorage.setItem('cal.manual.draft',JSON.stringify(editor));else sessionStorage.removeItem('cal.manual.draft')}catch{}},[editor])
  useEffect(()=>{let active=true;setEntries([]);setError('');apiGet(`/lab/manual-calibrations?instrument=${encodeURIComponent(instrument)}`).then(d=>{if(active)setEntries(d.entries)}).catch(e=>{if(active)setError(e.message)});return()=>{active=false}},[instrument,revision])
  useEffect(()=>{if(open)dialog.current?.showModal();else dialog.current?.close()},[open])
  useEffect(()=>{onMenuChange?.({count:entries.length,label:editor?'Resume custom calibration':'Add custom calibration',disabled:busy||!!editor&&editor.instrument!==instrument,open:()=>{if(!editor)setEditor(fresh(instrument));setError('');setOpen(true)}})},[onMenuChange,entries.length,editor,instrument,busy])
  const update=fields=>setEditor(old=>({...old,...fields}))
  const updateRow=(key,fields)=>setEditor(old=>({...old,rows:old.rows.map(r=>r.key===key?{...r,...fields}:r)}))
  async function save(event){
    event.preventDefault();setBusy(true);setError('')
    try{await apiSend('/lab/manual-calibrations','POST',editor);onSaved?.(editor.instrument);setOpen(false);setEditor(null);setRevision(n=>n+1)}catch(e){setError(e.message)}finally{setBusy(false)}
  }
  return <section className="manual-library" aria-label="Manual calibrations">
    {!onMenuChange&&(()=>{const button=<button className="primary-button" onClick={()=>{if(!editor)setEditor(fresh(instrument));setError('');setOpen(true)}}><Plus size={16}/>{editor?'Resume custom calibration':'Add custom calibration'}</button>;return actionTarget?createPortal(button,actionTarget):button})()}
    {error&&!open&&<ActionNotice error>{error}</ActionNotice>}
    {!!entries.length&&<div className="cal-table-wrap"><table><thead><tr><th>Compound / concentration</th><th>Source / method</th><th>Date</th><th>Type</th><th/><th aria-label="Copy to Excel"/><th aria-label="Excel workbook"/></tr></thead><tbody>{entries.map(entry=><tr key={entry.id}>
      <td>{entry.curves.map((curve,i)=><div key={i}><strong>{curve.compound}</strong>{curve.wavelength&&<small>{curve.wavelength} nm</small>}<ManualPlot curve={curve} theme={theme}/></div>)}<details><summary>{entry.rows.length} measurements</summary>{entry.rows.map((r,i)=><p key={i}>{r.compound}: {r.concentration} {r.unit}{r.rt!=null?` · RT ${r.rt} min`:''}{r.response!=null?` · ${entry.response_type} ${r.response}`:''}</p>)}</details></td>
      <td>{entry.source||'-'}<small>{entry.method}</small></td><td>{entry.date?.replace('T',' ')||'-'}</td><td><span className="manual-badge">Manual entry</span></td><td><button className="icon-button" disabled={!!editor} aria-label={`Edit manual entry ${entry.source||entry.rows[0].compound}`} title="Edit manual entry" onClick={()=>{setEditor({...entry,rows:entry.rows.map(r=>({...r,key:crypto.randomUUID()}))});setError('');setOpen(true)}}><Pencil size={16}/></button></td><td><CopyCalibration name={entry.source||entry.rows[0].compound} getText={()=>manualClipboardRows(entry)}/></td>
      <td ref={new URLSearchParams(window.location.search).get('manual')===entry.id?linkedRow:null}><ExcelCalibration name={entry.source||entry.rows[0].compound} getData={()=>entry}/><CopyCalibrationLink id={entry.id} name={entry.source||entry.rows[0].compound} instrument={entry.instrument} manual/>{new URLSearchParams(window.location.search).get('manual')===entry.id&&<span className="manual-badge">Linked calibration</span>}</td>
    </tr>)}</tbody></table></div>}
    <dialog ref={dialog} className="manual-dialog atmos-controls" aria-labelledby="manual-title" onCancel={e=>{e.preventDefault();if(!busy)setOpen(false)}}>
      {editor&&<form onSubmit={save}><header className="cal-section-heading"><h2 id="manual-title">Custom calibration</h2><button type="button" className="icon-button" disabled={busy} aria-label="Close and keep draft" title="Close and keep draft" onClick={()=>setOpen(false)}><X size={18}/></button></header>
        <fieldset disabled={busy}><SlidingPill label="Manual instrument" value={editor.instrument} onChange={value=>update({instrument:value,response_type:value==='UV-VIS'?'Absorbance':'Area'})} options={instruments.map(value=>({value,label:value,disabled:!!editor.revision}))}/>
        <div className="cal-fields"><label>Source<input maxLength={500} value={editor.source} onChange={e=>update({source:e.target.value})}/></label><label>Method<input maxLength={500} value={editor.method} onChange={e=>update({method:e.target.value})}/></label><label>Measurement date<input type="datetime-local" value={editor.date} onChange={e=>update({date:e.target.value})}/></label><label>Response type<Dropdown aria-label="Response type" value={editor.response_type} options={options(editor.instrument==='UV-VIS'?['Absorbance']:['Area','Height'])} onChange={response_type=>update({response_type})} menuPortal/></label></div>
        <div className="manual-rows">{editor.rows.map((r,i)=><div className="manual-row" key={r.key}>
          <CompoundField value={r} instrument={editor.instrument} index={i} disabled={busy} onChange={fields=>updateRow(r.key,fields)}/>
          <label>Concentration<input required type="number" min="0" step="any" aria-label={`Concentration ${i+1}`} value={r.concentration} onChange={e=>updateRow(r.key,{concentration:e.target.value})}/></label>
          <label>Unit<Dropdown aria-label={`Unit ${i+1}`} value={r.unit} options={options(units)} onChange={unit=>updateRow(r.key,{unit})} menuPortal/></label>
          <label>{editor.instrument==='UV-VIS'?'Wavelength (nm)':'RT (min, optional)'}<input type="number" min="0" step="any" aria-label={`Position ${i+1}`} value={(editor.instrument==='UV-VIS'?r.wavelength:r.rt)??''} onChange={e=>updateRow(r.key,{[editor.instrument==='UV-VIS'?'wavelength':'rt']:e.target.value})}/></label>
          <label>{editor.response_type} (optional)<input type="number" min="0" step="any" aria-label={`Response ${i+1}`} value={r.response??''} onChange={e=>updateRow(r.key,{response:e.target.value})}/></label>
          <button type="button" className="icon-button" disabled={editor.rows.length===1} aria-label={`Remove row ${i+1}`} title="Remove row" onClick={()=>update({rows:editor.rows.filter(item=>item.key!==r.key)})}><Trash2 size={16}/></button>
        </div>)}</div>
        <button type="button" className="ghost-button" disabled={editor.rows.length>=200} onClick={()=>update({rows:[...editor.rows,row()]})}><Plus size={16}/>Add row</button>
        <label>Notes<textarea maxLength={4000} value={editor.notes} onChange={e=>update({notes:e.target.value})}/></label></fieldset>
        {error&&<ActionNotice error>{error}</ActionNotice>}
        <footer className="cal-toolbar"><button type="submit" className="primary-button" disabled={busy}><Save size={16}/>{busy?'Saving...':'Save manual entry'}</button><button type="button" className="ghost-button" disabled={busy} onClick={()=>{setEditor(null);setOpen(false)}}>Discard draft</button></footer>
      </form>}
    </dialog>
  </section>
}
