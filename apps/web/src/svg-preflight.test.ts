import { describe, expect, it, vi } from 'vitest'

import { preflightSvg } from './svg-preflight'

describe('preflightSvg', () => {
  it('obtains CSRF then posts SVG bytes and accepts only an API PNG preview path', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ csrf_token: 'csrf-token' }) })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          verdict: 'pass',
          eligible_for_submission: true,
          findings: [],
          preview_url: '/api/v1/svg/preflight/previews/0123456789abcdef0123456789abcdef',
        }),
      })
    const file = new File(['<svg/>'], 'illustration.svg', { type: 'image/svg+xml' })

    const report = await preflightSvg(file, 'vector', fetchMock)

    expect(report.preview_url).toBe('/api/v1/svg/preflight/previews/0123456789abcdef0123456789abcdef')
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/v1/auth/csrf', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    })
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/v1/svg/preflight?content_type=vector', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'image/svg+xml',
        'X-CSRF-Token': 'csrf-token',
        'X-Upload-Filename': 'illustration.svg',
      },
      body: file,
    })
  })

  it('rejects a non-SVG browser file before contacting the API', async () => {
    const fetchMock = vi.fn()
    const file = new File(['not-svg'], 'photo.png', { type: 'image/png' })

    await expect(preflightSvg(file, 'vector', fetchMock)).rejects.toThrow(
      'Choose an SVG file for vector preflight.',
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a response that tries to return raw previews instead of an API preview URL', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ csrf_token: 'csrf-token' }) })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          verdict: 'pass',
          eligible_for_submission: true,
          findings: [],
          preview_url: 'data:image/png;base64,unsafe',
        }),
      })
    const file = new File(['<svg/>'], 'illustration.svg', { type: 'image/svg+xml' })

    await expect(preflightSvg(file, 'vector', fetchMock)).rejects.toThrow(
      'SVG preflight returned an invalid technical report.',
    )
  })
})
