import 'fake-indexeddb/auto'

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const handleStore = vi.hoisted(() => ({
  load: vi.fn<() => Promise<unknown>>(),
  remember: vi.fn<() => Promise<void>>(),
}))

vi.mock('./project-handle-store', () => ({
  loadRememberedProjectDirectory: handleStore.load,
  rememberProjectDirectory: handleStore.remember,
}))

import { App } from './App'

describe('App shell', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    handleStore.load.mockResolvedValue(undefined)
    handleStore.remember.mockResolvedValue()
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
    expect(screen.getByRole('button', { name: /^Open Project$/i })).toBeEnabled()
    expect(screen.getByRole('button', { name: /^Reopen remembered project$/i })).toBeDisabled()
    expect(screen.getByText(/Create Project and Open Project use a Chrome or Edge folder picker/i)).toBeVisible()
    expect(screen.queryByRole('button', { name: /generate/i })).not.toBeInTheDocument()
  })

  it('reopens a preloaded local handle with permission recovery from the button action', async () => {
    const manifest = JSON.stringify({
      schema_version: 1,
      project_id: '6e9e0cd4-7b2e-46fc-84ad-5a40816bdca1',
      project_name: 'Burung Laut',
      assets: [],
    })
    const directory = {
      queryPermission: vi.fn(() => Promise.resolve<'prompt'>('prompt')),
      requestPermission: vi.fn(() => Promise.resolve<'granted'>('granted')),
      getFileHandle: vi.fn(() => Promise.resolve({ getFile: () => Promise.resolve({ text: () => Promise.resolve(manifest) }) })),
    }
    handleStore.load.mockResolvedValueOnce(directory)
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
    const reopen = await screen.findByRole('button', { name: /^Reopen remembered project$/i })
    await waitFor(() => expect(reopen).toBeEnabled())

    fireEvent.click(reopen)

    expect(directory.requestPermission).toHaveBeenCalledWith({ mode: 'read' })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Project “Burung Laut” opened locally.'))
    expect(directory.getFileHandle).toHaveBeenCalledWith('gandiwa-project.json', { create: false })
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

  it('preflights a selected JPEG for the active project without claiming Adobe-ready', async () => {
    const manifest = JSON.stringify({
      schema_version: 1,
      project_id: 'f0a14fd6-dfca-4d5a-94fa-bb789d8639d3',
      project_name: 'Burung Laut',
      assets: [],
    })
    const directory = {
      queryPermission: vi.fn(() => Promise.resolve<'granted'>('granted')),
      requestPermission: vi.fn(() => Promise.resolve<'granted'>('granted')),
      getFileHandle: vi.fn(() => Promise.resolve({ getFile: () => Promise.resolve({ text: () => Promise.resolve(manifest) }) })),
    }
    vi.stubGlobal('showDirectoryPicker', vi.fn(() => Promise.resolve(directory)))
    vi.stubGlobal('fetch', vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          version: '0.0.0',
          mvp_version: 'mvp-1.0',
          backend: { health: 'ok', ready: true, checks: {} },
          worker: { status: 'idle', heartbeat_at: null },
        }),
      })
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
      }))

    render(<App />)
    await waitFor(() => expect(screen.getByText('Backend connected')).toBeVisible())
    fireEvent.click(screen.getByRole('button', { name: /^Open Project$/i }))
    await waitFor(() => expect(screen.getByRole('region', { name: 'Active project' })).toHaveTextContent('Burung Laut'))

    const rasterInput = screen.getByLabelText('Raster file to preflight')
    fireEvent.change(rasterInput, {
      target: { files: [new File(['synthetic-raster'], 'photo.jpeg', { type: 'image/jpeg' })] },
    })

    await waitFor(() => expect(screen.getByText('Technical preflight: PASS')).toBeVisible())
    expect(screen.getByText('Eligible for JPEG submission: yes')).toBeVisible()
    expect(screen.queryByText(/Adobe-ready/i)).not.toBeInTheDocument()
  })

  it('shows only a raster PNG preview after SVG preflight for the active project', async () => {
    const manifest = JSON.stringify({
      schema_version: 1,
      project_id: 'f0a14fd6-dfca-4d5a-94fa-bb789d8639d3',
      project_name: 'Burung Laut',
      assets: [],
    })
    const directory = {
      queryPermission: vi.fn(() => Promise.resolve<'granted'>('granted')),
      requestPermission: vi.fn(() => Promise.resolve<'granted'>('granted')),
      getFileHandle: vi.fn(() => Promise.resolve({ getFile: () => Promise.resolve({ text: () => Promise.resolve(manifest) }) })),
    }
    vi.stubGlobal('showDirectoryPicker', vi.fn(() => Promise.resolve(directory)))
    vi.stubGlobal('fetch', vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          version: '0.0.0',
          mvp_version: 'mvp-1.0',
          backend: { health: 'ok', ready: true, checks: {} },
          worker: { status: 'idle', heartbeat_at: null },
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ csrf_token: 'csrf-token' }) })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          verdict: 'pass',
          eligible_for_submission: true,
          findings: [],
          preview_url: '/api/v1/svg/preflight/previews/0123456789abcdef0123456789abcdef',
        }),
      }))

    render(<App />)
    await waitFor(() => expect(screen.getByText('Backend connected')).toBeVisible())
    fireEvent.click(screen.getByRole('button', { name: /^Open Project$/i }))
    await waitFor(() => expect(screen.getByRole('region', { name: 'Active project' })).toHaveTextContent('Burung Laut'))

    fireEvent.change(screen.getByLabelText('SVG file to preflight'), {
      target: { files: [new File(['<svg/>'], 'bird.svg', { type: 'image/svg+xml' })] },
    })

    await waitFor(() => expect(screen.getByText('SVG preflight: PASS')).toBeVisible())
    const preview = screen.getByRole('img', { name: 'Safe SVG raster preview' })
    expect(preview).toHaveAttribute('src', '/api/v1/svg/preflight/previews/0123456789abcdef0123456789abcdef')
    expect(screen.queryByText('<svg/>')).not.toBeInTheDocument()
  })

  it('keeps Reopen available after Open then Close in the same session', async () => {
    const manifest = JSON.stringify({
      schema_version: 1,
      project_id: 'f0a14fd6-dfca-4d5a-94fa-bb789d8639d3',
      project_name: 'Burung Laut',
      assets: [],
    })
    const directory = {
      queryPermission: vi.fn(() => Promise.resolve<'granted'>('granted')),
      requestPermission: vi.fn(() => Promise.resolve<'granted'>('granted')),
      getFileHandle: vi.fn(() => Promise.resolve({ getFile: () => Promise.resolve({ text: () => Promise.resolve(manifest) }) })),
    }
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
    fireEvent.click(screen.getByRole('button', { name: /^Open Project$/i }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Project “Burung Laut” opened locally.'))
    expect(screen.getByRole('button', { name: 'Reopen remembered project' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Close project' }))

    expect(screen.queryByRole('region', { name: 'Active project' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reopen remembered project' })).toBeEnabled()
  })

  it('ignores a delayed external-change result after another project becomes active', async () => {
    const manifestA = JSON.stringify({
      schema_version: 1,
      project_id: 'f0a14fd6-dfca-4d5a-94fa-bb789d8639d3',
      project_name: 'Burung Laut',
      assets: [],
    })
    const manifestB = JSON.stringify({
      schema_version: 1,
      project_id: '08b1a647-d499-4c42-97d9-7bd5116b1c3a',
      project_name: 'Burung Senja',
      assets: [],
    })
    let delayExternalRead = false
    let resolveExternalRead: ((value: string) => void) | undefined
    const directoryA = {
      queryPermission: vi.fn(() => Promise.resolve<'granted'>('granted')),
      requestPermission: vi.fn(() => Promise.resolve<'granted'>('granted')),
      getFileHandle: vi.fn(() => Promise.resolve({
        getFile: () => Promise.resolve({
          text: () => delayExternalRead
            ? new Promise<string>((resolve) => { resolveExternalRead = resolve })
            : Promise.resolve(manifestA),
        }),
      })),
    }
    const directoryB = {
      queryPermission: vi.fn(() => Promise.resolve<'granted'>('granted')),
      requestPermission: vi.fn(() => Promise.resolve<'granted'>('granted')),
      getFileHandle: vi.fn(() => Promise.resolve({ getFile: () => Promise.resolve({ text: () => Promise.resolve(manifestB) }) })),
    }
    vi.stubGlobal('showDirectoryPicker', vi.fn().mockResolvedValueOnce(directoryA).mockResolvedValueOnce(directoryB))
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
    fireEvent.click(screen.getByRole('button', { name: /^Open Project$/i }))
    await waitFor(() => expect(screen.getByRole('region', { name: 'Active project' })).toHaveTextContent('Burung Laut'))

    delayExternalRead = true
    fireEvent.click(screen.getByRole('button', { name: 'Check for external changes' }))
    await waitFor(() => expect(directoryA.getFileHandle).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole('button', { name: /^Open Project$/i }))
    await waitFor(() => expect(screen.getByRole('region', { name: 'Active project' })).toHaveTextContent('Burung Senja'))

    act(() => {
      resolveExternalRead?.(manifestA.replace('Burung Laut', 'Burung Fajar'))
    })

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'External manifest change detected' })).not.toBeInTheDocument())
    expect(screen.getByRole('region', { name: 'Active project' })).toHaveTextContent('Burung Senja')
  })

  it('holds an external manifest change for reload, save-copy, or cancel instead of blind overwrite', async () => {
    let manifest = JSON.stringify({
      schema_version: 1,
      project_id: '6e9e0cd4-7b2e-46fc-84ad-5a40816bdca1',
      project_name: 'Burung Laut',
      assets: [],
    })
    const directory = {
      queryPermission: vi.fn(() => Promise.resolve<'granted'>('granted')),
      requestPermission: vi.fn(() => Promise.resolve<'granted'>('granted')),
      getFileHandle: vi.fn((name: string, options?: { create?: boolean }) => {
        if (name === 'gandiwa-project.json' && !options?.create) {
          return Promise.resolve({ getFile: () => Promise.resolve({ text: () => Promise.resolve(manifest) }) })
        }
        return Promise.reject(new DOMException('Not found', 'NotFoundError'))
      }),
    }
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
    fireEvent.click(screen.getByRole('button', { name: /^Open Project$/i }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Project “Burung Laut” opened locally.'))

    manifest = JSON.stringify({
      schema_version: 1,
      project_id: '6e9e0cd4-7b2e-46fc-84ad-5a40816bdca1',
      project_name: 'Burung Senja',
      assets: [],
    })
    const externalChangeChecker = screen.getByRole('button', { name: 'Check for external changes' })
    fireEvent.click(externalChangeChecker)

    const dialog = await screen.findByRole('dialog', { name: 'External manifest change detected' })
    expect(dialog).toHaveTextContent('Burung Senja')
    const reload = screen.getByRole('button', { name: 'Reload external manifest' })
    expect(reload).toBeVisible()
    expect(reload).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Save current manifest as copy' })).toBeVisible()
    const cancel = screen.getByRole('button', { name: 'Cancel external change decision' })
    expect(cancel).toBeVisible()

    cancel.focus()
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(reload).toHaveFocus()
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(cancel).toHaveFocus()

    cancel.focus()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'External manifest change detected' })).not.toBeInTheDocument())
    expect(externalChangeChecker).toHaveFocus()
    expect(screen.getByRole('region', { name: 'Active project' })).toHaveTextContent('Burung Laut')

    fireEvent.click(screen.getByRole('button', { name: 'Check for external changes' }))
    await screen.findByRole('dialog', { name: 'External manifest change detected' })
    fireEvent.click(screen.getByRole('button', { name: 'Reload external manifest' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Reloaded external manifest for “Burung Senja”.'))
    expect(screen.getByRole('region', { name: 'Active project' })).toHaveTextContent('Burung Senja')
    expect(directory.getFileHandle).toHaveBeenCalledWith('gandiwa-project.json', { create: false })
    expect(directory.getFileHandle).not.toHaveBeenCalledWith('gandiwa-project.json', { create: true })
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
    expect(screen.getByRole('button', { name: /^Open Project$/i })).toBeEnabled()
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
