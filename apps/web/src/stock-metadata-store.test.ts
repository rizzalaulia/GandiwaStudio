import { describe, expect, it } from 'vitest'

import { loadStockMetadata, saveStockMetadata, supportsMetadataWrite, type MetadataDirectory } from './stock-metadata-store'

class File {
  content = ''
  getFile() { return Promise.resolve({ text: () => Promise.resolve(this.content) }) }
  createWritable() { return Promise.resolve({ write: (value: string) => { this.content = value; return Promise.resolve() }, close: () => Promise.resolve() }) }
}
class Directory implements MetadataDirectory {
  directories = new Map<string, Directory>()
  files = new Map<string, File>()
  getDirectoryHandle(name: string, options?: { create?: boolean }) { const found = this.directories.get(name); if (found) return Promise.resolve(found); if (!options?.create) return Promise.reject(new DOMException('missing', 'NotFoundError')); const made = new Directory(); this.directories.set(name, made); return Promise.resolve(made) }
  getFileHandle(name: string, options?: { create?: boolean }) { const found = this.files.get(name); if (found) return Promise.resolve(found); if (!options?.create) return Promise.reject(new DOMException('missing', 'NotFoundError')); const made = new File(); this.files.set(name, made); return Promise.resolve(made) }
}

const provenance = { contentType: 'illustration' as const, creationMethod: 'generative_ai' as const }
const metadata = { schemaVersion: 1 as const, title: 'Quiet lake at sunrise', keywords: ['lake', 'sunrise', 'mountain', 'nature', 'landscape'], category: 'Landscapes', contentType: 'illustration' as const, creationMethod: 'generative_ai' as const, generatedWithAi: true, aiDisclosure: 'Created with generative AI and curated by the contributor.', releaseStatus: 'not_required' as const }

describe('saveStockMetadata', () => {
  it('recognizes only directories with metadata write capabilities', () => {
    expect(supportsMetadataWrite({ getFileHandle: () => undefined })).toBe(false)
    expect(supportsMetadataWrite({ getDirectoryHandle: () => undefined, getFileHandle: () => undefined })).toBe(true)
  })

  it('writes a per-asset metadata sidecar without changing the manifest', async () => {
    const root = new Directory(); const manifest = new File(); manifest.content = '{"project":"snapshot"}'; root.files.set('gandiwa-project.json', manifest); root.directories.set('metadata', new Directory())
    await saveStockMetadata({ directory: root, manifestSnapshot: manifest.content, assetId: '123e4567-e89b-12d3-a456-426614174000', provenance, metadata, sidecarSnapshot: undefined })
    expect(manifest.content).toBe('{"project":"snapshot"}')
    expect(JSON.parse(root.directories.get('metadata')!.files.get('123e4567-e89b-12d3-a456-426614174000.json')!.content)).toEqual(metadata)
  })

  it('loads a valid saved sidecar without mutating it', async () => {
    const root = new Directory(); const metadataDirectory = new Directory(); root.directories.set('metadata', metadataDirectory)
    const file = new File(); file.content = `${JSON.stringify(metadata)}\n`; metadataDirectory.files.set('123e4567-e89b-12d3-a456-426614174000.json', file)
    const loaded = await loadStockMetadata(root, '123e4567-e89b-12d3-a456-426614174000', provenance)
    expect(loaded?.metadata).toEqual(metadata)
    expect(loaded?.snapshot).toBe(`${JSON.stringify(metadata)}\n`)
    expect(loaded?.checksum).toMatch(/^[0-9a-f]{64}$/)
    expect(file.content).toBe(`${JSON.stringify(metadata)}\n`)
  })

  it('rejects a corrupt saved sidecar', async () => {
    const root = new Directory(); const metadataDirectory = new Directory(); root.directories.set('metadata', metadataDirectory)
    const file = new File(); file.content = '{not-json'; metadataDirectory.files.set('123e4567-e89b-12d3-a456-426614174000.json', file)
    await expect(loadStockMetadata(root, '123e4567-e89b-12d3-a456-426614174000', provenance)).rejects.toThrow()
  })

  it('rejects a persisted sidecar without disclosure for generative-AI provenance', async () => {
    const root = new Directory(); const metadataDirectory = new Directory(); root.directories.set('metadata', metadataDirectory)
    const file = new File(); file.content = `${JSON.stringify({ ...metadata, creationMethod: 'camera', generatedWithAi: false, aiDisclosure: '' })}\n`; metadataDirectory.files.set('123e4567-e89b-12d3-a456-426614174000.json', file)
    await expect(loadStockMetadata(root, '123e4567-e89b-12d3-a456-426614174000', provenance)).rejects.toThrow('saved metadata is invalid')
  })

  it('refuses to overwrite a sidecar created or changed externally', async () => {
    const root = new Directory(); const manifest = new File(); manifest.content = '{"project":"snapshot"}'; root.files.set('gandiwa-project.json', manifest); const metadataDirectory = new Directory(); root.directories.set('metadata', metadataDirectory)
    const file = new File(); file.content = `${JSON.stringify(metadata)}\n`; metadataDirectory.files.set('123e4567-e89b-12d3-a456-426614174000.json', file)
    await expect(saveStockMetadata({ directory: root, manifestSnapshot: manifest.content, assetId: '123e4567-e89b-12d3-a456-426614174000', provenance, metadata: { ...metadata, title: 'Different title' }, sidecarSnapshot: undefined })).rejects.toThrow('metadata changed externally')
    const loaded = await loadStockMetadata(root, '123e4567-e89b-12d3-a456-426614174000', provenance)
    file.content = `${JSON.stringify({ ...metadata, title: 'External edit' })}\n`
    await expect(saveStockMetadata({ directory: root, manifestSnapshot: manifest.content, assetId: '123e4567-e89b-12d3-a456-426614174000', provenance, metadata: { ...metadata, title: 'Different title' }, sidecarSnapshot: loaded!.snapshot })).rejects.toThrow('metadata changed externally')
    expect(file.content).toContain('External edit')
  })

  it('rejects a noncanonical asset ID before any write', async () => {
    const root = new Directory(); root.directories.set('metadata', new Directory())
    await expect(saveStockMetadata({ directory: root, manifestSnapshot: '{}', assetId: '123e4567-e89b-12d3-a456-426614174000x', provenance, metadata, sidecarSnapshot: undefined })).rejects.toThrow('asset ID is invalid')
  })

  it('refuses to write metadata after an external manifest change', async () => {
    const root = new Directory(); const manifest = new File(); manifest.content = '{"external":true}'; root.files.set('gandiwa-project.json', manifest); root.directories.set('metadata', new Directory())
    await expect(saveStockMetadata({ directory: root, manifestSnapshot: '{"project":"snapshot"}', assetId: '123e4567-e89b-12d3-a456-426614174000', provenance, metadata, sidecarSnapshot: undefined })).rejects.toThrow('changed externally')
    expect(root.directories.get('metadata')!.files).toEqual(new Map())
  })
})
