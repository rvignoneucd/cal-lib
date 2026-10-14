import {useEffect,useRef,useState} from 'react'
import {Moon,Sun,RotateCcw} from 'lucide-react'
import Plot from '../components/LazyPlotlyPlot'
import ActionNotice from './ActionNotice'
import './inspection.css'

async function read(path,signal) {
  const response=await fetch(`/api${path}`,{signal,credentials:'omit'})
  if(!response.ok)throw new Error((await response.json()).detail||'Inspection data unavailable')
  return response.json()
}

export default function InspectionSession() {
  const [query]=useState(()=>new URLSearchParams(location.search))
  const id=query.get('id'),version=query.get('version')||'draft'
  const requestedRun=query.get('run'),requestedRt=query.has('rt')?Number(query.get('rt')):null
  const [theme,setTheme]=useState(query.get('theme')==='dark'?'dark':'light')
  const [data,setData]=useState(null),[error,setError]=useState(''),[runId,setRunId]=useState('')
  const [trace,setTrace]=useState(null),[spectrum,setSpectrum]=useState(null),[reset,setReset]=useState(0)
  const sequence=useRef(0)
  useEffect(()=>{document.documentElement.dataset.theme=theme},[theme])
  useEffect(()=>{
    const controller=new AbortController()
    if(!id&&!requestedRun){setError('No calibration or run selected');return}
    read(requestedRun?`/lab/inspection-run/${encodeURIComponent(requestedRun)}`:`/lab/inspection/${encodeURIComponent(id)}?version=${encodeURIComponent(version)}`,controller.signal)
      .then(value=>{setData(value);setRunId(value.runs.find(run=>run.available)?.id||'')})
      .catch(e=>{if(e.name!=='AbortError')setError(e.message)})
    return()=>controller.abort()
  },[id,version,requestedRun])
  useEffect(()=>{
    const controller=new AbortController();sequence.current++;setTrace(null);setSpectrum(null)
    if(runId)read(`/datasets/${encodeURIComponent(runId)}/chromatogram`,controller.signal).then(setTrace).catch(e=>{if(e.name!=='AbortError')setError(e.message)})
    return()=>controller.abort()
  },[runId])
  async function inspect(rt) {
    const request=++sequence.current
    try {
      const result=await read(requestedRun?`/lab/inspection-run/${encodeURIComponent(runId)}/spectrum?rt=${rt}`:`/lab/inspection/${encodeURIComponent(id)}/spectrum/${encodeURIComponent(runId)}?rt=${rt}&version=${encodeURIComponent(version)}`)
      if(request===sequence.current)setSpectrum(result)
    }catch(e){if(request===sequence.current)setError(e.message)}
  }
  useEffect(()=>{if(trace&&runId&&Number.isFinite(requestedRt))inspect(requestedRt)},[trace,runId,requestedRt])
  const dark=theme==='dark',color=dark?'#eceeed':'#242a29',grid=dark?'#4c514f':'#dce2df'
  const layout={autosize:true,paper_bgcolor:'transparent',plot_bgcolor:'transparent',font:{color,size:13},margin:{l:70,r:20,t:15,b:50},dragmode:'zoom',showlegend:false}
  const run=data?.runs.find(run=>run.id===runId)
  const measurement=run?.measurement
  const points=trace?.points||[]
  const area=measurement?.segment||[]
  const traces=[{type:'scatter',mode:'lines',x:points.map(p=>p.x),y:points.map(p=>p.y),line:{color:dark?'#58d8c2':'#087f72',width:1.4},hovertemplate:'%{x:.3f} min<br>%{y:.3e}<extra></extra>'}]
  if(area.length)traces.push({type:'scatter',mode:'lines',x:area.map(p=>p.x),y:area.map(p=>p.y),line:{color:'#b88016',width:1},name:'Saved area'})
  return <main className="cal-site atmos-inspection">
    <header><div><strong>Atmos</strong><span>Inspection</span></div><h1>{data?.compound||'Calibration'}</h1><span>{data?`${data.runs.length} runs`:''}</span><button className="icon-button" title="Toggle theme" aria-label="Toggle theme" onClick={()=>setTheme(dark?'light':'dark')}>{dark?<Sun size={16}/>:<Moon size={16}/>}</button></header>
    {error&&<ActionNotice error onDismiss={()=>setError('')}>{error}</ActionNotice>}
    <div className="inspection-workspace"><aside aria-label="Series runs">{data?.runs.map(file=><button key={file.id} className="inspection-run" aria-pressed={file.id===runId} disabled={!file.available} onClick={()=>setRunId(file.id)}><span>{file.filename}</span><small>{file.available?(file.excluded?'Excluded from fit':'Available'):'Source unavailable'}</small></button>)}</aside>
      <section className="inspection-plots"><div className="inspection-toolbar"><strong>{run?.filename||'Loading runs...'}</strong><button className="icon-button" title="Reset zoom" aria-label="Reset zoom" onClick={()=>setReset(old=>old+1)}><RotateCcw size={16}/></button></div>
        <div className="inspection-chromatogram" aria-label="Chromatogram">{trace?<Plot data={traces} layout={{...layout,uirevision:`${runId}:${reset}`,xaxis:{title:{text:'Retention time (min)'},gridcolor:grid},yaxis:{title:{text:'TIC'},gridcolor:grid,tickformat:'.2e'}}} config={{responsive:true,displayModeBar:false,doubleClick:'reset'}} style={{height:'100%',width:'100%'}} useDisplayPreferences={false} useResizeHandler onClick={event=>{const rt=event.points?.[0]?.x;if(Number.isFinite(rt))inspect(rt)}}/>:<p role="status">{runId?'Loading chromatogram...':'No run selected'}</p>}</div>
        <div className="inspection-spectrum" aria-label="Mass spectrum">{spectrum?<Plot data={[{type:'bar',x:spectrum.points.map(p=>p.mz),y:spectrum.points.map(p=>p.intensity),marker:{color:dark?'#79b7ff':'#2868ad'}}]} layout={{...layout,uirevision:`${runId}:${reset}:spectrum`,xaxis:{title:{text:'m/z'},gridcolor:grid},yaxis:{title:{text:'Intensity'},gridcolor:grid},title:{text:`${spectrum.rt.toFixed(3)} min`,font:{size:13}}}} config={{responsive:true,displayModeBar:false}} style={{height:'100%',width:'100%'}} useResizeHandler useDisplayPreferences={false}/>:<span>Mass spectrum</span>}</div>
      </section></div>
  </main>
}
