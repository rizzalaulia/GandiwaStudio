import { useCallback, useEffect, useRef, useState } from 'react'

import type { ContentType, CreationMethod } from '@gandiwa/contracts'

import {
  browserProjectCreationDependencies,
  createProject,
  type ProjectCreationResult,
} from './project-filesystem'

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

const DEFAULT_CREATE_PROJECT_FORM: CreateProjectForm = {
  projectName: '',
  contentType: 'illustration',
  creationMethod: 'generative_ai',
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
  if (result.kind === 'created') return `Project “${result.projectName}” created locally.`
  if (result.kind === 'cancelled') return 'Project creation cancelled.'
  return result.message
}

export function App() {
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [isCreateDialogOpen, setCreateDialogOpen] = useState(false)
  const [createForm, setCreateForm] = useState<CreateProjectForm>(DEFAULT_CREATE_PROJECT_FORM)
  const [isCreating, setCreating] = useState(false)
  const [creationMessage, setCreationMessage] = useState<string | null>(null)
  const requestSequence = useRef(0)
  const createProjectOpenerRef = useRef<HTMLButtonElement>(null)

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

  useEffect(() => {
    void refresh()
    const id = window.setInterval(() => void refresh(), 5000)
    return () => {
      window.clearInterval(id)
      requestSequence.current += 1
    }
  }, [refresh])

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
      if (result.kind === 'created' || result.kind === 'cancelled') closeCreateDialog()
    } catch (cause) {
      setCreationMessage(cause instanceof Error ? cause.message : 'Unable to create the project. No project was created.')
    } finally {
      setCreating(false)
    }
  }

  const statusLabel = runtime?.worker.status === 'running' ? 'Worker online' : runtime?.worker.status === 'idle' ? 'Worker idle' : runtime?.worker.status === 'stopped' ? 'Worker stopped' : 'Worker unavailable'
  const backendLabel = runtime?.backend.ready ? 'Backend ready' : 'Backend needs attention'
  const isBackendHealthy = runtime?.backend.ready ?? false

  return (
    <main className="app-shell">
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

      <section className="workspace" aria-busy={loading}>
        <header className="workspace-header">
          <div>
            <p className="eyebrow">PROJECT WORKSPACE</p>
            <h2>Start a project</h2>
          </div>
          <div className="version-badge" aria-label={`MVP ${runtime?.mvp_version ?? 'loading'}`}>
            MVP {runtime?.mvp_version ?? '…'}
          </div>
        </header>

        {error ? (
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

        <div className="action-grid" aria-describedby="project-actions-help">
          <button ref={createProjectOpenerRef} className="action-card action-primary" aria-label="Create Project" onClick={openCreateDialog}>
            <span className="action-icon" aria-hidden="true">＋</span>
            <span>
              <strong>Create Project</strong>
              <small>Create a local project workspace.</small>
            </span>
          </button>
          <button className="action-card" disabled>
            <span className="action-icon" aria-hidden="true">↥</span>
            <span>
              <strong>Open Project</strong>
              <small>Open an existing local project folder.</small>
            </span>
          </button>
        </div>

        <p className="helper" id="project-actions-help">
          Create Project uses a Chrome or Edge folder picker. Open Project arrives in the next Stage 2 slice.
        </p>

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
      </section>

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
