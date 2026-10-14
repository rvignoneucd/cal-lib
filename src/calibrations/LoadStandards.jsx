import ActionNotice from './ActionNotice'
import { useEffect, useState } from 'react'
import { FolderOpen, X } from 'lucide-react'
import { Dropdown } from '../components/AppPrimitives'
import { apiGet } from '../api/client'
import { standardGroups, standardHint } from './standardHints'

export default function LoadStandards({projects,projectId,lockedProject,onLoad,onClose}) {
  const [project,setProject]=useState(projectId||''),[files,setFiles]=useState([]),[selected,setSelected]=useState([])
  const [reference,setReference]=useState(''),[loading,setLoading]=useState(false),[error,setError]=useState('')
  const [group,setGroup]=useState('')
  const groups=standardGroups(files)
  const visible=group?groups.find(g=>g.key===group)?.files||[]:files
  useEffect(()=>{
    let active=true
    setFiles([]);setSelected([]);setReference('');setError('');setGroup('')
    if(!project)return
    setLoading(true)
    apiGet(`/calibration-library/sources/${encodeURIComponent(project)}`)
      .then(data=>{if(active)setFiles(data.files)})
      .catch(e=>{if(active)setError(e.message)})
      .finally(()=>{if(active)setLoading(false)})
    return()=>{active=false}
  },[project])
  return <div className="cal-load-standards" role="region" aria-label="Load internal-standard runs">
    <div className="cal-section-heading"><h3>Load IS</h3><button className="icon-button" title="Close run picker" aria-label="Close run picker" onClick={onClose}><X size={16}/></button></div>
    <div className="cal-fields">
      <label>Run project<Dropdown aria-label="Run project" value={project} disabled={lockedProject} onChange={setProject} menuPortal
        options={[{value:'',label:'Choose project'},...projects.filter(p=>p.can_edit!==false).map(p=>({value:p.id,label:p.name}))]}/></label>
      <label>Lowest-level run<Dropdown aria-label="Lowest-level run" value={reference} onChange={setReference} disabled={loading} menuPortal
        options={[{value:'',label:'Choose comparison reference'},...files.filter(f=>selected.includes(f.id)).map(f=>({value:f.id,label:f.filename}))]}/></label>
      <label>Series<Dropdown aria-label="Standard series" value={group} disabled={loading} onChange={setGroup} menuPortal
        options={[{value:'',label:'All runs'},...groups.map(g=>({value:g.key,label:`${g.label} | ${g.start.replace('T',' ')||'Time unknown'} | ${g.files.length} runs | ${g.files[0]?.profile?.column_model||'Column unknown'}`}))]}/></label>
    </div>
    <div className="cal-toolbar"><button className="ghost-button" disabled={!visible.length} onClick={()=>setSelected(old=>[...new Set([...old,...visible.map(f=>f.id)])])}>Select visible runs</button><span>{selected.length} selected</span></div>
    {loading&&<p role="status">Loading GC-MS runs...</p>}
    {error&&<ActionNotice error>{error}</ActionNotice>}
    {!loading&&project&&!files.length&&!error&&<p>No GC-MS runs in this project.</p>}
    <div className="cal-run-selection">{visible.map(file=>{const hint=standardHint(file.filename);return <label className="cal-check" key={file.id}>
      <input type="checkbox" aria-label={`Load ${file.filename}`} checked={selected.includes(file.id)} onChange={e=>{
        setSelected(old=>e.target.checked?[...old,file.id]:old.filter(id=>id!==file.id));if(!e.target.checked&&reference===file.id)setReference('')
      }}/><span>{file.filename}<small className="cal-subtle">{hint.level?` | Filename level: ${hint.level.value} ${hint.level.unit}`:hint.blank?' | Blank; zero not assumed':''}{hint.warning?` | ${hint.warning}`:''}</small></span></label>})}</div>
    <button className="primary-button" disabled={loading||!selected.length} onClick={()=>onLoad({project_id:project,files:files.filter(f=>selected.includes(f.id)),reference})}><FolderOpen size={16}/>Load selected IS runs</button>
  </div>
}
