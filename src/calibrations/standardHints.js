// Names are grouping hints only. Neither concentration nor compound identity is
// accepted as scientific data until the analyst confirms it.
export function standardHint(filename) {
  const name=String(filename||'').split(/[\\/]/).at(-1).replace(/\.d$/i,'')
  const levels=[...name.matchAll(/(?:^|[_\s])(\d+(?:\.\d+)?)\s*(ug|mg|ng)\s*(?:\/)?ml(?=$|[_\s])/gi)]
  const blank=/blank/i.test(name)
  const is=/\bIS\b/i.test(name.replaceAll('_',' '))
  const dateToken=name.match(/^(\d{6})(?:_|$)/)?.[1]||''
  const date=dateToken?`20${dateToken.slice(0,2)}-${dateToken.slice(2,4)}-${dateToken.slice(4,6)}`:''
  const level=levels.length===1?{value:Number(levels[0][1]),unit:`${levels[0][2].toLowerCase()}/mL`}:null
  let series=name.replace(/^\d{6,8}_+/,'').replace(/(?:^|[_\s])\d+(?:\.\d+)?\s*(?:ug|mg|ng)\s*\/?ml(?=$|[_\s])/gi,'_')
    .replace(/(?:^|_)IS(?=_|$)/gi,'_').replace(/(?:^|_)redo(?=_|$)/gi,'_').replace(/[_\s]+\d+$/,'')
    .replace(/[_\s]+/g,' ').trim()
  if(blank)series='Blanks'
  return {series:series||'Unclassified',date,key:`${series.toLowerCase()}|${is?'IS':'external'}|${level?.unit||''}`,
    level,blank,internalStandard:is,repeat:/_redo(?:_|$)/i.test(name)||/[_\s]\d+$/.test(name),
    warning:levels.length>1?'Multiple concentration tokens':/^\d{7}_/.test(name)?'Nonstandard date prefix':''}
}

export function concentrationOrder(a,b) {
  const value=file=>{
    const level=standardHint(file?.filename).level
    return level?level.value*({'ng/mL':.001,'ug/mL':1,'mg/mL':1000}[level.unit]):Infinity
  }
  const left=value(a),right=value(b)
  return left===right?0:left<right?-1:1
}

export function standardGroups(files) {
  const groups=[],lastByInstrument=new Map()
  const clock=file=>/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(file.acquired_at||'')?file.acquired_at:''
  const ordered=[...files].sort((a,b)=>(clock(a)||'~').localeCompare(clock(b)||'~')||a.filename.localeCompare(b.filename))
  for(const file of ordered) {
    const hint=standardHint(file.filename)
    // Unknown metadata is not silently equated to a known method/column.
    const acquisition=['instrument','method','column_model','column_phase','column_length_m','column_id_um','column_film_um','acquisition_mode']
      .map(key=>String(file.profile?.[key]||'').trim().toLowerCase()).join('|')
    const identity=`${hint.key}|${acquisition}|${file.profile?.method_signature||''}`
    const time=clock(file),day=time.slice(0,10),instrument=file.profile?.instrument||'unknown'
    const prior=lastByInstrument.get(instrument)
    const gap=prior&&time?(Date.parse(time+'Z')-Date.parse(prior.end+'Z'))/60000:Infinity
    // Timestamp ties and missing times cannot establish a consecutive sequence.
    // A conservative two-hour start-to-start limit flags idle/restarted batches.
    const methodKey=`${acquisition}|${file.profile?.method_signature||''}`
    const typo=prior&&likelySeriesTypo(prior.label,hint.series)&&prior.methodKey===methodKey&&
      !!file.profile?.method_signature&&!!hint.level&&prior.files.some(f=>f.hint.level)&&
      prior.files[0].hint.internalStandard===hint.internalStandard&&prior.files[0].hint.level?.unit===hint.level.unit
    const continuous=time&&prior&&(prior.identity===identity||typo)&&gap>0&&gap<=120
    let group=continuous?prior:null
    if(!group) {
      const warnings=[]
      if(!time)warnings.push('Acquisition time unavailable; sequence needs review')
      if(prior&&gap>120&&day===prior.day)warnings.push('Long gap; new sequence')
      group={key:`${identity}|${day||'unknown'}|${time}|${file.id||file.filename}`,identity,
        label:hint.series,methodKey,day,start:time,end:time,files:[],blank:hint.blank,warnings}
      groups.push(group)
    }
    if(time&&hint.date&&hint.date!==day&&!group.warnings.includes('Filename date differs from acquisition date'))group.warnings.push('Filename date differs from acquisition date')
    const fileWarnings=[]
    if(continuous&&typo){fileWarnings.push(`Likely filename typo: ${hint.series} grouped with ${group.label}`)}
    if(continuous&&prior.end.slice(0,10)!==day)fileWarnings.push('Continuous acquisition crosses midnight; series retained')
    if(time&&hint.date&&hint.date!==day)fileWarnings.push('Filename date differs from acquisition date')
    if(hint.warning)fileWarnings.push(hint.warning)
    for(const warning of fileWarnings)if(!group.warnings.includes(warning))group.warnings.push(warning)
    group.end=time
    group.files.push({...file,hint,grouping_warnings:fileWarnings})
    if(instrument==='unknown')lastByInstrument.clear()
    lastByInstrument.set(instrument,group)
  }
  return groups
}

export function likelySeriesTypo(a,b) {
  a=a.toLowerCase();b=b.toLowerCase()
  if(a===b||Math.min(a.length,b.length)<8||/\d|\+/.test(a+b)||Math.abs(a.length-b.length)>2)return false
  let row=Array.from({length:b.length+1},(_,i)=>i)
  for(let i=1;i<=a.length;i++){const next=[i];for(let j=1;j<=b.length;j++)next[j]=Math.min(next[j-1]+1,row[j]+1,row[j-1]+(a[i-1]===b[j-1]?0:1));row=next}
  return row[b.length]<=2
}
