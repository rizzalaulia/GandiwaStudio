import type { ContentType } from '@gandiwa/contracts'

export type SvgFinding = Readonly<{ rule_id: string; message: string }>
export type SvgPreflightReport = Readonly<{
  verdict: 'pass' | 'warning' | 'fail'
  eligible_for_submission: boolean
  findings: readonly SvgFinding[]
  preview_url: string | null
}>

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type SvgContentType = Extract<ContentType, 'illustration' | 'vector'>

const SVG_MIME_TYPE = 'image/svg+xml'
const SVG_PREVIEW_URL = /^\/api\/v1\/svg\/preflight\/previews\/[a-f0-9]{32}$/

function hasSvgExtension(name: string): boolean {
  return name.toLowerCase().endsWith('.svg')
}

function isSvgFinding(value: unknown): value is SvgFinding {
  return Boolean(
    value
      && typeof value === 'object'
      && typeof (value as { rule_id?: unknown }).rule_id === 'string'
      && typeof (value as { message?: unknown }).message === 'string',
  )
}

function isSvgReport(value: unknown): value is SvgPreflightReport {
  if (!value || typeof value !== 'object') return false
  const report = value as Partial<SvgPreflightReport>
  return (
    (report.verdict === 'pass' || report.verdict === 'warning' || report.verdict === 'fail')
    && typeof report.eligible_for_submission === 'boolean'
    && Array.isArray(report.findings)
    && report.findings.every(isSvgFinding)
    && (report.preview_url === null || (typeof report.preview_url === 'string' && SVG_PREVIEW_URL.test(report.preview_url)))
  )
}

export async function preflightSvg(
  file: File,
  contentType: SvgContentType,
  fetchImpl: FetchLike = fetch,
): Promise<SvgPreflightReport> {
  if (file.type !== SVG_MIME_TYPE || !hasSvgExtension(file.name)) {
    throw new Error('Choose an SVG file for vector preflight.')
  }

  const csrfResponse = await fetchImpl('/api/v1/auth/csrf', {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })
  if (!csrfResponse.ok) throw new Error('Unable to prepare a secure SVG preflight request.')
  const csrfPayload: unknown = await csrfResponse.json()
  if (!csrfPayload || typeof csrfPayload !== 'object' || typeof (csrfPayload as { csrf_token?: unknown }).csrf_token !== 'string') {
    throw new Error('Unable to prepare a secure SVG preflight request.')
  }

  const response = await fetchImpl(`/api/v1/svg/preflight?content_type=${contentType}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': SVG_MIME_TYPE,
      'X-CSRF-Token': (csrfPayload as { csrf_token: string }).csrf_token,
      'X-Upload-Filename': file.name,
    },
    body: file,
  })
  if (!response.ok) throw new Error('SVG preflight could not be completed.')
  const payload: unknown = await response.json()
  if (!isSvgReport(payload)) throw new Error('SVG preflight returned an invalid technical report.')
  return payload
}
