// Issue #26 (opsi B) — Settings page client logic.
// Keys live server-side forever; this module only renders masked state and
// talks to the backend through the companion-token envelope. A secret never
// round-trips through browser state: POST carries a new key, GET only ever
// returns configured/masked summaries.

export type ProviderName = 'fal' | '9router'

export type ProviderBackendState = Readonly<{ provider: string; configured: boolean }>

export type ProviderSettingsPayload = Readonly<{
  providers: ReadonlyArray<{ provider: ProviderName; apiKey: string }>
}>

export type ProviderView = Readonly<{
  provider: string
  configured: boolean
  maskedKey: string
  testable: boolean
}>

const EMPTY_KEY_NOTE = 'belum diatur'
const CONFIGURED_NOTE = 'terpasang'

export function maskSecret(secret: string): string {
  if (secret.length < 4) return EMPTY_KEY_NOTE
  return `****${secret.slice(-4)}`
}

export function companionHeadersForToken(csrfToken: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Companion-Token': csrfToken,
  }
}

async function save(args: { csrfToken: string; payload: ProviderSettingsPayload }): Promise<void> {
  const response = await fetch('/api/v1/settings/providers', {
    method: 'POST',
    headers: companionHeadersForToken(args.csrfToken),
    body: JSON.stringify(args.payload),
  })
  if (!response.ok) {
    throw new Error(`Gagal menyimpan kunci provider (${response.status})`)
  }
}

async function testConnection(provider: ProviderName, instance?: string): Promise<{ ok: boolean }> {
  void instance // Legacy caller compatibility; validation is provider-scoped.
  const response = await fetch(`/api/v1/settings/providers/${provider}/validate`, {
    credentials: 'same-origin',
  })
  if (!response.ok) return { ok: false }
  const body = (await response.json()) as { ok?: unknown }
  return { ok: body.ok === true }
}

export type ProviderSettingsViewFn = ((
  states: ReadonlyArray<ProviderBackendState>,
) => ProviderView[]) & {
  save: typeof save
  testConnection: typeof testConnection
}

export const providerSettingsView = ((states: ReadonlyArray<ProviderBackendState>) =>
  states.map((state) => ({
    provider: state.provider,
    configured: state.configured,
    maskedKey: state.configured ? CONFIGURED_NOTE : maskSecret(''),
    testable: state.configured,
  }))) as ProviderSettingsViewFn

providerSettingsView.save = save
providerSettingsView.testConnection = testConnection
