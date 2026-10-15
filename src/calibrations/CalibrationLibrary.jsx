import ActionNotice from './ActionNotice'
import { Fragment, useEffect, useRef, useState } from 'react'
import ChevronIndicator from '../components/ChevronIndicator'
import { ArrowLeft, Plus, Save, RefreshCw, GitBranch, Check, ExternalLink, Download, Trash2, FolderOpen, Pencil, X } from 'lucide-react'
import { Dropdown } from '../components/AppPrimitives'
import SlidingPill from '../components/SlidingPill'
import Plot from '../components/LazyPlotlyPlot'
import { apiGet, apiSend } from '../api/client'
import PrepareStandards from './PrepareStandards'
import CompoundBoard from './CompoundBoard'
import CompoundInfo from './CompoundInfo'
import CurveDataBlocks from './CurveDataBlocks'
import CompoundNameInput from './CompoundNameInput'
import CopyCalibration from './CopyCalibration'
import ExcelCalibration from './ExcelCalibration'
import CopyCalibrationLink from './CopyCalibrationLink'
import OpenInAtmos from './OpenInAtmos'
import LibrarySourceGroups from './LibrarySourceGroups'
import {calibrationClipboardTable as calibrationClipboardRow} from './calibrationClipboard.js'
import LoadStandards from './LoadStandards'
import DiscoverStandards from './DiscoverStandards.jsx'
import { applySeriesReview } from './applySeriesReview.js'
import { addSeriesFile } from './addSeriesFile.js'
import { publishReviewedDraft } from './publishReviewedDraft.js'
import { currentDraftPreview } from './currentDraftPreview.js'
import { targetDraft } from './targetDraft.js'
import { saveDraft } from './saveDraft.js'
import { concentrationOrder } from './standardHints.js'
import { libraryColumns, sortLibrary } from './librarySort.js'

const ROOT = '/calibration-library'
const FIELDS = [['instrument','Instrument'],['instrument_label','GC label'],['method','Method'],['column_model','Column model'],['column_phase','Stationary phase'],
  ['column_length_m','Column length (m)'],['column_id_um','Internal diameter (um)'],['column_film_um','Film thickness (um)'],
  ['acquisition_mode','Acquisition mode'],['area_multiplier','Area multiplier'],['integration','Integration convention']]
const options = values => values.map(value => ({value,label:value}))
const format = value => Number.isFinite(value) ? Number(value).toPrecision(6) : '-'
const pubchemLookupName = entry => entry.nist_match_name || entry.compound
const highlightedPeak = (data,index) => {
  if(!data||index===null||index===undefined)return null
  const fit=data.fit||data.preview?.fit
  const point=fit?.points?.[index]
  const evidence=fit?.evidence?.find(item=>item.dataset_id===point?.dataset_id)
  return evidence?.analyte&&point?{...evidence.analyte,dataset_id:point.dataset_id,concentration:point.concentration}:null
}
const emptyDraft = () => ({name:'',compound:'',project_id:'',mode:'external',unit:'ug/mL',profile:{response:'TIC'},rows:[],force_zero:false,versions:[],editable:true})
function InstrumentMeta({profile}) {
  const label=profile?.instrument_label||profile?.instrument||'-'
  return <><strong>{label}</strong>{profile?.instrument_label&&profile?.instrument&&<small>{profile.instrument}</small>}</>
}

function CurvePlot({ fit, mode, unit, theme, normalized=false, compact=false, highlightedPoint=null, onHighlight }) {
  const dark = theme === 'dark'
  const ratio = mode === 'internal'
  return <><div className="cal-plot" aria-label="Calibration fit chart">
    <Plot useDisplayPreferences={false} data={[
      {type:'scatter',mode:'markers',name:'Standards',x:fit.points.map(p=>p.concentration),y:fit.points.map(p=>p.area),customdata:fit.points.map(p=>[p.concentration]),hovertemplate:'(%{customdata[0]}, %{y:.2e})<extra></extra>',marker:{color:fit.points.map(p=>p.unconfirmed_manual?(dark?'#7eacff':'#4472c4'):(dark?'#7eacff':'#4472c4')),symbol:fit.points.map(p=>p.unconfirmed_manual?'diamond-open':'circle'),size:fit.points.map((_,i)=>i===highlightedPoint?14:10)}}, 
      {type:'scatter',mode:'lines',name:'Fit',x:[fit.min,fit.max],y:[fit.min*fit.slope+fit.intercept,fit.max*fit.slope+fit.intercept],line:{color:dark?'#7eacff':'#4472c4',width:2,dash:'dot'}},
    ]} layout={{autosize:true,margin:compact?{l:58,r:10,t:12,b:50}:{l:72,r:22,t:18,b:70},paper_bgcolor:'transparent',plot_bgcolor:'transparent',
      font:{color:dark?'#eceeed':'#242a29',size:12},showlegend:false,dragmode:compact?false:'zoom',
      xaxis:{fixedrange:compact,range:[0,Math.max(1,fit.max)*1.05],title:{text:ratio?'Concentration ratio':`Concentration (${unit})`},gridcolor:dark?'#4c514f':'#dce2df',zeroline:false},
      yaxis:{fixedrange:compact,range:[0,Math.max(1,...fit.points.map(p=>p.area),fit.max*fit.slope+fit.intercept)*1.05],title:{text:compact?'':ratio||normalized?'Area ratio':'Integrated area'},gridcolor:dark?'#4c514f':'#dce2df',zeroline:false,tickformat:'.2e'}}}
      onHover={e=>{if(compact)onHighlight?.(e.points?.[0]?.curveNumber===0?e.points[0].pointNumber:null)}} onUnhover={()=>onHighlight?.(null)} config={{displayModeBar:false,responsive:true,...(compact?{scrollZoom:false,doubleClick:false}: {})}} style={{width:'100%',height:'100%'}} useResizeHandler/>
  </div>{fit.points.some(p=>p.unconfirmed_manual)&&<small>Open diamonds: unconfirmed manual areas included in provisional R².</small>}</>
}

function CurveThumbnail({id,load,theme,refreshToken,onFit,onLabel,onData,hideCaption=false,highlightedPoint=null,onHighlight}) {
  const [data,setData]=useState(null)
  const loader=useRef(load)
  loader.current=load
  useEffect(()=>{
    let cancelled=false
    setData(null);onData?.(old=>({...old,[id]:null}))
    loader.current(id).then(value=>{if(!cancelled){setData(value);onData?.(old=>({...old,[id]:value}));onFit?.(old=>({...old,[id]:(value.fit||value.preview?.fit)?.r2??null}))}})
      .catch(error=>{if(!cancelled){setData({previewError:error.message});onFit?.(old=>({...old,[id]:null}))}})
    return ()=>{cancelled=true}
  },[id,refreshToken])
  const fit=data?.fit||data?.preview?.fit
  const caption=fit?`R² = ${format(fit.r2)}${data.fit?'':' · Provisional'}`:data?'R² unavailable':'Loading curve...'
  useEffect(()=>{onLabel?.(old=>old[id]===caption?old:{...old,[id]:caption})},[id,caption,onLabel])
  return <figure className="cal-curve-thumbnail" aria-label="Curve preview">
    <div className="cal-curve-thumbnail-chart">{fit?<CurvePlot compact highlightedPoint={highlightedPoint} onHighlight={onHighlight} fit={fit} mode={data.fit?data.mode:'external'} unit={data.unit} normalized={!data.fit&&data.preview?.normalized} theme={theme}/>:<span role="status">{data?(data.previewError||data.preview?.issue||data.fit_error||'No fitted curve'):'Loading curve...'}</span>}</div>
    {!hideCaption&&<figcaption>{caption}</figcaption>}
  </figure>
}

function CurveSummary({draft,theme,onInclude,disabled}) {
  const fit=draft.fit||draft.preview?.fit
  const provisional=!draft.fit
  const points=onInclude?(draft.preview?.points||fit?.points||[]):provisional?(draft.preview?.points||[]):(fit?.points||[])
  return <div className="cal-inline-preview">
    <div className="cal-table-wrap"><table aria-label="Curve data"><thead><tr><th>Concentration ({draft.unit})</th><th>{draft.preview?.normalized?'Area ratio':'Peak area'}</th><th>RT (min)</th></tr></thead><tbody>
      {points.map((point,index)=><tr key={index} title={point.filename}><td>{onInclude&&<input type="checkbox" aria-label={`Include ${point.concentration} ${draft.unit}`} checked={!draft.rows.find(r=>r.dataset_id===point.dataset_id)?.excluded} disabled={disabled} onChange={e=>onInclude(point.dataset_id,e.target.checked)}/>} {point.concentration}</td><td>{format(point.area)}</td><td>{Number.isFinite(point.rt)?point.rt.toFixed(3):'-'}</td></tr>)}
    </tbody></table>{!points.length&&<p>No matched points.</p>}</div>
    <div>{provisional&&<p className="cal-subtle">{draft.preview?.normalized?`Provisional: area / ${draft.preview.reference} area. IS concentration undocumented; equal concentration assumed. Not published.`:'Provisional: raw peak area vs filename concentration. Not an internal-standard ratio or a published calibration.'}</p>}
      {fit?<><CurvePlot fit={fit} mode={provisional?'external':draft.mode} normalized={provisional&&draft.preview?.normalized} unit={draft.unit} theme={theme}/>
        <p className="cal-equation">y = {format(fit.slope)}x {fit.intercept<0?'-':'+'} {format(Math.abs(fit.intercept))} | R² = {format(fit.r2)}</p>
        <p aria-label="Slope">Slope: {Number.isFinite(fit.slope)?fit.slope.toLocaleString('en-US',{maximumFractionDigits:6}):'-'}</p>
      </>:<p>{draft.preview?.issue||draft.fit_error||'No fitted curve yet.'}</p>}
      {!!draft.preview?.issues?.length&&<details><summary>{draft.preview.issues.length} runs need attention</summary>{draft.preview.issues.map((issue,index)=><p key={index}>{issue}</p>)}</details>}
    </div>
  </div>
}

export default function CalibrationLibrary({ theme, lab=false, onDiscover, refreshToken, onActionTarget, onMenuChange }) {
  const [mobile,setMobile]=useState(()=>window.matchMedia('(max-width: 700px)').matches)
  const [mobileExpanded,setMobileExpanded]=useState({})
  useEffect(()=>{
    const media=window.matchMedia('(max-width: 700px)')
    const update=()=>setMobile(media.matches)
    media.addEventListener('change',update)
    return()=>media.removeEventListener('change',update)
  },[])
  const [entries,setEntries] = useState([]), [projects,setProjects] = useState([]), [query,setQuery] = useState('')
  const [draft,setDraft] = useState(null), [files,setFiles] = useState([]), [view,setView] = useState('draft')
  const savedBaseline=useRef(null),actionRunning=useRef(false)
  const [busy,setBusy] = useState(false), [loading,setLoading] = useState(true), [sourceLoading,setSourceLoading] = useState(false)
  const [error,setError] = useState(''), [status,setStatus] = useState(''), [dirty,setDirty] = useState(false), [confirmed,setConfirmed] = useState(false)
  const [filter,setFilter] = useState('published')
  const [librarySort,setLibrarySort]=useState({key:'compound',direction:'ascending'})
  const [curveFits,setCurveFits]=useState({})
  const [curveLabels,setCurveLabels]=useState({})
  const [curveData,setCurveData]=useState({})
  const [highlightedPoints,setHighlightedPoints]=useState({})
  const [activeRun,setActiveRun]=useState(null)
  async function deleteDraft(entry) {
    if(!window.confirm(`Delete draft "${entry.compound||entry.name||'Unassigned compound'}"? Source files and published calibrations will be kept.`))return
    await action(async()=>{
      await apiSend(`${ROOT}/${entry.id}?revision=${entry.revision}`,'DELETE')
      setPreviews({});await refresh();setStatus('Draft deleted. Source files kept.')
    })
  }
  const deleteButton=entry=>!entry.published_count&&entry.editable&&<button className="icon-button" title="Delete draft" aria-label={`Delete draft ${entry.compound||entry.name||'Unassigned compound'}`} disabled={busy} onClick={()=>deleteDraft(entry)}><X size={17}/></button>
  const [libraryVersions,setLibraryVersions]=useState({}),[selectedVersions,setSelectedVersions]=useState({})
  async function loadLibraryVersion(id){
    const data=await loadDraft(id)
    setLibraryVersions(old=>({...old,[id]:data.versions||[]}))
    const selected=selectedVersions[id]
    if(selected==='draft')return data
    return data.versions?.find(version=>version.version===selected)||data.versions?.[0]||data
  }
  const [preparing,setPreparing] = useState(false)
  const [loadingIS,setLoadingIS] = useState(false),[prepRequest,setPrepRequest]=useState(null)
  const [discovering,setDiscovering]=useState(false)
  const [columns,setColumns]=useState([])
  const [expanded,setExpanded]=useState({}),[previews,setPreviews]=useState({})
  const [seriesConfirmed,setSeriesConfirmed]=useState(false)
  const [seriesExpanded,setSeriesExpanded]=useState({}),[otherExpanded,setOtherExpanded]=useState({})
  useEffect(()=>{
    const id=new URLSearchParams(window.location.search).get('calibration')
    if(!lab||!id)return
    let active=true
    setBusy(true)
    loadDraft(id).then(data=>{if(active)accept(data)}).catch(()=>{if(active)setError('This calibration link is unavailable. It may have been removed, or you may not have access.')}).finally(()=>{if(active)setBusy(false)})
    return()=>{active=false}
  },[lab])
  async function loadDraft(id) {
    const data=await apiGet(`${ROOT}/${id}`)
    if(lab&&data.discovery){
      return currentDraftPreview(data,await apiSend('/lab/preview','POST',data))
    }
    return data
  }
  async function togglePreview(id) {
    setExpanded(old=>({...old,[id]:!old[id]}))
    if(previews[id])return
    try {const data=await loadDraft(id);setPreviews(old=>({...old,[id]:data}))}
    catch(error){setPreviews(old=>({...old,[id]:{previewError:error.message}}))}
  }
  useEffect(()=>{if(lab&&draft)apiGet(`${ROOT}/columns`).then(data=>setColumns(data.columns)).catch(e=>setError(e.message))},[lab,draft?.id])
  const searchSeq = useRef(0)
  async function refresh() {
    const seq = ++searchSeq.current
    const data = await apiGet(`${ROOT}?q=${encodeURIComponent(query)}`)
    if(lab){const {roles}=await apiGet('/lab/compound-roles');data.entries=data.entries.map(entry=>({...entry,assignedRole:roles[entry.id]}))}
    if (seq === searchSeq.current) setEntries(data.entries)
  }
  useEffect(() => {
    let cancelled = false
    apiGet('/projects').then(data => {if (!cancelled) setProjects((data.projects || []).filter(p => !p.is_demo))})
      .catch(e=>{if(!cancelled)setError(e.message)})
    return () => {cancelled=true}
  }, [])
  useEffect(() => {
    const timer = setTimeout(() => {setLoading(true); refresh().catch(e=>setError(e.message)).finally(()=>setLoading(false))},150)
    return () => clearTimeout(timer)
  }, [query,refreshToken])
  useEffect(() => {
    let cancelled = false
    setFiles([])
    if (!draft?.project_id) return
    setSourceLoading(true)
    let refreshing=false
    const refreshSources=async(initial=false)=>{
      if(refreshing||cancelled)return
      refreshing=true
      try {
        const data=await apiGet(`${ROOT}/sources/${encodeURIComponent(draft.project_id)}`)
        if(!cancelled)setFiles(data.files)
      } catch(e) {if(initial&&!cancelled)setError(e.message)}
      finally {refreshing=false;if(!cancelled)setSourceLoading(false)}
    }
    refreshSources(true)
    return () => {cancelled=true}
  },[draft?.project_id])
  useEffect(() => {
    if (!dirty) return
    const guard = e => {e.preventDefault(); e.returnValue=''}
    window.addEventListener('beforeunload',guard)
    return () => window.removeEventListener('beforeunload',guard)
  },[dirty])
  function update(fields) {setDraft(old=>({...old,...fields}));setDirty(true);setConfirmed(false);setSeriesConfirmed(false);setStatus('')}
  function rowUpdate(index, fields) {update({rows:draft.rows.map((row,i)=>i===index?{...row,...fields}:row)})}
  async function changeZero(force_zero) {
    const next={...draft,force_zero,force_zero_manual:true,fit:null}
    update(next)
    if(lab&&next.discovery)await action(async()=>{
      const preview=await apiSend('/lab/preview','POST',next)
      setDraft(old=>({...old,preview}))
    })
  }
  async function includeConcentration(id,included) {
    const next={...draft,fit:null,rows:draft.rows.map(row=>row.dataset_id===id?{...row,excluded:!included,reason:included?'':row.reason||'Excluded by analyst from curve review'}:row)}
    update(next)
    await action(async()=>{const preview=await apiSend('/lab/preview','POST',next);setDraft(old=>({...old,preview}))})
  }
  async function action(fn) {
    if(actionRunning.current)return
    actionRunning.current=true
    setBusy(true);setError('');setStatus('')
    try {await fn()} catch(e) {setError(e.message)} finally {actionRunning.current=false;setBusy(false)}
  }
  function accept(next) {savedBaseline.current=structuredClone(next);setDraft(next);setDirty(false);setConfirmed(false);setSeriesConfirmed(false);setView('draft')}
  async function applyReview() {
    if(!seriesConfirmed)return
    await action(async()=>{
      const next=await applySeriesReview(draft,{get:apiGet,send:apiSend,confirmCompound:true})
      next.preview=await apiSend('/lab/preview','POST',next)
      const source=await apiGet(`${ROOT}/sources/${encodeURIComponent(draft.project_id)}`)
      setFiles(source.files);accept(next);setPreviews({});await refresh()
      setStatus(next.fit?'Series review saved. Calibration is ready for publication.':`Review saved. ${next.fit_error}`)
    })
  }
  async function open(id) {await action(async()=>accept(await loadDraft(id)))}
  async function save() {
    await action(async()=>{
      let next = await saveDraft(draft,savedBaseline.current||draft,{get:apiGet,send:apiSend,onSaved:accept})
      if(lab&&next.discovery)next=currentDraftPreview(next,await apiSend('/lab/preview','POST',next))
      accept(next);setStatus('Draft saved');await refresh()
    })
  }
  async function publish() {
    await action(async()=>{
      const next=lab?await publishReviewedDraft(draft,{get:apiGet,send:apiSend}):await apiSend(`${ROOT}/${draft.id}/publish`,'POST',{revision:draft.revision,confirmed})
      accept(next);setView(next.versions[0].version);setStatus('Version published');await refresh()
    })
  }
  async function variant() {
    await action(async()=>{accept(await apiSend(`${ROOT}/${draft.id}/variants`,'POST',{version:view}));setStatus('Variant created');await refresh()})
  }
  async function importMethod() {
    const id = draft.rows.find(r=>r.dataset_id)?.dataset_id
    if(!id) {setError('Choose a run before reading its acquisition metadata');return}
    await action(async()=>{
      const result=await apiGet(`${ROOT}/sources/${draft.project_id}/${id}/method`)
      const blankFields=Object.fromEntries(Object.entries(result.profile).filter(([key,value])=>value&&!draft.profile[key]))
      update({profile:{...draft.profile,...blankFields}})
      setStatus(`Acquisition source: ${result.source}`)
    })
  }
  function selectColumn(column_id) {
    const column=columns.find(c=>c.id===column_id)
    if(!column){update({column_id:null});return}
    const profile={...draft.profile}
    for(const key of ['column_model','column_phase','column_length_m','column_id_um','column_film_um'])profile[key]=column[key]
    update({column_id,profile})
  }
  function loadIS({project_id,files:chosen,reference}) {
    const ids=chosen.map(file=>file.id)
    const changedProject=project_id!==draft.project_id
    const profile={...(changedProject?{response:'TIC'}:draft.profile)}
    // Only fill blanks shared by the selected runs. Never replace typed values
    // or choose arbitrarily between conflicting acquisition metadata.
    for(const key of [...FIELDS.map(([key])=>key),'method_signature']) {
      const values=[...new Set(chosen.map(file=>String(file.profile?.[key]||'')).filter(Boolean))]
      if(!profile[key]&&values.length===1)profile[key]=values[0]
    }
    update({project_id,profile,mode:'internal',name:draft.name||`${projects.find(p=>p.id===project_id)?.name||'GC-MS'} - IS`,
      rows:changedProject?ids.map(dataset_id=>({dataset_id,peak_id:'',is_peak_id:'',concentration:'',is_concentration:''})):
        [...draft.rows,...ids.filter(id=>!draft.rows.some(row=>row.dataset_id===id)).map(dataset_id=>({dataset_id,peak_id:'',is_peak_id:'',concentration:'',is_concentration:''}))]})
    setLoadingIS(false);setPrepRequest({id:crypto.randomUUID(),ids,reference})
  }
  const shown = view==='draft'?draft:draft?.versions?.find(v=>v.version===view)
  const editable = view==='draft' && draft?.editable && !busy && !preparing
  const fit = shown?.fit
  const visible = entries.filter(entry=>filter==='all'||filter==='other'||(filter==='published'?entry.published_count>0:entry.published_count===0))
  const displayEntries=[]
  if(lab){
    displayEntries.push(...visible.filter(entry=>{
      if(filter==='draft'||filter==='all')return true
      const standard=!!entry.published_count||(entry.assignedRole?entry.assignedRole==='calibration':!entry.qualification||entry.qualification.qualified)
      return filter==='other'?!standard:standard
    }).sort((a,b)=>(a.compound||'').localeCompare(b.compound||'')||(a.series||'').localeCompare(b.series||'')))
  }else displayEntries.push(...visible)
  useEffect(()=>{onMenuChange?.({count:entries.length,disabled:busy||dirty,newCalibration:()=>{accept(emptyDraft());setError('')}})},[onMenuChange,entries.length,busy,dirty])
  const sortedEntries=sortLibrary(displayEntries,mobile&&librarySort.key==='curve'?{...librarySort,key:'compound'}:librarySort,curveFits,projects,query)
  return <main className={`cal-main${lab?' cal-lab-main':''}`}>
    {error && <ActionNotice error>{error}</ActionNotice>}
    {status && <ActionNotice>{status}</ActionNotice>}
    {!draft ? <>
      {!onMenuChange&&<div className="cal-title"><div>{!lab&&<h1>Curve library</h1>}<span>{entries.length} calibrations</span></div>
        {lab&&<span className="cal-custom-action" ref={onActionTarget}/>}
        {!lab&&<button className="ghost-button" disabled={busy} onClick={()=>setDiscovering(value=>!value)}><FolderOpen size={17}/>Populate drafts</button>}
        <button className="primary-button" disabled={busy} onClick={()=>{accept(emptyDraft());setError('')}}><Plus size={17}/>New calibration</button></div>}
      {discovering&&<DiscoverStandards projects={projects} onBusy={setBusy} onClose={()=>setDiscovering(false)} onDone={async()=>{await refresh();const data=await apiGet('/projects');setProjects((data.projects||[]).filter(p=>!p.is_demo))}}/>}
      <div className="cal-toolbar">
        <input type="text" aria-label="Search calibrations" placeholder={lab?'Compound, filename, CAS, instrument or column':'Compound, CAS, instrument or column'} value={query} onChange={e=>setQuery(e.target.value)}/>
        <SlidingPill label="Library status" value={filter} onChange={setFilter} options={[{value:'published',label:'Published'},{value:'all',label:'All'},{value:'draft',label:'Drafts'},...(lab?[{value:'other',label:mobile?'Other':'Other detections',accessibleLabel:'Other detections'}]:[])]}/>
        <button className="icon-button" title="Refresh library" aria-label="Refresh library" disabled={busy} onClick={()=>action(refresh)}><RefreshCw size={17}/></button>
      </div>
      {lab&&mobile&&<div className="cal-mobile-sort"><label>Sort by<Dropdown aria-label="Sort compounds" value={librarySort.key==='curve'?'compound':librarySort.key} options={libraryColumns.filter(([key])=>key!=='curve').map(([value,label])=>({value,label}))} onChange={key=>setLibrarySort(old=>({...old,key}))} menuPortal/></label><button className="icon-button" aria-label={librarySort.direction==='ascending'?'Sort descending':'Sort ascending'} title="Reverse sort order" onClick={()=>setLibrarySort(old=>({...old,direction:old.direction==='ascending'?'descending':'ascending'}))}><ChevronIndicator direction={librarySort.direction==='ascending'?'up':'down'}/></button></div>}
      {loading?<p role="status">Loading library...</p>:lab&&filter==='all'?<LibrarySourceGroups entries={sortedEntries} projects={projects} query={query} disabled={busy} onCreate={group=>{accept({...emptyDraft(),name:group.label,project_id:'cal-test',profile:{...group.files[0]?.profile,response:'TIC'},discovery:{series:group.label,files:group.files,preparations:[],review_state:'pending'}});setError('')}} renderDetails={entry=><div className="cal-mobile-details">
        <div className="cal-source-preview"><CompoundInfo name={entry.compound} lookupName={pubchemLookupName(entry)} theme={theme}/><CurveThumbnail id={entry.id} load={loadLibraryVersion} theme={theme} refreshToken={`${refreshToken}:${entry.updated_at}`} onFit={setCurveFits}/></div>
        <p className="cal-subtle"><InstrumentMeta profile={entry.profile}/>{[entry.profile.method,entry.profile.column_model].filter(Boolean).map(value=><small key={value}>{value}</small>)}</p>
        <div className="cal-mobile-actions"><button className="ghost-button" disabled={busy} onClick={()=>open(entry.id)}><ExternalLink size={16}/>Open calibration</button><CopyCalibration name={entry.compound||entry.name} getText={async()=>calibrationClipboardRow(await loadLibraryVersion(entry.id))}/><ExcelCalibration name={entry.compound||entry.name} getData={()=>loadLibraryVersion(entry.id)}/><CopyCalibrationLink id={entry.id} name={entry.compound||entry.name}/><OpenInAtmos id={entry.id} version={entry.latest_version||'draft'} theme={theme}/></div>
      </div>}/>:lab&&mobile?<div className="cal-mobile-library" aria-label="Calibration library">
        {!sortedEntries.length&&<p>No matching compounds.</p>}
        {sortedEntries.map(entry=>{
          const name=entry.compound||'Unassigned compound',isOpen=!!mobileExpanded[entry.id]
          return <section className="cal-mobile-compound" key={entry.id}>
            <button className="cal-mobile-disclosure" aria-expanded={isOpen} aria-controls={`mobile-curve-${entry.id}`} onClick={()=>setMobileExpanded(old=>({...old,[entry.id]:!old[entry.id]}))}>
              <span><strong>{name}</strong><small>{entry.series||projects.find(p=>p.id===entry.project_id)?.name||'-'} · {entry.published_count?'Published':'Draft'}</small></span><ChevronIndicator direction={isOpen?'down':'right'}/>
            </button>
            <div id={`mobile-curve-${entry.id}`} hidden={!isOpen}>{isOpen&&<div className="cal-mobile-details">
              {entry.compound&&<CompoundInfo name={entry.compound} lookupName={pubchemLookupName(entry)} theme={theme}/>}
              <CurveThumbnail id={entry.id} load={loadDraft} theme={theme} refreshToken={`${refreshToken}:${entry.updated_at}`} onFit={setCurveFits}/>
              <dl><dt>Author</dt><dd>{entry.author||'Unknown'}</dd><dt>Acquired</dt><dd>{entry.sequence?.start?.replace('T',' ')||'-'}</dd><dt>Instrument</dt><dd><InstrumentMeta profile={entry.profile}/></dd><dt>Method</dt><dd>{entry.profile.method||'-'}</dd><dt>Column</dt><dd>{[entry.profile.column_model,entry.profile.column_phase].filter(Boolean).join(' / ')||'-'}</dd><dt>Calibration</dt><dd>{entry.mode==='internal'?'Internal standard':'External'} · {entry.unit}</dd></dl>
              <div className="cal-mobile-actions"><button className="ghost-button" disabled={busy} onClick={()=>open(entry.id)}><ExternalLink size={16}/>Open calibration</button><CopyCalibration name={name} getText={async()=>calibrationClipboardRow(await loadDraft(entry.id))}/><ExcelCalibration name={name} getData={()=>loadDraft(entry.id)}/><CopyCalibrationLink id={entry.id} name={name}/><OpenInAtmos id={entry.id} theme={theme}/>{deleteButton(entry)}</div>
            </div>}</div>
          </section>
        })}
      </div>:<div className="cal-table-wrap" tabIndex={0} role="region" aria-label="Calibration library">
        {lab?<table className="cal-library-table cal-compound-library"><thead><tr>{libraryColumns.map(([key,label])=><th key={key} aria-sort={librarySort.key===key?librarySort.direction:'none'}><button className="cal-text-link cal-sort-heading" title={`Sort by ${key==='curve'?'R²':label}`} onClick={()=>setLibrarySort(old=>({key,direction:old.key===key&&old.direction==='ascending'?'descending':'ascending'}))}>{label}<ChevronIndicator direction={librarySort.key===key&&librarySort.direction==='descending'?'down':'up'}/></button></th>)}<th aria-label="Copy to Excel"/></tr></thead><tbody>
          {sortedEntries.map(entry=>{const peak=highlightedPeak(curveData[entry.id],highlightedPoints[entry.id]);return <Fragment key={entry.id}><tr className="cal-compound-header">
            <td><button className="cal-text-link" disabled={busy} onClick={()=>open(entry.id)}>{entry.compound||'Unassigned compound'}</button></td>
            <td><strong>{curveLabels[entry.id]||'Loading curve...'}</strong></td>
            <td>{entry.series||projects.find(p=>p.id===entry.project_id)?.name||'-'}</td>
            <td>{entry.sequence?.start?.replace('T',' ')||'-'}</td>
            <td><InstrumentMeta profile={entry.profile}/><small>{entry.profile.method||'-'}</small></td>
            <td>{entry.profile.column_model||'-'}<small>{entry.profile.column_phase}</small></td>
            <td>{entry.mode==='internal'?'Internal standard':'External'}<small>{entry.unit}</small></td>
            <td>{entry.author||'Unknown'}</td>
            <td>{entry.published_count?<Dropdown aria-label={`Version of ${entry.compound}`} menuPortal value={selectedVersions[entry.id]||libraryVersions[entry.id]?.[0]?.version||entry.latest_version} onChange={value=>setSelectedVersions(old=>({...old,[entry.id]:value}))} options={[...(libraryVersions[entry.id]||[]).map((version,index,versions)=>({value:version.version,label:`V${versions.length-index}${index===0?' (latest)':''} · ${new Date(version.published_at).toLocaleDateString()}`})),{value:'draft',label:'Draft'}]}/>:<span className="cal-draft">Draft</span>}</td>
            <td><div className="cal-row-actions">{entry.editable&&<button className="icon-button" title="Edit calibration" aria-label={`Edit calibration ${entry.compound||entry.name}`} disabled={busy} onClick={()=>open(entry.id)}><Pencil size={17}/></button>}<CopyCalibration name={entry.compound||entry.name} getText={async()=>calibrationClipboardRow(await loadLibraryVersion(entry.id))}/>{lab&&<><ExcelCalibration name={entry.compound||entry.name} getData={()=>loadLibraryVersion(entry.id)}/><CopyCalibrationLink id={entry.id} name={entry.compound||entry.name}/><OpenInAtmos id={entry.id} version={selectedVersions[entry.id]||entry.latest_version||'draft'} theme={theme}/></>}{deleteButton(entry)}</div></td>
          </tr><tr className="cal-compound-body"><td>{entry.compound&&<CompoundInfo name={entry.compound} lookupName={pubchemLookupName(entry)} theme={theme} part="structure" peak={peak}/>}</td><td><CurveThumbnail id={entry.id} load={loadLibraryVersion} theme={theme} refreshToken={`${refreshToken}:${entry.updated_at}:${selectedVersions[entry.id]||'latest'}`} onFit={setCurveFits} onLabel={setCurveLabels} onData={setCurveData} highlightedPoint={highlightedPoints[entry.id]??null} onHighlight={index=>setHighlightedPoints(old=>({...old,[entry.id]:index}))} hideCaption/></td><td colSpan={8}><div className="cal-preview-details">{entry.compound&&<CompoundInfo name={entry.compound} lookupName={pubchemLookupName(entry)} theme={theme} part="details"/>}<CurveDataBlocks data={curveData[entry.id]} highlightedPoint={highlightedPoints[entry.id]??null} onHighlight={index=>setHighlightedPoints(old=>({...old,[entry.id]:index}))}/></div></td></tr></Fragment>})}
        </tbody></table>:<table className="cal-library-table"><thead><tr><th>Calibration / compound</th><th>Instrument / method</th><th>Column</th><th>Calibration</th><th>Status</th></tr></thead><tbody>
          {displayEntries.map(entry=>entry.group?<tr key={entry.key}><td colSpan={5}><button className="cal-text-link cal-series-heading" aria-expanded={!!seriesExpanded[entry.key]||!!query} onClick={()=>setSeriesExpanded(old=>({...old,[entry.key]:!old[entry.key]}))}><ChevronIndicator direction={seriesExpanded[entry.key]||query?'down':'right'}/>{entry.label}</button></td></tr>:entry.otherGroup?<tr key={`${entry.key}:other`}><td colSpan={5}><button className="cal-text-link" aria-expanded={!!otherExpanded[entry.key]} onClick={()=>setOtherExpanded(old=>({...old,[entry.key]:!old[entry.key]}))}><ChevronIndicator direction={otherExpanded[entry.key]?'down':'right'}/>Other detections ({entry.count})</button></td></tr>:<Fragment key={entry.id}><tr><td><button className="cal-expand" aria-label={`Show chart data for ${entry.name}`} aria-expanded={!!expanded[entry.id]} onClick={()=>togglePreview(entry.id)}><ChevronIndicator direction={expanded[entry.id]?'down':'right'}/></button><button className="cal-text-link" disabled={busy} onClick={()=>open(entry.id)}>{entry.name}</button><small>{entry.compound || 'Unassigned compound'}{entry.qualification&&!entry.qualification.qualified?` · ${entry.qualification.reason}`:''}</small></td>
            <td><InstrumentMeta profile={entry.profile}/><small>{entry.profile.method || '-'}</small></td><td>{entry.profile.column_model || '-'}<small>{entry.profile.column_phase}</small></td>
            <td>{entry.mode==='internal'?'Internal standard':'External'}<small>{entry.unit}</small>{lab&&<CurveThumbnail id={entry.id} load={loadDraft} theme={theme} refreshToken={`${refreshToken}:${entry.updated_at}`}/>}</td><td><span className={entry.published_count?'cal-published':'cal-draft'}>{entry.published_count?`${entry.published_count} published`:'Draft'}</span></td></tr>
            {expanded[entry.id]&&<tr><td colSpan={5}><div>
              {!previews[entry.id]?<p role="status">Loading chart data...</p>:previews[entry.id].previewError?<p role="alert">{previews[entry.id].previewError}</p>:<>
                <CurveSummary draft={previews[entry.id]} theme={theme}/>
              </>}
            </div></td></tr>}
          </Fragment>)}
        </tbody></table>}{!displayEntries.length&&<p className="cal-empty">{query?'No matching calibrations.':'No calibrations in this view.'}</p>}
      </div>}
    </>:<>
      <div className="cal-title">
        <button className="icon-button" title={dirty?'Save changes before returning to library':'Back to library'} aria-label="Back to library" disabled={busy||dirty||preparing} onClick={()=>{setDraft(null);setError('');setStatus('');if(lab){const url=new URL(window.location.href);url.searchParams.delete('calibration');window.history.replaceState(null,'',url)}}}><ArrowLeft size={18}/></button>
        <div><h1>{draft.name || 'New calibration'}</h1><span>{dirty?'Unsaved changes':view==='draft'?'Draft':`Published ${new Date(shown.published_at).toLocaleDateString()}`}</span></div>
        <Dropdown aria-label="Calibration version" value={view} disabled={busy||dirty||preparing} onChange={value=>{setView(value);setConfirmed(false)}} options={[{value:'draft',label:'Current draft'},...draft.versions.map((v,i)=>({value:v.version,label:`Version ${draft.versions.length-i} - ${new Date(v.published_at).toLocaleString()}`}))]} menuPortal/>
        {view==='draft'?<><button className="primary-button" disabled={!editable||!draft.project_id||!draft.name} onClick={lab&&draft.versions.length?publish:save}><Save size={17}/>{lab&&draft.versions.length?'Save new version':'Save draft'}</button>{lab&&draft.versions.length>0&&<button className="ghost-button" disabled={!editable||!draft.project_id||!draft.name} onClick={save}><Save size={17}/>Save draft</button>}</>
          :<button className="ghost-button" disabled={busy||!draft.editable} onClick={variant}><GitBranch size={17}/>Create variant</button>}
        {dirty&&<button className="ghost-button" disabled={busy||preparing} onClick={()=>draft.id?open(draft.id):(setDraft(null),setDirty(false))}>Discard changes</button>}
        {lab&&draft.id&&<><ExcelCalibration name={draft.compound||draft.name} getData={()=>loadDraft(draft.id)}/><CopyCalibrationLink id={draft.id} name={draft.compound||draft.name}/></>}
      </div>
      {lab&&draft.id&&draft.discovery&&view==='draft'&&<CompoundBoard draftId={draft.id} disabled={!editable} navigationDisabled={dirty} onOpen={open} onChanged={async()=>{setPreviews({});const preview=await apiSend('/lab/preview','POST',draft);setDraft(old=>old?.id===draft.id?{...old,preview,fit:null}:old);setConfirmed(false);setSeriesConfirmed(false);await refresh()}}/>}
      <div className="cal-builder">
        <div className="cal-editor">
          <section><div className="cal-section-heading"><h2>Calibration</h2><button className="ghost-button" disabled={!editable} onClick={()=>setLoadingIS(value=>!value)}><FolderOpen size={16}/>Load IS</button></div>
            {loadingIS&&<LoadStandards projects={projects} projectId={draft.project_id} lockedProject={!!draft.id} onLoad={loadIS} onClose={()=>setLoadingIS(false)}/>}
            <div className="cal-fields">
            <label>Name<input type="text" value={shown.name} disabled={!editable} onChange={e=>update({name:e.target.value})}/></label>
            <label>Compound{lab?<CompoundNameInput value={shown.compound} disabled={!editable} onChange={compound=>update({compound,fit:null})}/>:<input type="text" value={shown.compound} disabled={!editable} onChange={e=>update({compound:e.target.value})}/>}</label>
            <label>Source project<Dropdown aria-label="Source project" value={shown.project_id} disabled={!editable||Boolean(draft.id)} options={[{value:'',label:'Choose project'},...projects.filter(p=>p.can_edit!==false).map(p=>({value:p.id,label:p.name}))]} onChange={project_id=>update({project_id,rows:[],profile:{response:'TIC'}})} menuPortal/></label>
            <label>Concentration unit<Dropdown aria-label="Concentration unit" value={shown.unit} disabled={!editable} options={options(['ug/mL','mg/mL','ng/mL'])} onChange={unit=>update({unit})} menuPortal/></label>
          </div><SlidingPill label="Calibration type" value={shown.mode} onChange={mode=>update({mode})} options={[{value:'external',label:'External',disabled:!editable},{value:'internal',label:'Internal standard',disabled:!editable}]}/>
          </section>
          {view==='draft'&&draft.project_id&&draft.editable&&!sourceLoading&&<PrepareStandards onActiveRun={setActiveRun} assignedCompound={draft.compound}
            onRefreshFiles={async()=>{const data=await apiGet(`${ROOT}/sources/${encodeURIComponent(draft.project_id)}`);setFiles(data.files)}}
            onAddFile={lab?async chosen=>{
              let updated=draft
              for(const file of chosen){
                const {preparation}=await apiGet(`/lab/preparation/${encodeURIComponent(file.id)}`)
                updated=addSeriesFile(updated,file,preparation)
              }
              const next=await apiSend(`${ROOT}/${draft.id}`,'PUT',updated)
              next.preview=await apiSend('/lab/preview','POST',next)
              accept(next);setPreviews({})
            }:undefined}
            onSelectionChanged={lab?ids=>update({discovery:{...draft.discovery,selected_file_ids:ids}}):undefined}
            onPrepared={lab?async(runs,selection)=>{
              const next=await targetDraft(draft,runs,selection,apiSend)
              next.preview=await apiSend('/lab/preview','POST',next)
              update(next)
              setStatus(next.preview.fit?'Provisional curve ready. Review concentrations, identity and areas before publishing.':next.preview.issue||'Review the target matches to build the curve.')
            }:undefined}
            labDraftId={lab?draft.id:null} onAreaChanged={async()=>{if(!lab)return;const preview=await apiSend('/lab/preview','POST',draft);setDraft(old=>({...old,preview,fit:null}));setConfirmed(false);setSeriesConfirmed(false);setPreviews({})}}
            key={`${draft.id||'new'}:${draft.project_id}`} files={files} theme={theme} disabled={busy}
            projectId={draft.project_id} discovery={draft.discovery}
            request={prepRequest} onRequestStarted={()=>setPrepRequest(null)}
            onConverted={async(ids)=>{
              const data=await apiGet(`${ROOT}/sources/${encodeURIComponent(draft.project_id)}`)
              setFiles(data.files)
              setDraft(old=>{
                const profile={...old.profile},chosen=data.files.filter(file=>ids.includes(file.id))
                for(const key of [...FIELDS.map(([key])=>key),'method_signature']){const values=[...new Set(chosen.map(file=>String(file.profile?.[key]||'')).filter(Boolean))];if(!profile[key]&&values.length===1)profile[key]=values[0]}
                return {...old,profile}
              })
            }}
            onBusy={setPreparing} onSaved={async(peak,datasetId)=>{
              const data=await apiGet(`${ROOT}/sources/${encodeURIComponent(draft.project_id)}`)
              setFiles(data.files);setConfirmed(false);setDirty(true)
              setDraft(old=>{
                const is=peak.calibration_preparation.role==='internal_standard'
                const compound=old.compound||(!is?peak.compound:'')
                return {...old,compound,rows:old.rows.map(row=>row.dataset_id===datasetId&&
                  (is||compound.toLowerCase()===peak.compound.toLowerCase())?
                  {...row,[is?'is_peak_id':'peak_id']:peak.annotationId}:row)}
              })
            }} />}
          <section><div className="cal-section-heading"><h2>Acquisition</h2><button className="ghost-button" disabled={!editable||!files.length} onClick={importMethod}><Download size={16}/>Read run metadata</button></div>
            {lab&&<label>Inventory column<Dropdown aria-label="Inventory column" value={shown.column_id||''} disabled={!editable} onChange={selectColumn} menuPortal options={[{value:'',label:'Run metadata / custom column'},...columns.filter(c=>c.active||c.id===shown.column_id).map(c=>({value:c.id,label:c.name}))]}/></label>}
            <div className="cal-fields">{FIELDS.map(([key,label])=><label key={key}>{label}<input type="text" value={shown.profile[key]||''} disabled={!editable} onChange={e=>update({profile:{...draft.profile,[key]:e.target.value}})}/></label>)}</div>
            <p className="cal-subtle">Response: TIC</p>
          </section>
          <section><div className="cal-section-heading"><h2>Standard injections</h2><button className="ghost-button" disabled={!editable||!files.length} onClick={()=>update({rows:[...draft.rows,{dataset_id:'',peak_id:'',concentration:'',is_peak_id:'',is_concentration:'',excluded:false,reason:''}]})}><Plus size={16}/>Add injection</button></div>
            {sourceLoading&&<p role="status">Loading saved integrations...</p>}
            {!sourceLoading&&draft.project_id&&!files.length&&<p className="cal-subtle">No GC-MS runs in this source project.</p>}
            <div className="cal-table-wrap" tabIndex={0} role="region" aria-label="Standard injections"><table><thead><tr><th>Include</th><th>Run / peak</th><th>Concentration</th>{shown.mode==='internal'&&<th>Internal standard</th>}<th>Exclusion reason</th><th/></tr></thead><tbody>
              {shown.rows.map((row,index)=>({row,index})).sort((a,b)=>concentrationOrder(files.find(f=>f.id===a.row.dataset_id),files.find(f=>f.id===b.row.dataset_id))).map(({row,index})=>{
                const file=files.find(f=>f.id===row.dataset_id)
                const peaks=(file?.peaks||[]).filter(p=>p.area>0)
                const peakOptions=[{value:'',label:'Choose peak'},...peaks.map(p=>({value:p.peak_id,label:`${p.name || 'Unassigned'} | ${format(p.area)}${p.review_needed?' | Review required':''}`}))]
                return <tr key={index}>
                  <td><input type="checkbox" aria-label={`Include injection ${index+1}`} checked={!row.excluded} disabled={!editable} onChange={e=>rowUpdate(index,{excluded:!e.target.checked})}/></td>
                  <td><Dropdown aria-label={`Run ${index+1}`} value={row.dataset_id||''} disabled={!editable} options={[{value:'',label:'Choose run'},...files.map(f=>({value:f.id,label:f.filename}))]} onChange={dataset_id=>rowUpdate(index,{dataset_id,peak_id:'',is_peak_id:''})} menuPortal/>
                    {peaks.length?<Dropdown aria-label={`Peak ${index+1}`} value={row.peak_id||''} disabled={!editable} options={peakOptions} onChange={peak_id=>rowUpdate(index,{peak_id})} menuPortal/>:<small>{shown.preview?.points?.some(point=>point.dataset_id===row.dataset_id)?`${shown.compound} | ${shown.preview.points.find(point=>point.dataset_id===row.dataset_id).rt.toFixed(3)} min | Awaiting series review`:'No matched peak. Review or exclude this injection.'}</small>}</td>
                  <td><input type="number" min="0" step="any" aria-label={`Concentration ${index+1}`} value={row.concentration??''} disabled={!editable} onChange={e=>rowUpdate(index,{concentration:e.target.value,...(row.quantity_confirmed!=null?{quantity_confirmed:false}:{})})}/><small>{shown.unit}</small>
                    {row.quantity_confirmed!=null&&<label className="cal-check"><input type="checkbox" aria-label={`Confirm filename concentration ${index+1}`} checked={row.quantity_confirmed} disabled={!editable} onChange={e=>rowUpdate(index,{quantity_confirmed:e.target.checked})}/>Filename level confirmed</label>}</td>
                  {shown.mode==='internal'&&<td>{peaks.some(p=>p.peak_id!==row.peak_id)?<Dropdown aria-label={`Internal standard peak ${index+1}`} value={row.is_peak_id||''} disabled={!editable} options={peakOptions.filter(p=>!p.value||p.value!==row.peak_id)} onChange={is_peak_id=>rowUpdate(index,{is_peak_id})} menuPortal/>:<small>No reviewed reference peak</small>}
                    <input type="number" min="0" step="any" aria-label={`Internal standard concentration ${index+1}`} value={row.is_concentration??''} disabled={!editable} onChange={e=>rowUpdate(index,{is_concentration:e.target.value})}/><small>{shown.unit}</small></td>}
                  <td><input type="text" aria-label={`Exclusion reason ${index+1}`} value={row.reason||''} disabled={!editable} onChange={e=>rowUpdate(index,{reason:e.target.value})}/></td>
                  <td><button className="icon-button" title="Remove injection" aria-label={`Remove injection ${index+1}`} disabled={!editable} onClick={()=>update({rows:draft.rows.filter((_,i)=>i!==index)})}><Trash2 size={16}/></button></td>
                </tr>
              })}
            </tbody></table></div>
          </section>
        </div>
        <aside className="cal-review" aria-label="Curve review"><h2>Curve review</h2>
          {shown.discovery&&<p className="cal-subtle">Imported draft: {shown.discovery.series}. Identity, filename levels and integrations await review.{shown.discovery.issue?` ${shown.discovery.issue}`:''}</p>}
          {shown.discovery?.sequence&&<p className="cal-subtle">Acquisition: {shown.discovery.sequence.start?.replace('T',' ')||'Unknown'} to {shown.discovery.sequence.end?.replace('T',' ')||'Unknown'}. {shown.discovery.sequence.warnings?.join('; ')}</p>}
          {shown.discovery?.rt_warning&&<p className="cal-alert">{shown.discovery.rt_warning}</p>}
          {shown.discovery?.assignment_warning&&<p className="cal-alert">{shown.discovery.assignment_warning}</p>}
          {dirty&&<p className="cal-subtle">Unpublished draft changes.</p>}
          {lab&&shown.preview?<CurveSummary draft={shown} theme={theme} onInclude={view==='draft'?includeConcentration:null} disabled={!editable}/>:fit?<><CurvePlot fit={fit} mode={shown.mode} unit={shown.unit} theme={theme}/>
            <dl className="cal-fit-stats"><dt>Slope</dt><dd>{format(fit.slope)}</dd><dt>Intercept</dt><dd>{format(fit.intercept)}</dd><dt>R2 (centered)</dt><dd>{format(fit.r2)}</dd><dt>Injections</dt><dd>{fit.n}</dd><dt>Range{shown.mode==='internal'?' (ratio)':''}</dt><dd>{format(fit.min)} - {format(fit.max)}</dd></dl>
            <div className="cal-table-wrap" tabIndex={0} role="region" aria-label="Fit diagnostics"><table><thead><tr><th>Run</th><th>Back-calculated{shown.mode==='internal'?' ratio':''}</th><th>Bias %</th><th>Residual</th></tr></thead><tbody>{fit.points.map(p=><tr key={p.dataset_id}><td>{p.filename}</td><td>{format(p.back_calculated)}</td><td>{format(p.bias_percent)}</td><td>{format(p.residual)}</td></tr>)}</tbody></table></div>
            </>:shown.preview?<CurveSummary draft={shown} theme={theme} onInclude={view==='draft'?includeConcentration:null} disabled={!editable}/>:<p className="cal-subtle">{shown.fit_error || 'No saved fit.'}</p>}
          {view==='draft'&&<div className="cal-publication">
            <label className="cal-check"><input type="checkbox" checked={(shown.fit||shown.preview?.fit)?.force_zero??shown.force_zero} disabled={!editable} onChange={e=>changeZero(e.target.checked)}/>Constrain through 0</label>
            {!lab&&<label className="cal-check"><input type="checkbox" checked={confirmed} disabled={!editable||dirty||!fit} onChange={e=>setConfirmed(e.target.checked)}/>Acquisition, concentrations and integrations reviewed</label>}
            <button className="primary-button" disabled={!editable||!draft.id||(!lab&&(dirty||!fit||!confirmed))} onClick={publish}><Check size={17}/>Publish version</button>
          </div>}
          {view!=='draft'&&<p className="cal-version-id">Version {view}</p>}
          {draft.parent&&<p className="cal-version-id">Variant of {draft.parent.version}</p>}
          {(!lab||activeRun||shown.id)&&<a className="cal-workspace-link" href={lab?`/inspection/?${new URLSearchParams(activeRun?{run:activeRun.id,...(activeRun.rt!==null?{rt:String(activeRun.rt)}:{}),theme}:{id:shown.id,version:view,theme})}`:import.meta.env.BASE_URL} target="_blank" rel="noopener noreferrer"><ExternalLink size={15}/>Atmos workspace</a>}
        </aside>
      </div>
    </>}
  </main>
}
