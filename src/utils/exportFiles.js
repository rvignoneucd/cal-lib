import { apiUrl } from '../apiBase'
import { authHeaders, notifyUnauthorized, setAuthToken } from '../api/client'

export function downloadFile(content, filename, mime) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

export function pngClipboardSize(aspect, longEdge = 2048) {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 4 / 3
  if (a >= 1) return { width: longEdge, height: Math.max(1, Math.round(longEdge / a)) }
  return { width: Math.max(1, Math.round(longEdge * a)), height: longEdge }
}

export async function imageDataUrlToPngBlob(dataUrl, { aspect = 4 / 3, longEdge = 2048, background = '#ffffff' } = {}) {
  const sourceBlob = await fetch(dataUrl).then((response) => response.blob())
  const sourceUrl = URL.createObjectURL(sourceBlob)
  try {
    const image = await new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('Could not load plot image for clipboard.'))
      img.src = sourceUrl
    })
    const { width, height } = pngClipboardSize(aspect || (image.width / Math.max(1, image.height)), longEdge)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas export is unavailable in this browser.')
    ctx.clearRect(0, 0, width, height)
    if (background) {
      ctx.fillStyle = background
      ctx.fillRect(0, 0, width, height)
    }
    ctx.drawImage(image, 0, 0, width, height)
    return await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob)
        else reject(new Error('Could not create clipboard PNG.'))
      }, 'image/png')
    })
  } finally {
    URL.revokeObjectURL(sourceUrl)
  }
}

export async function writePngToClipboard(blob) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw new Error('Image clipboard is not available in this browser context.')
  }
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
}

export function safeImageFilename(name) {
  const base = String(name || 'atmos-plot').trim() || 'atmos-plot'
  // eslint-disable-next-line no-control-regex
  return `${base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120)}.png`
}

export async function downloadExportXlsx(payload) {
  const response = await fetch(apiUrl('/peaks/export'), {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (response.status === 401) {
    setAuthToken(null)
    notifyUnauthorized()
    throw new Error('Unauthorized')
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(text || `Export failed with HTTP ${response.status}`)
  }
  const blob = await response.blob()
  downloadFile(blob, `${payload.filename || 'peak_table'}.xlsx`)
}
