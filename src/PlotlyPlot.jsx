import { forwardRef, useMemo } from 'react'
import createPlotlyComponentModule from 'react-plotly.js/factory'
import Plotly from './plotlyRuntime'
import { applyChartDisplayPreferences, applyChartTextPreferences } from './features/workspace/chartDisplayPreferences'
import { useChartDisplayPreferences } from './features/workspace/useChartDisplayPreferences'
import { matchBaselineGuideGrid } from './features/workspace/baselineGuide'

const createPlotlyComponent = createPlotlyComponentModule.default || createPlotlyComponentModule
const PlotlyComponent = createPlotlyComponent(Plotly)

const PlotlyPlot = forwardRef(function PlotlyPlot({ useDisplayPreferences = true, ...props }, ref) {
  const preferences = useChartDisplayPreferences()
  const layout = useMemo(() => useDisplayPreferences ? applyChartDisplayPreferences(props.layout, preferences) : props.layout, [props.layout, preferences, useDisplayPreferences])
  const data = useMemo(() => matchBaselineGuideGrid(useDisplayPreferences ? applyChartTextPreferences(props.data, preferences) : props.data, layout), [props.data, preferences, layout, useDisplayPreferences])
  return <PlotlyComponent ref={ref} {...props} layout={layout} data={data} />
})

export default PlotlyPlot
