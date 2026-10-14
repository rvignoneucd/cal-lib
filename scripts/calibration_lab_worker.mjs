import { discoverStandards } from '../src/calibrations/discoverStandards.js'
import { mergeDiscovery } from '../src/calibrations/labDiscovery.js'
import { fullCandidateName } from '../src/calibrations/fullCandidateName.js'

const base = process.env.CAL_API || 'http://127.0.0.1:8787/api'
const emit = event => console.log(JSON.stringify(event))
async function request(path, method='GET', body) {
  const response = await fetch(base+path, {method, headers:{'Content-Type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)}), signal:AbortSignal.timeout(900000)})
  const data = await response.json()
  if(!response.ok)throw new Error(typeof data.detail==='string'?data.detail:JSON.stringify(data.detail))
  return data
}
try {
  const {ids}=await request('/lab/current-runs')
  const {files}=await request('/calibration-library/sources/cal-test')
  const {columns}=await request('/calibration-library/columns')
  const sameColumn=(profile,column)=>['column_model','column_phase','column_length_m','column_id_um','column_film_um'].every(key=>
    key.endsWith('_m')||key.endsWith('_um')?Number(profile[key])===Number(column[key]):String(profile[key]||'').toLowerCase()===column[key].toLowerCase())
  const result=await discoverStandards('cal-test',files.filter(f=>ids.includes(f.id)),{
    identifyCandidate:fullCandidateName,
    get:path=>request(path),send:(path,method,body)=>{
      if(path==='/calibration-library'&&method==='POST') {
        const matches=columns.filter(c=>c.active&&sameColumn(body.profile,c))
        if(matches.length===1)body={...body,column_id:matches[0].id}
      }
      return request(path,method,body)
    },
    progress:progress=>emit({progress}),onGrouped:groups=>emit({sequences:groups.map(({files,...g})=>({...g,runs:files.length}))}),
    onExisting:async(draft,proposal)=>{
      const merged=mergeDiscovery(draft,proposal)
      if(merged)await request(`/calibration-library/${draft.id}`,'PUT',merged)
    },
  })
  emit({result,progress:'Drafts ready for review'})
} catch(error) {emit({error:error.message});process.exitCode=1}
