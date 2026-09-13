import { describe, expect, it } from 'vitest'
import {
  buildExportPackageName,
  buildExportManifest,
  validateExportManifest,
  type ExportManifest,
} from './export-package'

const assetId = '123e4567-e89b-12d3-a456-426614174000'
const checksum = 'a'.repeat(64)

const fileEntries = [
  { path: 'final.jpeg' as const, sha256: checksum, bytes: 4 },
  { path: 'metadata.json' as const, sha256: 'b'.repeat(64), bytes: 10 },
  { path: 'audit-report.json' as const, sha256: 'c'.repeat(64), bytes: 20 },
  { path: 'approval.json' as const, sha256: 'd'.repeat(64), bytes: 30 },
  { path: 'gandiwa-project.json' as const, sha256: 'e'.repeat(64), bytes: 40 },
]

function validManifest(): ExportManifest {
  return {
    schemaVersion: 1,
    packageKind: 'gandiwa-portable-export',
    assetId,
    revision: 2,
    submissionFormat: 'jpeg',
    rulesetId: 'adobe-stock-2026-09-08-v1',
    rulesetVersion: 'adobe-stock-2026-09-08-v1',
    submissionChecksum: checksum,
    metadataChecksum: 'b'.repeat(64),
    auditChecksum: 'c'.repeat(64),
    approvalChecksum: 'd'.repeat(64),
    files: fileEntries,
  }
}

type Node = { files: Map<string, File>; dirs: Map<string, Node> }
const node = (): Node => ({ files: new Map(), dirs: new Map() })
const directory = (root: Node) => ({
  getDirectoryHandle: async (name: string, options?: { create?: boolean }) => {
    await Promise.resolve()
    const child = root.dirs.get(name)
    if (!child && !options?.create) throw new DOMException('missing', 'NotFoundError')
    const result = child ?? node()
    root.dirs.set(name, result)
    return directory(result)
  },
  getFileHandle: async (name: string, options?: { create?: boolean }) => {
    await Promise.resolve()
    const file = root.files.get(name)
    if (!file && !options?.create) throw new DOMException('missing', 'NotFoundError')
    const result = file ?? new File([''], name)
    root.files.set(name, result)
    return { getFile: async () => { await Promise.resolve(); return result } }
  },
})

describe('export package contract', () => {
  it('rejects an externally changed manifest before reading export evidence', async () => {
    const root = node()
    root.files.set('gandiwa-project.json', new File(['changed'], 'gandiwa-project.json'))
    const { resolveExportPackageCandidate } = await import('./export-package')
    await expect(resolveExportPackageCandidate({
      directory: directory(root) as never,
      manifest: { schema_version: 1, project_id: assetId, project_name: 'Test', assets: [] },
      manifestSnapshot: 'expected',
      assetId,
      revision: 2,
    })).rejects.toThrow(/manifest changed externally/)
    expect(root.dirs.size).toBe(0)
  })

  it('rejects a missing metadata sidecar without creating folders', async () => {
    const root = node()
    const manifestSnapshot = 'manifest'
    root.files.set('gandiwa-project.json', new File([manifestSnapshot], 'gandiwa-project.json'))
    const { resolveExportPackageCandidate } = await import('./export-package')
    await expect(resolveExportPackageCandidate({
      directory: directory(root) as never,
      manifest: { schema_version: 1, project_id: assetId, project_name: 'Test', assets: [] },
      manifestSnapshot,
      assetId,
      revision: 2,
    })).rejects.toThrow(/asset revision is invalid/)
    expect(root.dirs.size).toBe(0)
  })

  it('rejects a missing metadata sidecar after resolving the revision', async () => {
    const root = node()
    const manifestSnapshot = 'manifest'
    root.files.set('gandiwa-project.json', new File([manifestSnapshot], 'gandiwa-project.json'))
    const revisionNode = node()
    const assetNode = node()
    const revisionDirectory = node()
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])
    revisionDirectory.files.set('master.jpeg', new File([bytes], 'master.jpeg'))
    revisionDirectory.files.set('preparation.json', new File([JSON.stringify({ submission_checksum: '32461d5bd1773012acef0ba15636752949bd7c2ce50f9172159d9f56cf0dd9af' })], 'preparation.json'))
    assetNode.dirs.set('2', revisionDirectory)
    revisionNode.dirs.set(assetId, assetNode)
    root.dirs.set('revisions', revisionNode)
    const { resolveExportPackageCandidate } = await import('./export-package')
    const manifest = { schema_version: 1 as const, project_id: assetId, project_name: 'Test', assets: [{ asset_id: assetId, content_type: 'photo' as const, creation_method: 'camera' as const, revisions: [{ revision: 2, generation_format: 'jpeg' as const, working_format: 'jpeg' as const, master_format: 'jpeg' as const, submission_format: 'jpeg' as const, relative_path: `revisions/${assetId}/2/master.jpeg` }] }] }
    await expect(resolveExportPackageCandidate({ directory: directory(root) as never, manifest, manifestSnapshot, assetId, revision: 2 })).rejects.toThrow(/metadata|metadata directory/i)
    expect(root.dirs.has('metadata')).toBe(false)
  })

  it('builds a deterministic safe package name', () => {
    expect(buildExportPackageName(assetId, 2, '32461d5bd1773012acef0ba15636752949bd7c2ce50f9172159d9f56cf0dd9af'))
      .toBe('123e4567-e89b-12d3-a456-426614174000-r2-32461d5bd1773012')
  })

  it.each([
    ['', 2, checksum],
    ['not-a-uuid', 2, checksum],
    [assetId, 0, checksum],
    [assetId, 2.5, checksum],
    [assetId, 2, 'not-a-checksum'],
  ])('rejects unsafe package identity %#', (id, revision, submissionChecksum) => {
    expect(() => buildExportPackageName(id, revision, submissionChecksum)).toThrow()
  })

  it('builds and strictly validates an SVG manifest with final.svg', () => {
    const manifest = buildExportManifest({
      assetId,
      revision: 2,
      submissionFormat: 'svg',
      rulesetId: 'adobe-stock-2026-09-08-v1',
      rulesetVersion: 'adobe-stock-2026-09-08-v1',
      submissionChecksum: checksum,
      metadataChecksum: 'b'.repeat(64),
      auditChecksum: 'c'.repeat(64),
      approvalChecksum: 'd'.repeat(64),
      files: fileEntries.map((entry, index) => index === 0 ? { ...entry, path: 'final.svg' as const } : entry),
    })
    expect(manifest.files[0]?.path).toBe('final.svg')
    expect(validateExportManifest(manifest)).toEqual(manifest)
  })

  it('builds and strictly validates the canonical manifest', () => {
    const manifest = buildExportManifest({
      assetId,
      revision: 2,
      submissionFormat: 'jpeg',
      rulesetId: 'adobe-stock-2026-09-08-v1',
      rulesetVersion: 'adobe-stock-2026-09-08-v1',
      submissionChecksum: checksum,
      metadataChecksum: 'b'.repeat(64),
      auditChecksum: 'c'.repeat(64),
      approvalChecksum: 'd'.repeat(64),
      files: fileEntries,
    })
    expect(manifest).toEqual(validManifest())
    expect(validateExportManifest(manifest)).toEqual(manifest)
  })

  it.each([
    { ...validManifest(), files: [...fileEntries, { path: 'export-manifest.json', sha256: checksum, bytes: 1 }] },
    { ...validManifest(), files: [...fileEntries].reverse() },
    { ...validManifest(), files: fileEntries.map((entry, index) => index === 0 ? { ...entry, path: '../final.jpeg' as 'final.jpeg' } : entry) },
    { ...validManifest(), files: fileEntries.map((entry, index) => index === 0 ? { ...entry, path: 'final.svg' as 'final.jpeg' } : entry) },
    { ...validManifest(), submissionChecksum: 'invalid' },
    (() => { const value = validManifest() as Record<string, unknown>; value.extra = true; return value })(),
  ])('rejects malformed manifest %#', (value) => {
    expect(() => validateExportManifest(value)).toThrow()
  })
})
