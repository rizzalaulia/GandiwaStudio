import { describe, expect, it } from 'vitest'

import {
  loadMasterSelection,
  peekMasterSelection,
  resolveMasterSelection,
  saveMasterSelection,
  type MasterSelectionDirectory,
} from './master-selection-store'

const PROJECT_ID = '1e5c8a02-7b34-4c19-9e2a-6d0f3b8c5a71'
const ASSET_ID = '3f2b8a64-9c1d-4e7a-b2f5-8d60c1a94e21'
const REVISION_BYTES = new Uint8Array([1, 2, 3, 4])

class MemoryFile {
  content: string | Uint8Array

  constructor(content: string | Uint8Array = '') {
    this.content = content
  }

  getFile() {
    return Promise.resolve({
      text: () => Promise.resolve(typeof this.content === 'string'
        ? this.content
        : new TextDecoder().decode(this.content)),
      arrayBuffer: () => Promise.resolve((typeof this.content === 'string'
        ? new TextEncoder().encode(this.content)
        : this.content).slice().buffer),
    })
  }

  createWritable() {
    return Promise.resolve({
      write: (value: string) => {
        this.content = value
        return Promise.resolve()
      },
      close: () => Promise.resolve(),
    })
  }
}

class MemoryDirectory implements MasterSelectionDirectory {
  readonly files = new Map<string, MemoryFile>()
  readonly directories = new Map<string, MemoryDirectory>()

  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MemoryDirectory> {
    const existing = this.directories.get(name)
    if (existing) return Promise.resolve(existing)
    if (!options?.create) return Promise.reject(new DOMException('missing', 'NotFoundError'))
    const created = new MemoryDirectory()
    this.directories.set(name, created)
    return Promise.resolve(created)
  }

  getFileHandle(name: string, options?: { create?: boolean }): Promise<MemoryFile> {
    const existing = this.files.get(name)
    if (existing) return Promise.resolve(existing)
    if (!options?.create) return Promise.reject(new DOMException('missing', 'NotFoundError'))
    const created = new MemoryFile()
    this.files.set(name, created)
    return Promise.resolve(created)
  }
}

function setup() {
  const manifest = {
    schema_version: 1,
    project_id: PROJECT_ID,
    project_name: 'Master evidence',
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
  root.files.set('gandiwa-project.json', new MemoryFile(manifestSnapshot))
  root.directories.set('reports', new MemoryDirectory())
  const revisions = new MemoryDirectory()
  const asset = new MemoryDirectory()
  asset.files.set('rev-1.png', new MemoryFile(REVISION_BYTES))
  revisions.directories.set(ASSET_ID, asset)
  root.directories.set('revisions', revisions)
  return { root, manifestSnapshot, revisionFile: asset.files.get('rev-1.png')! }
}

async function recordFor(root: MemoryDirectory, manifestSnapshot: string) {
  return resolveMasterSelection({
    directory: root,
    manifestSnapshot,
    assetId: ASSET_ID,
    revision: 1,
    selectedAt: '2026-09-24T00:00:00.000Z',
    selectedBy: 'Master Peng',
  })
}

describe('durable master selection store', () => {
  it('saves and reopens revision-bound master evidence', async () => {
    const { root, manifestSnapshot } = setup()
    const record = await recordFor(root, manifestSnapshot)
    const saved = await saveMasterSelection({ directory: root, manifestSnapshot, record })
    const loaded = await loadMasterSelection(root, manifestSnapshot)

    expect(saved.snapshot).toContain('"schemaVersion": 1')
    expect(loaded?.record).toEqual(record)
    expect(loaded?.record.revisionChecksum).toMatch(/^[a-f0-9]{64}$/)
  })

  it('refuses selection when the project manifest changed externally', async () => {
    const { root, manifestSnapshot } = setup()
    root.files.get('gandiwa-project.json')!.content = `${manifestSnapshot}\n`

    await expect(recordFor(root, manifestSnapshot)).rejects.toThrow(/manifest changed externally/)
  })

  it('marks persisted master evidence stale when revision bytes change', async () => {
    const { root, manifestSnapshot, revisionFile } = setup()
    const record = await recordFor(root, manifestSnapshot)
    await saveMasterSelection({ directory: root, manifestSnapshot, record })
    revisionFile.content = new Uint8Array([9, 9, 9, 9])

    await expect(loadMasterSelection(root, manifestSnapshot)).rejects.toThrow(/master selection is stale/)
  })

  it('refuses to overwrite a master sidecar that appeared externally', async () => {
    const { root, manifestSnapshot } = setup()
    const record = await recordFor(root, manifestSnapshot)
    root.directories.get('reports')!.files.set('master-selection.json', new MemoryFile('{}\n'))

    await expect(saveMasterSelection({ directory: root, manifestSnapshot, record }))
      .rejects.toThrow(/changed externally/)
  })

  it('peeks the master evidence without requiring the manifest snapshot', async () => {
    const { root, manifestSnapshot } = setup()
    const record = await recordFor(root, manifestSnapshot)
    await saveMasterSelection({ directory: root, manifestSnapshot, record })

    const peeked = await peekMasterSelection(root)
    expect(peeked?.record).toEqual(record)
  })

  it('rejects a peek when the master revision bytes changed', async () => {
    const { root, manifestSnapshot, revisionFile } = setup()
    const record = await recordFor(root, manifestSnapshot)
    await saveMasterSelection({ directory: root, manifestSnapshot, record })
    revisionFile.content = new Uint8Array([7, 7, 7, 7])

    await expect(peekMasterSelection(root)).rejects.toThrow(/master selection is stale/)
  })

  it('returns undefined for a peek when no master sidecar exists', async () => {
    const { root } = setup()

    await expect(peekMasterSelection(root)).resolves.toBeUndefined()
  })
})
