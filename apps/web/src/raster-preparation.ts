import { type ContentType, type CreationMethod, type ProjectManifest, validateProjectManifest } from '@gandiwa/contracts'

type Writable = { write(data: Blob | string): Promise<void>; close(): Promise<void> }
type FileHandle = { getFile(): Promise<File>; createWritable(): Promise<Writable> }
type Directory = { getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<Directory>; getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandle> }

type AlphaHandling = 'none' | 'flatten-white'
type ColorConversion = 'browser-canvas-to-srgb'
type EncodedJpeg = Readonly<{ bytes: Uint8Array; width: number; height: number; alphaHandling: AlphaHandling; colorConversion: ColorConversion }>
export type RasterPreparationDependencies = Readonly<{ directory: Directory; encodeJpeg: (source: File, quality: number) => Promise<EncodedJpeg>; newId: () => string }>
type PreparationRecord = Readonly<{ source_revision: number; revision: number; source_checksum: string; submission_checksum: string; quality: number; width: number; height: number; megapixels: number; alpha_handling: AlphaHandling; color_conversion: ColorConversion }>
type Input = Readonly<{ manifest: ProjectManifest; manifestSnapshot: string; source: File; contentType: Exclude<ContentType, 'vector'>; creationMethod: CreationMethod; quality: number }>

async function sourceFormat(source: File): Promise<'png' | 'jpeg'> {
  const bytes = new Uint8Array(await source.slice(0, 16).arrayBuffer())
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  throw new Error('source bytes are not a PNG or JPEG')
}
async function writeNew(directory: Directory, name: string, content: Blob | string): Promise<void> {
  try { await directory.getFileHandle(name, { create: false }); throw new Error(`refusing to overwrite existing revision file: ${name}`) } catch (cause) {
    if (!(cause instanceof DOMException && cause.name === 'NotFoundError')) throw cause
  }
  const writer = await (await directory.getFileHandle(name, { create: true })).createWritable(); await writer.write(content); await writer.close()
}
async function createNewDirectory(parent: Directory, name: string): Promise<Directory> {
  try { await parent.getDirectoryHandle(name, { create: false }); throw new Error(`refusing to overwrite existing revision directory: ${name}`) } catch (cause) {
    if (!(cause instanceof DOMException && cause.name === 'NotFoundError')) throw cause
  }
  return parent.getDirectoryHandle(name, { create: true })
}
async function hash(data: ArrayBuffer | Uint8Array): Promise<string> { const bytes = data instanceof Uint8Array ? data.slice().buffer : data; const digest = await crypto.subtle.digest('SHA-256', bytes); return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, '0')).join('') }
async function assertSnapshot(directory: Directory, expected: string): Promise<void> { const actual = await (await (await directory.getFileHandle('gandiwa-project.json', { create: false })).getFile()).text(); if (actual !== expected) throw new Error('project manifest changed externally; reload before preparing a revision') }

export async function prepareRasterForSubmission(input: Input, dependencies: RasterPreparationDependencies): Promise<Readonly<{ assetId: string; manifest: ProjectManifest; preparation: PreparationRecord }>> {
  if (!Number.isFinite(input.quality) || input.quality < 0 || input.quality > 1) throw new Error('quality must be between 0 and 1')
  const manifest = validateProjectManifest(input.manifest)
  await assertSnapshot(dependencies.directory, input.manifestSnapshot)
  const format = await sourceFormat(input.source)
  const encoded = await dependencies.encodeJpeg(input.source, input.quality)
  if (encoded.width * encoded.height < 4_000_000) throw new Error('submission must be at least 4 megapixels; upscaling is not allowed')
  if (encoded.bytes.length < 4 || encoded.bytes[0] !== 0xff || encoded.bytes[1] !== 0xd8 || encoded.bytes.at(-2) !== 0xff || encoded.bytes.at(-1) !== 0xd9) throw new Error('conversion did not produce a valid JPEG')
  const assetId = dependencies.newId()
  const sourceChecksum = await hash(await input.source.arrayBuffer()); const submissionChecksum = await hash(encoded.bytes)
  await assertSnapshot(dependencies.directory, input.manifestSnapshot)
  const preparation = { source_revision: 1, revision: 2, source_checksum: sourceChecksum, submission_checksum: submissionChecksum, quality: input.quality, width: encoded.width, height: encoded.height, megapixels: encoded.width * encoded.height / 1_000_000, alpha_handling: encoded.alphaHandling, color_conversion: encoded.colorConversion }
  const revisions = await dependencies.directory.getDirectoryHandle('revisions', { create: false }); const asset = await createNewDirectory(revisions, assetId); const original = await createNewDirectory(asset, '1'); const submission = await createNewDirectory(asset, '2')
  await writeNew(original, `master.${format}`, input.source); await writeNew(submission, 'master.jpeg', new Blob([encoded.bytes.slice().buffer], { type: 'image/jpeg' })); await writeNew(submission, 'preparation.json', `${JSON.stringify(preparation, null, 2)}\n`)
  const next = validateProjectManifest({ ...manifest, assets: [...manifest.assets, { asset_id: assetId, content_type: input.contentType, creation_method: input.creationMethod, revisions: [{ revision: 1, generation_format: format, working_format: format, master_format: format, submission_format: 'jpeg', relative_path: `revisions/${assetId}/1/master.${format}` }, { revision: 2, generation_format: format, working_format: 'jpeg', master_format: 'jpeg', submission_format: 'jpeg', relative_path: `revisions/${assetId}/2/master.jpeg` }] }] })
  await assertSnapshot(dependencies.directory, input.manifestSnapshot)
  const writer = await (await dependencies.directory.getFileHandle('gandiwa-project.json', { create: false })).createWritable(); await writer.write(`${JSON.stringify(next, null, 2)}\n`); await writer.close()
  return { assetId, manifest: next, preparation }
}

export async function browserEncodeJpeg(source: File, quality: number): Promise<EncodedJpeg> { const bitmap = await createImageBitmap(source); try { const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height; const context = canvas.getContext('2d'); if (!context) throw new Error('JPEG canvas is unavailable'); const transparent = await new Promise<boolean>((resolve) => { const alpha = document.createElement('canvas'); alpha.width = 1; alpha.height = 1; const alphaContext = alpha.getContext('2d'); if (!alphaContext) return resolve(false); alphaContext.drawImage(bitmap, 0, 0, 1, 1); resolve((alphaContext.getImageData(0, 0, 1, 1).data[3] ?? 255) < 255) }); context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0); const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality)); if (!blob) throw new Error('browser could not encode JPEG'); return { bytes: new Uint8Array(await blob.arrayBuffer()), width: bitmap.width, height: bitmap.height, alphaHandling: transparent ? 'flatten-white' : 'none', colorConversion: 'browser-canvas-to-srgb' } } finally { bitmap.close() } }
