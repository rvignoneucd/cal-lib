export function curvePreviewData(data) {
  const fit=data?.fit||data?.preview?.fit
  const points=[...(fit?.points||[])].filter(p=>!p.excluded).sort((a,b)=>a.concentration-b.concentration)
  const times=points.map(p=>Number.isFinite(p.rt)?p.rt:fit?.evidence?.find(e=>e.dataset_id===p.dataset_id)?.analyte?.rt).filter(Number.isFinite)
  return {fit,points,rtCount:times.length,average:times.length?times.reduce((a,b)=>a+b,0)/times.length:null}
}
