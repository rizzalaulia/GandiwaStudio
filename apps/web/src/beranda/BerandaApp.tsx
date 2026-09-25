import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

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
  requestProjectWritePermission,
  type DirectoryHandleLike,
} from '../project-lifecycle'
import { companionHeadersForToken } from './settings-client'
import { buildApprovedCreativeJob } from './creative-session-adapter'
import { dispatchApprovedCreativeJob, monitorCreativeJobToRevision } from './creative-dispatch-controller'
import { fetchCreativeJob, downloadCreativeArtifact, cancelCreativeJob } from './creative-job-client'
import { recordGeneratedRevision } from './generated-revision-store'
import { loadCreativeSession, saveCreativeSession, type CreativeSessionDirectory } from '../creative-session-store'
import { validateProjectManifest } from '@gandiwa/contracts'
import {
  fetchProviderOptions,
  resolveSelectedInstance,
  type ProviderOption,
} from '../assistant/router-selection'
import {
  loadMasterSelection,
  resolveMasterSelection,
  saveMasterSelection,
  type MasterSelectionDirectory,
} from '../master-selection-store'
import {
  loadStockMetadata,
  saveStockMetadata,
  type LoadedStockMetadata,
  type MetadataDirectory,
} from '../stock-metadata-store'
import type { ReleaseStatus, StockMetadataDraft } from '../stock-metadata'
import type { DurableAuditSnapshot } from '../approval-gate'
import {
  loadCurrentRevisionAudit,
  runRevisionAudit,
  type RevisionAuditDirectory,
} from '../revision-audit-pipeline'

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
    testKey: 'Check connection',
    testValid: 'kunci valid — provider menerima autentikasi',
    testRejected: 'kunci DITOLAK provider — periksa/paste ulang key',
    testAccountLocked: 'kunci SAH — tanpa autentikasi gagal; akun provider terkunci (mis. saldo habis). Selesaikan di dashboard provider; kunci tidak perlu di-paste ulang.',
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
    testAccountLocked: 'key is VALID — authentication did not fail; the provider account is locked (e.g. exhausted balance). Resolve it at the provider dashboard; the key does not need re-pasting.',
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
  validateProviderKey?: (provider: 'fal') => void
  testing?: boolean
  keyTest?: { provider: string; note: string; level: 'ok' | 'rejected' | 'account' | 'unreachable' | 'error' } | null
  t: Strings
}

function ProviderKeyRow({ provider, label, value, onChange, configured, unavailable = false, validateProviderKey, testing = false, keyTest = null, t }: ProviderKeyRowProps) {
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
        {!unavailable && validateProviderKey !== undefined && (
          <button
            type="button"
            className={`beranda-btn-test${testLevelClass}`}
            aria-label={`${t.testKey} ${label}`}
            disabled={value.trim().length === 0 || testing}
            onClick={() => {
              if (provider === 'fal') validateProviderKey(provider)
            }}
          ><span className="beranda-btn-test-icon" aria-hidden="true">{testing ? '⏳' : rowTest === null ? '⚡' : rowTest.level === 'ok' ? '✓' : rowTest.level === 'rejected' ? '✕' : rowTest.level === 'account' ? '🔒' : '⚠'}</span>{testing ? `${t.testKey}…` : t.testKey} {label}</button>
        )}
      </div>
      {rowTest !== null && (
        <p role="status" className={`beranda-keytest beranda-keytest-${rowTest.level}`}>{rowTest.note}</p>
      )}
    </div>
  )
}

type LocalConnectionFieldsProps = Readonly<{
  name: string; setName: (value: string) => void
  prefix: string; setPrefix: (value: string) => void
  apiType: string; setApiType: (value: string) => void
  baseUrl: string; setBaseUrl: (value: string) => void
  modelId: string; setModelId: (value: string) => void
  compact?: boolean
}>

function LocalConnectionFields({ name, setName, prefix, setPrefix, apiType, setApiType, baseUrl, setBaseUrl, modelId, setModelId, compact = false }: LocalConnectionFieldsProps) {
  const [checked, setChecked] = useState(false)
  const complete = baseUrl.trim().length > 0 && modelId.trim().length > 0
  return (
    <div className="beranda-local-connection">
      {!compact && <label className="beranda-field"><span>Nama koneksi</span><input aria-label="Nama koneksi gambar" value={name} onChange={(event) => { setName(event.target.value); setChecked(false) }} placeholder="Mis. studio image API" /></label>}
      <label className="beranda-field"><span>Tipe API</span><select aria-label={compact ? 'Tipe API reasoning dan metadata' : 'Tipe API gambar'} value={apiType} onChange={(event) => { setApiType(event.target.value); setChecked(false) }}><option value="responses">Responses-compatible</option><option value="chat">Chat Completions-compatible</option><option value="messages">Messages-compatible</option></select></label>
      {!compact && <label className="beranda-field"><span>Prefix API key</span><input aria-label="Prefix API key gambar" value={prefix} onChange={(event) => { setPrefix(event.target.value); setChecked(false) }} placeholder="Bearer" /></label>}
      <label className="beranda-field"><span>Base URL</span><input aria-label={compact ? 'Base URL reasoning dan metadata' : 'Base URL gambar'} value={baseUrl} onChange={(event) => { setBaseUrl(event.target.value); setChecked(false) }} placeholder="https://api.example.com/v1" /></label>
      <label className="beranda-field"><span>Model ID</span><input aria-label={compact ? 'Model ID reasoning dan metadata' : 'Model ID gambar'} value={modelId} onChange={(event) => { setModelId(event.target.value); setChecked(false) }} placeholder="model-id" /></label>
      <button type="button" className="beranda-btn-test" disabled={!complete} onClick={() => setChecked(true)}>⚡ Check connection</button>
      {checked && <p role="status" className="beranda-keytest beranda-keytest-ok">Check connection rev3: bentuk isian valid secara lokal. Belum menghubungi provider atau memotong kredit.</p>}
    </div>
  )
}

type RevisionHistoryEntry = Readonly<{
  assetId: string
  revision: number
  relativePath: string
  contentType: ContentType
  creationMethod: CreationMethod
}>

type PreviewFile = Readonly<{ arrayBuffer(): Promise<ArrayBuffer>; type?: string }>
type PreviewFileHandle = Readonly<{ getFile(): Promise<PreviewFile> }>
type PreviewDirectory = Readonly<{
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<PreviewDirectory>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<PreviewFileHandle>
}>

async function loadRevisionPreview(directory: PreviewDirectory, relativePath: string): Promise<string> {
  const segments = relativePath.split('/')
  const fileName = segments.pop()
  if (!fileName || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Path revisi tidak aman.')
  }
  let current = directory
  for (const segment of segments) current = await current.getDirectoryHandle(segment, { create: false })
  const file = await (await current.getFileHandle(fileName, { create: false })).getFile()
  const extension = fileName.split('.').at(-1)?.toLowerCase()
  const mediaType = extension === 'jpeg' || extension === 'jpg' ? 'image/jpeg' : extension === 'svg' ? 'image/svg+xml' : 'image/png'
  return URL.createObjectURL(new Blob([await file.arrayBuffer()], { type: file.type || mediaType }))
}

// Riwayat revisi dibaca dari manifest yang sudah tervalidasi kontrak. Manifest
// invalid → kosong + error, tidak pernah menebak isi folder.
function revisionHistoryFromSnapshot(snapshot: string): { history: RevisionHistoryEntry[]; error: string | null; latestAssetId: string | null } {
  let parsed: unknown
  try {
    parsed = JSON.parse(snapshot)
  } catch {
    return { history: [], error: 'Manifest proyek bukan JSON valid — riwayat revisi tidak dibaca.', latestAssetId: null }
  }
  try {
    const manifest = validateProjectManifest(parsed)
    const history: RevisionHistoryEntry[] = []
    for (const asset of manifest.assets) {
      for (const revision of asset.revisions) {
        history.push({
          assetId: asset.asset_id,
          revision: revision.revision,
          relativePath: revision.relative_path,
          contentType: asset.content_type,
          creationMethod: asset.creation_method,
        })
      }
    }
    history.sort((a, b) => b.revision - a.revision)
    const withAssets = manifest.assets.length > 0
    // Kontinuitas: asset terakhir (pemilik rev tertinggi) jadi aktif berikutnya
    // sehingga regenerate melanjutkan rev-N, bukan spawn asset baru.
    const latest = [...manifest.assets].sort((a, b) =>
      Math.max(...b.revisions.map((entry) => entry.revision)) - Math.max(...a.revisions.map((entry) => entry.revision)),
    )[0]
    return {
      history,
      error: null,
      latestAssetId: withAssets && latest ? latest.asset_id : null,
    }
  } catch (cause) {
    return {
      history: [],
      error: cause instanceof Error ? `Manifest invalid: ${cause.message}` : 'Manifest proyek invalid.',
      latestAssetId: null,
    }
  }
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
  // Rev3: dua halaman kerja yang sengaja fokus. Setelan tetap dialog pendukung.
  const [workPage, setWorkPage] = useState<'create' | 'prepare'>('create')
  const [metadataReviewed, setMetadataReviewed] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [keyTest, setKeyTest] = useState<{ provider: string; note: string; level: 'ok' | 'rejected' | 'account' | 'unreachable' | 'error' } | null>(null)
  const [testingProvider, setTestingProvider] = useState<'fal' | '9router' | null>(null)

  const [newFalKey, setNewFalKey] = useState('')
  // Purwarupa rev3: bentuk koneksi lokal, belum dipersist atau dihubungkan.
  const [imageConnectionKind, setImageConnectionKind] = useState<'fal' | 'openai' | 'self'>('fal')
  const [imageConnectionName, setImageConnectionName] = useState('')
  const [imageConnectionPrefix, setImageConnectionPrefix] = useState('')
  const [imageApiType, setImageApiType] = useState('responses')
  const [imageBaseUrl, setImageBaseUrl] = useState('')
  const [imageModelId, setImageModelId] = useState('')
  const [reasoningProvider, setReasoningProvider] = useState('anthropic')
  const [reasoningApiType, setReasoningApiType] = useState('messages')
  const [reasoningBaseUrl, setReasoningBaseUrl] = useState('')
  const [reasoningModelId, setReasoningModelId] = useState('')

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
  const [metadataCategory, setMetadataCategory] = useState('')
  const [aiDisclosure, setAiDisclosure] = useState('')
  const [releaseStatus, setReleaseStatus] = useState<ReleaseStatus>('not_required')
  const [loadedMetadata, setLoadedMetadata] = useState<LoadedStockMetadata | null>(null)
  const [metadataBusy, setMetadataBusy] = useState(false)
  const [metadataMessage, setMetadataMessage] = useState<string | null>(null)
  // Diisi hasil job nyata: piksel dari artifact tervalidasi SHA-256 yang
  // sudah tersimpan sebagai revisi lokal. Selama kosong, panggung mengikuti
  // warna ruangan; latar netral terang dipakai saat art ada.
  const [hasImage, setHasImage] = useState(false)
  const [canvasImage, setCanvasImage] = useState<{
    url: string
    width: number | null
    height: number | null
    revokeOnReplace: boolean
  } | null>(null)
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
  const [activeAssetId, setActiveAssetId] = useState<string | null>(null)
  const [contentType, setContentType] = useState<ContentType>('illustration')
  // Riwayat revisi riil dari manifest proyek aktif — kandidat compare di #26
  // adalah perbandingan antar-revision hasil regenerate, bukan batch kandidat.
  const [projectRevisions, setProjectRevisions] = useState<ReadonlyArray<RevisionHistoryEntry>>([])
  const [selectedRevisionKey, setSelectedRevisionKey] = useState<string | null>(null)
  const [masterRevisionKey, setMasterRevisionKey] = useState<string | null>(null)
  const [masterSelectionSnapshot, setMasterSelectionSnapshot] = useState<string | undefined>(undefined)
  const [masterSelectionBusy, setMasterSelectionBusy] = useState(false)
  const [masterSelectionMessage, setMasterSelectionMessage] = useState<string | null>(null)
  const [canvasZoom, setCanvasZoom] = useState(100)
  const [inspectionBackground, setInspectionBackground] = useState<'light' | 'dark' | 'checker'>('light')
  const [rejectionReason, setRejectionReason] = useState('')
  const [revisionPreviews, setRevisionPreviews] = useState<Readonly<Record<string, string>>>({})
  const [brainstorm, setBrainstorm] = useState<{ questions: string[]; recommendation: string } | null>(null)
  const [brainstormBusy, setBrainstormBusy] = useState(false)
  const [, setAssistantInstances] = useState<ProviderOption[] | null>(null)
  const [assistantInstance, setAssistantInstance] = useState<string | null>(null)
  // Ruling #58: instance/model assistant dipilih manusia, tanpa auto-route.
  const [assistantModel] = useState(() => {
    try { return window.localStorage.getItem('beranda-router-model') ?? '' } catch { return '' }
  })
  const [auditLifecycle, setAuditLifecycle] = useState<'EMPTY' | 'STALE' | 'PASS' | 'WARNING' | 'FAIL'>('EMPTY')
  const [auditSnapshot, setAuditSnapshot] = useState<string | undefined>(undefined)
  const [durableAudit, setDurableAudit] = useState<DurableAuditSnapshot | null>(null)
  const [auditMessage, setAuditMessage] = useState<string | null>(null)
  const [auditBusy, setAuditBusy] = useState(false)
  const generationSequence = useRef(0)
  const brainstormSequence = useRef(0)
  const masterSelectionSequence = useRef(0)
  const metadataSequence = useRef(0)
  const auditSequence = useRef(0)

  const resetProjectRuntime = useCallback(() => {
    generationSequence.current += 1
    brainstormSequence.current += 1
    masterSelectionSequence.current += 1
    metadataSequence.current += 1
    auditSequence.current += 1
    setBrainstormBusy(false)
    setHasImage(false)
    setCanvasImage(null)
    setPublishedManifest(null)
    setGenerationStatus({ state: 'idle', message: null })
    setActiveJobId(null)
    setCancelRequested(false)
    setArtifactExpiresAt(null)
    setProjectRevisions([])
    setSelectedRevisionKey(null)
    setMasterRevisionKey(null)
    setMasterSelectionSnapshot(undefined)
    setMasterSelectionBusy(false)
    setMasterSelectionMessage(null)
    setRevisionPreviews({})
    setRejectionReason('')
    setBrainstorm(null)
    setTitle('')
    setKeywords('')
    setMetadataCategory('')
    setAiDisclosure('')
    setReleaseStatus('not_required')
    setLoadedMetadata(null)
    setMetadataBusy(false)
    setMetadataMessage(null)
    setAuditLifecycle('EMPTY')
    setAuditSnapshot(undefined)
    setDurableAudit(null)
    setAuditMessage(null)
    setAuditBusy(false)
  }, [])

  const acceptOpenedProject = useCallback((name: string, directory: DirectoryHandleLike, manifestSnapshot: string | null = null) => {
    resetProjectRuntime()
    setProjectName(name)
    setRememberedProject(directory)
    setProjectDirectory(directory)
    setActiveProjectName(name)
    // Riwayat + kontinuitas asset dipulihkan dari manifest yang barusan
    // divalidasi lifecycle, bukan dari tebakan sesi React sebelumnya.
    if (manifestSnapshot !== null) {
      const { history, latestAssetId } = revisionHistoryFromSnapshot(manifestSnapshot)
      setProjectRevisions(history)
      setProjectManifestSnapshot(manifestSnapshot)
      setActiveAssetId(latestAssetId)
      setSelectedRevisionKey(history[0] ? `${history[0].assetId}/${history[0].revision}` : null)
      // Master adalah keputusan manusia sesi ini. Reopen tidak boleh menebak
      // bahwa revisi terbaru otomatis menjadi master.
      setMasterRevisionKey(null)
      setAuditLifecycle(history.length > 0 ? 'STALE' : 'EMPTY')
    } else {
      setProjectRevisions([])
      setActiveAssetId(null)
      setSelectedRevisionKey(null)
      setMasterRevisionKey(null)
      setAuditLifecycle('EMPTY')
    }
    setProjectMessage(`${name} dibuka secara lokal.`)
  }, [resetProjectRuntime])

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
        resetProjectRuntime()
        setProjectName(result.projectName)
        setContentType(result.contentType)
        const remembered = await loadRememberedProjectDirectory<DirectoryHandleLike>()
        setRememberedProject(remembered ?? null)
        setProjectDirectory(remembered ?? null)
        setActiveProjectName(result.projectName)
        setActiveAssetId(null)
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
  }, [newProjectMethod, newProjectName, newProjectType, resetProjectRuntime])

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

  useEffect(() => {
    let cancelled = false
    fetchProviderOptions()
      .then((options) => {
        if (cancelled) return
        setAssistantInstances(options)
        setAssistantInstance(resolveSelectedInstance(options))
      })
      .catch(() => {
        if (cancelled) return
        setAssistantInstances([])
        setAssistantInstance(null)
      })
    return () => { cancelled = true }
  }, [])

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === 'day' ? 'night' : 'day'))
  }, [])

  const handleBrainstorm = useCallback(async () => {
    if (!activeProjectName || brainstormBusy) return
    const operation = ++brainstormSequence.current
    const isCurrentOperation = () => brainstormSequence.current === operation
    if (assistantInstance === null) {
      setGenerationStatus({ state: 'error', message: 'Pilih instance 9Router di Setelan dulu — tanpa pemilihan otomatis.' })
      return
    }
    if (assistantModel.trim().length === 0) {
      setGenerationStatus({ state: 'error', message: 'Pilih model reasoning 9Router di Setelan dulu — tanpa pemilihan otomatis.' })
      return
    }
    setBrainstormBusy(true)
    try {
      const csrfResponse = await fetch('/api/v1/auth/csrf', { credentials: 'same-origin' })
      if (!csrfResponse.ok) throw new Error('Gagal menyiapkan token keamanan assistant.')
      const { csrf_token: csrfToken } = await csrfResponse.json() as { csrf_token: string }
      const response = await fetch('/api/v1/creative/assistant/brainstorm', {
        method: 'POST', credentials: 'same-origin', headers: companionHeadersForToken(csrfToken),
        body: JSON.stringify({
          instance_id: assistantInstance,
          topic: activeProjectName,
          content_type: contentType,
          model_id: assistantModel.trim(),
        }),
      })
      if (!response.ok) throw new Error(`Brainstorm assistant gagal (${response.status}).`)
      const body = await response.json() as { questions: string[]; recommendation: string }
      if (!Array.isArray(body.questions) || body.questions.length !== 3 || !body.recommendation) throw new Error('Respons brainstorm tidak valid.')
      if (isCurrentOperation()) setBrainstorm(body)
    } catch (error) {
      if (isCurrentOperation()) {
        setGenerationStatus({ state: 'error', message: error instanceof Error ? error.message : 'Brainstorm assistant gagal.' })
      }
    } finally {
      if (isCurrentOperation()) setBrainstormBusy(false)
    }
  }, [activeProjectName, assistantInstance, assistantModel, brainstormBusy, contentType])

  const handleApprovePrompt = useCallback(async () => {
    const operation = ++generationSequence.current
    const isCurrentOperation = () => generationSequence.current === operation
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
      // Kontinuitas asset: sesi kreatif memakai asset ID target — saat asset
      // aktif dipulihkan dari manifest/pilihan strip, sidecar, persisted session,
      // dan revisi manifest sama-sama menempel di asset itu, jadi regenerate
      // berikutnya menjadi rev-N+1 alih-alih tile asset terpisah.
      const targetAssetId = activeAssetId ?? crypto.randomUUID()
      const sessionId = targetAssetId
      const sessionDirectory = projectDirectory as DirectoryHandleLike & CreativeSessionDirectory
      const previousSession = activeAssetId === null
        ? undefined
        : await loadCreativeSession(sessionDirectory, activeAssetId)
      const approved = await buildApprovedCreativeJob({
        sessionId,
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
        ...(previousSession === undefined ? {} : { previousSession }),
        ...(rejectionReason.trim() ? { rejectionReason: rejectionReason.trim() } : {}),
      })
      // Runtime handle File System Access implement interface yang lebih luas
      // dari dua alias TS ini; set connected hanya lewat open/create nyata.
      const { job, persisted } = await dispatchApprovedCreativeJob({
        approved,
        directory: sessionDirectory,
        manifestSnapshot,
        sidecarSnapshot: previousSession?.snapshot,
      })
      if (!isCurrentOperation()) return
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
          if (!isCurrentOperation()) return
          const cancelNote = currentJob.cancel_requested ? ' · pembatalan diminta' : ''
          // Issue #26 AC: posisi antrean tampil jelas saat job masih menunggu.
          const queueNote = currentJob.status === 'queued' && currentJob.queue_position !== null
            ? ` · posisi antrean ${currentJob.queue_position}`
            : ''
          setGenerationStatus({
            state: 'busy',
            message: `Job ${currentJob.id}: ${currentJob.status}${queueNote} · percobaan ${currentJob.attempt_count}${cancelNote}`,
          })
        },
        fetchArtifact: downloadCreativeArtifact,
        recordRevision: recordGeneratedRevision,
        recordInput: {
          directory: sessionDirectory,
          manifestSnapshot,
          persistedSession: persisted,
          assetId: targetAssetId,
          ...(rejectionReason.trim() ? { rejectionReason: rejectionReason.trim() } : {}),
          saveSidecar: saveCreativeSession,
          publishManifest: (next) => writeProjectManifestAtomically(projectDirectory as unknown as Parameters<typeof writeProjectManifestAtomically>[0], next),
        },
        recordOutcome: (outcome) => {
          if (!isCurrentOperation()) return Promise.resolve()
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
      if (!isCurrentOperation()) return
      if (finished.status === 'succeeded' && finished.url !== null && finished.job?.artifact) {
        setCanvasImage({
          url: finished.url,
          width: finished.job.artifact.width,
          height: finished.job.artifact.height,
          revokeOnReplace: true,
        })
        setHasImage(true)
        setPublishedManifest(finished.publishedManifest)
        if (finished.publishedManifest !== null) {
          const nextSnapshot = `${JSON.stringify(finished.publishedManifest, null, 2)}\n`
          setProjectManifestSnapshot(nextSnapshot)
          // Baca ulang manifest yang baru terbit: rev-N+1 masuk strip kandidat
          // dan asset aktif tetap asset yang sama (kontinuitas regenerate).
          const { history, latestAssetId } = revisionHistoryFromSnapshot(nextSnapshot)
          setProjectRevisions(history)
          setActiveAssetId(latestAssetId ?? targetAssetId)
          setSelectedRevisionKey(history[0] ? `${history[0].assetId}/${history[0].revision}` : null)
        }
        setArtifactExpiresAt(finished.job.artifact_expires_at)
        setRejectionReason('')
        // Revisi baru selalu menginvalidasi audit/approval lama. Jangan pernah
        // menampilkan PASS/CLEAR hingga preflight terikat revisi ini dijalankan.
        setAuditLifecycle('STALE')
      } else {
        setGenerationStatus({ state: 'error', message: finished.error ?? finished.message ?? `Job berakhir ${finished.status}.` })
      }
    } catch (error) {
      if (isCurrentOperation()) {
        setGenerationStatus({
          state: 'error',
          message: error instanceof Error ? error.message : 'Pengiriman job gagal.',
        })
      }
    }
  }, [activeAssetId, activeProjectName, aspectRatio, contentType, model, negativePrompt, projectDirectory, projectManifestSnapshot, prompt, rejectionReason, tier])

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

  const handleSetMasterRevision = useCallback(async () => {
    if (selectedRevisionKey === null || projectDirectory === null || projectManifestSnapshot === null) return
    const entry = projectRevisions.find((candidate) => `${candidate.assetId}/${candidate.revision}` === selectedRevisionKey)
    if (!entry) {
      setMasterSelectionMessage('Revisi terpilih tidak lagi tersedia.')
      return
    }
    const operation = ++masterSelectionSequence.current
    const isCurrent = () => operation === masterSelectionSequence.current
    setMasterSelectionBusy(true)
    setMasterSelectionMessage(null)
    try {
      if (!(await requestProjectWritePermission(projectDirectory))) {
        throw new Error('Izin tulis tidak diberikan. Master tidak disimpan.')
      }
      if (!isCurrent()) return
      const directory = projectDirectory as unknown as MasterSelectionDirectory
      const record = await resolveMasterSelection({
        directory,
        manifestSnapshot: projectManifestSnapshot,
        assetId: entry.assetId,
        revision: entry.revision,
        selectedAt: new Date().toISOString(),
        selectedBy: 'Master Peng',
      })
      if (!isCurrent()) return
      const saved = await saveMasterSelection({
        directory,
        manifestSnapshot: projectManifestSnapshot,
        record,
        ...(masterSelectionSnapshot === undefined ? {} : { previousSnapshot: masterSelectionSnapshot }),
      })
      if (!isCurrent()) return
      setMasterRevisionKey(selectedRevisionKey)
      setMasterSelectionSnapshot(saved.snapshot)
      setMetadataReviewed(false)
      setMasterSelectionMessage(`Master rev-${entry.revision} tersimpan di proyek lokal.`)
    } catch (error) {
      if (!isCurrent()) return
      setMasterRevisionKey(null)
      setMasterSelectionMessage(error instanceof Error ? error.message : 'Master tidak dapat disimpan.')
    } finally {
      if (isCurrent()) setMasterSelectionBusy(false)
    }
  }, [masterSelectionSnapshot, projectDirectory, projectManifestSnapshot, projectRevisions, selectedRevisionKey])

  const activeWorkRevisionKey = workPage === 'prepare' ? masterRevisionKey : selectedRevisionKey
  const masterPreviewUrl = masterRevisionKey === null ? '' : revisionPreviews[masterRevisionKey] ?? ''

  const handleSaveMetadata = useCallback(async () => {
    if (projectDirectory === null || projectManifestSnapshot === null || activeWorkRevisionKey === null) return
    const entry = projectRevisions.find((candidate) => `${candidate.assetId}/${candidate.revision}` === activeWorkRevisionKey)
    if (!entry) return
    const operation = ++metadataSequence.current
    const isCurrent = () => operation === metadataSequence.current
    setMetadataBusy(true)
    setMetadataMessage(null)
    try {
      if (!(await requestProjectWritePermission(projectDirectory))) {
        throw new Error('Izin tulis tidak diberikan. Metadata tidak disimpan.')
      }
      if (!isCurrent()) return
      const metadata: StockMetadataDraft = {
        schemaVersion: 1,
        title,
        keywords: keywords.split(',').map((keyword) => keyword.trim()).filter(Boolean),
        category: metadataCategory,
        contentType: entry.contentType,
        creationMethod: entry.creationMethod,
        generatedWithAi: entry.creationMethod === 'generative_ai' || entry.creationMethod === 'mixed',
        aiDisclosure,
        releaseStatus,
      }
      const saved = await saveStockMetadata({
        directory: projectDirectory as unknown as MetadataDirectory,
        manifestSnapshot: projectManifestSnapshot,
        assetId: entry.assetId,
        provenance: { contentType: entry.contentType, creationMethod: entry.creationMethod },
        metadata,
        sidecarSnapshot: loadedMetadata?.snapshot,
      })
      if (!isCurrent()) return
      setLoadedMetadata(saved)
      setTitle(saved.metadata.title)
      setKeywords(saved.metadata.keywords.join(', '))
      setAuditLifecycle('STALE')
      auditSequence.current += 1
      setAuditBusy(false)
      setAuditMessage('Metadata berubah; durable audit sebelumnya STALE dan harus dijalankan ulang.')
      setMetadataMessage('Metadata tersimpan. Audit revisi harus dijalankan ulang.')
    } catch (error) {
      if (isCurrent()) setMetadataMessage(error instanceof Error ? error.message : 'Metadata tidak dapat disimpan.')
    } finally {
      if (isCurrent()) setMetadataBusy(false)
    }
  }, [aiDisclosure, keywords, loadedMetadata?.snapshot, metadataCategory, projectDirectory, projectManifestSnapshot, projectRevisions, releaseStatus, activeWorkRevisionKey, title])

  const handleRunAudit = useCallback(async () => {
    if (projectDirectory === null || projectManifestSnapshot === null || activeWorkRevisionKey === null) return
    const entry = projectRevisions.find((candidate) => `${candidate.assetId}/${candidate.revision}` === activeWorkRevisionKey)
    if (!entry) return
    const operation = ++auditSequence.current
    const isCurrent = () => operation === auditSequence.current
    setAuditBusy(true)
    setAuditMessage(null)
    try {
      if (!(await requestProjectWritePermission(projectDirectory))) {
        throw new Error('Izin tulis tidak diberikan. Audit tidak disimpan.')
      }
      if (!isCurrent()) return
      const result = await runRevisionAudit({
        directory: projectDirectory as unknown as RevisionAuditDirectory,
        manifestSnapshot: projectManifestSnapshot,
        assetId: entry.assetId,
        revision: entry.revision,
        ...(auditSnapshot === undefined ? {} : { previousAuditSnapshot: auditSnapshot }),
      })
      if (!isCurrent()) return
      setAuditLifecycle(result.status)
      setAuditSnapshot(result.snapshot)
      setDurableAudit(result.audit)
      setAuditMessage(`Audit ${result.status} tersimpan untuk rev-${entry.revision}.`)
    } catch (error) {
      if (!isCurrent()) return
      setAuditLifecycle('STALE')
      setAuditMessage(error instanceof Error ? error.message : 'Audit tidak dapat diselesaikan.')
    } finally {
      if (isCurrent()) setAuditBusy(false)
    }
  }, [auditSnapshot, projectDirectory, projectManifestSnapshot, projectRevisions, activeWorkRevisionKey])

  // Persistent gallery: hydrate thumbnails directly from browser-owned
  // revision files on reopen. Failed/missing files stay honest placeholders.
  useEffect(() => {
    if (projectDirectory === null || projectRevisions.length === 0) {
      setRevisionPreviews({})
      return
    }
    let cancelled = false
    const urls: string[] = []
    Promise.all(projectRevisions.map(async (entry) => {
      const key = `${entry.assetId}/${entry.revision}`
      try {
        const url = await loadRevisionPreview(projectDirectory as unknown as PreviewDirectory, entry.relativePath)
        urls.push(url)
        return [key, url] as const
      } catch {
        return [key, ''] as const
      }
    })).then((pairs) => {
      if (!cancelled) setRevisionPreviews(Object.fromEntries(pairs))
    }).catch(() => undefined)
    return () => {
      cancelled = true
      for (const url of urls) URL.revokeObjectURL(url)
    }
  }, [projectDirectory, projectRevisions])

  useEffect(() => {
    if (projectDirectory === null || projectManifestSnapshot === null) {
      setMasterRevisionKey(null)
      setMasterSelectionSnapshot(undefined)
      return
    }
    const operation = ++masterSelectionSequence.current
    loadMasterSelection(
      projectDirectory as unknown as MasterSelectionDirectory,
      projectManifestSnapshot,
    ).then((loaded) => {
      if (operation !== masterSelectionSequence.current) return
      setMasterRevisionKey(loaded ? `${loaded.record.assetId}/${loaded.record.revision}` : null)
      setMasterSelectionSnapshot(loaded?.snapshot)
      setMasterSelectionMessage(null)
    }).catch((error: unknown) => {
      if (operation !== masterSelectionSequence.current) return
      setMasterRevisionKey(null)
      setMasterSelectionSnapshot(undefined)
      setMasterSelectionMessage(error instanceof Error ? error.message : 'Master revision could not be loaded.')
    })
    return () => { masterSelectionSequence.current += 1; setMasterSelectionBusy(false) }
  }, [projectDirectory, projectManifestSnapshot])

  useEffect(() => {
    if (projectDirectory === null || projectManifestSnapshot === null || activeWorkRevisionKey === null) {
      setLoadedMetadata(null)
      setAuditSnapshot(undefined)
      setDurableAudit(null)
      setAuditLifecycle(projectRevisions.length > 0 ? 'STALE' : 'EMPTY')
      return
    }
    const entry = projectRevisions.find((candidate) => `${candidate.assetId}/${candidate.revision}` === activeWorkRevisionKey)
    if (!entry) return
    setLoadedMetadata(null)
    setTitle('')
    setKeywords('')
    setMetadataCategory('')
    setAiDisclosure('')
    setReleaseStatus('not_required')
    setMetadataMessage(null)
    setAuditLifecycle('STALE')
    setAuditSnapshot(undefined)
    setDurableAudit(null)
    setAuditMessage(null)
    const metadataOperation = ++metadataSequence.current
    const auditOperation = ++auditSequence.current
    const directory = projectDirectory as unknown as RevisionAuditDirectory
    loadStockMetadata(directory, entry.assetId, {
      contentType: entry.contentType,
      creationMethod: entry.creationMethod,
    }).then((loaded) => {
      if (metadataOperation !== metadataSequence.current) return
      setLoadedMetadata(loaded ?? null)
      if (loaded) {
        setTitle(loaded.metadata.title)
        setKeywords(loaded.metadata.keywords.join(', '))
        setMetadataCategory(loaded.metadata.category)
        setAiDisclosure(loaded.metadata.aiDisclosure)
        setReleaseStatus(loaded.metadata.releaseStatus)
        setMetadataMessage(null)
      }
      return loadCurrentRevisionAudit({
        directory,
        manifestSnapshot: projectManifestSnapshot,
        assetId: entry.assetId,
        revision: entry.revision,
      })
    }).then((loadedAudit) => {
      if (auditOperation !== auditSequence.current || loadedAudit === undefined) return
      setAuditLifecycle(loadedAudit.status)
      setAuditSnapshot(loadedAudit.snapshot)
      setDurableAudit(loadedAudit.audit)
      setAuditMessage(`Audit ${loadedAudit.status} dimuat untuk rev-${entry.revision}.`)
    }).catch((error: unknown) => {
      if (auditOperation !== auditSequence.current) return
      setAuditLifecycle('STALE')
      setAuditSnapshot(undefined)
      setDurableAudit(null)
      setAuditMessage(error instanceof Error ? error.message : 'Audit revision could not be loaded.')
    })
    return () => {
      metadataSequence.current += 1
      auditSequence.current += 1
      setMetadataBusy(false)
      setAuditBusy(false)
    }
  }, [projectDirectory, projectManifestSnapshot, projectRevisions, activeWorkRevisionKey])

  // Blob URL lifecycle: revoke exactly when the displayed image is replaced
  // or the desk unmounts, so no dead blob and no leak.
  useEffect(() => {
    if (canvasImage === null || !canvasImage.revokeOnReplace) return
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

  function validateProviderKey(provider: 'fal') {
    // Rev3 is explicitly a local-form prototype: never contact an upstream
    // provider, create a job, or consume credit from this Settings action.
    setKeyTest(null)
    setTestingProvider(provider)
    const candidate = newFalKey
    if (candidate.trim().length === 0) {
      setKeyTest({ provider, note: 'Check connection rev3: isi API key terlebih dahulu; belum ada panggilan API.', level: 'error' })
    } else {
      setKeyTest({ provider, note: 'Check connection rev3: bentuk isian valid secara lokal. Belum menghubungi provider atau memotong kredit.', level: 'ok' })
    }
    setTestingProvider(null)
  }

  const target = useMemo(() => resolutionForTier(tier, aspectRatio), [tier, aspectRatio])

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
    <div className={`beranda ${theme === 'night' ? 'beranda-night' : ''}`} data-page={workPage}>
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

      <nav className="beranda-workflow-nav" aria-label="Alur kerja">
        <button type="button" aria-label="Create" aria-current={workPage === 'create' ? 'page' : undefined} className="beranda-workflow-tab" onClick={() => setWorkPage('create')}>Create<span>Buat & pilih gambar</span></button>
        <button type="button" aria-label="Prepare" aria-current={workPage === 'prepare' ? 'page' : undefined} className="beranda-workflow-tab" disabled={masterRevisionKey === null} onClick={() => setWorkPage('prepare')}>Prepare<span>Audit & metadata</span></button>
        <p className="beranda-workflow-hint">{workPage === 'create' ? 'Buat beberapa revisi, lalu kunci satu gambar sebagai master.' : 'Rapikan satu master, tinjau metadata, lalu siapkan paket unduh.'}</p>
      </nav>

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

      {workPage === 'create' && (
      <div className="beranda-desk" role="region" aria-label="Create image">
        <section
          role="region"
          aria-label={t.promptPanel}
          data-testid="panel-prompt"
          className="beranda-side beranda-side-left"
        >
          <h2>{t.promptPanel}</h2>
          <button type="button" className="beranda-ghost" disabled={activeProjectName === null || brainstormBusy} onClick={() => void handleBrainstorm()}>
            {brainstormBusy ? '9Router berpikir…' : 'Brainstorm dengan 9Router'}
          </button>
          {activeProjectName === null && (
            <p className="beranda-note">Buka proyek dulu untuk mengaktifkan brainstorm. Brainstorm ini memanggil 9Router: 3 pertanyaan + 1 rekomendasi yang bisa langsung dipakai sebagai prompt.</p>
          )}
          {brainstorm !== null && (
            <div className="beranda-brainstorm" role="status" aria-label="Hasil brainstorm 9Router">
              <ol>{brainstorm.questions.map((question) => <li key={question}>{question}</li>)}</ol>
              <p><strong>Rekomendasi:</strong> {brainstorm.recommendation}</p>
              <button type="button" onClick={() => setPrompt(brainstorm.recommendation)}>Pakai rekomendasi sebagai prompt</button>
            </div>
          )}
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
          {projectRevisions.length > 0 && (
            <label className="beranda-field">
              <span>Alasan penolakan hasil sebelumnya (opsional jika prompt berubah)</span>
              <textarea
                aria-label="Alasan penolakan hasil sebelumnya"
                rows={2}
                value={rejectionReason}
                onChange={(event) => setRejectionReason(event.target.value)}
                placeholder="Contoh: komposisi terlalu padat di sisi kanan."
              />
            </label>
          )}
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
              aria-label="Setujui prompt"
              disabled={prompt.trim().length === 0 || generationStatus.state === 'busy' || projectDirectory === null || !generationRuntimeReady}
              onClick={() => void handleApprovePrompt()}
            >
              {generationStatus.state === 'busy' ? 'Generating…' : projectRevisions.length > 0 ? 'Regenerate image' : 'Generate image'}
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
          <div className="beranda-inspection-controls" aria-label="Kontrol inspeksi kandidat">
            <label>
              <span>Zoom</span>
              <input
                type="range"
                min="50"
                max="200"
                step="25"
                value={canvasZoom}
                aria-label="Zoom kanvas"
                onChange={(event) => setCanvasZoom(Number(event.target.value))}
              />
              <span aria-live="off">{canvasZoom}%</span>
            </label>
            <div role="group" aria-label="Latar inspeksi">
              {(['light', 'dark', 'checker'] as const).map((background) => (
                <button
                  type="button"
                  key={background}
                  aria-label={background === 'light' ? 'Latar terang' : background === 'dark' ? 'Latar gelap' : 'Latar kotak-kotak'}
                  aria-pressed={inspectionBackground === background}
                  onClick={() => setInspectionBackground(background)}
                >
                  {background === 'light' ? 'Terang' : background === 'dark' ? 'Gelap' : 'Kotak'}
                </button>
              ))}
            </div>
          </div>
          <div
            className={`beranda-stage ${hasImage ? 'beranda-stage-loaded' : ''}`}
            data-testid="canvas-stage"
            data-has-image={hasImage ? 'true' : 'false'}
            data-zoom={canvasZoom}
            data-inspection-background={inspectionBackground}
          >
            {hasImage && canvasImage ? (
              <>
                <img
                  src={canvasImage.url}
                  alt={canvasImage.width !== null && canvasImage.height !== null
                    ? `Hasil generate ${canvasImage.width} × ${canvasImage.height} px`
                    : 'Revisi terpilih dari proyek lokal'}
                  {...(canvasImage.width === null ? {} : { width: canvasImage.width })}
                  {...(canvasImage.height === null ? {} : { height: canvasImage.height })}
                  className="beranda-stage-art"
                  style={{ transform: `scale(${canvasZoom / 100})` }}
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
                  {canvasImage.width !== null && canvasImage.height !== null
                    ? `Unduh hasil (${canvasImage.width} × ${canvasImage.height} px)`
                    : 'Unduh revisi terpilih'}
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
            {projectRevisions.length === 0 ? (
              <p>{t.kandidatEmpty}</p>
            ) : (
              <div className="beranda-kandidat-strip" role="listbox" aria-label={t.backend === 'Backend' ? 'Riwayat revisi proyek' : 'Project revision history'}>
                {projectRevisions.map((entry) => {
                  const key = `${entry.assetId}/${entry.revision}`
                  const selected = key === selectedRevisionKey
                  return (
                    <button
                      type="button"
                      key={key}
                      role="option"
                      aria-selected={selected}
                      data-testid={`kandidat-${entry.assetId}-rev-${entry.revision}`}
                      data-revision={`rev-${entry.revision}`}
                      aria-label={`Asset ${entry.assetId}, rev-${entry.revision}`}
                      data-master={masterRevisionKey === key ? 'true' : 'false'}
                      onClick={() => {
                        setSelectedRevisionKey(key)
                        setMetadataReviewed(false)
                        // Kontinuitas berasal dari pilihan eksplisit pengguna:
                        // asset dari revisi yang dipilih menjadi target
                        // regeneration berikutnya, bukan tebakan sesi lama.
                        setActiveAssetId(entry.assetId)
                        const preview = revisionPreviews[key]
                        if (preview) {
                          setCanvasImage({
                            url: preview,
                            width: null,
                            height: null,
                            revokeOnReplace: false,
                          })
                          setHasImage(true)
                          setArtifactExpiresAt(null)
                        }
                        // Bukti audit harus terikat pada revisi yang dipilih.
                        // Sampai evidence revisi itu dimuat/diulang, gate tetap fail-closed.
                        setAuditLifecycle('STALE')
                      }}
                      title={entry.relativePath}
                    >
                      {revisionPreviews[key] ? (
                        <img src={revisionPreviews[key]} alt="" className="beranda-kandidat-thumb" />
                      ) : (
                        <span className="beranda-kandidat-placeholder" aria-hidden="true">Tanpa preview</span>
                      )}
                      <strong>rev-{entry.revision}</strong>
                    </button>
                  )
                })}
              </div>
            )}
            <div className="beranda-master-selection">
              <p className="beranda-note">Tombol ini aktif setelah ada minimal satu hasil generate: pilih revisi, lalu kunci sebagai master.</p>
              <button
                type="button"
                className="beranda-primary"
                disabled={selectedRevisionKey === null || masterSelectionBusy}
                onClick={() => void handleSetMasterRevision()}
              >
                {masterSelectionBusy ? 'Locking master…' : 'Lock this image as master'}
              </button>
              <p role="status" aria-label="Master revisi">
                {masterSelectionMessage ?? (masterRevisionKey === null
                  ? (projectRevisions.length === 0
                    ? 'Belum ada revisi — generate gambar untuk mengunci master.'
                    : 'Master belum dipilih — pilih secara eksplisit.')
                  : `Master: rev-${masterRevisionKey.split('/').at(-1)} · tersimpan`)}
              </p>
              <button type="button" className="beranda-toolbar-button" disabled={masterRevisionKey === null} onClick={() => setWorkPage('prepare')}>Prepare this image</button>
            </div>
          </div>
        </section>

      </div>
      )}

      {workPage === 'prepare' && (
        <section className="beranda-prepare" role="region" aria-label="Prepare selected image">
          <aside className="beranda-prepare-audit">
            <h2>Audit gambar</h2>
            <ul>
              <li>{masterRevisionKey ? '✓ Gambar master sudah dipilih' : '○ Pilih gambar master di Create'}</li>
              <li>{prompt.trim() ? '✓ Batasan stok dari prompt tercatat' : '○ Prompt belum tercatat'}</li>
              <li>{auditLifecycle === 'PASS' ? '✓ Audit internal selesai' : `○ Audit internal: ${auditLifecycle}`}</li>
            </ul>
            <p>Adobe-ready berarti lolos gerbang internal Gandiwa, bukan jaminan penerimaan Adobe Stock.</p>
            <section className="beranda-audit-lifecycle" aria-label="Audit revisi aktif">
              <strong>{auditLifecycle === 'EMPTY'
                ? 'Belum ada revisi untuk diaudit'
                : `${auditLifecycle} — export ${auditLifecycle === 'PASS' ? 'menunggu approval' : 'BLOCKED'}`}</strong>
              <p>{auditMessage ?? (auditLifecycle === 'STALE'
                ? 'Master menunggu preflight terikat asset, revision, checksum metadata, dan ruleset.'
                : auditLifecycle === 'EMPTY'
                  ? 'Pilih dan kunci master sebelum menjalankan audit.'
                  : `Durable audit ${auditLifecycle} terikat master terpilih.`)}</p>
              {durableAudit?.findings.map((finding) => (
                <p key={finding.ruleId} className="beranda-note"><strong>{finding.verdict}</strong> · {finding.ruleId} — {finding.message}</p>
              ))}
              <button type="button" className="beranda-toolbar-button" disabled={auditBusy || loadedMetadata === null || masterRevisionKey === null} onClick={() => void handleRunAudit()}>{auditBusy ? 'Menjalankan audit…' : 'Jalankan preflight revisi'}</button>
              {loadedMetadata === null && <p className="beranda-note">Simpan metadata valid master terlebih dahulu sebelum audit.</p>}
            </section>
          </aside>
          <section className="beranda-prepare-master" aria-label="Gambar master">
            <h2>Gambar master</h2>
            <div className={`beranda-stage ${masterPreviewUrl ? 'beranda-stage-loaded' : ''}`} data-testid="prepare-master-stage" data-master-revision={masterRevisionKey ?? ''}>
              {masterPreviewUrl ? <img src={masterPreviewUrl} alt="Gambar master terpilih" className="beranda-stage-art" /> : <p className="beranda-stage-empty">Preview master tersedia setelah revisi master dibaca dari proyek lokal.</p>}
            </div>
          </section>
          <section className="beranda-prepare-metadata" aria-label="Metadata selected image">
            <h2>Title, keywords, dan description</h2>
            <div className="beranda-metadata-actions" aria-label="Bantuan metadata AI">
              <button type="button" className="beranda-toolbar-button" disabled title="Generator metadata belum terhubung pada purwarupa rev3">Generate title — belum tersedia</button>
              <button type="button" className="beranda-toolbar-button" disabled title="Generator metadata belum terhubung pada purwarupa rev3">Generate keywords — belum tersedia</button>
              <button type="button" className="beranda-toolbar-button" disabled title="Generator metadata belum terhubung pada purwarupa rev3">Generate metadata — belum tersedia</button>
            </div>
            <label className="beranda-field"><span>{t.judul}</span><input aria-label={t.judul} value={title} onChange={(event) => { setTitle(event.target.value); setMetadataReviewed(false) }} placeholder={t.judulPlaceholder} /></label>
            <label className="beranda-field"><span>{t.keywords}</span><textarea aria-label={t.keywords} rows={4} value={keywords} onChange={(event) => { setKeywords(event.target.value); setMetadataReviewed(false) }} placeholder={t.keywordsPlaceholder} /></label>
            <label className="beranda-field"><span>Description</span><textarea aria-label="Description" rows={4} value={aiDisclosure} onChange={(event) => { setAiDisclosure(event.target.value); setMetadataReviewed(false) }} placeholder="Describe only what is visible in the selected image." /></label>
            <label className="beranda-field"><span>Kategori</span><input aria-label="Kategori metadata" value={metadataCategory} disabled={metadataBusy} onChange={(event) => { setMetadataCategory(event.target.value); setMetadataReviewed(false) }} placeholder="Contoh: Objects" /></label>
            <label className="beranda-field"><span>Disclosure AI</span><input aria-label="Disclosure AI" value={aiDisclosure} disabled={metadataBusy} onChange={(event) => { setAiDisclosure(event.target.value); setMetadataReviewed(false) }} placeholder="Created with generative AI." /></label>
            <label className="beranda-field"><span>Status release</span><select aria-label="Status release" value={releaseStatus} disabled={metadataBusy} onChange={(event) => { setReleaseStatus(event.target.value as ReleaseStatus); setMetadataReviewed(false) }}><option value="not_required">Tidak diperlukan</option><option value="attached">Terlampir</option><option value="needs_review">Perlu review</option></select></label>
            <button type="button" className="beranda-toolbar-button" disabled={metadataBusy} onClick={() => void handleSaveMetadata()}>{metadataBusy ? 'Menyimpan metadata…' : 'Simpan metadata revisi'}</button>
            <label className="beranda-review"><input type="checkbox" checked={metadataReviewed} onChange={(event) => setMetadataReviewed(event.target.checked)} /> I reviewed the title, keywords, and description for this selected image.</label>
            <button type="button" className="beranda-primary beranda-download-ready" disabled title="Paket unduhan belum terhubung pada purwarupa rev3">Download ready — belum tersedia</button>
            <p className="beranda-note">Paket unduhan belum terhubung pada purwarupa rev3; tombol tetap terkunci dan tidak mengunduh gambar atau mengirim ke Adobe.</p>
            {metadataMessage && <p role="status" className="beranda-note">{metadataMessage}</p>}
          </section>
        </section>
      )}

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
            className="beranda-dialog beranda-settings-desk"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="beranda-settings-mast">
              <div className="beranda-settings-mast-head">
                <h2>{t.settingsTitle}</h2>
                <button
                  type="button"
                  className="beranda-chip"
                  onClick={() => setSettingsOpen(false)}
                  aria-label={lang === 'id' ? 'Tutup setelan' : 'Close settings'}
                >✕</button>
              </div>
              <p className="beranda-settings-purpose">
                {lang === 'id'
                  ? 'Bahasa antarmuka dan bentuk koneksi AI. Purwarupa ini tidak menyimpan kunci atau menghubungi provider.'
                  : 'Interface language and AI connection forms. This prototype does not store keys or contact providers.'}
              </p>
              <ul className="beranda-settings-live">
                <li>
                  <i aria-hidden="true" className={`beranda-settings-dot${status && status.backend.health === 'ok' ? ' beranda-settings-dot-ok' : ' beranda-settings-dot-warn'}`} />
                  <span>{t.backend}</span>
                  <b>{status ? status.backend.health : '…'}</b>
                </li>
                {providerRows.map((provider) => (
                  <li key={provider.provider}>
                    <i aria-hidden="true" className={`beranda-settings-dot${provider.configured ? ' beranda-settings-dot-ok' : ' beranda-settings-dot-warn'}`} />
                    <span>{providerLabel(provider.provider)}</span>
                    <b>{provider.configured ? t.keyConfigured : t.noKey}</b>
                  </li>
                ))}
              </ul>
            </div>
            <div className="beranda-settings-ledger">
              <section aria-labelledby="beranda-settings-lang">
                <h4 id="beranda-settings-lang">{t.language}</h4>
                <label className="beranda-radio">
                  <input type="radio" name="beranda-lang" onChange={() => changeLang(navigator.language.toLowerCase().startsWith('id') ? 'id' : 'en')} />
                  <span>Ikuti bahasa perangkat</span>
                </label>
                <label className="beranda-radio">
                  <input type="radio" name="beranda-lang" checked={lang === 'id'} onChange={() => changeLang('id')} />
                  <span>Bahasa Indonesia</span>
                </label>
                <label className="beranda-radio">
                  <input type="radio" name="beranda-lang" checked={lang === 'en'} onChange={() => changeLang('en')} />
                  <span>English</span>
                </label>
              </section>
              <section aria-labelledby="beranda-settings-keys">
                <h4 id="beranda-settings-keys">Koneksi purwarupa</h4>
                <p className="beranda-note">Setelan ini hanya memeriksa kelengkapan isian di perangkat. Belum menyimpan kunci, menghubungi API, atau mengubah provider pekerjaan yang sedang berjalan.</p>
                <section className="beranda-api-role" aria-label="Image provider">
                  <div className="beranda-api-role-head"><strong>Image provider</strong><span>untuk halaman Create</span></div>
                  <label className="beranda-field"><span>Provider</span>
                    <select aria-label="Provider gambar" value={imageConnectionKind} onChange={(event) => setImageConnectionKind(event.target.value as 'fal' | 'openai' | 'self')}>
                      <option value="fal">fal.ai</option>
                      <option value="openai">OpenAI-compatible</option>
                      <option value="self">Custom provider</option>
                    </select>
                  </label>
                  {imageConnectionKind === 'fal' ? (
                    <ProviderKeyRow provider="fal" label="fal.ai" value={newFalKey} onChange={setNewFalKey} configured={providerRows.find((entry) => entry.provider === 'fal')?.configured === true} validateProviderKey={validateProviderKey} testing={testingProvider === 'fal'} keyTest={keyTest} t={t} />
                  ) : (
                    <LocalConnectionFields name={imageConnectionName} setName={setImageConnectionName} prefix={imageConnectionPrefix} setPrefix={setImageConnectionPrefix} apiType={imageApiType} setApiType={setImageApiType} baseUrl={imageBaseUrl} setBaseUrl={setImageBaseUrl} modelId={imageModelId} setModelId={setImageModelId} />
                  )}
                </section>
                <section className="beranda-api-role" aria-label="Reasoning and metadata provider">
                  <div className="beranda-api-role-head"><strong>Reasoning / metadata provider</strong><span>untuk bantu prompt &amp; metadata</span></div>
                  <label className="beranda-field"><span>Provider</span>
                    <select aria-label="Provider reasoning dan metadata" value={reasoningProvider} onChange={(event) => setReasoningProvider(event.target.value)}>
                      <option value="anthropic">Anthropic-compatible</option>
                      <option value="openai">OpenAI-compatible</option>
                    </select>
                  </label>
                  <LocalConnectionFields name="" setName={() => undefined} prefix="" setPrefix={() => undefined} apiType={reasoningApiType} setApiType={setReasoningApiType} baseUrl={reasoningBaseUrl} setBaseUrl={setReasoningBaseUrl} modelId={reasoningModelId} setModelId={setReasoningModelId} compact />
                </section>
              </section>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
