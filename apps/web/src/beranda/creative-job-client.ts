// Issue #26 — browser bridge for the durable creative-job queue.
// Project/session evidence stays browser-local; this module only exchanges an
// already approved immutable snapshot for a session-owned queue job.

export type CreativeJobPayload = Readonly<{
  session: Readonly<{
    topic: string
    prompt: Readonly<{
      prompt_text: string
      negative_prompt_text: string
      content_type: string
      creation_method: string
      provider_id: string
      model_id: string
      target_width: number
      target_height: number
      aspect_ratio: string
      orientation: string
      stock_constraints: Readonly<{
        no_logo: boolean
        no_brand: boolean
        no_watermark: boolean
        no_random_text: boolean
        no_fake_ui: boolean
        no_unintentional_crop: boolean
        no_malformed_anatomy: boolean
        no_copyrighted_property: boolean
        negative_space_decision: string
      }>
    }>
    human_prompt_approval: boolean
    approved_prompt_digest: string | null
    creative_approvals: readonly Readonly<{
      stage: string
      human: string
      approved_at: string
      prompt_digest: string | null
    }>[]
    revisions: readonly unknown[]
  }>
  rules_snapshot: Readonly<Record<string, unknown>>
  idempotency_key: string
}>

export type CreativeJob = Readonly<{
  id: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'needs_review' | (string & {})
  provider_id: string
  model_id: string
  attempt_count: number
  cancel_requested: boolean
  created_at: string
  started_at: string | null
  completed_at: string | null
  error_code: string | null
  message: string | null
  artifact: Readonly<{
    id: string
    media_type: string
    size_bytes: number
    sha256: string
    width: number
    height: number
  }> | null
}>

type JsonResponse = Readonly<{ ok: boolean; status: number; json(): Promise<unknown> }>

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function readString(record: Record<string, unknown>, name: string, nullable = false): string | null {
  const value = record[name]
  if (nullable && value === null) return null
  return typeof value === 'string' ? value : null
}

function parseJob(value: unknown): CreativeJob {
  const job = asRecord(value)
  if (!job) throw new Error('Respons job kreatif tidak valid.')
  const artifactSource = job.artifact === null ? null : asRecord(job.artifact)
  const artifact = artifactSource && typeof artifactSource.id === 'string' && typeof artifactSource.media_type === 'string'
    && typeof artifactSource.size_bytes === 'number' && typeof artifactSource.sha256 === 'string'
    && typeof artifactSource.width === 'number' && typeof artifactSource.height === 'number'
    ? { id: artifactSource.id, media_type: artifactSource.media_type, size_bytes: artifactSource.size_bytes, sha256: artifactSource.sha256, width: artifactSource.width, height: artifactSource.height }
    : job.artifact === null ? null : undefined
  if (
    typeof job.id !== 'string' || typeof job.status !== 'string' || typeof job.provider_id !== 'string'
    || typeof job.model_id !== 'string' || typeof job.attempt_count !== 'number'
    || typeof job.cancel_requested !== 'boolean' || typeof job.created_at !== 'string'
    || readString(job, 'started_at', true) === null && job.started_at !== null
    || readString(job, 'completed_at', true) === null && job.completed_at !== null
    || readString(job, 'error_code', true) === null && job.error_code !== null
    || readString(job, 'message', true) === null && job.message !== null
    || artifact === undefined
  ) throw new Error('Respons job kreatif tidak valid.')
  return {
    id: job.id,
    status: job.status,
    provider_id: job.provider_id,
    model_id: job.model_id,
    attempt_count: job.attempt_count,
    cancel_requested: job.cancel_requested,
    created_at: job.created_at,
    started_at: readString(job, 'started_at', true),
    completed_at: readString(job, 'completed_at', true),
    error_code: readString(job, 'error_code', true),
    message: readString(job, 'message', true),
    artifact,
  }
}

async function responseDetail(response: JsonResponse): Promise<string> {
  const body = asRecord(await response.json())
  return body && typeof body.detail === 'string' ? body.detail : `HTTP ${response.status}`
}

async function csrfToken(): Promise<string> {
  const response = await fetch('/api/v1/auth/csrf', { credentials: 'same-origin' }) as JsonResponse
  if (!response.ok) throw new Error(`Gagal menyiapkan token keamanan (${response.status})`)
  const body = asRecord(await response.json())
  if (!body || typeof body.csrf_token !== 'string' || !body.csrf_token) throw new Error('Token keamanan backend tidak valid.')
  return body.csrf_token
}

export async function bootstrapCreativeJobSession(): Promise<void> {
  const response = await fetch('/api/v1/creative/bootstrap', { credentials: 'same-origin' }) as JsonResponse
  if (!response.ok) throw new Error(`Gagal menyiapkan sesi generation (${response.status})`)
}

export async function enqueueApprovedCreativeJob(payload: CreativeJobPayload): Promise<CreativeJob> {
  const token = await csrfToken()
  const response = await fetch('/api/v1/creative/jobs', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
    body: JSON.stringify(payload),
  }) as JsonResponse
  if (!response.ok) throw new Error(await responseDetail(response))
  return parseJob(await response.json())
}

export async function fetchCreativeJob(jobId: string): Promise<CreativeJob> {
  const response = await fetch(`/api/v1/creative/jobs/${encodeURIComponent(jobId)}`, { credentials: 'same-origin' }) as JsonResponse
  if (!response.ok) throw new Error(await responseDetail(response))
  return parseJob(await response.json())
}

export async function cancelCreativeJob(jobId: string): Promise<CreativeJob> {
  const token = await csrfToken()
  const response = await fetch(`/api/v1/creative/jobs/${encodeURIComponent(jobId)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: { 'X-CSRF-Token': token },
  }) as JsonResponse
  if (!response.ok) throw new Error(await responseDetail(response))
  return parseJob(await response.json())
}

// Owner-scoped artifact download: the backend returns a private attachment
// with an X-Gandiwa-SHA256 header. The caller must still verify the bytes
// against the job artifact's declared digest before trusting them.
export type CreativeArtifactDownload = Readonly<{ bytes: Uint8Array; sha256Header: string }>

export async function downloadCreativeArtifact(artifactId: string): Promise<CreativeArtifactDownload> {
  const response = await fetch(`/api/v1/artifacts/${encodeURIComponent(artifactId)}/download`, { credentials: 'same-origin' }) as JsonResponse & {
    headers: { get(name: string): string | null }
    arrayBuffer(): Promise<ArrayBuffer>
  }
  if (!response.ok) throw new Error(await responseDetail(response))
  const sha256Header = response.headers.get('X-Gandiwa-SHA256')
  if (sha256Header === null) throw new Error('Respons unduhan artifact tanpa digest transport.')
  return { bytes: new Uint8Array(await response.arrayBuffer()), sha256Header }
}
