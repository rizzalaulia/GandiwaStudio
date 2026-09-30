import { validateProjectManifest, type ProjectManifest } from '@gandiwa/contracts'

export type MasterSelectionRecord = Readonly<{
  schemaVersion: 1
  assetId: string
  revision: number
  relativePath: string
  revisionChecksum: string
  selectedAt: string
  selectedBy: string
}>

export type LoadedMasterSelection = Readonly<{
  record: MasterSelectionRecord
  snapshot: string
}>

type ReadableFile = Readonly<{
  text(): Promise<string>
  arrayBuffer(): Promise<ArrayBuffer>
}>

type MasterFileHandle = Readonly<{
  getFile(): Promise<ReadableFile>
  createWritable(): Promise<Readonly<{
    write(value: string): Promise<void>
    close(): Promise<void>
  }>>
}>

export type MasterSelectionDirectory = Readonly<{
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MasterSelectionDirectory>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<MasterFileHandle>
}>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const HEX = /^[a-f0-9]{64}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/
const RECORD_KEYS = [
  'schemaVersion',
  'assetId',
  'revision',
  'relativePath',
  'revisionChecksum',
  'selectedAt',
  'selectedBy',
] as const
const FILE_NAME = 'master-selection.json'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value)
  return keys.length === RECORD_KEYS.length && RECORD_KEYS.every((key) => Object.hasOwn(value, key))
}

export function validateMasterSelection(value: unknown): MasterSelectionRecord {
  if (!isRecord(value) || !hasExactKeys(value)) throw new Error('master selection is invalid')
  if (
    value.schemaVersion !== 1
    || typeof value.assetId !== 'string'
    || !UUID.test(value.assetId)
    || !Number.isInteger(value.revision)
    || (value.revision as number) < 1
    || typeof value.relativePath !== 'string'
    || typeof value.revisionChecksum !== 'string'
    || !HEX.test(value.revisionChecksum)
    || typeof value.selectedAt !== 'string'
    || !ISO.test(value.selectedAt)
    || typeof value.selectedBy !== 'string'
    || value.selectedBy.trim().length === 0
    || value.selectedBy.length > 120
  ) throw new Error('master selection is invalid')
  assertSafeRevisionPath(value.relativePath, value.assetId)
  return value as unknown as MasterSelectionRecord
}

function assertSafeRevisionPath(relativePath: string, assetId: string): void {
  const segments = relativePath.split('/')
  if (
    segments.length < 3
    || segments[0] !== 'revisions'
    || segments[1] !== assetId
    || segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) throw new Error('master revision path is invalid')
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function readFile(directory: MasterSelectionDirectory, name: string): Promise<string | undefined> {
  try {
    return await (await (await directory.getFileHandle(name, { create: false })).getFile()).text()
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'NotFoundError') return undefined
    throw cause
  }
}

async function assertManifestSnapshot(directory: MasterSelectionDirectory, expected: string): Promise<ProjectManifest> {
  const current = await readFile(directory, 'gandiwa-project.json')
  if (current !== expected) throw new Error('project manifest changed externally; reload before selecting master')
  let parsed: unknown
  try { parsed = JSON.parse(expected) } catch { throw new Error('project manifest is invalid') }
  return validateProjectManifest(parsed)
}

async function readRevisionBytes(
  directory: MasterSelectionDirectory,
  relativePath: string,
  assetId: string,
): Promise<ArrayBuffer> {
  assertSafeRevisionPath(relativePath, assetId)
  const segments = relativePath.split('/')
  const name = segments.pop()
  if (!name) throw new Error('master revision path is invalid')
  let current = directory
  for (const segment of segments) current = await current.getDirectoryHandle(segment, { create: false })
  return (await (await current.getFileHandle(name, { create: false })).getFile()).arrayBuffer()
}

export async function resolveMasterSelection(input: Readonly<{
  directory: MasterSelectionDirectory
  manifestSnapshot: string
  assetId: string
  revision: number
  selectedAt: string
  selectedBy: string
}>): Promise<MasterSelectionRecord> {
  const manifest = await assertManifestSnapshot(input.directory, input.manifestSnapshot)
  const asset = manifest.assets.find((candidate) => candidate.asset_id === input.assetId)
  const revision = asset?.revisions.find((candidate) => candidate.revision === input.revision)
  if (!asset || !revision) throw new Error('selected master revision does not exist')
  const bytes = await readRevisionBytes(input.directory, revision.relative_path, asset.asset_id)
  return validateMasterSelection({
    schemaVersion: 1,
    assetId: asset.asset_id,
    revision: revision.revision,
    relativePath: revision.relative_path,
    revisionChecksum: await sha256(bytes),
    selectedAt: input.selectedAt,
    selectedBy: input.selectedBy.trim(),
  })
}

export async function loadMasterSelection(
  directory: MasterSelectionDirectory,
  manifestSnapshot: string,
): Promise<LoadedMasterSelection | undefined> {
  const manifest = await assertManifestSnapshot(directory, manifestSnapshot)
  let reports: MasterSelectionDirectory
  try {
    reports = await directory.getDirectoryHandle('reports', { create: false })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'NotFoundError') return undefined
    throw cause
  }
  const snapshot = await readFile(reports, FILE_NAME)
  if (snapshot === undefined) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(snapshot) } catch { throw new Error('master selection is invalid') }
  const record = validateMasterSelection(parsed)
  const asset = manifest.assets.find((candidate) => candidate.asset_id === record.assetId)
  const revision = asset?.revisions.find((candidate) => candidate.revision === record.revision)
  if (!revision || revision.relative_path !== record.relativePath) throw new Error('master selection is stale')
  const checksum = await sha256(await readRevisionBytes(directory, record.relativePath, record.assetId))
  if (checksum !== record.revisionChecksum) throw new Error('master selection is stale')
  return { record, snapshot }
}

export async function peekMasterSelection(
  directory: MasterSelectionDirectory,
): Promise<LoadedMasterSelection | undefined> {
  let reports: MasterSelectionDirectory
  try {
    reports = await directory.getDirectoryHandle('reports', { create: false })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'NotFoundError') return undefined
    throw cause
  }
  const snapshot = await readFile(reports, FILE_NAME)
  if (snapshot === undefined) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(snapshot) } catch { throw new Error('master selection is invalid') }
  const record = validateMasterSelection(parsed)
  const checksum = await sha256(await readRevisionBytes(directory, record.relativePath, record.assetId))
  if (checksum !== record.revisionChecksum) throw new Error('master selection is stale')
  return { record, snapshot }
}

export function isSameMasterEvidence(
  left: LoadedMasterSelection | undefined,
  right: LoadedMasterSelection | undefined,
): boolean {
  return left?.snapshot === right?.snapshot
}

export async function saveMasterSelection(input: Readonly<{
  directory: MasterSelectionDirectory
  manifestSnapshot: string
  record: MasterSelectionRecord
  previousSnapshot?: string
}>): Promise<LoadedMasterSelection> {
  const record = validateMasterSelection(input.record)
  await assertManifestSnapshot(input.directory, input.manifestSnapshot)
  const reports = await input.directory.getDirectoryHandle('reports', { create: true })
  const current = await readFile(reports, FILE_NAME)
  if (current !== input.previousSnapshot) throw new Error('master selection changed externally; reload before saving')
  const resolved = await resolveMasterSelection({
    directory: input.directory,
    manifestSnapshot: input.manifestSnapshot,
    assetId: record.assetId,
    revision: record.revision,
    selectedAt: record.selectedAt,
    selectedBy: record.selectedBy,
  })
  if (resolved.relativePath !== record.relativePath || resolved.revisionChecksum !== record.revisionChecksum) {
    throw new Error('master revision changed externally; reload before saving')
  }
  const snapshot = `${JSON.stringify(record, null, 2)}\n`
  if (await readFile(reports, FILE_NAME) !== input.previousSnapshot) {
    throw new Error('master selection changed externally; reload before saving')
  }
  const writable = await (await reports.getFileHandle(FILE_NAME, { create: true })).createWritable()
  await writable.write(snapshot)
  await writable.close()
  return { record, snapshot }
}
