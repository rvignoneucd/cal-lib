import { standardHint } from './standardHints.js'

export function addSeriesFile(draft, file, preparation=null) {
  const hint=standardHint(file.filename)
  const scales={'ng/mL':.001,'ug/mL':1,'mg/mL':1000}
  const concentration=hint.level?hint.level.value*scales[hint.level.unit]/scales[draft.unit]:''
  return {...draft,fit:null,rows:draft.rows.some(row=>row.dataset_id===file.id)?draft.rows:[...draft.rows,{
    dataset_id:file.id,peak_id:'',concentration,is_peak_id:'',is_concentration:'',excluded:false,reason:'',quantity_confirmed:false,
  }],discovery:{...draft.discovery,review_state:'pending',
    preparations:[...new Set([...(draft.discovery.preparations||[]),...(preparation?.preparation_id?[preparation.preparation_id]:[])])],
    files:draft.discovery.files.some(old=>old.id===file.id)?draft.discovery.files:[...draft.discovery.files,{id:file.id,filename:file.filename,hint,grouping_warnings:[]}]}}
}
