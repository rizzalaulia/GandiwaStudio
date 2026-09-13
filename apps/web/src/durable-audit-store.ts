import { ADOBE_STOCK_MVP_RULESET_ID } from '@gandiwa/adobe-rules'

import type { DurableAuditSnapshot } from './approval-gate'

export type AuditFile = Readonly<{
  getFile(): Promise<Readonly<{ text(): Promise<string> }>>
  createWritable(): Promise<Readonly<{ write(value: string): Promise<void>; close(): Promise<void> }>>
}>

export type AuditDirectory = Readonly<{
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<AuditDirectory>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<AuditFile>
}>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const HEX = /^[a-f0-9]{64}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/
const FINDING_KEYS = ['ruleId', 'verdict', 'message', 'evidence'] as const
const AUDIT_KEYS = ['schemaVersion', 'assetId', 'revision', 'submissionChecksum', 'metadataChecksum', 'rulesetId', 'rulesetVersion', 'findings', 'createdAt'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key))
}

function isFinding(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, FINDING_KEYS)) return false
  const verdict = value.verdict
  return typeof value.ruleId === 'string'
    && (verdict === 'PASS' || verdict === 'WARNING' || verdict === 'FAIL')
    && typeof value.message === 'string'
    && isRecord(value.evidence)
}

export function validateDurableAudit(value: unknown): DurableAuditSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, AUDIT_KEYS)) throw new Error('audit snapshot is invalid')
  if (
    value.schemaVersion !== 1
    || typeof value.assetId !== 'string'
    || !UUID.test(value.assetId)
    || !Number.isInteger(value.revision)
    || (value.revision as number) < 1
    || typeof value.submissionChecksum !== 'string'
    || !HEX.test(value.submissionChecksum)
    || typeof value.metadataChecksum !== 'string'
    || !HEX.test(value.metadataChecksum)
    || value.rulesetId !== ADOBE_STOCK_MVP_RULESET_ID
    || value.rulesetVersion !== ADOBE_STOCK_MVP_RULESET_ID
    || !Array.isArray(value.findings)
    || !value.findings.every(isFinding)
    || typeof value.createdAt !== 'string'
    || !ISO.test(value.createdAt)
  ) throw new Error('audit snapshot is invalid')
  return value as unknown as DurableAuditSnapshot
}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function readFile(directory: AuditDirectory, name: string): Promise<string | undefined> {
  try {
    return await (await (await directory.getFileHandle(name, { create: false })).getFile()).text()
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'NotFoundError') return undefined
    throw cause
  }
}

async function readManifest(directory: AuditDirectory): Promise<string> {
  const snapshot = await readFile(directory, 'gandiwa-project.json')
  if (snapshot === undefined) throw new Error('project manifest is missing')
  return snapshot
}

export async function loadDurableAudit(
  directory: AuditDirectory,
  assetId: string,
  revision: number,
): Promise<Readonly<{ audit: DurableAuditSnapshot; snapshot: string; checksum: string }> | undefined> {
  if (!UUID.test(assetId) || !Number.isInteger(revision) || revision < 1) throw new Error('audit identity is invalid')
  let reports: AuditDirectory
  try {
    reports = await directory.getDirectoryHandle('reports', { create: false })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'NotFoundError') return undefined
    throw cause
  }
  let audits: AuditDirectory
  try {
    audits = await reports.getDirectoryHandle('audits', { create: false })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'NotFoundError') return undefined
    throw cause
  }
  const snapshot = await readFile(audits, `${assetId}-r${revision}.json`)
  if (snapshot === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(snapshot)
  } catch {
    throw new Error('audit snapshot is invalid')
  }
  const audit = validateDurableAudit(parsed)
  if (audit.assetId !== assetId || audit.revision !== revision) throw new Error('audit snapshot identity is invalid')
  return { audit, snapshot, checksum: await hash(snapshot) }
}

export async function saveDurableAudit(input: Readonly<{
  directory: AuditDirectory
  manifestSnapshot: string
  audit: DurableAuditSnapshot
  sidecarSnapshot?: string
  verifyCurrentEvidence?: () => Promise<void>
}>): Promise<Readonly<{ audit: DurableAuditSnapshot; snapshot: string; checksum: string }>> {
  const audit = validateDurableAudit(input.audit)
  if (await readManifest(input.directory) !== input.manifestSnapshot) throw new Error('project manifest changed externally; reload before saving audit')
  const reports = await input.directory.getDirectoryHandle('reports', { create: false })
  const audits = await reports.getDirectoryHandle('audits', { create: true })
  const name = `${audit.assetId}-r${audit.revision}.json`
  const current = await readFile(audits, name)
  if (current !== input.sidecarSnapshot) throw new Error('audit changed externally; reload before saving')
  const snapshot = `${JSON.stringify(audit, null, 2)}\n`
  if (await readManifest(input.directory) !== input.manifestSnapshot || await readFile(audits, name) !== input.sidecarSnapshot) {
    throw new Error('audit changed externally; reload before saving')
  }
  await input.verifyCurrentEvidence?.()
  const writable = await (await audits.getFileHandle(name, { create: true })).createWritable()
  await writable.write(snapshot)
  await writable.close()
  return { audit, snapshot, checksum: await hash(snapshot) }
}
