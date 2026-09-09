import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'

describe('App shell', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('renders real backend and worker state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        version: '0.0.0',
        mvp_version: 'mvp-1.0',
        backend: { health: 'ok', ready: true, checks: { database: true, migration: true, queue: true, artifacts_dir: true } },
        worker: { status: 'running', heartbeat_at: '2026-09-09T02:00:00+00:00' },
      }),
    }))

    render(<App />)
    await waitFor(() => expect(screen.getByText('Backend connected')).toBeVisible())
    expect(screen.getAllByText('Worker online').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByLabelText('MVP mvp-1.0')).toBeVisible()
    expect(screen.getByRole('button', { name: /Create Project/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Open Project/i })).toBeDisabled()
    expect(screen.getByText('Project creation and opening arrive in Stage 2.')).toBeVisible()
    expect(screen.queryByRole('button', { name: /generate/i })).not.toBeInTheDocument()
  })

  it('shows an actionable offline state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Failed to fetch')))

    render(<App />)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Backend unavailable'))
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible()
    expect(screen.getByRole('button', { name: /Create Project/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Open Project/i })).toBeDisabled()
  })

  it('keeps the newest status when requests complete out of order', async () => {
    let resolveFirst: ((value: Response) => void) | undefined
    const first = new Promise<Response>((resolve) => {
      resolveFirst = resolve
    })
    const second = Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        version: '0.0.0',
        mvp_version: 'mvp-1.0',
        backend: { health: 'ok', ready: false, checks: {} },
        worker: { status: 'stopped', heartbeat_at: null },
      }),
    } as Response)
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second))

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }))
    await waitFor(() => expect(screen.getByText('Readiness checks are not passing.')).toBeVisible())

    await act(async () => {
      resolveFirst?.({
        ok: true,
        json: () => Promise.resolve({
          version: '0.0.0',
          mvp_version: 'mvp-1.0',
          backend: { health: 'ok', ready: true, checks: {} },
          worker: { status: 'running', heartbeat_at: null },
        }),
      } as Response)
      await first
    })

    await waitFor(() => {
      expect(screen.getByText('Readiness checks are not passing.')).toBeVisible()
      expect(screen.queryByText('Backend connected')).not.toBeInTheDocument()
    })
  })

  it('clears stale runtime state when a refresh loses the backend', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          version: '0.0.0',
          mvp_version: 'mvp-1.0',
          backend: { health: 'ok', ready: true, checks: {} },
          worker: { status: 'running', heartbeat_at: null },
        }),
      })
      .mockRejectedValueOnce(new Error('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)
    await waitFor(() => expect(screen.getAllByText('Worker online').length).toBeGreaterThan(0))

    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Backend unavailable'))
    expect(screen.getAllByText('Worker unavailable').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /Create Project/i })).toBeDisabled()
  })
})
