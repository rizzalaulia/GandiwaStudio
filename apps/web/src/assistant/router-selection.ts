/** Visible 9Router instance selection for assistant prompts (Issue #24 Slice B). */

const PROVIDERS_PATH = '/api/v1/providers'

export interface ProviderOption {
  id: string
  name: string
  configured: boolean
  auth_required: boolean
}

export const DEFAULT_INSTANCE_STORAGE_KEY = 'gandiwa.selected-9router-instance'

export function providersPath(): string {
  return PROVIDERS_PATH
}

/** Instance ids only; aggregate/disabled connectors never reach the picker. */
export function providersFromResponse(items: readonly ProviderOption[]): ProviderOption[] {
  return items.filter((item) => item.id !== 'fal' && item.configured)
}

export async function fetchProviderOptions(): Promise<ProviderOption[]> {
  const response = await fetch(providersPath(), {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })
  if (!response || !response.ok) {
    throw new Error(`Provider request failed (${response ? response.status : 'no response'})`)
  }
  const payload = (await response.json()) as ProviderOption[]
  if (!Array.isArray(payload)) throw new Error('Provider response was not a list')
  return providersFromResponse(payload)
}

export function persistSelectedInstance(instanceId: string): void {
  window.localStorage.setItem(DEFAULT_INSTANCE_STORAGE_KEY, instanceId)
}

export function clearSelectedInstance(): void {
  window.localStorage.removeItem(DEFAULT_INSTANCE_STORAGE_KEY)
}

/**
 * Never auto-picks: returns the stored selection only when the backend still
 * offers it as configured; otherwise null so the UI must ask the human.
 */
export function resolveSelectedInstance(options: readonly ProviderOption[]): string | null {
  const stored = window.localStorage.getItem(DEFAULT_INSTANCE_STORAGE_KEY)
  if (!stored) return null
  const offered = options.some((option) => option.id === stored && option.configured)
  return offered ? stored : null
}
