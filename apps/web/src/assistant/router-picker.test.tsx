/** Mirror UI regressions for the visible 9Router instance picker (Issue #24 Slice B). */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from '../App'

type ProviderPayload = { id: string; name: string; configured: boolean; auth_required: boolean }

const BOTH_INSTANCES: ProviderPayload[] = [
  { id: 'fal', name: 'fal.ai', configured: false, auth_required: true },
  { id: 'studio-a', name: '9Router · studio-a', configured: true, auth_required: true },
  { id: 'studio-b', name: '9Router · studio-b', configured: true, auth_required: true },
]

function stubFetch(providers: ProviderPayload[]): void {
  const statusJson = () => Promise.resolve({
    version: '0.0.0',
    mvp_version: 'mvp-1.0',
    backend: { health: 'ok', ready: true, checks: {} },
    worker: { status: 'running', heartbeat_at: null },
  })
  const providersJson = (): Promise<ProviderPayload[]> => Promise.resolve([...providers])
  vi.stubGlobal('fetch', vi.fn((input: string | Request) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.includes('/api/v1/status')) {
      return Promise.resolve({ ok: true, json: statusJson })
    }
    if (url.includes('/api/v1/providers')) {
      return Promise.resolve({ ok: true, json: providersJson })
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`))
  }))
}

function renderShell(): void {
  render(<App />)
}

const STORAGE_KEY = 'gandiwa.selected-9router-instance'

describe('Assistant router picker (guided workflow)', () => {
  beforeEach(() => {
    window.localStorage.clear()
    stubFetch(BOTH_INSTANCES)
  })

  afterEach(() => {
    cleanup()
    window.localStorage.clear()
    vi.unstubAllGlobals()
  })

  it('offers both configured instances before any prompt starts', async () => {
    renderShell()
    const picker = await screen.findByRole<HTMLSelectElement>('combobox', { name: '9Router instance' })
    const options = Array.from(picker.options).map((option) => option.value)
    expect(options).toEqual(['', 'studio-a', 'studio-b'])
    expect(screen.getByText(/Select a 9Router instance before starting a prompt/)).toBeInTheDocument()
  })

  it('preserves the explicit human selection without auto-picking', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'studio-b')
    renderShell()
    const picker = await screen.findByRole<HTMLSelectElement>('combobox', { name: '9Router instance' })
    await waitFor(() => expect(picker.value).toBe('studio-b'))
  })

  it('keeps a new selection after choosing the other instance', async () => {
    renderShell()
    const picker = await screen.findByRole<HTMLSelectElement>('combobox', { name: '9Router instance' })
    await waitFor(() => expect(picker.value).toBe(''))
    fireEvent.change(picker, { target: { value: 'studio-a' } })
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('studio-a')
    fireEvent.change(picker, { target: { value: 'studio-b' } })
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('studio-b')
  })

  it('refuses a stored instance the backend no longer offers and shows the blocked status again', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'studio-gone')
    renderShell()
    const picker = await screen.findByRole<HTMLSelectElement>('combobox', { name: '9Router instance' })
    await waitFor(() => expect(picker.value).toBe(''))
    expect(screen.getByText(/Select a 9Router instance before starting a prompt/)).toBeInTheDocument()
  })
})

describe('Assistant router picker backend variation', () => {
  afterEach(() => {
    cleanup()
    window.localStorage.clear()
    vi.unstubAllGlobals()
  })

  it('lists no instance option when the backend has none configured', async () => {
    stubFetch([])
    renderShell()
    await screen.findByText(/No 9Router instance is configured on the backend/)
  })
})
