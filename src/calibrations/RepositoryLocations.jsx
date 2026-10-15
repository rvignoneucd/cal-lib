import ActionNotice from './ActionNotice'
import {useEffect,useState} from 'react'
import {ChevronLeft,FolderOpen,Plus,Trash2,X,Save} from 'lucide-react'
import {Dropdown} from '../components/AppPrimitives'
import {apiGet,apiSend} from '../api/client'

export default function RepositoryLocations({instrument}){
  const [data,setData]=useState(null),[source,setSource]=useState(null),[job,setJob]=useState(null),[editor,setEditor]=useState(null),[browser,setBrowser]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('')
  useEffect(()=>{let active=true;setData(null);setSource(null);setJob(null);setError('');Promise.all([apiGet(`/lab/repositories?instrument=${encodeURIComponent(instrument)}`),apiGet(`/lab/source-selection?instrument=${encodeURIComponent(instrument)}`),apiGet('/lab/status')]).then(([locations,selection,status])=>{if(active){setData(locations);setSource(status.selections?.[instrument]||selection);setJob(status.jobs?.[0]||null)}}).catch(e=>{if(active)setError(e.message)});return()=>{active=false}},[instrument])
  useEffect(()=>{
    if(!job||!['queued','running'].includes(job.state))return
    const poll=()=>apiGet('/lab/status').then(status=>{setSource(status.selections?.[instrument]||null);setJob(status.jobs?.[0]||null)}).catch(()=>{})
    const timer=setInterval(poll,1500)
    return()=>clearInterval(timer)
  },[job?.state,instrument])
  function newKey(){return `${instrument}-${Date.now()}-${Math.random().toString(36).slice(2)}`}
  function open(){if(data){setNotice('');setBrowser(null);setEditor({...data,instrument,locations:(data.locations.length?data.locations:[{name:'',path:''}]).map(r=>({...r,key:newKey()}))})}}
  function relativePath(path){
    const root='/mnt/Nguyen Lab',value=String(path||'').trim()
    if(!value||value===root)return ''
    return value.startsWith(`${root}/`)?value.slice(root.length).replace(/^\/+/,''):value.replace(/^\/+/,'')
  }
  async function browse(row, path=''){
    setError('');setBrowser({row,loading:true,data:null})
    try{const next=await apiGet(`/lab/repository-browse?path=${encodeURIComponent(relativePath(path))}`);setBrowser({row,loading:false,data:next})}
    catch(e){setBrowser(null);setError(e.message)}
  }
  function useFolder(){
    const path=browser?.data?.absolute_path
    if(!path)return
    setEditor(old=>({...old,locations:old.locations.map((item,n)=>n===browser.row?{...item,path}:item)}))
    setBrowser(null)
  }
  async function useAsSource(){
    const path=browser?.data?.absolute_path
    if(!path)return
    setBusy(true);setError('');setNotice('')
    try{setEditor(old=>({...old,locations:old.locations.map((item,n)=>n===browser.row?{...item,path}:item)}));const selection=await apiSend(`/lab/source-selection?instrument=${encodeURIComponent(instrument)}`,'PUT',{path});setSource(selection);if(instrument==='GC-MS'){const scan=await apiSend('/lab/scan','POST',{});setJob(scan.job);setNotice('GC-MS intake root selected. Scan started.')}else setNotice(`${instrument} watch root selected. The folder will be checked automatically.`);setBrowser(null)}
    catch(e){setError(e.message)}finally{setBusy(false)}
  }
  async function save(e){e.preventDefault();setBusy(true);setError('');try{const next=await apiSend(`/lab/repositories?instrument=${encodeURIComponent(editor.instrument)}`,'PUT',editor);setData(next);setEditor(null);setNotice(editor.instrument==='GC-MS'&&!source?.path?'Repository saved. Choose Browse, then Use for GC-MS intake to start importing runs.':'Repository locations saved.')}catch(e){setError(e.message)}finally{setBusy(false)}}
  return <div className="cal-repositories">
    <Dropdown aria-label={`${instrument} repositories`} value="" placeholder={`Repositories (${data?.locations.length??0})`} disabled={!data} options={[...(data?.locations||[]).map((r,i)=>({value:String(i),label:r.name,hint:`${r.path} · Pending connection`})),{value:'manage',label:'Manage locations...'}]} onChange={value=>{if(value==='manage')open()}} menuPortal/>
    {error&&!editor&&<ActionNotice error>{error}</ActionNotice>}
    {notice&&!editor&&<ActionNotice>{notice}</ActionNotice>}
    {source?.path&&<div className="cal-watch-status" aria-live="polite"><span>{instrument} watch root</span><code title={source.path}>{source.path}</code><span className="cal-watch-progress">{job?.state==='running'||job?.state==='queued'?job.progress||'Scanning...':job?.state==='complete'?`${job.result?.runs??0} runs imported`:`${Number(source.file_count||0).toLocaleString()} files found`}</span></div>}
    {editor&&<div className="cal-modal" role="dialog" aria-modal="true" aria-labelledby="repository-title" tabIndex={-1} onKeyDown={e=>{if(e.key==='Escape'&&!busy)setEditor(null)}}><form className="cal-modal-card atmos-controls" onSubmit={save}>
      <header className="cal-section-heading"><h2 id="repository-title">{editor.instrument} standard repositories</h2><button type="button" className="icon-button" disabled={busy} aria-label="Close repository locations" onClick={()=>setEditor(null)}><X size={18}/></button></header>
      <p className="cal-subtle">Browse the mounted Nguyen Lab share, choose a folder, and save it as a repository. Each instrument can have its own watched root. GC-MS also uses its selected root for intake scanning.</p>
      {editor.locations.map((r,i)=><div className="cal-repository-row" key={r.key}><label>Name<input required maxLength={120} disabled={busy} value={r.name} onChange={e=>setEditor(old=>({...old,locations:old.locations.map((item,n)=>n===i?{...item,name:e.target.value}:item)}))}/></label><label>Network folder / mounted path<div className="cal-path-picker"><input required maxLength={1000} disabled={busy} value={r.path} onChange={e=>setEditor(old=>({...old,locations:old.locations.map((item,n)=>n===i?{...item,path:e.target.value}:item)}))}/><button type="button" className="ghost-button" disabled={busy} onClick={()=>browse(i,r.path)}><FolderOpen size={16}/>Browse</button></div></label><button type="button" className="icon-button" disabled={busy} aria-label={`Remove location ${i+1}`} onClick={()=>setEditor(old=>({...old,locations:old.locations.filter((_,n)=>n!==i)}))}><Trash2 size={16}/></button></div>)}
      {browser&&<section className="cal-location-browser" aria-label="Mounted folder browser"><header><div><strong>Mounted Nguyen Lab share</strong><small>{browser.data?.absolute_path||'Loading...'}</small></div><button type="button" className="icon-button" disabled={busy||browser.loading||!browser.data?.parent_path} aria-label="Parent folder" onClick={()=>browse(browser.row,browser.data.parent_path)}><ChevronLeft size={18}/></button></header>{browser.loading?<p className="cal-subtle">Loading folders...</p>:<><div className="cal-browser-list">{browser.data.entries.map(entry=><button type="button" key={entry.path} className="cal-browser-entry" disabled={busy} onClick={()=>browse(browser.row,entry.path)}><FolderOpen size={16}/><span>{entry.name}</span></button>)}{browser.data.entries.length===0&&<p className="cal-subtle">No subfolders.</p>}</div><div className="cal-toolbar"><button type="button" className="ghost-button" disabled={busy} onClick={useFolder}>Use this folder</button><button type="button" className="primary-button" disabled={busy} onClick={useAsSource}>{instrument==='GC-MS'?'Use for GC-MS intake':'Use as watched root'}</button></div></>}</section>}
      <div className="cal-toolbar"><button type="button" className="ghost-button" disabled={busy||editor.locations.length>=20} onClick={()=>setEditor(old=>({...old,locations:[...old.locations,{key:newKey(),name:'',path:''}]}))}><Plus size={16}/>Add location</button><button className="primary-button" disabled={busy}><Save size={16}/>Save locations</button></div>{error&&<ActionNotice error>{error}</ActionNotice>}
    </form></div>}
  </div>
}
