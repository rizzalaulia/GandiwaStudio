import { useCallback, useEffect, useRef, useState } from 'react'

type RuntimeStatus = {
  version: string
  mvp_version: string
  backend: { health: string; ready: boolean; checks: Record<string, boolean> }
  worker: { status: 'idle' | 'running' | 'stopped' | 'unavailable'; heartbeat_at: string | null }
}

async function fetchStatus(): Promise<RuntimeStatus> {
  const response = await fetch('/api/v1/status', {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`Backend status request failed (${response.status})`)
  return response.json() as Promise<RuntimeStatus>
}

export function App() {
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const requestSequence = useRef(0)

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
      if (requestId === requestSequence.current) {
        setLoading(false)
      }
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
              <p>{isBackendHealthy ? 'Health and readiness checks are passing.' : 'Open the backend or resolve the failed checks before starting work.'}</p>
            </div>
            <button className="button button-secondary" onClick={() => void refresh()}>Refresh status</button>
          </div>
        )}

        <div className="action-grid" aria-describedby="project-actions-help">
          <button className="action-card action-primary" disabled>
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
          Project creation and opening arrive in Stage 2.
        </p>

        <section className="runtime-grid" aria-label="Runtime status">
          <article className="panel">
            <p className="eyebrow">BACKEND HEALTH</p>
            <strong>{runtime?.backend.health === 'ok' ? 'Live' : 'Unavailable'}</strong>
            <span>{isBackendHealthy ? 'Ready for workspace operations.' : 'Readiness checks are not passing.'}</span>
          </article>
          <article className="panel">
            <p className="eyebrow">WORKER STATE</p>
            <strong>{statusLabel}</strong>
            <span>{runtime?.worker.heartbeat_at ? `Heartbeat ${new Date(runtime.worker.heartbeat_at).toLocaleTimeString()}` : 'No heartbeat available.'}</span>
          </article>
        </section>
      </section>
    </main>
  )
}
