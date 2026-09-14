import type { ApprovalGateResult } from './approval-gate'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const HEX = /^[a-f0-9]{64}$/
const RULESET = 'adobe-stock-2026-09-08-v1'
const PACKAGE_KIND = 'gandiwa-portable-export'

export type ExportFormat = 'jpeg' | 'svg'
export type ExportFileName = 'final.jpeg' | 'final.svg' | 'metadata.json' | 'audit-report.json' | 'approval.json' | 'gandiwa-project.json'
export type ExportFileEntry = Readonly<{ path: ExportFileName; sha256: string; bytes: number }>

export type ExportManifest = Readonly<{
  schemaVersion: 1
  packageKind: typeof PACKAGE_KIND
  assetId: string
  revision: number
  submissionFormat: ExportFormat
  rulesetId: string
  rulesetVersion: string
  submissionChecksum: string
  metadataChecksum: string
  auditChecksum: string
  approvalChecksum: string
  files: readonly ExportFileEntry[]
}>

export type ExportManifestInput = Omit<ExportManifest, 'schemaVersion' | 'packageKind'>

const EXPECTED_KEYS = [
  'schemaVersion',
  'packageKind',
  'assetId',
  'revision',
  'submissionFormat',
  'rulesetId',
  'rulesetVersion',
  'submissionChecksum',
  'metadataChecksum',
  'auditChecksum',
  'approvalChecksum',
  'files',
] as const
const FILE_KEYS = ['path', 'sha256', 'bytes'] as const
const EXPECTED_TAIL_FILES: readonly ExportFileName[] = ['metadata.json', 'audit-report.json', 'approval.json', 'gandiwa-project.json']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function assertIdentity(assetId: string, revision: number, submissionChecksum: string): void {
  if (!UUID.test(assetId)) throw new Error('asset ID is invalid')
  if (!Number.isInteger(revision) || revision < 1) throw new Error('revision is invalid')
  if (!HEX.test(submissionChecksum)) throw new Error('submission checksum is invalid')
}

export function buildExportPackageName(assetId: string, revision: number, submissionChecksum: string): string {
  assertIdentity(assetId, revision, submissionChecksum)
  return `${assetId}-r${revision}-${submissionChecksum.slice(0, 16)}`
}

export function buildExportManifest(input: ExportManifestInput): ExportManifest {
  const manifest: ExportManifest = { schemaVersion: 1, packageKind: PACKAGE_KIND, ...input }
  return validateExportManifest(manifest)
}

export function validateExportManifest(value: unknown): ExportManifest {
  if (!isRecord(value) || !hasExactKeys(value, EXPECTED_KEYS)) throw new Error('export manifest is invalid')
  if (value.schemaVersion !== 1 || value.packageKind !== PACKAGE_KIND) throw new Error('export manifest identity is invalid')
  if (typeof value.assetId !== 'string' || !UUID.test(value.assetId) || !Number.isInteger(value.revision) || (value.revision as number) < 1) throw new Error('export manifest asset identity is invalid')
  if (value.submissionFormat !== 'jpeg' && value.submissionFormat !== 'svg') throw new Error('export manifest format is invalid')
  if (value.rulesetId !== RULESET || value.rulesetVersion !== RULESET) throw new Error('export manifest ruleset is invalid')
  for (const key of ['submissionChecksum', 'metadataChecksum', 'auditChecksum', 'approvalChecksum']) {
    if (typeof value[key] !== 'string' || !HEX.test(value[key])) throw new Error(`export manifest ${key} is invalid`)
  }
  if (!Array.isArray(value.files) || value.files.length !== EXPECTED_TAIL_FILES.length + 1) throw new Error('export manifest file list is invalid')
  const files = value.files as unknown[]
  const expectedFiles: readonly ExportFileName[] = [value.submissionFormat === 'jpeg' ? 'final.jpeg' : 'final.svg', ...EXPECTED_TAIL_FILES]
  const seen = new Set<string>()
  files.forEach((entry, index) => {
    if (!isRecord(entry) || !hasExactKeys(entry, FILE_KEYS)) throw new Error('export manifest file entry is invalid')
    const expectedPath = expectedFiles[index]
    if (entry.path !== expectedPath || typeof entry.path !== 'string' || seen.has(entry.path)) throw new Error('export manifest file order or path is invalid')
    if (typeof entry.sha256 !== 'string' || !HEX.test(entry.sha256)) throw new Error('export manifest file checksum is invalid')
    if (!Number.isSafeInteger(entry.bytes) || (entry.bytes as number) < 0) throw new Error('export manifest file size is invalid')
    seen.add(entry.path)
  })
  return value as unknown as ExportManifest
}

export type ExportPackageCandidate = Readonly<{
  assetId: string
  revision: number
  submissionFormat: ExportFormat
  packageName: string
  finalFileName: 'final.jpeg' | 'final.svg'
  manifestSnapshot: string
  metadataSnapshot: string
  metadataChecksum: string
  auditSnapshot: string
  auditChecksum: string
  approvalSnapshot: string
  approvalChecksum: string
  submissionBytes: Uint8Array
  submissionChecksum: string
  gate: ApprovalGateResult
}>

export type ExportWritable = Readonly<{
  write(value: string | Uint8Array): Promise<void>
  close(): Promise<void>
}>

export type ExportFileHandle = Readonly<{
  getFile(): Promise<File>
  createWritable(): Promise<ExportWritable>
}>

export type ExportDirectory = Readonly<{
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<ExportDirectory>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<ExportFileHandle>
}>

export type ExportResolverDirectory = ExportDirectory

async function readText(directory: ExportDirectory, name: string): Promise<string | undefined> {
  try {
    return await (await (await directory.getFileHandle(name, { create: false })).getFile()).text()
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'NotFoundError') return undefined
    throw cause
  }
}

async function sha256(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const source: ArrayBuffer = bytes instanceof Uint8Array ? new Uint8Array(bytes).buffer : bytes
  const digest = await crypto.subtle.digest('SHA-256', source)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function resolveExportPackageCandidate(input: Readonly<{
  directory: ExportResolverDirectory
  manifest: import('@gandiwa/contracts').ProjectManifest
  manifestSnapshot: string
  assetId: string
  revision: number
}>): Promise<ExportPackageCandidate> {
  const { resolveApprovalSubmission } = await import('./approval-submission')
  const { loadDurableAudit } = await import('./durable-audit-store')
  const { loadApproval } = await import('./approval-store')
  const { evaluateApprovalGate } = await import('./approval-gate')
  const { ADOBE_STOCK_MVP_RULESET_ID } = await import('@gandiwa/adobe-rules')

  const currentManifest = await readText(input.directory, 'gandiwa-project.json')
  if (currentManifest !== input.manifestSnapshot) throw new Error('project manifest changed externally; reload before export')
  let submission: Awaited<ReturnType<typeof resolveApprovalSubmission>>
  try {
    submission = await resolveApprovalSubmission({
      directory: input.directory,
      manifest: input.manifest,
      manifestSnapshot: input.manifestSnapshot,
      assetId: input.assetId,
      revision: input.revision,
    })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'NotFoundError') throw new Error('metadata is missing; export is blocked', { cause })
    throw cause
  }
  let metadataDirectory: ExportDirectory
  try {
    metadataDirectory = await input.directory.getDirectoryHandle('metadata', { create: false })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'NotFoundError') throw new Error('metadata is missing; export is blocked', { cause })
    throw cause
  }
  const metadataSnapshot = await readText(metadataDirectory, `${input.assetId}.json`)
  if (metadataSnapshot === undefined) throw new Error('metadata is missing; export is blocked')
  const metadataChecksum = await sha256(new TextEncoder().encode(metadataSnapshot))
  if (metadataChecksum !== submission.metadataChecksum) throw new Error('metadata changed while resolving export')
  const savedAudit = await loadDurableAudit(input.directory, input.assetId, input.revision)
  if (!savedAudit) throw new Error('durable audit is missing; export is blocked')
  const savedApproval = await loadApproval(input.directory, input.assetId, input.revision)
  if (!savedApproval) throw new Error('human approval is missing; export is blocked')
  const gate = evaluateApprovalGate({
    assetId: submission.assetId,
    revision: submission.revision,
    submissionChecksum: submission.submissionChecksum,
    metadataChecksum: submission.metadataChecksum,
    auditChecksum: savedAudit.checksum,
    rulesetId: ADOBE_STOCK_MVP_RULESET_ID,
    rulesetVersion: ADOBE_STOCK_MVP_RULESET_ID,
    metadataValid: true,
    audit: savedAudit.audit,
    approval: savedApproval.record,
  })
  if (gate.status !== 'APPROVED / ADOBE-READY' || !gate.adobeReady || gate.exportGate !== 'CLEAR') {
    throw new Error(`export is blocked: ${gate.reasons.join(' ')}`)
  }
  const submissionBytes = new Uint8Array(await submission.file.arrayBuffer())
  const actualChecksum = await sha256(submissionBytes)
  if (actualChecksum !== submission.submissionChecksum) throw new Error('submission changed while resolving export')
  const approvalDirectory = await input.directory.getDirectoryHandle('reports', { create: false }).then((reports) => reports.getDirectoryHandle('approvals', { create: false }))
  const approvalSnapshot = await readText(approvalDirectory, `${input.assetId}-r${input.revision}.json`)
  if (approvalSnapshot === undefined || approvalSnapshot !== savedApproval.snapshot) throw new Error('approval changed while resolving export')
  const format = input.manifest.assets.find((asset) => asset.asset_id === input.assetId)?.revisions.find((candidate) => candidate.revision === input.revision)?.submission_format
  if (format !== 'jpeg' && format !== 'svg') throw new Error('submission format is invalid for export')
  return {
    assetId: submission.assetId,
    revision: submission.revision,
    submissionFormat: format,
    packageName: buildExportPackageName(submission.assetId, submission.revision, submission.submissionChecksum),
    finalFileName: format === 'jpeg' ? 'final.jpeg' : 'final.svg',
    manifestSnapshot: input.manifestSnapshot,
    metadataSnapshot,
    metadataChecksum: submission.metadataChecksum,
    auditSnapshot: savedAudit.snapshot,
    auditChecksum: savedAudit.checksum,
    approvalSnapshot: savedApproval.snapshot,
    approvalChecksum: await sha256(new TextEncoder().encode(savedApproval.snapshot)),
    submissionBytes,
    submissionChecksum: submission.submissionChecksum,
    gate,
  }
}

export async function writeExportPackage(input: Readonly<{
  directory: ExportDirectory
  candidate: ExportPackageCandidate
  verifyCurrentEvidence: () => Promise<void>
}>): Promise<Readonly<{ packageName: string; exportManifest: ExportManifest; exportManifestSnapshot: string }>> {
  await input.verifyCurrentEvidence()
  const exports = await input.directory.getDirectoryHandle('exports', { create: false })
  try { await exports.getDirectoryHandle(input.candidate.packageName, { create: false }); throw new Error('export package already exists; refusing to overwrite') } catch (cause) { if (!(cause instanceof DOMException && cause.name === 'NotFoundError')) throw cause }
  const packageDirectory = await exports.getDirectoryHandle(input.candidate.packageName, { create: true })
  await input.verifyCurrentEvidence()
  const files: Array<{ path: ExportFileName; data: string | Uint8Array }> = [
    { path: input.candidate.finalFileName, data: input.candidate.submissionBytes },
    { path: 'metadata.json', data: input.candidate.metadataSnapshot },
    { path: 'audit-report.json', data: input.candidate.auditSnapshot },
    { path: 'approval.json', data: input.candidate.approvalSnapshot },
    { path: 'gandiwa-project.json', data: input.candidate.manifestSnapshot },
  ]
  const entries: ExportFileEntry[] = []
  for (const file of files) {
    try { await packageDirectory.getFileHandle(file.path, { create: false }); throw new Error(`refusing to overwrite export file: ${file.path}`) } catch (cause) { if (!(cause instanceof DOMException && cause.name === 'NotFoundError')) throw cause }
    const writable = await (await packageDirectory.getFileHandle(file.path, { create: true })).createWritable()
    await writable.write(file.data); await writable.close()
    const bytes = typeof file.data === 'string' ? new TextEncoder().encode(file.data) : file.data
    const fileChecksum = await sha256(bytes)
    if (file.path === input.candidate.finalFileName && fileChecksum !== input.candidate.submissionChecksum) {
      throw new Error('submission checksum does not match the approval candidate')
    }
    entries.push({ path: file.path, sha256: fileChecksum, bytes: bytes.byteLength })
  }
  await input.verifyCurrentEvidence()
  const exportManifest = buildExportManifest({ assetId: input.candidate.assetId, revision: input.candidate.revision, submissionFormat: input.candidate.submissionFormat, rulesetId: RULESET, rulesetVersion: RULESET, submissionChecksum: input.candidate.submissionChecksum, metadataChecksum: input.candidate.metadataChecksum, auditChecksum: input.candidate.auditChecksum, approvalChecksum: input.candidate.approvalChecksum, files: entries })
  const exportManifestSnapshot = `${JSON.stringify(exportManifest, null, 2)}\n`
  try { await packageDirectory.getFileHandle('export-manifest.json', { create: false }); throw new Error('refusing to overwrite export-manifest.json') } catch (cause) { if (!(cause instanceof DOMException && cause.name === 'NotFoundError')) throw cause }
  await input.verifyCurrentEvidence()
  const markerHandle = await packageDirectory.getFileHandle('export-manifest.json', { create: true })
  await input.verifyCurrentEvidence()
  const marker = await markerHandle.createWritable()
  await input.verifyCurrentEvidence()
  await marker.write(exportManifestSnapshot)
  await input.verifyCurrentEvidence()
  await marker.close()
  await input.verifyCurrentEvidence()
  return { packageName: input.candidate.packageName, exportManifest, exportManifestSnapshot }
}

export function buildExportManifestFromCandidate(input: Readonly<{
  candidate: ExportPackageCandidate
  files: readonly ExportFileEntry[]
}>): ExportManifest {
  return buildExportManifest({
    assetId: input.candidate.assetId,
    revision: input.candidate.revision,
    submissionFormat: input.candidate.submissionFormat,
    rulesetId: RULESET,
    rulesetVersion: RULESET,
    submissionChecksum: input.candidate.submissionChecksum,
    metadataChecksum: input.candidate.metadataChecksum,
    auditChecksum: input.candidate.auditChecksum,
    approvalChecksum: input.candidate.approvalChecksum,
    files: input.files,
  })
}
