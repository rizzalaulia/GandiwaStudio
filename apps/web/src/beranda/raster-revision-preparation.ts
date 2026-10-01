import { type ProjectManifest, validateProjectManifest } from '@gandiwa/contracts'

type AlphaHandling = 'none' | 'flatten-white'
type ColorConversion = 'browser-canvas-to-srgb'
type EncodedJpeg = Readonly<{ bytes: Uint8Array; width: number; height: number; alphaHandling: AlphaHandling; colorConversion: ColorConversion }>
type Writable = Readonly<{ write(value: BlobPart): Promise<void>; close(): Promise<void> }>
type FileHandle = Readonly<{ getFile(): Promise<File>; createWritable(): Promise<Writable> }>
type Directory = Readonly<{ getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<Directory>; getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandle> }>

export type ExistingRasterPreparationInput = Readonly<{
  directory: Directory
  manifest: ProjectManifest
  manifestSnapshot: string
  assetId: string
  sourceRevision: number
  quality: number
  encodeJpeg: (source: File, quality: number) => Promise<EncodedJpeg>
}>

async function sha256(data: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = data instanceof Uint8Array ? new Uint8Array(data).buffer : data
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function manifestText(directory: Directory): Promise<string> {
  return (await (await directory.getFileHandle('gandiwa-project.json', { create: false })).getFile()).text()
}

async function sourceFile(directory: Directory, path: string): Promise<File> {
  const segments = path.split('/')
  const name = segments.pop()
  if (!name || segments.some((segment) => !segment || segment === '.' || segment === '..')) throw new Error('source revision path is invalid')
  let current = directory
  for (const segment of segments) current = await current.getDirectoryHandle(segment, { create: false })
  return (await current.getFileHandle(name, { create: false })).getFile()
}

async function assertAbsent(directory: Directory, name: string): Promise<void> {
  try {
    await directory.getFileHandle(name, { create: false })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'NotFoundError') return
    throw cause
  }
  throw new Error(`refusing to overwrite existing preparation file: ${name}`)
}

export async function prepareExistingRasterRevision(input: ExistingRasterPreparationInput): Promise<Readonly<{ revision: number; manifest: ProjectManifest }>> {
  if (!Number.isFinite(input.quality) || input.quality < 0 || input.quality > 1) throw new Error('quality must be between 0 and 1')
  const manifest = validateProjectManifest(input.manifest)
  if (await manifestText(input.directory) !== input.manifestSnapshot) throw new Error('project manifest changed externally; reload before preparing revision')
  const asset = manifest.assets.find((candidate) => candidate.asset_id === input.assetId)
  const sourceRevision = asset?.revisions.find((candidate) => candidate.revision === input.sourceRevision)
  if (!asset || !sourceRevision || sourceRevision.submission_format === 'svg') throw new Error('raster source revision is unavailable')
  const source = await sourceFile(input.directory, sourceRevision.relative_path)
  const encoded = await input.encodeJpeg(source, input.quality)
  if (encoded.width * encoded.height < 4_000_000) throw new Error('submission must be at least 4 megapixels; upscaling is not allowed')
  if (encoded.bytes.length < 4 || encoded.bytes[0] !== 0xff || encoded.bytes[1] !== 0xd8 || encoded.bytes.at(-2) !== 0xff || encoded.bytes.at(-1) !== 0xd9) throw new Error('conversion did not produce a valid JPEG')
  if (await manifestText(input.directory) !== input.manifestSnapshot) throw new Error('project manifest changed externally; reload before preparing revision')
  const revision = Math.max(...asset.revisions.map((entry) => entry.revision)) + 1
  const revisions = await input.directory.getDirectoryHandle('revisions', { create: false })
  const assetDirectory = await revisions.getDirectoryHandle(input.assetId, { create: false })
  try {
    await assetDirectory.getDirectoryHandle(String(revision), { create: false })
    throw new Error(`refusing to overwrite existing preparation revision: ${revision}`)
  } catch (cause) {
    if (!(cause instanceof DOMException && cause.name === 'NotFoundError')) throw cause
  }
  const prepared = await assetDirectory.getDirectoryHandle(String(revision), { create: true })
  await assertAbsent(prepared, 'master.jpeg')
  await assertAbsent(prepared, 'preparation.json')
  const preparation = {
    source_revision: input.sourceRevision,
    revision,
    source_checksum: await sha256(await source.arrayBuffer()),
    submission_checksum: await sha256(encoded.bytes),
    quality: input.quality,
    width: encoded.width,
    height: encoded.height,
    megapixels: encoded.width * encoded.height / 1_000_000,
    alpha_handling: encoded.alphaHandling,
    color_conversion: encoded.colorConversion,
  }
  const jpeg = await (await prepared.getFileHandle('master.jpeg', { create: true })).createWritable()
  await jpeg.write(encoded.bytes.slice().buffer)
  await jpeg.close()
  const evidence = await (await prepared.getFileHandle('preparation.json', { create: true })).createWritable()
  await evidence.write(`${JSON.stringify(preparation, null, 2)}\n`)
  await evidence.close()
  if (await manifestText(input.directory) !== input.manifestSnapshot) throw new Error('project manifest changed externally; reload before publishing prepared revision')
  const next = validateProjectManifest({
    ...manifest,
    assets: manifest.assets.map((candidate) => candidate.asset_id === input.assetId ? {
      ...candidate,
      revisions: [...candidate.revisions, {
        revision,
        generation_format: sourceRevision.generation_format,
        working_format: 'jpeg',
        master_format: 'jpeg',
        submission_format: 'jpeg',
        relative_path: `revisions/${input.assetId}/${revision}/master.jpeg`,
      }],
    } : candidate),
  })
  return { revision, manifest: next }
}
