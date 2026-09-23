import { describe, expect, it, vi } from 'vitest'

import { dispatchApprovedCreativeJob, awaitCreativeJobOutcome } from './creative-dispatch-controller'

const approved = {
  sidecar: { schemaVersion: 1 as const, sessionId: '123e4567-e89b-12d3-a456-426614174000' },
  promptDigest: 'a'.repeat(64),
  payload: { idempotency_key: 'creative-123-a' },
}

describe('creative dispatch controller', () => {
  it('persists the browser-owned approval before it starts the owned queue job', async () => {
    const events: string[] = []
    const saveSidecar = vi.fn(() => {
      events.push('save')
      return Promise.resolve({ session: approved.sidecar, snapshot: '{}', checksum: 'a'.repeat(64) })
    })
    const bootstrap = vi.fn(() => { events.push('bootstrap'); return Promise.resolve() })
    const enqueue = vi.fn(() => {
      events.push('enqueue')
      return Promise.resolve({
        id: 'job-1', status: 'queued', provider_id: 'fal', model_id: 'fal-ai/flux/schnell',
        attempt_count: 0, artifact_expires_at: null, cancel_requested: false, created_at: '2026-09-22T00:00:00Z',
        started_at: null, completed_at: null, error_code: null, message: null, artifact: null,
      })
    })

    const { job } = await dispatchApprovedCreativeJob({
      approved: approved as never,
      directory: { name: 'local-project' } as never,
      manifestSnapshot: '{"schema_version":1}',
      sidecarSnapshot: undefined,
      saveSidecar,
      bootstrap,
      enqueue,
    })

    expect(job).toMatchObject({ id: 'job-1', status: 'queued' })
    expect(events).toEqual(['save', 'bootstrap', 'enqueue'])
    expect(saveSidecar).toHaveBeenCalledWith(expect.objectContaining({
      manifestSnapshot: '{"schema_version":1}',
      session: approved.sidecar,
      sidecarSnapshot: undefined,
    }))
  })

  it('polls the owned job until it reaches a terminal outcome', async () => {
    const behaviour: string[] = ['queued', 'running', 'needs_review']
    const job = (status: string) => ({
      id: 'job-9', status, provider_id: 'fal', model_id: 'fal-ai/flux/schnell',
      attempt_count: 1, artifact_expires_at: null, cancel_requested: false, created_at: '2026-09-22T00:00:00Z',
      started_at: null, completed_at: null, error_code: null, message: null, artifact: null,
    })
    const polls = vi.fn(() => Promise.resolve(job(behaviour.shift() ?? 'running')))
    const pauses: number[] = []
    const outcome = await awaitCreativeJobOutcome({
      jobId: 'job-9',
      fetchJob: polls,
      delay: (ms: number) => { pauses.push(ms); return Promise.resolve() },
      maxAttempts: 5,
    })
    expect(outcome.status).toBe('needs_review')
    expect(polls).toHaveBeenCalledTimes(3)
    expect(pauses).toEqual([1_000, 1_000])
  })

  it('pauses monitoring honestly when the job stays non-terminal for every attempt', async () => {
    const polls = vi.fn(() => Promise.resolve({
      id: 'job-9', status: 'running', provider_id: 'fal', model_id: 'fal-ai/flux/schnell',
      attempt_count: 1, artifact_expires_at: null, cancel_requested: false, created_at: '2026-09-22T00:00:00Z',
      started_at: null, completed_at: null, error_code: null, message: null, artifact: null,
    }))
    await expect(awaitCreativeJobOutcome({
      jobId: 'job-9',
      fetchJob: polls,
      delay: () => Promise.resolve(),
      maxAttempts: 4,
    })).rejects.toThrow(/masih berjalan di backend/)
    expect(polls).toHaveBeenCalledTimes(4)
  })

  it('does not contact the queue when durable local approval evidence cannot be written', async () => {
    const saveSidecar = vi.fn(() => Promise.reject(new Error('manifest changed externally')))
    const bootstrap = vi.fn()
    const enqueue = vi.fn()

    await expect(dispatchApprovedCreativeJob({
      approved: approved as never,
      directory: {} as never,
      manifestSnapshot: '{}',
      sidecarSnapshot: undefined,
      saveSidecar,
      bootstrap,
      enqueue,
    })).rejects.toThrow('manifest changed externally')

    expect(bootstrap).not.toHaveBeenCalled()
    expect(enqueue).not.toHaveBeenCalled()
  })
})
