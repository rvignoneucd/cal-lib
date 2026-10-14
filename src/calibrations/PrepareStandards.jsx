import ActionNotice from './ActionNotice'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, Play, Plus, Square, ZoomOut, Maximize, Minimize, ScanLine, RotateCcw, Search } from 'lucide-react'
import { inspectionSeries } from './compoundSeries.js'
import { concentrationOrder, standardHint } from './standardHints.js'
import { Dropdown } from '../components/AppPrimitives'
import SlidingPill from '../components/SlidingPill'
import SeriesChromatograms from './SeriesChromatograms'
import WarningFlag from './WarningFlag'
import AddSeriesFiles from './AddSeriesFiles'
import Plot from '../components/LazyPlotlyPlot'
import { XRangeControl } from '../features/workspace/WorkspaceControls'
import { apiGet, apiSend } from '../api/client'
import {savedArea} from './savedArea.js'
import {targetRun} from './targetRun.js'
import { compareRuns, prepareRuns, reviewedAnnotation, DETECTION } from './preparation'

const choices=values=>values.map(value=>({value,label:value}))
const fmt=value=>Number.isFinite(value)?value.toPrecision(5):'-'
const datasetPath=id=>`/datasets/${encodeURIComponent(id)}`

export default function PrepareStandards({files,theme,disabled,onBusy,onSaved,request,onRequestStarted,onConverted,projectId,discovery,labDraftId,onAreaChanged,onAddFile,onPrepared,onSelectionChanged,onActiveRun,assignedCompound,onRefreshFiles}) {
  const [corrections,setCorrections]=useState({})
  const [reviewView,setReviewView]=useState('review')
  const areaKey=row=>`${row.dataset_id}:${Number(row.rt_apex).toFixed(6)}`
  useEffect(()=>{if(!labDraftId)return;let cancelled=false
    apiGet(`/lab/areas/${labDraftId}`).then(data=>{if(!cancelled){
      const entries=data.areas.map(record=>[`${record.dataset_id}:${Number(record.candidate_rt).toFixed(6)}`,record.measurement])
      for(const [id,rt] of Object.entries(discovery?.selected_peaks||{})){
        const record=savedArea(data.areas,id,rt)
        if(record)entries.push([`${id}:${Number(rt).toFixed(6)}`,record.measurement])
      }
      setCorrections(Object.fromEntries(entries))
    }})
      .catch(error=>{if(!cancelled)setError(error.message)})
    return()=>{cancelled=true}
  },[labDraftId])
  const [selected,setSelected]=useState([]),[reference,setReference]=useState(''),[runs,setRuns]=useState([])
  const [addedFiles,setAddedFiles]=useState([]),[addingFiles,setAddingFiles]=useState(false)
  const [busy,setBusy]=useState(false),[status,setStatus]=useState(''),[error,setError]=useState('')
  const [candidate,setCandidate]=useState(null),[points,setPoints]=useState([]),[hits,setHits]=useState([]),[hitIndex,setHitIndex]=useState('')
  const [confirmed,setConfirmed]=useState(false),[measured,setMeasured]=useState(null),[saved,setSaved]=useState({})
  const [areaConfirmed,setAreaConfirmed]=useState(false),[areaDrawn,setAreaDrawn]=useState(false)
  const [left,setLeft]=useState(''),[right,setRight]=useState(''),[quantity,setQuantity]=useState(''),[unit,setUnit]=useState('ug/mL')
  const [basis,setBasis]=useState('added'),[role,setRole]=useState('analyte'),[tool,setTool]=useState('select')
  const [multiplier,setMultiplier]=useState(labDraftId?'10':'60'),[tolerance,setTolerance]=useState('0.1'),[increase,setIncrease]=useState('20')
  const controller=useRef(null),alive=useRef(true)
  const plotRef=useRef(null),gesture=useRef(null)
  const [reviewRange,setReviewRange]=useState(null),[rangeRevision,setRangeRevision]=useState(0),[expandedReview,setExpandedReview]=useState(false)
  const [drag,setDrag]=useState(null)
  const started=useRef(null)
  const [target,setTarget]=useState(null),[targetRt,setTargetRt]=useState('')
  const [targetSearch,setTargetSearch]=useState(null)
  const [previousArea,setPreviousArea]=useState(null)
  const [targetMatch,setTargetMatch]=useState(null)
  const targetSearchKey=useRef('')
  targetSearchKey.current=`${target?.file.id}:${targetRt}`
  const currentTargetSearch=targetSearch?.key===targetSearchKey.current?targetSearch:null
  const selectedTargetHit=targetMatch?.key===targetSearchKey.current?targetMatch.hit:null
  async function searchTarget(){
    const rt=Number(targetRt),key=targetSearchKey.current
    if(!target||targetRt===''||!Number.isFinite(rt)||rt<0)return
    await action(async()=>{
      setTargetSearch(null)
      setTargetMatch(null)
      const response=await apiSend(`${datasetPath(target.file.id)}/library/search-batch`,'POST',{rts:[rt],full_search:true})
      if(!alive.current||targetSearchKey.current!==key)return
      const result=response.results?.[0]
      if(result?.error)throw new Error(result.error)
      setTargetSearch({key,rt,hits:result?.hits||[]})
    })
  }
  const targetFirst=!!discovery?.files?.length&&!labDraftId
  useEffect(()=>{
    const id=candidate?.dataset_id||target?.file.id
    const rt=candidate?.rt_apex??(targetRt===''?null:Number(targetRt))
    onActiveRun?.(id?{id,rt:Number.isFinite(rt)?rt:null}:null)
  },[candidate?.dataset_id,candidate?.rt_apex,target?.file.id,targetRt,onActiveRun])
  useEffect(()=>()=>onActiveRun?.(null),[onActiveRun])
  async function suggestTarget(){
    await action(async()=>{
      const file=targetRun(files,selected)
      if(!file)throw new Error('Select a run with available MS data')
      const data=await apiGet(`${datasetPath(file.id)}/chromatogram?trace=TIC`)
      const detection=await apiSend(`${datasetPath(file.id)}/auto-peaks`,'POST',{...DETECTION,area_multiplier:10})
      const peak=[...(detection.peaks||[])].sort((a,b)=>(b.height??b.net_area??0)-(a.height??a.net_area??0))[0]
      if(!peak)throw new Error('No peak found; select another run')
      setTarget({file,points:data.points||[]});setTargetRt(String(peak.rt_apex));setRuns([])
    })
  }
  useEffect(()=>{
    if(discovery?.preparations?.length||!discovery?.files?.length)return
    const usable=discovery.files.filter(file=>!file.source_error)
    setSelected(discovery.selected_file_ids??usable.map(file=>file.id))
    setReference([...usable].sort(concentrationOrder)[0]?.id||'')
  },[projectId,discovery?.files?.map(file=>file.id).join('|')])
  useEffect(()=>{
    if(!discovery?.preparations?.length)return
    let cancelled=false
    setBusy(true);onBusy(true)
    Promise.all(discovery.preparations.map(id=>apiGet(`/calibration-library/preparations/${encodeURIComponent(projectId)}/${encodeURIComponent(id)}`)))
      .then(records=>{if(!cancelled){setRuns(records);setSelected(discovery.selected_file_ids??[...new Set([...records.map(r=>r.id),...(discovery.files||[]).map(file=>file.id)])]);setReference(discovery.reference_dataset_id||'');
        setStatus(`${records.reduce((sum,r)=>sum+r.peaks.length,0)} proposed areas restored for review`)}})
      .catch(error=>{if(!cancelled)setError(error.message)})
      .finally(()=>{if(!cancelled){setBusy(false);onBusy(false)}})
    return()=>{cancelled=true}
  },[projectId,discovery?.preparations?.join('|')])
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;controller.current?.abort();onBusy(false)}},[])
  useEffect(()=>{
    if(!request||request.id===started.current||!request.ids.every(id=>files.some(f=>f.id===id)))return
    started.current=request.id;setSelected(request.ids);setReference(request.reference);onRequestStarted()
    prepare(request.ids)
  },[request,files])
  const locked=busy||disabled
  const seriesIds=new Set([...(discovery?.files||[]).map(file=>file.id),...(request?.ids||[]),...runs.map(run=>run.id),...selected,...addedFiles])
  const seriesFiles=files.filter(file=>!file.source_error&&seriesIds.has(file.id)).sort(concentrationOrder)
  const availableFiles=files.filter(file=>!file.source_error&&!seriesIds.has(file.id))
  const rows=useMemo(()=>inspectionSeries(compareRuns(runs,reference,{window:Number(tolerance),minIncrease:Number(increase)}),discovery,seriesFiles.filter(file=>selected.includes(file.id)),Number(tolerance)),[runs,reference,tolerance,increase,discovery,files,selected,addedFiles])
  const reviewIndex=rows.findIndex(row=>row.key===candidate?.key)
  const dark=theme==='dark'
  async function action(fn,keepStatus=false) {
    setBusy(true);onBusy(true);setError('');if(!keepStatus)setStatus('')
    try {await fn()} catch(e) {if(alive.current){if(e.name==='AbortError')setStatus('Preparation stopped');else setError(e.message)}}
    finally {if(alive.current){setBusy(false);onBusy(false)}}
  }
  async function prepare(ids=selected) {
    await action(async()=>{
      if(targetFirst&&(!target||targetRt===''||!Number.isFinite(Number(targetRt))||!(Number(tolerance)>0)))throw new Error('Select a target RT and a positive tolerance first')
      const chosen=files.filter(f=>ids.includes(f.id)&&!f.source_error)
      const usableIds=chosen.map(file=>file.id)
      for(const field of ['instrument','method','column_model','column_phase','column_length_m','column_id_um','column_film_um','acquisition_mode']) {
        const values=new Set(chosen.map(f=>String(f.profile?.[field]||'').trim().toLowerCase()).filter(Boolean))
        if(values.size>1)throw new Error(`Selected runs have different ${field.replaceAll('_',' ')} values`)
      }
      controller.current=new AbortController()
      setCandidate(null);setRuns([])
      const result=await prepareRuns(usableIds,{get:apiGet,send:apiSend,signal:controller.current.signal,onConverted,areaMultiplier:targetFirst?10:1,...(targetFirst?{targetRt:Number(targetRt),targetTolerance:Number(tolerance)}:{}),progress:s=>{if(alive.current)setStatus(s)}})
      if(!alive.current)return
      setRuns(result)
      if(targetFirst)await onPrepared?.(result,{targetRt:Number(targetRt),reference,seedId:target.file.id,files:chosen,selectedHit:selectedTargetHit})
      const failures=result.flatMap(r=>r.peaks).filter(p=>p.searchError).length
      setStatus(failures?`Detection complete; ${failures} peaks need a NIST retry`:'Detection complete; matches and areas await review')
    })
  }
  async function open(row,showPrevious=false) {
    const retainedRange=candidate?(plotRef.current?._fullLayout?.xaxis?.range||reviewRange):null
    await action(async()=>{
      const data=await apiGet(`${datasetPath(row.dataset_id)}/chromatogram?trace=TIC&max_points=100000`)
      if(!alive.current)return
      setPreviousArea(showPrevious&&areaDrawn&&measured?structuredClone(measured):null)
      setMeasured(null);setConfirmed(false);setAreaConfirmed(false);setAreaDrawn(false);setHitIndex('');setQuantity('')
      const rt=Number.isFinite(row.rt_apex)?row.rt_apex:(data.points?.[0]?.x??0)
      setPoints(data.points||[]);setHits(row.hits);setCandidate({...row,rt_apex:rt});setTool('select')
      setReviewRange(retainedRange?[...retainedRange]:null);setRangeRevision(value=>value+1)
      const run=runs.find(r=>r.id===row.dataset_id)
      setMultiplier(String(run?.area_multiplier||(labDraftId?10:1)))
      const correction=corrections[areaKey(row)]
      if(correction){setMeasured(correction);setLeft(String(correction.left));setRight(String(correction.right));setAreaDrawn(true);setAreaConfirmed(true)}
      else if(!row.integration_error&&row.rt_left<row.rt_apex&&row.rt_right>row.rt_apex&&row.net_area>0) {
        setMeasured({...row,left:row.rt_left,right:row.rt_right,apex_x:row.rt_apex})
        setLeft(String(row.rt_left));setRight(String(row.rt_right))
      } else {setLeft('');setRight('')}
      if(labDraftId&&!assignedCompound?.trim()){
        const identity=await apiGet(`${datasetPath(row.dataset_id)}/peak-identity?rt=${correction?.apex_x??rt}`)
        if(alive.current)setHits(identity.hits||[])
      }
    },true)
  }
  function bounds(a,b) {setLeft(String(a));setRight(String(b));setMeasured(null);setConfirmed(false);setAreaConfirmed(false);setAreaDrawn(false)}
  function plotPosition(event) {
    const plot=plotRef.current,axis=plot?._fullLayout?.xaxis,rect=plot?.getBoundingClientRect()
    const yAxis=plot?._fullLayout?.yaxis
    if(!axis||!yAxis||!rect)return null
    const px=event.clientX-rect.left,py=event.clientY-rect.top
    if(px<axis._offset||px>axis._offset+axis._length||py<yAxis._offset||py>yAxis._offset+yAxis._length)return null
    return axis.p2d(px-axis._offset)
  }
  function begin(event) {
    if(locked||tool!=='select'||event.button!==2)return
    const rt=plotPosition(event);if(!Number.isFinite(rt))return
    event.preventDefault();event.stopPropagation();event.currentTarget.setPointerCapture(event.pointerId)
    gesture.current={start:rt,end:rt,px:event.clientX,id:event.pointerId};setDrag(gesture.current)
  }
  function move(event) {
    if(!gesture.current||gesture.current.id!==event.pointerId)return
    event.stopPropagation()
    const rt=plotPosition(event)
    if(Number.isFinite(rt)){gesture.current={...gesture.current,end:rt};setDrag(gesture.current)}
  }
  function cancel() {gesture.current=null;setDrag(null)}
  function finish(event) {
    const current=gesture.current;if(!current||current.id!==event.pointerId)return
    event.preventDefault();event.stopPropagation();cancel()
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId)
    if(Math.abs(event.clientX-current.px)>=6)measure(Math.min(current.start,current.end),Math.max(current.start,current.end))
  }
  async function measure(a=left,b=right) {
    if(locked||!candidate)return
    await action(async()=>{
      if(a===''||b===''||![Number(a),Number(b)].every(Number.isFinite)||Number(b)<=Number(a))throw new Error('Choose an area with increasing retention-time bounds')
      if(!(Number(multiplier)>0)||!Number.isFinite(Number(multiplier)))throw new Error('Area multiplier must be positive')
      const payload={trace:'TIC',left:Number(a),right:Number(b),baseline_mode:'endpoints',area_multiplier:Number(multiplier),candidate_rt:candidate.rt_apex}
      const response=await apiSend(labDraftId?`/lab/areas/${labDraftId}/${candidate.dataset_id}`:`${datasetPath(candidate.dataset_id)}/integrate`,labDraftId?'PUT':'POST',payload)
      const result=labDraftId?response.measurement:response
      if(!alive.current)return
      setCorrections(old=>({...old,[areaKey(candidate)]:result}))
      setMeasured(result);setLeft(String(result.left));setRight(String(result.right));setAreaDrawn(true);setAreaConfirmed(true);setConfirmed(false)
      await onAreaChanged?.()
      if(assignedCompound?.trim()){
        setConfirmed(true)
        setStatus(`Area saved for ${assignedCompound}`)
        return
      }
      // Search the manually drawn apex, not a stale detector apex.
      const matches=labDraftId?null:await apiSend(`${datasetPath(candidate.dataset_id)}/library/search-batch`,'POST',{
        rts:[result.apex_x],full_search:true,top_n:5,min_score:0,enrich_pubchem:false})
      const match=labDraftId?await apiGet(`${datasetPath(candidate.dataset_id)}/peak-identity?rt=${result.apex_x}`):matches.results?.[0]
      if(match?.error)throw new Error(match.error)
      if(!alive.current)return
      setHits(match?.hits||[]);setHitIndex('');setMeasured(result);setLeft(String(result.left));setRight(String(result.right))
      setAreaDrawn(true);setAreaConfirmed(true)
      setStatus('Area measured; confirm the identity at its apex')
    })
  }
  async function save() {
    if(!confirmed||!areaConfirmed)return
    await action(async()=>{
      const peak=reviewedAnnotation({candidate,hit:hitIndex===''?null:hits[Number(hitIndex)],manualCompound:assignedCompound,measurement:measured,
        quantity,unit,basis,role,referenceId:reference,areaMultiplier:Number(multiplier),areaDrawn,areaConfirmed})
      const url=`${datasetPath(candidate.dataset_id)}/annotations`
      const existing=await apiGet(url)
      const original=existing.stored_peaks||existing.peaks||[]
      const prior=original.find(p=>p.calibration_preparation?.candidate_rt===candidate.rt_apex)
      if(prior)throw new Error('This candidate already has a reviewed area. Edit its saved integration instead of overwriting it.')
      await apiSend(url,'PUT',{expected_peaks:original,peaks:[...original,peak]})
      if(!alive.current)return
      setSaved(old=>({...old,[candidate.key]:true}));setConfirmed(false)
      setStatus('Confirmed match and reviewed area saved')
      await onSaved(peak,candidate.dataset_id)
    })
  }
  const selectedHit=hitIndex===''?null:hits[Number(hitIndex)]
  const peakLeft=candidate?Math.min(candidate.rt_apex-.3,(measured?.left??candidate.rt_apex)-.05):0
  const peakRight=candidate?Math.max(candidate.rt_apex+.3,(measured?.right??candidate.rt_apex)+.05):1
  const [viewLeft,viewRight]=reviewRange||[peakLeft,peakRight]
  function changeRange(mode){
    if(!points.length)return
    const start=points[0].x,end=points[points.length-1].x
    const current=plotRef.current?._fullLayout?.xaxis?.range||[viewLeft,viewRight]
    const center=(current[0]+current[1])/2,span=current[1]-current[0]
    setReviewRange(mode==='full'?[start,end]:mode==='peak'?null:[Math.max(start,center-span),Math.min(end,center+span)])
    setRangeRevision(value=>value+1)
  }
  const localSignal=candidate?points.filter(p=>p.x>=viewLeft&&p.x<=viewRight).map(p=>p.y).filter(Number.isFinite):[]
  const localMin=localSignal.length?Math.min(...localSignal):0,localMax=localSignal.length?Math.max(...localSignal):1
  const padding=Math.max((localMax-localMin)*.12,Math.abs(localMax)*.02,1)
  const chartData=[{type:'scatter',mode:'lines',name:'TIC',x:points.map(p=>p.x),y:points.map(p=>p.y),line:{color:dark?'#b4e6da':'#146953',width:1.5}}]
  if(previousArea?.segment?.length){
    chartData.unshift({type:'scatter',mode:'lines',name:'Previous drawn area',hoverinfo:'skip',
      x:[...previousArea.segment.map(p=>p.x),previousArea.right,previousArea.left],
      y:[...previousArea.segment.map(p=>p.y),previousArea.y_right,previousArea.y_left],
      fill:'toself',fillcolor:dark?'rgba(126,172,255,0.12)':'rgba(68,114,196,0.10)',
      line:{color:dark?'rgba(126,172,255,0.55)':'rgba(68,114,196,0.45)',dash:'dot',width:1}})
  }
  if(measured) {
    const segment=measured.segment||[]
    chartData.push({type:'scatter',mode:'lines',name:'Reviewed area',x:[...segment.map(p=>p.x),measured.right,measured.left],
      y:[...segment.map(p=>p.y),measured.y_right,measured.y_left],fill:'toself',fillcolor:'rgba(230,174,56,0.3)',line:{color:dark?'#f1c969':'#9b6500',width:1}})
  }
  return <section className="cal-preparation">
    <div className="cal-section-heading"><h2>Prepare standards</h2><div className="cal-toolbar">
      {!labDraftId&&<button className="ghost-button" disabled={locked||!selected.length} onClick={()=>targetFirst?suggestTarget():prepare()}><Play size={16}/>{targetFirst?'Select target peak':'Prepare selected runs'}</button>}
      {busy&&controller.current&&!candidate&&<button className="icon-button" title="Stop preparation" aria-label="Stop preparation" onClick={()=>controller.current.abort()}><Square size={16}/></button>}
    </div></div>
    {targetFirst&&target&&<div>
      <h3>{target.file.filename}</h3>
      <Plot data={[{x:target.points.map(p=>p.x),y:target.points.map(p=>p.y),type:'scatter',mode:'lines'}]} layout={{height:260,autosize:true,font:{color:dark?'#eceeed':'#242a29'},paper_bgcolor:'transparent',plot_bgcolor:'transparent',margin:{l:65,r:20,t:15,b:45},shapes:[{type:'line',x0:Number(targetRt),x1:Number(targetRt),y0:0,y1:1,yref:'paper',line:{color:'#00879b'}}]}} onClick={e=>{if(e.points?.[0])setTargetRt(String(e.points[0].x))}} style={{width:'100%'}} useResizeHandler useDisplayPreferences={false}/>
      <label>Target RT (min)<input type="number" step="0.001" value={targetRt} disabled={locked} onChange={e=>setTargetRt(e.target.value)}/></label>
      <button className="ghost-button" disabled={locked||targetRt===''||!Number.isFinite(Number(targetRt))||Number(targetRt)<0} onClick={searchTarget}><Search size={16}/>Search full NIST at current RT</button>
      {currentTargetSearch&&<div className="cal-table-wrap" aria-label="Target NIST results"><h3>Full NIST - {currentTargetSearch.rt.toFixed(3)} min</h3>{currentTargetSearch.hits.length?<table><thead><tr><th>Compound</th><th>Match</th><th>Reverse match</th><th>CAS</th><th>Select</th></tr></thead><tbody>{currentTargetSearch.hits.map((hit,i)=><tr key={i}><td>{hit.common_name||hit.name}</td><td>{hit.match_score??'-'}</td><td>{hit.reverse_score??'-'}</td><td>{hit.cas||'-'}</td><td><input type="radio" name="target-nist-match" aria-label={`Use ${hit.common_name||hit.name} as analyte`} disabled={locked} checked={selectedTargetHit===hit} onChange={()=>setTargetMatch({key:targetSearchKey.current,hit})}/></td></tr>)}</tbody></table>:<p>No NIST matches at this RT.</p>}</div>}
      <button className="ghost-button" disabled={locked} onClick={()=>prepare()}><Check size={16}/>Confirm target and match selected runs</button>
    </div>}
    <div className="cal-fields">
      <label>Reference / lowest level<Dropdown aria-label="Reference / lowest level" disabled={locked} value={reference} onChange={value=>{setReference(value);setCandidate(null)}} menuPortal options={[{value:'',label:'No comparison reference'},...files.filter(f=>selected.includes(f.id)).map(f=>({value:f.id,label:f.filename}))]}/></label>
      <label>RT tolerance (min)<input type="number" min="0" step="0.01" value={tolerance} disabled={locked} onChange={e=>setTolerance(e.target.value)}/></label>
      <label>Signal increase threshold (%)<input type="number" min="0" step="1" value={increase} disabled={locked} onChange={e=>setIncrease(e.target.value)}/></label>
    </div>
    <div className="cal-section-heading"><h3>Series files ({seriesFiles.length})</h3>
      <button className="ghost-button" disabled={locked} aria-expanded={addingFiles} onClick={()=>{if(addingFiles){setAddingFiles(false);return}action(async()=>{await onRefreshFiles?.();setAddingFiles(true)})}}><Plus size={16}/>Add files</button>
    </div>
    {addingFiles&&<AddSeriesFiles files={availableFiles} onClose={()=>setAddingFiles(false)} onAdd={async chosen=>{
      await onAddFile?.(chosen)
      const ids=chosen.map(file=>file.id)
      setAddedFiles(old=>[...new Set([...old,...ids])]);setSelected(old=>[...new Set([...old,...ids])])
    }}/>}
    <div className="cal-run-selection" aria-label="Series files">{seriesFiles.map(file=><div className="cal-run-item" key={file.id}><label className="cal-check">
      <input type="checkbox" aria-label={`Prepare ${file.filename}`} checked={!file.source_error&&selected.includes(file.id)} disabled={locked||!!file.source_error} onChange={e=>{
        setAddedFiles(old=>old.includes(file.id)?old:[...old,file.id])
        const next=e.target.checked?[...selected,file.id]:selected.filter(id=>id!==file.id)
        setSelected(next);onSelectionChanged?.(next)
        if(file.id===reference&&!e.target.checked)setReference('')
      }}/>{file.filename}</label>{file.source_error&&<small role="status">{file.source_error}</small>}<WarningFlag message={[...(discovery?.files?.find(f=>f.id===file.id)?.grouping_warnings||[]),runs.find(r=>r.id===file.id)?.limit_reached?'Detection limit reached; review this run.':''].filter(Boolean).join('; ')}/></div>)}</div>
    {status&&<ActionNotice>{status}</ActionNotice>}
    {error&&<ActionNotice error>{error}</ActionNotice>}
    {!!seriesFiles.length&&<SlidingPill label="Series view" value={reviewView} onChange={setReviewView} options={[{value:'review',label:'Review'},{value:'compare',label:'Compare runs'}]}/>}
    {reviewView==='compare'&&<SeriesChromatograms files={seriesFiles.filter(file=>!file.source_error&&selected.includes(file.id))} rows={rows} preparedRuns={runs} theme={theme}/>}
    {reviewView==='review'&&runs.length>0&&<div className="cal-table-wrap cal-candidates" tabIndex={0} role="region" aria-label="Detected standard candidates"><table>
      <thead><tr><th>Concentration</th><th>RT (min)</th><th>Provisional area</th><th>Change vs reference</th><th>Analyte</th><th>Review</th></tr></thead>
      <tbody>{rows.map(row=>{const filename=files.find(f=>f.id===row.dataset_id)?.filename;const level=standardHint(filename).level;return <tr key={row.key}>
        <td title={filename}>{level?`${level.value} ${level.unit}`:'Unknown'}</td>
        <td>{Number.isFinite(row.rt_apex)?row.rt_apex.toFixed(3):'-'}{row.inspection_only&&<small>Expected RT</small>}</td>
        <td>{fmt(corrections[areaKey(row)]?.net_area??row.net_area)}</td><td>{row.state}<small>{row.reference?.detected===false?'Not detected in reference':row.increase===null?'-':`${row.increase.toFixed(1)}%`}</small></td>
        <td>{assignedCompound||discovery?.candidate?.common_name||discovery?.candidate?.name||row.hits[0]?.common_name||row.hits[0]?.name||'Unassigned'}<small>{row.hits[0]?`NIST: ${row.hits[0].common_name||row.hits[0].name} | ${row.hits[0].match_score??'-'} / ${row.hits[0].reverse_score??'-'}`:row.searchError||'No NIST result'}</small></td>
        <td><button className="ghost-button" disabled={locked||saved[row.key]} onClick={()=>open(row)}>{saved[row.key]?'Saved':row.inspection_only?'Draw area':'Review'}</button></td>
      </tr>})}</tbody></table>{!rows.length&&<p>No peaks detected.</p>}</div>}
    {reviewView==='review'&&candidate&&<div className={`cal-candidate-review${expandedReview?' cal-review-expanded':''}`} aria-busy={busy}>
      <div className="cal-section-heading"><h3>{files.find(f=>f.id===candidate.dataset_id)?.filename} | {candidate.rt_apex.toFixed(3)} min</h3>
        <div className="cal-toolbar">
          <button className="icon-button" title="Previous peak" aria-label="Previous peak" disabled={locked||reviewIndex<=0} onClick={()=>open(rows[reviewIndex-1])}><ArrowLeft size={16}/></button>
          <span>{reviewIndex+1} / {rows.length}</span>
          <button className="icon-button" title="Next peak" aria-label="Next peak" disabled={locked||reviewIndex<0||reviewIndex>=rows.length-1} onClick={()=>open(rows[reviewIndex+1],true)}><ArrowRight size={16}/></button>
        </div>
        <div className="cal-toolbar">
          <button className="icon-button" title="Zoom out" aria-label="Zoom out review" disabled={locked} onClick={()=>changeRange('out')}><ZoomOut size={17}/></button>
          <button className="icon-button" title="Show full run" aria-label="Show full run" disabled={locked} onClick={()=>changeRange('full')}><ScanLine size={17}/></button>
          <button className="icon-button" title="Fit peak and area" aria-label="Fit peak and area" disabled={locked} onClick={()=>changeRange('peak')}><RotateCcw size={17}/></button>
          <button className="icon-button" title={expandedReview?'Restore review size':'Expand review'} aria-label={expandedReview?'Restore review size':'Expand review'} aria-pressed={expandedReview} onClick={()=>setExpandedReview(value=>!value)}>{expandedReview?<Minimize size={17}/>:<Maximize size={17}/>}</button>
          <SlidingPill label="Chromatogram tool" value={tool} onChange={setTool} options={[{value:'select',label:'Draw area',disabled:locked},{value:'zoom',label:'Zoom',disabled:locked}]}/>
        </div></div>
      <div className="cal-chromatogram" aria-label="Standard chromatogram" title="Right-drag to draw an area; left-drag to zoom" tabIndex={0}
        onContextMenu={event=>event.preventDefault()} onPointerDownCapture={begin} onPointerMoveCapture={move} onPointerUpCapture={finish}
        onPointerCancel={cancel} onLostPointerCapture={cancel} onKeyDown={event=>{if(event.key==='Escape')cancel()}}>
        <Plot data={chartData} useDisplayPreferences={false} onInitialized={(_,plot)=>{plotRef.current=plot}} onUpdate={(_,plot)=>{plotRef.current=plot}}
        onRelayout={event=>{
          const range=event['xaxis.range']||[event['xaxis.range[0]'],event['xaxis.range[1]']]
          if(range.every(Number.isFinite)&&range[1]>range[0])setReviewRange(old=>old?.[0]===range[0]&&old?.[1]===range[1]?old:range)
        }}
        layout={{autosize:true,dragmode:locked?false:'zoom',uirevision:`${candidate.key}:${rangeRevision}`,
          shapes:drag?[{type:'rect',xref:'x',yref:'paper',x0:drag.start,x1:drag.end,y0:0,y1:1,line:{width:1,color:'#c99423'},fillcolor:'rgba(230,174,56,0.15)'}]:[],
          margin:{l:65,r:16,t:14,b:52},paper_bgcolor:'transparent',plot_bgcolor:'transparent',showlegend:false,
          font:{color:dark?'#eceeed':'#242a29',size:12},xaxis:{title:{text:'Retention time (min)'},range:[viewLeft,viewRight]},yaxis:{title:{text:'TIC'},tickformat:'.2e',range:[localMin-padding,localMax+padding]}}}
        config={{responsive:true,displayModeBar:false,doubleClick:'reset'}} style={{width:'100%',height:'100%'}} useResizeHandler/></div>
      <XRangeControl axis="RT" formatPlotValue={value=>Number(value).toFixed(3)}
        range={{min:points[0]?.x,max:points[points.length-1]?.x}} value={{min:viewLeft,max:viewRight}}
        onChange={locked?undefined:(min,max)=>{setReviewRange([min,max]);setRangeRevision(value=>value+1)}}
        onReset={()=>changeRange('full')} reserveSpace/>
      <div className="cal-fields">
        <label>Start RT<input type="number" step="any" value={left} disabled={locked} onChange={e=>bounds(e.target.value,right)}/></label>
        <label>End RT<input type="number" step="any" value={right} disabled={locked} onChange={e=>bounds(left,e.target.value)}/></label>
        <label>Measurement area multiplier<input type="number" min="0" step="any" value={multiplier} disabled={locked} onChange={e=>{setMultiplier(e.target.value);setMeasured(null);setConfirmed(false);setAreaConfirmed(false)}}/></label>
        <button className="ghost-button" disabled={locked||left===''||right===''} onClick={()=>measure()}>Measure area</button>
        <label>NIST suggestions ({hits.length})<Dropdown aria-label="NIST identity" value={hitIndex} disabled={locked} menuPortal onChange={value=>{setHitIndex(value);setConfirmed(false)}} options={[{value:'',label:'Choose match'},...hits.map((hit,i)=>({value:String(i),label:`${hit.name} | ${hit.cas||'No CAS'} | Match ${hit.match_score??'-'} / reverse ${hit.reverse_score??'-'}`}))]}/></label>
        <label>Compound role<Dropdown aria-label="Compound role" value={role} disabled={locked} menuPortal onChange={setRole} options={[{value:'analyte',label:'Analyte'},{value:'internal_standard',label:'Internal standard'}]}/></label>
        <label>Known quantity<input type="number" min="0" step="any" value={quantity} disabled={locked} onChange={e=>setQuantity(e.target.value)}/></label>
        <label>Quantity unit<Dropdown aria-label="Quantity unit" value={unit} disabled={locked} menuPortal onChange={setUnit} options={choices(['ug/mL','mg/mL','ng/mL','ug','mg','ng'])}/></label>
        <label>Quantity basis<Dropdown aria-label="Quantity basis" value={basis} disabled={locked} menuPortal onChange={setBasis} options={[{value:'added',label:'Amount added'},{value:'total',label:'Known total'}]}/></label>
      </div>
      <p className="cal-subtle">Net area: {fmt(measured?.net_area)} | Baseline: endpoints</p>
      <label className="cal-check"><input type="checkbox" aria-label="Confirm analyte assignment" checked={confirmed} disabled={locked||(!assignedCompound?.trim()&&!selectedHit)||!measured} onChange={e=>setConfirmed(e.target.checked)}/>Analyte assignment confirmed</label>
      <label className="cal-check"><input type="checkbox" aria-label="Verify integration area" checked={areaConfirmed} disabled={locked||!(measured?.net_area>0)} onChange={e=>setAreaConfirmed(e.target.checked)}/>Integration area verified</label>
      <button className="primary-button" disabled={locked||!confirmed||!areaConfirmed||!measured||quantity===''||!!saved[candidate.key]} onClick={save}><Check size={16}/>Save reviewed area</button>
    </div>}
  </section>
}
