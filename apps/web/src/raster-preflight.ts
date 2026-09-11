import type { ContentType } from '@gandiwa/contracts'

export type RasterFinding = Readonly<{ rule_id: string; message: string }>
export type RasterPreflightReport = Readonly<{
  verdict: 'pass' | 'warning' | 'fail'
  detected_mime_type: 'image/jpeg' | 'image/png' | null
  detected_extension: 'jpeg' | 'png' | null
  width: number | null
  height: number | null
  megapixels: number | null
  has_alpha: boolean | null
  eligible_for_submission: boolean
  findings: readonly RasterFinding[]
}>

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type RasterContentType = Exclude<ContentType, 'vector'>

const ALLOWED_FILE_TYPES = new Set(['image/jpeg', 'image/png'])
const ALLOWED_EXTENSIONS = new Set(['jpeg', 'jpg', 'png'])

function hasAllowedExtension(name: string): boolean {
  const dotIndex = name.lastIndexOf('.')
  const extension = dotIndex >= 0 ? name.slice(dotIndex + 1).toLowerCase() : ''
  return ALLOWED_EXTENSIONS.has(extension)
}

function isRasterFinding(value: unknown): value is RasterFinding {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof (value as { rule_id?: unknown }).rule_id === 'string'
    && typeof (value as { message?: unknown }).message === 'string',
  )
}

function isRasterReport(value: unknown): value is RasterPreflightReport {
  if (!value || typeof value !== 'object') return false
  const report = value as Partial<RasterPreflightReport>
  return (
    (report.verdict === 'pass' || report.verdict === 'warning' || report.verdict === 'fail')
    && (report.detected_mime_type === 'image/jpeg' || report.detected_mime_type === 'image/png' || report.detected_mime_type === null)
    && (report.detected_extension === 'jpeg' || report.detected_extension === 'png' || report.detected_extension === null)
    && (typeof report.width === 'number' || report.width === null)
    && (typeof report.height === 'number' || report.height === null)
    && (typeof report.megapixels === 'number' || report.megapixels === null)
    && (typeof report.has_alpha === 'boolean' || report.has_alpha === null)
    && typeof report.eligible_for_submission === 'boolean'
    && Array.isArray(report.findings)
    && report.findings.every(isRasterFinding)
  )
}

export async function preflightRaster(
  file: File,
  contentType: RasterContentType,
  fetchImpl: FetchLike = fetch,
): Promise<RasterPreflightReport> {
  if (!ALLOWED_FILE_TYPES.has(file.type) || !hasAllowedExtension(file.name)) {
    throw new Error('Choose a PNG or JPEG file for raster preflight.')
  }

  const csrfResponse = await fetchImpl('/api/v1/auth/csrf', {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })
  if (!csrfResponse.ok) throw new Error('Unable to prepare a secure raster preflight request.')
  const csrfPayload: unknown = await csrfResponse.json()
  if (!csrfPayload || typeof csrfPayload !== 'object' || typeof (csrfPayload as { csrf_token?: unknown }).csrf_token !== 'string') {
    throw new Error('Unable to prepare a secure raster preflight request.')
  }

  const response = await fetchImpl(`/api/v1/raster/preflight?content_type=${contentType}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': file.type,
      'X-CSRF-Token': (csrfPayload as { csrf_token: string }).csrf_token,
      'X-Upload-Filename': file.name,
    },
    body: file,
  })
  if (!response.ok) throw new Error('Raster preflight could not be completed.')
  const payload: unknown = await response.json()
  if (!isRasterReport(payload)) throw new Error('Raster preflight returned an invalid technical report.')
  return payload
}
