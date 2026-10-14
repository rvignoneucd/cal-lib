import { standardGroups } from './standardHints.js'
import { compareRuns, prepareRuns } from './preparation.js'
import { compoundSeries, responseAssignment, reviewSeries, qualifySeries } from './compoundSeries.js'

export async function discoverStandards(projectId,files,{get,send,signal,progress=()=>{},onGrouped=()=>{},onExisting,sleep,identifyCandidate}) {
  // Persist each run independently: a failed search or conversion must not lose
  // already prepared areas, nor be interpreted as an undetected reference.
  const prepared=new Map()
  for(const [index,file] of files.entries()) {
    if(signal?.aborted)throw new DOMException('Discovery stopped','AbortError')
    const areaMultiplier=Number(file.profile?.area_multiplier)||60
    let run
    try {
      const results=await prepareRuns([file.id],{get,send,signal,sleep,areaMultiplier,
        progress:text=>progress(`Run ${index+1}/${files.length}: ${file.filename} - ${text}`)})
      run=results[0]
    } catch(error) {
      if(error.name==='AbortError')throw error
      run={id:file.id,peaks:[],error:error.message,area_multiplier:areaMultiplier,integration:'endpoints'}
    }
    if(signal?.aborted)throw new DOMException('Discovery stopped','AbortError')
    const snapshot=await send(`/calibration-library/preparations/${encodeURIComponent(projectId)}`,'POST',run)
    prepared.set(file.id,{...run,preparation_id:snapshot.preparation_id})
  }
  // Method sidecars can become available during conversion. Group only after
  // refreshing them, not from the initial folder-list placeholders.
  const refreshed=await get(`/calibration-library/sources/${encodeURIComponent(projectId)}`)
  const groups=standardGroups(files.map(file=>refreshed.files.find(f=>f.id===file.id)||file))
  onGrouped(groups.map(group=>({...group,file_warnings:group.files.flatMap(file=>{
    const run=prepared.get(file.id)
    const message=run?.error||((run?.peaks||[]).some(p=>p.searchError)?'NIST search needs review':'')
    return message?[{id:file.id,filename:file.filename,message}]:[]
  })})))
  let created=0,reused=0
  for(const [index,group] of groups.entries()) {
    if(signal?.aborted)throw new DOMException('Discovery stopped','AbortError')
    const ids=group.files.map(f=>f.id)
    progress(`Series ${index+1}/${groups.length}: ${group.label}`)
    const runs=ids.map(id=>prepared.get(id))
    const issue=runs.filter(r=>r.error).map(r=>`${group.files.find(f=>f.id===r.id).filename}: ${r.error}`).join('; ')
    if(signal?.aborted)throw new DOMException('Discovery stopped','AbortError')
    const reference=[...group.files].filter(f=>f.hint.level).sort((a,b)=>a.hint.level.value-b.hint.level.value)[0]?.id||ids[0]
    const changes=compareRuns(runs,reference)
    // Keep all identified compounds available for review, including flat references.
    // Qualification controls calibration eligibility, not discovery visibility.
    const compounds=compoundSeries(changes)
    const targets=compounds.map(group=>({...group,key:group.identity,name:group.hit.common_name||group.hit.name}))
    const profile={...group.files[0].profile,response:'TIC',area_multiplier:String(runs[0].area_multiplier),integration:'endpoints'}
    for(const target of targets) {
      const assignment=responseAssignment(target.rows,group.files)
      let fullIdentity=null
      if(identifyCandidate){
        progress(`Series ${index+1}/${groups.length}: Full NIST identification of ${target.name}`)
        try{fullIdentity=await identifyCandidate(target,assignment,send)}catch(error){if(error.name==='AbortError')throw error;fullIdentity={error:error.message}}
      }
      const suggestedName=fullIdentity?.name||target.name
      const qualification=qualifySeries(reviewSeries(target.rows,{candidate:target.hit,files:group.files,selected_peaks:assignment.selected}),group.files)
      if(signal?.aborted)throw new DOMException('Discovery stopped','AbortError')
      const proposal={
        import_key:`${group.key}:${target.key}`,project_id:projectId,name:`${group.label}${group.start?` - ${group.start.replace('T',' ')}`:''}${suggestedName?` - ${suggestedName}`:''}`.slice(0,240),
        compound:suggestedName,mode:'external',unit:group.files.find(f=>f.hint.level)?.hint.level.unit||'ug/mL',
        profile,force_zero:false,
        rows:group.files.map(f=>({dataset_id:f.id,peak_id:'',concentration:f.hint.level?.value??'',
          is_peak_id:'',is_concentration:'',excluded:false,reason:'',quantity_confirmed:false})),
        discovery:{series:group.label,source:'filename, acquisition sequence and NIST suggestions',reference_dataset_id:reference,issue:[issue,fullIdentity?.error?`Full NIST naming needs retry: ${fullIdentity.error}`:''].filter(Boolean).join('; '),
          sequence:{day:group.day,start:group.start,end:group.end,warnings:group.warnings},
          preparations:runs.map(r=>r.preparation_id),candidate_count:runs.reduce((sum,r)=>sum+r.peaks.length,0),
          review_state:'pending',grouping_version:2,full_identity:fullIdentity,suggested_name:suggestedName,
          qualification,
          selected_peaks:assignment.selected,response_correlation:assignment.correlation,assignment_warning:assignment.warning,
          rt_warning:target.rt_warning?`RT shift: ${target.rt_min.toFixed(3)}-${target.rt_max.toFixed(3)} min. Series retained; review assignments.`:'',
          candidate:target.hit,target_rt:target.rt,files:group.files.map(f=>({id:f.id,filename:f.filename,hint:f.hint,grouping_warnings:f.grouping_warnings})),
          evidence:changes.filter(row=>target.hit&&row.hits[0]?.cas===target.hit.cas&&row.hits[0]?.name===target.hit.name).slice(0,500)
            .map(row=>({dataset_id:row.dataset_id,rt:row.rt_apex,state:row.state,increase:row.increase,reference:row.reference,hit:row.hits[0]||null}))},
      }
      const draft=await send('/calibration-library','POST',proposal)
      if(draft.created===false){await onExisting?.(draft,proposal);reused++}else created++
    }
  }
  return {created,reused,series:groups.length,runs:prepared.size,peaks:[...prepared.values()].reduce((sum,r)=>sum+r.peaks.length,0),
    failed:[...prepared.values()].filter(r=>r.error).length,
    searchFailed:[...prepared.values()].flatMap(r=>r.peaks).filter(p=>p.searchError).length}
}
