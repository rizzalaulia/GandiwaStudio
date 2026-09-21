import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

import { providersFromResponse, resolveSelectedInstance, persistSelectedInstance, clearSelectedInstance, DEFAULT_INSTANCE_STORAGE_KEY } from './router-selection'

describe('router-selection', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  afterEach(() => {
    window.localStorage.clear()
    vi.unstubAllGlobals()
  })

  const both = providersFromResponse([
    { id: 'fal', name: 'fal.ai', configured: false, auth_required: true },
    { id: 'studio-a', name: '9Router · studio-a', configured: true, auth_required: true },
    { id: 'studio-b', name: '9Router · studio-b', configured: true, auth_required: true },
  ])

  it('lists both named 9Router instances from the backend response with no URLs or keys', () => {
    expect(both.map((p) => p.id)).toEqual(['studio-a', 'studio-b'])
  })

  it('keeps an explicit selection and resolves it again', () => {
    persistSelectedInstance('studio-b')
    expect(resolveSelectedInstance(both)).toBe('studio-b')
  })

  it('never auto-picks: no stored selection resolves to null even with both configured', () => {
    expect(resolveSelectedInstance(both)).toBeNull()
  })

  it('refuses a stored selection that the backend no longer offers', () => {
    persistSelectedInstance('studio-gone')
    expect(resolveSelectedInstance(both)).toBeNull()
  })

  it('offers only configured instances', () => {
    const oneConfigured = providersFromResponse([
      { id: 'studio-a', name: '9Router · studio-a', configured: true, auth_required: true },
      { id: 'studio-b', name: '9Router · studio-b', configured: false, auth_required: true },
    ])
    expect(oneConfigured.map((p) => p.id)).toEqual(['studio-a'])
  })

  it('stores the selection under the documented key', () => {
    persistSelectedInstance('studio-a')
    expect(window.localStorage.getItem(DEFAULT_INSTANCE_STORAGE_KEY)).toBe('studio-a')
    expect(resolveSelectedInstance([])).toBeNull()
    clearSelectedInstance()
    expect(window.localStorage.getItem(DEFAULT_INSTANCE_STORAGE_KEY)).toBeNull()
  })
})
