import {useEffect,useRef,useState} from 'react'
import {apiGet,getAuthToken} from '../api/client'
import Plot from '../components/LazyPlotlyPlot'
import {createChromatogramCache} from './chromatogramCache.js'

const finite = value => Number.isFinite(Number(value)) ? Number(value) : null
const chromatogramCache = createChromatogramCache(
  datasetId=>apiGet(`/datasets/${encodeURIComponent(datasetId)}/chromatogram?trace=TIC&max_points=20000`),
  {scope:getAuthToken},
)

function PeakTracePreview({peak,peaks=[],theme,stacked=false}) {
  const selectedPeaks=(peaks.length?peaks:[peak]).filter(Boolean)
  const datasetKey=JSON.stringify(selectedPeaks.map(({dataset_id,left,right,rt,concentration})=>[dataset_id,left,right,rt,concentration]))
  const cachedTraces=()=>selectedPeaks.map(peak=>{
    const cached=chromatogramCache.peek(peak.dataset_id)
    return cached?{peak,points:cached.points||[]}:null
  }).filter(Boolean)
  const [traces,setTraces]=useState(cachedTraces),[error,setError]=useState(''),[attempt,setAttempt]=useState(0),[loading,setLoading]=useState(true)
  useEffect(()=>{
    let cancelled=false
    setTraces(cachedTraces());setError('');setLoading(true)
    if(!selectedPeaks.length){setError('Selected peak unavailable');setLoading(false);return()=>{cancelled=true}}
    Promise.allSettled(selectedPeaks.map(item=>chromatogramCache.get(item.dataset_id))).then(results=>{
      const loaded=results.map((result,index)=>result.status==='fulfilled'?{peak:selectedPeaks[index],points:result.value.points||[]}:null).filter(Boolean)
      if(cancelled)return
      setLoading(false)
      if(loaded.length)setTraces(loaded)
      else setError('Selected peak trace unavailable')
    })
    return()=>{cancelled=true}
  },[datasetKey,attempt])
  const boxClass='cal-peak-preview'
  if(error)return <div className={boxClass} role="status"><small>{error}</small> <button className="cal-text-link" onClick={()=>setAttempt(value=>value+1)}>Retry</button></div>
  if(!traces.length)return <div className={boxClass} role="status"><small>Loading selected peak traces...</small></div>
  const active=stacked?null:(peak||selectedPeaks[0])
  const leftCandidates=selectedPeaks.map(item=>finite(item.left)).filter(value=>value!==null)
  const rightCandidates=selectedPeaks.map(item=>finite(item.right)).filter(value=>value!==null)
  const left=active?finite(active.left):Math.min(...leftCandidates),right=active?finite(active.right):Math.max(...rightCandidates),apex=finite(active?.rt)
  if(!Number.isFinite(left)||!Number.isFinite(right))return <div className={boxClass} role="status"><small>Selected peak trace unavailable</small></div>
  const width=Math.max(right-left,0.04),padding=Math.max(width*.65,.08),start=left-padding,end=right+padding
  const prepared=traces.filter(trace=>!active||trace.peak.dataset_id===active.dataset_id).map((trace,index)=>{
    const points=trace.points.map(point=>({x:finite(point.x),y:finite(point.y)})).filter(point=>point.x!==null&&point.y!==null&&point.x>=start&&point.x<=end)
    const max=Math.max(1,...points.map(point=>point.y))
    return {...trace,index,points,rawMax:max}
  }).filter(trace=>trace.points.length)
  if(!prepared.length)return <div className={boxClass} role="status"><small>{loading?'Loading selected peak trace...':'Selected peak trace unavailable'}</small>{!loading&&<> <button className="cal-text-link" onClick={()=>setAttempt(value=>value+1)}>Retry</button></>}</div>
  const activeTrace=active?prepared.find(trace=>trace.peak.dataset_id===active.dataset_id)||prepared[0]:null
  const activeOriginal=activeTrace?traces.find(trace=>trace.peak.dataset_id===activeTrace.peak.dataset_id)?.points.map(point=>({x:finite(point.x),y:finite(point.y)})).filter(point=>point.x!==null&&point.y!==null&&point.x>=start&&point.x<=end)||[]:[]
  const maxOriginal=Math.max(1,...activeOriginal.map(point=>point.y))
  const renderHeight=value=>value
  const integrated=activeOriginal.filter(point=>point.x>=left&&point.x<=right)
  const nearest=target=>activeOriginal.reduce((best,point)=>!best||Math.abs(point.x-target)<Math.abs(best.x-target)?point:best,null)
  const leftPoint=nearest(left),rightPoint=nearest(right)
  const dark=theme==='dark',grid=dark?'#4c514f':'#dce2df',accent=dark?'#7eacff':'#4472c4',muted=dark?'#68716d':'#9aa7b5',text=dark?'#eceeed':'#242a29'
  const stackHeight=stacked?Math.max(...prepared.map(trace=>trace.rawMax)):maxOriginal
  const activeOffset=0
  const plotData=[...prepared.map(trace=>{const isActive=!!activeTrace&&trace.peak.dataset_id===activeTrace.peak.dataset_id;return {type:'scatter',mode:'lines',name:trace.peak.concentration===undefined?'Standard':`${trace.peak.concentration}`,x:trace.points.map(point=>point.x),y:trace.points.map(point=>point.y),line:{color:isActive?accent:muted,width:isActive?1.7:1},opacity:stacked||isActive?1:.5,customdata:trace.points.map(point=>[point.y]),hovertemplate:`${trace.peak.concentration===undefined?'Standard':`Conc. ${trace.peak.concentration}`}<br>RT %{x:.3f} min<br>Peak height %{customdata[0]:.2e}<extra></extra>`}})]
  if(integrated.length)plotData.push({type:'scatter',mode:'lines',x:integrated.map(point=>point.x),y:integrated.map(point=>renderHeight(point.y)),fill:'tozeroy',fillcolor:dark?'rgba(126,172,255,.08)':'rgba(68,114,196,.08)',line:{color:'transparent'},hoverinfo:'skip'})
  if(leftPoint&&rightPoint)plotData.push({type:'scatter',mode:'markers',x:[leftPoint.x,rightPoint.x],y:[renderHeight(leftPoint.y),renderHeight(rightPoint.y)],marker:{color:accent,size:6},hovertemplate:'Area marker<br>RT %{x:.3f} min<extra></extra>'})
  const shapes=activeTrace?[{type:'rect',x0:left,x1:right,y0:activeOffset,y1:activeOffset+(stacked?1:maxOriginal),line:{color:accent,width:1},fillcolor:dark?'rgba(126,172,255,.04)':'rgba(68,114,196,.04)'},{type:'line',x0:left,x1:left,y0:activeOffset,y1:activeOffset+(stacked?1.02:maxOriginal*1.02),line:{color:accent,width:1.5}},{type:'line',x0:right,x1:right,y0:activeOffset,y1:activeOffset+(stacked?1.02:maxOriginal*1.02),line:{color:accent,width:1.5}}]:[]
  return <div className={boxClass} aria-label={stacked?'Overlaid chromatogram traces at actual height':`Selected peak at ${apex?.toFixed(3)||'-'} minutes`}>
    <Plot useDisplayPreferences={false} data={plotData} layout={{autosize:true,margin:{l:72,r:12,t:12,b:50},paper_bgcolor:'transparent',plot_bgcolor:'transparent',font:{color:text,size:12},showlegend:false,dragmode:false,uirevision:`${datasetKey}:${left}:${right}:${stacked}`,xaxis:{title:{text:'Retention time (min)'},range:[start,end],gridcolor:grid,zeroline:false,tickformat:'.3f'},yaxis:{title:{text:'Height'},range:[0,stackHeight*1.08],gridcolor:grid,zeroline:false,tickformat:'.2e'},shapes}} config={{displayModeBar:false,responsive:true}} style={{width:'100%',height:'100%'}} useResizeHandler/>
  </div>
}

export default function CompoundInfo({name,lookupName=name,theme,part='all',peak=null,peaks=[],previewPeaks=[],stacked=false}) {
  const root=useRef(null)
  const [visible,setVisible]=useState(false),[data,setData]=useState(null),[attempt,setAttempt]=useState(0)
  useEffect(()=>{
    const observer=new IntersectionObserver(([entry])=>{if(entry.isIntersecting){setVisible(true);observer.disconnect()}},{rootMargin:'200px'})
    observer.observe(root.current)
    return()=>observer.disconnect()
  },[])
  useEffect(()=>{
    if(!visible||!lookupName)return
    let cancelled=false
    setData(null)
    apiGet(`/lab/compound-info?name=${encodeURIComponent(lookupName)}`).then(value=>{if(!cancelled)setData(value)}).catch(()=>{if(!cancelled)setData({message:'PubChem unavailable'})})
    return()=>{cancelled=true}
  },[lookupName,visible,attempt])
  const info=data?.info
  const showStructure=part!=='details'
  const showDetails=part!=='structure'
  const prewarm=part==='structure'&&visible&&previewPeaks.length>0
  const showPeak=!!peak||stacked
  return <div ref={root} className={`cal-compound-info cal-compound-info-${part}`}>
    {prewarm&&<div className="cal-prewarmed-peak" aria-hidden={!showPeak} style={{visibility:showPeak?'visible':'hidden',pointerEvents:showPeak?'auto':'none'}}><PeakTracePreview peak={peak} peaks={previewPeaks} theme={theme} stacked={stacked||!peak}/></div>}
    {showStructure&&(!showPeak?data?.found&&data.svg?<img width="350" height="350" alt={`Molecular structure of ${name}`} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(data.svg[theme==='dark'?'dark':'light'])}`}/>:!data?<small>Loading PubChem...</small>:<><small>{data.message||'Structure unavailable'}</small><button className="cal-text-link" onClick={()=>setAttempt(a=>a+1)}>Retry</button></>:!prewarm&&<PeakTracePreview peak={peak} peaks={peaks} theme={theme} stacked={stacked}/>)}
    {showDetails&&(!data?<small>Loading PubChem...</small>:!data.found?<><small>{data.message}</small><button className="cal-text-link" onClick={()=>setAttempt(a=>a+1)}>Retry</button></>:<><dl><dt>PubChem CID</dt><dd><a href={info.pubchem_url} target="_blank" rel="noreferrer">{info.pubchem_cid}</a></dd><dt>Formula</dt><dd>{info.formula||'-'}</dd><dt>Mol. weight</dt><dd>{info.mol_weight||'-'}</dd><dt>IUPAC</dt><dd>{info.iupac_name||'-'}</dd></dl><small>NIST match used for PubChem lookup; peak identity not confirmed.</small>{info.description&&<details><summary>Compound information</summary><p>{info.description}</p><a href={info.source_url} target="_blank" rel="noreferrer">{info.source_name||'PubChem'}</a></details>}</>)}
  </div>
}
