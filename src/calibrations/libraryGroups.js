export function groupLibrary(entries, projects=[], query='') {
  const groups=new Map(),needle=query.trim().toLowerCase()
  for(const entry of entries){
    const label=entry.series||projects.find(project=>project.id===entry.project_id)?.name||'Unassigned source'
    const key=JSON.stringify([entry.project_id,label.trim().toLowerCase().replace(/\s+/g,'')])
    if(!groups.has(key))groups.set(key,{key,label,entries:[],files:new Map(),rank:0})
    const group=groups.get(key)
    group.entries.push(entry)
    for(const file of entry.source_files||[])group.files.set(file.id,file)
    const compound=(entry.compound||'').trim().toLowerCase()
    group.rank=Math.max(group.rank,compound===needle?3:compound.startsWith(needle)?2:compound.includes(needle)?1:0)
  }
  return [...groups.values()].map(group=>({...group,files:[...group.files.values()].sort((a,b)=>a.filename.localeCompare(b.filename,undefined,{numeric:true}))}))
    .sort((a,b)=>(needle?b.rank-a.rank:0)||a.label.localeCompare(b.label,undefined,{numeric:true,sensitivity:'base'})||a.key.localeCompare(b.key))
}
