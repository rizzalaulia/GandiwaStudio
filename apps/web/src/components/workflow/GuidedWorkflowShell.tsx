import { useEffect, useRef, useState, type ReactNode } from 'react'

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
  presentation: GuidedWorkflowPresentation
  onOpenInspector: () => void
  task: ReactNode
  inspector: ReactNode
}>

export function GuidedWorkflowShell({
  projectName,
  assetSummary,
  presentation,
  onOpenInspector,
  task,
  inspector,
}: GuidedWorkflowShellProps) {
  const [isInspectorOpen, setIsInspectorOpen] = useState(false)
  const [usesInspectorDrawer, setUsesInspectorDrawer] = useState(() => window.matchMedia?.('(max-width: 1279px)').matches ?? false)
  const inspectorTriggerRef = useRef<HTMLButtonElement>(null)
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
    if (isInspectorOpen && usesInspectorDrawer) closeInspectorRef.current?.focus()
  }, [isInspectorOpen, usesInspectorDrawer])

  const closeInspector = () => {
    setIsInspectorOpen(false)
    inspectorTriggerRef.current?.focus()
  }
  const openInspector = () => {
    if (usesInspectorDrawer) setIsInspectorOpen(true)
    onOpenInspector()
  }

  return (
    <div className="guided-shell">
      <aside className="guided-sidebar">
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
          </nav>
        </div>
        <p className="guided-sidebar-note">Browser-owned local project folder.<br />Evidence stays revision-bound.</p>
      </aside>

      <main className="guided-workspace" id="workflow">
        <header className="guided-header" aria-label="Project header">
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

        <section className="guided-task" aria-label="Current workflow task">
          <div className="guided-task-heading">
            <div>
              <p className="guided-kicker">CURRENT TASK</p>
              <h2>{presentation.title}</h2>
            </div>
            <button ref={inspectorTriggerRef} className="guided-inspector-trigger" type="button" aria-label="Open contextual inspector" aria-controls="workflow-inspector" onClick={openInspector}>
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

      <aside className="guided-inspector" id="workflow-inspector" aria-label="Contextual inspector">
        <p className="guided-kicker">CONTEXTUAL INSPECTOR</p>
        <h2>Why progress is here</h2>
        {inspector}
      </aside>
      {isInspectorOpen && usesInspectorDrawer ? (
        <div className="guided-inspector-backdrop" onClick={closeInspector}>
          <aside className="guided-inspector-drawer" role="dialog" aria-modal="true" aria-label="Contextual inspector" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Escape') closeInspector() }}>
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
