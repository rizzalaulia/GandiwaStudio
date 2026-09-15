import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

import type { GuidedWorkflowPresentation, GuidedWorkflowStep } from '../../workflow/guided-workflow'

const steps: readonly { id: GuidedWorkflowStep; label: string }[] = [
  { id: 'prepare', label: 'Prepare revision' },
  { id: 'metadata', label: 'Complete metadata' },
  { id: 'audit', label: 'Run audit' },
  { id: 'approval', label: 'Human approval' },
  { id: 'export', label: 'Export package' },
]

export type GuidedWorkflowShellProps = Readonly<{
  projectName: string
  showSidebar?: boolean
  assetSummary: string
  breadcrumb?: readonly string[]
  statusItems?: readonly { label: string; tone?: 'ok' | 'idle' | 'warn' }[]
  presentation: GuidedWorkflowPresentation
  onOpenInspector: (intent?: 'project-files' | 'audit-history' | 'inspector') => void
  task: ReactNode
  inspector: ReactNode
}>

export function GuidedWorkflowShell({
  projectName,
  assetSummary,
  breadcrumb,
  statusItems,
  presentation,
  onOpenInspector,
  task,
  inspector,
}: GuidedWorkflowShellProps) {
  const [isInspectorOpen, setIsInspectorOpen] = useState(false)
  const [usesInspectorDrawer, setUsesInspectorDrawer] = useState(() => window.matchMedia?.('(max-width: 1279px)').matches ?? false)
  const inspectorTriggerRef = useRef<HTMLButtonElement>(null)
  const lastInspectorOpenerRef = useRef<HTMLElement>(null)
  const shouldRestoreInspectorFocusRef = useRef(false)
  const closeInspectorRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const media = window.matchMedia?.('(max-width: 1279px)')
    if (!media) return
    const syncDrawerMode = () => setUsesInspectorDrawer(media.matches)
    syncDrawerMode()
    media.addEventListener('change', syncDrawerMode)
    return () => media.removeEventListener('change', syncDrawerMode)
  }, [])

  useEffect(() => {
    if (!isInspectorOpen || !usesInspectorDrawer) return
    closeInspectorRef.current?.focus()
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previousOverflow }
  }, [isInspectorOpen, usesInspectorDrawer])

  const isDrawerModalOpen = isInspectorOpen && usesInspectorDrawer
  const backgroundModalProps = isDrawerModalOpen ? { 'aria-hidden': true, inert: true } : {} as const

  useLayoutEffect(() => {
    if (!shouldRestoreInspectorFocusRef.current || isDrawerModalOpen) return
    shouldRestoreInspectorFocusRef.current = false
    lastInspectorOpenerRef.current?.focus()
  }, [isDrawerModalOpen])

  const closeInspector = () => {
    shouldRestoreInspectorFocusRef.current = true
    setIsInspectorOpen(false)
  }
  const openInspector = (intent: 'project-files' | 'audit-history' | 'inspector' = 'inspector', opener?: HTMLElement) => {
    if (usesInspectorDrawer) {
      lastInspectorOpenerRef.current = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
      setIsInspectorOpen(true)
    }
    onOpenInspector(intent)
  }

  return (
    <div className="guided-shell">
      <aside className="guided-sidebar" {...backgroundModalProps}>
        <div>
          <p className="guided-brand">GANDIWA STUDIO</p>
          <div className="guided-project-context">
            <span className="guided-label">ACTIVE PROJECT</span>
            <strong>{projectName}</strong>
            <span>{assetSummary}</span>
          </div>
          <nav aria-label="Project navigation" className="guided-project-nav">
            <span className="guided-nav-heading">PROJECT</span>
            <a className="guided-nav-item guided-nav-item-current" href="#workflow">Workspace</a>
            <button className="guided-nav-item" type="button" aria-controls="workflow-inspector" onClick={(event) => openInspector('project-files', event.currentTarget)}>Project files</button>
            <button className="guided-nav-item" type="button" aria-controls="workflow-inspector" onClick={(event) => openInspector('audit-history', event.currentTarget)}>Audit history</button>
          </nav>
        </div>
        <p className="guided-sidebar-note">Browser-owned local project folder.<br />Evidence stays revision-bound.</p>
        {statusItems && statusItems.length > 0 ? (
          <ul className="guided-status" aria-label="Project status">
            {statusItems.map((item) => (
              <li key={item.label}><span className={`guided-led${item.tone === 'idle' ? ' guided-led-idle' : ''}`} aria-hidden="true" />{item.label}</li>
            ))}
          </ul>
        ) : null}
      </aside>

      <main className="guided-workspace" id="workflow" {...backgroundModalProps}>
        <div className="guided-topbar">
        <header className="guided-header" aria-label="Project header">
          {breadcrumb && breadcrumb.length > 0 ? (
            <nav className="guided-breadcrumb" aria-label="Breadcrumb">
              {breadcrumb.join(' / ')}
            </nav>
          ) : null}
          <div>
            <p className="guided-kicker">ACTIVE PROJECT / NEXT ACTION</p>
            <h1>{presentation.title}</h1>
            <p className="guided-header-summary">{projectName} · {assetSummary}</p>
          </div>
          <span className={`guided-state guided-state-${presentation.state.toLowerCase()}`} aria-label={`Workflow state: ${presentation.state.replaceAll('_', ' ')}`}>
            {presentation.state.replaceAll('_', ' ')}
          </span>
        </header>

        <nav className="guided-stepper" aria-label="Production workflow">
          <ol>
            {steps.map((step, index) => {
              const isCurrent = presentation.activeStep === step.id
              const isComplete = presentation.completedSteps.includes(step.id)
              return (
                <li
                  key={step.id}
                  aria-current={isCurrent ? 'step' : undefined}
                  aria-label={`${step.label} — ${isCurrent ? 'current' : isComplete ? 'complete' : 'upcoming'}`}
                  className={isCurrent ? 'guided-step guided-step-current' : isComplete ? 'guided-step guided-step-complete' : 'guided-step'}
                >
                  <span className="guided-step-marker" aria-hidden="true">{isComplete ? '✓' : index + 1}</span>
                  <span>
                    <strong>{step.label}</strong>
                    <small>{isCurrent ? 'Current task' : isComplete ? 'Complete' : 'Upcoming'}</small>
                  </span>
                </li>
              )
            })}
          </ol>
        </nav>
        </div>

        <section className="guided-task" aria-label="Current workflow task">
          <div className="guided-task-heading">
            <div>
              <p className="guided-kicker">CURRENT TASK</p>
              <h2>{presentation.title}</h2>
            </div>
            <button ref={inspectorTriggerRef} className="guided-inspector-trigger" type="button" aria-label="Open contextual inspector" aria-controls="workflow-inspector" onClick={(event) => openInspector('inspector', event.currentTarget)}>
              Inspect details
            </button>
          </div>
          <p className="guided-explanation">{presentation.explanation}</p>
          {presentation.blockers.length > 0 ? (
            <div className="guided-blockers" role="alert">
              <strong>What needs attention</strong>
              <ul>{presentation.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>
            </div>
          ) : null}
          <div className="guided-task-outlet">{task}</div>
        </section>
      </main>

      <aside className="guided-inspector" id="workflow-inspector" aria-label="Contextual inspector" {...backgroundModalProps}>
        <p className="guided-kicker">CONTEXTUAL INSPECTOR</p>
        <h2>Why progress is here</h2>
        {inspector}
      </aside>
      {isInspectorOpen && usesInspectorDrawer ? (
        <div className="guided-inspector-backdrop" onClick={closeInspector}>
          <aside
            className="guided-inspector-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Contextual inspector"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                closeInspector()
                return
              }
              if (event.key !== 'Tab') return
              const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])')]
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
            }}
          >
            <div className="guided-drawer-heading">
              <div><p className="guided-kicker">CONTEXTUAL INSPECTOR</p><h2>Why progress is here</h2></div>
              <button ref={closeInspectorRef} className="guided-inspector-trigger" type="button" onClick={closeInspector}>Close details</button>
            </div>
            {inspector}
          </aside>
        </div>
      ) : null}
    </div>
  )
}
