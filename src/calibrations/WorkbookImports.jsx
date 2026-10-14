import {useEffect,useRef,useState} from 'react'
import {createPortal} from 'react-dom'
import {Upload,Save,Check,X} from 'lucide-react'
import {Dropdown} from '../components/AppPrimitives'
import {apiGet,apiSend} from '../api/client'
import Plot from '../components/LazyPlotlyPlot'
import CurveDataBlocks from './CurveDataBlocks'

const instruments=['GC-MS','UV-VIS','LC-MS','Hapsite']
const units=['ug/mL','mg/mL','ng/mL','mg/L','ug/L','mol/L','mmol/L']
const opts=values=>values.map(value=>({value,label:value}))
const read=file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve({filename:file.name,data:reader.result.split(',')[1]});reader.onerror=reject;reader.readAsDataURL(file)})

export default function WorkbookImports({instrument,theme,onMenuChange}) {
  const [entries,setEntries]=useState([]),[editor,setEditor]=useState(null),[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[index,setIndex]=useState(0),[revision,setRevision]=useState(0),[target,setTarget]=useState(instrument)
  const dialog=useRef(null),lock=useRef(false)
  const curve=editor?.curves[index],readonly=editor?.status==='published'
  useEffect(()=>{let active=true;apiGet(`/lab/workbook-imports?instrument=${encodeURIComponent(instrument)}`).then(d=>{if(active)setEntries(d.entries)}).catch(e=>{if(active)setError(e.message)});return()=>{active=false}},[instrument,revision])
  useEffect(()=>{if(open)dialog.current?.showModal();else dialog.current?.close()},[open])
  useEffect(()=>{onMenuChange?.({open:()=>{setTarget(instrument);setOpen(true)},disabled:busy})},[onMenuChange,instrument,busy])
  async function action(fn){if(lock.current)return;lock.current=true;setBusy(true);setError('');try{await fn()}catch(e){setError(e.message||'Import failed')}finally{lock.current=false;setBusy(false)}}
  async function upload(files){await action(async()=>{if(files.length>10||[...files].some(f=>f.size>5000000))throw Error('Choose up to 10 workbooks, each under 5 MB');const result=await apiSend('/lab/workbook-imports/preview','POST',{instrument:target,files:await Promise.all([...files].map(read))});setEditor(result);setIndex(0)})}
  function change(fields){setEditor(old=>({...old,curves:old.curves.map((c,i)=>i===index?{...c,...fields,fit:null,reviewed:false}:c)}))}
  // Refit only the current snapshot; stale responses must not undo newer edits.
  useEffect(()=>{if(!curve||curve.fit||readonly)return;let active=true;const timer=setTimeout(()=>{apiSend('/lab/workbook-imports/fit','POST',curve).then(result=>{if(active)setEditor(old=>({...old,curves:old.curves.map(c=>c===curve?result:c)}))}).catch(e=>{if(active)setError(e.message)})},250);return()=>{active=false;clearTimeout(timer)}},[curve,readonly])
  const mark=fields=>setEditor(old=>({...old,curves:old.curves.map((c,i)=>i===index?{...c,...fields}:c)}))
  const selected=editor?.curves.filter(c=>c.selected)||[]
  async function save(publish){await action(async()=>{const result=await apiSend('/lab/workbook-imports','POST',{...editor,publish});setEditor(result);setRevision(n=>n+1)})}
  const fit=curve?.fit,dark=theme==='dark'
  return <section className="workbook-library">
    {!!entries.length&&<details><summary>Workbook imports ({entries.length})</summary>{entries.map(entry=><button key={entry.id} className="cal-text-link" onClick={()=>{setEditor(entry.status==='published'?{...entry,curves:entry.published_curves}:entry);setIndex(0);setOpen(true);setError('')}}>{(entry.published_curves||entry.curves).map(c=>c.compound).join(', ')} - {entry.status}</button>)}</details>}
    {!open&&error&&<p role="alert">{error}</p>}
    {createPortal(<dialog ref={dialog} className="manual-dialog atmos-controls workbook-dialog" onCancel={e=>{e.preventDefault();if(!busy)setOpen(false)}}>
      <header className="cal-toolbar"><h2>{readonly?'Published workbook curves':'Review workbook imports'}</h2><button className="icon-button" aria-label="Close import review" title="Close" disabled={busy} onClick={()=>setOpen(false)}><X size={18}/></button></header>
      {error&&<p role="alert">{error}</p>}
      {!editor?<div className="cal-fields"><label>Instrument<Dropdown aria-label="Import instrument" value={target} onChange={setTarget} options={opts(instruments)} menuPortal disabled={busy}/></label><label><Upload size={18}/>Workbooks (.xlsx)<input aria-label="Workbooks" type="file" accept=".xlsx" multiple disabled={busy} onChange={e=>upload(e.target.files)}/></label></div>:<>
        <p>{editor.instrument} - {editor.curves.length} curves - {editor.status}</p>
        {editor.updated_at&&<p role="status">Saved {new Date(editor.updated_at).toLocaleString()}</p>}
        {[...(editor.errors||[]),...(editor.warnings||[])].map((message,i)=><p role="alert" key={i}>{message}</p>)}
        <Dropdown aria-label="Review curve" value={String(index)} onChange={v=>setIndex(Number(v))} options={editor.curves.map((c,i)=>({value:String(i),label:`${c.compound} - ${c.reviewed?'Reviewed':'Needs review'}`}))} menuPortal/>
        {curve&&<><p className="cal-subtle">{curve.workbook} / {curve.sheet} / row {curve.header_row} {curve.source}</p>
          <fieldset disabled={busy||readonly}><div className="cal-fields"><label>Compound name<input value={curve.compound} onChange={e=>change({compound:e.target.value})}/></label><label>Concentration unit<Dropdown value={curve.unit} onChange={unit=>change({unit})} options={opts(units)} menuPortal disabled={busy||readonly}/></label><label>RT (min)<input type="number" min="0" step="any" value={curve.rt??''} onChange={e=>change({rt:e.target.value===''?null:Number(e.target.value)})}/></label><label>Response<input value={curve.response_type} onChange={e=>change({response_type:e.target.value})}/></label></div>
          <div className="workbook-review-grid"><div className="cal-table-wrap"><table><thead><tr><th>Include</th><th>Concentration</th><th>{curve.response_type}</th><th>Source row</th></tr></thead><tbody>{curve.points.map((point,i)=><tr key={i}><td><input aria-label={`Include row ${i+1}`} type="checkbox" checked={!point.excluded} onChange={e=>change({points:curve.points.map((p,j)=>i===j?{...p,excluded:!e.target.checked}:p)})}/></td>{['concentration','area'].map(key=><td key={key}><input aria-label={`${key} row ${i+1}`} type="number" min="0" step="any" value={point[key]??''} onChange={e=>change({points:curve.points.map((p,j)=>i===j?{...p,[key]:e.target.value===''?null:Number(e.target.value)}:p)})}/></td>)}<td>{point.source_row}<small>{point.note}</small></td></tr>)}</tbody></table></div>
          <div>{fit?<><Plot useDisplayPreferences={false} data={[{type:'scatter',mode:'markers',x:fit.points.map(p=>p.concentration),y:fit.points.map(p=>p.area),marker:{color:dark?'#7eacff':'#4472c4'}},{type:'scatter',mode:'lines',x:[fit.min,fit.max],y:[fit.min*fit.slope+fit.intercept,fit.max*fit.slope+fit.intercept],line:{color:dark?'#7eacff':'#4472c4',dash:'dot',width:2}}]} layout={{height:280,autosize:true,margin:{l:65,r:16,t:12,b:50},showlegend:false,paper_bgcolor:'transparent',plot_bgcolor:'transparent',font:{color:dark?'#eee':'#242a29'},xaxis:{range:[0,Math.max(1,fit.max)*1.05],title:{text:curve.unit}},yaxis:{range:[0,Math.max(1,...fit.points.map(p=>p.area),fit.max*fit.slope+fit.intercept)*1.05],tickformat:'.2e'}}} config={{displayModeBar:false,responsive:true}} style={{width:'100%',height:280}}/><CurveDataBlocks data={{...curve,fit:{...fit,points:fit.points.map(p=>({...p,rt:curve.rt}))}}}/></>:<p role="status">{curve.issue||'Updating curve...'}</p>}</div></div>
          {curve.notes&&<p>{curve.notes}</p>}
          <label className="cal-file-choice"><input type="checkbox" checked={curve.force_zero} onChange={e=>change({force_zero:e.target.checked,force_zero_manual:true})}/>Constrain through 0</label>
          <label className="cal-file-choice"><input type="checkbox" checked={curve.selected} onChange={e=>mark({selected:e.target.checked})}/>Include in publication</label>
          <label className="cal-file-choice"><input type="checkbox" checked={curve.reviewed} disabled={!fit} onChange={e=>mark({reviewed:e.target.checked})}/>Name, units and curve data reviewed</label></fieldset></>}
        {!readonly&&<div className="cal-toolbar"><button className="ghost-button" disabled={busy||!editor.curves.length} onClick={()=>save(false)}><Save size={16}/>Save import draft</button><button className="primary-button" disabled={busy||!selected.length||selected.some(c=>!c.reviewed||!c.fit)} onClick={()=>save(true)}><Check size={16}/>Publish selected ({selected.length})</button></div>}
        <button className="ghost-button" disabled={busy} onClick={()=>{if(readonly||window.confirm('Start another import? Save your current import draft first to keep any changes.')){setEditor(null);setError('')}}}><Upload size={16}/>Import more workbooks</button>
      </>}
    </dialog>,document.body)}
  </section>
}
