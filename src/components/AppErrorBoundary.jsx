import { Component } from 'react'
import { recordBrowserDiagnostic } from '../utils/browserDiagnostics'

export function recordAppError(error, source = 'render', componentStack = '') {
  const detail = {
    at: new Date().toISOString(), source,
    message: String(error?.message || error || 'Unknown error').slice(0, 2000),
    stack: String(error?.stack || '').slice(0, 6000),
    componentStack: String(componentStack).slice(0, 4000),
  }
  console.error('[Atmos recovery]', detail)
  recordBrowserDiagnostic('app-error', {source, message: detail.message, stack: detail.stack})
  try { sessionStorage.setItem('atmos.lastAppError', JSON.stringify(detail)) } catch { /* Storage may be unavailable. */ }
}

export default class AppErrorBoundary extends Component {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error, info) { recordAppError(error, 'render', info.componentStack) }
  render() {
    if (!this.state.failed) return this.props.children
    return <main role="alert" style={{ position: 'fixed', inset: 0, zIndex: 100000, background: '#f8fafc', color: '#0f172a', display: 'grid', placeContent: 'center', padding: 24 }}>
      <h1 style={{ fontSize: 24 }}>Atmos could not display this workspace</h1>
      <p>Reload to reopen your saved project. Unsaved changes may be lost.</p>
      <button type="button" onClick={() => window.location.reload()}>Reload Atmos</button>
    </main>
  }
}
