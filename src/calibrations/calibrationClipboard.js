const text=value=>{
  const s=String(value??'').replace(/[\t\r\n]+/g,' ')
  return /^[\s]*[=+\-@]/.test(s)?`'${s}`:s
}
const number=value=>typeof value==='number'&&Number.isFinite(value)?String(value):''
const mean=points=>{const values=points.map(p=>p.rt).filter(v=>typeof v==='number'&&Number.isFinite(v));return values.length?values.reduce((a,b)=>a+b,0)/values.length:null}
const cas=value=>{const s=String(value||'').replace(/\D/g,'');return s.length>=5?`${s.slice(0,-3)}-${s.slice(-3,-1)}-${s.slice(-1)}`:''}

// Column order follows Flavorant_Table_Links_RT_ExtCals.xlsx; no header row.
export function calibrationClipboardRow(draft){
  const fit=draft.fit
  const points=fit?.points||draft.preview?.points||[]
  const common=[text(draft.compound),text(cas(fit?.cas||draft.cas)),text(draft.flavor_profile),number(mean(points))]
  if(draft.mode==='internal')return [...common,number(draft.internal_cal_factor)].join('\t')
  return [...common,number(fit?.slope),number(fit?.intercept),text(draft.proxy)].join('\t')
}

export function calibrationClipboardTable(draft){
  const fit=draft.fit||draft.preview?.fit
  const points=(draft.fit?.points||draft.preview?.points||[]).filter(p=>!p.excluded&&!draft.rows?.find(r=>r.dataset_id===p.dataset_id)?.excluded)
    .map(p=>({...p,rt:p.rt??draft.fit?.evidence?.find(e=>e.dataset_id===p.dataset_id)?.analyte?.rt})).sort((a,b)=>a.concentration-b.concentration)
  const ratio=!!draft.preview?.normalized||(!!draft.fit&&draft.mode==='internal')
  return [
    ['', 'RT (min)', ''],
    [text(draft.compound),number(mean(points)),'',draft.fit?'Reviewed fit':'Provisional preview, not published'],
    ['', '', ''],
    ['',text(`Concentration (${draft.fit&&draft.mode==='internal'?'ratio':draft.unit||'ug/mL'})`),ratio?'Area ratio':'Peak Area'],
    ...points.map(p=>['',number(p.concentration),number(p.area??p.response)]),
    ['', '', ''],
    ['', 'Slope',number(fit?.slope)],
  ].map(row=>row.join('\t')).join('\r\n')
}

export function manualClipboardRows(entry){
  return entry.curves.map(curve=>{
    const points=entry.rows.filter(r=>r.compound.toLowerCase()===curve.compound.toLowerCase()&&r.unit===curve.unit&&r.wavelength===curve.wavelength)
    return calibrationClipboardTable({compound:curve.compound,unit:curve.unit,mode:'external',fit:curve.fit?{...curve.fit,points}:null,preview:{points}})
  }).join('\r\n\r\n')
}
