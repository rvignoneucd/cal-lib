import {useEffect,useRef,useState} from 'react'
import {apiGet} from '../api/client'
import Plot from '../components/LazyPlotlyPlot'

const finite = value => Number.isFinite(Number(value)) ? Number(value) : null

function PeakTracePreview({peak,theme}) {
  const [data,setData]=useState(null),[error,setError]=useState('')
  useEffect(()=>{
    if(!peak?.dataset_id){setData(null);setError('');return}
    let cancelled=false
    setData(null);setError('')
    apiGet(`/datasets/${encodeURIComponent(peak.dataset_id)}/chromatogram?trace=TIC&max_points=20000`).then(value=>{if(!cancelled)setData(value)}).catch(reason=>{if(!cancelled)setError(reason.message||'Chromatogram unavailable')})
    return ()=>{cancelled=true}
  },[peak?.dataset_id])
  if(error)return <div className="cal-peak-preview" role="status"><small>{error}</small></div>
  if(!data)return <div className="cal-peak-preview" role="status"><small>Loading selected peak...</small></div>
  const points=(data.points||[]).map(point=>({x:finite(point.x),y:finite(point.y)})).filter(point=>point.x!==null&&point.y!==null)
  const left=finite(peak.left),right=finite(peak.right),apex=finite(peak.rt)
  if(!points.length||left===null||right===null)return <div className="cal-peak-preview" role="status"><small>Selected peak trace unavailable</small></div>
  const width=Math.max(right-left,0.04),padding=Math.max(width*.65,.08),start=left-padding,end=right+padding
  const cropped=points.filter(point=>point.x>=start&&point.x<=end)
  const integrated=cropped.filter(point=>point.x>=left&&point.x<=right)
  const nearest=(target)=>cropped.reduce((best,point)=>!best||Math.abs(point.x-target)<Math.abs(best.x-target)?point:best,null)
  const leftPoint=nearest(left),rightPoint=nearest(right)
  const dark=theme==='dark',grid=dark?'#4c514f':'#dce2df',accent=dark?'#7eacff':'#4472c4',text=dark?'#eceeed':'#242a29'
  const baseline=(peak.baseline||[]).map(point=>({x:finite(point.x),y:finite(point.y)})).filter(point=>point.x!==null&&point.y!==null)
  const maxY=Math.max(1,...cropped.map(point=>point.y),...baseline.map(point=>point.y))
  return <div className="cal-peak-preview" aria-label={`Selected peak at ${apex?.toFixed(3)||'-'} minutes`}>
    <Plot useDisplayPreferences={false} data={[
      ...(integrated.length?[{type:'scatter',mode:'lines',x:integrated.map(point=>point.x),y:integrated.map(point=>point.y),fill:'tozeroy',fillcolor:dark?'rgba(126,172,255,.22)':'rgba(68,114,196,.16)',line:{color:'transparent'},hoverinfo:'skip'}]:[]),
      {type:'scatter',mode:'lines',x:cropped.map(point=>point.x),y:cropped.map(point=>point.y),line:{color:accent,width:2},hovertemplate:'RT %{x:.3f} min<br>Height %{y:.3e}<extra></extra>'},
      ...(baseline.length?[{type:'scatter',mode:'lines',x:baseline.map(point=>point.x),y:baseline.map(point=>point.y),line:{color:accent,width:1,dash:'dot'},hoverinfo:'skip'}]:[]),
      ...(leftPoint&&rightPoint?[{type:'scatter',mode:'markers',x:[leftPoint.x,rightPoint.x],y:[leftPoint.y,rightPoint.y],marker:{color:accent,size:7},hovertemplate:'Area marker<br>RT %{x:.3f} min<extra></extra>'}]:[])
    ]} layout={{autosize:true,margin:{l:58,r:12,t:8,b:42},paper_bgcolor:'transparent',plot_bgcolor:'transparent',font:{color:text,size:10},showlegend:false,dragmode:false,uirevision:`${peak.dataset_id}:${left}:${right}`,xaxis:{title:{text:'Retention time (min)',font:{size:10}},range:[start,end],gridcolor:grid,zeroline:false,tickformat:'.3f'},yaxis:{title:{text:'Height',font:{size:10}},range:[0,maxY*1.08],gridcolor:grid,zeroline:false,tickformat:'.2e'},shapes:[{type:'line',x0:left,x1:left,y0:0,y1:maxY*1.04,line:{color:accent,width:2}},{type:'line',x0:right,x1:right,y0:0,y1:maxY*1.04,line:{color:accent,width:2}}]}} config={{displayModeBar:false,responsive:true}} style={{width:'100%',height:'100%'}} useResizeHandler/>
  </div>
}

export default function CompoundInfo({name,lookupName=name,theme,part='all',peak=null}) {
  const root=useRef(null)
  const [visible,setVisible]=useState(false),[data,setData]=useState(null),[attempt,setAttempt]=useState(0)
  useEffect(()=>{
    const observer=new IntersectionObserver(([entry])=>{if(entry.isIntersecting){setVisible(true);observer.disconnect()}},{rootMargin:'200px'})
    observer.observe(root.current)
    return ()=>observer.disconnect()
  },[])
  useEffect(()=>{
    if(!visible||!lookupName)return
    let cancelled=false
    setData(null)
    apiGet(`/lab/compound-info?name=${encodeURIComponent(lookupName)}`).then(value=>{if(!cancelled)setData(value)})
      .catch(()=>{if(!cancelled)setData({message:'PubChem unavailable'})})
    return ()=>{cancelled=true}
  },[lookupName,visible,attempt])
  const info=data?.info
  return <div ref={root} className={`cal-compound-info cal-compound-info-${part}`}>
    {!data?<small>Loading PubChem...</small>:!data.found?<><small>{data.message}</small><button className="cal-text-link" onClick={()=>setAttempt(a=>a+1)}>Retry</button></>:<>
      {part!=='details'&&(peak?<PeakTracePreview peak={peak} theme={theme}/>:data.svg?<img width="350" height="350" alt={`Molecular structure of ${name}`} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(data.svg[theme==='dark'?'dark':'light'])}`}/>:<small>Structure unavailable</small>)}
      {part!=='structure'&&<><dl><dt>PubChem CID</dt><dd><a href={info.pubchem_url} target="_blank" rel="noreferrer">{info.pubchem_cid}</a></dd><dt>Formula</dt><dd>{info.formula||'-'}</dd><dt>Mol. weight</dt><dd>{info.mol_weight||'-'}</dd><dt>IUPAC</dt><dd>{info.iupac_name||'-'}</dd></dl>
      <small>NIST match used for PubChem lookup; peak identity not confirmed.</small>
      {info.description&&<details><summary>Compound information</summary><p>{info.description}</p><a href={info.source_url} target="_blank" rel="noreferrer">{info.source_name||'PubChem'}</a></details>}
      </>}
    </>}
  </div>
}
