import type { CreativeSessionSidecar, LoadedCreativeSession } from '../creative-session-store'
import type { CreativeJobPayload } from './creative-job-client'

const RULESET = 'adobe-stock-2026-09-08-v1'

type ContentType = 'photo' | 'illustration' | 'vector'

export type ApprovedCreativeInput = Readonly<{
  sessionId: string
  topic: string
  prompt: string
  negativePrompt: string
  providerId: 'fal'
  modelId: string
  width: number
  height: number
  aspectRatio: string
  contentType: ContentType
  human: string
  approvedAt: string
  previousSession?: LoadedCreativeSession
  rejectionReason?: string
}>

export type ApprovedCreativeJob = Readonly<{
  sidecar: CreativeSessionSidecar
  payload: CreativeJobPayload
  promptDigest: string
}>

function orientationFor(width: number, height: number): 'landscape' | 'portrait' | 'square' {
  if (width === height) return 'square'
  return width > height ? 'landscape' : 'portrait'
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function requireText(value: string, message: string): string {
  const text = value.trim()
  if (!text) throw new Error(message)
  return text
}

export async function buildApprovedCreativeJob(input: ApprovedCreativeInput): Promise<ApprovedCreativeJob> {
  const topic = requireText(input.topic, 'Topik kreatif wajib diisi.')
  const promptText = requireText(input.prompt, 'Prompt wajib diisi.')
  const negativePrompt = requireText(input.negativePrompt, 'Negative prompt wajib diisi.')
  const human = requireText(input.human, 'Nama pemberi persetujuan wajib diisi.')
  if (!Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width * input.height < 4_000_000) {
    throw new Error('Target gambar minimal 4 MP.')
  }

  const stockConstraints = {
    no_logo: true,
    no_brand: true,
    no_watermark: true,
    no_random_text: true,
    no_fake_ui: true,
    no_unintentional_crop: true,
    no_malformed_anatomy: true,
    no_copyrighted_property: true,
    negative_space_decision: 'none required',
  }
  const prompt = {
    prompt_text: promptText,
    negative_prompt_text: negativePrompt,
    content_type: input.contentType,
    creation_method: 'generative_ai',
    provider_id: input.providerId,
    model_id: requireText(input.modelId, 'Model gambar wajib dipilih.'),
    target_width: input.width,
    target_height: input.height,
    aspect_ratio: input.aspectRatio,
    orientation: orientationFor(input.width, input.height),
    stock_constraints: stockConstraints,
  }
  const promptDigest = await sha256(canonicalize(prompt))
  const approval = {
    stage: 'prompt' as const,
    human,
    approved_at: input.approvedAt,
    prompt_digest: promptDigest,
  }
  const previous = input.previousSession?.session
  const lastRevision = previous?.revisions.at(-1)
  const rejectionReason = input.rejectionReason?.trim()
  if (lastRevision?.promptDigest === promptDigest && !rejectionReason) {
    throw new Error('Regenerate identik ditolak: ubah prompt secara bermakna atau catat alasan penolakan.')
  }
  // An explicitly justified identical regenerate is a new paid job, not an
  // idempotent replay of rev-N. The approval timestamp is the stable identity
  // of one human-approved attempt: retries of the same payload stay idempotent,
  // while a later approval using the same reason creates a distinct job.
  const dispatchDigest = rejectionReason
    ? await sha256(`${promptDigest}:${rejectionReason}:${input.approvedAt}`)
    : promptDigest
  const sidecar: CreativeSessionSidecar = {
    schemaVersion: 1,
    sessionId: input.sessionId,
    topic,
    rounds: previous?.rounds ?? [],
    prompt: {
      promptText,
      negativePrompt,
      contentType: input.contentType,
      creationMethod: 'generative_ai',
      providerId: input.providerId,
      modelId: prompt.model_id,
      targetWidth: input.width,
      targetHeight: input.height,
      aspectRatio: input.aspectRatio,
      orientation: prompt.orientation,
      stockConstraints: [
        'no_logo', 'no_brand', 'no_watermark', 'no_random_text', 'no_fake_ui',
        'no_unintentional_crop', 'no_malformed_anatomy', 'no_copyrighted_property',
      ],
      negativeSpaceDecision: stockConstraints.negative_space_decision,
    },
    approvals: [...(previous?.approvals ?? []), {
      stage: 'prompt', human, approvedAt: input.approvedAt, promptDigest,
    }],
    revisions: previous?.revisions ?? [],
  }
  return {
    sidecar,
    promptDigest,
    payload: {
      session: {
        topic,
        prompt,
        human_prompt_approval: true,
        approved_prompt_digest: promptDigest,
        creative_approvals: [approval],
        revisions: [],
      },
      rules_snapshot: { id: RULESET, version: RULESET },
      idempotency_key: `creative-${input.sessionId}-${dispatchDigest.slice(0, 32)}`,
    },
  }
}
