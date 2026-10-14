// Extend provisional intake only. Reviewed rows, names, profiles, published
// versions and concentration edits belong to the analyst, not the watcher.
export function mergeDiscovery(draft, proposal) {
  const previous=draft.discovery||{}, current=proposal.discovery||{}
  const known=new Set((previous.files||[]).map(file=>file.id))
  const added=proposal.rows.filter(row=>!known.has(row.dataset_id)&&!draft.rows.some(old=>old.dataset_id===row.dataset_id))
  const byRun=new Map((previous.files||[]).map((file,index)=>[file.id,{file,preparation:previous.preparations?.[index]}]))
  for(const [index,file] of (current.files||[]).entries())byRun.set(file.id,{file,preparation:current.preparations?.[index]})
  const retained=[...byRun.keys()].filter(id=>!current.files.some(file=>file.id===id))
  const discovery={...previous,...current,files:[...byRun.values()].map(v=>v.file),preparations:[...byRun.values()].map(v=>v.preparation).filter(Boolean),
    issue:[current.issue,retained.length?`${retained.length} earlier source runs retained; active source sequence changed. Review before publishing.`:''].filter(Boolean).join(' ')}
  if(!added.length&&JSON.stringify(previous)===JSON.stringify(discovery))return null
  return {...draft,rows:[...draft.rows,...added],discovery}
}
