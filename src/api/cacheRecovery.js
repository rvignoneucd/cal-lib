function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(new DOMException('Request aborted', 'AbortError'))
    }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}

export async function fetchRecoveringCache(request, { signal, stillCurrent = () => true, sleep = pause, timeoutMs = 300000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (!stillCurrent()) throw new Error('Account changed while loading data')
    if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError')
    const response = await request()
    if (!stillCurrent()) throw new Error('Account changed while loading data')
    if (response.status !== 503) return response
    const payload = await response.clone().json().catch(() => null)
    if (payload?.detail?.code !== 'cache_rebuilding') return response
    if (Date.now() >= deadline) throw new Error('Cache rebuild is still running. Check the processing job and reopen the file when it finishes.')
    const seconds = Number(response.headers.get('Retry-After')) || 2
    await sleep(Math.min(10000, Math.max(1000, seconds * 1000)), signal)
  }
}
