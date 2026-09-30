import {
  saveCreativeSession,
  type CreativeSessionDirectory,
  type CreativeSessionSidecar,
  type LoadedCreativeSession,
} from '../creative-session-store'
import type { ProjectManifest, ProjectRevision } from '@gandiwa/contracts'

import { recordGeneratedRevision, type RecordGeneratedRevisionInput } from './generated-revision-store'
import type { ApprovedCreativeJob } from './creative-session-adapter'
import {
  bootstrapCreativeJobSession,
  enqueueApprovedCreativeJob,
  type CreativeJob,
} from './creative-job-client'

// The dispatch controller uses saveCreativeSession only as a durability gate:
// it reads "did the browser-owned evidence land?" and never the parsed result,
// so injected substitutes only need to honour the input contract.
export type SaveSidecarFn = (input: Readonly<{
  directory: CreativeSessionDirectory
  manifestSnapshot: string
  session: CreativeSessionSidecar
  sidecarSnapshot: string | undefined
}>) => Promise<unknown>

export type DispatchApprovedCreativeJobInput = Readonly<{
  approved: ApprovedCreativeJob
  directory: CreativeSessionDirectory
  manifestSnapshot: string
  sidecarSnapshot: string | undefined
  saveSidecar?: SaveSidecarFn
  bootstrap?: typeof bootstrapCreativeJobSession
  enqueue?: typeof enqueueApprovedCreativeJob
}>

// A persisted approval is also returned so the UI can reuse the same sidecar
// evidence for later flow steps (status polling, revisions) without refetching.
export type CreativeDispatchOutcome = Readonly<{
  job: CreativeJob
  persisted: LoadedCreativeSession
}>

export async function dispatchApprovedCreativeJob(input: DispatchApprovedCreativeJobInput): Promise<CreativeDispatchOutcome> {
  const save = input.saveSidecar ?? saveCreativeSession
  const bootstrap = input.bootstrap ?? bootstrapCreativeJobSession
  const enqueue = input.enqueue ?? enqueueApprovedCreativeJob
  const persisted = (await save({
    directory: input.directory,
    manifestSnapshot: input.manifestSnapshot,
    session: input.approved.sidecar,
    sidecarSnapshot: input.sidecarSnapshot,
  })) as LoadedCreativeSession
  await bootstrap()
  const job = await enqueue(input.approved.payload)
  return { job, persisted }
}

export type AwaitCreativeJobOutcomeInput = Readonly<{
  jobId: string
  fetchJob: (jobId: string) => Promise<CreativeJob>
  delay: (ms: number) => Promise<void>
  maxAttempts: number
  onProgress?: (job: CreativeJob) => void
}>

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'needs_review'])

export async function awaitCreativeJobOutcome(input: AwaitCreativeJobOutcomeInput): Promise<CreativeJob> {
  let last: CreativeJob | undefined
  for (let attempt = 0; attempt < input.maxAttempts; attempt += 1) {
    if (attempt > 0) await input.delay(1_000)
    last = await input.fetchJob(input.jobId)
    input.onProgress?.(last)
    if (TERMINAL_STATUSES.has(last.status)) return last
  }
  throw new Error(`Pemantauan job ${input.jobId} berhenti sementara setelah ${input.maxAttempts} percobaan; job masih berjalan di backend.`)
}

export type MonitorCreativeJobToRevisionInput = Readonly<{
  jobId: string
  fetchJob: (jobId: string) => Promise<CreativeJob>
  delay: (ms: number) => Promise<void>
  maxAttempts: number
  onProgress?: (job: CreativeJob) => void
  awaitOutcome?: typeof awaitCreativeJobOutcome
  fetchArtifact: (artifactId: string) => Promise<Readonly<{ bytes: Uint8Array; sha256Header: string }>>
  recordRevision: typeof recordGeneratedRevision
  recordInput: Omit<RecordGeneratedRevisionInput, 'jobId' | 'artifact' | 'fetchArtifact'>
  recordOutcome?: (outcome: CreativeJobRevisionOutcome) => Promise<unknown>
  revokeObjectUrl?: (url: string) => void
  now: () => number
}>

export type CreativeJobRevisionOutcome = Readonly<{
  status: CreativeJob['status']
  error: string | null
  revision: ProjectRevision | null
  addedRevisionNumber: number | null
  blob: Blob | null
  url: string | null
  objectUrlRevoked: boolean
  publishedManifest: ProjectManifest | null
  message: string | null
  job: CreativeJob | null
}>

// Terminal outcome → next action, decided in exactly one place:
//   succeeded    → verify + download the artifact, record the durable
//                  revision, hand the UI a lifecycle-owned blob URL.
//   failed /
//   cancelled    → error string built from the job's own message.
//   needs_review → surfaced unchanged; a human reviews, nothing downloads.
// recordOutcome observes the pending outcome (side-channel for tests or a
// host app) but never rewrites policy; the returned outcome is the contract.
export async function monitorCreativeJobToRevision(input: MonitorCreativeJobToRevisionInput): Promise<CreativeJobRevisionOutcome> {
  const awaitOutcome = input.awaitOutcome ?? awaitCreativeJobOutcome
  const finished = await awaitOutcome({
    jobId: input.jobId,
    fetchJob: input.fetchJob,
    delay: input.delay,
    maxAttempts: input.maxAttempts,
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
  })
  let outcome: CreativeJobRevisionOutcome
  if (finished.status === 'succeeded' && finished.artifact !== null) {
    const recorded = await input.recordRevision({
      ...input.recordInput,
      jobId: input.jobId,
      artifact: finished.artifact,
      fetchArtifact: input.fetchArtifact,
    })
    // Blob direct from bytes: decoding to a JS string would corrupt binary
    // PNG/JPEG payloads; copy into a standalone ArrayBuffer for strict BlobPart.
    const blob = new Blob([recorded.bytes.slice().buffer], { type: recorded.revision.generation_format === 'svg' ? 'image/svg+xml' : `image/${recorded.revision.generation_format}` })
    outcome = {
      status: 'succeeded',
      error: null,
      revision: recorded.revision,
      addedRevisionNumber: recorded.revision.revision,
      blob,
      url: URL.createObjectURL(blob),
      objectUrlRevoked: false,
      publishedManifest: recorded.manifest,
      message: `Revisi rev-${recorded.revision.revision} tersimpan di proyek lokal.`,
      job: finished,
    }
  } else if (finished.status === 'needs_review') {
    outcome = {
      status: 'needs_review',
      error: finished.message ?? 'Job needs review before it may produce a revision.',
      revision: null,
      addedRevisionNumber: null,
      blob: null,
      url: null,
      objectUrlRevoked: false,
      publishedManifest: null,
      message: 'Job butuh tinjauan manusia sebelum hasil bisa dipakai.',
      job: finished,
    }
  } else {
    outcome = {
      status: finished.status,
      error: finished.message ?? `Job berakhir dengan status ${finished.status}.`,
      revision: null,
      addedRevisionNumber: null,
      blob: null,
      url: null,
      objectUrlRevoked: false,
      publishedManifest: null,
      message: `Job berakhir dengan status ${finished.status}.`,
      job: finished,
    }
  }
  if (input.recordOutcome) await input.recordOutcome(outcome)
  if (input.revokeObjectUrl && outcome.url !== null) {
    input.revokeObjectUrl(outcome.url)
    outcome = { ...outcome, url: null, objectUrlRevoked: true }
  }
  return outcome
}
