import { assessStockMetadata, isStockMetadataDraft, normalizeStockMetadata, type AssetProvenance, type StockMetadataDraft } from './stock-metadata'

type Writable = { write(data: string): Promise<void>; close(): Promise<void> }
type FileHandle = { getFile(): Promise<{ text(): Promise<string> }>; createWritable(): Promise<Writable> }
export interface MetadataDirectory {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MetadataDirectory>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandle>
}

export type LoadedStockMetadata = Readonly<{ metadata: StockMetadataDraft; snapshot: string; checksum: string }>

type SaveInput = Readonly<{
  directory: MetadataDirectory
  manifestSnapshot: string
  assetId: string
  provenance: AssetProvenance
  metadata: StockMetadataDraft
  sidecarSnapshot: string | undefined
}>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function supportsMetadataWrite(directory: unknown): directory is MetadataDirectory {
  return typeof directory === 'object' && directory !== null
    && 'getDirectoryHandle' in directory && typeof directory.getDirectoryHandle === 'function'
    && 'getFileHandle' in directory && typeof directory.getFileHandle === 'function'
}

function assertAssetId(assetId: string): void {
  if (!UUID.test(assetId)) throw new Error('asset ID is invalid')
}

async function checksum(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function readFile(directory: MetadataDirectory, name: string): Promise<string | undefined> {
  try {
    return (await (await directory.getFileHandle(name, { create: false })).getFile()).text()
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'NotFoundError') return undefined
    throw cause
  }
}

async function assertManifestSnapshot(directory: MetadataDirectory, expected: string): Promise<void> {
  if ((await readFile(directory, 'gandiwa-project.json')) !== expected) throw new Error('project manifest changed externally; reload before saving metadata')
}

export async function loadStockMetadata(directory: MetadataDirectory, assetId: string, provenance: AssetProvenance): Promise<LoadedStockMetadata | undefined> {
  assertAssetId(assetId)
  const metadataDirectory = await directory.getDirectoryHandle('metadata', { create: false })
  const snapshot = await readFile(metadataDirectory, `${assetId}.json`)
  if (snapshot === undefined) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(snapshot) } catch { throw new Error('saved metadata is invalid') }
  if (!isStockMetadataDraft(parsed) || !assessStockMetadata(parsed, provenance).valid) throw new Error('saved metadata is invalid')
  return { metadata: normalizeStockMetadata(parsed), snapshot, checksum: await checksum(snapshot) }
}

export async function saveStockMetadata(input: SaveInput): Promise<LoadedStockMetadata> {
  assertAssetId(input.assetId)
  const metadata = normalizeStockMetadata(input.metadata)
  const assessment = assessStockMetadata(metadata, input.provenance)
  if (!assessment.valid) throw new Error(assessment.errors.join(' '))
  await assertManifestSnapshot(input.directory, input.manifestSnapshot)
  const directory = await input.directory.getDirectoryHandle('metadata', { create: false })
  const name = `${input.assetId}.json`
  const current = await readFile(directory, name)
  if (current !== input.sidecarSnapshot) throw new Error('metadata changed externally; reload before saving')
  const snapshot = `${JSON.stringify(metadata, null, 2)}\n`
  await assertManifestSnapshot(input.directory, input.manifestSnapshot)
  if ((await readFile(directory, name)) !== input.sidecarSnapshot) throw new Error('metadata changed externally; reload before saving')
  const writable = await (await directory.getFileHandle(name, { create: true })).createWritable()
  await writable.write(snapshot)
  await writable.close()
  return { metadata, snapshot, checksum: await checksum(snapshot) }
}
