import { describe, expect, it } from 'vitest'

import { buildApprovedCreativeJob, type ApprovedCreativeInput } from './creative-session-adapter'

const input: ApprovedCreativeInput = {
  sessionId: '123e4567-e89b-12d3-a456-426614174000',
  topic: 'Ceramic cup scene',
  prompt: 'Pale ceramic cup on linen with generous copy space',
  negativePrompt: 'logo, brand, watermark, random text',
  providerId: 'fal',
  modelId: 'fal-ai/flux/schnell',
  width: 2000,
  height: 2000,
  aspectRatio: '1:1',
  contentType: 'illustration',
  human: 'Guru',
  approvedAt: '2026-09-22T00:00:00.000Z',
}

describe('approved creative session adapter', () => {
  it('builds one exact browser-side approval and API snapshot with a stable idempotency key', async () => {
    const result = await buildApprovedCreativeJob(input)

    expect(result.sidecar.schemaVersion).toBe(1)
    expect(result.sidecar.approvals).toEqual([
      expect.objectContaining({ stage: 'prompt', human: 'Guru', promptDigest: result.promptDigest }),
    ])
    expect(result.payload.session.human_prompt_approval).toBe(true)
    expect(result.payload.session.approved_prompt_digest).toBe(result.promptDigest)
    expect(result.payload.session.creative_approvals[0]?.prompt_digest).toBe(result.promptDigest)
    expect(result.payload.idempotency_key).toBe(`creative-${input.sessionId}-${result.promptDigest.slice(0, 32)}`)
    expect(result.payload.session.prompt.stock_constraints).toEqual({
      no_logo: true,
      no_brand: true,
      no_watermark: true,
      no_random_text: true,
      no_fake_ui: true,
      no_unintentional_crop: true,
      no_malformed_anatomy: true,
      no_copyrighted_property: true,
      negative_space_decision: 'none required',
    })
  })

  it('changes the approval digest and idempotency identity when a dispatch-affecting field changes', async () => {
    const original = await buildApprovedCreativeJob(input)
    const changed = await buildApprovedCreativeJob({ ...input, modelId: 'fal-ai/flux/dev' })

    expect(changed.promptDigest).not.toBe(original.promptDigest)
    expect(changed.payload.idempotency_key).not.toBe(original.payload.idempotency_key)
  })

  it('rejects a sidecar request before it can claim approval when the prompt is incomplete', async () => {
    await expect(buildApprovedCreativeJob({ ...input, negativePrompt: '   ' })).rejects.toThrow('Negative prompt wajib diisi')
  })

  it('rejects identical regenerate unless a human records a rejection reason', async () => {
    const first = await buildApprovedCreativeJob(input)
    const previousSession = {
      session: {
        ...first.sidecar,
        revisions: [{
          revisionId: 'rev-1', promptDigest: first.promptDigest, providerId: 'fal',
          modelId: input.modelId, providerJobId: 'job-1', adapterVersion: 'gandiwa-web-1',
          parameters: { artifact_id: 'artifact-1' }, createdAt: input.approvedAt,
        }],
      },
      snapshot: '{}\n',
      checksum: 'a'.repeat(64),
    }

    await expect(buildApprovedCreativeJob({ ...input, previousSession })).rejects.toThrow(/Regenerate identik ditolak/)
    const allowedInput = { ...input, previousSession, rejectionReason: 'Komposisi terlalu padat.' }
    const allowed = await buildApprovedCreativeJob(allowedInput)
    const browserRetry = await buildApprovedCreativeJob(allowedInput)
    const nextIntentionalAttempt = await buildApprovedCreativeJob({
      ...allowedInput,
      approvedAt: '2026-09-22T00:05:00.000Z',
    })
    expect(allowed.sidecar.revisions).toHaveLength(1)
    expect(allowed.sidecar.approvals).toHaveLength(2)
    expect(allowed.payload.idempotency_key).not.toBe(first.payload.idempotency_key)
    expect(browserRetry.payload.idempotency_key).toBe(allowed.payload.idempotency_key)
    expect(nextIntentionalAttempt.payload.idempotency_key).not.toBe(allowed.payload.idempotency_key)
  })
})
