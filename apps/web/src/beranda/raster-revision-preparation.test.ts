import { describe, expect, it, vi } from 'vitest'

import { prepareExistingRasterRevision } from './raster-revision-preparation'

const ASSET = '3f2b8a64-9c1d-4e7a-b2f5-8d60c1a94e21'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])

class FileNode {
  content: BlobPart
  constructor(content: BlobPart, private readonly name: string) { this.content = content }
  async getFile(): Promise<File> { return new File([this.content], this.name) }
  async createWritable() {
    return {
      write: async (value: BlobPart) => { this.content = value },
      close: async (): Promise<void> => {},
    }
  }
}

class Directory {
  files = new Map<string, FileNode>()
  directories = new Map<string, Directory>()
  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<Directory> {
    const found = this.directories.get(name)
    if (found) return found
    if (!options?.create) throw new DOMException('missing', 'NotFoundError')
    const created = new Directory()
    this.directories.set(name, created)
    return created
  }
  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FileNode> {
    const found = this.files.get(name)
    if (found) return found
    if (!options?.create) throw new DOMException('missing', 'NotFoundError')
    const created = new FileNode('', name)
    this.files.set(name, created)
    return created
  }
}

function fixture() {
  const manifest = {
    schema_version: 1 as const,
    project_id: ASSET,
    project_name: 'Raster',
    assets: [{
      asset_id: ASSET,
      content_type: 'illustration' as const,
      creation_method: 'generative_ai' as const,
      revisions: [{ revision: 1, generation_format: 'png' as const, working_format: 'png' as const, master_format: 'png' as const, submission_format: 'jpeg' as const, relative_path: `revisions/${ASSET}/rev-1.png` }],
    }],
  }
  const snapshot = `${JSON.stringify(manifest, null, 2)}\n`
  const root = new Directory()
  root.files.set('gandiwa-project.json', new FileNode(snapshot, 'gandiwa-project.json'))
  const revisions = new Directory()
  const asset = new Directory()
  asset.files.set('rev-1.png', new FileNode(PNG, 'rev-1.png'))
  revisions.directories.set(ASSET, asset)
  root.directories.set('revisions', revisions)
  return { manifest, snapshot, root, asset }
}

const encode4Mp = vi.fn(async () => ({
  bytes: JPEG,
  width: 2000,
  height: 2000,
  alphaHandling: 'none' as const,
  colorConversion: 'browser-canvas-to-srgb' as const,
}))

describe('prepareExistingRasterRevision', () => {
  it('keeps the generated candidate untouched and adds a 4MP JPEG submission revision with preparation evidence', async () => {
    const { manifest, snapshot, root, asset } = fixture()
    const result = await prepareExistingRasterRevision({ directory: root, manifest, manifestSnapshot: snapshot, assetId: ASSET, sourceRevision: 1, quality: 0.92, encodeJpeg: encode4Mp })

    expect(await (await asset.getFileHandle('rev-1.png')).getFile()).toHaveProperty('size', PNG.byteLength)
    expect(result.revision).toBe(2)
    expect(result.manifest.assets[0]?.revisions.map((entry) => entry.relative_path)).toEqual([`revisions/${ASSET}/rev-1.png`, `revisions/${ASSET}/2/master.jpeg`])
    const prepared = await asset.getDirectoryHandle('2')
    expect(new Uint8Array(await (await (await prepared.getFileHandle('master.jpeg')).getFile()).arrayBuffer())).toEqual(JPEG)
    expect(JSON.parse(await (await (await prepared.getFileHandle('preparation.json')).getFile()).text())).toMatchObject({ source_revision: 1, revision: 2, width: 2000, height: 2000 })
  })

  it('rejects under-4MP output before creating a revision or changing the manifest', async () => {
    const { manifest, snapshot, root, asset } = fixture()
    await expect(prepareExistingRasterRevision({
      directory: root,
      manifest,
      manifestSnapshot: snapshot,
      assetId: ASSET,
      sourceRevision: 1,
      quality: 0.92,
      encodeJpeg: async () => ({ bytes: JPEG, width: 1999, height: 2000, alphaHandling: 'none', colorConversion: 'browser-canvas-to-srgb' }),
    })).rejects.toThrow(/at least 4 megapixels/)

    expect(asset.directories.size).toBe(0)
    expect(await (await (await root.getFileHandle('gandiwa-project.json')).getFile()).text()).toBe(snapshot)
  })
})
