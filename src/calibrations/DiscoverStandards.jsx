import ActionNotice from './ActionNotice'
import { useEffect, useRef, useState } from 'react'
import { FolderOpen, Square, X } from 'lucide-react'
import { Dropdown } from '../components/AppPrimitives'
import { BoxFolderPicker } from '../features/projects/FolderPickers'
import { apiGet, apiSend } from '../api/client'
import { discoverStandards } from './discoverStandards.js'

export default function DiscoverStandards({projects,onDone,onClose,onBusy=()=>{}}) {
  const [project,setProject]=useState(''),[picker,setPicker]=useState(false),[busy,setBusy]=useState(false)
  const [status,setStatus]=useState(''),[error,setError]=useState('')
  const [groups,setGroups]=useState([])
  const controller=useRef(null)
  useEffect(()=>()=>controller.current?.abort(),[])
  async function run(projectId) {
    controller.current=new AbortController()
    const data=await apiGet(`/calibration-library/sources/${encodeURIComponent(projectId)}`)
    const result=await discoverStandards(projectId,data.files,{get:apiGet,send:apiSend,signal:controller.current.signal,progress:setStatus,onGrouped:setGroups})
    setStatus(`${result.runs} runs, ${result.series} series, ${result.peaks} proposed areas. ${result.created} drafts created; ${result.reused} existing drafts preserved.${result.failed?` ${result.failed} runs need attention.`:''}`)
    await onDone()
  }
  async function action(fn) {setBusy(true);onBusy(true);setError('');try{await fn()}catch(e){setError(e.name==='AbortError'?'Stopped; completed drafts are saved':e.message)}finally{setBusy(false);onBusy(false)}}
  async function folderPicked(folder) {
    setPicker(false)
    await action(async()=>{
      setStatus('Loading calibration folder')
      let source=projects.find(p=>p.can_edit!==false&&p.instruments?.some(i=>i.type==='GCMS'&&String(i.box_folder_id)===String(folder.id)))
      if(!source)source=await apiSend('/projects','POST',{
        id:`cal-source-${crypto.randomUUID()}`,name:`${folder.name} - Calibration source`,project_type:'gcms_calibration',collaborators:[],
        description:'Calibration source folder',instruments:[{type:'GCMS',short_name:'GC-MS',path:folder.path,
          path_mode:'box_root',box_folder_id:folder.id,box_folder_path:folder.path,include_subfolders:[],area_multiplier:60}],
      })
      setProject(source.id);await run(source.id)
    })
  }
  return <section className="cal-discover" aria-label="Populate calibration drafts">
    <div className="cal-section-heading"><h2>Populate drafts</h2><button className="icon-button" title="Close import" aria-label="Close import" disabled={busy} onClick={onClose}><X size={16}/></button></div>
    <div className="cal-toolbar">
      <Dropdown aria-label="Discovery source project" value={project} disabled={busy} onChange={setProject} menuPortal options={[{value:'',label:'Choose source project'},...projects.filter(p=>p.can_edit!==false).map(p=>({value:p.id,label:p.name}))]}/>
      <button className="primary-button" disabled={busy||!project} onClick={()=>action(()=>run(project))}>Populate from project</button>
      <button className="ghost-button" disabled={busy} onClick={()=>setPicker(true)}><FolderOpen size={16}/>Browse Box folder</button>
      {busy&&<button className="icon-button" title="Stop after current request" aria-label="Stop discovery" onClick={()=>controller.current?.abort()}><Square size={16}/></button>}
    </div>
    {picker&&<BoxFolderPicker title="Calibration source folder" instrumentType="GCMS" onPick={folderPicked} onCancel={()=>setPicker(false)}/>}
    {status&&<ActionNotice>{status}</ActionNotice>}
    {error&&<ActionNotice error>{error}</ActionNotice>}
    {groups.length>0&&<div className="cal-table-wrap" role="region" tabIndex={0} aria-label="Detected acquisition sequences"><table>
      <thead><tr><th>Series</th><th>Run sequence</th><th>Method / column</th><th>Review flags</th></tr></thead>
      <tbody>{groups.map(group=><tr key={group.key}><td>{group.label}<small>{group.files.length} runs</small></td>
        <td>{group.start.replace('T',' ')||'Unknown'}<small>{group.end.replace('T',' ')}</small></td>
        <td>{group.files[0].profile?.method||'Unknown method'}<small>{group.files[0].profile?.column_model||'Unknown column'}</small></td>
        <td>{group.warnings.join('; ')||'Pending review'}</td></tr>)}</tbody>
    </table></div>}
  </section>
}
