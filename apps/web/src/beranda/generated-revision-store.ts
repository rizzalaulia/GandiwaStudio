import { validateProjectManifest, type ProjectManifest, type ProjectRevision } from '@gandiwa/contracts'

import type { CreativeSessionDirectory, CreativeSessionSidecar, LoadedCreativeSession } from '../creative-session-store'

// Issue #26 slice: a succeeded, session-owned queue job becomes a durable
// browser-local revision. The download is verified twice (header digest vs
// the job's declared artifact digest, then the actual bytes), the revision
// file is created exclusively, the sidecar is updated, and only then is the
// manifest republished — the manifest is always the completion marker.

export type GeneratedRevisionArtifact = Readonly<{
  id: string
  media_type: string
  size_bytes: number
  sha256: string
}>

export type RecordGeneratedRevisionInput = Readonly<{
  directory: CreativeSessionDirectory
  manifestSnapshot: string
  persistedSession: LoadedCreativeSession
  jobId: string
  artifact: GeneratedRevisionArtifact
  fetchArtifact: (artifactId: string) => Promise<Readonly<{ bytes: Uint8Array; sha256Header: string }>>
  saveSidecar: (input: Readonly<{
    directory: CreativeSessionDirectory
    manifestSnapshot: string
    session: CreativeSessionSidecar
    sidecarSnapshot: string | undefined
  }>) => Promise<unknown>
  publishManifest: (manifest: ProjectManifest) => Promise<void>
  newId?: () => string
}>

export type RecordedRevisionOutcome = Readonly<{
  bytes: Uint8Array
  revision: ProjectRevision
  manifest: ProjectManifest
}>

const EXTENSIONS: Record<string, 'png' | 'jpeg' | 'svg'> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/svg+xml': 'svg',
}

function formatRoute(contentType: CreativeSessionSidecar['prompt']['contentType'], extension: 'png' | 'jpeg' | 'svg'): {
  generation_format: 'png' | 'jpeg' | 'svg'
  working_format: 'png' | 'jpeg' | 'svg'
  master_format: 'png' | 'jpeg' | 'svg'
  submission_format: 'png' | 'jpeg' | 'svg'
} {
  if (contentType === 'vector') {
    return { generation_format: 'svg', working_format: 'svg', master_format: 'svg', submission_format: 'svg' }
  }
  if (extension === 'png') {
    return { generation_format: 'png', working_format: 'png', master_format: 'png', submission_format: 'jpeg' }
  }
  return { generation_format: extension, working_format: extension, master_format: extension, submission_format: 'jpeg' }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function recordGeneratedRevision(input: RecordGeneratedRevisionInput): Promise<RecordedRevisionOutcome> {
  const declared = input.artifact
  const download = await input.fetchArtifact(declared.id)
  if (download.sha256Header !== declared.sha256) {
    throw new Error('artifact digest mismatch: transport header disagrees with the job artifact')
  }
  const contentDigest = await sha256Hex(download.bytes)
  if (contentDigest !== declared.sha256) {
    throw new Error('artifact content digest mismatch: downloaded bytes disagree with the declared digest')
  }

  // The approved manifest snapshot is the verified base: don't re-parse a
  // live read that could observe a concurrent edit the approval never saw.
  const manifest: ProjectManifest = validateProjectManifest(JSON.parse(input.manifestSnapshot))
  const snapshotBefore = input.manifestSnapshot

  const session = input.persistedSession.session
  const contentType = session.prompt.contentType
  const extension = EXTENSIONS[declared.media_type]
  if (extension === undefined) throw new Error(`unsupported artifact media type: ${declared.media_type}`)

  const asset = manifest.assets.find((entry) => entry.asset_id === session.sessionId)
  const nextRevisionNumber = asset ? Math.max(...asset.revisions.map((entry) => entry.revision)) + 1 : 1
  const relativePath = `revisions/${session.sessionId}/rev-${nextRevisionNumber}.${extension}`

  const revisionsDir = await input.directory.getDirectoryHandle('revisions', { create: true })
  const assetDir = await revisionsDir.getDirectoryHandle(session.sessionId, { create: true })
  const fileName = `rev-${nextRevisionNumber}.${extension}`
  try {
    await assetDir.getFileHandle(fileName, { create: false })
    throw new Error(`__EXISTS__revision file already exists; refusing to overwrite: ${fileName}`)
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith('__EXISTS__')) {
      throw new Error(cause.message.slice('__EXISTS__'.length), { cause })
    }
    if (cause instanceof DOMException && cause.name === 'NotFoundError') {
      // Absent — the only path that may continue to create + write.
    } else {
      throw cause
    }
  }

  const writable = await (await assetDir.getFileHandle(fileName, { create: true })).createWritable()
  // Bytes stay binary: decode() would corrupt PNG/JPEG payloads into mojibake.
  await writable.write(download.bytes as unknown as string)
  await writable.close()

  const revision: ProjectRevision = {
    revision: nextRevisionNumber,
    ...formatRoute(contentType, extension),
    relative_path: relativePath,
  }
  const nextAssets = manifest.assets.some((entry) => entry.asset_id === session.sessionId)
    ? manifest.assets.map((entry) => entry.asset_id === session.sessionId ? { ...entry, revisions: [...entry.revisions, revision] } : entry)
    : [...manifest.assets, {
      asset_id: session.sessionId,
      content_type: contentType,
      creation_method: session.prompt.creationMethod,
      revisions: [revision],
    }]
  const nextManifest: ProjectManifest = { ...manifest, assets: nextAssets }

  const promptDigest = session.approvals.find((approval) => approval.promptDigest)?.promptDigest ?? ''
  const updatedSession: CreativeSessionSidecar = {
    ...session,
    revisions: [...session.revisions, {
      revisionId: `rev-${nextRevisionNumber}`,
      promptDigest,
      providerId: session.prompt.providerId,
      modelId: session.prompt.modelId,
      providerJobId: input.jobId,
      adapterVersion: 'gandiwa-web-1',
      parameters: {
        artifact_id: declared.id,
        sha256: declared.sha256,
        size_bytes: declared.size_bytes,
        width: session.prompt.targetWidth,
        height: session.prompt.targetHeight,
      },
      createdAt: new Date().toISOString(),
    }],
  }
  await input.saveSidecar({
    directory: input.directory,
    manifestSnapshot: snapshotBefore,
    session: updatedSession,
    sidecarSnapshot: input.persistedSession.snapshot,
  })

  await input.publishManifest(nextManifest)
  return { bytes: download.bytes, revision, manifest: nextManifest }
}
