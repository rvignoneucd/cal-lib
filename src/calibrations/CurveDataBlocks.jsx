import {curvePreviewData} from './curvePreviewData'
const number = value => Number.isFinite(value) ? value.toLocaleString('en-US', {maximumFractionDigits:4}) : '-'
const scientific = value => Number.isFinite(value) ? value.toExponential(4) : '-'

export default function CurveDataBlocks({data,highlightedPoint=null,onHighlight}) {
  const {fit,points,average,rtCount}=curvePreviewData(data)
  if(!fit)return null
  return <div className="cal-preview-blocks">
    <section aria-label="Fit statistics"><dl className="cal-fit-stats"><dt>Slope</dt><dd>{scientific(fit.slope)}</dd><dt>Intercept</dt><dd>{scientific(fit.intercept)}</dd><dt title="Centered coefficient of determination">R<sup>2</sup></dt><dd>{number(fit.r2)}</dd></dl></section>
    <section aria-label="Calibration points"><div className="cal-table-wrap"><table><thead><tr><th>{data.mode==='internal'?'Concentration ratio':`Concentration (${data.unit})`}</th><th>{data.preview?.normalized||data.mode==='internal'?'Area ratio':data.response_type||'Peak area'}</th></tr></thead><tbody>{points.map((p,i)=><tr key={i} tabIndex={0} className={fit.points.indexOf(p)===highlightedPoint?'cal-point-highlight':undefined} onMouseEnter={()=>onHighlight?.(fit.points.indexOf(p))} onMouseLeave={()=>onHighlight?.(null)} onFocus={()=>onHighlight?.(fit.points.indexOf(p))} onBlur={()=>onHighlight?.(null)}><td>{number(p.concentration)}</td><td>{scientific(p.area)}</td></tr>)}</tbody></table></div><p>Average RT: {average===null?'-':`${average.toFixed(3)} min`}{rtCount>0&&rtCount<points.length?` (${rtCount}/${points.length} points)`:''}</p></section>
  </div>
}
