/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it } from 'vitest'
import {
  buildExportPackageName,
  buildExportManifest,
  validateExportManifest,
  writeExportPackage,
  type ExportManifest,
  type ExportPackageCandidate,
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

async function hashFixture(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function approvedFixture(format: 'jpeg' | 'svg', master: 'current' | 'other' | 'none' = 'current') {
  const root = node()
  const submissionBytes = format === 'jpeg'
    ? new Uint8Array([0xff, 0xd8, 0xff, 0xd9])
    : new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>')
  const submissionChecksum = await hashFixture(submissionBytes)
  const metadataSnapshot = JSON.stringify({ schemaVersion: 1, title: 'Bird', keywords: ['bird', 'sky', 'sea', 'light', 'nature'], category: 'animals', contentType: format === 'jpeg' ? 'photo' : 'vector', creationMethod: 'camera', generatedWithAi: false, aiDisclosure: '', releaseStatus: 'not_required' }) + '\n'
  const metadataChecksum = await hashFixture(metadataSnapshot)
  const manifest = { schema_version: 1 as const, project_id: assetId, project_name: 'Test', assets: [{ asset_id: assetId, content_type: format === 'jpeg' ? 'photo' as const : 'vector' as const, creation_method: 'camera' as const, revisions: [{ revision: 2, generation_format: format, working_format: format, master_format: format, submission_format: format, relative_path: `revisions/${assetId}/2/master.${format}` }] }] }
  const manifestSnapshot = JSON.stringify(manifest)
  root.files.set('gandiwa-project.json', new File([manifestSnapshot], 'gandiwa-project.json'))
  const revisions = node(); const asset = node(); const revision = node()
  revision.files.set(`master.${format}`, new File([submissionBytes], `master.${format}`))
  if (format === 'jpeg') revision.files.set('preparation.json', new File([JSON.stringify({ submission_checksum: submissionChecksum })], 'preparation.json'))
  asset.dirs.set('2', revision); revisions.dirs.set(assetId, asset); root.dirs.set('revisions', revisions)
  const metadata = node(); metadata.files.set(`${assetId}.json`, new File([metadataSnapshot], `${assetId}.json`)); root.dirs.set('metadata', metadata)
  const auditSnapshot = JSON.stringify({ schemaVersion: 1, assetId, revision: 2, submissionChecksum, metadataChecksum, rulesetId: 'adobe-stock-2026-09-08-v1', rulesetVersion: 'adobe-stock-2026-09-08-v1', findings: [], createdAt: '2026-09-13T00:00:00.000Z' }) + '\n'
  const auditChecksum = await hashFixture(auditSnapshot)
  const approvalSnapshot = JSON.stringify({ schemaVersion: 1, status: 'APPROVED', assetId, revision: 2, submissionChecksum, metadataChecksum, auditChecksum, rulesetId: 'adobe-stock-2026-09-08-v1', rulesetVersion: 'adobe-stock-2026-09-08-v1', approvedAt: '2026-09-13T00:00:00.000Z', statementVersion: 1 }) + '\n'
  const reports = node(); const audits = node(); const approvals = node()
  audits.files.set(`${assetId}-r2.json`, new File([auditSnapshot], `${assetId}-r2.json`)); approvals.files.set(`${assetId}-r2.json`, new File([approvalSnapshot], `${assetId}-r2.json`)); reports.dirs.set('audits', audits); reports.dirs.set('approvals', approvals); root.dirs.set('reports', reports)
  if (master === 'current') {
    const masterRecord = { schemaVersion: 1, assetId, revision: 2, relativePath: `revisions/${assetId}/2/master.${format}`, revisionChecksum: submissionChecksum, selectedAt: '2026-09-13T00:00:00.000Z', selectedBy: 'Master Peng' }
    reports.files.set('master-selection.json', new File([`${JSON.stringify(masterRecord)}\n`], 'master-selection.json'))
  }
  if (master === 'other') {
    const otherBytes = new Uint8Array([0x11, 0x22, 0x33, 0x44])
    const otherChecksum = await hashFixture(otherBytes)
    const otherRevision = node(); const assetDirectory = revisions.dirs.get(assetId)!
    otherRevision.files.set('master.jpeg', new File([otherBytes], 'master.jpeg'))
    assetDirectory.dirs.set('1', otherRevision)
    const masterRecord = { schemaVersion: 1, assetId, revision: 1, relativePath: `revisions/${assetId}/1/master.jpeg`, revisionChecksum: otherChecksum, selectedAt: '2026-09-13T00:00:00.000Z', selectedBy: 'Master Peng' }
    reports.files.set('master-selection.json', new File([`${JSON.stringify(masterRecord)}\n`], 'master-selection.json'))
  }
  return { root, manifest, manifestSnapshot, submissionChecksum, metadataChecksum, auditSnapshot, auditChecksum, approvalSnapshot }
}

async function resolveFixture(format: 'jpeg' | 'svg') {
  const fixture = await approvedFixture(format)
  const { resolveExportPackageCandidate } = await import('./export-package')
  const candidate = await resolveExportPackageCandidate({ directory: directory(fixture.root) as never, manifest: fixture.manifest, manifestSnapshot: fixture.manifestSnapshot, assetId, revision: 2 })
  return { fixture, candidate }
}

function candidate(format: 'jpeg' | 'svg'): ExportPackageCandidate {
  return {
    assetId,
    revision: 2,
    submissionFormat: format,
    packageName: `${assetId}-r2-${'a'.repeat(16)}`,
    finalFileName: format === 'jpeg' ? 'final.jpeg' : 'final.svg',
    manifestSnapshot: '{"schema_version":1}',
    metadataSnapshot: '{"metadata":true}\n',
    metadataChecksum: 'b'.repeat(64),
    auditSnapshot: '{"audit":true}\n',
    auditChecksum: 'c'.repeat(64),
    approvalSnapshot: '{"approval":true}\n',
    approvalChecksum: 'd'.repeat(64),
    submissionBytes: format === 'jpeg' ? new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) : new TextEncoder().encode('<svg></svg>'),
    submissionChecksum: format === 'jpeg' ? '32461d5bd1773012acef0ba15636752949bd7c2ce50f9172159d9f56cf0dd9af' : 'b12e0d83ce2357d80b89c57694814d0a3abdaf8c40724f2049af8b7f01b7812b',
    gate: { status: 'APPROVED / ADOBE-READY', adobeReady: true, exportGate: 'CLEAR', reasons: [] },
  }
}

type WriteNode = { files: Map<string, { content: string | Uint8Array }>; dirs: Map<string, WriteNode> }
const writeNode = (): WriteNode => ({ files: new Map(), dirs: new Map() })

function writableDirectory(root: WriteNode, events: string[] = []) {
  return {
    getDirectoryHandle: async (name: string, options?: { create?: boolean }) => {
      events.push(`dir:${name}:${options?.create === true ? 'create' : 'read'}`)
      const existing = root.dirs.get(name)
      if (!existing && !options?.create) throw new DOMException('missing', 'NotFoundError')
      const result = existing ?? writeNode()
      root.dirs.set(name, result)
      return writableDirectory(result, events)
    },
    getFileHandle: async (name: string, options?: { create?: boolean }) => {
      events.push(`file:${name}:${options?.create === true ? 'create' : 'read'}`)
      const existing = root.files.get(name)
      if (!existing && !options?.create) throw new DOMException('missing', 'NotFoundError')
      const result = existing ?? { content: '' }
      root.files.set(name, result)
      return {
        createWritable: async () => ({ write: async (content: string | Uint8Array) => { result.content = content; events.push(`write:${name}`) }, close: async () => { events.push(`close:${name}`) } }),
      }
    },
  }
}

describe('export package writer', () => {
  it('writes a JPEG package and writes the completion marker last', async () => {
    const root = writeNode(); root.dirs.set('exports', writeNode()); const events: string[] = []
    const result = await writeExportPackage({ directory: writableDirectory(root, events) as never, candidate: candidate('jpeg'), verifyCurrentEvidence: async () => { events.push('verify') } })
    expect(result.packageName).toBe(`${assetId}-r2-${'a'.repeat(16)}`)
    const packageNode = root.dirs.get('exports')?.dirs.get(result.packageName)
    expect(packageNode?.files.has('final.jpeg')).toBe(true)
    expect(packageNode?.files.has('export-manifest.json')).toBe(true)
    const markerWrite = events.lastIndexOf('write:export-manifest.json')
    expect(markerWrite).toBeGreaterThan(-1)
    const filesystemEvents = events.filter((event) => event !== 'verify')
    expect(filesystemEvents.at(-1)).toBe('close:export-manifest.json')
    expect(events.slice(markerWrite + 1)).not.toContain('write:final.jpeg')
  })

  it('writes final.svg for a vector candidate', async () => {
    const root = writeNode(); root.dirs.set('exports', writeNode())
    const result = await writeExportPackage({ directory: writableDirectory(root) as never, candidate: candidate('svg'), verifyCurrentEvidence: async () => undefined })
    const packageNode = root.dirs.get('exports')?.dirs.get(result.packageName)
    expect(packageNode?.files.has('final.svg')).toBe(true)
    expect(packageNode?.files.has('final.jpeg')).toBe(false)
  })

  it('rejects final bytes whose checksum differs from the candidate binding', async () => {
    const root = writeNode(); root.dirs.set('exports', writeNode())
    const mismatched = { ...candidate('jpeg'), submissionChecksum: 'f'.repeat(64) }
    await expect(writeExportPackage({ directory: writableDirectory(root) as never, candidate: mismatched, verifyCurrentEvidence: async () => undefined })).rejects.toThrow(/submission checksum/)
    const packageNode = root.dirs.get('exports')?.dirs.get(mismatched.packageName)
    expect(packageNode?.files.has('export-manifest.json')).toBe(false)
  })

  it('refuses to overwrite an existing package directory', async () => {
    const root = writeNode(); const exports = writeNode(); root.dirs.set('exports', exports)
    exports.dirs.set(candidate('jpeg').packageName, writeNode())
    await expect(writeExportPackage({ directory: writableDirectory(root) as never, candidate: candidate('jpeg'), verifyCurrentEvidence: async () => undefined })).rejects.toThrow(/already exists|overwrite/)
  })

  it('refuses a completion marker that appears before publication', async () => {
    const root = writeNode(); const exports = writeNode(); root.dirs.set('exports', exports)
    let verificationCount = 0
    await expect(writeExportPackage({
      directory: writableDirectory(root) as never,
      candidate: candidate('jpeg'),
      verifyCurrentEvidence: async () => {
        verificationCount += 1
        if (verificationCount === 3) exports.dirs.get(candidate('jpeg').packageName)?.files.set('export-manifest.json', { content: 'intruder' })
      },
    })).rejects.toThrow(/export-manifest|overwrite/)
    expect(exports.dirs.get(candidate('jpeg').packageName)?.files.get('export-manifest.json')?.content).toBe('intruder')
  })

  it('does not publish a valid marker when evidence is invalidated after marker handle creation', async () => {
    const root = writeNode(); root.dirs.set('exports', writeNode())
    let verificationCount = 0
    await expect(writeExportPackage({
      directory: writableDirectory(root) as never,
      candidate: candidate('jpeg'),
      verifyCurrentEvidence: async () => {
        verificationCount += 1
        if (verificationCount === 5) throw new Error('export superseded')
      },
    })).rejects.toThrow('export superseded')
    const marker = root.dirs.get('exports')?.dirs.get(candidate('jpeg').packageName)?.files.get('export-manifest.json')
    expect(marker?.content).toBe('')
  })

  it('does not return export success when evidence is invalidated after marker close', async () => {
    const root = writeNode(); root.dirs.set('exports', writeNode())
    let verificationCount = 0
    await expect(writeExportPackage({
      directory: writableDirectory(root) as never,
      candidate: candidate('jpeg'),
      verifyCurrentEvidence: async () => {
        verificationCount += 1
        if (verificationCount === 8) throw new Error('export superseded after close')
      },
    })).rejects.toThrow('export superseded after close')
  })

  it('does not write a completion marker when final verification fails', async () => {
    const root = writeNode(); root.dirs.set('exports', writeNode())
    await expect(writeExportPackage({ directory: writableDirectory(root) as never, candidate: candidate('jpeg'), verifyCurrentEvidence: async () => { throw new Error('evidence changed') } })).rejects.toThrow('evidence changed')
    expect([...root.dirs.values()][0]?.files.has('export-manifest.json')).toBe(false)
  })
})

describe('export package contract', () => {
  it('resolves an approved JPEG candidate end-to-end', async () => {
    const { fixture, candidate } = await resolveFixture('jpeg')
    expect(candidate.finalFileName).toBe('final.jpeg')
    expect(candidate.submissionChecksum).toBe(fixture.submissionChecksum)
    expect(candidate.metadataChecksum).toBe(fixture.metadataChecksum)
    expect(candidate.gate.status).toBe('APPROVED / ADOBE-READY')
    expect(fixture.root.dirs.has('exports')).toBe(false)
  })

  it('resolves an approved SVG candidate end-to-end', async () => {
    const { candidate } = await resolveFixture('svg')
    expect(candidate.finalFileName).toBe('final.svg')
    expect(candidate.submissionFormat).toBe('svg')
    expect(candidate.gate.exportGate).toBe('CLEAR')
  })

  it('rejects a stale audit binding before producing a candidate', async () => {
    const fixture = await approvedFixture('jpeg')
    const audit = fixture.root.dirs.get('reports')!.dirs.get('audits')!
    const file = audit.files.get(`${assetId}-r2.json`)!
    audit.files.set(`${assetId}-r2.json`, new File([fixture.auditSnapshot.replace(fixture.submissionChecksum, 'f'.repeat(64))], file.name))
    const { resolveExportPackageCandidate } = await import('./export-package')
    await expect(resolveExportPackageCandidate({ directory: directory(fixture.root) as never, manifest: fixture.manifest, manifestSnapshot: fixture.manifestSnapshot, assetId, revision: 2 })).rejects.toThrow()
  })

  it('rejects a malformed audit before producing a candidate', async () => {
    const fixture = await approvedFixture('jpeg')
    const audit = fixture.root.dirs.get('reports')!.dirs.get('audits')!
    audit.files.set(`${assetId}-r2.json`, new File(['{"findings":[null]}'], `${assetId}-r2.json`))
    const { resolveExportPackageCandidate } = await import('./export-package')
    await expect(resolveExportPackageCandidate({ directory: directory(fixture.root) as never, manifest: fixture.manifest, manifestSnapshot: fixture.manifestSnapshot, assetId, revision: 2 })).rejects.toThrow(/audit/i)
  })

  it('rejects an export when no master revision was ever selected', async () => {
    const fixture = await approvedFixture('jpeg', 'none')
    const { resolveExportPackageCandidate } = await import('./export-package')
    await expect(resolveExportPackageCandidate({ directory: directory(fixture.root) as never, manifest: fixture.manifest, manifestSnapshot: fixture.manifestSnapshot, assetId, revision: 2 }))
      .rejects.toThrow(/master selection/i)
  })

  it('rejects an export when the selected master is a different revision', async () => {
    const fixture = await approvedFixture('jpeg', 'other')
    const { resolveExportPackageCandidate } = await import('./export-package')
    await expect(resolveExportPackageCandidate({ directory: directory(fixture.root) as never, manifest: fixture.manifest, manifestSnapshot: fixture.manifestSnapshot, assetId, revision: 2 }))
      .rejects.toThrow(/master selection/i)
  })

  it('re-verifies the master binding when revision bytes drift from the sidecar', async () => {
    const fixture = await approvedFixture('jpeg')
    const revisionDirectory = fixture.root.dirs.get('revisions')!.dirs.get(assetId)!.dirs.get('2')!
    revisionDirectory.files.set('master.jpeg', new File([new Uint8Array([0xde, 0xad, 0xbe, 0xef])], 'master.jpeg'))
    const { resolveExportPackageCandidate } = await import('./export-package')
    await expect(resolveExportPackageCandidate({ directory: directory(fixture.root) as never, manifest: fixture.manifest, manifestSnapshot: fixture.manifestSnapshot, assetId, revision: 2 }))
      .rejects.toThrow(/master|submission|stale/i)
  })

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
