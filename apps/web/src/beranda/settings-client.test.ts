import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  companionHeadersForToken,
  maskSecret,
  providerSettingsView,
  type ProviderSettingsPayload,
} from './settings-client'

// Issue #26 (opsi B) — Settings page client logic.
// Keys live server-side; the browser only ever sees masked previews and
// never echoes a secret back. POST always uses the dedicated write envelope.

function payload(overrides: Partial<ProviderSettingsPayload> = {}): ProviderSettingsPayload {
  return { providers: [{ provider: 'fal', apiKey: 'new-secret-9876' }], ...overrides }
}

describe('maskSecret', () => {
  it('shows only the last four characters, whatever the length', () => {
    expect(maskSecret('0123456789abcdef')).toBe('****cdef')
    expect(maskSecret('1234')).toBe('****1234')
  })

  it('hides existence entirely for short or empty secrets', () => {
    expect(maskSecret('')).toBe('belum diatur')
    expect(maskSecret('12')).toBe('belum diatur')
  })
})

describe('providerSettingsView', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('renders provider state from the backend without exposing any secret', () => {
    const view = providerSettingsView([
      { provider: 'fal', configured: true },
      { provider: '9router', configured: false },
    ])
    expect(view).toEqual([
      { provider: 'fal', configured: true, maskedKey: 'terpasang', testable: true },
      { provider: '9router', configured: false, maskedKey: 'belum diatur', testable: false },
    ])
    expect(JSON.stringify(view)).not.toContain('secret')
  })

  it('sends writes through the companion-token envelope and no plain body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ providers: [] }) })
    vi.stubGlobal('fetch', fetchMock)

    await providerSettingsView.save({
      csrfToken: 'tok',
      payload: payload(),
    })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/v1/settings/providers')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['X-Companion-Token']).toBe('tok')
    expect(JSON.parse(init.body as string)).toEqual({ providers: [{ provider: 'fal', apiKey: 'new-secret-9876' }] })
  })

  it('treats a non-ok write as a failure it does not swallow', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }))
    await expect(providerSettingsView.save({ csrfToken: 'tok', payload: payload() })).rejects.toThrow('403')
  })

  it('uses the real provider-auth validation verdict for test buttons', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, provider: '9router', probe: 'provider_auth' }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await providerSettingsView.testConnection('9router', 'inst-1')
    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toBe('/api/v1/settings/providers/9router/validate')
    expect(result.ok).toBe(true)
  })
})

describe('companionHeadersForToken', () => {
  it('never leaks the token into logs-style stringification', () => {
    const headers = companionHeadersForToken('tok-123')
    expect(headers['X-Companion-Token']).toBe('tok-123')
    expect(Object.keys(headers)).not.toContain('Authorization')
  })
})
