export const API_BASE_STORAGE_KEY = `atmos.apiBase.v1${import.meta.env.BASE_URL === '/' ? '' : import.meta.env.BASE_URL}`

function stripTrailingSlashes(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

export function normalizeApiBase(value) {
  const raw = stripTrailingSlashes(value)
  if (!raw || raw === '/') return ''
  return raw.endsWith('/api') ? raw : `${raw}/api`
}

export function displayApiBase(value) {
  const normalized = normalizeApiBase(value)
  return normalized.endsWith('/api') ? normalized.slice(0, -4) : normalized
}

export function storedApiBase() {
  if (typeof window === 'undefined') return ''
  try {
    return window.localStorage.getItem(API_BASE_STORAGE_KEY) || ''
  } catch {
    return ''
  }
}

export function setStoredApiBase(value) {
  if (typeof window === 'undefined') return ''
  const display = displayApiBase(value)
  try {
    if (display) window.localStorage.setItem(API_BASE_STORAGE_KEY, display)
    else window.localStorage.removeItem(API_BASE_STORAGE_KEY)
  } catch {
    // localStorage can be unavailable in hardened browsers. In that case
    // the app still falls back to the compiled/default API base.
  }
  return display
}

export function configuredApiBase() {
  // A hosted subpath must never inherit a production API override.
  if (import.meta.env.BASE_URL !== '/') return `${import.meta.env.BASE_URL.replace(/\/$/, '')}/api`
  const envBase = import.meta.env.VITE_API_BASE || ''
  if (typeof window === 'undefined') return normalizeApiBase(envBase || '/api')
  const runtimeBase = (() => {
    try {
      return window.__ATMOS_API_BASE__ || ''
    } catch {
      return ''
    }
  })()
  return normalizeApiBase(storedApiBase() || runtimeBase || envBase || '/api')
}

export function apiUrl(path) {
  const rawPath = String(path || '')
  const cleanPath = rawPath.startsWith('/api/')
    ? rawPath.slice(4)
    : rawPath.startsWith('/') ? rawPath : `/${rawPath}`
  const base = configuredApiBase()
  if (!base || base === '/api') return `/api${cleanPath}`
  return `${base}${cleanPath}`
}
