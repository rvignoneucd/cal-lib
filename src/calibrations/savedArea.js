export function savedArea(areas,id,rt) {
  const exact=areas.find(a=>a.dataset_id===id&&Math.abs(a.candidate_rt-rt)<.000001)
  if(exact)return exact
  const covering=areas.filter(a=>a.dataset_id===id&&a.measurement.left<=rt&&a.measurement.right>=rt)
  return covering.length===1?covering[0]:undefined
}
