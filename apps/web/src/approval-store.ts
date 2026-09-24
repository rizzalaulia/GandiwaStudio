import { ADOBE_STOCK_MVP_RULESET_ID } from '@gandiwa/adobe-rules'
import type { ApprovalRecord } from './approval-gate'
import type { AuditDirectory } from './durable-audit-store'
import { validateMasterSelection } from './master-selection-store'

export type LoadedApproval = Readonly<{ record: ApprovalRecord; snapshot: string }>
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const HEX = /^[a-f0-9]{64}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/
const KEYS = ['schemaVersion', 'status', 'assetId', 'revision', 'submissionChecksum', 'metadataChecksum', 'auditChecksum', 'rulesetId', 'rulesetVersion', 'approvedAt', 'statementVersion'] as const

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function valid(value: unknown): value is ApprovalRecord {
  if (!isRecord(value) || Object.keys(value).length !== KEYS.length || !KEYS.every((key) => Object.hasOwn(value, key))) return false
  return value.schemaVersion === 1 && value.status === 'APPROVED' && value.statementVersion === 1
    && typeof value.assetId === 'string' && UUID.test(value.assetId)
    && Number.isInteger(value.revision) && (value.revision as number) > 0
    && typeof value.submissionChecksum === 'string' && HEX.test(value.submissionChecksum)
    && typeof value.metadataChecksum === 'string' && HEX.test(value.metadataChecksum)
    && typeof value.auditChecksum === 'string' && HEX.test(value.auditChecksum)
    && value.rulesetId === ADOBE_STOCK_MVP_RULESET_ID && value.rulesetVersion === ADOBE_STOCK_MVP_RULESET_ID
    && typeof value.approvedAt === 'string' && ISO.test(value.approvedAt)
}
async function read(directory: AuditDirectory, name: string): Promise<string | undefined> {
  try { return await (await (await directory.getFileHandle(name, { create: false })).getFile()).text() }
  catch (cause) { if (cause instanceof DOMException && cause.name === 'NotFoundError') return undefined; throw cause }
}
async function readNested(directory: AuditDirectory, folders: readonly string[], name: string): Promise<string | undefined> {
  try {
    let current = directory
    for (const folder of folders) current = await current.getDirectoryHandle(folder, { create: false })
    return await read(current, name)
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'NotFoundError') return undefined
    throw cause
  }
}

function expectedEvidence(input: Readonly<{ metadataSnapshot: string; auditSnapshot: string }>, metadata: string | undefined, audit: string | undefined): void {
  if (metadata !== input.metadataSnapshot || audit !== input.auditSnapshot) throw new Error('metadata or audit evidence changed externally; reload and audit again')
}

async function readMaster(directory: AuditDirectory): Promise<string | undefined> {
  return readNested(directory, ['reports'], 'master-selection.json')
}

async function assertMasterBinding(
  directory: AuditDirectory,
  assetId: string,
  revision: number,
  expectedSnapshot: string | undefined,
): Promise<string | undefined> {
  const onDisk = await readMaster(directory)
  if (onDisk !== expectedSnapshot) throw new Error('master selection changed externally; reload before saving approval')
  if (onDisk === undefined) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(onDisk) } catch { throw new Error('master selection is invalid') }
  const record = validateMasterSelection(parsed)
  if (record.assetId !== assetId || record.revision !== revision) {
    throw new Error('approval target is not the selected master revision; select master again')
  }
  return onDisk
}

async function assertEvidence(directory: AuditDirectory, assetId: string, revision: number, input: Readonly<{ metadataSnapshot: string; auditSnapshot: string }>): Promise<void> {
  expectedEvidence(
    input,
    await readNested(directory, ['metadata'], `${assetId}.json`),
    await readNested(directory, ['reports', 'audits'], `${assetId}-r${revision}.json`),
  )
}
async function identity(directory: AuditDirectory, assetId: string, revision: number, create: boolean) {
  if (!UUID.test(assetId) || !Number.isInteger(revision) || revision < 1) throw new Error('approval identity is invalid')
  const reports = await directory.getDirectoryHandle('reports', { create: false })
  return reports.getDirectoryHandle('approvals', { create })
}

export async function loadApproval(directory: AuditDirectory, assetId: string, revision: number): Promise<LoadedApproval | undefined> {
  let approvals: AuditDirectory
  try { approvals = await identity(directory, assetId, revision, false) } catch (cause) { if (cause instanceof DOMException && cause.name === 'NotFoundError') return undefined; throw cause }
  const snapshot = await read(approvals, `${assetId}-r${revision}.json`)
  if (snapshot === undefined) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(snapshot) } catch { throw new Error('approval record is invalid') }
  if (!valid(parsed) || parsed.assetId !== assetId || parsed.revision !== revision) throw new Error('approval record is invalid')
  return { record: parsed, snapshot }
}

export async function saveApproval(input: Readonly<{ directory: AuditDirectory; manifestSnapshot: string; metadataSnapshot: string; auditSnapshot: string; masterSelectionSnapshot?: string; record: ApprovalRecord; existingSnapshot?: string }>): Promise<LoadedApproval> {
  if (!valid(input.record)) throw new Error('approval record is invalid')
  if (await read(input.directory, 'gandiwa-project.json') !== input.manifestSnapshot) throw new Error('project manifest changed externally; reload before saving approval')
  await assertEvidence(input.directory, input.record.assetId, input.record.revision, input)
  const masterBinding = await assertMasterBinding(input.directory, input.record.assetId, input.record.revision, input.masterSelectionSnapshot)
  const approvals = await identity(input.directory, input.record.assetId, input.record.revision, true)
  const name = `${input.record.assetId}-r${input.record.revision}.json`
  const current = await read(approvals, name)
  if (current !== input.existingSnapshot) throw new Error('approval changed externally; reload before saving')
  const snapshot = `${JSON.stringify(input.record, null, 2)}\n`
  if (await read(input.directory, 'gandiwa-project.json') !== input.manifestSnapshot || await read(approvals, name) !== input.existingSnapshot) throw new Error('approval changed externally; reload before saving')
  await assertEvidence(input.directory, input.record.assetId, input.record.revision, input)
  if (await readMaster(input.directory) !== masterBinding) throw new Error('master selection changed externally; reload before saving approval')
  const writable = await (await approvals.getFileHandle(name, { create: true })).createWritable()
  await writable.write(snapshot)
  await writable.close()
  return { record: input.record, snapshot }
}
