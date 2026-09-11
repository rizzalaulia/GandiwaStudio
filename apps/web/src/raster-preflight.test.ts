import { describe, expect, it, vi } from 'vitest'

import { preflightRaster } from './raster-preflight'

describe('preflightRaster', () => {
  it('obtains CSRF then posts only raw raster bytes and untrusted metadata', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ csrf_token: 'csrf-token' }) })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          verdict: 'pass',
          detected_mime_type: 'image/jpeg',
          detected_extension: 'jpeg',
          width: 2000,
          height: 2000,
          megapixels: 4,
          has_alpha: false,
          eligible_for_submission: true,
          findings: [],
        }),
      })
    const file = new File(['synthetic-raster'], 'photo.jpeg', { type: 'image/jpeg' })

    const report = await preflightRaster(file, 'photo', fetchMock)

    expect(report.verdict).toBe('pass')
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/v1/auth/csrf', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    })
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/v1/raster/preflight?content_type=photo', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'image/jpeg',
        'X-CSRF-Token': 'csrf-token',
        'X-Upload-Filename': 'photo.jpeg',
      },
      body: file,
    })
  })

  it('rejects an unsupported browser file type before contacting the API', async () => {
    const fetchMock = vi.fn()
    const file = new File(['not-a-raster'], 'vector.svg', { type: 'image/svg+xml' })

    await expect(preflightRaster(file, 'illustration', fetchMock)).rejects.toThrow(
      'Choose a PNG or JPEG file for raster preflight.',
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
