function identity(hit) {
  const cas = String(hit?.cas || '').replace(/[^0-9]/g, '')
  if (cas && !/^0+$/.test(cas)) return `cas:${cas}`
  const name = String(hit?.name || '').trim().toLowerCase()
  return name ? `name:${name}` : null
}

export function strongLibraryAgreement(referenceHits, candidateHits) {
  const a = referenceHits?.[0], b = candidateHits?.[0]
  if (![a?.match_score, b?.match_score, a?.reverse_score, b?.reverse_score].every(value => Number.isFinite(value) && value >= 900)) return null
  const key = identity(a)
  if (!key || key !== identity(b)) return null
  return {identity:key, name:a.common_name || a.name, referenceMatch:a.match_score,
    candidateMatch:b.match_score, referenceReverse:a.reverse_score, candidateReverse:b.reverse_score}
}

function strongLibraryConflict(referenceHits, candidateHits) {
  const a=referenceHits?.[0],b=candidateHits?.[0]
  return [a?.match_score,b?.match_score,a?.reverse_score,b?.reverse_score].every(value=>Number.isFinite(value)&&value>=900) &&
    Boolean(identity(a)&&identity(b)&&identity(a)!==identity(b))
}

export function peakBounds(peak) {
  return {left:peak.rt_left ?? peak.left, right:peak.rt_right ?? peak.right, rt:peak.rt_apex ?? peak.rt}
}

export function inCandidateRegion(peak, referenceRt, window) {
  const {left, right, rt} = peakBounds(peak)
  if (!Number.isFinite(rt) || !Number.isFinite(referenceRt)) return false
  if (Math.abs(rt - referenceRt) <= window) return true
  return [left, right].every(Number.isFinite) && right > left && rt >= left && rt <= right && left <= referenceRt + window && right >= referenceRt - window
}

export function withLibraryEvidence(check, referenceHits, candidateHits, peak, referenceRt, window) {
  const {left, right, rt} = peakBounds(peak)
  const agreement = strongLibraryAgreement(referenceHits, candidateHits)
  const fullRegion = Number.isFinite(left) && Number.isFinite(right) && right > left && peak.segment?.length >= 5
  return {...check, nistAgreement:agreement, nistConflict:strongLibraryConflict(referenceHits,candidateHits), fullRegion:Boolean(fullRegion),
    rtShift:Math.abs(rt-referenceRt), outsideRtWindow:Math.abs(rt-referenceRt)>window,
    withinCandidateRegion:inCandidateRegion(peak, referenceRt, window)}
}

export function librarySupportedMatch(check, threshold = .7) {
  return Boolean(check?.nistAgreement && check.fullRegion &&
    Number.isFinite(check.score) && check.score >= Math.max(.9, threshold) &&
    Number.isFinite(check.commonIons) && check.commonIons >= 5)
}

export function groupingWarning(check, threshold, shapeThreshold) {
  if (!librarySupportedMatch(check, threshold)) return ''
  const warnings=[]
  if(check.rtShift>1) warnings.push(`RT shift ${check.rtShift.toFixed(3)} min (>1 min)`)
  else if(check.outsideRtWindow) warnings.push(`RT shift ${check.rtShift.toFixed(3)} min`)
  if(!Number.isFinite(check.shapeScore)||check.shapeScore<shapeThreshold) warnings.push('Peak width/shape differs')
  return warnings.join('; ')
}

export function embeddedRipple(small, full) {
  const a = peakBounds(small), b = peakBounds(full)
  const smallArea = small.net_area ?? small.area, fullArea = full.net_area ?? full.area
  return [a.left,a.right,b.left,b.right,smallArea,fullArea].every(Number.isFinite) &&
    a.right > a.left && b.right > b.left && a.left >= b.left && a.right <= b.right &&
    a.right-a.left < (b.right-b.left)*.2 && smallArea >= 0 && fullArea > 0 && smallArea < fullArea*.05
}

export function preferFullRegions(candidates, threshold) {
  const supersededBy=(candidate,other)=>{
    if(other===candidate||!librarySupportedMatch(other.spectral,threshold)||candidate.spectral?.nistAgreement?.identity!==other.spectral.nistAgreement.identity||candidate.spectral.score<Math.max(.9,threshold))return false
    if(embeddedRipple(candidate.peak,other.peak))return true
    const a=peakBounds(candidate.peak),b=peakBounds(other.peak),width=other.spectral.referenceWidth
    const area=candidate.peak.net_area??candidate.peak.area,fullArea=other.peak.net_area??other.peak.area
    // Near-identical spectra cannot distinguish a small secondary region from
    // the main peak. Use reference-scale width and signal only within this file.
    return Number.isFinite(width)&&width>0&&a.right-a.left<width*.25&&b.right-b.left>=width*.5&&b.right-b.left<=width*4&&
      area>=0&&fullArea>0&&area<fullArea*.05&&Math.abs(candidate.spectral.score-other.spectral.score)<.02&&
      Number.isFinite(candidate.spectral.shapeScore)&&other.spectral.shapeScore>candidate.spectral.shapeScore+.15
  }
  return candidates.filter(candidate=>!candidates.some(other=>supersededBy(candidate,other))).map(candidate=>{
    const minorRegions=candidates.filter(other=>supersededBy(other,candidate)).map(other=>({...peakBounds(other.peak),area:other.peak.net_area??other.peak.area,score:other.spectral.score}))
    return minorRegions.length?{...candidate,spectral:{...candidate.spectral,minorRegions}}:candidate
  })
}

export function canReplaceMovedRipple(old, candidate, threshold) {
  return Boolean(old?.status==='Moved'&&candidate?.peak&&librarySupportedMatch(candidate.spectral,threshold)&&embeddedRipple(old,candidate.peak))
}

// Retire only untouched automatic candidates; archive their evidence on the full
// peak so replacing a ripple never discards the original measurement.
export function absorbAutomaticCandidates(rows, fileId, targetIds) {
  let result=rows.map(row=>({...row,cells:{...row.cells}}))
  for(const target of result.filter(row=>targetIds.includes(row.id))) {
    const full={...target.cells[fileId]}
    if(!librarySupportedMatch(full?.spectral,full?.spectral?.threshold))continue
    target.cells[fileId]=full
    for(const source of result) {
      if(source.id===target.id||source.kind!=='unassigned'||source.ignored||source.assignment||source.mergeHistory?.length)continue
      const cell=source.cells[fileId]
      if(!cell?.segment?.length||cell.matchDecision||cell.history?.length||cell.moveOrigin||cell.mergeEvidence||cell.status!=='Review')continue
      if(!strongLibraryAgreement(full.hits,cell.hits))continue
      const samePeak=Number.isFinite(cell.rt)&&Math.abs(cell.rt-full.rt)<.000001
      if(!samePeak&&!embeddedRipple(cell,full))continue
      full.absorbedCandidates=[...(full.absorbedCandidates||[]),{row:{...source,cells:undefined},fileId,cell}]
      delete source.cells[fileId]
    }
  }
  return result.filter(row=>rows.find(original=>original.id===row.id)?.kind!=='unassigned'||Object.keys(row.cells).length>0)
}
