import {standardHint} from './standardHints.js'
import {qualifySeries,reviewSeries} from './compoundSeries.js'

export async function targetDraft(draft,runs,{targetRt,reference,seedId,files,selectedHit},send) {
  const candidate=selectedHit||(draft.compound?.trim()?{name:draft.compound.trim()}:null)||runs.find(run=>run.id===seedId)?.peaks?.[0]?.hits?.[0]
  if(!candidate?.name)throw new Error('Choose an analyte from the search results or enter its name')
  const preparations=[]
  for(const run of runs){
    const result=await send(`/calibration-library/preparations/${encodeURIComponent(draft.project_id)}`,'POST',run)
    preparations.push(result.preparation_id)
  }
  const series=files.map(file=>({...file,hint:standardHint(file.filename)}))
  const selected_peaks=Object.fromEntries(runs.filter(run=>run.peaks.length===1).map(run=>[run.id,run.peaks[0].rt_apex]))
  const profile={...draft.profile}
  for(const key of Object.keys(files[0]?.profile||{})){
    const values=[...new Set(files.map(file=>file.profile?.[key]).filter(value=>value!==undefined&&value!==''))]
    if(!profile[key]&&values.length===1)profile[key]=values[0]
  }
  const discovery={...draft.discovery,files:series,preparations,candidate,target_rt:targetRt,
    selected_file_ids:series.map(file=>file.id),
    selected_peaks,reference_dataset_id:reference,review_state:'pending',identity_source:selectedHit?'analyst':'nist'}
  discovery.qualification=qualifySeries(reviewSeries(runs.flatMap(run=>run.peaks.map(peak=>({...peak,dataset_id:run.id}))),discovery),series)
  return {...draft,fit:null,compound:candidate.common_name||candidate.name,
    profile:{...profile,area_multiplier:10,integration:'endpoints'},
    rows:series.map(file=>({dataset_id:file.id,peak_id:'',concentration:file.hint.level?.value??'',
      quantity_confirmed:false,is_peak_id:'',is_concentration:'',excluded:false,reason:''})),
    discovery}
}
