import {applySeriesReview} from './applySeriesReview.js'

export async function publishReviewedDraft(draft,{get,send}) {
  const saved=draft.discovery&&draft.mode==='external'
    ?await applySeriesReview(draft,{get,send,confirmCompound:true})
    :await send(`/calibration-library/${draft.id}`,'PUT',draft)
  if(!saved.fit)throw new Error(saved.fit_error||'A valid calibration fit is required')
  return send(`/calibration-library/${draft.id}/publish`,'POST',{revision:saved.revision,confirmed:true})
}
