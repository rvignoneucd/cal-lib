import ActionNotice from './ActionNotice'
import {useEffect,useRef,useState} from 'react'
import {Plus,X} from 'lucide-react'
import {standardHint,concentrationOrder} from './standardHints.js'

export default function AddSeriesFiles({files,onAdd,onClose}) {
  const dialog=useRef(null),[query,setQuery]=useState(''),[selected,setSelected]=useState([])
  const [busy,setBusy]=useState(false),[error,setError]=useState('')
  useEffect(()=>{dialog.current.showModal()},[])
  const visible=files.filter(file=>query.toLowerCase().split(/\s+/).every(term=>file.filename.toLowerCase().includes(term))).sort(concentrationOrder)
  const all=visible.length>0&&visible.every(file=>selected.includes(file.id))
  async function add(){
    setBusy(true);setError('')
    try{await onAdd(files.filter(file=>selected.includes(file.id)));onClose()}
    catch(error){setError(error.message);setBusy(false)}
  }
  return <dialog ref={dialog} className="manual-dialog atmos-controls cal-file-picker" aria-labelledby="add-series-title" onCancel={event=>{event.preventDefault();if(!busy)onClose()}}>
    <div className="cal-section-heading"><h2 id="add-series-title">Add files to series</h2><button className="icon-button" aria-label="Close file picker" title="Close" disabled={busy} onClick={onClose}><X size={18}/></button></div>
    <label>Filter files<input autoFocus type="search" value={query} disabled={busy} onChange={event=>setQuery(event.target.value)}/></label>
    <div className="cal-toolbar"><label className="cal-file-choice"><input type="checkbox" disabled={busy||!visible.length} checked={all} ref={node=>{if(node)node.indeterminate=!all&&visible.some(file=>selected.includes(file.id))}} onChange={event=>setSelected(old=>event.target.checked?[...new Set([...old,...visible.map(file=>file.id)])]:old.filter(id=>!visible.some(file=>file.id===id)))}/>Select matching files</label><span>{visible.length} files · {selected.length} selected</span></div>
    <div className="cal-file-picker-list">{visible.map(file=>{const level=standardHint(file.filename).level;return <label className="cal-file-choice" key={file.id}>
      <input type="checkbox" aria-label={`Add ${file.filename}`} disabled={busy} checked={selected.includes(file.id)} onChange={event=>setSelected(old=>event.target.checked?[...old,file.id]:old.filter(id=>id!==file.id))}/>
      <span>{file.filename}<small>{level?`${level.value} ${level.unit}`:'Concentration unknown'}</small></span>
    </label>})}{!visible.length&&<p>No matching files.</p>}</div>
    {error&&<ActionNotice error>{error}</ActionNotice>}
    <footer className="cal-toolbar"><button className="ghost-button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy||!selected.length} onClick={add}><Plus size={16}/>{busy?'Adding files...':`Add selected (${selected.length})`}</button></footer>
  </dialog>
}
