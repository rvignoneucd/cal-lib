import ActionNotice from './ActionNotice'
import {useEffect,useState} from 'react'
import {X,Check} from 'lucide-react'
import Plot from '../components/LazyPlotlyPlot'
import {apiGet,apiSend} from '../api/client'

export default function PeakIdentity({selection,theme,onClose,onSaved}) {
  const [data,setData]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  useEffect(()=>{let active=true;setData(null);setError('');apiGet(`/datasets/${selection.id}/peak-identity?rt=${selection.rt}`).then(d=>{if(active)setData(d)}).catch(e=>{if(active)setError(e.message)});return()=>{active=false}},[selection.id,selection.rt])
  async function confirm(hit){setBusy(true);setError('');try{const saved=await apiSend(`/datasets/${selection.id}/peak-identity`,'PUT',{rt:data.rt,rank:hit.rank});setData(old=>({...old,selected:saved}));onSaved(selection.id,data.rt,saved.hit)}catch(e){setError(e.message)}finally{setBusy(false)}}
  const dark=theme==='dark'
  return <section className="cal-identity" aria-label="Peak identity review">
    <div className="cal-section-heading"><h2>NIST identity · {selection.rt.toFixed(3)} min</h2><button className="icon-button" aria-label="Close identity review" title="Close identity review" onClick={onClose}><X size={17}/></button></div>
    {error&&<ActionNotice error>{error}</ActionNotice>}{!data&&!error&&<p role="status">Searching NIST candidates...</p>}
    {data&&<><p className="cal-subtle">{data.filename} · Top {data.hits.length} returned matches · Filename agreement adds 20 ranking points; spectral scores are unchanged.</p>
      {data.selected&&<ActionNotice>{`Confirmed: ${data.selected.hit.name}. Discovery refresh queued; existing reviewed areas are preserved.`}</ActionNotice>}
      <div className="cal-identity-spectrum"><Plot useDisplayPreferences={false} data={[{type:'scatter',mode:'lines',x:data.spectrum.flatMap(p=>[p.mz,p.mz,null]),y:data.spectrum.flatMap(p=>[0,p.intensity,null]),line:{color:dark?'#58d8c2':'#087f72',width:1},hovertemplate:'m/z %{x}<br>%{y:.3e}<extra></extra>'}]} layout={{autosize:true,margin:{l:65,r:15,t:25,b:45},paper_bgcolor:'transparent',plot_bgcolor:'transparent',font:{color:dark?'#eceeed':'#242a29'},xaxis:{title:{text:'m/z'}},yaxis:{title:{text:'Measured intensity'},tickformat:'.2e'}}} config={{responsive:true,displayModeBar:false}} style={{width:'100%',height:'100%'}} useResizeHandler/></div>
      <div className="cal-identity-hits"><table><thead><tr><th>NIST rank</th><th>Compound / CAS</th><th>Match / reverse</th><th>Filename</th><th/></tr></thead><tbody>{data.hits.map(hit=><tr key={hit.rank}><td>{hit.rank}</td><td>{hit.name}<small>{hit.cas||'-'}</small></td><td>{hit.match_score} / {hit.reverse_score}</td><td>{hit.filename_support?'Agreement':'-'}</td><td><button className="icon-button" disabled={busy} title={`Confirm ${hit.name}`} aria-label={`Confirm ${hit.name}, rank ${hit.rank}`} onClick={()=>confirm(hit)}><Check size={17}/></button></td></tr>)}</tbody></table></div>
    </>}
  </section>
}
