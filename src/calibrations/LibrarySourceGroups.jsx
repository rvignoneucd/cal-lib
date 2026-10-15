import {useEffect,useRef,useState} from 'react'
import {apiGet} from '../api/client'
import {standardHint} from './standardHints'
import Plot from '../components/LazyPlotlyPlot'
import ChevronIndicator from '../components/ChevronIndicator'
import {Plus,FileChartColumn} from 'lucide-react'

function cleanFolderPath(value) {
  const path=String(value || '').replaceAll('\\', '/').replace(/^\/+|\/+$/g, '')
  return path==='.'?'':path
}

function folderGroup(groups, folderPath) {
  const path=cleanFolderPath(folderPath),key=`folder:${path.toLowerCase()}`
  if(!groups.has(key)) {
    const parts=path.split('/').filter(Boolean)
    groups.set(key,{key,label:parts.at(-1)||'Root folder',folderPath:path,entries:[],files:[]})
  }
  return groups.get(key)
}

export default function LibrarySourceGroups({entries,projects,query,renderDetails,onCreate,disabled}) {
  const [expanded,setExpanded]=useState({}),[compounds,setCompounds]=useState({})
  const [files,setFiles]=useState([]),[error,setError]=useState(''),[trace,setTrace]=useState(null)
  const requestId=useRef(0)
  useEffect(()=>{let active=true;apiGet('/calibration-library/sources/cal-test').then(data=>{if(active)setFiles(data.files)}).catch(e=>{if(active)setError(e.message)});return()=>{active=false}},[])
  const groupsMap=new Map()
  for(const entry of entries) {
    const paths=[...new Set((entry.source_files||[]).map(file=>cleanFolderPath(file.source_folder)).filter(Boolean))]
    const groups=paths.length?paths:['']
    for(const path of groups) {
      const group=folderGroup(groupsMap,path)
      if(!group.entries.some(item=>item.id===entry.id))group.entries.push(entry)
      for(const file of entry.source_files||[]) {
        if(cleanFolderPath(file.source_folder)===path&&!group.files.some(item=>item.id===file.id))group.files.push(file)
      }
    }
  }
  for(const file of files){
    const group=folderGroup(groupsMap,file.source_folder)
    if(!group.files.some(f=>f.id===file.id))group.files.push(file)
  }
  const groups=[...groupsMap.values()]
  const visible=groups.filter(g=>!query.trim()||g.entries.length||[g.label,g.folderPath,...g.files.map(f=>f.filename)].some(s=>s.toLowerCase().includes(query.trim().toLowerCase())))
    .sort((a,b)=>(a.folderPath||'').localeCompare(b.folderPath||'',undefined,{numeric:true}))
  async function openFile(file){const id=++requestId.current;setTrace({file});setError('');try{const result=await apiGet(`/datasets/${file.id}/chromatogram`);if(id===requestId.current)setTrace({file,data:{rt:result.points.map(p=>p.x),tic:result.points.map(p=>p.y)}})}catch(e){if(id===requestId.current){setTrace(null);setError(e.message)}}}
  return <div className="cal-source-library" aria-label="Calibrations by source">
    {error&&<p role="alert">{error}</p>}
    {trace&&<section aria-label="File chromatogram"><h2 style={{overflowWrap:'anywhere'}}>{trace.file.filename}</h2>{trace.data?<Plot useDisplayPreferences={false} data={[{x:trace.data.rt,y:trace.data.tic,type:'scatter',mode:'lines'}]} layout={{autosize:true,height:300,font:{color:getComputedStyle(document.body).color},margin:{l:65,r:20,t:20,b:45},xaxis:{title:{text:'Retention time (min)'}},paper_bgcolor:'transparent',plot_bgcolor:'transparent'}} config={{responsive:true}} style={{width:'100%'}} useResizeHandler/>:<p role="status">Loading chromatogram...</p>}</section>}
    {!visible.length&&<p>No matching files.</p>}
    {visible.map((group,index)=>{
      const open=expanded[group.key]??Boolean(query.trim()),panel=`cal-source-${index}`
      return <section className="cal-source-group" key={group.key}>
        <div style={{display:'flex',alignItems:'center',gap:8}}>
          <button className="icon-button" title={`Add calibration from ${group.folderPath||'the root folder'}`} aria-label={`Add calibration from ${group.folderPath||'the root folder'}`} disabled={disabled} onClick={()=>onCreate(group)}><Plus size={18}/></button>
          <button className="cal-mobile-disclosure" style={{flex:1,minWidth:0}} aria-expanded={open} aria-controls={panel} onClick={()=>setExpanded(old=>({...old,[group.key]:!open}))}>
            <span><strong>{group.label}</strong><small>{group.folderPath||'Selected root'} · {group.files.length} {group.files.length===1?'file':'files'} · {group.entries.length} {group.entries.length===1?'calibration':'calibrations'}</small></span><ChevronIndicator direction={open?'down':'right'}/>
          </button>
        </div>
        <div id={panel} hidden={!open}>{open&&<>
          <div className="cal-source-files"><ul>{group.files.map(file=><li key={file.id}><button className="cal-text-link" title="Open chromatogram" onClick={()=>openFile(file)}><FileChartColumn size={16} aria-hidden="true"/> {file.filename}</button></li>)}</ul></div>
          {group.entries.map(entry=>{
            const key=JSON.stringify([group.key,entry.id]),shown=!!compounds[key],id=`${panel}-${entry.id}`
            return <div className="cal-source-compound" key={entry.id}>
              <button className="cal-mobile-disclosure" aria-expanded={shown} aria-controls={id} onClick={()=>setCompounds(old=>({...old,[key]:!shown}))}>
                <span><strong>{entry.compound||'Unassigned compound'}</strong><small>{entry.sequence?.start?.replace('T',' ')||entry.name} · {entry.published_count?'Published':'Draft'} · {entry.mode==='internal'?'Internal standard':'External'}</small></span><ChevronIndicator direction={shown?'down':'right'}/>
              </button>
              <div id={id} hidden={!shown}>{shown&&renderDetails(entry)}</div>
            </div>
          })}
        </>}</div>
      </section>
    })}
  </div>
}
