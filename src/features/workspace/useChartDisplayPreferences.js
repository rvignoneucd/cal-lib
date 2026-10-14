import { useSyncExternalStore } from 'react'
import { chartDisplayPreferences } from './chartDisplayPreferences'

const listeners = new Set()
let preferences = Object.freeze({ grid: '', background: '', text: '' })
const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener) }
const snapshot = () => preferences

export function setChartDisplayPreferences(settings, theme) {
  const next = chartDisplayPreferences(settings, theme)
  if (next.grid === preferences.grid && next.background === preferences.background && next.text === preferences.text) return
  preferences = Object.freeze(next)
  listeners.forEach(listener => listener())
}

export function useChartDisplayPreferences() {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
