const fields=['name','compound','unit','mode','profile','column_id','force_zero','force_zero_manual','rows','discovery']
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b)

export function reconcileDraft(local,base,remote) {
  const merged={...remote}
  for(const key of fields){
    if(equal(local[key],base[key]))continue
    if(!equal(remote[key],base[key])&&!equal(remote[key],local[key]))
      throw new Error(`Draft changed in ${key}. Your unsaved edits are preserved; automatic overwrite was stopped.`)
    merged[key]=local[key]
  }
  return merged
}

export async function saveDraft(local,base,{get,send,onSaved}) {
  let payload=local
  if(local.id){
    const remote=await get(`/calibration-library/${local.id}`)
    if(remote.revision!==local.revision)payload=reconcileDraft(local,base,remote)
  }
  const saved=await send(local.id?`/calibration-library/${local.id}`:'/calibration-library',local.id?'PUT':'POST',payload)
  // Accept the committed revision before optional preview work can fail.
  onSaved(saved)
  return saved
}
