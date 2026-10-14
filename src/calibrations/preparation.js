import { strongLibraryAgreement } from '../features/batch/batchEvidence.js'

export const DETECTION = Object.freeze({trace:'TIC',prominence_pct:0.5,height_pct:0,
  min_separation_s:1,snr_threshold:0,prominence_reference:'max',
  prominence_noise_mult:0,boundary_mode:'valley',max_peaks:500,area_multiplier:1})

const path = id => `/datasets/${encodeURIComponent(id)}`
const stopped = signal => {if(signal?.aborted)throw new DOMException('Preparation stopped','AbortError')}
const pause = signal => new Promise((resolve,reject)=>{
  stopped(signal)
  const abort=()=>{clearTimeout(timer);reject(new DOMException('Preparation stopped','AbortError'))}
  const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve()},1000)
  signal?.addEventListener('abort',abort,{once:true})
})

// Conversion must finish successfully before any spectrum is searched. All
// detection areas are provisional and never written as saved annotations.
export async function convertRuns(ids, {get,send,signal,progress=()=>{},sleep=pause,onConverted}) {
  const selected=[...new Set(ids)]
  if(!selected.length)throw new Error('Select at least one run')
  progress('Converting selected runs')
  stopped(signal)
  let {job}=await send('/datasets/precompute-acg-ams','POST',{dataset_ids:selected})
  if(!job?.id)throw new Error('Conversion did not return a job')
  while(!['complete','error','cancelled'].includes(job.state)) {
    await sleep(signal);stopped(signal)
    const result=await get(`/jobs/${encodeURIComponent(job.id)}`)
    job=result.job||result
    progress(`Converting: ${job.current || job.state}`)
  }
  stopped(signal)
  if(job.state!=='complete'||job.errors?.length)throw new Error('Conversion needs attention. Resolve failed runs before NIST detection.'+(job.errors?.length?' '+job.errors.map(e=>typeof e==='string'?e:e.error||'Conversion failed').join('; '):''))
  await onConverted?.(selected)
  stopped(signal)
}

export async function prepareRuns(ids, {get,send,signal,progress=()=>{},sleep=pause,onConverted,onRun,converted=false,areaMultiplier=1,targetRt,targetTolerance=.1}) {
  const selected=[...new Set(ids)]
  if(!selected.length)throw new Error('Select at least one run')
  if(!converted)await convertRuns(selected,{get,send,signal,progress,sleep,onConverted})
  if(!Number.isFinite(areaMultiplier)||areaMultiplier<=0)throw new Error('Invalid area multiplier')
  const runs=[]
  for(const [index,id] of selected.entries()) {
    stopped(signal);progress(`Detecting peaks ${index+1}/${selected.length}`)
    const detection=await send(`${path(id)}/auto-peaks`,'POST',{...DETECTION,area_multiplier:areaMultiplier})
    let peaks=(detection.peaks||[]).filter(p=>Number.isFinite(p.rt_apex))
    if(Number.isFinite(targetRt)){
      peaks=peaks.filter(p=>Math.abs(p.rt_apex-targetRt)<=targetTolerance)
      if(peaks.length!==1){runs.push({id,area_multiplier:areaMultiplier,integration:'endpoints',peaks:[],error:peaks.length?'Multiple peaks in target window; narrow the RT tolerance':'No peak in target window'});continue}
    }
    const matches=[]
    for(let start=0;start<peaks.length;start+=12) {
      stopped(signal);progress(`NIST ${index+1}/${selected.length}: ${Math.min(start+12,peaks.length)}/${peaks.length} peaks`)
      const rts=peaks.slice(start,start+12).map(p=>p.rt_apex)
      try {
        const result=await send(`${path(id)}/library/search-batch`,'POST',{rts,full_search:true,top_n:5,min_score:0,enrich_pubchem:false})
        matches.push(...(result.results||[]))
      } catch(error) {
        if(error.name==='AbortError')throw error
        matches.push(...rts.map(rt=>({rt,hits:[],error:error.message})))
      }
    }
    stopped(signal)
    const run={id,area_multiplier:areaMultiplier,integration:'endpoints',detection_settings:{...DETECTION,area_multiplier:areaMultiplier},
      limit_reached:peaks.length>=DETECTION.max_peaks,peaks:peaks.map((peak,i)=>{
      const match=matches.find(m=>Math.abs(m.rt-peak.rt_apex)<0.0001)
      return {...peak,key:`${id}:${i}`,hits:match?.hits||[],searchError:match?.error||(!match?'No NIST response':''),engine:match?.engine}
    })}
    await onRun?.(run)
    runs.push(run)
  }
  return runs
}

export function compareRuns(runs, referenceId, {window=0.1,minIncrease=20}={}) {
  if(!Number.isFinite(window)||window<0||!Number.isFinite(minIncrease)||minIncrease<0)return []
  const reference=runs.find(run=>run.id===referenceId)
  return runs.flatMap(run=>run.peaks.map(peak=>{
    const row={...peak,dataset_id:run.id,increase:null,reference:null,state:'Unpaired candidate'}
    if(run.id===referenceId)return {...row,state:'Reference'}
    if(!reference||reference.error||run.error)return row
    const nearby=reference.peaks.filter(ref=>Math.abs(ref.rt_apex-peak.rt_apex)<=window)
    const compatible=nearby.filter(ref=>strongLibraryAgreement(ref.hits,peak.hits))
    if(!nearby.length&&strongLibraryAgreement(peak.hits,peak.hits)&&peak.net_area>0)
      return {...row,state:'Emerging signal',reference:{detected:false}}
    if(compatible.length!==1)return {...row,state:compatible.length?'Ambiguous reference':'Unpaired candidate'}
    const ref=compatible[0]
    // Do not let two resolved or coeluting regions both claim one reference.
    const competing=run.peaks.filter(other=>Math.abs(other.rt_apex-ref.rt_apex)<=window&&strongLibraryAgreement(ref.hits,other.hits))
    if(competing.length!==1)return {...row,state:'Ambiguous reference'}
    if(ref.net_area===0&&peak.net_area>0)return {...row,state:'Emerging signal',reference:{detected:true,rt:ref.rt_apex,area:0}}
    if(!(ref.net_area>0)||!(peak.net_area>=0))return {...row,state:'Area unavailable'}
    const increase=100*(peak.net_area/ref.net_area-1)
    if(!Number.isFinite(increase))return {...row,state:'Area unavailable'}
    return {...row,increase,reference:{rt:ref.rt_apex,area:ref.net_area},state:increase>=minIncrease?'Increased signal':'No increase'}
  })).sort((a,b)=>Number(['Increased signal','Emerging signal'].includes(b.state))-Number(['Increased signal','Emerging signal'].includes(a.state))||(b.increase??-Infinity)-(a.increase??-Infinity)||a.rt_apex-b.rt_apex)
}

export function reviewedAnnotation({candidate,hit,manualCompound,measurement,quantity,unit,basis,role,referenceId,areaMultiplier,areaDrawn=true,areaConfirmed=false}) {
  if(!hit?.name&&!manualCompound?.trim())throw new Error('Confirm a compound identity')
  if(quantity===''||!Number.isFinite(Number(quantity))||Number(quantity)<0)throw new Error('Enter the known quantity')
  if(!measurement||!(measurement.net_area>0)||!(measurement.right>measurement.left))throw new Error('Draw a positive area first')
  if(!areaDrawn&&!areaConfirmed)throw new Error('Verify the proposed area first')
  return {
    annotationId:`cal-review-${crypto.randomUUID()}`,kind:'Measure',trace:'TIC',compound:manualCompound?.trim()||hit.common_name||hit.name,
    library_match:manualCompound?null:hit,manual_assignment:true,include:true,rt_apex:measurement.apex_x,rt_left:measurement.left,rt_right:measurement.right,
    rt:String(measurement.apex_x),area:String(measurement.net_area),area_value:measurement.net_area,net_area:measurement.net_area,
    height_value:measurement.apex_y,peak_height:measurement.peak_height,segment:measurement.segment,
    manual_baseline:[{x:measurement.left,y:measurement.y_left},{x:measurement.right,y:measurement.y_right}],
    calibration_preparation:{reviewed_at:new Date().toISOString(),candidate_rt:candidate.rt_apex,
      nist_hit:hit,engine:candidate.engine||'',quantity:Number(quantity),unit,basis,role,
      reference_dataset_id:referenceId||null,area_multiplier:areaMultiplier,integration:'endpoints',
      match_confirmed:!manualCompound,identity_confirmed:!!manualCompound,identity_source:manualCompound?'analyst':'NIST',area_drawn:areaDrawn,area_confirmed:areaConfirmed},
  }
}
