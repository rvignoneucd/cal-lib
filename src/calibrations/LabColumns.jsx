import ActionNotice from './ActionNotice'
import { useEffect, useState } from 'react'
import { Plus, Save } from 'lucide-react'
import { apiGet, apiSend } from '../api/client'

const fields=[['name','Name'],['manufacturer','Manufacturer'],['serial','Serial number'],['column_model','Model'],['column_phase','Stationary phase'],['column_length_m','Length (m)'],['column_id_um','Internal diameter (um)'],['column_film_um','Film thickness (um)']]
export default function LabColumns() {
  const [columns,setColumns]=useState([]),[draft,setDraft]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const refresh=()=>apiGet('/calibration-library/columns').then(d=>setColumns(d.columns))
  useEffect(()=>{refresh().catch(e=>setError(e.message))},[])
  async function save(){setBusy(true);setError('');try{await apiSend('/calibration-library/columns','POST',draft);setDraft(null);await refresh()}catch(e){setError(e.message)}finally{setBusy(false)}}
  return <main className="cal-main"><div className="cal-title"><h1>Column inventory</h1><button className="primary-button" disabled={!!draft} onClick={()=>setDraft({project_id:'cal-test',active:true})}><Plus size={16}/>Add column</button></div>
    {error&&<ActionNotice error>{error}</ActionNotice>}
    {draft&&<section><div className="cal-fields">{fields.map(([key,label])=><label key={key}>{label}<input value={draft[key]||''} disabled={busy} onChange={e=>setDraft({...draft,[key]:e.target.value})}/></label>)}</div>
      <label className="cal-check"><input type="checkbox" checked={draft.active} disabled={busy} onChange={e=>setDraft({...draft,active:e.target.checked})}/>Active</label>
      <div className="cal-toolbar"><button className="primary-button" disabled={busy} onClick={save}><Save size={16}/>Save column</button><button className="ghost-button" disabled={busy} onClick={()=>setDraft(null)}>Cancel</button></div></section>}
    <div className="cal-table-wrap"><table><thead><tr><th>Column</th><th>Phase</th><th>Geometry</th><th>Status</th></tr></thead><tbody>{columns.map(c=><tr key={c.id}><td><button className="cal-text-link" disabled={!!draft} onClick={()=>setDraft(c)}>{c.name}</button><small>{c.column_model} / {c.serial||'No serial'}</small></td><td>{c.column_phase}</td><td>{c.column_length_m} m / {c.column_id_um} um / {c.column_film_um} um</td><td>{c.active?'Active':'Retired'}</td></tr>)}</tbody></table></div>
  </main>
}
