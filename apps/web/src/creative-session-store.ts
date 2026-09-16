type Writable = { write(data: string): Promise<void>; close(): Promise<void> }
type FileHandle = { getFile(): Promise<{ text(): Promise<string> }>; createWritable(): Promise<Writable> }

export interface CreativeSessionDirectory {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<CreativeSessionDirectory>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandle>
}

export type CreativeRound = Readonly<{
  questions: readonly [string, string, string]
  recommendation: string
  humanAnswer?: string
  createdAt: string
  model: string
}>

export type CreativePrompt = Readonly<{
  promptText: string
  negativePrompt: string
  contentType: 'photo' | 'illustration' | 'vector'
  creationMethod: 'camera' | 'manual_digital' | 'generative_ai' | 'mixed'
  providerId: string
  modelId: string
  targetWidth: number
  targetHeight: number
  aspectRatio: string
  orientation: 'landscape' | 'portrait' | 'square'
  stockConstraints: readonly string[]
  negativeSpaceDecision: string
}>

export type CreativeApproval = Readonly<{
  stage: 'concept' | 'prompt' | 'visual' | 'metadata'
  approvedAt: string
  human: string
  promptDigest?: string
}>

export type CreativeRevision = Readonly<{
  revisionId: string
  promptDigest: string
  providerId: string
  modelId: string
  providerJobId: string
  adapterVersion: string
  parameters: Readonly<Record<string, string | number | boolean>>
  createdAt: string
  seed?: number
  rejectionReason?: string
  visionReview?: Readonly<{ summary: string; concerns: readonly string[]; model: string }>
  metadataSuggestion?: Readonly<{ title: string; keywords: readonly string[]; model: string; humanConfirmed: boolean }>
}>

export type CreativeSessionSidecar = Readonly<{
  schemaVersion: 1
  sessionId: string
  topic: string
  rounds: readonly CreativeRound[]
  prompt: CreativePrompt
  approvals: readonly CreativeApproval[]
  revisions: readonly CreativeRevision[]
}>

export type LoadedCreativeSession = Readonly<{
  session: CreativeSessionSidecar
  snapshot: string
  checksum: string
}>

type SaveInput = Readonly<{
  directory: CreativeSessionDirectory
  manifestSnapshot: string
  session: CreativeSessionSidecar
  sidecarSnapshot: string | undefined
}>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function assertSessionId(sessionId: string): void {
  if (!UUID.test(sessionId)) throw new Error('session ID is invalid')
}

async function checksum(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function readFile(directory: CreativeSessionDirectory, name: string): Promise<string | undefined> {
  try { return (await (await directory.getFileHandle(name, { create: false })).getFile()).text() } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'NotFoundError') return undefined
    throw cause
  }
}

async function sessionDirectory(directory: CreativeSessionDirectory, create: boolean): Promise<CreativeSessionDirectory> {
  return directory.getDirectoryHandle('creative-sessions', { create })
}

function isCreativeSession(value: unknown): value is CreativeSessionSidecar {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<CreativeSessionSidecar>
  if (candidate.schemaVersion !== 1 || typeof candidate.sessionId !== 'string' || !UUID.test(candidate.sessionId)) return false
  if (typeof candidate.topic !== 'string' || !Array.isArray(candidate.rounds) || !Array.isArray(candidate.approvals) || !Array.isArray(candidate.revisions)) return false
  if (!candidate.rounds.every((round) => {
    if (typeof round !== 'object' || round === null) return false
    const item = round as Partial<CreativeRound>
    return Array.isArray(item.questions) && item.questions.length === 3
      && item.questions.every((question: unknown) => typeof question === 'string' && question.trim())
      && new Set(item.questions).size === 3
      && typeof item.recommendation === 'string' && item.recommendation.trim()
      && typeof item.createdAt === 'string' && item.createdAt.trim()
      && typeof item.model === 'string' && item.model.trim()
  })) return false
  if (!candidate.approvals.every((approval) => {
    if (typeof approval !== 'object' || approval === null) return false
    const item = approval as Partial<CreativeApproval>
    return ['concept', 'prompt', 'visual', 'metadata'].includes(item.stage ?? '')
      && typeof item.approvedAt === 'string' && item.approvedAt.trim()
      && typeof item.human === 'string' && item.human.trim()
      && (item.promptDigest === undefined || typeof item.promptDigest === 'string')
  })) return false
  if (!candidate.revisions.every((revision) => {
    if (typeof revision !== 'object' || revision === null) return false
    const item = revision as Partial<CreativeRevision>
    return typeof item.revisionId === 'string' && item.revisionId.trim()
      && typeof item.promptDigest === 'string' && item.promptDigest.trim()
      && typeof item.providerId === 'string' && item.providerId.trim()
      && typeof item.modelId === 'string' && item.modelId.trim()
      && typeof item.providerJobId === 'string' && item.providerJobId.trim()
      && typeof item.adapterVersion === 'string' && item.adapterVersion.trim()
      && typeof item.parameters === 'object' && item.parameters !== null
      && !Array.isArray(item.parameters)
      && Object.keys(item.parameters).length > 0
      && Object.values(item.parameters).every((parameter) => ['string', 'number', 'boolean'].includes(typeof parameter))
      && typeof item.createdAt === 'string' && item.createdAt.trim()
  })) return false
  const prompt = candidate.prompt
  return typeof prompt === 'object' && prompt !== null
    && typeof prompt.promptText === 'string' && prompt.promptText.trim().length > 0
    && typeof prompt.negativePrompt === 'string' && prompt.negativePrompt.trim().length > 0
    && ['photo', 'illustration', 'vector'].includes(prompt.contentType ?? '')
    && ['camera', 'manual_digital', 'generative_ai', 'mixed'].includes(prompt.creationMethod ?? '')
    && typeof prompt.providerId === 'string' && prompt.providerId.trim().length > 0
    && typeof prompt.modelId === 'string' && prompt.modelId.trim().length > 0
    && typeof prompt.targetWidth === 'number' && Number.isFinite(prompt.targetWidth) && prompt.targetWidth > 0
    && typeof prompt.targetHeight === 'number' && Number.isFinite(prompt.targetHeight) && prompt.targetHeight > 0
    && typeof prompt.aspectRatio === 'string' && prompt.aspectRatio.trim().length > 0
    && ['landscape', 'portrait', 'square'].includes(prompt.orientation ?? '')
    && Array.isArray(prompt.stockConstraints) && prompt.stockConstraints.length > 0
    && prompt.stockConstraints.every((constraint) => typeof constraint === 'string' && constraint.trim().length > 0)
    && typeof prompt.negativeSpaceDecision === 'string' && prompt.negativeSpaceDecision.trim().length > 0
}

async function assertManifestSnapshot(directory: CreativeSessionDirectory, expected: string): Promise<void> {
  if ((await readFile(directory, 'gandiwa-project.json')) !== expected) throw new Error('project manifest changed externally; reload before saving creative session')
}

export async function loadCreativeSession(directory: CreativeSessionDirectory, sessionId: string): Promise<LoadedCreativeSession | undefined> {
  assertSessionId(sessionId)
  let folder: CreativeSessionDirectory
  try { folder = await sessionDirectory(directory, false) } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'NotFoundError') return undefined
    throw cause
  }
  const snapshot = await readFile(folder, `${sessionId}.json`)
  if (snapshot === undefined) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(snapshot) } catch { throw new Error('saved creative session is invalid') }
  if (!isCreativeSession(parsed)) throw new Error('saved creative session is invalid')
  return { session: parsed, snapshot, checksum: await checksum(snapshot) }
}

export async function saveCreativeSession(input: SaveInput): Promise<LoadedCreativeSession> {
  assertSessionId(input.session.sessionId)
  if (!isCreativeSession(input.session)) throw new Error('creative session is invalid')
  await assertManifestSnapshot(input.directory, input.manifestSnapshot)
  const folder = await sessionDirectory(input.directory, true)
  const name = `${input.session.sessionId}.json`
  if ((await readFile(folder, name)) !== input.sidecarSnapshot) throw new Error('creative session changed externally; reload before saving')
  const snapshot = `${JSON.stringify(input.session, null, 2)}\n`
  await assertManifestSnapshot(input.directory, input.manifestSnapshot)
  if ((await readFile(folder, name)) !== input.sidecarSnapshot) throw new Error('creative session changed externally; reload before saving')
  const writable = await (await folder.getFileHandle(name, { create: true })).createWritable()
  await writable.write(snapshot)
  await writable.close()
  return { session: input.session, snapshot, checksum: await checksum(snapshot) }
}
