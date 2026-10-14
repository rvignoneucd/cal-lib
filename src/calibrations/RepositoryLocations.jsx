import ActionNotice from './ActionNotice'
import {useEffect,useRef,useState} from 'react'
import {Plus,Trash2,X,Save} from 'lucide-react'
import {Dropdown} from '../components/AppPrimitives'
import {apiGet,apiSend} from '../api/client'

export default function RepositoryLocations({instrument}){
  const [data,setData]=useState(null),[editor,setEditor]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const dialog=useRef(null)
  useEffect(()=>{let active=true;setData(null);setError('');apiGet(`/lab/repositories?instrument=${encodeURIComponent(instrument)}`).then(d=>{if(active)setData(d)}).catch(e=>{if(active)setError(e.message)});return()=>{active=false}},[instrument])
  useEffect(()=>{if(editor)dialog.current?.showModal();else dialog.current?.close()},[!!editor])
  function open(){if(data)setEditor({...data,instrument,locations:data.locations.map(r=>({...r,key:crypto.randomUUID()}))})}
  async function save(e){e.preventDefault();setBusy(true);setError('');try{const next=await apiSend(`/lab/repositories?instrument=${encodeURIComponent(editor.instrument)}`,'PUT',editor);setData(next);setEditor(null)}catch(e){setError(e.message)}finally{setBusy(false)}}
  return <div className="cal-repositories">
    <Dropdown aria-label={`${instrument} repositories`} value="" placeholder={`Repositories (${data?.locations.length??0})`} disabled={!data} options={[...(data?.locations||[]).map((r,i)=>({value:String(i),label:r.name,hint:`${r.path} · Pending connection`})),{value:'manage',label:'Manage locations...'}]} onChange={open} menuPortal/>
    {error&&!editor&&<ActionNotice error>{error}</ActionNotice>}
    <dialog ref={dialog} className="manual-dialog atmos-controls" aria-labelledby="repository-title" onCancel={e=>{if(busy)e.preventDefault();else setEditor(null)}}>{editor&&<form onSubmit={save}>
      <header className="cal-section-heading"><h2 id="repository-title">{editor.instrument} standard repositories</h2><button type="button" className="icon-button" disabled={busy} aria-label="Close repository locations" onClick={()=>setEditor(null)}><X size={18}/></button></header>
      <p className="cal-subtle">Saved mappings are pending connection. Network folders must be mounted on the Atmos host before import can be enabled. Existing GC-MS sync is unchanged.</p>
      {editor.locations.map((r,i)=><div className="cal-repository-row" key={r.key}><label>Name<input required maxLength={120} disabled={busy} value={r.name} onChange={e=>setEditor(old=>({...old,locations:old.locations.map((item,n)=>n===i?{...item,name:e.target.value}:item)}))}/></label><label>Network folder / mounted path<input required maxLength={1000} disabled={busy} value={r.path} onChange={e=>setEditor(old=>({...old,locations:old.locations.map((item,n)=>n===i?{...item,path:e.target.value}:item)}))}/></label><button type="button" className="icon-button" disabled={busy} aria-label={`Remove location ${i+1}`} onClick={()=>setEditor(old=>({...old,locations:old.locations.filter((_,n)=>n!==i)}))}><Trash2 size={16}/></button></div>)}
      <div className="cal-toolbar"><button type="button" className="ghost-button" disabled={busy||editor.locations.length>=20} onClick={()=>setEditor(old=>({...old,locations:[...old.locations,{key:crypto.randomUUID(),name:'',path:''}]}))}><Plus size={16}/>Add location</button><button className="primary-button" disabled={busy}><Save size={16}/>Save locations</button></div>{error&&<ActionNotice error>{error}</ActionNotice>}
    </form>}</dialog>
  </div>
}
