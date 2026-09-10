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
    expect(screen.getByRole('button', { name: /^Create Project$/i })).toBeEnabled()
    expect(screen.getByRole('button', { name: /Open Project/i })).toBeDisabled()
    expect(screen.getByText(/Create Project uses a Chrome or Edge folder picker/i)).toBeVisible()
    expect(screen.queryByRole('button', { name: /generate/i })).not.toBeInTheDocument()
  })

  it('closes Create Project with Escape and restores focus to its opener', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        version: '0.0.0',
        mvp_version: 'mvp-1.0',
        backend: { health: 'ok', ready: true, checks: {} },
        worker: { status: 'idle', heartbeat_at: null },
      }),
    }))

    render(<App />)
    await waitFor(() => expect(screen.getByText('Backend connected')).toBeVisible())
    const opener = screen.getByRole('button', { name: /^Create Project$/i })
    opener.focus()
    fireEvent.click(opener)
    expect(screen.getByRole('dialog', { name: 'Create local project' })).toBeVisible()

    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Create local project' }), { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create local project' })).not.toBeInTheDocument())
    expect(opener).toHaveFocus()
  })

  it('keeps Tab focus within Create Project', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        version: '0.0.0',
        mvp_version: 'mvp-1.0',
        backend: { health: 'ok', ready: true, checks: {} },
        worker: { status: 'idle', heartbeat_at: null },
      }),
    }))

    render(<App />)
    await waitFor(() => expect(screen.getByText('Backend connected')).toBeVisible())
    fireEvent.click(screen.getByRole('button', { name: /^Create Project$/i }))
    const dialog = screen.getByRole('dialog', { name: 'Create local project' })
    const nameInput = screen.getByLabelText('Project name')
    const submit = screen.getByRole('button', { name: 'Choose empty folder and create project' })

    submit.focus()
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(nameInput).toHaveFocus()
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(submit).toHaveFocus()
  })

  it('opens Create Project, collects the MVP choices, and reports a local project created', async () => {
    type FileStub = { createWritable: () => Promise<{ write: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> }
    type DirectoryStub = {
      directories: Map<string, DirectoryStub>
      files: Map<string, FileStub>
      getDirectoryHandle: ReturnType<typeof vi.fn>
      getFileHandle: ReturnType<typeof vi.fn>
      removeEntry: ReturnType<typeof vi.fn>
      values: () => AsyncIterable<unknown>
    }
    const createDirectory = (): DirectoryStub => {
      const directories = new Map<string, DirectoryStub>()
      const files = new Map<string, FileStub>()
      return {
        directories,
        files,
        getDirectoryHandle: vi.fn((name: string, options?: { create?: boolean }) => {
          const existing = directories.get(name)
          if (existing) return Promise.resolve(existing)
          if (!options?.create) return Promise.reject(new DOMException('Not found', 'NotFoundError'))
          const created = createDirectory()
          directories.set(name, created)
          return Promise.resolve(created)
        }),
        getFileHandle: vi.fn((name: string, options?: { create?: boolean }) => {
          const existing = files.get(name)
          if (existing) return Promise.resolve(existing)
          if (!options?.create) return Promise.reject(new DOMException('Not found', 'NotFoundError'))
          const created: FileStub = {
            createWritable: () => Promise.resolve({ write: vi.fn(() => Promise.resolve()), close: vi.fn(() => Promise.resolve()) }),
          }
          files.set(name, created)
          return Promise.resolve(created)
        }),
        removeEntry: vi.fn((name: string) => {
          files.delete(name)
          return Promise.resolve()
        }),
        // eslint-disable-next-line @typescript-eslint/require-await
        async *values(): AsyncIterable<unknown> {
          yield* directories.values()
          yield* files.values()
        },
      }
    }
    const directory = createDirectory()
    vi.stubGlobal('showDirectoryPicker', vi.fn(() => Promise.resolve(directory)))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        version: '0.0.0',
        mvp_version: 'mvp-1.0',
        backend: { health: 'ok', ready: true, checks: {} },
        worker: { status: 'idle', heartbeat_at: null },
      }),
    }))

    render(<App />)
    await waitFor(() => expect(screen.getByText('Backend connected')).toBeVisible())
    fireEvent.click(screen.getByRole('button', { name: /^Create Project$/i }))
    expect(screen.getByRole('dialog', { name: 'Create local project' })).toBeVisible()

    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Burung Laut' } })
    fireEvent.change(screen.getByLabelText('Content type'), { target: { value: 'vector' } })
    fireEvent.change(screen.getByLabelText('Creation method'), { target: { value: 'manual_digital' } })
    fireEvent.click(screen.getByRole('button', { name: 'Choose empty folder and create project' }))

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Project “Burung Laut” created locally.'))
    expect((globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker).toHaveBeenCalledTimes(1)
  })

  it('reports picker cancellation without presenting a project as created', async () => {
    vi.stubGlobal('showDirectoryPicker', vi.fn(() => Promise.reject(new DOMException('User cancelled', 'AbortError'))))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        version: '0.0.0',
        mvp_version: 'mvp-1.0',
        backend: { health: 'ok', ready: true, checks: {} },
        worker: { status: 'idle', heartbeat_at: null },
      }),
    }))

    render(<App />)
    await waitFor(() => expect(screen.getByText('Backend connected')).toBeVisible())
    fireEvent.click(screen.getByRole('button', { name: /^Create Project$/i }))
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Burung Laut' } })
    fireEvent.click(screen.getByRole('button', { name: 'Choose empty folder and create project' }))

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Project creation cancelled.'))
    expect(screen.queryByText(/created locally/i)).not.toBeInTheDocument()
  })

  it('shows an actionable offline state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Failed to fetch')))

    render(<App />)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Backend unavailable'))
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible()
    expect(screen.getByRole('button', { name: /^Create Project$/i })).toBeEnabled()
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
    await waitFor(() => expect(screen.getByText('Local project creation remains available while backend checks recover.')).toBeVisible())

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
      expect(screen.getByText('Local project creation remains available while backend checks recover.')).toBeVisible()
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
    expect(screen.getByRole('button', { name: /^Create Project$/i })).toBeEnabled()
  })
})
