import { forwardRef, lazy, Suspense } from 'react'

const PlotlyPlot = lazy(() => import('../PlotlyPlot'))

const LazyPlotlyPlot = forwardRef(function LazyPlotlyPlot(props, ref) {
  const className = ['plotly-loading', props.className].filter(Boolean).join(' ')
  const style = props.style || { width: '100%', height: '100%' }

  return (
    <Suspense
      fallback={(
        <div className={className} style={style}>
          <span>Loading plot...</span>
        </div>
      )}
    >
      <PlotlyPlot ref={ref} {...props} />
    </Suspense>
  )
})

export default LazyPlotlyPlot
