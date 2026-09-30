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

// Canonical SETTINGS provider id mapping (24 Sep): the providers registry
// names connector rows by INSTANCE id (fal, or a 9Router instance like
// 'mibp'/'studio-a'), while key storage, validation, and the settings rows
// use the DOCKET provider id ('fal' | '9router'). Forwarding raw ids left the
// 9Router row searching 'mibp' against a '9router' key: chip said "belum ada
// key" and the Tes button stayed disabled even with a stored, VALID key
// (probe answered ok). Map every non-fal connector row onto the 9Router
// settings id — one stored router key serves the whole instance family.
const CANONICAL_PROVIDER_IDS: Readonly<Record<string, string>> = { fal: 'fal' }

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
        provider: CANONICAL_PROVIDER_IDS[provider.id] ?? '9router',
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
