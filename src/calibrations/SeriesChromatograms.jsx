import {useEffect,useState} from 'react'
import SlidingPill from '../components/SlidingPill'
import Plot from '../components/LazyPlotlyPlot'
import {apiGet} from '../api/client'
import {standardHint} from './standardHints.js'
import PeakIdentity from './PeakIdentity'

export default function SeriesChromatograms({files,rows,preparedRuns=[],theme}) {
  const [mode,setMode]=useState('stacked'),[scale,setScale]=useState('raw'),[scope,setScope]=useState('peak')
  const [runs,setRuns]=useState([]),[loading,setLoading]=useState(true)
  const [selection,setSelection]=useState(null),[identities,setIdentities]=useState({})
  useEffect(()=>{let cancelled=false;setLoading(true)
    Promise.all(files.map(async file=>{try {const data=await apiGet(`/datasets/${encodeURIComponent(file.id)}/chromatogram?trace=TIC&max_points=100000`);return {...file,points:data.points||[]}}
      catch(error){return {...file,points:[],error:error.message}}})).then(data=>{if(!cancelled){setRuns(data);setLoading(false)}})
    return()=>{cancelled=true}
  },[files.map(f=>f.id).join('|')])
  const dark=theme==='dark',color=dark?'#eceeed':'#242a29',grid=dark?'#4c514f':'#dce2df'
  const rts=rows.map(row=>row.rt_apex).filter(Number.isFinite)
  const range=scope==='peak'&&rts.length?[Math.min(...rts)-.35,Math.max(...rts)+.35]:undefined
  const available=runs.filter(run=>run.points.length),count=available.length
  const layout={autosize:true,dragmode:'zoom',uirevision:`${mode}:${scope}:${scale}`,paper_bgcolor:'transparent',plot_bgcolor:'transparent',
    margin:{l:88,r:18,t:35,b:55},font:{color,size:12},showlegend:mode==='overlay',legend:{orientation:'h',y:1.15},annotations:[]}
  const palette=dark?['#58d8c2','#fbbf67','#c7a6f7','#ff91a4','#79b7ff','#d5dc75','#f1a9df']:['#087f72','#a5510e','#7951ae','#b83c59','#2868ad','#65751c','#a13d8c']
  const traces=available.map((run,index)=>{
    const selected=range?run.points.filter(p=>p.x>=range[0]&&p.x<=range[1]):run.points
    const max=selected.reduce((m,p)=>Math.max(m,p.y),0)||1
    const level=standardHint(run.filename).level,label=level?`${level.value} ${level.unit}`:run.filename
    const suffix=index?String(index+1):''
    const peaks=preparedRuns.find(prepared=>prepared.id===run.id)?.peaks||[]
    const customdata=run.points.map(point=>{
      const peak=peaks.filter(peak=>point.x>=peak.rt_left&&point.x<=peak.rt_right).sort((a,b)=>Math.abs(a.rt_apex-point.x)-Math.abs(b.rt_apex-point.x))[0]
      const hit=identities[`${run.id}:${peak?.rt_apex}`]||peak?.hits?.[0]
      return hit?[hit.name,hit.match_score??'-',hit.reverse_score??'-',hit.cas||'-']:['No NIST match at this RT','-','-','-']
    })
    if(mode==='stacked'){
      const gap=.025,slot=1/count
      layout[`xaxis${suffix}`]={title:index===count-1?{text:'Retention time (min)'}:undefined,range,anchor:`y${suffix}`,matches:index?'x':undefined,showticklabels:index===count-1,gridcolor:grid}
      layout[`yaxis${suffix}`]={domain:[1-(index+1)*slot,1-index*slot-gap],anchor:`x${suffix}`,tickformat:scale==='raw'?'.2e':'.0%',rangemode:'tozero',gridcolor:grid}
      layout.annotations.push({xref:'paper',yref:'paper',x:0,y:1-index*slot-gap,text:label,showarrow:false,xanchor:'left',yanchor:'bottom',font:{color:palette[index%palette.length]}})
    }
    return {type:'scatter',mode:'lines',name:label,x:run.points.map(p=>p.x),y:run.points.map(p=>scale==='raw'?p.y:p.y/max),
      xaxis:mode==='stacked'?`x${suffix}`:'x',yaxis:mode==='stacked'?`y${suffix}`:'y',line:{color:palette[index%palette.length],width:1.5},
      customdata,hovertemplate:`${label}<br>RT %{x:.3f} min<br>%{y:.3e}<br>NIST: %{customdata[0]}<br>Match %{customdata[1]} / reverse %{customdata[2]}<br>CAS %{customdata[3]}<extra></extra>`}
  })
  if(mode==='overlay'){layout.xaxis={title:{text:'Retention time (min)'},range,gridcolor:grid};layout.yaxis={title:{text:scale==='raw'?'TIC':'Relative intensity'},tickformat:scale==='raw'?'.2e':'.0%',gridcolor:grid,rangemode:'tozero'}}
  return <div>
    <div className="cal-toolbar">
      <SlidingPill label="Series trace layout" value={mode} onChange={setMode} options={[{value:'stacked',label:'Stacked'},{value:'overlay',label:'Overlay'}]}/>
      <SlidingPill label="Series trace scale" value={scale} onChange={setScale} options={[{value:'raw',label:'Raw'},{value:'normalized',label:'Normalized'}]}/>
      <SlidingPill label="Series trace range" value={scope} onChange={setScope} options={[{value:'peak',label:'Peak'},{value:'full',label:'Full run'}]}/>
    </div>
    {loading?<p role="status">Loading series chromatograms...</p>:<>
      {runs.filter(run=>run.error).map(run=><p className="cal-alert" key={run.id}>{run.filename}: {run.error}</p>)}
      {!!count&&<div aria-label="Series chromatograms" style={{height:mode==='stacked'?Math.max(360,count*150):450,minWidth:0}}>
        <Plot data={traces} layout={layout} onClick={event=>{const point=event.points?.[0],run=available[point?.curveNumber];if(!run)return;const peak=(preparedRuns.find(p=>p.id===run.id)?.peaks||[]).filter(p=>point.x>=p.rt_left&&point.x<=p.rt_right).sort((a,b)=>Math.abs(a.rt_apex-point.x)-Math.abs(b.rt_apex-point.x))[0];setSelection({id:run.id,rt:peak?.rt_apex??point.x})}} useDisplayPreferences={false} config={{responsive:true,displayModeBar:false,doubleClick:'reset'}} style={{width:'100%',height:'100%'}} useResizeHandler/>
      </div>}
    </>}
    {selection&&<PeakIdentity selection={selection} theme={theme} onClose={()=>setSelection(null)} onSaved={(id,rt,hit)=>setIdentities(old=>({...old,[`${id}:${selection.rt}`]:hit}))}/>}
  </div>
}
