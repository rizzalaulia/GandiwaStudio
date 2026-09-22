import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchStatus } from './status-client'

// Issue #26 (opsi B) — status-client merges the two honest runtime
// endpoints into one chip-row view: /api/v1/status (backend + worker) and
// /api/v1/providers (configured connectors, never secrets). Pure mapping,
// fail-closed defaults, no invented health.

function mockFetch(routes: Record<string, { ok: boolean; status?: number; body: unknown }>) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String((input).url)
    for (const [path, response] of Object.entries(routes)) {
      if (url.endsWith(path)) {
        return Promise.resolve({
          ok: response.ok,
          status: response.status ?? (response.ok ? 200 : 500),
          json: () => Promise.resolve(response.body),
        })
      }
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) })
  })
}

describe('fetchStatus (Status tab data)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('merges backend, worker, and provider states from the two endpoints', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        '/api/v1/status': {
          ok: true,
          body: {
            version: '0.1.0',
            mvp_version: 'mvp-1.0',
            backend: { health: 'ok', ready: true, checks: {} },
            worker: { status: 'idle', heartbeat_at: null },
          },
        },
        '/api/v1/providers': {
          ok: true,
          body: [
            { id: 'fal', name: 'fal.ai', configured: true, auth_required: false },
            { id: '9router', name: '9Router', configured: false, auth_required: true },
          ],
        },
      }),
    )
    const view = await fetchStatus()
    expect(view.backend).toEqual({ health: 'ok', ready: true })
    expect(view.worker.status).toBe('idle')
    expect(view.providers).toEqual([
      { provider: 'fal', configured: true, testable: true },
      { provider: '9router', configured: false, testable: false },
    ])
  })

  it('fails closed: unavailable pieces read as down, never as healthy', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        '/api/v1/status': {
          ok: true,
          body: { version: 'x', mvp_version: 'mvp-1.0', backend: null, worker: null },
        },
        '/api/v1/providers': { ok: false, status: 503, body: {} },
      }),
    )
    const view = await fetchStatus()
    expect(view.backend.health).toBe('unknown')
    expect(view.backend.ready).toBe(false)
    expect(view.worker.status).toBe('unavailable')
    expect(view.providers).toEqual([])
  })

  it('throws a human error when the status endpoint itself is down', async () => {
    vi.stubGlobal('fetch', mockFetch({ '/': { ok: false, status: 500, body: {} } }))
    await expect(fetchStatus()).rejects.toThrow('Permintaan status backend gagal')
  })
})
