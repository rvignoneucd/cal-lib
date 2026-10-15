import {useEffect,useRef,useState} from 'react'
import {apiGet} from '../api/client'

export default function CompoundInfo({name,lookupName=name,theme,part='all'}) {
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
      {part!=='details'&&(data.svg?<img width="200" height="150" alt={`Molecular structure of ${name}`} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(data.svg[theme==='dark'?'dark':'light'])}`}/>:<small>Structure unavailable</small>)}
      {part!=='structure'&&<><dl><dt>PubChem CID</dt><dd><a href={info.pubchem_url} target="_blank" rel="noreferrer">{info.pubchem_cid}</a></dd><dt>Formula</dt><dd>{info.formula||'-'}</dd><dt>Mol. weight</dt><dd>{info.mol_weight||'-'}</dd><dt>IUPAC</dt><dd>{info.iupac_name||'-'}</dd></dl>
      <small>NIST match used for PubChem lookup; peak identity not confirmed.</small>
      {info.description&&<details><summary>Compound information</summary><p>{info.description}</p><a href={info.source_url} target="_blank" rel="noreferrer">{info.source_name||'PubChem'}</a></details>}
      </>}
    </>}
  </div>
}
