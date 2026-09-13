import { describe, expect, it, vi } from 'vitest'

import { prepareRasterForSubmission, type RasterPreparationDependencies } from './raster-preparation'

class MemoryFile {
  content: Blob | string = ''
  getFile() { return Promise.resolve(new File([this.content], 'memory')) }
  createWritable() { return Promise.resolve({ write: (value: Blob | string) => { this.content = value; return Promise.resolve() }, close: () => Promise.resolve() }) }
}
class MemoryDirectory {
  directories = new Map<string, MemoryDirectory>()
  files = new Map<string, MemoryFile>()
  getDirectoryHandle(name: string, options?: { create?: boolean }) { const found = this.directories.get(name); if (found) return Promise.resolve(found); if (!options?.create) return Promise.reject(new DOMException('missing', 'NotFoundError')); const made = new MemoryDirectory(); this.directories.set(name, made); return Promise.resolve(made) }
  getFileHandle(name: string, options?: { create?: boolean }) { const found = this.files.get(name); if (found) return Promise.resolve(found); if (!options?.create) return Promise.reject(new DOMException('missing', 'NotFoundError')); const made = new MemoryFile(); this.files.set(name, made); return Promise.resolve(made) }
}
const emptyManifest = { schema_version: 1, project_id: '6e9e0cd4-7b2e-46fc-84ad-5a40816bdca1', project_name: 'Burung Laut', assets: [] } as const
const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const pngFile = () => new File([PNG_HEADER], 'bird.png', { type: 'image/png' })
const jpegOutput = { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), width: 2000, height: 2000, alphaHandling: 'flatten-white' as const, colorConversion: 'browser-canvas-to-srgb' as const }

function setup() {
  const root = new MemoryDirectory(); root.directories.set('revisions', new MemoryDirectory())
  const manifestFile = new MemoryFile(); manifestFile.content = JSON.stringify(emptyManifest); root.files.set('gandiwa-project.json', manifestFile)
  const dependencies: RasterPreparationDependencies = { directory: root, encodeJpeg: vi.fn(() => Promise.resolve(jpegOutput)), newId: () => '123e4567-e89b-12d3-a456-426614174000' }
  return { root, manifestFile, dependencies }
}

describe('prepareRasterForSubmission', () => {
  it('preserves PNG master in revision 1 and records JPEG submission as revision 2', async () => {
    const { root, dependencies } = setup()
    const result = await prepareRasterForSubmission({ manifest: emptyManifest, manifestSnapshot: JSON.stringify(emptyManifest), source: pngFile(), contentType: 'photo', creationMethod: 'camera', quality: 0.92 }, dependencies)
    expect(result.manifest.assets[0]?.revisions.map((item) => item.master_format)).toEqual(['png', 'jpeg'])
    const asset = root.directories.get('revisions')!.directories.get('123e4567-e89b-12d3-a456-426614174000')!
    expect(new Uint8Array(await (await asset.directories.get('1')!.files.get('master.png')!.getFile()).arrayBuffer())).toEqual(PNG_HEADER)
    const record = JSON.parse(asset.directories.get('2')!.files.get('preparation.json')!.content as string)
    expect(record).toMatchObject({ source_revision: 1, revision: 2, quality: 0.92, megapixels: 4, alpha_handling: 'flatten-white', color_conversion: 'browser-canvas-to-srgb' })
    expect(record.source_checksum).toMatch(/^[a-f0-9]{64}$/)
    expect(record.submission_checksum).toMatch(/^[a-f0-9]{64}$/)
  })

  it('rejects output below 4MP before durable writes instead of upscaling', async () => {
    const { root, dependencies } = setup()
    vi.mocked(dependencies.encodeJpeg).mockResolvedValueOnce({ ...jpegOutput, width: 1999 })
    await expect(prepareRasterForSubmission({ manifest: emptyManifest, manifestSnapshot: JSON.stringify(emptyManifest), source: pngFile(), contentType: 'photo', creationMethod: 'camera', quality: 0.92 }, dependencies)).rejects.toThrow('at least 4 megapixels')
    expect(root.directories.get('revisions')!.directories).toEqual(new Map())
  })

  it('uses byte signatures rather than spoofed source MIME/name', async () => {
    const { root, dependencies } = setup()
    const disguised = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], 'bird.png', { type: 'image/png' })
    const result = await prepareRasterForSubmission({ manifest: emptyManifest, manifestSnapshot: JSON.stringify(emptyManifest), source: disguised, contentType: 'photo', creationMethod: 'camera', quality: 0.92 }, dependencies)
    expect(result.manifest.assets[0]?.revisions[0]?.master_format).toBe('jpeg')
    expect(root.directories.get('revisions')!.directories.get('123e4567-e89b-12d3-a456-426614174000')!.directories.get('1')!.files.has('master.png')).toBe(false)
  })

  it('rejects external manifest changes before and after encoding', async () => {
    const { root, dependencies, manifestFile } = setup(); manifestFile.content = '{"external":true}'
    await expect(prepareRasterForSubmission({ manifest: emptyManifest, manifestSnapshot: JSON.stringify(emptyManifest), source: pngFile(), contentType: 'photo', creationMethod: 'camera', quality: 0.92 }, dependencies)).rejects.toThrow('changed externally')
    expect(root.directories.get('revisions')!.directories).toEqual(new Map())
    const second = setup()
    vi.mocked(second.dependencies.encodeJpeg).mockImplementationOnce(() => { second.manifestFile.content = '{"external":true}'; return Promise.resolve(jpegOutput) })
    await expect(prepareRasterForSubmission({ manifest: emptyManifest, manifestSnapshot: JSON.stringify(emptyManifest), source: pngFile(), contentType: 'photo', creationMethod: 'camera', quality: 0.92 }, second.dependencies)).rejects.toThrow('changed externally')
    expect(second.root.directories.get('revisions')!.directories).toEqual(new Map())
  })

  it('refuses an asset ID collision before writing a revision', async () => {
    const { root, dependencies } = setup()
    root.directories.get('revisions')!.directories.set('123e4567-e89b-12d3-a456-426614174000', new MemoryDirectory())
    await expect(prepareRasterForSubmission({ manifest: emptyManifest, manifestSnapshot: JSON.stringify(emptyManifest), source: pngFile(), contentType: 'photo', creationMethod: 'camera', quality: 0.92 }, dependencies)).rejects.toThrow('existing revision directory')
  })
})
