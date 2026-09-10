import 'fake-indexeddb/auto'

import { afterEach, describe, expect, it } from 'vitest'

import { forgetProjectDirectory, loadRememberedProjectDirectory, rememberProjectDirectory } from './project-handle-store'

const DATABASE_NAME = 'gandiwa-project-handles'

function deleteStore(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(new Error(request.error?.message ?? 'Unable to clear local project storage.'))
  })
}

afterEach(async () => {
  await deleteStore()
})

describe('project handle store', () => {
  it('persists and restores the browser-owned project directory handle', async () => {
    const directory = { kind: 'directory', name: 'Burung Laut' }

    await rememberProjectDirectory(directory)

    await expect(loadRememberedProjectDirectory()).resolves.toEqual(directory)
  })

  it('returns no directory before any project has been remembered', async () => {
    await expect(loadRememberedProjectDirectory()).resolves.toBeUndefined()
  })

  it('forgets the remembered directory when the user chooses to remove local reopen access', async () => {
    await rememberProjectDirectory({ kind: 'directory', name: 'Burung Laut' })

    await forgetProjectDirectory()

    await expect(loadRememberedProjectDirectory()).resolves.toBeUndefined()
  })
})
