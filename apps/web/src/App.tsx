import { useCallback, useEffect, useRef, useState } from 'react'

import type { ContentType, CreationMethod } from '@gandiwa/contracts'

import { preflightRaster, type RasterPreflightReport } from './raster-preflight'
import { preflightSvg, type SvgPreflightReport } from './svg-preflight'
import { buildAuditCenter, fileAuditIdentity, verdictForFinding, type AuditCenterResult } from './audit-center'
import { browserEncodeJpeg, prepareRasterForSubmission } from './raster-preparation'
import { assessStockMetadata, type AssetProvenance, type StockMetadataDraft } from './stock-metadata'
import { loadStockMetadata, saveStockMetadata, supportsMetadataWrite, type LoadedStockMetadata } from './stock-metadata-store'
import { loadDurableAudit, saveDurableAudit } from './durable-audit-store'
import { loadApproval, saveApproval, type LoadedApproval } from './approval-store'
import { resolveApprovalSubmission, type ApprovalSubmission, type SubmissionDirectory } from './approval-submission'
import { evaluateApprovalGate, type ApprovalGateResult, type DurableAuditSnapshot, type ApprovalRecord } from './approval-gate'
import type { AuditDirectory } from './durable-audit-store'
import { resolveExportPackageCandidate, writeExportPackage, type ExportPackageCandidate } from './export-package'
import { getGuidedWorkflowPresentation, type GuidedWorkflowInput } from './workflow/guided-workflow'
import {
  clearSelectedInstance,
  fetchProviderOptions,
  persistSelectedInstance,
  resolveSelectedInstance,
  type ProviderOption,
} from './assistant/router-selection'
import { GuidedWorkflowShell } from './components/workflow/GuidedWorkflowShell'

const AUDIT_RULESET_ID = 'adobe-stock-2026-09-08-v1'
const AUDIT_RULESET_VERSION = AUDIT_RULESET_ID

export function isCurrentPreflight(requestId: number, currentSequence: number): boolean {
  return requestId === currentSequence
}

export function isCurrentProjectPreflight(requestId: number, currentSequence: number, expectedProject: unknown, activeProject: unknown): boolean {
  return requestId === currentSequence && expectedProject === activeProject
}

export function isCurrentExport(operationId: number, currentSequence: number, expectedProject: unknown, activeProject: unknown): boolean {
  return operationId === currentSequence && expectedProject === activeProject
}

export function isSameApprovalEvidence(left: Readonly<{ submissionChecksum: string; metadataChecksum: string }>, right: Readonly<{ submissionChecksum: string; metadataChecksum: string }>): boolean {
  return left.submissionChecksum === right.submissionChecksum && left.metadataChecksum === right.metadataChecksum
}

function auditFromSvgReport(report: SvgPreflightReport, identity: Readonly<{ revisionId: string; checksum: string }>): AuditCenterResult {
  return buildAuditCenter({
    assetRevisionId: identity.revisionId,
    assetChecksum: identity.checksum,
    rulesetId: AUDIT_RULESET_ID,
    rulesetVersion: AUDIT_RULESET_VERSION,
    findings: report.findings.map((finding) => ({
      ruleId: finding.rule_id,
      verdict: verdictForFinding(finding.rule_id, report.verdict),
      message: finding.message,
      evidence: { source: 'SVG technical preflight', ruleId: finding.rule_id, message: finding.message },
    })),
  })
}

function auditFromRasterReport(report: RasterPreflightReport, identity: Readonly<{ revisionId: string; checksum: string }>): AuditCenterResult {
  return buildAuditCenter({
    assetRevisionId: identity.revisionId,
    assetChecksum: identity.checksum,
    rulesetId: AUDIT_RULESET_ID,
    rulesetVersion: AUDIT_RULESET_VERSION,
    findings: report.findings.map((finding) => ({
      ruleId: finding.rule_id,
      verdict: verdictForFinding(finding.rule_id, report.verdict),
      message: finding.message,
      evidence: {
        source: 'Raster technical preflight',
        ruleId: finding.rule_id,
        message: finding.message,
        detectedMimeType: report.detected_mime_type,
        width: report.width,
        height: report.height,
        megapixels: report.megapixels,
      },
    })),
  })
}

export function ApprovalGatePanel({
  gate,
  asset: assetContext,
  audit,
  submission,
  metadataValid,
  metadataChecksum,
  auditChecksum,
  busy,
  message,
  onAudit,
  onApprove,
  mode = 'both',
}: {
  gate: ApprovalGateResult
  asset: Readonly<{ assetId: string; revision: number }> | null
  audit: DurableAuditSnapshot | null
  submission: ApprovalSubmission | null
  metadataValid: boolean
  metadataChecksum: string | null
  auditChecksum: string | null
  busy: boolean
  message: string | null
  onAudit: () => void
  onApprove: () => void
  mode?: 'audit' | 'approval' | 'both'
}) {
  return (
    <section className="audit-center" aria-label="Approval and Adobe-ready gate">
      <p className="eyebrow">APPROVAL & ADOBE-READY</p>
      <div className="audit-summary">
        <strong>{gate.status}</strong>
        <span>Export gate: {gate.exportGate}</span>
      </div>
      <p className="audit-context">Target: latest asset’s latest prepared revision (selected automatically for this MVP).</p>
      {assetContext ? <p className="audit-context">Asset <code>{assetContext.assetId}</code> · revision <code>{assetContext.revision}</code>{submission ? <> · checksum <code>{submission.submissionChecksum}</code></> : null}</p> : null}
      <p className="audit-context">
        Metadata checksum <code>{metadataChecksum ?? 'unavailable'}</code><br />
        Audit checksum <code>{auditChecksum ?? 'unavailable'}</code><br />
        Ruleset <code>{audit?.rulesetId ?? 'unavailable'}</code> · version <code>{audit?.rulesetVersion ?? 'unavailable'}</code>
      </p>
      {gate.reasons.length > 0 ? <ul className="audit-findings"><li><span>{gate.reasons.join(' ')}</span></li></ul> : null}
      {audit && audit.findings.length > 0 ? <ul className="audit-findings">{audit.findings.map((finding) => <li key={finding.ruleId}><strong><code>{finding.ruleId}</code> · {finding.verdict}</strong><span>{finding.message}</span><small>Evidence: {JSON.stringify(finding.evidence)}</small></li>)}</ul> : null}
      <p className="helper">Adobe-ready berarti gate Gandiwa lolos; ini bukan jaminan Adobe Stock akan menerima submission.</p>
      {message ? <p className="project-result" role="status">{message}</p> : null}
      <div className="dialog-actions">
        {(mode === 'audit' || mode === 'both') ? <button className="button button-secondary" disabled={busy || !assetContext || !submission || !metadataValid} onClick={onAudit}>{busy ? 'Auditing revision…' : 'Audit prepared revision'}</button> : null}
        {(mode === 'approval' || mode === 'both') ? <button className="button button-primary" disabled={busy || gate.status !== 'READY FOR HUMAN APPROVAL'} onClick={onApprove}>I confirm this revision for manual Adobe Stock submission</button> : null}
      </div>
    </section>
  )
}

function AuditCenterPanel({ audit }: { audit: AuditCenterResult }) {
  return (
    <section className="audit-center" aria-label="Audit Center">
      <p className="eyebrow">AUDIT CENTER</p>
      <div className="audit-summary" role="status" aria-label={audit.ariaLabel}>
        <strong>{audit.statusLabel}</strong>
        <span>Export gate: {audit.exportGate}</span>
      </div>
      <p className="audit-context">
        Ruleset <code>{audit.ruleset.id}</code> · version <code>{audit.ruleset.version}</code><br />
        Revision <code>{audit.asset.revisionId}</code> · checksum <code>{audit.asset.checksum}</code>
      </p>
      {audit.staleReason ? <p className="audit-stale" role="alert">{audit.staleReason} Run preflight again.</p> : null}
      {audit.findings.length > 0 ? (
        <ul className="audit-findings">
          {audit.findings.map((finding, index) => (
            <li key={`${finding.ruleId}-${index}`}>
              <strong><code>{finding.ruleId}</code> · {finding.verdict}</strong>
              <span>{finding.message}</span>
              <small>Evidence: {JSON.stringify(finding.evidence)}</small>
              <small>Remediation: {finding.remediation}</small>
            </li>
          ))}
        </ul>
      ) : <p className="audit-clear">No deterministic findings. Audit evidence is clear.</p>}
    </section>
  )
}

import {
  browserProjectCreationDependencies,
  createProject,
  type ProjectCreationResult,
} from './project-filesystem'
import {
  browserProjectLifecycleDependencies,
  detectExternalManifestChange,
  loadRememberedProject,
  openProject,
  requestProjectWritePermission,
  reopenProjectFromUserGesture,
  type DirectoryHandleLike,
  type OpenProjectResult,
} from './project-lifecycle'

type RuntimeStatus = {
  version: string
  mvp_version: string
  backend: { health: string; ready: boolean; checks: Record<string, boolean> }
  worker: { status: 'idle' | 'running' | 'stopped' | 'unavailable'; heartbeat_at: string | null }
}

type CreateProjectForm = {
  projectName: string
  contentType: ContentType
  creationMethod: CreationMethod
}

type ActiveProject = Extract<OpenProjectResult, { kind: 'opened' }>

export function sameExportCandidate(left: ExportPackageCandidate, right: ExportPackageCandidate): boolean {
  return left.assetId === right.assetId && left.revision === right.revision
    && left.submissionChecksum === right.submissionChecksum
    && left.metadataChecksum === right.metadataChecksum
    && left.auditChecksum === right.auditChecksum
    && left.approvalChecksum === right.approvalChecksum
}

function exportDirectory(project: ActiveProject): import('./export-package').ExportDirectory {
  return project.directory as unknown as import('./export-package').ExportDirectory
}

type ExternalManifestDecision = Readonly<{ source: ActiveProject; external: ActiveProject }>

function isSameActiveProject(left: ActiveProject | null, right: ActiveProject): boolean {
  return left?.directory === right.directory && left.manifestSnapshot === right.manifestSnapshot
}

const DEFAULT_CREATE_PROJECT_FORM: CreateProjectForm = {
  projectName: '',
  contentType: 'illustration',
  creationMethod: 'generative_ai',
}

const DEFAULT_STOCK_METADATA: StockMetadataDraft = {
  schemaVersion: 1,
  title: '',
  keywords: [],
  category: '',
  contentType: 'illustration',
  creationMethod: 'generative_ai',
  generatedWithAi: false,
  aiDisclosure: '',
  releaseStatus: 'not_required',
}

async function fetchStatus(): Promise<RuntimeStatus> {
  const response = await fetch('/api/v1/status', {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`Backend status request failed (${response.status})`)
  return response.json() as Promise<RuntimeStatus>
}

function projectMessage(result: ProjectCreationResult): string {
  if (result.kind === 'created') return `Project “${result.projectName}” created locally.${result.reopenWarning ? ` ${result.reopenWarning}` : ''}`
  if (result.kind === 'cancelled') return 'Project creation cancelled.'
  return result.message
}

export function App() {
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [routerInstances, setRouterInstances] = useState<ProviderOption[] | null>(null)
  const [routerInstance, setRouterInstance] = useState<string | null>(null)
  const [routerMessage, setRouterMessage] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [isCreateDialogOpen, setCreateDialogOpen] = useState(false)
  const [createForm, setCreateForm] = useState<CreateProjectForm>(DEFAULT_CREATE_PROJECT_FORM)
  const [isCreating, setCreating] = useState(false)
  const [creationMessage, setCreationMessage] = useState<string | null>(null)
  const [activeProject, setActiveProject] = useState<ActiveProject | null>(null)
  const [externalManifestDecision, setExternalManifestDecision] = useState<ExternalManifestDecision | null>(null)
  const [rememberedDirectory, setRememberedDirectory] = useState<DirectoryHandleLike | null>(null)
  const [isOpening, setOpening] = useState(false)
  const [rasterContentType, setRasterContentType] = useState<Exclude<ContentType, 'vector'>>('photo')
  const [rasterReport, setRasterReport] = useState<RasterPreflightReport | null>(null)
  const [rasterMessage, setRasterMessage] = useState<string | null>(null)
  const [isPreflightingRaster, setPreflightingRaster] = useState(false)
  const [isPreparingRaster, setPreparingRaster] = useState(false)
  const [preparationMessage, setPreparationMessage] = useState<string | null>(null)
  const [svgContentType, setSvgContentType] = useState<Extract<ContentType, 'illustration' | 'vector'>>('vector')
  const [svgReport, setSvgReport] = useState<SvgPreflightReport | null>(null)
  const [svgMessage, setSvgMessage] = useState<string | null>(null)
  const [isPreflightingSvg, setPreflightingSvg] = useState(false)
  const [auditReport, setAuditReport] = useState<AuditCenterResult | null>(null)
  const [durableAudit, setDurableAudit] = useState<DurableAuditSnapshot | null>(null)
  const [durableAuditSnapshot, setDurableAuditSnapshot] = useState<string | undefined>(undefined)
  const [durableAuditChecksum, setDurableAuditChecksum] = useState<string | null>(null)
  const [approval, setApproval] = useState<LoadedApproval | null>(null)
  const [previousApprovalSnapshot, setPreviousApprovalSnapshot] = useState<string | undefined>(undefined)
  const [approvalSubmission, setApprovalSubmission] = useState<ApprovalSubmission | null>(null)
  const [approvalGate, setApprovalGate] = useState<ApprovalGateResult>({ status: 'NOT READY', adobeReady: false, exportGate: 'BLOCKED', reasons: ['No active asset revision exists.'] })
  const [approvalMessage, setApprovalMessage] = useState<string | null>(null)
  const [isApprovalBusy, setApprovalBusy] = useState(false)
  const [isExporting, setExporting] = useState(false)
  const [exportMessage, setExportMessage] = useState<string | null>(null)
  const [stockMetadata, setStockMetadata] = useState<StockMetadataDraft>(DEFAULT_STOCK_METADATA)
  const [loadedMetadata, setLoadedMetadata] = useState<LoadedStockMetadata | null>(null)
  const [metadataMessage, setMetadataMessage] = useState<string | null>(null)
  const [isSavingMetadata, setSavingMetadata] = useState(false)
  const [inspectorView, setInspectorView] = useState<'inspector' | 'project-files' | 'audit-history'>('inspector')
  const activeProjectRef = useRef<ActiveProject | null>(null)
  const requestSequence = useRef(0)
  const preflightSequence = useRef(0)
  const approvalContextSequence = useRef(0)
  const approvalOperationSequence = useRef(0)
  const exportOperationSequence = useRef(0)
  const createProjectOpenerRef = useRef<HTMLButtonElement>(null)
  const externalChangeCheckerRef = useRef<HTMLButtonElement>(null)
  const externalManifestReloadRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (externalManifestDecision) externalManifestReloadRef.current?.focus()
  }, [externalManifestDecision])

  const refresh = useCallback(async () => {
    const requestId = ++requestSequence.current
    setLoading(true)
    try {
      const next = await fetchStatus()
      if (requestId === requestSequence.current) {
        setRuntime(next)
        setError(null)
      }
    } catch (cause) {
      if (requestId === requestSequence.current) {
        setRuntime(null)
        setError(cause instanceof Error ? cause.message : 'Unable to reach the Gandiwa backend.')
      }
    } finally {
      if (requestId === requestSequence.current) setLoading(false)
    }
  }, [])

  // Instance options are fetched once on mount; the selection itself is human-owned.
  const routerSequence = useRef(0)
  useEffect(() => {
    const requestId = ++routerSequence.current
    fetchProviderOptions()
      .then((instances) => {
        // Only the human's explicit stored choice is restored; never auto-pick.
        setRouterInstances(instances)
        setRouterInstance(resolveSelectedInstance(instances))
      })
      .catch(() => {
        if (requestId === routerSequence.current) setRouterInstances(null)
      })
  }, [])

  useEffect(() => {
    void refresh()
    const id = window.setInterval(() => void refresh(), 5000)
    return () => {
      window.clearInterval(id)
      requestSequence.current += 1
    }
  }, [refresh])

  useEffect(() => {
    setRasterReport(null)
    setAuditReport(null)
  }, [rasterContentType])

  useEffect(() => {
    setSvgReport(null)
    setAuditReport(null)
  }, [svgContentType])

  useEffect(() => {
    let cancelled = false
    void loadRememberedProject()
      .then((directory) => {
        if (!cancelled) setRememberedDirectory(directory ?? null)
      })
      .catch(() => {
        if (!cancelled) setRememberedDirectory(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const closeCreateDialog = () => {
    createProjectOpenerRef.current?.focus()
    setCreateDialogOpen(false)
  }

  const openCreateDialog = () => {
    setCreationMessage(null)
    setCreateDialogOpen(true)
  }

  const handleCreateDialogKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' && !isCreating) {
      event.preventDefault()
      closeCreateDialog()
      return
    }
    if (event.key !== 'Tab') return

    const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled])')]
    const first = focusable[0]
    const last = focusable.at(-1)
    if (!first || !last) return
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const submitCreateProject = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setCreating(true)
    try {
      const result = await createProject(createForm, browserProjectCreationDependencies())
      setCreationMessage(projectMessage(result))
      if (result.kind === 'created') {
        try {
          setRememberedDirectory((await loadRememberedProject()) ?? null)
        } catch {
          setRememberedDirectory(null)
        }
        closeCreateDialog()
      } else if (result.kind === 'cancelled') {
        closeCreateDialog()
      }
    } catch (cause) {
      setCreationMessage(cause instanceof Error ? cause.message : 'Unable to create the project. No project was created.')
    } finally {
      setCreating(false)
    }
  }

  const refreshApprovalContext = async (project: ActiveProject, metadata: LoadedStockMetadata | null = loadedMetadata) => {
    const contextId = ++approvalContextSequence.current
    const asset = project.manifest.assets.at(-1)
    const revision = asset?.revisions.at(-1)
    if (!asset || !revision || !metadata) {
      setApprovalSubmission(null)
      setDurableAudit(null)
      setDurableAuditSnapshot(undefined)
      setDurableAuditChecksum(null)
      setApproval(null)
      setApprovalGate({ status: 'NOT READY', adobeReady: false, exportGate: 'BLOCKED', reasons: ['A prepared revision and valid metadata are required.'] })
      return
    }
    try {
      const directory = project.directory as unknown as SubmissionDirectory & AuditDirectory
      const submission = await resolveApprovalSubmission({ directory, manifest: project.manifest, manifestSnapshot: project.manifestSnapshot, assetId: asset.asset_id, revision: revision.revision })
      const savedAudit = await loadDurableAudit(directory, asset.asset_id, revision.revision)
      const savedApproval = await loadApproval(directory, asset.asset_id, revision.revision)
      if (activeProjectRef.current !== project || contextId !== approvalContextSequence.current) return
      setApprovalSubmission(submission)
      setDurableAudit(savedAudit?.audit ?? null)
      setDurableAuditSnapshot(savedAudit?.snapshot)
      setDurableAuditChecksum(savedAudit?.checksum ?? null)
      setApproval(savedApproval ?? null)
      setPreviousApprovalSnapshot(savedApproval?.snapshot)
      setApprovalGate(evaluateApprovalGate({
        assetId: submission.assetId,
        revision: submission.revision,
        submissionChecksum: submission.submissionChecksum,
        metadataChecksum: submission.metadataChecksum,
        auditChecksum: savedAudit?.checksum ?? '',
        rulesetId: AUDIT_RULESET_ID,
        rulesetVersion: AUDIT_RULESET_VERSION,
        metadataValid: true,
        ...(savedAudit ? { audit: savedAudit.audit } : {}),
        ...(savedApproval ? { approval: savedApproval.record } : {}),
      }))
    } catch (cause) {
      if (activeProjectRef.current !== project || contextId !== approvalContextSequence.current) return
      setApprovalSubmission(null)
      setDurableAudit(null)
      setDurableAuditSnapshot(undefined)
      setDurableAuditChecksum(null)
      setApproval(null)
      setApprovalGate({ status: 'NOT READY', adobeReady: false, exportGate: 'BLOCKED', reasons: [cause instanceof Error ? cause.message : 'Approval evidence could not be loaded.'] })
    }
  }

  const auditPreparedRevision = async () => {
    const project = activeProjectRef.current
    const asset = project?.manifest.assets.at(-1)
    const revision = asset?.revisions.at(-1)
    if (!project || !asset || !revision || !approvalSubmission || !loadedMetadata) return
    setApprovalBusy(true)
    setApprovalMessage(null)
    const requestId = ++preflightSequence.current
    try {
      if (!(await requestProjectWritePermission(project.directory))) throw new Error('Write permission was not granted. Audit was not saved.')
      const report = revision.submission_format === 'svg'
        ? await preflightSvg(approvalSubmission.file, asset.content_type === 'vector' ? 'vector' : 'illustration')
        : await preflightRaster(approvalSubmission.file, asset.content_type === 'vector' ? 'photo' : asset.content_type)
      if (!isCurrentProjectPreflight(requestId, preflightSequence.current, project, activeProjectRef.current)) return
      const findings = report.findings.map((finding) => ({ ruleId: finding.rule_id, verdict: verdictForFinding(finding.rule_id, report.verdict), message: finding.message, evidence: { source: revision.submission_format === 'svg' ? 'SVG security preflight' : 'Raster technical preflight', ruleId: finding.rule_id, verdict: report.verdict, assetId: asset.asset_id, revision: revision.revision } }))
      const currentSubmission = await resolveApprovalSubmission({ directory: project.directory as unknown as SubmissionDirectory & AuditDirectory, manifest: project.manifest, manifestSnapshot: project.manifestSnapshot, assetId: asset.asset_id, revision: revision.revision })
      if (!isCurrentProjectPreflight(requestId, preflightSequence.current, project, activeProjectRef.current)) return
      if (!isSameApprovalEvidence(approvalSubmission, currentSubmission)) throw new Error('Prepared revision or metadata changed during audit. Run audit again.')
      const snapshot: DurableAuditSnapshot = { schemaVersion: 1, assetId: asset.asset_id, revision: revision.revision, submissionChecksum: currentSubmission.submissionChecksum, metadataChecksum: currentSubmission.metadataChecksum, rulesetId: AUDIT_RULESET_ID, rulesetVersion: AUDIT_RULESET_VERSION, findings, createdAt: new Date().toISOString() }
      if (!isCurrentProjectPreflight(requestId, preflightSequence.current, project, activeProjectRef.current)) return
      const saved = await saveDurableAudit({
        directory: project.directory as unknown as AuditDirectory,
        manifestSnapshot: project.manifestSnapshot,
        audit: snapshot,
        ...(durableAuditSnapshot !== undefined ? { sidecarSnapshot: durableAuditSnapshot } : {}),
        verifyCurrentEvidence: async () => {
          if (!isCurrentProjectPreflight(requestId, preflightSequence.current, project, activeProjectRef.current)) throw new Error('Audit request was superseded.')
          const finalSubmission = await resolveApprovalSubmission({ directory: project.directory as unknown as SubmissionDirectory & AuditDirectory, manifest: project.manifest, manifestSnapshot: project.manifestSnapshot, assetId: asset.asset_id, revision: revision.revision })
          if (!isSameApprovalEvidence(currentSubmission, finalSubmission)) throw new Error('Prepared revision or metadata changed during audit. Run audit again.')
        },
      })
      if (!isCurrentProjectPreflight(requestId, preflightSequence.current, project, activeProjectRef.current)) return
      setDurableAudit(saved.audit)
      setDurableAuditSnapshot(saved.snapshot)
      setDurableAuditChecksum(saved.checksum)
      setApproval(null)
      setPreviousApprovalSnapshot(approval?.snapshot ?? previousApprovalSnapshot)
      setApprovalGate(evaluateApprovalGate({ assetId: asset.asset_id, revision: revision.revision, submissionChecksum: approvalSubmission.submissionChecksum, metadataChecksum: approvalSubmission.metadataChecksum, auditChecksum: saved.checksum, rulesetId: AUDIT_RULESET_ID, rulesetVersion: AUDIT_RULESET_VERSION, metadataValid: true, audit: saved.audit }))
      setApprovalMessage('Durable audit snapshot saved. Human approval is still required.')
    } catch (cause) {
      if (isCurrentPreflight(requestId, preflightSequence.current)) setApprovalMessage(cause instanceof Error ? cause.message : 'Audit could not be saved.')
    } finally {
      if (isCurrentPreflight(requestId, preflightSequence.current)) setApprovalBusy(false)
    }
  }

  const approveCurrentRevision = async () => {
    const project = activeProjectRef.current
    const asset = project?.manifest.assets.at(-1)
    const revision = asset?.revisions.at(-1)
    if (!project || !asset || !revision || !durableAudit || !loadedMetadata || approvalGate.status !== 'READY FOR HUMAN APPROVAL') return
    setApprovalBusy(true)
    setApprovalMessage(null)
    const operationId = ++approvalOperationSequence.current
    const isCurrentApproval = () => operationId === approvalOperationSequence.current && activeProjectRef.current === project
    try {
      const directory = project.directory as unknown as SubmissionDirectory & AuditDirectory
      const submission = await resolveApprovalSubmission({ directory, manifest: project.manifest, manifestSnapshot: project.manifestSnapshot, assetId: asset.asset_id, revision: revision.revision })
      if (!isCurrentApproval()) return
      const loadedAudit = await loadDurableAudit(directory, asset.asset_id, revision.revision)
      if (!isCurrentApproval()) return
      if (!loadedAudit) throw new Error('Audit evidence changed or disappeared. Approval was blocked.')
      const currentGate = evaluateApprovalGate({ assetId: submission.assetId, revision: submission.revision, submissionChecksum: submission.submissionChecksum, metadataChecksum: submission.metadataChecksum, auditChecksum: loadedAudit.checksum, rulesetId: AUDIT_RULESET_ID, rulesetVersion: AUDIT_RULESET_VERSION, metadataValid: true, audit: loadedAudit.audit })
      if (currentGate.status !== 'READY FOR HUMAN APPROVAL') { setApprovalGate(currentGate); throw new Error('Approval evidence became stale. Run audit again.') }
      if (!(await requestProjectWritePermission(project.directory))) throw new Error('Write permission was not granted. Approval was not saved.')
      if (!isCurrentApproval()) return
      const currentSubmission = await resolveApprovalSubmission({ directory, manifest: project.manifest, manifestSnapshot: project.manifestSnapshot, assetId: asset.asset_id, revision: revision.revision })
      if (!isCurrentApproval()) return
      if (!isSameApprovalEvidence(submission, currentSubmission)) throw new Error('Prepared revision or metadata changed during approval. Run audit again.')
      const record: ApprovalRecord = { schemaVersion: 1, status: 'APPROVED', assetId: currentSubmission.assetId, revision: currentSubmission.revision, submissionChecksum: currentSubmission.submissionChecksum, metadataChecksum: currentSubmission.metadataChecksum, auditChecksum: loadedAudit.checksum, rulesetId: AUDIT_RULESET_ID, rulesetVersion: AUDIT_RULESET_VERSION, approvedAt: new Date().toISOString(), statementVersion: 1 }
      const saved = await saveApproval({ directory, manifestSnapshot: project.manifestSnapshot, metadataSnapshot: loadedMetadata.snapshot, auditSnapshot: loadedAudit.snapshot, record, ...(previousApprovalSnapshot !== undefined ? { existingSnapshot: previousApprovalSnapshot } : {}) })
      if (!isCurrentApproval()) return
      setApproval(saved)
      setPreviousApprovalSnapshot(saved.snapshot)
      setApprovalGate({ ...currentGate, status: 'APPROVED / ADOBE-READY', adobeReady: true, exportGate: 'CLEAR', reasons: [] })
      setApprovalMessage('Approval saved locally. This revision is eligible for manual submission.')
    } catch (cause) {
      setApprovalMessage(cause instanceof Error ? cause.message : 'Approval could not be saved.')
    } finally {
      setApprovalBusy(false)
    }
  }

  const handleExport = async () => {
    const project = activeProjectRef.current
    const asset = project?.manifest.assets.at(-1)
    const revision = asset?.revisions.at(-1)
    if (!project || !asset || !revision || approvalGate.exportGate !== 'CLEAR') return
    const operationId = ++exportOperationSequence.current
    const isCurrent = () => isCurrentExport(operationId, exportOperationSequence.current, project, activeProjectRef.current)
    setExporting(true)
    setExportMessage(null)
    try {
      const candidate = await resolveExportPackageCandidate({
        directory: exportDirectory(project),
        manifest: project.manifest,
        manifestSnapshot: project.manifestSnapshot,
        assetId: asset.asset_id,
        revision: revision.revision,
      })
      if (!isCurrent()) return
      if (candidate.gate.exportGate !== 'CLEAR') throw new Error('Export is blocked by current approval evidence.')
      const granted = await requestProjectWritePermission(project.directory)
      if (!isCurrent()) return
      if (!granted) throw new Error('Write permission was not granted. Export package was not written.')
      const current = await resolveExportPackageCandidate({
        directory: exportDirectory(project),
        manifest: project.manifest,
        manifestSnapshot: project.manifestSnapshot,
        assetId: asset.asset_id,
        revision: revision.revision,
      })
      if (!isCurrent()) return
      if (!sameExportCandidate(candidate, current)) throw new Error('Approval evidence changed before export. Run audit and approval again.')
      const result = await writeExportPackage({
        directory: exportDirectory(project),
        candidate: current,
        verifyCurrentEvidence: async () => {
          if (!isCurrent()) throw new Error('Export request was superseded. Completion marker was not written.')
          const latest = await resolveExportPackageCandidate({
            directory: exportDirectory(project),
            manifest: project.manifest,
            manifestSnapshot: project.manifestSnapshot,
            assetId: asset.asset_id,
            revision: revision.revision,
          })
          if (!isCurrent()) throw new Error('Export request was superseded. Completion marker was not written.')
          if (!sameExportCandidate(current, latest)) throw new Error('Approval evidence changed during export. Completion marker was not written.')
        },
      })
      if (!isCurrent()) return
      setExportMessage(`Export package “${result.packageName}” written locally. Completion marker verified.`)
    } catch (cause) {
      if (isCurrent()) setExportMessage(cause instanceof Error ? cause.message : 'Export package could not be written.')
    } finally {
      if (isCurrent()) setExporting(false)
    }
  }

  const receiveOpenResult = (result: OpenProjectResult) => {
    if (result.kind === 'opened') {
      preflightSequence.current += 1
      approvalContextSequence.current += 1
      approvalOperationSequence.current += 1
      exportOperationSequence.current += 1
      setExporting(false)
      setExportMessage(null)
      activeProjectRef.current = result
      setActiveProject(result)
      const latestAsset = result.manifest.assets.at(-1)
      const defaults = { ...DEFAULT_STOCK_METADATA, contentType: latestAsset?.content_type ?? 'illustration', creationMethod: latestAsset?.creation_method ?? 'generative_ai' }
      setStockMetadata(defaults)
      setLoadedMetadata(null)
      setMetadataMessage(null)
      if (latestAsset && supportsMetadataWrite(result.directory)) {
        void loadStockMetadata(result.directory, latestAsset.asset_id, { contentType: latestAsset.content_type, creationMethod: latestAsset.creation_method }).then((saved) => {
          if (activeProjectRef.current === result && saved) {
            setStockMetadata(saved.metadata)
            setLoadedMetadata(saved)
            void refreshApprovalContext(result, saved)
          }
        }).catch(() => {
          if (activeProjectRef.current === result) setMetadataMessage('Saved metadata could not be read; it was not modified.')
        })
      }
      setRasterReport(null)
      setSvgReport(null)
      setAuditReport(null)
      setExternalManifestDecision(null)
      if (!result.reopenWarning) setRememberedDirectory(result.directory)
      setCreationMessage(`Project “${result.manifest.project_name}” opened locally.${result.reopenWarning ? ` ${result.reopenWarning}` : ''}`)
      void refreshApprovalContext(result, null)
    } else if (result.kind === 'cancelled') {
      setCreationMessage('Project opening cancelled.')
    } else {
      setCreationMessage(result.message)
    }
  }

  const handleOpenProject = async () => {
    setOpening(true)
    try {
      receiveOpenResult(await openProject(browserProjectLifecycleDependencies()))
    } catch (cause) {
      setCreationMessage(cause instanceof Error ? cause.message : 'Unable to open the selected project folder.')
    } finally {
      setOpening(false)
    }
  }

  const handleReopenProject = () => {
    if (!rememberedDirectory) {
      setCreationMessage('No remembered project is available to reopen.')
      return
    }
    const result = reopenProjectFromUserGesture(rememberedDirectory)
    setOpening(true)
    void result
      .then(receiveOpenResult)
      .finally(() => setOpening(false))
  }

  const handleRasterFileSelection = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    const file = input.files?.[0]
    if (!file) return
    setPreflightingRaster(true)
    const requestId = ++preflightSequence.current
    setRasterReport(null)
    setSvgReport(null)
    setAuditReport(null)
    setRasterMessage(null)
    try {
      const report = await preflightRaster(file, rasterContentType)
      const identity = await fileAuditIdentity(file)
      if (!isCurrentPreflight(requestId, preflightSequence.current)) return
      setRasterReport(report)
      setAuditReport(auditFromRasterReport(report, identity))
    } catch (cause) {
      setRasterMessage(cause instanceof Error ? cause.message : 'Raster preflight could not be completed.')
    } finally {
      setPreflightingRaster(false)
      input.value = ''
    }
  }

  const saveMetadata = async () => {
    const project = activeProjectRef.current
    const asset = project?.manifest.assets.at(-1)
    if (!project || !asset) {
      setMetadataMessage('Prepare an asset revision before saving stock metadata.')
      return
    }
    if (!supportsMetadataWrite(project.directory)) {
      setMetadataMessage('This project handle cannot write metadata. Reopen it with a current Chrome or Edge browser.')
      return
    }
    const provenance: AssetProvenance = { contentType: asset.content_type, creationMethod: asset.creation_method }
    const assessment = assessStockMetadata(stockMetadata, provenance)
    if (!assessment.valid) {
      setMetadataMessage(assessment.errors.join(' '))
      return
    }
    setSavingMetadata(true)
    setMetadataMessage(null)
    try {
      if (!(await requestProjectWritePermission(project.directory))) {
        setMetadataMessage('Write permission was not granted. Metadata was not saved.')
        return
      }
      const saved = await saveStockMetadata({ directory: project.directory, manifestSnapshot: project.manifestSnapshot, assetId: asset.asset_id, provenance, metadata: stockMetadata, sidecarSnapshot: loadedMetadata?.snapshot })
      if (activeProjectRef.current !== project) return
      setStockMetadata(saved.metadata)
      setLoadedMetadata(saved)
      // A preflight started before this save must not later resurrect a CLEAR
      // audit after metadata has made the submission state stale.
      ++preflightSequence.current
      ++exportOperationSequence.current
      setExporting(false)
      setExportMessage(null)
      const invalidatedAudit = auditReport !== null
      setAuditReport((previous) => previous ? buildAuditCenter({
        assetRevisionId: previous.asset.revisionId,
        assetChecksum: previous.asset.checksum,
        rulesetId: previous.ruleset.id,
        rulesetVersion: previous.ruleset.version,
        findings: previous.findings.map((finding) => ({ ruleId: finding.ruleId, verdict: finding.verdict, message: finding.message, evidence: finding.evidence })),
        // Current preflight audits are file-bound, not durable asset-bound. Until
        // the audit workflow receives a durable asset binding, fail closed: no
        // active audit may remain CLEAR after a metadata save.
        currentAssetRevisionId: `${previous.asset.revisionId}-metadata-${asset.asset_id}`,
        currentAssetChecksum: saved.checksum,
      }) : null)
      setDurableAudit(null)
      setDurableAuditSnapshot(undefined)
      setDurableAuditChecksum(null)
      setApproval(null)
      setPreviousApprovalSnapshot(undefined)
      setApprovalGate({ status: 'STALE / BLOCKED', adobeReady: false, exportGate: 'BLOCKED', reasons: ['Metadata changed. Reload and audit the prepared revision again.'] })
      setMetadataMessage(invalidatedAudit ? 'Metadata saved locally. Active audit is stale; run audit again.' : 'Metadata saved locally. Approval evidence is stale; run audit again.')
      void refreshApprovalContext(project, saved)
    } catch (cause) {
      setMetadataMessage(cause instanceof Error ? cause.message : 'Metadata could not be saved.')
    } finally {
      setSavingMetadata(false)
    }
  }

  const handleRasterPreparation = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const source = event.currentTarget.files?.[0]
    const project = activeProjectRef.current
    if (!source || !project) return
    setPreparingRaster(true)
    setPreparationMessage(null)
    try {
      if (!(await requestProjectWritePermission(project.directory))) {
        setPreparationMessage('Write permission was not granted. No revision was written.')
        return
      }
      const result = await prepareRasterForSubmission({
        manifest: project.manifest,
        manifestSnapshot: project.manifestSnapshot,
        source,
        contentType: rasterContentType,
        creationMethod: 'manual_digital',
        quality: 0.92,
      }, { directory: project.directory as never, encodeJpeg: browserEncodeJpeg, newId: () => crypto.randomUUID() })
      if (activeProjectRef.current !== project) return
      const next: ActiveProject = { ...project, manifest: result.manifest, manifestSnapshot: `${JSON.stringify(result.manifest, null, 2)}\n` }
      activeProjectRef.current = next
      setActiveProject(next)
      setRasterReport(null)
      setAuditReport((previous) => previous ? buildAuditCenter({
        assetRevisionId: previous.asset.revisionId,
        assetChecksum: previous.asset.checksum,
        rulesetId: previous.ruleset.id,
        rulesetVersion: previous.ruleset.version,
        findings: previous.findings.map((finding) => ({ ruleId: finding.ruleId, verdict: finding.verdict, message: finding.message, evidence: finding.evidence })),
        currentAssetRevisionId: `${result.assetId}-2`,
        currentAssetChecksum: result.preparation.submission_checksum,
      }) : null)
      ++preflightSequence.current
      ++exportOperationSequence.current
      setExporting(false)
      setExportMessage(null)
      void refreshApprovalContext(next, null)
      setPreparationMessage(`JPEG submission revision 2 was saved locally. Previous audit evidence is stale; run preflight again.`)
    } catch (cause) {
      setPreparationMessage(cause instanceof Error ? cause.message : 'Raster preparation could not be completed.')
    } finally {
      setPreparingRaster(false)
      event.currentTarget.value = ''
    }
  }

  const handleSvgFileSelection = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    const file = input.files?.[0]
    if (!file) return
    setPreflightingSvg(true)
    const requestId = ++preflightSequence.current
    setSvgReport(null)
    setRasterReport(null)
    setAuditReport(null)
    setSvgMessage(null)
    try {
      const report = await preflightSvg(file, svgContentType)
      const identity = await fileAuditIdentity(file)
      if (!isCurrentPreflight(requestId, preflightSequence.current)) return
      setSvgReport(report)
      setAuditReport(auditFromSvgReport(report, identity))
    } catch (cause) {
      setSvgMessage(cause instanceof Error ? cause.message : 'SVG preflight could not be completed.')
    } finally {
      setPreflightingSvg(false)
      input.value = ''
    }
  }

  const closeExternalManifestDecision = () => {
    externalChangeCheckerRef.current?.focus()
    setExternalManifestDecision(null)
  }

  const handleExternalChangeDialogKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeExternalManifestDecision()
      return
    }
    if (event.key !== 'Tab') return

    const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled])')]
    const first = focusable[0]
    const last = focusable.at(-1)
    if (!first || !last) return
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const checkExternalManifestChange = async () => {
    const source = activeProjectRef.current
    if (!source) return
    const result = await detectExternalManifestChange(source.directory, source.manifestSnapshot)
    if (!isSameActiveProject(activeProjectRef.current, source)) return
    if (result.kind === 'unchanged') {
      setCreationMessage('Project manifest is unchanged.')
    } else if (result.kind === 'changed') {
      setExternalManifestDecision({
        source,
        external: { kind: 'opened', directory: source.directory, manifest: result.manifest, manifestSnapshot: result.manifestSnapshot },
      })
    } else {
      setCreationMessage(result.message)
    }
  }

  const saveCurrentManifestCopy = () => {
    const decision = externalManifestDecision
    if (!decision || !isSameActiveProject(activeProjectRef.current, decision.source)) return
    const link = document.createElement('a')
    const blob = new Blob([decision.source.manifestSnapshot], { type: 'application/json' })
    const objectUrl = URL.createObjectURL(blob)
    link.href = objectUrl
    link.download = 'gandiwa-project.external-copy.json'
    link.click()
    URL.revokeObjectURL(objectUrl)
    closeExternalManifestDecision()
    setCreationMessage('Current manifest was saved as a browser download copy. The project folder was not modified.')
  }

  const statusLabel = runtime?.worker.status === 'running' ? 'Worker online' : runtime?.worker.status === 'idle' ? 'Worker idle' : runtime?.worker.status === 'stopped' ? 'Worker stopped' : 'Worker unavailable'
  const backendLabel = runtime?.backend.ready ? 'Backend ready' : 'Backend needs attention'
  const isBackendHealthy = runtime?.backend.ready ?? false
  const activeAsset = activeProject?.manifest.assets.at(-1)
  const activeRevision = activeAsset?.revisions.at(-1)
  const durableAuditVerdict = durableAudit?.findings.some((finding) => finding.verdict === 'FAIL')
    ? 'blocked'
    : durableAudit?.findings.some((finding) => finding.verdict === 'WARNING')
      ? 'warning'
      : durableAudit
        ? 'pass'
        : approvalGate.status === 'STALE / BLOCKED'
          ? 'stale'
          : 'required'
  const guidedWorkflowInput: GuidedWorkflowInput = {
    project: activeProject ? 'active' : 'none',
    hasAsset: Boolean(activeAsset),
    revision: activeRevision ? 'current' : 'required',
    metadata: loadedMetadata ? 'current' : 'required',
    audit: durableAuditVerdict,
    approvalGate: approvalGate.status,
    export: isExporting ? 'running' : exportMessage?.includes('written locally') ? 'success' : 'idle',
    blockers: approvalGate.reasons,
  }
  const workflowPresentation = getGuidedWorkflowPresentation(guidedWorkflowInput)
  const assistantRouterPicker = (
    <section className="guided-secondary-tools" aria-label="Assistant router selection">
      <p className="guided-kicker">ASSISTANT ROUTER</p>
      <p className="helper">
        Choose which 9Router instance handles assistant prompts before starting one. Gandiwa never
        picks automatically and never falls back between instances.
      </p>
      {routerInstances === null ? (
        <p className="helper">9Router instances are still loading.</p>
      ) : routerInstances.length === 0 ? (
        <p className="helper">No 9Router instance is configured on the backend.</p>
      ) : (
        <>
          <label htmlFor="assistant-router-instance">9Router instance</label>
          <select
            id="assistant-router-instance"
            value={routerInstance ?? ''}
            onChange={(event) => {
              const chosen = event.target.value
              if (!chosen) {
                clearSelectedInstance()
                setRouterInstance(null)
                setRouterMessage('Assistant prompts stay blocked until you choose one.')
                return
              }
              persistSelectedInstance(chosen)
              setRouterInstance(chosen)
              setRouterMessage(null)
            }}
          >
            <option value="">Choose an instance…</option>
            {routerInstances.map((instance) => (
              <option key={instance.id} value={instance.id}>{instance.name}</option>
            ))}
          </select>
          {routerInstance === null ? (
            <p className="helper" data-testid="assistant-router-blocked">Select a 9Router instance before starting a prompt.</p>
          ) : null}
          {routerMessage ? <p className="helper" role="alert">{routerMessage}</p> : null}
        </>
      )}
    </section>
  )

  const preflightTools = (
    <details className="guided-secondary-tools">
      <summary>Inspect a candidate temporarily</summary>
      <p className="helper">Preflight is non-durable. It never creates a source, asset, or revision.</p>
      <label htmlFor="raster-content-type">Raster candidate content type</label>
      <select id="raster-content-type" value={rasterContentType} disabled={isPreflightingRaster} onChange={(event) => setRasterContentType(event.target.value as Exclude<ContentType, 'vector'>)}>
        <option value="photo">Photo</option><option value="illustration">Illustration</option>
      </select>
      <label htmlFor="raster-file">Raster file to preflight</label>
      <input id="raster-file" type="file" accept="image/jpeg,image/png,.jpeg,.jpg,.png" disabled={isPreflightingRaster} onChange={(event) => void handleRasterFileSelection(event)} />
      {isPreflightingRaster ? <p className="project-result" role="status">Inspecting raster bytes…</p> : null}
      {rasterMessage ? <p className="project-result" role="alert">{rasterMessage}</p> : null}
      <label htmlFor="svg-content-type">SVG candidate content type</label>
      <select id="svg-content-type" value={svgContentType} disabled={isPreflightingSvg} onChange={(event) => setSvgContentType(event.target.value as Extract<ContentType, 'illustration' | 'vector'>)}>
        <option value="vector">Vector</option><option value="illustration">Illustration vector</option>
      </select>
      <label htmlFor="svg-file">SVG file to preflight</label>
      <input id="svg-file" type="file" accept="image/svg+xml,.svg" disabled={isPreflightingSvg} onChange={(event) => void handleSvgFileSelection(event)} />
      {isPreflightingSvg ? <p className="project-result" role="status">Inspecting SVG security boundary…</p> : null}
      {svgMessage ? <p className="project-result" role="alert">{svgMessage}</p> : null}
    </details>
  )

  const preparationTask = (
    <section aria-label="Revision preparation">
      <p className="guided-kicker">DURABLE PREPARATION</p>
      <p className="helper">Create a new submission revision in the browser-owned folder. The selected source is never overwritten.</p>
      <label className="guided-file-cta" htmlFor="raster-preparation-file">{isPreparingRaster ? 'Preparing JPEG submission revision…' : 'Choose master and prepare revision'}</label>
      <input className="guided-visually-hidden" id="raster-preparation-file" type="file" accept="image/jpeg,image/png,.jpeg,.jpg,.png" disabled={isPreparingRaster} onChange={(event) => void handleRasterPreparation(event)} />
      {isPreparingRaster ? <p className="project-result" role="status">Preparing JPEG submission revision…</p> : null}
      {preparationMessage ? <p className="project-result" role="status">{preparationMessage}</p> : null}
      {assistantRouterPicker}
      {preflightTools}
    </section>
  )

  const metadataTask = activeProject && activeAsset ? (
    <section aria-label="Stock metadata editor">
      <p className="guided-kicker">STOCK METADATA & AI DISCLOSURE</p>
      <p className="helper">Saved as a browser-local sidecar. Asset content type and creation method remain immutable provenance.</p>
      <p className="guided-provenance">Asset <code>{activeAsset.asset_id}</code> · provenance: {activeAsset.content_type} · {activeAsset.creation_method}</p>
      <button className="button button-primary guided-primary-action" disabled={isSavingMetadata || !assessStockMetadata(stockMetadata, { contentType: activeAsset.content_type, creationMethod: activeAsset.creation_method }).valid} onClick={() => void saveMetadata()}>{isSavingMetadata ? 'Saving metadata…' : 'Save metadata locally'}</button>
      <label htmlFor="stock-content-type">Submission content type</label>
      <select id="stock-content-type" value={stockMetadata.contentType} disabled={isSavingMetadata} onChange={(event) => setStockMetadata({ ...stockMetadata, contentType: event.target.value as StockMetadataDraft['contentType'] })}>
        <option value="photo">Photo</option><option value="illustration">Illustration</option><option value="vector">Vector</option>
      </select>
      <label htmlFor="stock-creation-method">Submission creation method</label>
      <select id="stock-creation-method" value={stockMetadata.creationMethod} disabled={isSavingMetadata} onChange={(event) => setStockMetadata({ ...stockMetadata, creationMethod: event.target.value as StockMetadataDraft['creationMethod'] })}>
        <option value="camera">Camera</option><option value="manual_digital">Manual digital</option><option value="generative_ai">Generative AI</option><option value="mixed">Mixed</option>
      </select>
      <label htmlFor="stock-title">Title</label>
      <input id="stock-title" value={stockMetadata.title} disabled={isSavingMetadata} onChange={(event) => setStockMetadata({ ...stockMetadata, title: event.target.value })} />
      <label htmlFor="stock-keywords">Keywords (comma-separated; ordered)</label>
      <input id="stock-keywords" value={stockMetadata.keywords.join(', ')} disabled={isSavingMetadata} onChange={(event) => setStockMetadata({ ...stockMetadata, keywords: event.target.value.split(',') })} />
      <label htmlFor="stock-category">Category</label>
      <input id="stock-category" value={stockMetadata.category} disabled={isSavingMetadata} onChange={(event) => setStockMetadata({ ...stockMetadata, category: event.target.value })} />
      <label><input type="checkbox" checked={stockMetadata.generatedWithAi} disabled={isSavingMetadata} onChange={(event) => setStockMetadata({ ...stockMetadata, generatedWithAi: event.target.checked })} /> Generated with AI</label>
      <label htmlFor="ai-disclosure">AI disclosure</label>
      <textarea id="ai-disclosure" value={stockMetadata.aiDisclosure} disabled={isSavingMetadata} onChange={(event) => setStockMetadata({ ...stockMetadata, aiDisclosure: event.target.value })} />
      <label htmlFor="release-status">Release status</label>
      <select id="release-status" value={stockMetadata.releaseStatus} disabled={isSavingMetadata} onChange={(event) => setStockMetadata({ ...stockMetadata, releaseStatus: event.target.value as StockMetadataDraft['releaseStatus'] })}>
        <option value="not_required">Not required</option><option value="attached">Attached</option><option value="needs_review">Needs review</option>
      </select>
      {assessStockMetadata(stockMetadata, { contentType: activeAsset.content_type, creationMethod: activeAsset.creation_method }).warnings.map((warning) => <p className="helper" key={warning}>Warning: {warning}</p>)}
      {metadataMessage ? <p className="project-result" role="status">{metadataMessage}</p> : null}
    </section>
  ) : <p className="helper">Prepare an asset revision before editing stock metadata.</p>

  const auditTask = activeProject && activeAsset ? <ApprovalGatePanel gate={approvalGate} asset={approvalSubmission ? { assetId: approvalSubmission.assetId, revision: approvalSubmission.revision } : null} audit={durableAudit} submission={approvalSubmission} metadataValid={Boolean(loadedMetadata)} metadataChecksum={approvalSubmission?.metadataChecksum ?? null} auditChecksum={durableAuditChecksum} busy={isApprovalBusy} message={approvalMessage} onAudit={() => void auditPreparedRevision()} onApprove={() => void approveCurrentRevision()} mode="audit" /> : <p className="helper">Prepare an asset revision and valid metadata before running the audit.</p>
  const approvalTask = activeProject && activeAsset ? <ApprovalGatePanel gate={approvalGate} asset={approvalSubmission ? { assetId: approvalSubmission.assetId, revision: approvalSubmission.revision } : null} audit={durableAudit} submission={approvalSubmission} metadataValid={Boolean(loadedMetadata)} metadataChecksum={approvalSubmission?.metadataChecksum ?? null} auditChecksum={durableAuditChecksum} busy={isApprovalBusy} message={approvalMessage} onAudit={() => void auditPreparedRevision()} onApprove={() => void approveCurrentRevision()} mode="approval" /> : <p className="helper">Approval requires current metadata and durable audit evidence.</p>
  const exportTask = activeProject && activeAsset ? (
    <section className="guided-export-task" aria-label="Portable export package">
      <p className="guided-kicker">PORTABLE EXPORT PACKAGE</p>
      <p className="helper">Browser-local only. Gandiwa revalidates the latest approved evidence before writing.</p>
      <button className="button button-primary" disabled={isExporting || isApprovalBusy || approvalGate.exportGate !== 'CLEAR'} onClick={() => void handleExport()}>{isExporting ? 'Writing export package…' : exportMessage?.includes('written locally') ? 'Export another package' : 'Export approved package'}</button>
      {exportMessage ? <p className="project-result" role="status">{exportMessage}</p> : null}
    </section>
  ) : <p className="helper">Export becomes available only after current human approval.</p>
  const workflowTask = workflowPresentation.activeStep === 'prepare'
    ? preparationTask
    : workflowPresentation.activeStep === 'metadata'
      ? metadataTask
      : workflowPresentation.activeStep === 'audit'
        ? auditTask
        : workflowPresentation.activeStep === 'approval'
          ? approvalTask
          : workflowPresentation.activeStep === 'export'
            ? exportTask
            : <p className="helper">Open or create a local project to begin.</p>
  const workflowInspector = inspectorView === 'project-files' ? (
    <>
      <p className="guided-kicker">PROJECT FILES</p>
      <h3>Current browser-local project context</h3>
      <ul className="guided-inspector-list">
        <li>Manifest v{activeProject?.manifest.schema_version} · {activeProject?.manifest.assets.length ?? 0} asset(s)</li>
        <li>{activeAsset ? `Asset ${activeAsset.asset_id} · ${activeAsset.content_type} · ${activeAsset.creation_method}` : 'No durable asset has been prepared yet.'}</li>
        <li>{activeRevision ? `Current revision ${activeRevision.revision}` : 'No current durable revision exists.'}</li>
      </ul>
      <p className="helper">This is a browser-owned project folder. Gandiwa does not upload or write your source files through the backend.</p>
    </>
  ) : inspectorView === 'audit-history' ? (
    <>
      <p className="guided-kicker">AUDIT HISTORY</p>
      <h3>Current durable audit evidence</h3>
      {auditReport ? <AuditCenterPanel audit={auditReport} /> : durableAudit ? <ul className="guided-inspector-list"><li>Asset <code>{durableAudit.assetId}</code> · revision {durableAudit.revision}</li><li>Ruleset {durableAudit.rulesetId} / {durableAudit.rulesetVersion}</li><li>Created {durableAudit.createdAt}</li><li>{durableAudit.findings.length} finding(s) bound to this evidence snapshot</li></ul> : <p className="helper">No durable audit evidence exists for the current revision yet. Run the audit after metadata is current.</p>}
      <p className="helper">Only evidence bound to the current revision, metadata, checksum, and ruleset can clear the next gate.</p>
    </>
  ) : (
    <>
      <p>{workflowPresentation.explanation}</p>
      {workflowPresentation.blockers.length > 0 ? <ul className="guided-inspector-list">{workflowPresentation.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul> : null}
      {auditReport ? <AuditCenterPanel audit={auditReport} /> : <p className="helper">Technical evidence is not available until a current preflight or durable audit has run.</p>}
      {rasterReport ? (
        <section className={`status-card status-${rasterReport.verdict}`} aria-label="Raster preflight result">
          <div>
            <strong>Technical preflight: {rasterReport.verdict.toUpperCase()}</strong>
            <p>{rasterReport.width ?? 'unknown'} × {rasterReport.height ?? 'unknown'} px · {rasterReport.megapixels ?? 'unknown'} MP · alpha: {rasterReport.has_alpha === null ? 'unknown' : rasterReport.has_alpha ? 'yes' : 'no'}</p>
            <p>Eligible for JPEG submission: {rasterReport.eligible_for_submission ? 'yes' : 'no'}</p>
          </div>
          {rasterReport.findings.length > 0 ? <ul>{rasterReport.findings.map((finding) => <li key={finding.rule_id}><code>{finding.rule_id}</code>: {finding.message}</li>)}</ul> : null}
        </section>
      ) : null}
      {svgReport ? (
        <section className={`status-card status-${svgReport.verdict}`} aria-label="SVG preflight result">
          <div>
            <strong>SVG preflight: {svgReport.verdict.toUpperCase()}</strong>
            <p>Eligible for SVG submission: {svgReport.eligible_for_submission ? 'yes' : 'no'}</p>
            {svgReport.preview_url ? <img className="svg-raster-preview" src={svgReport.preview_url} alt="Safe SVG raster preview" /> : null}
          </div>
          {svgReport.findings.length > 0 ? <ul>{svgReport.findings.map((finding) => <li key={finding.rule_id}><code>{finding.rule_id}</code>: {finding.message}</li>)}</ul> : null}
        </section>
      ) : null}
    </>
  )

  return (
    <main className={activeProject ? 'app-shell app-shell-guided' : 'app-shell'}>
      {activeProject ? null : (
      <aside className="nav-panel">
        <div>
          <p className="eyebrow">GANDIWA STUDIO</p>
          <h1>Creative workspace</h1>
          <p className="muted">Local-first production with visible system state.</p>
        </div>
        <div className="nav-status" aria-live="polite">
          <span>{backendLabel}</span>
          <span>{statusLabel}</span>
        </div>
      </aside>
      )}

      <section className={activeProject ? 'workspace workspace-guided' : 'workspace'} aria-busy={loading}>
        {activeProject ? null : (
        <header className="workspace-header">
          <div>
            <p className="eyebrow">PROJECT WORKSPACE</p>
            <h2>Start a project</h2>
          </div>
          <div className="version-badge" aria-label={`MVP ${runtime?.mvp_version ?? 'loading'}`}>
            MVP {runtime?.mvp_version ?? '…'}
          </div>
        </header>
        )}

        {activeProject ? null : error ? (
          <div className="status-card status-fail" role="alert">
            <div>
              <strong>Backend unavailable</strong>
              <p>{error}</p>
            </div>
            <button className="button button-secondary" onClick={() => void refresh()}>Retry</button>
          </div>
        ) : (
          <div className={isBackendHealthy ? 'status-card status-pass' : 'status-card status-warning'}>
            <div>
              <strong>{isBackendHealthy ? 'Backend connected' : 'Backend needs attention'}</strong>
              <p>{isBackendHealthy ? 'Health and readiness checks are passing.' : 'Local project creation remains available while backend checks recover.'}</p>
            </div>
            <button className="button button-secondary" onClick={() => void refresh()}>Refresh status</button>
          </div>
        )}

        {creationMessage ? <p className="project-result" role="status">{creationMessage}</p> : null}

        {activeProject ? null : assistantRouterPicker}

        {activeProject ? null : (
        <>
        <div className="action-grid" aria-describedby="project-actions-help">
          <button ref={createProjectOpenerRef} className="action-card action-primary" aria-label="Create Project" onClick={openCreateDialog}>
            <span className="action-icon" aria-hidden="true">＋</span>
            <span>
              <strong>Create Project</strong>
              <small>Create a local project workspace.</small>
            </span>
          </button>
          <button className="action-card" aria-label="Open Project" disabled={isOpening} onClick={() => void handleOpenProject()}>
            <span className="action-icon" aria-hidden="true">↥</span>
            <span>
              <strong>{isOpening ? 'Opening Project…' : 'Open Project'}</strong>
              <small>Open an existing local project folder.</small>
            </span>
          </button>
          <button className="action-card" aria-label="Reopen remembered project" disabled={isOpening || !rememberedDirectory} onClick={handleReopenProject}>
            <span className="action-icon" aria-hidden="true">⟳</span>
            <span>
              <strong>{rememberedDirectory ? 'Reopen remembered project' : 'No remembered project loaded'}</strong>
              <small>Recover read permission only after you choose this action.</small>
            </span>
          </button>
        </div>

        <p className="helper" id="project-actions-help">
          Create Project and Open Project use a Chrome or Edge folder picker. Reopen uses browser-local handle storage only; it does not sync project files.
        </p>
        </>
        )}

        {activeProject ? (
          <section className="guided-project-region" aria-label="Active project">
            <GuidedWorkflowShell
              projectName={activeProject.manifest.project_name}
              assetSummary={activeAsset && activeRevision ? `${activeAsset.content_type} · revision ${activeRevision.revision}` : 'No asset yet'}
              breadcrumb={['Projects', activeProject.manifest.project_name, activeAsset ? activeAsset.asset_id : 'no asset', activeRevision ? `revision ${activeRevision.revision}` : 'no revision']}
              statusItems={[
                { label: backendLabel, tone: isBackendHealthy ? 'ok' : 'warn' },
                { label: statusLabel, tone: runtime?.worker.status === 'running' ? 'ok' : 'idle' },
              ]}
              presentation={workflowPresentation}
              onOpenInspector={(intent = 'inspector') => {
                setInspectorView(intent)
                document.getElementById('workflow-inspector')?.scrollIntoView({ block: 'nearest' })
              }}
              task={workflowTask}
              inspector={workflowInspector}
              projectActions={
                <>
                  <button className="button button-secondary" aria-label="Open Project" disabled={isOpening} onClick={() => void handleOpenProject()}>Open another project</button>
                  <button className="button button-secondary" aria-label="Reopen remembered project" disabled={isOpening || !rememberedDirectory} onClick={handleReopenProject}>Reopen remembered project</button>
                  <button ref={externalChangeCheckerRef} className="button button-secondary" onClick={() => void checkExternalManifestChange()}>Check for external changes</button>
                  <button
                    className="button button-secondary"
                    onClick={() => {
                      activeProjectRef.current = null
                      approvalContextSequence.current += 1
                      approvalOperationSequence.current += 1
                      exportOperationSequence.current += 1
                      preflightSequence.current += 1
                      setExporting(false)
                      setExportMessage(null)
                      setExternalManifestDecision(null)
                      setActiveProject(null)
                      setRasterReport(null)
                      setSvgReport(null)
                      setAuditReport(null)
                      setApprovalSubmission(null)
                      setDurableAudit(null)
                      setDurableAuditSnapshot(undefined)
                      setDurableAuditChecksum(null)
                      setApproval(null)
                      setPreviousApprovalSnapshot(undefined)
                      setApprovalGate({ status: 'NOT READY', adobeReady: false, exportGate: 'BLOCKED', reasons: ['No active project exists.'] })
                      setApprovalMessage(null)
                      setLoadedMetadata(null)
                    }}
                  >
                    Close project
                  </button>
                </>
              }
            />
          </section>
        ) : null}

        {activeProject ? null : (
        <section className="runtime-grid" aria-label="Runtime status">
          <article className="panel">
            <p className="eyebrow">BACKEND HEALTH</p>
            <strong>{runtime?.backend.health === 'ok' ? 'Live' : 'Unavailable'}</strong>
            <span>{isBackendHealthy ? 'Ready for workspace operations.' : 'Local folders remain available; backend operations are paused.'}</span>
          </article>
          <article className="panel">
            <p className="eyebrow">WORKER STATE</p>
            <strong>{statusLabel}</strong>
            <span>{runtime?.worker.heartbeat_at ? `Heartbeat ${new Date(runtime.worker.heartbeat_at).toLocaleTimeString()}` : 'No heartbeat available.'}</span>
          </article>
        </section>
        )}
      </section>

      {externalManifestDecision ? (
        <div className="dialog-backdrop">
          <section
            className="create-project-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="external-change-title"
            onKeyDown={handleExternalChangeDialogKeyDown}
          >
            <header>
              <p className="eyebrow">EXTERNAL CHANGE</p>
              <h2 id="external-change-title">External manifest change detected</h2>
              <p>The project folder now contains manifest “{externalManifestDecision.external.manifest.project_name}”. Gandiwa has not written over either version.</p>
            </header>
            <div className="dialog-actions">
              <button
                ref={externalManifestReloadRef}
                className="button button-primary"
                onClick={() => {
                  if (!isSameActiveProject(activeProjectRef.current, externalManifestDecision.source)) return
                  activeProjectRef.current = externalManifestDecision.external
                  approvalContextSequence.current += 1
                  approvalOperationSequence.current += 1
                  exportOperationSequence.current += 1
                  preflightSequence.current += 1
                  setExporting(false)
                  setExportMessage(null)
                  setActiveProject(externalManifestDecision.external)
                  setApprovalSubmission(null)
                  setDurableAudit(null)
                  setDurableAuditSnapshot(undefined)
                  setDurableAuditChecksum(null)
                  setApproval(null)
                  setPreviousApprovalSnapshot(undefined)
                  setApprovalGate({ status: 'NOT READY', adobeReady: false, exportGate: 'BLOCKED', reasons: ['Reloaded manifest; approval evidence is being recomputed.'] })
                  setApprovalMessage(null)
                  setLoadedMetadata(null)
                  closeExternalManifestDecision()
                  setCreationMessage(`Reloaded external manifest for “${externalManifestDecision.external.manifest.project_name}”.`)
                  const reloadedAsset = externalManifestDecision.external.manifest.assets.at(-1)
                  if (reloadedAsset && supportsMetadataWrite(externalManifestDecision.external.directory)) {
                    void loadStockMetadata(externalManifestDecision.external.directory, reloadedAsset.asset_id, { contentType: reloadedAsset.content_type, creationMethod: reloadedAsset.creation_method }).then((saved) => {
                      if (activeProjectRef.current === externalManifestDecision.external && saved) {
                        setStockMetadata(saved.metadata)
                        setLoadedMetadata(saved)
                        void refreshApprovalContext(externalManifestDecision.external, saved)
                      }
                    }).catch(() => setApprovalMessage('Reloaded manifest metadata could not be read; approval remains blocked.'))
                  } else {
                    void refreshApprovalContext(externalManifestDecision.external, null)
                  }
                }}
              >
                Reload external manifest
              </button>
              <button className="button button-secondary" onClick={saveCurrentManifestCopy}>Save current manifest as copy</button>
              <button className="button button-secondary" onClick={closeExternalManifestDecision}>Cancel external change decision</button>
            </div>
          </section>
        </div>
      ) : null}

      {isCreateDialogOpen ? (
        <div className="dialog-backdrop">
          <section className="create-project-dialog" role="dialog" aria-modal="true" aria-labelledby="create-project-title" onKeyDown={handleCreateDialogKeyDown}>
            <header>
              <p className="eyebrow">LOCAL PROJECT</p>
              <h2 id="create-project-title">Create local project</h2>
              <p>Choose an empty folder only after the project details are valid. Gandiwa writes no provider credential to this folder.</p>
            </header>
            <form onSubmit={(event) => void submitCreateProject(event)}>
              <label htmlFor="project-name">Project name</label>
              <input
                id="project-name"
                value={createForm.projectName}
                onChange={(event) => setCreateForm((form) => ({ ...form, projectName: event.target.value }))}
                autoFocus
                maxLength={80}
                required
              />

              <label htmlFor="content-type">Content type</label>
              <select
                id="content-type"
                value={createForm.contentType}
                onChange={(event) => setCreateForm((form) => ({ ...form, contentType: event.target.value as ContentType }))}
              >
                <option value="photo">Photo</option>
                <option value="illustration">Illustration</option>
                <option value="vector">Vector</option>
              </select>

              <label htmlFor="creation-method">Creation method</label>
              <select
                id="creation-method"
                value={createForm.creationMethod}
                onChange={(event) => setCreateForm((form) => ({ ...form, creationMethod: event.target.value as CreationMethod }))}
              >
                <option value="camera">Camera</option>
                <option value="manual_digital">Manual digital</option>
                <option value="generative_ai">Generative AI</option>
                <option value="mixed">Mixed</option>
              </select>

              <p className="form-note">The chosen type and method are required before the first asset is created. This empty project manifest does not invent an asset or revision.</p>
              <div className="dialog-actions">
                <button className="button button-secondary" type="button" disabled={isCreating} onClick={closeCreateDialog}>Cancel</button>
                <button className="button button-primary" type="submit" disabled={isCreating}>
                  {isCreating ? 'Creating local project…' : 'Choose empty folder and create project'}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </main>
  )
}
