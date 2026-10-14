import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Database, Moon, Sun } from 'lucide-react'
import '../index.css'
import '../App.css'
import '../styles/controls.css'
import '../styles/dropdownMenu.css'
import { apiGet, apiSend } from '../api/client'
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
  const [instrument,setInstrument]=useState(()=>{const value=new URLSearchParams(window.location.search).get('instrument');return ['GC-MS','UV-VIS','LC-MS','Hapsite'].includes(value)?value:'GC-MS'})
  const [workbookMenu,setWorkbookMenu]=useState(null)
  const [branch,setBranch]=useState(null),[branchError,setBranchError]=useState('')
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
  const job=state?.jobs?.[0],running=['queued','running'].includes(job?.state)
  const runProgress=running?job?.progress?.match(/Run (\d+)\/(\d+):/):null
  return <div className="cal-site atmos-controls">
    <header className="cal-masthead"><a className="icon-button" href={`/?instrument=${encodeURIComponent(instrument)}`} aria-label="Main library page" title="Main library page"><Database size={26}/></a><div><strong>Curve Library</strong><span>Lab / {instrument}</span></div>
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
        <SlidingPill label="Instrument database" value={instrument} onChange={value=>{setInstrument(value);setView('curves')}} options={['GC-MS','UV-VIS','LC-MS','Hapsite'].map(value=>({value,label:value}))}/>
        <RepositoryLocations instrument={instrument}/>
        <button className="icon-button" title={theme==='light'?'Dark theme':'Light theme'} aria-label={theme==='light'?'Dark theme':'Light theme'} onClick={()=>setTheme(theme==='light'?'dark':'light')}>{theme==='light'?<Moon size={18}/>:<Sun size={18}/>}</button></nav>
    </header>
    <div className="lab-tools"><ManualCalibrations instrument={instrument} theme={theme} onSaved={setInstrument} onMenuChange={setManualMenu}/>
      <WorkbookImports instrument={instrument} theme={theme} onMenuChange={setWorkbookMenu}/>
    </div>
    {instrument==='GC-MS'&&running&&<section className="lab-intake-status" aria-label="Ingestion status" aria-live="polite" aria-atomic="true">
      <strong>{error?'Intake status unavailable':running?'Importing calibration files':job?.state==='error'||job?.state==='interrupted'?'Import needs attention':job?.state==='complete'?'Import complete':'Waiting for folder sync'}</strong>
      {running&&<progress aria-label="Calibration file ingestion" max={runProgress?Number(runProgress[2]):undefined} value={runProgress?Math.max(0,Number(runProgress[1])-1):undefined}/>}
      <span>{error|| (running?job.progress:job?.state==='complete'?`${job.result?.runs??0} runs checked; ${job.result?.created??0} new drafts; ${job.result?.reused??0} existing drafts preserved.`:job?.error||'New files appear after the source folder syncs.')}</span>
      {job?.state==='complete'&&(job.result?.failed>0||job.result?.searchFailed>0)&&<span role="alert">{job.result.failed||0} failed runs; {job.result.searchFailed||0} NIST searches need retry. See intake console for details.</span>}
      {state?.watch_error?.error&&<span role="alert">Folder watcher: {state.watch_error.error}</span>}
      <small>{state?.source.ids?.length??0} source files · Last sync: {state?.source.synced_at?new Date(state.source.synced_at).toLocaleString():'Waiting'}</small>
    </section>}
    <div hidden={view!=='curves'||instrument!=='GC-MS'}><CalibrationLibrary theme={theme} lab onDiscover={scan} refreshToken={job?.completed_at} onMenuChange={setLibraryMenu}/></div>
    <div hidden={instrument!=='GC-MS'}>{view==='columns'&&<LabColumns/>}</div>
    {instrument!=='GC-MS'&&<main className="cal-main"><h1>{instrument}</h1>{branchError?<p role="alert">{branchError}</p>:!branch?<p role="status">Loading database...</p>:<><p role="status">{branch.entries.length} file-derived calibrations</p>{branch.entries.length?<table><thead><tr><th>Compound</th><th>Name</th></tr></thead><tbody>{branch.entries.map(entry=><tr key={entry.id}><td>{entry.compound}</td><td>{entry.name}</td></tr>)}</tbody></table>:<p>No file-derived calibrations yet.</p>}<p className="cal-subtle">Instrument-specific file import is not available yet.</p></>}</main>}
    <footer className="lab-console" hidden={instrument!=='GC-MS'}><details><summary>Intake console · {state?.source.ids?.length??0} runs · {running?'Scanning':job?.state||'Waiting'}</summary>
      <div className="lab-metrics"><span>{state?.source.ids?.length??0} source runs</span><span>{nist?.available?'NIST connected':nist===null?'Checking NIST':'NIST needs attention'}</span>
        <span>Last folder sync: {state?.source.synced_at?new Date(state.source.synced_at).toLocaleString():'Waiting'}</span></div>
      {job&&<p role="status">{running?job.progress:job.state==='complete'?`${job.result?.runs??0} runs / ${job.result?.series??0} sequences / ${job.result?.peaks??0} proposed areas. ${job.result?.created??0} new drafts; ${job.result?.reused??0} existing drafts preserved.`:job.error||job.state}</p>}
      {job?.result?.failed>0&&<p>{job.result.failed} run(s) could not be converted.</p>}
      {job?.result?.searchFailed>0&&<p>{job.result.searchFailed} peak searches need a NIST retry.</p>}
      {error&&<p className="cal-alert" role="alert">{error}</p>}
      {state?.watch_error?.error&&<p className="cal-alert" role="alert">{state.watch_error.error}</p>}
      {nist?.error&&<p className="cal-alert">{nist.error}</p>}
      {job?.sequences?.length>0&&<details><summary>Detected sequences ({job.sequences.length})</summary><div className="cal-table-wrap" tabIndex={0}><table><thead><tr><th>Series</th><th>Acquired</th><th>Runs</th><th>Review flags</th></tr></thead>
        <tbody>{job.sequences.map(g=><tr key={g.key}><td>{g.label} <WarningFlag message={[...g.warnings,...(g.file_warnings||[]).map(f=>`${f.filename}: ${f.message}`)].join('; ')}/></td><td>{g.start?.replace('T',' ')}<small>{g.end?.replace('T',' ')}</small></td><td>{g.runs}</td><td>{(g.file_warnings||[]).map(f=><div key={f.id}>{f.filename} <WarningFlag message={f.message}/></div>)}</td></tr>)}</tbody></table></div></details>}
    </details></footer>
  </div>
}
createRoot(document.getElementById('root')).render(<StrictMode><AppErrorBoundary>{location.pathname==='/inspection/'?<InspectionSession/>:<Lab/>}</AppErrorBoundary></StrictMode>)
