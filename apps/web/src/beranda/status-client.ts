// Issue #26 (opsi B) — status tab data: merges the two honest runtime
// endpoints into one view. /api/v1/status gives backend health + worker
// heartbeat; /api/v1/providers gives configured connectors without secrets.
// Everything defaults fail-closed: unavailable reads as down, never healthy.

export type ProviderChip = Readonly<{
  provider: string
  configured: boolean
  testable: boolean
}>

export type StatusView = Readonly<{
  backend: { health: string; ready: boolean }
  worker: { status: string; heartbeat_at: string | null }
  providers: ProviderChip[]
}>

type RawProvider = Readonly<{ id: string; name: string; configured: boolean; auth_required: boolean }>

export async function fetchStatus(): Promise<StatusView> {
  const [statusResponse, providersResponse] = await Promise.all([
    fetch('/api/v1/status', { credentials: 'same-origin', headers: { Accept: 'application/json' } }),
    fetch('/api/v1/providers', { credentials: 'same-origin', headers: { Accept: 'application/json' } }),
  ])
  if (!statusResponse.ok) {
    throw new Error(`Permintaan status backend gagal (${statusResponse.status})`)
  }
  const raw = (await statusResponse.json()) as {
    backend?: { health?: string; ready?: boolean } | null
    worker?: { status?: string; heartbeat_at?: string | null } | null
  }
  const providers: ProviderChip[] = providersResponse.ok
    ? ((await providersResponse.json()) as RawProvider[]).map((provider) => ({
        provider: provider.id,
        configured: provider.configured === true,
        testable: provider.configured === true,
      }))
    : []
  const backend = raw.backend ?? {}
  const worker = raw.worker ?? {}
  return {
    backend: {
      health: typeof backend.health === 'string' ? backend.health : 'unknown',
      ready: backend.ready === true,
    },
    worker: {
      status: typeof worker.status === 'string' ? worker.status : 'unavailable',
      heartbeat_at: typeof worker.heartbeat_at === 'string' ? worker.heartbeat_at : null,
    },
    providers,
  }
}
