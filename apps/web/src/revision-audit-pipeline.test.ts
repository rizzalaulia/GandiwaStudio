import { describe, expect, it, vi } from 'vitest'

import type { RevisionAuditDirectory } from './revision-audit-pipeline'
import { loadCurrentRevisionAudit, runRevisionAudit } from './revision-audit-pipeline'

const PROJECT_ID = '1e5c8a02-7b34-4c19-9e2a-6d0f3b8c5a71'
const ASSET_ID = '3f2b8a64-9c1d-4e7a-b2f5-8d60c1a94e21'

class MemoryHandle {
  content: BlobPart
  type: string
  name: string

  constructor(content: BlobPart = '', name = 'file.txt', type = 'text/plain') {
    this.content = content
    this.name = name
    this.type = type
  }

  getFile() {
    return Promise.resolve(new File([this.content], this.name, { type: this.type }))
  }

  createWritable() {
    return Promise.resolve({
      write: (value: string) => { this.content = value; return Promise.resolve() },
      close: () => Promise.resolve(),
    })
  }
}

class MemoryDirectory implements RevisionAuditDirectory {
  readonly files = new Map<string, MemoryHandle>()
  readonly directories = new Map<string, MemoryDirectory>()

  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MemoryDirectory> {
    const existing = this.directories.get(name)
    if (existing) return Promise.resolve(existing)
    if (!options?.create) return Promise.reject(new DOMException('missing', 'NotFoundError'))
    const created = new MemoryDirectory()
    this.directories.set(name, created)
    return Promise.resolve(created)
  }

  getFileHandle(name: string, options?: { create?: boolean }): Promise<MemoryHandle> {
    const existing = this.files.get(name)
    if (existing) return Promise.resolve(existing)
    if (!options?.create) return Promise.reject(new DOMException('missing', 'NotFoundError'))
    const created = new MemoryHandle('', name)
    this.files.set(name, created)
    return Promise.resolve(created)
  }
}

function setup(withMetadata = true) {
  const manifest = {
    schema_version: 1,
    project_id: PROJECT_ID,
    project_name: 'Revision audit',
    assets: [{
      asset_id: ASSET_ID,
      content_type: 'illustration',
      creation_method: 'generative_ai',
      revisions: [{
        revision: 1,
        generation_format: 'png',
        working_format: 'png',
        master_format: 'png',
        submission_format: 'jpeg',
        relative_path: `revisions/${ASSET_ID}/rev-1.png`,
      }],
    }],
  }
  const manifestSnapshot = JSON.stringify(manifest)
  const root = new MemoryDirectory()
  root.files.set('gandiwa-project.json', new MemoryHandle(manifestSnapshot, 'gandiwa-project.json', 'application/json'))
  const revisions = new MemoryDirectory()
  const asset = new MemoryDirectory()
  const revision = new MemoryHandle(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]), 'rev-1.png', 'image/png')
  asset.files.set('rev-1.png', revision)
  revisions.directories.set(ASSET_ID, asset)
  root.directories.set('revisions', revisions)
  root.directories.set('reports', new MemoryDirectory())
  const metadata = new MemoryDirectory()
  if (withMetadata) {
    metadata.files.set(`${ASSET_ID}.json`, new MemoryHandle(`${JSON.stringify({
      schemaVersion: 1,
      title: 'Ceramic cup with soft studio light',
      keywords: ['ceramic', 'cup', 'studio', 'minimal', 'illustration'],
      category: 'Objects',
      contentType: 'illustration',
      creationMethod: 'generative_ai',
      generatedWithAi: true,
      aiDisclosure: 'Created with generative AI.',
      releaseStatus: 'not_required',
    }, null, 2)}\n`, `${ASSET_ID}.json`, 'application/json'))
  }
  root.directories.set('metadata', metadata)
  return { root, manifestSnapshot, revision }
}

function rasterFetch(verdict: 'warning' | 'fail' = 'fail') {
  return vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ csrf_token: 'csrf-1' }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({
      verdict,
      detected_mime_type: 'image/png',
      detected_extension: 'png',
      width: 2000,
      height: 2000,
      megapixels: 4,
      has_alpha: false,
      eligible_for_submission: false,
      findings: [{ rule_id: 'illustration-raster.submission-format', message: 'Final submission must be JPEG.' }],
    }), { status: 200 }))
}

describe('revision audit pipeline', () => {
  it('preflights selected revision bytes and persists revision/checksum/ruleset-bound evidence', async () => {
    const { root, manifestSnapshot } = setup()
    const fetchImpl = rasterFetch('warning')
    const result = await runRevisionAudit({
      directory: root,
      manifestSnapshot,
      assetId: ASSET_ID,
      revision: 1,
      fetchImpl,
      now: () => '2026-09-24T00:00:00.000Z',
    })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(result.status).toBe('FAIL')
    expect(result.audit.assetId).toBe(ASSET_ID)
    expect(result.audit.revision).toBe(1)
    expect(result.audit.submissionChecksum).toMatch(/^[a-f0-9]{64}$/)
    expect(result.audit.metadataChecksum).toMatch(/^[a-f0-9]{64}$/)
    expect(result.audit.findings[0]?.ruleId).toBe('illustration-raster.submission-format')
    expect(await loadCurrentRevisionAudit({ directory: root, manifestSnapshot, assetId: ASSET_ID, revision: 1 }))
      .toMatchObject({ status: 'FAIL' })
  })

  it('keeps the sidecar snapshot when revision bytes make durable evidence stale so rerun can replace it', async () => {
    const { root, manifestSnapshot, revision } = setup()
    await runRevisionAudit({
      directory: root,
      manifestSnapshot,
      assetId: ASSET_ID,
      revision: 1,
      fetchImpl: rasterFetch('warning'),
      now: () => '2026-09-24T00:00:00.000Z',
    })
    revision.content = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9])

    const stale = await loadCurrentRevisionAudit({ directory: root, manifestSnapshot, assetId: ASSET_ID, revision: 1 })
    expect(stale).toMatchObject({ status: 'STALE' })
    expect(stale?.snapshot).toContain('"revision": 1')

    const rerun = await runRevisionAudit({
      directory: root,
      manifestSnapshot,
      assetId: ASSET_ID,
      revision: 1,
      ...(stale?.snapshot === undefined ? {} : { previousAuditSnapshot: stale.snapshot }),
      fetchImpl: rasterFetch('warning'),
      now: () => '2026-09-24T00:01:00.000Z',
    })
    expect(rerun.status).toBe('FAIL')
    expect(rerun.audit.submissionChecksum).not.toBe(stale?.audit.submissionChecksum)
  })

  it('blocks before network preflight when valid metadata evidence is missing', async () => {
    const { root, manifestSnapshot } = setup(false)
    const fetchImpl = rasterFetch('warning')

    await expect(runRevisionAudit({
      directory: root,
      manifestSnapshot,
      assetId: ASSET_ID,
      revision: 1,
      fetchImpl,
    })).rejects.toThrow(/metadata is missing/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('preserves an existing audit snapshot as STALE when metadata disappears so a repaired rerun can CAS safely', async () => {
    const { root, manifestSnapshot } = setup()
    const first = await runRevisionAudit({
      directory: root,
      manifestSnapshot,
      assetId: ASSET_ID,
      revision: 1,
      fetchImpl: rasterFetch('warning'),
    })
    root.directories.get('metadata')!.files.delete(`${ASSET_ID}.json`)

    const stale = await loadCurrentRevisionAudit({ directory: root, manifestSnapshot, assetId: ASSET_ID, revision: 1 })
    expect(stale).toMatchObject({ status: 'STALE', snapshot: first.snapshot })
  })
})
