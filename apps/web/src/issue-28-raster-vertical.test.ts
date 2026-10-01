/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/require-await */
import { type ProjectManifest } from '@gandiwa/contracts'
import { describe, expect, it, vi } from 'vitest'

import { evaluateApprovalGate } from './approval-gate'
import { resolveApprovalSubmission } from './approval-submission'
import { saveApproval } from './approval-store'
import { recordGeneratedRevision } from './beranda/generated-revision-store'
import { loadDurableAudit } from './durable-audit-store'
import { resolveExportPackageCandidate, writeExportPackage } from './export-package'
import { resolveMasterSelection, saveMasterSelection } from './master-selection-store'
import { prepareRasterForSubmission } from './raster-preparation'
import { runRevisionAudit } from './revision-audit-pipeline'
import { saveStockMetadata } from './stock-metadata-store'

const PHOTO_ID = '123e4567-e89b-12d3-a456-426614174000'
const GENERATED_ID = '3f2b8a64-9c1d-4e7a-b2f5-8d60c1a94e21'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])
const JPEG_SHA256 = '32461d5bd1773012acef0ba15636752949bd7c2ce50f9172159d9f56cf0dd9af'

class MemoryFile {
  content: BlobPart = ''

  constructor(private readonly name: string) {}

  getFile() {
    return Promise.resolve(new File([this.content], this.name))
  }

  createWritable() {
    return Promise.resolve({
      write: async (value: BlobPart) => { this.content = value },
      close: async (): Promise<void> => {},
    })
  }
}

class MemoryDirectory {
  readonly files = new Map<string, MemoryFile>()
  readonly directories = new Map<string, MemoryDirectory>()

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MemoryDirectory> {
    const existing = this.directories.get(name)
    if (existing) return existing
    if (!options?.create) throw new DOMException('missing', 'NotFoundError')
    const created = new MemoryDirectory()
    this.directories.set(name, created)
    return created
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<MemoryFile> {
    const existing = this.files.get(name)
    if (existing) return existing
    if (!options?.create) throw new DOMException('missing', 'NotFoundError')
    const created = new MemoryFile(name)
    this.files.set(name, created)
    return created
  }
}

function projectRoot(): MemoryDirectory {
  const root = new MemoryDirectory()
  root.directories.set('revisions', new MemoryDirectory())
  root.directories.set('metadata', new MemoryDirectory())
  root.directories.set('reports', new MemoryDirectory())
  root.directories.set('exports', new MemoryDirectory())
  return root
}

async function snapshot(root: MemoryDirectory): Promise<string> {
  return (await root.getFileHandle('gandiwa-project.json')).getFile().then((file) => file.text())
}

async function bytes(root: MemoryDirectory, path: string): Promise<Uint8Array> {
  let directory = root
  const segments = path.split('/')
  const name = segments.pop()!
  for (const segment of segments) directory = await directory.getDirectoryHandle(segment)
  return new Uint8Array(await (await (await directory.getFileHandle(name)).getFile()).arrayBuffer())
}

function rasterFetch(verdict: 'pass' | 'fail') {
  return vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ csrf_token: 'csrf-issue-28' }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({
      verdict,
      detected_mime_type: 'image/jpeg',
      detected_extension: 'jpeg',
      width: 2000,
      height: 2000,
      megapixels: 4,
      has_alpha: false,
      eligible_for_submission: verdict === 'pass',
      findings: verdict === 'pass' ? [] : [{ rule_id: 'illustration-raster.submission-format', message: 'Final submission must be JPEG.' }],
    }), { status: 200 }))
}

const cameraMetadata = {
  schemaVersion: 1 as const,
  title: 'Sea bird over calm water',
  keywords: ['bird', 'sea', 'water', 'nature', 'coast'],
  category: 'Animals',
  contentType: 'photo' as const,
  creationMethod: 'camera' as const,
  generatedWithAi: false,
  aiDisclosure: '',
  releaseStatus: 'not_required' as const,
}

const generatedMetadata = {
  schemaVersion: 1 as const,
  title: 'Golden cat illustration',
  keywords: ['cat', 'golden', 'illustration', 'animal', 'portrait'],
  category: 'Animals',
  contentType: 'illustration' as const,
  creationMethod: 'generative_ai' as const,
  generatedWithAi: true,
  aiDisclosure: 'Created with generative AI and curated by the contributor.',
  releaseStatus: 'not_required' as const,
}

describe('Issue 28 raster verticals', () => {
  it('prepares a camera photo through metadata, audit, approval, and portable export', async () => {
    const root = projectRoot()
    const initial = { schema_version: 1 as const, project_id: PHOTO_ID, project_name: 'Camera photo', assets: [] }
    const initialSnapshot = `${JSON.stringify(initial)}\n`
    ;(await root.getFileHandle('gandiwa-project.json', { create: true })).content = initialSnapshot

    const prepared = await prepareRasterForSubmission({
      manifest: initial,
      manifestSnapshot: initialSnapshot,
      source: new File([PNG], 'camera.png', { type: 'image/png' }),
      contentType: 'photo',
      creationMethod: 'camera',
      quality: 0.92,
    }, {
      directory: root,
      newId: () => PHOTO_ID,
      encodeJpeg: async () => ({ bytes: JPEG, width: 2000, height: 2000, alphaHandling: 'flatten-white', colorConversion: 'browser-canvas-to-srgb' }),
    })
    const manifestSnapshot = await snapshot(root)
    const metadata = await saveStockMetadata({
      directory: root,
      manifestSnapshot,
      assetId: PHOTO_ID,
      provenance: { contentType: 'photo', creationMethod: 'camera' },
      metadata: cameraMetadata,
      sidecarSnapshot: undefined,
    })
    const audit = await runRevisionAudit({ directory: root, manifestSnapshot, assetId: PHOTO_ID, revision: 2, fetchImpl: rasterFetch('pass'), now: () => '2026-10-01T00:00:00.000Z' })
    const masterRecord = await resolveMasterSelection({ directory: root, manifestSnapshot, assetId: PHOTO_ID, revision: 2, selectedAt: '2026-10-01T00:00:01.000Z', selectedBy: 'Master Peng' })
    const master = await saveMasterSelection({ directory: root, manifestSnapshot, record: masterRecord })
    const submission = await resolveApprovalSubmission({ directory: root, manifest: prepared.manifest, manifestSnapshot, assetId: PHOTO_ID, revision: 2 })
    const beforeApproval = evaluateApprovalGate({
      assetId: PHOTO_ID, revision: 2, submissionChecksum: submission.submissionChecksum, metadataChecksum: metadata.checksum,
      auditChecksum: audit.checksum, rulesetId: audit.audit.rulesetId, rulesetVersion: audit.audit.rulesetVersion, metadataValid: true, audit: audit.audit,
    })
    expect(beforeApproval).toMatchObject({ status: 'READY FOR HUMAN APPROVAL', exportGate: 'BLOCKED' })

    const approvalRecord = {
      schemaVersion: 1 as const, status: 'APPROVED' as const, assetId: PHOTO_ID, revision: 2,
      submissionChecksum: submission.submissionChecksum, metadataChecksum: metadata.checksum, auditChecksum: audit.checksum,
      rulesetId: audit.audit.rulesetId, rulesetVersion: audit.audit.rulesetVersion, approvedAt: '2026-10-01T00:00:02.000Z', statementVersion: 1 as const,
    }
    await saveApproval({ directory: root, manifestSnapshot, metadataSnapshot: metadata.snapshot, auditSnapshot: audit.snapshot, masterSelectionSnapshot: master.snapshot, record: approvalRecord })
    const candidate = await resolveExportPackageCandidate({ directory: root as never, manifest: prepared.manifest, manifestSnapshot, assetId: PHOTO_ID, revision: 2 })
    const exported = await writeExportPackage({ directory: root as never, candidate, verifyCurrentEvidence: async () => undefined })

    expect(prepared.manifest.assets[0]).toMatchObject({ content_type: 'photo', creation_method: 'camera' })
    expect(audit.status).toBe('PASS')
    expect(candidate.gate).toMatchObject({ status: 'APPROVED / ADOBE-READY', exportGate: 'CLEAR' })
    expect(candidate.submissionBytes).toEqual(JPEG)
    expect(await bytes(root, `exports/${exported.packageName}/final.jpeg`)).toEqual(JPEG)
    expect(await bytes(root, `exports/${exported.packageName}/export-manifest.json`)).not.toHaveLength(0)
  })

  it('keeps generated candidate bytes available while disclosure-backed metadata and a failed audit block approval and export', async () => {
    const root = projectRoot()
    const manifest = {
      schema_version: 1 as const,
      project_id: GENERATED_ID,
      project_name: 'Generated illustration',
      assets: [],
    }
    const manifestSnapshot = JSON.stringify(manifest)
    ;(await root.getFileHandle('gandiwa-project.json', { create: true })).content = manifestSnapshot
    const session = {
      schemaVersion: 1 as const,
      sessionId: GENERATED_ID,
      topic: 'Golden cat',
      rounds: [],
      prompt: {
        promptText: 'golden cat', negativePrompt: 'watermark', contentType: 'illustration' as const, creationMethod: 'generative_ai' as const,
        providerId: 'fake', modelId: 'fake-model', targetWidth: 2000, targetHeight: 2000, aspectRatio: '1:1', orientation: 'square' as const,
        stockConstraints: ['no_logo'], negativeSpaceDecision: 'none',
      },
      approvals: [{ stage: 'prompt' as const, approvedAt: '2026-10-01T00:00:00.000Z', human: 'Master Peng', promptDigest: 'a'.repeat(64) }],
      revisions: [],
    }
    let published: ProjectManifest = manifest
    const outcome = await recordGeneratedRevision({
      directory: root,
      manifestSnapshot,
      persistedSession: { session, snapshot: 'creative-session', checksum: 'b'.repeat(64) },
      jobId: 'job-28',
      artifact: { id: 'artifact-28', media_type: 'image/jpeg', size_bytes: JPEG.byteLength, sha256: JPEG_SHA256 },
      fetchArtifact: async () => ({ bytes: JPEG, sha256Header: JPEG_SHA256 }),
      saveSidecar: async () => ({ session, snapshot: 'creative-session-next', checksum: 'c'.repeat(64) }),
      publishManifest: async (next) => {
        published = next
        ;(await root.getFileHandle('gandiwa-project.json')).content = JSON.stringify(next)
      },
    })
    const publishedSnapshot = await snapshot(root)
    const metadata = await saveStockMetadata({
      directory: root,
      manifestSnapshot: publishedSnapshot,
      assetId: GENERATED_ID,
      provenance: { contentType: 'illustration', creationMethod: 'generative_ai' },
      metadata: generatedMetadata,
      sidecarSnapshot: undefined,
    })
    const audit = await runRevisionAudit({ directory: root, manifestSnapshot: publishedSnapshot, assetId: GENERATED_ID, revision: 1, fetchImpl: rasterFetch('fail'), now: () => '2026-10-01T00:00:03.000Z' })
    const durable = await loadDurableAudit(root, GENERATED_ID, 1)
    const revisionDirectory = await (await root.getDirectoryHandle('revisions')).getDirectoryHandle(GENERATED_ID)
    ;(await revisionDirectory.getFileHandle('preparation.json', { create: true })).content = JSON.stringify({ submission_checksum: JPEG_SHA256 })
    const submission = await resolveApprovalSubmission({ directory: root, manifest: published, manifestSnapshot: publishedSnapshot, assetId: GENERATED_ID, revision: 1 })
    const masterRecord = await resolveMasterSelection({ directory: root, manifestSnapshot: publishedSnapshot, assetId: GENERATED_ID, revision: 1, selectedAt: '2026-10-01T00:00:04.000Z', selectedBy: 'Master Peng' })
    const master = await saveMasterSelection({ directory: root, manifestSnapshot: publishedSnapshot, record: masterRecord })
    const approvalRecord = {
      schemaVersion: 1 as const, status: 'APPROVED' as const, assetId: GENERATED_ID, revision: 1,
      submissionChecksum: submission.submissionChecksum, metadataChecksum: metadata.checksum, auditChecksum: audit.checksum,
      rulesetId: audit.audit.rulesetId, rulesetVersion: audit.audit.rulesetVersion, approvedAt: '2026-10-01T00:00:05.000Z', statementVersion: 1 as const,
    }
    await saveApproval({ directory: root, manifestSnapshot: publishedSnapshot, metadataSnapshot: metadata.snapshot, auditSnapshot: audit.snapshot, masterSelectionSnapshot: master.snapshot, record: approvalRecord })
    const gate = evaluateApprovalGate({
      assetId: GENERATED_ID, revision: 1, submissionChecksum: submission.submissionChecksum, metadataChecksum: metadata.checksum,
      auditChecksum: audit.checksum, rulesetId: audit.audit.rulesetId, rulesetVersion: audit.audit.rulesetVersion, metadataValid: true, audit: audit.audit, approval: approvalRecord,
    })

    expect(outcome.manifest.assets[0]).toMatchObject({ content_type: 'illustration', creation_method: 'generative_ai' })
    expect(metadata.metadata).toMatchObject({ generatedWithAi: true, aiDisclosure: expect.stringMatching(/generative AI/i) })
    expect(audit.status).toBe('FAIL')
    expect(durable?.audit.findings[0]).toMatchObject({ ruleId: 'illustration-raster.submission-format', verdict: 'FAIL' })
    expect(gate).toMatchObject({ status: 'STALE / BLOCKED', exportGate: 'BLOCKED' })
    await expect(resolveExportPackageCandidate({ directory: root as never, manifest: published, manifestSnapshot: publishedSnapshot, assetId: GENERATED_ID, revision: 1 })).rejects.toThrow(/export is blocked/)
    expect(outcome.bytes).toEqual(JPEG)
    expect(await bytes(root, `revisions/${GENERATED_ID}/rev-1.jpeg`)).toEqual(JPEG)
  })
})
