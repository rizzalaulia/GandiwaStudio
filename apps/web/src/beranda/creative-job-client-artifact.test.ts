import { afterEach, describe, expect, it, vi } from 'vitest'

import { downloadCreativeArtifact } from './creative-job-client'

// Issue #26 slice artifact-revision: a succeeded job's artifact may be
// downloaded only by its signed-session owner, as a private attachment.
// The client surfaces the transport digest header so the caller can check
// it against the job's declared artifact digest before trusting bytes.

describe('downloadCreativeArtifact', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('fetches the owner-scoped download URL with same-origin credentials', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url
      if (url.endsWith('/api/v1/artifacts/art-1/download')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'X-Gandiwa-SHA256': '9f'.repeat(32) }),
          arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3, 4]).buffer),
        })
      }
      return Promise.reject(new Error(`unexpected request: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)

    const download = await downloadCreativeArtifact('art-1')

    expect(download.bytes).toEqual(new Uint8Array([1, 2, 3, 4]))
    expect(download.sha256Header).toBe('9f'.repeat(32))
    expect(fetchMock.mock.calls.map(([request]) => (typeof request === 'string' ? request : request instanceof URL ? request.href : request.url))).toEqual([
      '/api/v1/artifacts/art-1/download',
    ])
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init?.credentials).toBe('same-origin')
  })

  it('reports a failed download without pretending bytes arrived', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ detail: 'Artifact not found' }),
    })))

    await expect(downloadCreativeArtifact('art-404')).rejects.toThrow('Artifact not found')
  })
})
