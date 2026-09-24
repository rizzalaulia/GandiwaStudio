import { ADOBE_STOCK_MVP_RULESET_ID } from '@gandiwa/adobe-rules'
import { validateProjectManifest, type ProjectManifest } from '@gandiwa/contracts'

import { verdictForFinding } from './audit-center'
import type { DurableAuditSnapshot } from './approval-gate'
import { loadDurableAudit, saveDurableAudit, type AuditDirectory } from './durable-audit-store'
import { preflightRaster, type RasterPreflightReport } from './raster-preflight'
import { preflightSvg, type SvgPreflightReport } from './svg-preflight'
import { loadStockMetadata, type MetadataDirectory } from './stock-metadata-store'

export type RevisionAuditDirectory = AuditDirectory & MetadataDirectory
export type RevisionAuditTarget = Readonly<{
  assetId: string
  revision: number
  file: File
  relativePath: string
  contentType: ProjectManifest['assets'][number]['content_type']
  creationMethod: ProjectManifest['assets'][number]['creation_method']
  revisionChecksum: string
  metadataChecksum: string
  manifestSnapshot: string
}>

export type RevisionAuditResult = Readonly<{
  audit: DurableAuditSnapshot
  snapshot: string
  checksum: string
  status: 'PASS' | 'WARNING' | 'FAIL' | 'STALE'
}>

export class MetadataEvidenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MetadataEvidenceError'
  }
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function readManifest(directory: RevisionAuditDirectory): Promise<string> {
  return (await (await directory.getFileHandle('gandiwa-project.json', { create: false })).getFile()).text()
}

function assertSafePath(path: string, assetId: string): string[] {
  const segments = path.split('/')
  if (
    segments.length < 3
    || segments[0] !== 'revisions'
    || segments[1] !== assetId
    || segments.some((segment) => !SAFE_SEGMENT.test(segment) || segment === '.' || segment === '..')
  ) throw new Error('revision path is invalid')
  return segments
}

export async function resolveRevisionAuditTarget(input: Readonly<{
  directory: RevisionAuditDirectory
  manifestSnapshot: string
  assetId: string
  revision: number
}>): Promise<RevisionAuditTarget> {
  if (await readManifest(input.directory) !== input.manifestSnapshot) {
    throw new Error('project manifest changed externally; reload before audit')
  }
  let raw: unknown
  try { raw = JSON.parse(input.manifestSnapshot) } catch { throw new Error('project manifest is invalid') }
  const manifest = validateProjectManifest(raw)
  const asset = manifest.assets.find((candidate) => candidate.asset_id === input.assetId)
  const revision = asset?.revisions.find((candidate) => candidate.revision === input.revision)
  if (!asset || !revision) throw new Error('selected audit revision does not exist')
  const segments = assertSafePath(revision.relative_path, asset.asset_id)
  const fileName = segments.pop()
  if (!fileName) throw new Error('revision path is invalid')
  let parent: RevisionAuditDirectory = input.directory
  for (const segment of segments) parent = await parent.getDirectoryHandle(segment, { create: false })
  const sourceFile = await (await parent.getFileHandle(fileName, { create: false })).getFile() as File
  const bytes = await sourceFile.arrayBuffer()
  const extension = fileName.split('.').at(-1)?.toLowerCase()
  const mediaType = extension === 'svg'
    ? 'image/svg+xml'
    : extension === 'jpeg' || extension === 'jpg'
      ? 'image/jpeg'
      : extension === 'png'
        ? 'image/png'
        : sourceFile.type
  const file = new File([bytes], fileName, { type: mediaType })
  const revisionChecksum = await sha256(bytes)
  const metadata = await loadStockMetadata(input.directory, asset.asset_id, {
    contentType: asset.content_type,
    creationMethod: asset.creation_method,
  }).catch((error: unknown) => {
    if (error instanceof MetadataEvidenceError) throw error
    throw new MetadataEvidenceError(error instanceof Error ? error.message : 'saved metadata is invalid')
  })
  if (!metadata) throw new MetadataEvidenceError('metadata is missing; save valid metadata before audit')
  return {
    assetId: asset.asset_id,
    revision: revision.revision,
    file,
    relativePath: revision.relative_path,
    contentType: asset.content_type,
    creationMethod: asset.creation_method,
    revisionChecksum,
    metadataChecksum: metadata.checksum,
    manifestSnapshot: input.manifestSnapshot,
  }
}

function statusForFindings(findings: DurableAuditSnapshot['findings']): 'PASS' | 'WARNING' | 'FAIL' {
  if (findings.some((finding) => finding.verdict === 'FAIL')) return 'FAIL'
  if (findings.some((finding) => finding.verdict === 'WARNING')) return 'WARNING'
  return 'PASS'
}

function findingsFromReport(
  report: RasterPreflightReport | SvgPreflightReport,
  target: RevisionAuditTarget,
): DurableAuditSnapshot['findings'] {
  return report.findings.map((finding) => ({
    ruleId: finding.rule_id,
    verdict: verdictForFinding(finding.rule_id, report.verdict),
    message: finding.message,
    evidence: {
      source: target.file.type === 'image/svg+xml' ? 'SVG security preflight' : 'Raster technical preflight',
      assetId: target.assetId,
      revision: target.revision,
      relativePath: target.relativePath,
      revisionChecksum: target.revisionChecksum,
      reportVerdict: report.verdict,
      eligibleForSubmission: report.eligible_for_submission,
    },
  }))
}

export async function runRevisionAudit(input: Readonly<{
  directory: RevisionAuditDirectory
  manifestSnapshot: string
  assetId: string
  revision: number
  previousAuditSnapshot?: string
  fetchImpl?: typeof fetch
  now?: () => string
}>): Promise<RevisionAuditResult> {
  const target = await resolveRevisionAuditTarget(input)
  const fetchImpl = input.fetchImpl ?? fetch
  const report = target.file.type === 'image/svg+xml'
    ? await preflightSvg(target.file, target.contentType === 'vector' ? 'vector' : 'illustration', fetchImpl)
    : await preflightRaster(target.file, target.contentType === 'vector' ? 'photo' : target.contentType, fetchImpl)
  const findings = findingsFromReport(report, target)
  const audit: DurableAuditSnapshot = {
    schemaVersion: 1,
    assetId: target.assetId,
    revision: target.revision,
    submissionChecksum: target.revisionChecksum,
    metadataChecksum: target.metadataChecksum,
    rulesetId: ADOBE_STOCK_MVP_RULESET_ID,
    rulesetVersion: ADOBE_STOCK_MVP_RULESET_ID,
    findings,
    createdAt: (input.now ?? (() => new Date().toISOString()))(),
  }
  const saved = await saveDurableAudit({
    directory: input.directory,
    manifestSnapshot: input.manifestSnapshot,
    audit,
    ...(input.previousAuditSnapshot === undefined ? {} : { sidecarSnapshot: input.previousAuditSnapshot }),
    verifyCurrentEvidence: async () => {
      const current = await resolveRevisionAuditTarget(input)
      if (
        current.revisionChecksum !== target.revisionChecksum
        || current.metadataChecksum !== target.metadataChecksum
      ) throw new Error('revision or metadata changed during audit; run audit again')
    },
  })
  return { ...saved, status: statusForFindings(findings) }
}

export async function loadCurrentRevisionAudit(input: Readonly<{
  directory: RevisionAuditDirectory
  manifestSnapshot: string
  assetId: string
  revision: number
}>): Promise<RevisionAuditResult | undefined> {
  const loaded = await loadDurableAudit(input.directory, input.assetId, input.revision)
  if (!loaded) return undefined
  let target: RevisionAuditTarget
  try {
    target = await resolveRevisionAuditTarget(input)
  } catch (error) {
    // Evidence lama tetap dipulihkan bila hanya metadata/revision bytes yang
    // berubah: status WAJIB STALE (tidak pernah valid), dan snapshot utuh
    // supaya audit ulang bisa CAS menimpa sidecar ini secara sah.
    if (error instanceof MetadataEvidenceError) return { ...loaded, status: 'STALE' }
    throw error
  }
  const audit = loaded.audit
  const stale = audit.assetId !== target.assetId
    || audit.revision !== target.revision
    || audit.submissionChecksum !== target.revisionChecksum
    || audit.metadataChecksum !== target.metadataChecksum
    || audit.rulesetId !== ADOBE_STOCK_MVP_RULESET_ID
    || audit.rulesetVersion !== ADOBE_STOCK_MVP_RULESET_ID
  return { ...loaded, status: stale ? 'STALE' : statusForFindings(audit.findings) }
}
