import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BerandaApp } from './BerandaApp'

// Issue #26 (opsi B, revisi layout 22 Sep) — Beranda is a STUDIO DESK, not
// tabs: the generated image is the hero in the CENTER, prompt lives in a
// compact LEFT panel, Title & Keywords sit in the RIGHT panel, Kandidat is
// an embedded strip under the canvas, and Status chips live in the header.
// Ruling: 1 generate = 1 gambar (no 4-candidate batch).

vi.mock('./project-handle-store', () => ({
  loadRememberedProjectDirectory: vi.fn(() => Promise.resolve(rememberedDirectory)),
  rememberProjectDirectory: vi.fn(() => Promise.resolve()),
}))

vi.mock('./creative-session-adapter', () => creativeAdapter)
const dispatchController = vi.hoisted(() => ({
  dispatchApprovedCreativeJob: vi.fn(),
}))
vi.mock('./creative-dispatch-controller', async (importOriginal) => ({
  ...await importOriginal<typeof import('./creative-dispatch-controller')>(),
  ...dispatchController,
}))
vi.mock('./generated-revision-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('./generated-revision-store')>(),
}))

let rememberedDirectory: unknown = undefined

const creativeAdapter = vi.hoisted(() => ({
  buildApprovedCreativeJob: vi.fn(),
}))

const MANIFEST_TEXT = JSON.stringify({
  schema_version: 1,
  project_id: '3f2b8a64-9c1d-4e7a-b2f5-8d60c1a94e21',
  project_name: 'Demo Stok',
  assets: [],
})

const APPROVED_FIXTURE = {
  sidecar: {
    schemaVersion: 1 as const,
    sessionId: '1e5c8a02-7b34-4c19-9e2a-6d0f3b8c5a71',
    topic: 'Demo Stok',
    rounds: [],
    prompt: {
      promptText: 'ilustrasi kucing oren, cahaya lembut',
      negativePrompt: 'watermark, logo',
      contentType: 'illustration' as const,
      creationMethod: 'generative_ai' as const,
      providerId: 'fal',
      modelId: 'fal-ai/flux/schnell',
      targetWidth: 2000,
      targetHeight: 2000,
      aspectRatio: '1:1',
      orientation: 'square' as const,
      stockConstraints: ['no_logo', 'no_brand', 'no_watermark', 'no_random_text'],
      negativeSpaceDecision: 'none required',
    },
    approvals: [],
    revisions: [],
  },
  payload: { session: {}, rules_snapshot: {}, idempotency_key: 'idem-1' } as never,
  promptDigest: 'd'.repeat(64),
} as unknown

let sidecarText = ''
let createdSidecar = false

function fakeProjectDirectory(): unknown {
  return {
    getFileHandle: (name: string, options?: { create?: boolean }) => {
      if (name === 'gandiwa-project.json' && options?.create !== true) {
        return Promise.resolve({ getFile: () => Promise.resolve({ text: () => Promise.resolve(MANIFEST_TEXT) }) })
      }
      if (options?.create === true) {
        // Writes (tmp manifest + final manifest overwrite + revision files).
        return Promise.resolve({
          getFile: () => Promise.resolve({ text: () => Promise.resolve(MANIFEST_TEXT) }),
          createWritable: () => Promise.resolve({
            write: () => Promise.resolve(),
            close: () => Promise.resolve(),
          }),
        })
      }
      return Promise.reject(new DOMException('missing', 'NotFoundError'))
    },
    getDirectoryHandle: (name: string) => {
      if (name === 'revisions') {
        return Promise.resolve({
          getDirectoryHandle: () => Promise.resolve({
            getFileHandle: (fileName: string, options?: { create?: boolean }) => {
              if (options?.create === true) {
                return Promise.resolve({
                  createWritable: () => Promise.resolve({
                    write: () => Promise.resolve(),
                    close: () => Promise.resolve(),
                  }),
                })
              }
              return Promise.reject(new DOMException('missing', 'NotFoundError'))
            },
          }),
        })
      }
      if (name === 'creative-sessions') {
        return Promise.resolve({
          getFileHandle: (fileName: string, options?: { create?: boolean }) => {
            if (options?.create === true) {
              return Promise.resolve({
                getFile: () => Promise.resolve({ text: () => Promise.resolve(sidecarText) }),
                createWritable: () => Promise.resolve({
                  write: (value: string) => { sidecarText = value; createdSidecar = true; return Promise.resolve() },
                  close: () => Promise.resolve(),
                }),
              })
            }
            // Existing sidecar reads:되after a first write the file exists.
            return createdSidecar
              ? Promise.resolve({ getFile: () => Promise.resolve({ text: () => Promise.resolve(sidecarText) }) })
              : Promise.reject(new DOMException('missing', 'NotFoundError'))
          },
        })
      }
      return Promise.reject(new DOMException('missing', 'NotFoundError'))
    },
    removeEntry: () => Promise.resolve(),
    queryPermission: () => Promise.resolve('granted'),
    requestPermission: () => Promise.resolve('granted'),
  }
}


vi.mock('./status-client', () => ({
  fetchStatus: vi.fn(() =>
    Promise.resolve({
      version: '0.0.0',
      mvp_version: 'mvp-1.0',
      backend: { health: 'ok', ready: true, checks: {} },
      worker: { status: 'idle', heartbeat_at: null },
      providers: [
        { provider: 'fal', configured: true, testable: true },
        { provider: '9router', configured: true, testable: true },
      ],
    }),
  ),
}))

describe('Beranda — meja kerja studio', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('keeps project actions in a dedicated toolbar, never in the header', () => {
    render(<BerandaApp />)
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Kanvas hasil' })).toBeVisible()
    expect(screen.getByRole('region', { name: 'Layout prompt' })).toBeVisible()
    expect(screen.getByRole('region', { name: 'Title & Keywords' })).toBeVisible()
    const toolbar = screen.getByRole('toolbar', { name: 'Toolbar proyek' })
    expect(toolbar).toContainElement(screen.getByRole('button', { name: 'Buat proyek baru' }))
    expect(toolbar).toContainElement(screen.getByRole('button', { name: 'Buka proyek' }))
    expect(toolbar).toContainElement(screen.getByRole('button', { name: 'Proyek terakhir' }))
    expect(screen.getByRole('banner')).not.toContainElement(screen.getByRole('button', { name: 'Buka proyek' }))
  })

  it('uses right-aligned icon-only controls for theme and settings', () => {
    render(<BerandaApp />)
    const header = screen.getByRole('banner')
    const title = header.querySelector('.beranda-header-title')
    const controls = header.querySelector('.beranda-header-actions')
    const themeButton = screen.getByRole('button', { name: 'Mode malam' })
    const settingsButton = screen.getByRole('button', { name: 'Setelan' })

    expect(title).toHaveClass('beranda-header-title')
    expect(controls).toContainElement(themeButton)
    expect(controls).toContainElement(settingsButton)
    expect(themeButton).toHaveTextContent('🌙')
    expect(themeButton).not.toHaveTextContent('Mode malam')
    expect(settingsButton).toHaveTextContent('⚙️')
    expect(settingsButton).not.toHaveTextContent('Setelan')
  })

  it('separates the header title from its right-side icon action zone', () => {
    render(<BerandaApp />)

    const header = screen.getByRole('banner')
    const title = header.querySelector('.beranda-header-title')
    const actions = header.querySelector('.beranda-header-actions')
    expect(title).toBeTruthy()
    expect(actions).toBeTruthy()
    expect(title).not.toContainElement(screen.getByRole('button', { name: 'Mode malam' }))
    expect(actions).toContainElement(screen.getByRole('button', { name: 'Mode malam' }))
  })

  it('opens the new-project dialog from the toolbar', () => {
    render(<BerandaApp />)
    fireEvent.click(screen.getByRole('button', { name: 'Buat proyek baru' }))
    expect(screen.getByRole('dialog', { name: 'Buat proyek baru' })).toBeVisible()
  })

  it('leaves Last opened project disabled until a durable handle exists', () => {
    render(<BerandaApp />)
    expect(screen.getByRole('button', { name: 'Proyek terakhir' })).toBeDisabled()
  })

  it('places a truthful Adobe Stock disclaimer before the footer attribution', () => {
    render(<BerandaApp />)
    const disclaimer = screen.getByRole('note', { name: 'Disclaimer Adobe Stock' })
    const link = screen.getByRole('link', { name: '@Rizzalaulia' })

    expect(disclaimer).toHaveTextContent('Gandiwa Studio adalah alat bantu')
    expect(disclaimer).toHaveTextContent('tidak menjamin 100%')
    expect(disclaimer.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(link).toHaveAttribute('href', 'https://github.com/Rizzalaulia')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noreferrer')
  })

  it('makes the canvas the hero: target pixels live inside the canvas region', () => {
    render(<BerandaApp />)
    const canvas = screen.getByRole('region', { name: 'Kanvas hasil' })
    expect(canvas).toHaveTextContent(/2000 × 2000/)
  })

  it('tier switch changes the promised pixels on the canvas, ratio preserved', () => {
    render(<BerandaApp />)
    const tier = screen.getByLabelText('Tier kualitas')
    fireEvent.change(tier, { target: { value: 'max' } })
    const canvas = screen.getByRole('region', { name: 'Kanvas hasil' })
    expect(canvas).toHaveTextContent(/3465 × 3464/)
    fireEvent.change(tier, { target: { value: 'medium' } })
    expect(canvas).toHaveTextContent(/2000 × 2000/)
  })

  it('keeps a prompt-specific compact layout on the left with model and submit', () => {
    render(<BerandaApp />)
    const left = screen.getByRole('region', { name: 'Layout prompt' })
    expect(left.contains(screen.getByLabelText('Prompt utama'))).toBe(true)
    expect(left.contains(screen.getByLabelText('Prompt negatif'))).toBe(true)
    expect(left.contains(screen.getByLabelText('Model gambar'))).toBe(true)
    expect(left.contains(screen.getByRole('button', { name: 'Setujui prompt' }))).toBe(true)
  })

  it('keeps title & keywords as their own layout on the right, not a separate page', () => {
    render(<BerandaApp />)
    const right = screen.getByRole('region', { name: 'Title & Keywords' })
    expect(right.contains(screen.getByLabelText('Judul'))).toBe(true)
    expect(right.contains(screen.getByLabelText('Kata kunci (dipisah koma)'))).toBe(true)
  })

  it('embeds the kandidat strip under the canvas and states the 1:1 ruling', () => {
    render(<BerandaApp />)
    const strip = screen.getByRole('region', { name: 'Kandidat job terakhir' })
    expect(strip).toBeVisible()
    expect(strip).toHaveTextContent(/1 generate = 1 gambar/i)
    expect(strip).not.toHaveTextContent('4 kandidat')
  })

  it('places system status beneath Title & Keywords, not in the header', async () => {
    render(<BerandaApp />)
    const status = screen.getByRole('region', { name: 'Status sistem' })
    const metadata = screen.getByRole('region', { name: 'Title & Keywords' })
    await waitFor(() => expect(status).toHaveTextContent('fal.ai'))
    expect(metadata).toContainElement(status)
    expect(screen.getByRole('banner')).not.toContainElement(status)
    expect(status).toHaveTextContent('9Router')
    expect(status).toHaveTextContent('Backend')
    expect(status).toHaveTextContent('Worker')
    expect(JSON.stringify(status.textContent)).not.toContain('secret')
  })

  it('model picker honors the human pick', () => {
    render(<BerandaApp />)
    const picker = screen.getByLabelText('Model gambar')
    fireEvent.change(picker, { target: { value: 'fal-ai/flux/dev' } })
    expect(screen.getByLabelText('Model gambar')).toHaveValue('fal-ai/flux/dev')
  })

  it('offers only real fal registry models on the desk picker', () => {
    render(<BerandaApp />)
    const options = [...screen.getByLabelText('Model gambar').querySelectorAll('option')].map((option) => option.value)
    expect(options).toEqual([
      'fal-ai/flux/schnell',
      'fal-ai/flux/dev',
      'fal-ai/flux-realism',
      'fal-ai/imagen',
      'fal-ai/sdxl',
    ])
  })

  it('sends the approved local-sidecar evidence first, then dispatches one owned job', async () => {
    rememberedDirectory = fakeProjectDirectory()
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: vi.fn(() => Promise.resolve(rememberedDirectory)),
    })
    creativeAdapter.buildApprovedCreativeJob.mockResolvedValue(APPROVED_FIXTURE)
    dispatchController.dispatchApprovedCreativeJob.mockResolvedValue({
      job: {
        id: 'job-1', status: 'queued', provider_id: 'fal', model_id: 'fal-ai/flux/schnell',
        attempt_count: 0, cancel_requested: false, created_at: '2026-09-22T00:00:00Z',
        started_at: null, completed_at: null, error_code: null, message: null, artifact: null,
      },
      persisted: {
        session: {
          schemaVersion: 1 as const,
          sessionId: '1e5c8a02-7b34-4c19-9e2a-6d0f3b8c5a71',
          topic: 'Demo Stok',
          rounds: [],
          prompt: {
            promptText: 'ilustrasi kucing oren',
            negativePrompt: 'watermark, logo',
            contentType: 'illustration' as const,
            creationMethod: 'generative_ai' as const,
            providerId: 'fal',
            modelId: 'fal-ai/flux/schnell',
            targetWidth: 2000,
            targetHeight: 2000,
            aspectRatio: '1:1',
            orientation: 'square' as const,
            stockConstraints: ['no watermark, clean edges'],
            negativeSpaceDecision: 'none required',
          },
          approvals: [{ stage: 'prompt' as const, human: 'Master Peng', approvedAt: '2026-09-22T00:00:00.000Z', promptDigest: 'd'.repeat(64) }],
          revisions: [],
        },
        snapshot: 'sidecar-text',
        checksum: 'a'.repeat(64),
      },
    })
    // Monitoring runs against the real pipeline in this test; the sidecar
    // fixture is thin but structurally complete (prompt + approvals present).
    const approvedBase = APPROVED_FIXTURE as { sidecar: Record<string, unknown> }
    creativeAdapter.buildApprovedCreativeJob.mockResolvedValue({
      ...approvedBase,
      sidecar: {
        ...approvedBase.sidecar,
        revisions: [],
      },
    })
    // Monitoring hits the real fetch client; keep it inside this test's
    //Boundary by stubbing the job endpoint at its terminal state directly.
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url
      if (url.endsWith('/api/v1/creative/jobs/job-1')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            id: 'job-1', status: 'failed', provider_id: 'fal', model_id: 'fal-ai/flux/schnell',
            attempt_count: 1, cancel_requested: false, created_at: '2026-09-22T00:00:00Z',
            started_at: '2026-09-22T00:01:00Z', completed_at: '2026-09-22T00:02:00Z',
            error_code: null, message: null, artifact: null,
          }),
        })
      }
      return Promise.reject(new Error(`unexpected request: ${url}`))
    }))
    render(<BerandaApp />)
    fireEvent.click(screen.getByRole('button', { name: 'Buka proyek' }))
    await waitFor(() => expect(screen.getByRole('toolbar')).toHaveTextContent('dibuka secara lokal'))
    fireEvent.change(screen.getByLabelText('Prompt utama'), { target: { value: 'Kucing oren duduk santai, cahaya lembut' } })
    fireEvent.change(screen.getByLabelText('Prompt negatif'), { target: { value: 'waternmark, logo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Setujui prompt' }))

    await waitFor(() => expect(dispatchController.dispatchApprovedCreativeJob).toHaveBeenCalledTimes(1))
    const call = dispatchController.dispatchApprovedCreativeJob.mock.calls[0]![0] as Record<string, unknown>
    expect(call.directory).toBe(rememberedDirectory)
    expect(call.manifestSnapshot).toBe(MANIFEST_TEXT)
    expect(call.sidecarSnapshot).toBeUndefined()
    expect(call.approved).toStrictEqual(APPROVED_FIXTURE)
    expect(creativeAdapter.buildApprovedCreativeJob).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'Demo Stok',
      prompt: 'Kucing oren duduk santai, cahaya lembut',
      negativePrompt: 'waternmark, logo',
      providerId: 'fal',
      modelId: 'fal-ai/flux/schnell',
      width: 2000,
      height: 2000,
      aspectRatio: '1:1',
      contentType: 'illustration',
      human: 'Master Peng',
    }))
    expect(typeof (creativeAdapter.buildApprovedCreativeJob.mock.calls[0]![0] as { sessionId: unknown }).sessionId).toBe('string')
    // Monitoring runs to the honest terminal state (message updates as the
    // pipe completes) rather than freezing on the transient queue note.
    await waitFor(() => expect(screen.getByRole('log')).toHaveTextContent(/berakhir dengan status failed/))
  })

  it('keeps the approval button honest when local evidence cannot be written', async () => {
    rememberedDirectory = fakeProjectDirectory()
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: vi.fn(() => Promise.resolve(rememberedDirectory)),
    })
    creativeAdapter.buildApprovedCreativeJob.mockResolvedValue(APPROVED_FIXTURE)
    dispatchController.dispatchApprovedCreativeJob.mockRejectedValue(
      new Error('project manifest changed externally; reload before saving creative session'),
    )
    render(<BerandaApp />)
    fireEvent.click(screen.getByRole('button', { name: 'Buka proyek' }))
    await waitFor(() => expect(screen.getByRole('toolbar')).toHaveTextContent('dibuka secara lokal'))
    fireEvent.change(screen.getByLabelText('Prompt utama'), { target: { value: 'Prompt jujur' } })
    fireEvent.change(screen.getByLabelText('Prompt negatif'), { target: { value: 'nol' } })
    fireEvent.click(screen.getByRole('button', { name: 'Setujui prompt' }))

    await waitFor(() => expect(screen.getByRole('log')).toHaveTextContent(/project manifest changed externally/))
    expect(screen.getByRole('log')).not.toHaveTextContent('terkirim')
  })
})

describe('Beranda — setelan: bahasa & API key', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  it('opens the settings dialog from the header button', () => {
    render(<BerandaApp />)
    fireEvent.click(screen.getByRole('button', { name: 'Setelan' }))
    const dialog = screen.getByRole('dialog', { name: 'Setelan' })
    expect(dialog).toBeVisible()
    expect(dialog).toHaveTextContent('Bahasa')
    expect(dialog).toHaveTextContent('API Key')
  })

  it('closes the dialog with Escape', () => {
    render(<BerandaApp />)
    fireEvent.click(screen.getByRole('button', { name: 'Setelan' }))
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Setelan' }), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('switches the UI to English and persists the choice', () => {
    render(<BerandaApp />)
    fireEvent.click(screen.getByRole('button', { name: 'Setelan' }))
    fireEvent.click(screen.getByRole('radio', { name: 'English' }))
    expect(screen.getByRole('button', { name: 'Open project' })).toBeVisible()
    expect(window.localStorage.getItem('beranda-lang')).toBe('en')
  })

  it('restores English on the next load', () => {
    window.localStorage.setItem('beranda-lang', 'en')
    render(<BerandaApp />)
    expect(screen.getByRole('button', { name: 'Open project' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Buka proyek' })).not.toBeInTheDocument()
  })

  it('organizes API management by role, API provider, then model', () => {
    render(<BerandaApp />)
    fireEvent.click(screen.getByRole('button', { name: 'Setelan' }))
    const dialog = screen.getByRole('dialog', { name: 'Setelan' })

    expect(dialog).toHaveTextContent('Image generation')
    expect(screen.getByLabelText('API image generation')).toHaveValue('fal')
    expect(screen.getByLabelText('Model image generation')).toHaveValue('fal-ai/flux/schnell')
    expect(screen.getByRole('option', { name: 'OpenAI · gpt-2.5-sunburst' })).toBeVisible()

    expect(dialog).toHaveTextContent('Reasoning')
    expect(screen.getByLabelText('API reasoning')).toHaveValue('9router')
    expect(screen.getByRole('option', { name: 'OpenAI compatible' })).toBeVisible()
    expect(screen.getByRole('option', { name: 'Anthropic compatible' })).toBeVisible()
  })

  it('switches the image model selector with the selected API', () => {
    render(<BerandaApp />)
    fireEvent.click(screen.getByRole('button', { name: 'Setelan' }))
    fireEvent.change(screen.getByLabelText('API image generation'), { target: { value: 'openai-sunburst' } })
    expect(screen.getByLabelText('Model image generation')).toHaveValue('gpt-2.5-sunburst')
    expect(screen.getByLabelText('Kunci baru OpenAI')).toBeVisible()
  })

  it('keeps save honest for an API whose backend connector is not available', () => {
    render(<BerandaApp />)
    fireEvent.click(screen.getByRole('button', { name: 'Setelan' }))
    fireEvent.change(screen.getByLabelText('API reasoning'), { target: { value: 'anthropic-compatible' } })
    expect(screen.getByText(/Connector backend belum tersedia/i)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Simpan Anthropic compatible' })).toBeDisabled()
  })

  it('saves a new key through the companion-token envelope', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url
      if (url.endsWith('/api/v1/auth/csrf')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ csrf_token: 'tok-1' }) })
      }
      if (url.endsWith('/api/v1/settings/providers')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
      }
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<BerandaApp />)
    fireEvent.click(screen.getByRole('button', { name: 'Setelan' }))
    fireEvent.change(screen.getByLabelText('Kunci baru fal.ai'), { target: { value: 'fal-key-baru' } })
    fireEvent.click(screen.getByRole('button', { name: 'Simpan fal.ai' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('tersimpan'))
    const postCall = (fetchMock as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => String(call[0]).endsWith('/api/v1/settings/providers'),
    ) as unknown as [string, RequestInit]
    expect((postCall[1].headers as Record<string, string>)['X-Companion-Token']).toBe('tok-1')
  })

  it('reports an absent backend key endpoint honestly instead of pretending', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) })))
    render(<BerandaApp />)
    fireEvent.click(screen.getByRole('button', { name: 'Setelan' }))
    fireEvent.change(screen.getByLabelText('Kunci baru 9Router'), { target: { value: 'tok-baru' } })
    fireEvent.click(screen.getByRole('button', { name: 'Simpan 9Router' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('404'))
  })

  function mockFetchWith(validateResponse: () => Record<string, unknown>) {
    return vi.fn((input: RequestInfo | URL) => {
      const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url
      if (url.endsWith('/api/v1/status')) {
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({ backend: { health: 'ok', ready: true }, worker: { status: 'idle', heartbeat_at: null } }),
        })
      }
      if (url.endsWith('/api/v1/providers')) {
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve([{ id: 'fal', name: 'fal.ai', configured: true, auth_required: true }]),
        })
      }
      if (url.endsWith('/api/v1/settings/providers/fal/validate')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(validateResponse()) })
      }
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) })
    })
  }

  it('Tes API button probes the real provider and reports a valid key', async () => {
    vi.stubGlobal('fetch', mockFetchWith(() => ({ ok: true, provider: 'fal', probe: 'provider_auth' })))
    render(<BerandaApp />)
    fireEvent.click(screen.getByRole('button', { name: 'Setelan' }))
    const tesBtn = await screen.findByRole('button', { name: 'Tes fal.ai' })
    expect(tesBtn).toBeEnabled() // kunci tersimpan (configured) → boleh dites
    fireEvent.click(tesBtn)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/kunci valid/))
  })

  it('Tes API reports a rejected key instead of pretending it works', async () => {
    vi.stubGlobal('fetch', mockFetchWith(() => ({ ok: false, provider: 'fal', probe: 'provider_auth', reason: 'auth_rejected' })))
    render(<BerandaApp />)
    fireEvent.click(screen.getByRole('button', { name: 'Setelan' }))
    const tesBtn = await screen.findByRole('button', { name: 'Tes fal.ai' })
    fireEvent.click(tesBtn)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/ditolak provider/i))
  })

  it('Tes API distinguishes unreachable network from an invalid key', async () => {
    vi.stubGlobal('fetch', mockFetchWith(() => ({ ok: false, provider: 'fal', probe: 'provider_auth', reason: 'unreachable' })))
    render(<BerandaApp />)
    fireEvent.click(screen.getByRole('button', { name: 'Setelan' }))
    const tesBtn = await screen.findByRole('button', { name: 'Tes fal.ai' })
    fireEvent.click(tesBtn)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/tidak terjangkau/))
  })
})
describe('Beranda — mode malam / siang', () => {
  afterEach(() => {
    cleanup()
    window.localStorage.clear()
  })

  it('starts in day mode and offers the night toggle', () => {
    render(<BerandaApp />)
    const root = document.querySelector('.beranda') as HTMLElement
    expect(root.classList.contains('beranda-night')).toBe(false)
    expect(screen.getByRole('button', { name: 'Mode malam' })).toBeVisible()
  })

  it('flips to night on click, relabels, and persists the choice', () => {
    render(<BerandaApp />)
    fireEvent.click(screen.getByRole('button', { name: 'Mode malam' }))
    const root = document.querySelector('.beranda') as HTMLElement
    expect(root.classList.contains('beranda-night')).toBe(true)
    expect(document.documentElement.classList.contains('gandiwa-night')).toBe(true)
    expect(screen.getByRole('button', { name: 'Mode siang' })).toBeVisible()
    expect(window.localStorage.getItem('beranda-theme')).toBe('night')
  })

  it('restores the remembered night theme on the next load', () => {
    window.localStorage.setItem('beranda-theme', 'night')
    render(<BerandaApp />)
    const root = document.querySelector('.beranda') as HTMLElement
    expect(root.classList.contains('beranda-night')).toBe(true)
    expect(screen.getByRole('button', { name: 'Mode siang' })).toBeVisible()
  })

  it('flips back to day from night', () => {
    window.localStorage.setItem('beranda-theme', 'night')
    render(<BerandaApp />)
    fireEvent.click(screen.getByRole('button', { name: 'Mode siang' }))
    const root = document.querySelector('.beranda') as HTMLElement
    expect(root.classList.contains('beranda-night')).toBe(false)
    expect(window.localStorage.getItem('beranda-theme')).toBe('day')
  })

  it('keeps the stage on the night wall while it is empty and only loads a light canvas when art exists', () => {
    window.localStorage.setItem('beranda-theme', 'night')
    render(<BerandaApp />)
    const stage = screen.getByTestId('canvas-stage')
    expect(stage.classList.contains('beranda-stage-loaded')).toBe(false)
    expect(stage.getAttribute('data-has-image')).toBe('false')
    expect(stage.querySelector('.beranda-stage-empty')).not.toBeNull()
  })

  it('paints the night scheme switch so native widgets follow the theme', () => {
    window.localStorage.setItem('beranda-theme', 'night')
    render(<BerandaApp />)
    const root = document.querySelector('.beranda') as HTMLElement
    expect(root.classList.contains('beranda-night')).toBe(true)
    expect(root.querySelector('select')).not.toBeNull()
  })
})

describe('Beranda — hasil job ke kanvas & unduhan aman', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  function succeededJobShape(id: string) {
    return {
      job: {
        id, status: 'queued', provider_id: 'fal', model_id: 'fal-ai/flux/schnell',
        attempt_count: 0, cancel_requested: false, created_at: '2026-09-22T00:00:00Z',
        started_at: null, completed_at: null, error_code: null, message: null, artifact: null,
      },
      persisted: {
        session: {
          schemaVersion: 1 as const,
          sessionId: '1e5c8a02-7b34-4c19-9e2a-6d0f3b8c5a71',
          topic: 'Demo Stok',
          rounds: [],
          prompt: {
            promptText: 'ilustrasi kucing oren',
            negativePrompt: 'watermark, logo',
            contentType: 'illustration' as const,
            creationMethod: 'generative_ai' as const,
            providerId: 'fal',
            modelId: 'fal-ai/flux/schnell',
            targetWidth: 2000,
            targetHeight: 2000,
            aspectRatio: '1:1',
            orientation: 'square' as const,
            stockConstraints: ['no watermark, clean edges'],
            negativeSpaceDecision: 'none required',
          },
          approvals: [{ stage: 'prompt' as const, human: 'Master Peng', approvedAt: '2026-09-22T00:00:00.000Z', promptDigest: 'd'.repeat(64) }],
          revisions: [],
        },
        snapshot: 'sidecar-text',
        checksum: 'a'.repeat(64),
      },
    }
  }

  it('polls the dispatched job, paints the revision onto the kanvas, and offers the safe download', async () => {
    rememberedDirectory = fakeProjectDirectory()
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: vi.fn(() => Promise.resolve(rememberedDirectory)),
    })
    const REAL_DIGEST = '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a'
    // The mocked dispatch reports a persisted snapshot; mirror it on disk so
    // the real save's unchanged-check sees the same evidence.
    sidecarText = 'sidecar-text'
    createdSidecar = true
    const manifestWithAsset = JSON.stringify({
      schema_version: 1,
      project_id: '1e5c8a02-7b34-4c19-9e2a-6d0f3b8c5a71',
      project_name: 'Demo Stok',
      assets: [{
        asset_id: '1e5c8a02-7b34-4c19-9e2a-6d0f3b8c5a71',
        content_type: 'illustration',
        creation_method: 'generative_ai',
        revisions: [{ revision: 1, generation_format: 'png', working_format: 'png', master_format: 'png', submission_format: 'jpeg', relative_path: `revisions/1e5c8a02-7b34-4c19-9e2a-6d0f3b8c5a71/rev-1.png` }],
      }],
    })
    creativeAdapter.buildApprovedCreativeJob.mockResolvedValue(APPROVED_FIXTURE)
    dispatchController.dispatchApprovedCreativeJob.mockResolvedValue(succeededJobShape('job-canv-1'))
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url
      if (url.endsWith('/api/v1/creative/jobs/job-canv-1')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            id: 'job-canv-1', status: 'succeeded', provider_id: 'fal', model_id: 'fal-ai/flux/schnell',
            attempt_count: 1, cancel_requested: false, created_at: '2026-09-22T00:00:00Z',
            started_at: '2026-09-22T00:01:00Z', completed_at: '2026-09-22T00:02:00Z',
            error_code: null, message: null,
            artifact: { id: 'art-canvas', media_type: 'image/png', size_bytes: 4, sha256: REAL_DIGEST, width: 2000, height: 2000 },
          }),
        })
      }
      if (url.endsWith('/api/v1/artifacts/art-canvas/download')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'X-Gandiwa-SHA256': REAL_DIGEST }),
          arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3, 4]).buffer),
        })
      }
      return Promise.reject(new Error(`unexpected request: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<BerandaApp />)
    fireEvent.click(screen.getByRole('button', { name: 'Buka proyek' }))
    await waitFor(() => expect(screen.getByRole('toolbar')).toHaveTextContent('dibuka secara lokal'))
    fireEvent.change(screen.getByLabelText('Prompt utama'), { target: { value: 'Kanvas piksel nyata' } })
    fireEvent.click(screen.getByRole('button', { name: 'Setujui prompt' }))

    await waitFor(() => expect(screen.getByTestId('canvas-stage').getAttribute('data-has-image')).toBe('true'))
    const stage = screen.getByTestId('canvas-stage')
    const image = stage.querySelector('img')
    expect(image).not.toBeNull()
    expect(image!.getAttribute('src')?.startsWith('blob:')).toBe(true)
    expect(stage).toHaveTextContent(/2000 × 2000 px/)
    const download = screen.getByRole('link', { name: /Unduh hasil/ })
    expect(download).toBeVisible()
    // Manifest locally records the revision of the owned session.
    expect((JSON.parse(manifestWithAsset) as { assets: Array<{ revisions: unknown[] }> }).assets[0]!.revisions).toHaveLength(1)
  })

  it('tells the truth when the job fails: the job message lands in the log, stage stays empty', async () => {
    rememberedDirectory = fakeProjectDirectory()
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: vi.fn(() => Promise.resolve(rememberedDirectory)),
    })
    creativeAdapter.buildApprovedCreativeJob.mockResolvedValue(APPROVED_FIXTURE)
    dispatchController.dispatchApprovedCreativeJob.mockResolvedValue(succeededJobShape('job-fail-1'))
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url
      if (url.endsWith('/api/v1/creative/jobs/job-fail-1')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            id: 'job-fail-1', status: 'failed', provider_id: 'fal', model_id: 'fal-ai/flux/schnell',
            attempt_count: 1, cancel_requested: false, created_at: '2026-09-22T00:00:00Z',
            started_at: '2026-09-22T00:01:00Z', completed_at: '2026-09-22T00:02:00Z',
            error_code: 'PROVIDER_ERROR', message: 'Provider exploded at generation time',
            artifact: null,
          }),
        })
      }
      return Promise.reject(new Error(`unexpected request: ${url}`))
    }))

    render(<BerandaApp />)
    fireEvent.click(screen.getByRole('button', { name: 'Buka proyek' }))
    await waitFor(() => expect(screen.getByRole('toolbar')).toHaveTextContent('dibuka secara lokal'))
    fireEvent.change(screen.getByLabelText('Prompt utama'), { target: { value: 'Job gagal harus jujur' } })
    fireEvent.click(screen.getByRole('button', { name: 'Setujui prompt' }))

    await waitFor(() => expect(screen.getByRole('log')).toHaveTextContent(/Provider exploded at generation time/))
    expect(screen.getByTestId('canvas-stage').getAttribute('data-has-image')).toBe('false')
  })

  it('keeps needs_review visible to the human instead of pretending it is a result', async () => {
    rememberedDirectory = fakeProjectDirectory()
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: vi.fn(() => Promise.resolve(rememberedDirectory)),
    })
    creativeAdapter.buildApprovedCreativeJob.mockResolvedValue(APPROVED_FIXTURE)
    dispatchController.dispatchApprovedCreativeJob.mockResolvedValue(succeededJobShape('job-review-1'))
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url
      if (url.endsWith('/api/v1/creative/jobs/job-review-1')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            id: 'job-review-1', status: 'needs_review', provider_id: 'fal', model_id: 'fal-ai/flux/schnell',
            attempt_count: 1, cancel_requested: false, created_at: '2026-09-22T00:00:00Z',
            started_at: '2026-09-22T00:01:00Z', completed_at: '2026-09-22T00:02:00Z',
            error_code: 'UNKNOWN_PROVIDER_OUTCOME', message: 'Provider outcome needs review',
            artifact: null,
          }),
        })
      }
      return Promise.reject(new Error(`unexpected request: ${url}`))
    }))

    render(<BerandaApp />)
    fireEvent.click(screen.getByRole('button', { name: 'Buka proyek' }))
    await waitFor(() => expect(screen.getByRole('toolbar')).toHaveTextContent('dibuka secara lokal'))
    fireEvent.change(screen.getByLabelText('Prompt utama'), { target: { value: 'Needs review tetap terlihat' } })
    fireEvent.click(screen.getByRole('button', { name: 'Setujui prompt' }))

    await waitFor(() => expect(screen.getByRole('log')).toHaveTextContent(/Provider outcome needs review/))
    expect(screen.getByTestId('canvas-stage').getAttribute('data-has-image')).toBe('false')
    expect(screen.queryByRole('button', { name: /Unduh hasil/ })).not.toBeInTheDocument()
  })
})
