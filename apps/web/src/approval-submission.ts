import type { ProjectManifest } from '@gandiwa/contracts'
import { loadStockMetadata, type MetadataDirectory } from './stock-metadata-store'

export type SubmissionDirectory = MetadataDirectory & Readonly<{
  getFileHandle(name: string, options?: { create?: boolean }): Promise<Readonly<{ getFile(): Promise<File> }>>
}>
export type ApprovalSubmission = Readonly<{
  assetId: string
  revision: number
  path: string
  file: File
  contentType: ProjectManifest['assets'][number]['content_type']
  creationMethod: ProjectManifest['assets'][number]['creation_method']
  submissionChecksum: string
  metadataChecksum: string
  manifestSnapshot: string
}>

const HEX = /^[a-f0-9]{64}$/
async function sha256(bytes: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function resolveApprovalSubmission(input: Readonly<{
  directory: SubmissionDirectory
  manifest: ProjectManifest
  manifestSnapshot: string
  assetId: string
  revision: number
}>): Promise<ApprovalSubmission> {
  const manifestHandle = await input.directory.getFileHandle('gandiwa-project.json', { create: false })
  const currentManifest = await (await (manifestHandle as unknown as { getFile(): Promise<{ text(): Promise<string> }> }).getFile()).text()
  if (currentManifest !== input.manifestSnapshot) throw new Error('project manifest changed externally; reload before approval')
  const asset = input.manifest.assets.find((candidate) => candidate.asset_id === input.assetId)
  const revision = asset?.revisions.find((candidate) => candidate.revision === input.revision)
  if (!asset || !revision || !revision.relative_path.startsWith('revisions/')) throw new Error('asset revision is invalid')
  const segments = revision.relative_path.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) throw new Error('asset revision path is invalid')
  let parent: MetadataDirectory = input.directory
  for (const segment of segments.slice(0, -1)) parent = await parent.getDirectoryHandle(segment, { create: false })
  const handle = await parent.getFileHandle(segments.at(-1)!, { create: false }) as unknown as Readonly<{ getFile(): Promise<File> }>
  const file = await handle.getFile()
  const submissionChecksum = await sha256(await file.arrayBuffer())
  if (!HEX.test(submissionChecksum)) throw new Error('submission checksum is invalid')
  const metadata = await loadStockMetadata(input.directory, asset.asset_id, { contentType: asset.content_type, creationMethod: asset.creation_method })
  if (!metadata) throw new Error('metadata is missing')
  return { assetId: asset.asset_id, revision: revision.revision, path: revision.relative_path, file, contentType: asset.content_type, creationMethod: asset.creation_method, submissionChecksum, metadataChecksum: metadata.checksum, manifestSnapshot: input.manifestSnapshot }
}
