import {concentrationOrder} from './standardHints.js'
const identity=hit=>hit?.cas?`cas:${hit.cas}`:`name:${String(hit?.common_name||hit?.name||'').trim().toLowerCase()}`

// Acquisition grouping happens first. RT drift is evidence, not a new curve.
export function compoundSeries(rows,tolerance=0.1) {
  const groups=[]
  for(const row of [...rows].sort((a,b)=>a.rt_apex-b.rt_apex)) {
    const hit=row.hits?.[0]
    if(!hit?.name||!Number.isFinite(row.rt_apex))continue
    const key=identity(hit)
    let group=groups.find(g=>g.identity===key)
    if(!group){group={identity:key,rt:row.rt_apex,hit,rows:[]};groups.push(group)}
    group.rows.push(row)
  }
  return groups.map(group=>({...group,rt_min:Math.min(...group.rows.map(r=>r.rt_apex)),rt_max:Math.max(...group.rows.map(r=>r.rt_apex)),
    rt_warning:Math.max(...group.rows.map(r=>r.rt_apex))-Math.min(...group.rows.map(r=>r.rt_apex))>tolerance}))
}

export function reviewSeries(rows,discovery,tolerance=0.1) {
  if(!discovery?.candidate)return rows
  const key=identity(discovery.candidate)
  const order=new Map([...(discovery.files||[])].sort(concentrationOrder).map((file,i)=>[file.id,i]))
  const selected=discovery.selected_peaks
  return rows.filter(row=>order.has(row.dataset_id)&&(selected?.[row.dataset_id]!=null?Math.abs(row.rt_apex-selected[row.dataset_id])<0.000001:identity(row.hits?.[0])===key))
    .map(row=>selected?.[row.dataset_id]!=null?{...row,state:identity(row.hits?.[0])===key?'Assigned target':'Assigned target - NIST differs'}:row)
    .sort((a,b)=>(order.get(a.dataset_id)??Infinity)-(order.get(b.dataset_id)??Infinity)||a.rt_apex-b.rt_apex)
}

// Inspection-only placeholders must never enter qualification or curve fitting.
export function inspectionSeries(rows,discovery,files,tolerance=0.1) {
  const matched=reviewSeries(rows,discovery,tolerance)
  if(!discovery?.candidate)return matched
  const target=Number.isFinite(discovery.target_rt)?discovery.target_rt:matched[0]?.rt_apex
  return [...files].sort(concentrationOrder).flatMap(file=>{
    const found=matched.filter(row=>row.dataset_id===file.id)
    if(found.length)return found
    return [{key:`${file.id}:unmatched`,dataset_id:file.id,rt_apex:target,
      inspection_only:true,hits:[],net_area:null,increase:null,reference:null,
      state:'Draw area',searchError:''}]
  })
}

export function responseAssignment(rows,files) {
  const byRun=new Map(files.map(file=>[file.id,rows.filter(row=>row.dataset_id===file.id)]))
  const alternatives=[...byRun.values()].sort((a,b)=>b.length-a.length)[0]||[]
  const score=chosen=>{
    const points=chosen.flatMap(row=>{const x=files.find(f=>f.id===row.dataset_id)?.hint?.level?.value;return Number.isFinite(x)&&row.net_area>0?[[x,row.net_area]]:[]})
    if(new Set(points.map(p=>p[0])).size<3)return {r:null,score:0}
    const mx=points.reduce((s,p)=>s+p[0],0)/points.length,my=points.reduce((s,p)=>s+p[1],0)/points.length
    const xx=points.reduce((s,p)=>s+(p[0]-mx)**2,0),yy=points.reduce((s,p)=>s+(p[1]-my)**2,0)
    const r=xx&&yy?points.reduce((s,p)=>s+(p[0]-mx)*(p[1]-my),0)/Math.sqrt(xx*yy):0
    const fold=Math.max(...points.map(p=>p[1]))/Math.min(...points.map(p=>p[1]))
    return {r,score:r>=.8&&fold>=1.5?r*Math.log(fold):0}
  }
  const hypotheses=alternatives.map(anchor=>{
    const chosen=[...byRun.values()].filter(group=>group.length).map(group=>[...group].sort((a,b)=>Math.abs(a.rt_apex-anchor.rt_apex)-Math.abs(b.rt_apex-anchor.rt_apex))[0])
    return {chosen,...score(chosen)}
  }).sort((a,b)=>b.score-a.score)
  const conflict=alternatives.length>1,best=hypotheses[0]
  const resolved=!conflict||(best?.score>0&&best.score-(hypotheses[1]?.score||0)>.2)
  return {selected:resolved&&best?Object.fromEntries(best.chosen.map(row=>[row.dataset_id,row.rt_apex])):null,
    correlation:best?.r??null,
    warning:conflict?(resolved?'Multiple same-name peaks: assignment follows the strongest concentration response; confirm the proposed peaks.':'Multiple same-name peaks: concentration response does not resolve the assignment. Review within this series.'):
      best?.r!=null&&best.r<.8?'Peak response does not consistently follow filename concentration; review the series.':''}
}

export function qualifySeries(rows,files) {
  const valid=rows.filter(row=>row.net_area>0&&!row.integration_error)
  const ids=new Set(valid.map(row=>row.dataset_id))
  const levels=new Set(files.filter(file=>ids.has(file.id)).map(file=>file.hint?.level?.value).filter(Number.isFinite))
  const response=responseAssignment(valid,files)
  const areas=valid.map(row=>row.net_area),fold=areas.length?Math.max(...areas)/Math.min(...areas):0
  const reason=ids.size<3||levels.size<3?'Requires matching peaks in at least 3 runs at 3 concentration levels':
    !response.selected?'Peak assignment is ambiguous':
    response.correlation<.8||response.correlation==null||fold<1.5?'Insufficient concentration-dependent response':''
  return {qualified:!reason,reason,runs:ids.size,levels:levels.size,correlation:response.correlation,fold}
}
