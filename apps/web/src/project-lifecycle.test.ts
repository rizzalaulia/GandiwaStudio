import { describe, expect, it, vi } from 'vitest'

import {
  detectExternalManifestChange,
  openProject,
  type DirectoryHandleLike,
  type ProjectLifecycleDependencies,
} from './project-lifecycle'

const VALID_MANIFEST = {
  schema_version: 1,
  project_id: '6e9e0cd4-7b2e-46fc-84ad-5a40816bdca1',
  project_name: 'Burung Laut',
  assets: [],
}

class MemoryFile {
  constructor(private content: string) {}

  text(): Promise<string> {
    return Promise.resolve(this.content)
  }

  replace(content: string): void {
    this.content = content
  }
}

class MemoryDirectory implements DirectoryHandleLike {
  readonly files = new Map<string, MemoryFile>()
  readonly queryPermission = vi.fn(() => Promise.resolve<'prompt' | 'granted' | 'denied'>('prompt'))
  readonly requestPermission = vi.fn(() => Promise.resolve<'prompt' | 'granted' | 'denied'>('granted'))

  getFileHandle(name: string, options?: { create?: boolean }) {
    const file = this.files.get(name)
    if (file) return Promise.resolve({ getFile: () => Promise.resolve(file) })
    if (!options?.create) return Promise.reject(new DOMException('Not found', 'NotFoundError'))
    const created = new MemoryFile('')
    this.files.set(name, created)
    return Promise.resolve({ getFile: () => Promise.resolve(created) })
  }
}

function dependencies(directory: MemoryDirectory): ProjectLifecycleDependencies {
  return {
    pickDirectory: vi.fn(() => Promise.resolve(directory)),
    rememberDirectory: vi.fn(() => Promise.resolve()),
  }
}

describe('project lifecycle', () => {
  it('opens a valid project after recovering read permission and records its manifest snapshot', async () => {
    const directory = new MemoryDirectory()
    directory.files.set('gandiwa-project.json', new MemoryFile(JSON.stringify(VALID_MANIFEST)))
    const projectDependencies = dependencies(directory)

    await expect(openProject(projectDependencies)).resolves.toEqual({
      kind: 'opened',
      directory,
      manifest: VALID_MANIFEST,
      manifestSnapshot: JSON.stringify(VALID_MANIFEST),
    })
    expect(directory.queryPermission).toHaveBeenCalledWith({ mode: 'read' })
    expect(directory.requestPermission).toHaveBeenCalledWith({ mode: 'read' })
    expect(projectDependencies.rememberDirectory).toHaveBeenCalledWith(directory)
  })

  it('starts permission recovery immediately from the Reopen user action before awaiting project data', async () => {
    const directory = new MemoryDirectory()
    directory.files.set('gandiwa-project.json', new MemoryFile(JSON.stringify(VALID_MANIFEST)))
    const events: string[] = []
    directory.requestPermission.mockImplementationOnce(() => {
      events.push('request-permission')
      return Promise.resolve('granted')
    })

    const { reopenProjectFromUserGesture } = await import('./project-lifecycle')
    const result = reopenProjectFromUserGesture(directory)

    expect(events).toEqual(['request-permission'])
    await expect(result).resolves.toMatchObject({
      kind: 'opened',
      directory,
      manifest: VALID_MANIFEST,
    })
  })

  it('preloads the remembered directory without requesting permission', async () => {
    const directory = new MemoryDirectory()
    const { loadRememberedProject } = await import('./project-lifecycle')

    await expect(loadRememberedProject(() => Promise.resolve(directory))).resolves.toBe(directory)
    expect(directory.requestPermission).not.toHaveBeenCalled()
    expect(directory.queryPermission).not.toHaveBeenCalled()
  })

  it('keeps a valid project open while warning when local reopen storage fails', async () => {
    const directory = new MemoryDirectory()
    directory.files.set('gandiwa-project.json', new MemoryFile(JSON.stringify(VALID_MANIFEST)))
    const projectDependencies = dependencies(directory)
    vi.mocked(projectDependencies.rememberDirectory).mockRejectedValueOnce(new Error('IndexedDB quota exceeded'))

    await expect(openProject(projectDependencies)).resolves.toMatchObject({
      kind: 'opened',
      directory,
      manifest: VALID_MANIFEST,
      reopenWarning: 'The project opened, but local reopen access could not be remembered.',
    })
  })

  it('does not remember a folder when read permission recovery is denied', async () => {
    const directory = new MemoryDirectory()
    directory.requestPermission.mockResolvedValueOnce('denied')
    directory.files.set('gandiwa-project.json', new MemoryFile(JSON.stringify(VALID_MANIFEST)))
    const projectDependencies = dependencies(directory)

    await expect(openProject(projectDependencies)).resolves.toEqual({
      kind: 'error',
      message: 'Read permission was not granted for the selected project folder.',
    })
    expect(projectDependencies.rememberDirectory).not.toHaveBeenCalled()
  })

  it('rejects a newer manifest schema without remembering or modifying the selected folder', async () => {
    const directory = new MemoryDirectory()
    directory.files.set('gandiwa-project.json', new MemoryFile(JSON.stringify({ ...VALID_MANIFEST, schema_version: 2 })))
    const projectDependencies = dependencies(directory)

    await expect(openProject(projectDependencies)).resolves.toEqual({
      kind: 'error',
      message: 'This project uses a newer manifest schema and was not modified.',
    })
    expect(projectDependencies.rememberDirectory).not.toHaveBeenCalled()
  })

  it('rejects an unsupported older manifest schema as invalid without modifying the selected folder', async () => {
    const directory = new MemoryDirectory()
    directory.files.set('gandiwa-project.json', new MemoryFile(JSON.stringify({ ...VALID_MANIFEST, schema_version: 0 })))
    const projectDependencies = dependencies(directory)

    await expect(openProject(projectDependencies)).resolves.toEqual({
      kind: 'error',
      message: 'The project manifest is invalid and was not modified.',
    })
    expect(projectDependencies.rememberDirectory).not.toHaveBeenCalled()
  })

  it('reports an external manifest change instead of treating the stale snapshot as current', async () => {
    const directory = new MemoryDirectory()
    const file = new MemoryFile(JSON.stringify(VALID_MANIFEST))
    directory.files.set('gandiwa-project.json', file)
    const snapshot = JSON.stringify(VALID_MANIFEST)
    file.replace(JSON.stringify({ ...VALID_MANIFEST, project_name: 'Burung Senja' }))

    await expect(detectExternalManifestChange(directory, snapshot)).resolves.toEqual({
      kind: 'changed',
      manifest: { ...VALID_MANIFEST, project_name: 'Burung Senja' },
      manifestSnapshot: JSON.stringify({ ...VALID_MANIFEST, project_name: 'Burung Senja' }),
    })
  })
})
