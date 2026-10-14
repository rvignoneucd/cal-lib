import {useState} from 'react'
import ActionNotice from './ActionNotice'
import {FileSpreadsheet} from 'lucide-react'
import {apiUrl} from '../apiBase'
import {authHeaders} from '../api/client'
import {downloadFile} from '../utils/exportFiles'

export function workbookCurves(data){
  if(data.origin==='manual')return data.curves.map(curve=>({
    name:curve.compound,unit:curve.unit,status:'Manual entry',response_label:data.response_type,notes:data.notes,
    rows:data.rows.filter(r=>r.compound.toLowerCase()===curve.compound.toLowerCase()&&r.unit===curve.unit&&r.wavelength===curve.wavelength)
      .map(r=>({...r,area:r.response,source:data.source})),
  }))
  const fit=data.fit||data.preview?.fit
  return [{name:data.compound||data.name,notes:data.notes,unit:data.fit&&data.mode==='internal'?'Concentration ratio':data.unit,
    status:data.fit?'Reviewed fit':'Provisional preview, not published',force_zero:fit?.force_zero===true,
    response_label:(data.fit&&data.mode==='internal')||data.preview?.normalized?'Area ratio':'Peak area',
    rows:(data.fit?.points||data.preview?.points||[]).filter(p=>!p.excluded).map(p=>({...p,rt:p.rt??data.fit?.evidence?.find(e=>e.dataset_id===p.dataset_id)?.analyte?.rt,source:p.dataset_name||p.filename||p.dataset_id||data.source||''})),
  }]
}

export default function ExcelCalibration({name,getData}){
  const [busy,setBusy]=useState(false),[error,setError]=useState('')
  async function download(){
    setBusy(true);setError('')
    try{
      const response=await fetch(apiUrl('/lab/workbook'),{method:'POST',headers:{...authHeaders(),'Content-Type':'application/json'},body:JSON.stringify({curves:workbookCurves(await getData())})})
      if(!response.ok)throw new Error((await response.json()).detail||'Export failed')
      downloadFile(await response.blob(),`${name.replace(/[<>:"/\\|?*]/g,'_')}.xlsx`)
    }catch(e){setError(e.message||'Excel export failed')}
    finally{setBusy(false)}
  }
  return <div className="cal-copy"><button type="button" className="icon-button" disabled={busy} title="Download Excel table and linked chart" aria-label={`Download ${name} workbook`} onClick={download}><FileSpreadsheet size={16}/></button>{error&&<ActionNotice error>{error}</ActionNotice>}</div>
}
