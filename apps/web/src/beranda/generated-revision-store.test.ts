import { describe, expect, it, vi } from 'vitest'

import { recordGeneratedRevision } from './generated-revision-store'

const UUID = '3f2b8a64-9c1d-4e7a-b2f5-8d60c1a94e21'

const SESSION = {
  schemaVersion: 1 as const,
  sessionId: UUID,
  topic: 'Demo Stok',
  rounds: [],
  prompt: {
    promptText: 'ilustrasi kucing oren',
    negativePrompt: 'watermark',
    contentType: 'illustration' as const,
    creationMethod: 'generative_ai' as const,
    providerId: 'fal',
    modelId: 'fal-ai/flux/schnell',
    targetWidth: 2000,
    targetHeight: 2000,
    aspectRatio: '1:1',
    orientation: 'square' as const,
    stockConstraints: ['no_logo'],
    negativeSpaceDecision: 'none required',
  },
  approvals: [{ stage: 'prompt' as const, approvedAt: '2026-09-22T00:00:00Z', human: 'Master Peng', promptDigest: 'd'.repeat(64) }],
  revisions: [],
}

const ARTIFACT = { id: 'art-1', media_type: 'image/png', size_bytes: 4, sha256: '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a' }

function baseHarness(initialAssets: unknown[] = []) {
  const revisionWrites: string[] = []
  const publishedManifests: unknown[] = []
  const savedSidecars: unknown[] = []
  const manifestText = JSON.stringify({
    schema_version: 1,
    project_id: UUID,
    project_name: 'Demo Stok',
    assets: initialAssets,
  })
  const directory = {
    getFileHandle: vi.fn(() => Promise.resolve({
      getFile: () => Promise.resolve({ text: () => Promise.resolve(manifestText) }),
    })),
    getDirectoryHandle: vi.fn((name: string, options?: { create?: boolean }) => {
      if (name === 'revisions' && options?.create) {
        return Promise.resolve({
          getDirectoryHandle: (asset: string, assetOptions?: { create?: boolean }) => {
            if (asset === UUID && assetOptions?.create) {
              return Promise.resolve({
                getFileHandle: (fileName: string, fileOptions?: { create?: boolean }) => {
                  if (fileOptions?.create) {
                    revisionWrites.push(fileName)
                    return Promise.resolve({
                      createWritable: () => Promise.resolve({
                        write: () => Promise.resolve(),
                        close: () => Promise.resolve(),
                      }),
                    })
                  }
                  return Promise.reject(new DOMException('missing', 'NotFoundError'))
                },
              })
            }
            return Promise.reject(new DOMException('missing', 'NotFoundError'))
          },
        })
      }
      return Promise.reject(new DOMException('missing', 'NotFoundError'))
    }),
  }
  const saveSidecar = vi.fn((input: { session: unknown }) => {
    savedSidecars.push(input.session)
    return Promise.resolve({ session: input.session, snapshot: 'next-sidecar', checksum: 'bb'.repeat(32) })
  })
  const publishManifest = vi.fn((next: unknown) => {
    publishedManifests.push(next)
    return Promise.resolve()
  })
  return { directory, saveSidecar, publishManifest, revisionWrites, publishedManifests, savedSidecars, manifestText }
}

function harness(h = baseHarness()) {
  return {
    ...h,
    input: {
      directory: h.directory as never,
      manifestSnapshot: h.manifestText,
      persistedSession: { session: SESSION, snapshot: 'sidecar-text', checksum: 'c'.repeat(32) },
      jobId: 'job-9',
      artifact: ARTIFACT,
      fetchArtifact: vi.fn(() => Promise.resolve({ bytes: new Uint8Array([1, 2, 3, 4]), sha256Header: '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a' })),
      saveSidecar: h.saveSidecar as never,
      publishManifest: h.publishManifest as never,
    },
    ...h,
  }
}

function harnessWithAssets(initialAssets: unknown[]) {
  const h = baseHarness(initialAssets)
  return harness(h)
}

describe('generated revision store — browser-local durable revision from a succeeded job', () => {
  it('downloads verified artifact bytes, writes them exclusively, saves the sidecar, then publishes the manifest', async () => {
    const h = harness()
    const outcome = await recordGeneratedRevision(h.input)

    expect(h.input.fetchArtifact).toHaveBeenCalledWith('art-1')
    expect(h.revisionWrites).toEqual(['rev-1.png'])
    expect(h.saveSidecar).toHaveBeenCalledTimes(1)
    expect(h.publishedManifests).toHaveLength(1)
    const manifest = h.publishedManifests[0] as { assets: Array<{ asset_id: string; content_type: string; creation_method: string; revisions: Array<{ revision: number; relative_path: string }> }> }
    expect(manifest.assets).toHaveLength(1)
    expect(manifest.assets[0]!.content_type).toBe('illustration')
    expect(manifest.assets[0]!.creation_method).toBe('generative_ai')
    expect(manifest.assets[0]!.revisions[0]!.revision).toBe(1)
    expect(manifest.assets[0]!.revisions[0]!.relative_path).toBe(`revisions/${UUID}/rev-1.png`)
    expect(outcome.bytes).toEqual(new Uint8Array([1, 2, 3, 4]))
    expect(outcome.revision.revision).toBe(1)
  })

  it('binds a regenerated revision to the latest prompt approval digest', async () => {
    const h = harness()
    const oldDigest = 'a'.repeat(64)
    const latestDigest = 'b'.repeat(64)
    const input = {
      ...h.input,
      persistedSession: {
        ...h.input.persistedSession,
        session: {
          ...h.input.persistedSession.session,
          approvals: [
            { stage: 'prompt' as const, approvedAt: '2026-09-21T00:00:00Z', human: 'Guru', promptDigest: oldDigest },
            { stage: 'prompt' as const, approvedAt: '2026-09-22T00:00:00Z', human: 'Guru', promptDigest: latestDigest },
          ],
        },
      },
    }

    await recordGeneratedRevision(input)
    const saved = h.savedSidecars[0] as { revisions: Array<{ promptDigest: string }> }
    expect(saved.revisions.at(-1)?.promptDigest).toBe(latestDigest)
  })

  it('rejects before touching disk when the download header disagrees with the job artifact digest', async () => {
    const h = harness()
    h.input.fetchArtifact = vi.fn(() => Promise.resolve({ bytes: new Uint8Array([1, 2, 3, 4]), sha256Header: 'bb'.repeat(32) }))

    await expect(recordGeneratedRevision(h.input)).rejects.toThrow('artifact digest mismatch')
    expect(h.publishedManifests).toEqual([])
  })

  it('rejects before touching disk when the downloaded bytes do not hash to the declared digest', async () => {
    const h = harness()
    h.input.fetchArtifact = vi.fn(() => Promise.resolve({ bytes: new Uint8Array([9, 9, 9, 9]), sha256Header: '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a' }))

    await expect(recordGeneratedRevision(h.input)).rejects.toThrow('artifact content digest mismatch')
    expect(h.revisionWrites).toEqual([])
    expect(h.publishedManifests).toEqual([])
  })

  it('refuses to relabel a raster fal artifact as a vector SVG master', async () => {
    const h = harness()
    const vectorSession = {
      ...SESSION,
      prompt: { ...SESSION.prompt, contentType: 'vector' as const },
    }
    const input = {
      ...h.input,
      persistedSession: { session: vectorSession, snapshot: 'sidecar-text', checksum: 'c'.repeat(32) },
    }

    await expect(recordGeneratedRevision(input)).rejects.toThrow(/requires an SVG artifact/)
    expect(h.revisionWrites).toEqual([])
    expect(h.publishedManifests).toEqual([])
  })

  it('records a regenerate as the next revision of an existing asset instead of a new asset', async () => {
    const existingAsset = {
      asset_id: UUID,
      content_type: 'illustration',
      creation_method: 'generative_ai',
      revisions: [{ revision: 1, generation_format: 'png', working_format: 'png', master_format: 'png', submission_format: 'jpeg', relative_path: `revisions/${UUID}/rev-1.png` }],
    }
    const h = harnessWithAssets([existingAsset])
    const outcome = await recordGeneratedRevision({ ...h.input, assetId: UUID })

    expect(h.revisionWrites).toEqual(['rev-2.png'])
    const manifest = h.publishedManifests[0] as { assets: Array<{ asset_id: string; revisions: Array<{ revision: number; relative_path: string }> }> }
    expect(manifest.assets).toHaveLength(1)
    expect(manifest.assets[0]!.asset_id).toBe(UUID)
    expect(manifest.assets[0]!.revisions).toHaveLength(2)
    expect(manifest.assets[0]!.revisions[1]!.revision).toBe(2)
    expect(outcome.revision.revision).toBe(2)
  })

  it('refuses an existing revision file and never republishes the manifest', async () => {
    const h = harness()
    h.directory.getDirectoryHandle = vi.fn(() => Promise.resolve({
      getDirectoryHandle: () => Promise.resolve({
        getFileHandle: () => Promise.resolve({ createWritable: () => { throw new Error('must not be called') } }),
      }),
    }))

    await expect(recordGeneratedRevision(h.input)).rejects.toThrow('already exists')
    expect(h.publishedManifests).toEqual([])
  })

  it('refuses a revision when the on-disk manifest diverges from the approved snapshot (external-change guard)', async () => {
    const h = harness()
    const input = {
      ...h.input,
      readCurrentManifestText: vi.fn(() => Promise.resolve('{"schema_version":1,"project_id":"3f2b8a64-9c1d-4e7a-b2f5-8d60c1a94e21","project_name":"Demo Stok","assets":[{"asset_id":"updated-externally"}]}')),
    }

    await expect(recordGeneratedRevision(input as typeof h.input)).rejects.toThrow('project manifest changed externally')
    expect(h.revisionWrites).toEqual([])
    expect(h.savedSidecars).toEqual([])
    expect(h.publishedManifests).toEqual([])
  })
})
