import { apiUrl } from '../apiBase'
import { apiErrorMessage } from './errorMessage'
import { fetchRecoveringCache } from './cacheRecovery'
export { apiErrorMessage } from './errorMessage'

export const TOKEN_STORAGE_KEY = `atmos.auth.token${import.meta.env.BASE_URL === '/' ? '' : import.meta.env.BASE_URL}`

let authToken = typeof localStorage !== 'undefined' ? localStorage.getItem(TOKEN_STORAGE_KEY) : null
const authListeners = new Set()
const apiInflightGets = new Map()
let workspaceGeneration = null
let workspaceGenerationToken = null

export function acceptWorkspaceGeneration(generation) {
  if (Number.isInteger(generation)) {
    workspaceGeneration = generation
    workspaceGenerationToken = authToken
  }
}

async function ensureWorkspaceGeneration() {
  if (!authToken || workspaceGenerationToken === authToken) return
  const token = authToken
  const state = await apiGet('/workspace-cloud')
  if (token !== authToken) throw new Error('Account changed before saving')
  acceptWorkspaceGeneration(state.generation)
}

async function checkWorkspaceGeneration(response) {
  if (response.status !== 409) return
  const error = await response.clone().json().catch(() => null)
  if (error?.detail?.code === 'workspace_restored') {
    window.dispatchEvent(new Event('atmos:workspace-restored'))
    throw new Error(error.detail.message)
  }
}
const apiPerfNow = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now())

export function getAuthToken() {
  return authToken
}

export function setAuthToken(token) {
  authToken = token || null
  if (typeof localStorage !== 'undefined') {
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token)
    else localStorage.removeItem(TOKEN_STORAGE_KEY)
  }
}

export function addAuthListener(listener) {
  authListeners.add(listener)
  return () => authListeners.delete(listener)
}

export function authHeaders() {
  return authToken ? { Authorization: `Bearer ${authToken}`,
    'X-Atmos-Workspace-Generation': String(workspaceGenerationToken === authToken ? workspaceGeneration ?? 0 : 0) } : {}
}

function logApiTiming(method, path, started, response = null) {
  const elapsed = Math.round(apiPerfNow() - started)
  const serverMs = response?.headers?.get?.('X-ATMOS-Process-Time-Ms')
  const slow = elapsed >= 500
  const debug = typeof localStorage !== 'undefined' && localStorage.getItem('atmos.debugApiTiming.v1') === '1'
  if (!slow && !debug) return
  // eslint-disable-next-line no-console
  console.info(`[ATMOS api] ${method} ${path} ${elapsed}ms${serverMs ? ` server=${serverMs}ms` : ''}`)
}

export function notifyUnauthorized() {
  for (const listener of authListeners) listener()
}

function handleUnauthorized() {
  setAuthToken(null)
  notifyUnauthorized()
  throw new Error('Unauthorized')
}

export async function apiGet(path) {
  const token = authToken
  const cacheKey = `${authToken || ''}|${path}`
  if (apiInflightGets.has(cacheKey)) return apiInflightGets.get(cacheKey)
  const promise = (async () => {
    const started = apiPerfNow()
    const response = await fetchRecoveringCache(() => fetch(apiUrl(path), { headers: { ...authHeaders() },
      ...(path.endsWith('/ui-prefs') ? {cache: 'no-store'} : {}) }),
      { stillCurrent: () => token === authToken })
    logApiTiming('GET', path, started, response)
    if (response.status === 401) handleUnauthorized()
    if (!response.ok) throw new Error(await apiErrorMessage(response))
    return response.json()
  })()
  apiInflightGets.set(cacheKey, promise)
  promise.finally(() => apiInflightGets.delete(cacheKey)).catch(() => {})
  return promise
}

export async function apiGetWithSignal(path, signal) {
  const token = authToken
  const started = apiPerfNow()
  const response = await fetchRecoveringCache(() => fetch(apiUrl(path), { headers: { ...authHeaders() }, signal }),
    { signal, stillCurrent: () => token === authToken })
  logApiTiming('GET', path, started, response)
  if (response.status === 401) handleUnauthorized()
  if (!response.ok) throw new Error(await apiErrorMessage(response))
  return response.json()
}

export async function apiWarmGet(path, timeoutMs = 8000) {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const started = apiPerfNow()
    const response = await fetch(apiUrl(path), {
      headers: { ...authHeaders() },
      signal: controller.signal,
    })
    logApiTiming('GET', path, started, response)
    if (response.status === 401) handleUnauthorized()
    if (!response.ok) throw new Error(await apiErrorMessage(response))
    return response.json()
  } finally {
    window.clearTimeout(timer)
  }
}

export async function apiSend(path, method, body) {
  if (!path.startsWith('/auth/') && !path.startsWith('/box/')) await ensureWorkspaceGeneration()
  const headers = { ...authHeaders() }
  if (body) headers['Content-Type'] = 'application/json'
  const started = apiPerfNow()
  const response = await fetch(apiUrl(path), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  logApiTiming(method, path, started, response)
  await checkWorkspaceGeneration(response)
  if (response.status !== 401 && !response.ok) {
    const error = new Error(await apiErrorMessage(response))
    error.status = response.status
    throw error
  }
  if (response.status === 401) handleUnauthorized()
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`${response.status} ${response.statusText}${text ? ` - ${text}` : ''}`)
  }
  return response.json()
}

export async function apiUpload(path, file, { filename = file?.name } = {}) {
  if (!(file instanceof Blob)) throw new Error('Choose a local file first')
  await ensureWorkspaceGeneration()
  const started = apiPerfNow()
  const response = await fetch(apiUrl(path), {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'Content-Type': 'application/octet-stream',
      'X-Atmos-Filename': encodeURIComponent(String(filename || 'upload')),
    },
    body: file,
  })
  logApiTiming('POST', path, started, response)
  await checkWorkspaceGeneration(response)
  if (response.status === 401) handleUnauthorized()
  if (!response.ok) {
    const error = new Error(await apiErrorMessage(response))
    error.status = response.status
    throw error
  }
  return response.json()
}

export function apiKeepalive(path, method, body) {
  const headers = { ...authHeaders() }
  if (body) headers['Content-Type'] = 'application/json'
  return fetch(apiUrl(path), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    keepalive: true,
  })
}
