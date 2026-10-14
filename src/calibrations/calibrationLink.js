export function calibrationLink({id,instrument='GC-MS',manual=false,compound},base=window.location.href){
  const url=new URL(base)
  url.search='';url.hash=''
  url.searchParams.set('instrument',instrument)
  url.searchParams.set(manual?'manual':'calibration',id)
  if(manual&&compound)url.searchParams.set('compound',compound)
  return url.href
}
