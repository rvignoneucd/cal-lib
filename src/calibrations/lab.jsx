import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Download, Moon, Sun, Upload } from 'lucide-react'
import '../index.css'
import '../App.css'
import '../styles/controls.css'
import '../styles/dropdownMenu.css'
import { apiGet, apiSend, apiUpload } from '../api/client'
import { applyThemeMode } from '../features/chrome/appChromeUtils'
import AppErrorBoundary from '../components/AppErrorBoundary'
import { Dropdown } from '../components/AppPrimitives'
import SlidingPill from '../components/SlidingPill'
import CalibrationLibrary from './CalibrationLibrary'
import LabColumns from './LabColumns'
import WarningFlag from './WarningFlag'
import ManualCalibrations from './ManualCalibrations'
import WorkbookImports from './WorkbookImports'
import RepositoryLocations from './RepositoryLocations'
import './calibrations.css'
import './lab.css'
import InspectionSession from './InspectionSession'

function Lab() {
  const [theme,setTheme]=useState(()=>localStorage.getItem('cal.lab.theme')||'light')
  const [view,setView]=useState('curves'),[state,setState]=useState(null),[nist,setNist]=useState(null),[error,setError]=useState('')
  const [busy,setBusy]=useState(false)
  const [actionTarget,setActionTarget]=useState(null)
  const [libraryMenu,setLibraryMenu]=useState(null),[manualMenu,setManualMenu]=useState(null)
  const [instrument,setInstrument]=useState(()=>{const value=new URLSearchParams(window.location.search).get('instrument');return ['GC-MS','Orbitrap','UV-VIS','LC-MS','Hapsite'].includes(value)?value:'GC-MS'})
  const [workbookMenu,setWorkbookMenu]=useState(null)
  const [branch,setBranch]=useState(null),[branchError,setBranchError]=useState('')
  const [transferMessage,setTransferMessage]=useState('')
  const importInput=useRef(null)
  useEffect(()=>{
    let active=true
    setBranch(null);setBranchError('')
    apiGet(`/lab/instrument-library?instrument=${encodeURIComponent(instrument)}`)
      .then(data=>{if(active)setBranch(data)})
      .catch(error=>{if(active)setBranchError(error.message)})
    return ()=>{active=false}
  },[instrument])
  useEffect(()=>{applyThemeMode(document.documentElement,document.body,theme);localStorage.setItem('cal.lab.theme',theme)},[theme])
  useEffect(()=>{
    let alive=true
    const refresh=()=>apiGet('/lab/status').then(data=>{if(alive){setState(data);setError('')}}).catch(e=>{if(alive)setError(e.message)})
    refresh();const timer=setInterval(refresh,3000)
    apiGet('/lab/nist').then(data=>{if(alive)setNist(data)}).catch(e=>{if(alive)setNist({available:false,error:e.message})})
    return()=>{alive=false;clearInterval(timer)}
  },[])
  async function scan() {setBusy(true);setError('');try{await apiSend('/lab/scan','POST',{});setState(await apiGet('/lab/status'))}catch(e){setError(e.message)}finally{setBusy(false)}}
  function exportPublished(){setTransferMessage('Preparing published export…');window.location.assign('/api/lab/published/export')}
  async function importPublished(event){
    const file=event.target.files?.[0]
    event.target.value=''
    if(!file)return
    setBusy(true);setError('');setTransferMessage('Importing published calibrations…')
    try{const result=await apiUpload('/lab/published/import',file);setTransferMessage(`Imported ${result.calibrations} published calibration${result.calibrations===1?'':'s'}. Existing matching records were preserved.`);setPublishedRefresh(Date.now())}
    catch(e){setTransferMessage('');setError(e.message)}finally{setBusy(false)}
  }
  const [publishedRefresh,setPublishedRefresh]=useState(0)
  const job=state?.jobs?.[0],running=['queued','running'].includes(job?.state)
  const watchRoot=state?.selections?.[instrument]||state?.selection||{}
  return <div className="cal-site atmos-controls">
    <header className="cal-masthead"><a className="icon-button cal-brand-mark" href={`/?instrument=${encodeURIComponent(instrument)}`} aria-label="CalLib main library page" title="CalLib main library page"><img src="/cal-lib-logo.png" alt=""/></a><div><strong>CalLib</strong><span>Calibration library / {instrument}</span></div>
      <nav aria-label="Library"><Dropdown aria-label={`${instrument} menu`} placeholder="Menu" menuPortal value="" onChange={value=>{
        if(value==='custom'){manualMenu?.open();return}
        if(value==='workbooks'){workbookMenu?.open();return}
        if(value==='new'){if(instrument==='GC-MS')libraryMenu?.newCalibration();else manualMenu?.open();setView('curves');return}
        if(instrument!=='GC-MS')return
        if(value==='scan'){scan();return}
        if(value==='columns'){setView(view==='curves'?'columns':'curves');return}
      }} options={[
        {value:'custom',label:manualMenu?.label||'Add custom calibration',disabled:!manualMenu||manualMenu.disabled},
        {value:'workbooks',label:'Import workbooks',disabled:!workbookMenu||workbookMenu.disabled},
        {value:'new',label:'New calibration',disabled:instrument==='GC-MS'?!libraryMenu||libraryMenu.disabled:!manualMenu||manualMenu.disabled},
        {value:'scan',label:'Scan now',disabled:instrument!=='GC-MS'||busy||running},
        {value:'columns',label:view==='curves'?'Column inventory':'Back to curves',disabled:instrument!=='GC-MS'}]}/>
        <SlidingPill label="Instrument database" value={instrument} onChange={value=>{setInstrument(value);setView('curves')}} options={['GC-MS','Orbitrap','UV-VIS','LC-MS','Hapsite'].map(value=>({value,label:value}))}/>
        <RepositoryLocations instrument={instrument}/>
        <button className="icon-button" title="Export published database" aria-label="Export published database" disabled={busy} onClick={exportPublished}><Download size={18}/></button>
        <button className="icon-button" title="Import published database" aria-label="Import published database" disabled={busy} onClick={()=>importInput.current?.click()}><Upload size={18}/></button>
        <input ref={importInput} type="file" accept=".zip,application/zip" hidden onChange={importPublished}/>
        <button className="icon-button" title={theme==='light'?'Dark theme':'Light theme'} aria-label={theme==='light'?'Dark theme':'Light theme'} onClick={()=>setTheme(theme==='light'?'dark':'light')}>{theme==='light'?<Moon size={18}/>:<Sun size={18}/>}</button></nav>
    </header>
    {transferMessage&&<div className="cal-subtle" role="status" aria-live="polite">{transferMessage}</div>}
    <div className="lab-tools"><ManualCalibrations instrument={instrument} theme={theme} onSaved={setInstrument} onMenuChange={setManualMenu}/>
      <WorkbookImports instrument={instrument} theme={theme} onMenuChange={setWorkbookMenu}/>
    </div>
    <div hidden={view!=='curves'||instrument!=='GC-MS'}><CalibrationLibrary theme={theme} lab onDiscover={scan} refreshToken={`${job?.completed_at||''}:${publishedRefresh}`} onMenuChange={setLibraryMenu}/></div>
    <div hidden={instrument!=='GC-MS'}>{view==='columns'&&<LabColumns/>}</div>
    {instrument!=='GC-MS'&&<main className="cal-main"><h1>{instrument}</h1>{branchError?<p role="alert">{branchError}</p>:!branch?<p role="status">Loading database...</p>:<><p role="status">{branch.entries.length} file-derived calibrations</p>{branch.entries.length?<table><thead><tr><th>Compound</th><th>Name</th></tr></thead><tbody>{branch.entries.map(entry=><tr key={entry.id}><td>{entry.compound}</td><td>{entry.name}</td></tr>)}</tbody></table>:<p>No file-derived calibrations yet.</p>}<p className="cal-subtle">Instrument-specific file import is not available yet.</p></>}</main>}
    <footer className="lab-console" hidden={instrument!=='GC-MS'} aria-label="CalLib output">
      <div className="lab-console-heading"><div><strong>Output</strong><span>GC-MS intake</span></div><span className="lab-console-state">{running?'Importing':job?.state||'Waiting'}</span></div>
      <div className="lab-console-path"><small>Watch root</small><code title={watchRoot.path||'No GC-MS intake folder selected'}>{watchRoot.path||'No GC-MS intake folder selected'}</code></div>
      <div className="lab-metrics"><span>{watchRoot.file_count??0} files seen</span><span>{state?.source?.ids?.length??0} runs discovered</span><span>{nist?.available?'NIST connected':nist===null?'Checking NIST':'NIST needs attention'}</span>
        <span>Last folder sync: {state?.source?.synced_at?new Date(state.source.synced_at).toLocaleString():'Waiting'}</span></div>
      {job&&<p role="status">{running?job.progress:job.state==='complete'?`${job.result?.runs??0} runs / ${job.result?.series??0} sequences / ${job.result?.peaks??0} proposed areas. ${job.result?.created??0} new drafts; ${job.result?.reused??0} existing drafts preserved.`:job.error||job.state}</p>}
      {job?.result?.failed>0&&<p>{job.result.failed} run(s) could not be converted.</p>}
      {job?.result?.searchFailed>0&&<p>{job.result.searchFailed} peak searches need a NIST retry.</p>}
      {error&&<p className="cal-alert" role="alert">{error}</p>}
      {state?.watch_error?.error&&<p className="cal-alert" role="alert">{state.watch_error.error}</p>}
      {nist?.error&&<p className="cal-alert">{nist.error}</p>}
      {job?.sequences?.length>0&&<details><summary>Detected sequences ({job.sequences.length})</summary><div className="cal-table-wrap" tabIndex={0}><table><thead><tr><th>Series</th><th>Acquired</th><th>Runs</th><th>Review flags</th></tr></thead>
        <tbody>{job.sequences.map(g=><tr key={g.key}><td>{g.label} <WarningFlag message={[...g.warnings,...(g.file_warnings||[]).map(f=>`${f.filename}: ${f.message}`)].join('; ')}/></td><td>{g.start?.replace('T',' ')}<small>{g.end?.replace('T',' ')}</small></td><td>{g.runs}</td><td>{(g.file_warnings||[]).map(f=><div key={f.id}>{f.filename} <WarningFlag message={f.message}/></div>)}</td></tr>)}</tbody></table></div></details>}
    </footer>
  </div>
}
createRoot(document.getElementById('root')).render(<StrictMode><AppErrorBoundary>{location.pathname==='/inspection/'?<InspectionSession/>:<Lab/>}</AppErrorBoundary></StrictMode>)
