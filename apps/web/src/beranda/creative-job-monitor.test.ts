import { describe, expect, it, vi } from 'vitest'

import { awaitCreativeJobOutcome, monitorCreativeJobToRevision, type CreativeJobRevisionOutcome } from './creative-dispatch-controller'
import { recordGeneratedRevision, type RecordGeneratedRevisionInput } from './generated-revision-store'
import type { CreativeJob } from './creative-job-client'
import type { CreativeSessionDirectory } from '../creative-session-store'

// Issue #26 slice artifact-revision: after the owned job reaches a terminal
// outcome, the controller alone decides what happens next. succeeded →
// download + durable revision; failed/cancelled → honest error carrying the
// job's own message; needs_review → surfaced unchanged for the reviewer.

const job = (status: string, artifact: unknown = null, message: string | null = null): CreativeJob => ({
  id: 'job-9',
  status,
  provider_id: 'fal',
  model_id: 'fal-ai/flux/schnell',
  attempt_count: 1,
  cancel_requested: false,
  created_at: '2026-09-22T00:00:00Z',
  started_at: '2026-09-22T00:01:00Z',
  completed_at: '2026-09-22T00:02:00Z',
  error_code: null,
  message,
  artifact,
} as CreativeJob)

const REAL_DIGEST = '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a'

const ARTIFACT_FIXTURE = { id: 'art-1', media_type: 'image/png', size_bytes: 4, sha256: REAL_DIGEST, width: 2000, height: 2000 }

function baseInput(): RecordGeneratedRevisionInput & Record<string, unknown> {
  const revisionWrites: string[] = []
  const directory = {
    getFileHandle: () => Promise.reject(new DOMException('missing', 'NotFoundError')),
    getDirectoryHandle: (name: string) => {
      if (name === 'revisions') {
        return Promise.resolve({
          getDirectoryHandle: () => Promise.resolve({
            getFileHandle: (fileName: string, options?: { create?: boolean }) => {
              if (options?.create === true) {
                return Promise.resolve({
                  createWritable: () => Promise.resolve({
                    write: (chunk: string) => { revisionWrites.push(`${fileName}:${chunk.length}`); return Promise.resolve() },
                    close: () => Promise.resolve(),
                  }),
                })
              }
              return Promise.reject(new DOMException('missing', 'NotFoundError'))
            },
          }),
        })
      }
      throw new Error(`unexpected getDirectoryHandle: ${name}`)
    },
  }
  const input = {
    directory: directory as unknown as CreativeSessionDirectory,
    manifestSnapshot: JSON.stringify({
      schema_version: 1,
      project_id: '3f2b8a64-9c1d-4e7a-b2f5-8d60c1a94e21',
      project_name: 'Demo Stok',
      assets: [],
    }),
    persistedSession: {
      session: {
        schemaVersion: 1 as const,
        sessionId: '3f2b8a64-9c1d-4e7a-b2f5-8d60c1a94e21',
        topic: 'Demo Stok',
        rounds: [],
        prompt: {
          promptText: 'ilustrasi kucing oren',
          negativePrompt: 'watermark',
          contentType: 'illustration' as const,
          creationMethod: 'generative_ai' as const,
          providerId: 'fal',
          modelId: 'fal-ai/flux/schnell',
          targetWidth: 2000,
          targetHeight: 2000,
          aspectRatio: '1:1',
          orientation: 'square' as const,
          stockConstraints: [],
          negativeSpaceDecision: 'none required',
        },
        approvals: [{ stage: 'prompt', human: 'Guru', approvedAt: '2026-09-22T00:00:00.000Z', promptDigest: 'd'.repeat(64) }],
        revisions: [],
      },
      snapshot: 'sidecar-text',
      checksum: 'c'.repeat(64),
    } as never,
    jobId: 'job-9',
    artifact: { id: 'art-1', media_type: 'image/png', size_bytes: 4, sha256: REAL_DIGEST },
    fetchArtifact: vi.fn(() => Promise.resolve({ bytes: new Uint8Array([1, 2, 3, 4]), sha256Header: REAL_DIGEST })),
    saveSidecar: vi.fn(() => Promise.resolve({})),
    publishManifest: vi.fn(() => Promise.resolve()),
  } as unknown as RecordGeneratedRevisionInput & Record<string, unknown>
  return Object.assign(input, { revisionWrites })
}

describe('monitorCreativeJobToRevision', () => {
  it('polls until the owned job succeeds, then records the durable revision', async () => {
    const input = baseInput()
    const fetchJob = vi
      .fn()
      .mockResolvedValueOnce(job('running'))
      .mockResolvedValueOnce(job('succeeded', ARTIFACT_FIXTURE))

    const outcome = await monitorCreativeJobToRevision({
      jobId: 'job-9',
      fetchJob,
      delay: () => Promise.resolve(),
      maxAttempts: 5,
      awaitOutcome: awaitCreativeJobOutcome,
      fetchArtifact: input.fetchArtifact,
      recordRevision: recordGeneratedRevision,
      recordInput: input,
      now: () => 1760000000000,
    })

    expect(fetchJob).toHaveBeenCalledTimes(2)
    expect(outcome.blob).toBeTruthy()
    expect(outcome.url?.startsWith('blob:')).toBe(true)
    expect(outcome.revision?.relative_path).toContain('revisions/')
    expect(outcome.addedRevisionNumber).toBe(1)
  })

  it('reports failed and cancelled jobs with the job message, never touching the artifact path', async () => {
    const input = baseInput()
    for (const [status, message] of [['failed', 'provider exploded'], ['cancelled', 'stop requested']] as const) {
      const outcome = await monitorCreativeJobToRevision({
        jobId: 'job-9',
        fetchJob: vi.fn(() => Promise.resolve(job(status, null, message))),
        delay: () => Promise.resolve(),
        maxAttempts: 3,
        awaitOutcome: awaitCreativeJobOutcome,
        fetchArtifact: input.fetchArtifact,
        recordRevision: recordGeneratedRevision,
        recordInput: input,
        now: () => 1760000000000,
      })

      expect(outcome.status).toBe(status)
      expect(outcome.error).toContain(message)
      expect(input.fetchArtifact).not.toHaveBeenCalled()
    }
  })

  it('keeps needs_review human-owned instead of downloading or burying it', async () => {
    const input = baseInput()
    const outcome = await monitorCreativeJobToRevision({
      jobId: 'job-9',
      fetchJob: vi.fn(() => Promise.resolve(job('needs_review', null, 'Provider outcome needs review'))),
      delay: () => Promise.resolve(),
      maxAttempts: 3,
      awaitOutcome: awaitCreativeJobOutcome,
      fetchArtifact: input.fetchArtifact,
      recordRevision: recordGeneratedRevision,
      recordInput: input,
      now: () => 1760000000000,
    })

    expect(outcome.status).toBe('needs_review')
    expect(outcome.error).toBe('Provider outcome needs review')
    expect(input.fetchArtifact).not.toHaveBeenCalled()
  })

  it('accepts a dependency-injected recordOutcome without re-deciding policy', async () => {
    const input = baseInput()
    const seen: string[] = []
    const recordOutcome = vi.fn((given: CreativeJobRevisionOutcome) => {
      seen.push(given.status)
      return Promise.resolve({ status: given.status, message: 'injected' })
    })
    const outcome = await monitorCreativeJobToRevision({
      jobId: 'job-9',
      fetchJob: vi.fn(() => Promise.resolve(job('succeeded', ARTIFACT_FIXTURE))),
      delay: () => Promise.resolve(),
      maxAttempts: 3,
      awaitOutcome: awaitCreativeJobOutcome,
      fetchArtifact: input.fetchArtifact,
      recordRevision: recordGeneratedRevision,
      recordInput: input,
      recordOutcome: recordOutcome,
      now: () => 1760000000000,
    })

    expect(recordOutcome).toHaveBeenCalledTimes(1)
    expect(seen).toEqual(['succeeded'])
    // The observer never rewrites the policy outcome.
    expect(outcome.message).toBe('Revisi rev-1 tersimpan di proyek lokal.')
  })

  it('lifecycle-owns the blob URL: a later revoke cleans up without errors', async () => {
    const input = baseInput()
    const outcome = await monitorCreativeJobToRevision({
      jobId: 'job-9',
      fetchJob: vi.fn(() => Promise.resolve(job('succeeded', ARTIFACT_FIXTURE))),
      delay: () => Promise.resolve(),
      maxAttempts: 3,
      awaitOutcome: awaitCreativeJobOutcome,
      fetchArtifact: input.fetchArtifact,
      recordRevision: recordGeneratedRevision,
      recordInput: input,
      now: () => 1760000000000,
      revokeObjectUrl: outcomeUrl => { URL.revokeObjectURL(outcomeUrl) },
    })

    expect(outcome.url).toBeNull()
    expect(outcome.objectUrlRevoked).toBe(true)
    expect(outcome.addedRevisionNumber).toBe(1)
  })
})
