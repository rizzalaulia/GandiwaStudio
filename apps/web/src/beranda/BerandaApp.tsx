import { useCallback, useEffect, useMemo, useState } from 'react'

import type { ContentType, CreationMethod, ProjectManifest } from '@gandiwa/contracts'

import {
  ASPECT_RATIOS,
  resolutionForTier,
  type QualityTierId,
} from './quality-tiers'
import { fetchStatus, type StatusView } from './status-client'
import { loadRememberedProjectDirectory } from '../project-handle-store'
import {
  browserProjectCreationDependencies,
  createProject,
  writeProjectManifestAtomically,
} from '../project-filesystem'
import {
  browserProjectLifecycleDependencies,
  openProject,
  reopenProjectFromUserGesture,
  type DirectoryHandleLike,
} from '../project-lifecycle'
import { companionHeadersForToken } from './settings-client'
import { buildApprovedCreativeJob } from './creative-session-adapter'
import { dispatchApprovedCreativeJob, monitorCreativeJobToRevision } from './creative-dispatch-controller'
import { fetchCreativeJob, downloadCreativeArtifact, cancelCreativeJob } from './creative-job-client'
import { recordGeneratedRevision } from './generated-revision-store'
import { saveCreativeSession, type CreativeSessionDirectory } from '../creative-session-store'

// Issue #26 (opsi B, ronde 4) — Beranda meja studio + header controls:
// theme toggle (malam/siang) dan tombol Setelan. Dialog Setelan memuat
// Bahasa (id/en, dipersist, mengganti seluruh label UI) dan API Key
// (fal.ai & 9Router: status ter-mask, simpan via companion-token envelope,
// tanpa pernah menampilkan key utuh). Ruling tetap: 1 generate = 1 gambar.
// Kanvas artwork tetap netral terang di kedua tema.

type Lang = 'id' | 'en'

const STRINGS = {
  id: {
    appTitle: 'Gandiwa Studio — Beranda',
    noProject: 'Belum ada proyek aktif. Buka folder proyek untuk mulai.',
    activeProject: 'Proyek aktif',
    openProject: 'Buka proyek',
    changeProject: 'Ganti proyek',
    themeNight: 'Mode malam',
    themeDay: 'Mode siang',
    settings: 'Setelan',
    settingsTitle: 'Setelan',
    language: 'Bahasa',
    apiKeys: 'API Key',
    save: 'Simpan',
    newKey: 'Kunci baru',
    saved: 'tersimpan',
    backend: 'Backend',
    worker: 'Worker',
    provider: 'Provider',
    ready: 'siap',
    noKey: 'tanpa key',
    empty: 'kosong',
    promptPanel: 'Layout prompt',
    promptMain: 'Prompt utama',
    promptNegative: 'Prompt negatif',
    promptPlaceholder: 'Deskripsikan satu ilustrasi stock: subjek, komposisi, cahaya, gaya.',
    negativePlaceholder: 'Hal yang tidak boleh muncul, dipisah koma.',
    model: 'Model gambar',
    ratio: 'Rasio',
    tier: 'Tier kualitas',
    approve: 'Setujui prompt',
    metaPanel: 'Title & Keywords',
    judul: 'Judul',
    judulPlaceholder: 'Judul komersial untuk katalog stock.',
    keywords: 'Kata kunci (dipisah koma)',
    keywordsPlaceholder: 'kucing, studio, ilustrasi flat, ...',
    keywordCount: 'kata kunci',
    stageEmpty: 'Hasil generate tampil di sini — satu job, satu gambar.',
    targetPixels: 'Target piksel',
    ratioWord: 'rasio',
    kandidatEmpty: 'Belum ada kandidat — 1 generate = 1 gambar, hasil terakhir menempel di strip ini dengan piksel aktualnya.',
    keyConfigured: 'tersimpan',
    keyMissing: 'belum ada key',
    keyPlaceholder: 'Tempel kunci API baru di sini',
    keyNote: 'Kunci hanya disimpan di backend, tidak pernah tampil utuh kembali.',
    testKey: 'Tes',
    testValid: 'kunci valid — provider menerima autentikasi',
    testRejected: 'kunci DITOLAK provider — periksa/paste ulang key',
    testUnreachable: 'provider tidak terjangkau — validitas belum bisa dipastikan',
    testError: 'gagal mengetes kunci',
  },
  en: {
    appTitle: 'Gandiwa Studio — Home',
    noProject: 'No active project yet. Open a project folder to start.',
    activeProject: 'Active project',
    openProject: 'Open project',
    changeProject: 'Change project',
    themeNight: 'Night mode',
    themeDay: 'Day mode',
    settings: 'Settings',
    settingsTitle: 'Settings',
    language: 'Language',
    apiKeys: 'API Key',
    save: 'Save',
    newKey: 'New key',
    saved: 'saved',
    backend: 'Backend',
    worker: 'Worker',
    provider: 'Provider',
    ready: 'ready',
    noKey: 'no key',
    empty: 'empty',
    promptPanel: 'Prompt layout',
    promptMain: 'Main prompt',
    promptNegative: 'Negative prompt',
    promptPlaceholder: 'Describe one stock illustration: subject, composition, light, style.',
    negativePlaceholder: 'Things that must not appear, comma separated.',
    model: 'Image model',
    ratio: 'Ratio',
    tier: 'Quality tier',
    approve: 'Approve prompt',
    metaPanel: 'Title & Keywords',
    judul: 'Title',
    judulPlaceholder: 'Commercial title for the stock catalog.',
    keywords: 'Keywords (comma separated)',
    keywordsPlaceholder: 'cat, studio, flat illustration, ...',
    keywordCount: 'keywords',
    stageEmpty: 'Generated results appear here — one job, one image.',
    targetPixels: 'Target pixels',
    ratioWord: 'ratio',
    kandidatEmpty: 'No candidates yet — 1 generate = 1 image; the latest result lands in this strip with its actual pixels.',
    keyConfigured: 'stored',
    keyMissing: 'no key',
    keyPlaceholder: 'Paste a new API key here',
    keyNote: 'Keys are stored server-side only and are never shown back in full.',
    testKey: 'Test',
    testValid: 'key is valid — the provider accepted authentication',
    testRejected: 'key REJECTED by the provider — re-check or re-paste the key',
    testUnreachable: 'provider unreachable — validity cannot be confirmed yet',
    testError: 'failed to test the key',
  },
} as const

type Strings = (typeof STRINGS)[Lang]

// Model yang sah untuk dispatch nyata; sinkron dengan
// dispatch_policy.CURRENT_IMAGE_GENERATION_PROVIDER_MODELS di backend.
const MODEL_OPTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'fal-ai/flux/schnell', label: 'FLUX Schnell' },
  { id: 'fal-ai/flux/dev', label: 'FLUX Dev' },
  { id: 'fal-ai/flux-realism', label: 'FLUX Realism' },
  { id: 'fal-ai/imagen', label: 'Imagen' },
  { id: 'fal-ai/sdxl', label: 'SDXL' },
]

const TIERS: ReadonlyArray<{ id: QualityTierId; label: string }> = [
  { id: 'medium', label: 'Medium · 4 MP' },
  { id: 'high', label: 'High · 8 MP' },
  { id: 'max', label: 'Max · 12 MP' },
]

function providerLabel(provider: string): string {
  if (provider === 'fal') return 'fal.ai'
  if (provider === '9router') return '9Router'
  return provider
}

type ProviderKeyRowProps = {
  provider: string
  label: string
  value: string
  onChange: (value: string) => void
  configured: boolean
  unavailable?: boolean
  saveProviderKey?: (provider: 'fal' | '9router', apiKey: string) => Promise<void>
  validateProviderKey?: (provider: 'fal' | '9router') => Promise<void>
  testing?: boolean
  keyTest?: { provider: string; note: string; level: 'ok' | 'rejected' | 'unreachable' | 'error' } | null
  t: Strings
}

function ProviderKeyRow({ provider, label, value, onChange, configured, unavailable = false, saveProviderKey, validateProviderKey, testing = false, keyTest = null, t }: ProviderKeyRowProps) {
  const canSave = !unavailable && value.trim().length > 0 && saveProviderKey !== undefined
  const rowTest = keyTest !== null && keyTest.provider === provider ? keyTest : null
  const testLevelClass = rowTest === null ? '' : ` beranda-keytest-${rowTest.level}`
  return (
    <div className="beranda-keyrow">
      <div className="beranda-keyrow-head">
        <strong>{label}</strong>
        <span className="beranda-chip">{unavailable ? 'belum didukung' : configured ? t.keyConfigured : t.keyMissing}</span>
      </div>
      <label className="beranda-field">
        <span>{t.newKey} {label}</span>
        <input type="password" autoComplete="off" aria-label={`${t.newKey} ${label}`} value={value} onChange={(event) => onChange(event.target.value)} placeholder={t.keyPlaceholder} />
      </label>
      {unavailable && <p className="beranda-note">Connector backend belum tersedia — kunci tidak akan disimpan.</p>}
      <div className="beranda-keyrow-actions">
        <button type="button" className="beranda-primary" disabled={!canSave} onClick={() => {
          if (canSave && (provider === 'fal' || provider === '9router')) void saveProviderKey(provider, value.trim())
        }}>{t.save} {label}</button>
        {!unavailable && validateProviderKey !== undefined && (
          <button
            type="button"
            className={`beranda-btn-test${testLevelClass}`}
            aria-label={`${t.testKey} ${label}`}
            disabled={!configured || testing}
            onClick={() => {
              if (provider === 'fal' || provider === '9router') void validateProviderKey(provider)
            }}
          ><span className="beranda-btn-test-icon" aria-hidden="true">{testing ? '⏳' : rowTest === null ? '⚡' : rowTest.level === 'ok' ? '✓' : rowTest.level === 'rejected' ? '✕' : '⚠'}</span>{testing ? `${t.testKey}…` : t.testKey} {label}</button>
        )}
      </div>
      {rowTest !== null && (
        <p role="status" className={`beranda-keytest beranda-keytest-${rowTest.level}`}>{rowTest.note}</p>
      )}
    </div>
  )
}

export function BerandaApp() {
  const [theme, setTheme] = useState<'day' | 'night'>(() => {
    try {
      return window.localStorage.getItem('beranda-theme') === 'night' ? 'night' : 'day'
    } catch {
      return 'day'
    }
  })
  const [lang, setLang] = useState<Lang>(() => {
    try {
      return window.localStorage.getItem('beranda-lang') === 'en' ? 'en' : 'id'
    } catch {
      return 'id'
    }
  })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsNote, setSettingsNote] = useState<string | null>(null)
  const [keyTest, setKeyTest] = useState<{ provider: string; note: string; level: 'ok' | 'rejected' | 'unreachable' | 'error' } | null>(null)
  const [testingProvider, setTestingProvider] = useState<'fal' | '9router' | null>(null)

  const [newFalKey, setNewFalKey] = useState('')
  const [newRouterKey, setNewRouterKey] = useState('')

  const t: Strings = STRINGS[lang]

  const [projectName, setProjectName] = useState<string | null>(null)
  const [rememberedProject, setRememberedProject] = useState<DirectoryHandleLike | null>(null)
  const [projectMessage, setProjectMessage] = useState<string | null>(null)
  const [isProjectBusy, setProjectBusy] = useState(false)
  const [isCreateProjectOpen, setCreateProjectOpen] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [newProjectType, setNewProjectType] = useState<ContentType>('illustration')
  const [newProjectMethod, setNewProjectMethod] = useState<CreationMethod>('generative_ai')
  const [status, setStatus] = useState<StatusView | null>(null)

  const [prompt, setPrompt] = useState('')
  const [negativePrompt, setNegativePrompt] = useState('')
  const [aspectRatio, setAspectRatio] = useState('1:1')
  const [tier, setTier] = useState<QualityTierId>('medium')
  const [model, setModel] = useState('fal-ai/flux/schnell')

  const [title, setTitle] = useState('')
  const [keywords, setKeywords] = useState('')
  // Diisi hasil job nyata: piksel dari artifact tervalidasi SHA-256 yang
  // sudah tersimpan sebagai revisi lokal. Selama kosong, panggung mengikuti
  // warna ruangan; latar netral terang dipakai saat art ada.
  const [hasImage, setHasImage] = useState(false)
  const [canvasImage, setCanvasImage] = useState<{ url: string; width: number; height: number } | null>(null)
  const [publishedManifest, setPublishedManifest] = useState<ProjectManifest | null>(null)
  const [projectDirectory, setProjectDirectory] = useState<DirectoryHandleLike | null>(null)
  const [projectManifestSnapshot, setProjectManifestSnapshot] = useState<string | null>(null)
  const [activeProjectName, setActiveProjectName] = useState<string | null>(null)
  const [generationStatus, setGenerationStatus] = useState<{
    state: 'idle' | 'busy' | 'queued' | 'error' | 'review'
    message: string | null
  }>({ state: 'idle', message: null })
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const [cancelRequested, setCancelRequested] = useState(false)
  const [artifactExpiresAt, setArtifactExpiresAt] = useState<string | null>(null)
  const [contentType, setContentType] = useState<ContentType>('illustration')

  const acceptOpenedProject = useCallback((name: string, directory: DirectoryHandleLike, manifestSnapshot: string | null = null) => {
    setProjectName(name)
    setRememberedProject(directory)
    setProjectDirectory(directory)
    setActiveProjectName(name)
    if (manifestSnapshot !== null) setProjectManifestSnapshot(manifestSnapshot)
    setProjectMessage(`${name} dibuka secara lokal.`)
  }, [])

  const handleOpenProject = useCallback(async () => {
    setProjectBusy(true)
    setProjectMessage(null)
    try {
      const result = await openProject(browserProjectLifecycleDependencies())
      if (result.kind === 'opened') acceptOpenedProject(result.manifest.project_name, result.directory, result.manifestSnapshot)
      else setProjectMessage(result.kind === 'cancelled' ? 'Membuka proyek dibatalkan.' : result.message)
    } catch (error) {
      setProjectMessage(error instanceof Error ? error.message : 'Gagal membuka proyek.')
    } finally {
      setProjectBusy(false)
    }
  }, [acceptOpenedProject])

  const handleReopenProject = useCallback(async () => {
    if (!rememberedProject) return
    setProjectBusy(true)
    setProjectMessage(null)
    try {
      const result = await reopenProjectFromUserGesture(rememberedProject)
      if (result.kind === 'opened') acceptOpenedProject(result.manifest.project_name, result.directory, result.manifestSnapshot)
      else setProjectMessage(result.kind === 'cancelled' ? 'Membuka proyek dibatalkan.' : result.message)
    } finally {
      setProjectBusy(false)
    }
  }, [acceptOpenedProject, rememberedProject])

  const handleCreateProject = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setProjectBusy(true)
    setProjectMessage(null)
    try {
      const result = await createProject(
        { projectName: newProjectName, contentType: newProjectType, creationMethod: newProjectMethod },
        browserProjectCreationDependencies(),
      )
      if (result.kind === 'created') {
        setProjectName(result.projectName)
        setContentType(result.contentType)
        const remembered = await loadRememberedProjectDirectory<DirectoryHandleLike>()
        setRememberedProject(remembered ?? null)
        setProjectDirectory(remembered ?? null)
        setActiveProjectName(result.projectName)
        setProjectManifestSnapshot(null)
        setProjectMessage(`Proyek “${result.projectName}” dibuat secara lokal.`)
        setCreateProjectOpen(false)
        setNewProjectName('')
      } else setProjectMessage(result.kind === 'cancelled' ? 'Membuat proyek dibatalkan.' : result.message)
    } catch (error) {
      setProjectMessage(error instanceof Error ? error.message : 'Gagal membuat proyek.')
    } finally {
      setProjectBusy(false)
    }
  }, [newProjectMethod, newProjectName, newProjectType])

  useEffect(() => {
    let cancelled = false
    loadRememberedProjectDirectory<{ name: string }>()
      .then((handle) => {
        if (!cancelled && handle) setProjectName(handle.name)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    fetchStatus()
      .then((view) => {
        if (!cancelled) setStatus(view)
      })
      .catch(() => {
        if (!cancelled) setStatus(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === 'day' ? 'night' : 'day'))
  }, [])

  const handleApprovePrompt = useCallback(async () => {
    setGenerationStatus({ state: 'busy', message: null })
    try {
      if (!projectDirectory || activeProjectName === null) {
        throw new Error('Buka proyek lokal dulu sebelum menyetujui prompt.')
      }
      const manifestSnapshot = projectManifestSnapshot
        ?? await (await projectDirectory.getFileHandle('gandiwa-project.json', { create: false })).getFile().then((file) => file.text())
      if (manifestSnapshot === null) {
        throw new Error('Snapshot manifest proyek belum tersedia.')
      }
      const generationTarget = resolutionForTier(tier, aspectRatio)
      const approved = await buildApprovedCreativeJob({
        sessionId: crypto.randomUUID(),
        topic: activeProjectName,
        prompt,
        negativePrompt,
        providerId: 'fal',
        modelId: model,
        width: generationTarget.width,
        height: generationTarget.height,
        aspectRatio,
        contentType,
        human: 'Master Peng',
        approvedAt: new Date().toISOString(),
      })
      // Runtime handle File System Access implement interface yang lebih luas
      // dari dua alias TS ini; set connected hanya lewat open/create nyata.
      const sessionDirectory = projectDirectory as DirectoryHandleLike & CreativeSessionDirectory
      const { job, persisted } = await dispatchApprovedCreativeJob({
        approved,
        directory: sessionDirectory,
        manifestSnapshot,
        sidecarSnapshot: undefined,
      })
      setActiveJobId(job.id)
      setCancelRequested(false)
      setGenerationStatus({
        state: 'busy',
        message: `Job ${job.id} terkirim ke antrean (${job.status}). Memantau status…`,
      })
      setProjectManifestSnapshot(manifestSnapshot)

      const finished = await monitorCreativeJobToRevision({
        jobId: job.id,
        fetchJob: fetchCreativeJob,
        delay: (ms) => new Promise((resolve) => { window.setTimeout(resolve, ms) }),
        maxAttempts: 300,
        onProgress: (currentJob) => {
          const cancelNote = currentJob.cancel_requested ? ' · pembatalan diminta' : ''
          setGenerationStatus({
            state: 'busy',
            message: `Job ${currentJob.id}: ${currentJob.status} · percobaan ${currentJob.attempt_count}${cancelNote}`,
          })
        },
        fetchArtifact: downloadCreativeArtifact,
        recordRevision: recordGeneratedRevision,
        recordInput: {
          directory: sessionDirectory,
          manifestSnapshot,
          persistedSession: persisted,
          saveSidecar: saveCreativeSession,
          publishManifest: (next) => writeProjectManifestAtomically(projectDirectory as unknown as Parameters<typeof writeProjectManifestAtomically>[0], next),
        },
        recordOutcome: (outcome) => {
          if (outcome.status === 'succeeded') {
            setGenerationStatus({ state: 'idle', message: outcome.message })
            setActiveJobId(null)
          } else if (outcome.status === 'needs_review') {
            setGenerationStatus({
              state: 'review',
              message: [outcome.message, outcome.job?.error_code ? `Kode: ${outcome.job.error_code}` : null]
                .filter(Boolean)
                .join(' — '),
            })
            setActiveJobId(null)
          } else if (outcome.status === 'cancelled') {
            setGenerationStatus({ state: 'idle', message: outcome.message ?? 'Job dibatalkan.' })
            setActiveJobId(null)
          } else {
            setGenerationStatus({
              state: 'error',
              message: [outcome.error ?? outcome.message ?? `Job ${outcome.status}.`, outcome.job?.error_code ? `Kode: ${outcome.job.error_code}` : null]
                .filter(Boolean)
                .join(' — '),
            })
            setActiveJobId(null)
          }
          return Promise.resolve()
        },
        // The UI owns the blob URL lifetime: it stays valid while displayed
        // and is revoked by the canvas-image effect below on replacement or
        // unmount — not here, or the <img> would point at a dead handle.
        now: () => Date.now(),
      })
      if (finished.status === 'succeeded' && finished.url !== null && finished.job?.artifact) {
        setCanvasImage({ url: finished.url, width: finished.job.artifact.width, height: finished.job.artifact.height })
        setHasImage(true)
        setPublishedManifest(finished.publishedManifest)
        setArtifactExpiresAt(finished.job.artifact_expires_at)
      } else {
        setGenerationStatus({ state: 'error', message: finished.error ?? finished.message ?? `Job berakhir ${finished.status}.` })
      }
    } catch (error) {
      setGenerationStatus({
        state: 'error',
        message: error instanceof Error ? error.message : 'Pengiriman job gagal.',
      })
    }
  }, [activeProjectName, aspectRatio, contentType, model, negativePrompt, projectDirectory, projectManifestSnapshot, prompt, tier])

  const handleCancelJob = useCallback(async () => {
    if (activeJobId === null || cancelRequested) return
    setCancelRequested(true)
    try {
      await cancelCreativeJob(activeJobId)
      setGenerationStatus((current) => ({
        state: current.state,
        message: 'Permintaan pembatalan terkirim — menunggu pekerja menyelesaikan dengan aman…',
      }))
    } catch (error) {
      setCancelRequested(false)
      setGenerationStatus((current) => ({
        state: current.state,
        message: error instanceof Error ? `Gagal membatalkan: ${error.message}` : 'Gagal membatalkan job.',
      }))
    }
  }, [activeJobId, cancelRequested])

  // Blob URL lifecycle: revoke exactly when the displayed image is replaced
  // or the desk unmounts, so no dead blob and no leak.
  useEffect(() => {
    if (canvasImage === null) return
    const liveUrl = canvasImage.url
    return () => { URL.revokeObjectURL(liveUrl) }
  }, [canvasImage])

  // Pasang kelas juga pada <html>, bukan hanya pembungkus Beranda. Ini
  // membuat tema tidak bisa lepas saat browser memakai gaya shell global.
  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('gandiwa-night', theme === 'night')
    try {
      window.localStorage.setItem('beranda-theme', theme)
    } catch {
      // Penyimpanan tidak tersedia — tampilan tetap berubah untuk sesi ini.
    }
    return () => root.classList.remove('gandiwa-night')
  }, [theme])

  const changeLang = useCallback((next: Lang) => {
    setLang(next)
    try {
      window.localStorage.setItem('beranda-lang', next)
    } catch {
      // Tanpa persist pun UI tetap berganti.
    }
  }, [])

  useEffect(() => {
    if (!settingsOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSettingsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settingsOpen])

  async function saveProviderKey(provider: 'fal' | '9router', apiKey: string) {
    setSettingsNote(null)
    try {
      const csrfResponse = await fetch('/api/v1/auth/csrf', { credentials: 'same-origin' })
      if (!csrfResponse.ok) {
        setSettingsNote(`Gagal mengambil token keamanan (${csrfResponse.status})`)
        return
      }
      const { csrf_token: csrfToken } = (await csrfResponse.json()) as { csrf_token: string }
      const response = await fetch('/api/v1/settings/providers', {
        method: 'POST',
        headers: companionHeadersForToken(csrfToken),
        body: JSON.stringify({ providers: [{ provider, apiKey }] }),
      })
      if (!response.ok) {
        setSettingsNote(`Gagal menyimpan (${response.status}) — endpoint backend belum tersedia`)
        return
      }
      setSettingsNote(`${provider} ${t.saved}`)
      if (provider === 'fal') setNewFalKey('')
      else setNewRouterKey('')
      const refreshed = await fetch('/api/v1/providers', { credentials: 'same-origin' })
      if (refreshed.ok) {
        const providers = (await refreshed.json()) as Array<{ id: string; configured: boolean }>
        setStatus((current) =>
          current
            ? {
                ...current,
                providers: providers.map((entry) => ({
                  provider: entry.id,
                  configured: entry.configured,
                  testable: entry.configured,
                })),
              }
            : current,
        )
      }
    } catch (error) {
      setSettingsNote(error instanceof Error ? error.message : 'Gagal menyimpan kunci')
    }
  }

  async function validateProviderKey(provider: 'fal' | '9router') {
    setKeyTest(null)
    setTestingProvider(provider)
    try {
      const response = await fetch(`/api/v1/settings/providers/${provider}/validate`)
      if (!response.ok) {
        setKeyTest({ provider, note: `${t.testError} (${response.status})`, level: 'error' })
        return
      }
      const body = (await response.json()) as { ok: boolean; reason?: string }
      if (body.ok) {
        setKeyTest({ provider, note: t.testValid, level: 'ok' })
      } else if (body.reason === 'auth_rejected') {
        setKeyTest({ provider, note: t.testRejected, level: 'rejected' })
      } else {
        setKeyTest({ provider, note: t.testUnreachable, level: 'unreachable' })
      }
    } catch (error) {
      setKeyTest({ provider, note: error instanceof Error ? error.message : t.testError, level: 'error' })
    } finally {
      setTestingProvider(null)
    }
  }

  const target = useMemo(() => resolutionForTier(tier, aspectRatio), [tier, aspectRatio])
  const keywordCount = useMemo(
    () => keywords.split(',').map((word) => word.trim()).filter(Boolean).length,
    [keywords],
  )
  const providerRows = status?.providers ?? []
  const falConfigured = providerRows.some((entry) => entry.provider === 'fal' && entry.configured)
  const generationRuntimeReady = contentType !== 'vector' && status?.backend.ready === true && status.worker.status === 'running' && falConfigured
  const generationBlockReason = contentType === 'vector'
    ? 'Generate diblokir: fal.ai menghasilkan raster PNG/JPEG, bukan master SVG untuk proyek Vector.'
    : status === null
      ? 'Memeriksa kesiapan backend…'
      : status.backend.ready !== true
      ? 'Generate diblokir: database, antrean, atau penyimpanan artefak belum siap.'
      : status.worker.status !== 'running'
        ? 'Generate diblokir: worker belum berjalan.'
        : !falConfigured
          ? 'Generate diblokir: simpan dan tes kunci fal.ai terlebih dahulu.'
          : null

  return (
    <div className={`beranda ${theme === 'night' ? 'beranda-night' : ''}`}>
      <header className="beranda-header">
        <div className="beranda-header-title">
          <h1>{t.appTitle}</h1>
          <p className="beranda-subtitle">
            {projectName ? `${t.activeProject}: ${projectName}` : t.noProject}
          </p>
        </div>
        <div className="beranda-header-actions" aria-label="Kontrol tampilan dan setelan">
          <button
            type="button"
            className="beranda-chip beranda-icon-button"
            onClick={toggleTheme}
            aria-pressed={theme === 'night'}
            aria-label={theme === 'night' ? t.themeDay : t.themeNight}
            title={theme === 'night' ? t.themeDay : t.themeNight}
          >
            {theme === 'night' ? '☀️' : '🌙'}
          </button>
          <button
            type="button"
            className="beranda-chip beranda-icon-button"
            onClick={() => setSettingsOpen(true)}
            aria-label={t.settings}
            title={t.settings}
          >
            ⚙️
          </button>
        </div>
      </header>

      <div role="toolbar" aria-label={lang === 'id' ? 'Toolbar proyek' : 'Project toolbar'} className="beranda-toolbar">
        <button type="button" className="beranda-primary" onClick={() => setCreateProjectOpen(true)}>
          {lang === 'id' ? 'Buat proyek baru' : 'Create new project'}
        </button>
        <button type="button" className="beranda-toolbar-button" disabled={isProjectBusy} onClick={() => void handleOpenProject()}>
          {isProjectBusy ? '…' : t.openProject}
        </button>
        <button
          type="button"
          className="beranda-toolbar-button"
          disabled={!rememberedProject || isProjectBusy}
          onClick={() => void handleReopenProject()}
        >
          {lang === 'id' ? 'Proyek terakhir' : 'Last opened project'}
          {rememberedProject && projectName ? ` · ${projectName}` : ''}
        </button>
        {projectMessage && <span role="status" className="beranda-toolbar-message">{projectMessage}</span>}
      </div>

      <div className="beranda-desk">
        <section
          role="region"
          aria-label={t.promptPanel}
          data-testid="panel-prompt"
          className="beranda-side beranda-side-left"
        >
          <h2>{t.promptPanel}</h2>
          <label className="beranda-field">
            <span>{t.promptMain}</span>
            <textarea
              aria-label={t.promptMain}
              rows={8}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder={t.promptPlaceholder}
            />
          </label>
          <label className="beranda-field">
            <span>{t.promptNegative}</span>
            <textarea
              aria-label={t.promptNegative}
              rows={3}
              value={negativePrompt}
              onChange={(event) => setNegativePrompt(event.target.value)}
              placeholder={t.negativePlaceholder}
            />
          </label>
          <label className="beranda-field">
            <span>{t.model}</span>
            <select aria-label={t.model} value={model} onChange={(event) => setModel(event.target.value)}>
              {MODEL_OPTIONS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          <div className="beranda-field-pair">
            <label className="beranda-field">
              <span>{t.ratio}</span>
              <select aria-label={t.ratio} value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)}>
                {ASPECT_RATIOS.map((ratio) => (
                  <option key={ratio.id} value={ratio.id}>
                    {ratio.id}
                  </option>
                ))}
              </select>
            </label>
            <label className="beranda-field">
              <span>{t.tier}</span>
              <select
                aria-label={t.tier}
                value={tier}
                onChange={(event) => setTier(event.target.value as QualityTierId)}
              >
                {TIERS.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="beranda-dispatch-actions">
            <button
              type="button"
              className="beranda-primary beranda-submit"
              disabled={prompt.trim().length === 0 || generationStatus.state === 'busy' || projectDirectory === null || !generationRuntimeReady}
              onClick={() => void handleApprovePrompt()}
            >
              {generationStatus.state === 'busy' ? 'Mengirim…' : t.approve}
            </button>
            {generationStatus.state === 'busy' && activeJobId !== null && (
              <button
                type="button"
                className="beranda-btn-test beranda-cancel-job"
                data-testid="cancel-job"
                disabled={cancelRequested}
                onClick={() => void handleCancelJob()}
              >
                {cancelRequested ? 'Membatalkan…' : 'Batalkan job'}
              </button>
            )}
          </div>
          <p role="log" data-testid="generation-flow" aria-label="Status pengiriman generasi">
            {generationStatus.message ?? generationBlockReason ?? 'Menunggu persetujuan prompt.'}
          </p>
        </section>

        <section
          role="region"
          aria-label={t.backend === 'Backend' ? 'Kanvas hasil' : 'Result canvas'}
          data-testid="canvas-hero"
          className="beranda-canvas"
        >
          <div
            className={`beranda-stage ${hasImage ? 'beranda-stage-loaded' : ''}`}
            data-testid="canvas-stage"
            data-has-image={hasImage ? 'true' : 'false'}
          >
            {hasImage && canvasImage ? (
              <>
                <img
                  src={canvasImage.url}
                  alt={`Hasil generate ${canvasImage.width} × ${canvasImage.height} px`}
                  width={canvasImage.width}
                  height={canvasImage.height}
                  className="beranda-stage-art"
                />
                <a
                  className="beranda-primary beranda-download"
                  href={canvasImage.url}
                  download={`rev-${publishedManifest !== null ? 'local' : 'local'}.png`}
                  onClick={(event) => {
                    // Unduhan memakai blob URL yang masih hidup untuk sesi ini.
                    event.stopPropagation()
                  }}
                >
                  Unduh hasil ({canvasImage.width} × {canvasImage.height} px)
                </a>
                {artifactExpiresAt !== null && (
                  <p data-testid="artifact-expiry" className="beranda-note">
                    Revisi sudah tersimpan di proyek lokal. Salinan server sementara berakhir {new Date(artifactExpiresAt).toLocaleString()}.
                  </p>
                )}
              </>
            ) : (
              <p className="beranda-stage-empty">{t.stageEmpty}</p>
            )}
          </div>
          <p className="beranda-pixels" data-testid="target-pixels">
            {t.targetPixels} {tier}: {target.width} × {target.height} px · {t.ratioWord} {aspectRatio}
          </p>
          <div
            role="region"
            aria-label={t.backend === 'Backend' ? 'Kandidat job terakhir' : 'Latest job candidates'}
            className="beranda-kandidat"
          >
            <p>{t.kandidatEmpty}</p>
          </div>
        </section>

        <section
          role="region"
          aria-label={t.metaPanel}
          data-testid="panel-meta"
          className="beranda-side beranda-side-right"
        >
          <h2>{t.metaPanel}</h2>
          <label className="beranda-field">
            <span>{t.judul}</span>
            <input
              aria-label={t.judul}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t.judulPlaceholder}
            />
          </label>
          <label className="beranda-field">
            <span>{t.keywords}</span>
            <textarea
              aria-label={t.keywords}
              rows={6}
              value={keywords}
              onChange={(event) => setKeywords(event.target.value)}
              placeholder={t.keywordsPlaceholder}
            />
          </label>
          <p className="beranda-note" data-testid="keyword-count">
            {keywordCount} {t.keywordCount}
          </p>
          <section
            role="region"
            aria-label={t.backend === 'Backend' ? 'Status sistem' : 'System status'}
            className="beranda-system-pulse"
          >
            <div className="beranda-system-pulse-head">
              <span>{t.backend === 'Backend' ? 'Status sistem' : 'System status'}</span>
              <span className="beranda-system-pulse-note">live</span>
            </div>
            <div className="beranda-system-grid">
              <span className={`beranda-system-item beranda-system-${status ? status.backend.health : 'wait'}`}>
                <b>{t.backend}</b><small>{status ? status.backend.health : '…'}</small>
              </span>
              <span className="beranda-system-item">
                <b>{t.worker}</b><small>{status ? status.worker.status : '…'}</small>
              </span>
              {providerRows.length > 0 ? providerRows.map((provider) => (
                <span key={provider.provider} className={`beranda-system-item ${provider.configured ? 'beranda-system-ok' : ''}`}>
                  <b>{providerLabel(provider.provider)}</b><small>{provider.configured ? t.keyConfigured : t.noKey}</small>
                </span>
              )) : (
                <span className="beranda-system-item"><b>{t.provider}</b><small>{status ? t.empty : '…'}</small></span>
              )}
            </div>
          </section>
        </section>
      </div>

      {isCreateProjectOpen && (
        <div className="beranda-scrim" onClick={() => setCreateProjectOpen(false)}>
          <form
            role="dialog"
            aria-modal="true"
            aria-label={lang === 'id' ? 'Buat proyek baru' : 'Create new project'}
            className="beranda-dialog"
            onSubmit={(event) => void handleCreateProject(event)}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="beranda-dialog-head">
              <h2>{lang === 'id' ? 'Buat proyek baru' : 'Create new project'}</h2>
              <button type="button" className="beranda-chip" onClick={() => setCreateProjectOpen(false)} aria-label="Tutup">✕</button>
            </header>
            <label className="beranda-field">
              <span>{lang === 'id' ? 'Nama proyek' : 'Project name'}</span>
              <input value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} required autoFocus />
            </label>
            <label className="beranda-field">
              <span>{lang === 'id' ? 'Jenis konten' : 'Content type'}</span>
              <select value={newProjectType} onChange={(event) => setNewProjectType(event.target.value as ContentType)}>
                <option value="illustration">Illustration</option><option value="photo">Photo</option><option value="vector">Vector</option>
              </select>
            </label>
            <label className="beranda-field">
              <span>{lang === 'id' ? 'Metode pembuatan' : 'Creation method'}</span>
              <select value={newProjectMethod} onChange={(event) => setNewProjectMethod(event.target.value as CreationMethod)}>
                <option value="generative_ai">Generative AI</option><option value="manual_digital">Manual digital</option>
              </select>
            </label>
            <p className="beranda-note">{lang === 'id' ? 'Pilih folder kosong; manifest proyek dibuat secara lokal.' : 'Choose an empty folder; the project manifest is created locally.'}</p>
            <button type="submit" className="beranda-primary" disabled={isProjectBusy || newProjectName.trim().length === 0}>
              {isProjectBusy ? '…' : lang === 'id' ? 'Pilih folder dan buat' : 'Choose folder and create'}
            </button>
          </form>
        </div>
      )}

      <aside className="beranda-disclaimer" role="note" aria-label="Disclaimer Adobe Stock">
        <strong>Disclaimer Adobe Stock</strong>
        <p>
          Gandiwa Studio adalah alat bantu untuk menyusun prompt, metadata, dan alur produksi aset.
          Hasil generate maupun rekomendasinya tidak menjamin 100% karya diterima oleh Adobe Stock.
          Kreator tetap bertanggung jawab memeriksa kualitas visual, lisensi, kebijakan konten generative AI,
          hak kekayaan intelektual, serta kelayakan akhir sebelum mengunggah aset.
        </p>
      </aside>
      <footer className="beranda-footer">
        Gandiwa Studio by <a href="https://github.com/Rizzalaulia" target="_blank" rel="noreferrer">@Rizzalaulia</a>
      </footer>

      {settingsOpen && (
        <div className="beranda-scrim" onClick={() => setSettingsOpen(false)}>
          <section
            role="dialog"
            aria-modal="true"
            aria-label={t.settingsTitle}
            className="beranda-dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="beranda-dialog-head">
              <h2>{t.settingsTitle}</h2>
              <button
                type="button"
                className="beranda-chip"
                onClick={() => setSettingsOpen(false)}
                aria-label={lang === 'id' ? 'Tutup setelan' : 'Close settings'}
              >
                ✕
              </button>
            </header>

            <fieldset className="beranda-dialog-section">
              <legend>{t.language}</legend>
              <label className="beranda-radio">
                <input
                  type="radio"
                  name="beranda-lang"
                  checked={lang === 'id'}
                  onChange={() => changeLang('id')}
                />
                <span>Bahasa Indonesia</span>
              </label>
              <label className="beranda-radio">
                <input
                  type="radio"
                  name="beranda-lang"
                  checked={lang === 'en'}
                  onChange={() => changeLang('en')}
                />
                <span>English</span>
              </label>
            </fieldset>

            <fieldset className="beranda-dialog-section">
              <legend>{t.apiKeys}</legend>
              <p className="beranda-note">{t.keyNote}</p>

              <section className="beranda-api-role" aria-label="Image generation">
                <div className="beranda-api-role-head"><strong>Image generation</strong><span>1 gambar / job</span></div>
                <label className="beranda-field"><span>API</span>
                  <select aria-label="API image generation" value="fal" disabled>
                    <option value="fal">fal.ai · aktif</option>
                    <option value="openai-sunburst" disabled>OpenAI · gpt-2.5-sunburst · belum tersedia</option>
                  </select>
                </label>
                <label className="beranda-field"><span>Model</span>
                  <select aria-label="Model image generation" value={model} onChange={(event) => setModel(event.target.value)}>
                    {MODEL_OPTIONS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
                  </select>
                </label>
                <ProviderKeyRow provider="fal" label="fal.ai" value={newFalKey} onChange={setNewFalKey} configured={providerRows.find((entry) => entry.provider === 'fal')?.configured === true} saveProviderKey={saveProviderKey} validateProviderKey={validateProviderKey} testing={testingProvider === 'fal'} keyTest={keyTest} t={t} />
              </section>

              <section className="beranda-api-role" aria-label="Reasoning">
                <div className="beranda-api-role-head"><strong>Reasoning</strong><span>prompt & metadata</span></div>
                <label className="beranda-field"><span>API</span>
                  <select aria-label="API reasoning" value="9router" disabled>
                    <option value="9router">9Router · credential saja</option>
                  </select>
                </label>
                <label className="beranda-field"><span>Model</span>
                  <select aria-label="Model reasoning" value="assistant-pending" disabled>
                    <option value="assistant-pending">Assistant workflow belum tersedia</option>
                  </select>
                </label>
                <p className="beranda-note">Kunci dapat disimpan dan diuji, tetapi brainstorm/metadata assistant belum tersambung ke Beranda.</p>
                <ProviderKeyRow provider="9router" label="9Router" value={newRouterKey} onChange={setNewRouterKey} configured={providerRows.find((entry) => entry.provider === '9router')?.configured === true} saveProviderKey={saveProviderKey} validateProviderKey={validateProviderKey} testing={testingProvider === '9router'} keyTest={keyTest} t={t} />
              </section>
              {settingsNote && <p role="status" className="beranda-note">{settingsNote}</p>}
            </fieldset>
          </section>
        </div>
      )}
    </div>
  )
}
