export const libraryColumns = [
  ['compound','Compound'],['curve','Curve'],['source','Source / mix'],
  ['date','Acquisition date'],['instrument','Instrument / method'],
  ['column','Column'],['mode','Calibration'],['author','Author'],['status','Status'],
]

export function sortLibrary(entries, sort, fits={}, projects=[], query='') {
  const search=query.trim().toLocaleLowerCase()
  const relevance=entry=>{
    const name=String(entry.compound||'').trim().toLocaleLowerCase()
    return name===search?3:name.startsWith(search)?2:name.includes(search)?1:0
  }
  const textCompare=(a,b)=>String(a).localeCompare(String(b),undefined,{numeric:true,sensitivity:'base'})
  const value=entry=>{
    switch(sort.key){
      case 'curve': return fits[entry.id]
      case 'compound': return entry.compound
      case 'source': return entry.series||projects.find(p=>p.id===entry.project_id)?.name
      case 'date': return entry.sequence?.start
      case 'instrument': return [entry.profile?.instrument,entry.profile?.method].filter(Boolean).join(' ')
      case 'column': return [entry.profile?.column_model,entry.profile?.column_phase].filter(Boolean).join(' ')
      case 'mode': return `${entry.mode==='internal'?'Internal standard':'External'} ${entry.unit||''}`
      case 'status': return entry.published_count||0
      case 'author': return entry.author
      default: return entry.compound
    }
  }
  const missing=v=>v==null||v===''||(typeof v==='number'&&!Number.isFinite(v))
  return [...entries].sort((a,b)=>{
    if(search){const rank=relevance(b)-relevance(a);if(rank)return rank}
    const av=value(a),bv=value(b)
    if(missing(av)!==missing(bv))return missing(av)?1:-1
    const compared=missing(av)?0:typeof av==='number'&&typeof bv==='number'?av-bv:textCompare(av,bv)
    return compared*(sort.direction==='ascending'?1:-1)||textCompare(a.compound||'',b.compound||'')||textCompare(a.id,b.id)
  })
}
