import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  bootstrapCreativeJobSession,
  enqueueApprovedCreativeJob,
  fetchCreativeJob,
  type CreativeJobPayload,
} from './creative-job-client'

const payload: CreativeJobPayload = {
  session: {
    topic: 'Pale ceramic cup on a linen table',
    prompt: {
      prompt_text: 'Pale ceramic cup on a linen table with generous copy space',
      negative_prompt_text: 'logo, brand, watermark, random text',
      content_type: 'illustration',
      creation_method: 'generative_ai',
      provider_id: 'fal',
      model_id: 'fal-ai/flux/schnell',
      target_width: 2000,
      target_height: 2000,
      aspect_ratio: '1:1',
      orientation: 'square',
      stock_constraints: {
        no_logo: true,
        no_brand: true,
        no_watermark: true,
        no_random_text: true,
        no_fake_ui: true,
        no_unintentional_crop: true,
        no_malformed_anatomy: true,
        no_copyrighted_property: true,
        negative_space_decision: 'right third open',
      },
    },
    human_prompt_approval: true,
    approved_prompt_digest: 'a'.repeat(64),
    creative_approvals: [{ stage: 'prompt', human: 'Guru', approved_at: '2026-09-22T00:00:00.000Z', prompt_digest: 'a'.repeat(64) }],
    revisions: [],
  },
  rules_snapshot: { id: 'adobe-stock-2026-09-08-v1', version: 'adobe-stock-2026-09-08-v1' },
  idempotency_key: 'creative-session-1-approval-a',
}

describe('creative job client', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('bootstraps ownership, obtains CSRF, then dispatches exactly one approved snapshot', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url
      if (url.endsWith('/api/v1/creative/bootstrap')) return Promise.resolve({ ok: true, status: 200 })
      if (url.endsWith('/api/v1/auth/csrf')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ csrf_token: 'csrf-1' }) })
      if (url.endsWith('/api/v1/creative/jobs')) return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ id: 'job-1', status: 'queued', provider_id: 'fal', model_id: 'fal-ai/flux/schnell', attempt_count: 0, cancel_requested: false, created_at: '2026-09-22T00:00:00+00:00', started_at: null, completed_at: null, error_code: null, message: null, artifact: null }) })
      return Promise.reject(new Error(`unexpected request: ${url} ${init?.method ?? 'GET'}`))
    })
    vi.stubGlobal('fetch', fetchMock)

    await bootstrapCreativeJobSession()
    const job = await enqueueApprovedCreativeJob(payload)

    expect(job).toMatchObject({ id: 'job-1', status: 'queued', artifact: null })
    expect(fetchMock.mock.calls.map(([request]) => (typeof request === 'string' ? request : request instanceof URL ? request.href : request.url))).toEqual([
      '/api/v1/creative/bootstrap',
      '/api/v1/auth/csrf',
      '/api/v1/creative/jobs',
    ])
    const [, init] = fetchMock.mock.calls[2] as [string, RequestInit]
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['X-CSRF-Token']).toBe('csrf-1')
    expect(JSON.parse(init.body as string)).toEqual(payload)
  })

  it('preserves needs_review as a human intervention state instead of success', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ id: 'job-review', status: 'needs_review', provider_id: 'fal', model_id: 'fal-ai/flux/schnell', attempt_count: 1, cancel_requested: false, created_at: '2026-09-22T00:00:00+00:00', started_at: '2026-09-22T00:01:00+00:00', completed_at: '2026-09-22T00:02:00+00:00', error_code: 'UNKNOWN_PROVIDER_OUTCOME', message: 'Provider outcome needs review', artifact: null }),
    })))

    const job = await fetchCreativeJob('job-review')

    expect(job.status).toBe('needs_review')
    expect(job.message).toBe('Provider outcome needs review')
  })

  it('surfaces a rejected dispatch without inventing a queued job', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.endsWith('/api/v1/auth/csrf')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ csrf_token: 'csrf-1' }) })
      return Promise.resolve({ ok: false, status: 422, json: () => Promise.resolve({ detail: 'GENERATION_READY is blocked: negative_prompt_present' }) })
    }))

    await expect(enqueueApprovedCreativeJob(payload)).rejects.toThrow('GENERATION_READY is blocked')
  })
})
