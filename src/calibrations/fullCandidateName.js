// Keep Fast-search grouping stable; Full evidence names the series, not every run.
export async function fullCandidateName(target, assignment, send) {
  const rows=target.rows.filter(row=>Number.isFinite(row.net_area)&&row.net_area>0&&Number.isFinite(row.rt_apex)&&
    (!assignment.selected||assignment.selected[row.dataset_id]===row.rt_apex))
  const largest=[...rows].sort((a,b)=>b.net_area-a.net_area)[0]
  if(!largest)return {error:'No measured candidate for Full NIST search'}
  if(!assignment.selected)return {error:'Resolve ambiguous peak assignments before Full NIST naming'}
  const response=await send(`/datasets/${encodeURIComponent(largest.dataset_id)}/library/search-batch`,'POST',{rts:[largest.rt_apex],full_search:true})
  const result=response.results?.[0]
  if(result?.error||!result?.hits?.[0]?.name)return {error:result?.error||'Full NIST returned no candidate',dataset_id:largest.dataset_id,rt:largest.rt_apex}
  return {hit:result.hits[0],name:result.hits[0].common_name||result.hits[0].name,dataset_id:largest.dataset_id,
    rt:largest.rt_apex,area:largest.net_area,search_type:'sI',searched_at:result.searched_at,identity_confirmed:!!result.identity_confirmed}
}
