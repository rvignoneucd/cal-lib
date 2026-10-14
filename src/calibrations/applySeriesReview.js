import { reviewSeries } from './compoundSeries.js'
import { reviewedAnnotation } from './preparation.js'
import { savedArea } from './savedArea.js'

export async function applySeriesReview(draft, {get,send,confirmCompound=false}) {
  if(draft.mode!=='external')throw new Error('For the displayed area-versus-concentration curve, select External. Internal-standard calibration requires a separate reference peak and concentration.')
  const runs=await Promise.all(draft.discovery.preparations.map(id=>get(`/calibration-library/preparations/${encodeURIComponent(draft.project_id)}/${encodeURIComponent(id)}`)))
  const {areas}=await get(`/lab/areas/${draft.id}`)
  const candidates=reviewSeries(runs.flatMap(run=>run.peaks.map(peak=>({...peak,dataset_id:run.id}))),draft.discovery)
  const reviewed=new Map()
  for(const row of draft.rows.filter(row=>!row.excluded&&row.peak_id)){
    const data=await get(`/datasets/${encodeURIComponent(row.dataset_id)}/annotations`)
    const peak=(data.stored_peaks||data.peaks||[]).find(peak=>peak.annotationId===row.peak_id)
    const review=peak?.calibration_preparation
    if(peak?.compound?.trim().toLowerCase()===draft.compound.trim().toLowerCase()&&(review?.match_confirmed||review?.identity_confirmed)&&
      (review.area_drawn||review.area_confirmed))reviewed.set(row.dataset_id,peak)
  }
  // Validate the entire selection before creating any reviewed annotations.
  const planned=draft.rows.map(row=>{
    if(row.excluded){if(!row.reason?.trim())throw new Error('Enter a reason for each excluded injection');return {row}}
    const prior=reviewed.get(row.dataset_id)
    if(prior&&!areas.some(area=>area.dataset_id===row.dataset_id&&Date.parse(area.updated_at)>Date.parse(prior.calibration_preparation.reviewed_at)))return {row:{...row,quantity_confirmed:true}}
    const file=draft.discovery.files.find(file=>file.id===row.dataset_id)
    const matches=candidates.filter(peak=>peak.dataset_id===row.dataset_id)
    const expectedRt=draft.discovery.selected_peaks?.[row.dataset_id]??draft.discovery.target_rt
    const manual=savedArea(areas,row.dataset_id,expectedRt)
    // A loaded source file is not a calibration point until it has an area.
    // Never discard an existing assignment or a manual area at another RT.
    if(confirmCompound&&!matches.length&&!row.peak_id&&!areas.some(area=>area.dataset_id===row.dataset_id))
      return {row:{...row,excluded:true,reason:'Source file only; no assigned or measured calibration point'}}
    if(matches.length!==1&&!(confirmCompound&&manual))throw new Error(`${file?.filename||row.dataset_id}: no unique compound/RT match. Exclude this injection with a reason or review its peak.`)
    const candidate=matches[0]||{rt_apex:expectedRt,hits:[]},hit=candidate.hits[0]
    if(!confirmCompound&&(hit?.common_name||hit?.name||'').toLowerCase()!==draft.compound.trim().toLowerCase())throw new Error('Selected NIST identity differs from the calibration compound')
    const correction=savedArea(areas,row.dataset_id,candidate.rt_apex)
    const measurement=correction?.measurement||{...candidate,left:candidate.rt_left,right:candidate.rt_right,apex_x:candidate.rt_apex}
    const peak=reviewedAnnotation({candidate,hit,manualCompound:confirmCompound?draft.compound:undefined,measurement,quantity:row.concentration,unit:draft.unit,basis:'added',role:'analyte',referenceId:draft.discovery.reference_dataset_id,areaMultiplier:Number(draft.profile.area_multiplier),areaDrawn:!!correction,areaConfirmed:true})
    // Stable per-draft keys make retries safe without overwriting another curve's review.
    peak.annotationId=`cal-series-${draft.id}-${row.dataset_id}`
    return {row,peak}
  })
  for(const {row,peak} of planned){
    if(!peak)continue
    const path=`/datasets/${encodeURIComponent(row.dataset_id)}/annotations`
    const data=await get(path),original=data.stored_peaks||data.peaks||[]
    await send(path,'PUT',{expected_peaks:original,peaks:[...original.filter(p=>p.annotationId!==peak.annotationId),peak]})
  }
  return send(`/calibration-library/${draft.id}`,'PUT',{...draft,rows:planned.map(({row,peak})=>peak?{...row,peak_id:peak.annotationId,quantity_confirmed:true}:row)})
}
