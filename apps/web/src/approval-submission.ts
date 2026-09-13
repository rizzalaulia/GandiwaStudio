import type { ProjectManifest } from '@gandiwa/contracts'
import { loadStockMetadata, type MetadataDirectory } from './stock-metadata-store'

export type SubmissionDirectory = MetadataDirectory & { getFileHandle(name: string, options?: { create?: boolean }): Promise<{ getFile(): Promise<File> }> }
export type ApprovalSubmission = Readonly<{ assetId: string; revision: number; path: string; submissionChecksum: string; metadataChecksum: string; manifestSnapshot: string }>
async function sha256(bytes: ArrayBuffer): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('') }
export async function resolveApprovalSubmission(input: Readonly<{ directory: SubmissionDirectory; manifest: ProjectManifest; manifestSnapshot: string; assetId: string; revision: number }>): Promise<ApprovalSubmission> {
  const asset = input.manifest.assets.find((candidate) => candidate.asset_id === input.assetId)
  const revision = asset?.revisions.find((candidate) => candidate.revision === input.revision)
  if (!asset || !revision || !revision.relative_path.startsWith('revisions/')) throw new Error('asset revision is invalid')
  const segments = revision.relative_path.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) throw new Error('asset revision path is invalid')
  let parent: MetadataDirectory = input.directory
  for (const segment of segments.slice(0, -1)) parent = await parent.getDirectoryHandle(segment, { create: false })
  const handle = await parent.getFileHandle(segments.at(-1)!, { create: false }) as unknown as { getFile(): Promise<File> }
  const file = await handle.getFile()
  const metadata = await loadStockMetadata(input.directory, asset.asset_id, { contentType: asset.content_type, creationMethod: asset.creation_method })
  if (!metadata) throw new Error('metadata is missing')
  return { assetId: asset.asset_id, revision: revision.revision, path: revision.relative_path, submissionChecksum: await sha256(await file.arrayBuffer()), metadataChecksum: metadata.checksum, manifestSnapshot: input.manifestSnapshot }
}
