import { describe, expect, it, vi } from 'vitest'

import {
  createProject,
  writeProjectManifestAtomically,
  type FileSystemDirectoryHandleLike,
  type ProjectCreationDependencies,
} from './project-filesystem'

class MemoryFile {
  content = ''
  readonly write = vi.fn((value: string) => {
    this.content = value
    return Promise.resolve()
  })
  readonly close = vi.fn(() => Promise.resolve())
}

class MemoryDirectory implements FileSystemDirectoryHandleLike {
  readonly directories = new Map<string, MemoryDirectory>()
  readonly files = new Map<string, MemoryFile>()
  onDirectoryLookup: ((name: string) => void) | undefined
  readonly removeEntry = vi.fn((name: string) => {
    this.directories.delete(name)
    this.files.delete(name)
    return Promise.resolve()
  })

  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MemoryDirectory> {
    this.onDirectoryLookup?.(name)
    const existing = this.directories.get(name)
    if (existing) return Promise.resolve(existing)
    if (!options?.create) return Promise.reject(new DOMException('Not found', 'NotFoundError'))
    const created = new MemoryDirectory()
    this.directories.set(name, created)
    return Promise.resolve(created)
  }

  getFileHandle(name: string, options?: { create?: boolean }) {
    const existing = this.files.get(name)
    if (existing) return Promise.resolve({ createWritable: () => Promise.resolve(existing) })
    if (!options?.create) return Promise.reject(new DOMException('Not found', 'NotFoundError'))
    const created = new MemoryFile()
    this.files.set(name, created)
    return Promise.resolve({ createWritable: () => Promise.resolve(created) })
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async *values(): AsyncIterable<unknown> {
    yield* this.directories.values()
    yield* this.files.values()
  }
}

function dependencies(parent: MemoryDirectory): ProjectCreationDependencies {
  return {
    pickDirectory: vi.fn(() => Promise.resolve(parent)),
    newId: () => '6e9e0cd4-7b2e-46fc-84ad-5a40816bdca1',
  }
}

describe('createProject', () => {
  it('creates the project structure and a valid empty manifest after form validation', async () => {
    const parent = new MemoryDirectory()

    const result = await createProject(
      {
        projectName: 'Burung Laut',
        contentType: 'illustration',
        creationMethod: 'generative_ai',
      },
      dependencies(parent),
    )

    expect(result).toEqual({
      kind: 'created',
      projectName: 'Burung Laut',
      contentType: 'illustration',
      creationMethod: 'generative_ai',
    })
    const project = parent
    expect(project).toBeDefined()
    expect([...project.directories.keys()].sort()).toEqual([
      'exports',
      'generated',
      'metadata',
      'previews',
      'reports',
      'revisions',
      'sources',
    ])
    expect([...project.directories.get('generated')!.directories.keys()].sort()).toEqual([
      'illustration',
      'photo',
      'vector',
    ])
    expect(JSON.parse(project.files.get('gandiwa-project.json')!.content)).toEqual({
      schema_version: 1,
      project_id: '6e9e0cd4-7b2e-46fc-84ad-5a40816bdca1',
      project_name: 'Burung Laut',
      assets: [],
    })
  })

  it('remembers the newly created project directory for browser-session reopen', async () => {
    const directory = new MemoryDirectory()
    const rememberDirectory = vi.fn(() => Promise.resolve())

    await expect(
      createProject(
        { projectName: 'Burung Laut', contentType: 'photo', creationMethod: 'camera' },
        { ...dependencies(directory), rememberDirectory },
      ),
    ).resolves.toMatchObject({ kind: 'created', projectName: 'Burung Laut' })
    expect(rememberDirectory).toHaveBeenCalledWith(directory)
  })

  it('reports a reopen warning but keeps the new project created when local handle storage fails', async () => {
    const directory = new MemoryDirectory()
    const rememberDirectory = vi.fn(() => Promise.reject(new Error('IndexedDB quota exceeded')))

    await expect(
      createProject(
        { projectName: 'Burung Laut', contentType: 'photo', creationMethod: 'camera' },
        { ...dependencies(directory), rememberDirectory },
      ),
    ).resolves.toMatchObject({
      kind: 'created',
      projectName: 'Burung Laut',
      reopenWarning: 'The project was created, but local reopen access could not be remembered.',
    })
    expect(directory.files.get('gandiwa-project.json')).toBeDefined()
  })

  it('rejects a non-empty selected folder before writing project data', async () => {
    const selectedFolder = new MemoryDirectory()
    selectedFolder.directories.set('existing-user-folder', new MemoryDirectory())

    await expect(
      createProject(
        { projectName: 'Burung Laut', contentType: 'photo', creationMethod: 'camera' },
        dependencies(selectedFolder),
      ),
    ).resolves.toEqual({
      kind: 'error',
      message: 'Choose an empty folder for a new Gandiwa project. No files were written.',
    })
    expect(selectedFolder.directories.has('existing-user-folder')).toBe(true)
    expect(selectedFolder.files).toEqual(new Map())
    expect(selectedFolder.removeEntry).not.toHaveBeenCalled()
  })

  it('fails closed without overwriting a manifest created after the empty-folder check', async () => {
    const selectedFolder = new MemoryDirectory()
    const existingManifest = new MemoryFile()
    existingManifest.content = '{"owned":"by-another-writer"}'
    selectedFolder.onDirectoryLookup = (name) => {
      if (name !== 'sources') return
      selectedFolder.onDirectoryLookup = undefined
      selectedFolder.files.set('gandiwa-project.json', existingManifest)
    }

    await expect(
      createProject(
        { projectName: 'Burung Laut', contentType: 'photo', creationMethod: 'camera' },
        dependencies(selectedFolder),
      ),
    ).resolves.toEqual({
      kind: 'error',
      message: 'Unable to finish the project. Inspect the selected folder before deleting or reusing it.',
    })
    expect(existingManifest.content).toBe('{"owned":"by-another-writer"}')
  })

  it('rejects an unsupported asset intent before asking for a folder', async () => {
    const parent = new MemoryDirectory()
    const projectDependencies = dependencies(parent)

    await expect(
      createProject(
        { projectName: 'Burung Laut', contentType: 'not-a-content-type' as never, creationMethod: 'camera' },
        projectDependencies,
      ),
    ).resolves.toEqual({ kind: 'error', message: 'Content type is not supported.' })
    expect(projectDependencies.pickDirectory).not.toHaveBeenCalled()
    expect(parent.directories).toEqual(new Map())
  })

  it('rejects an unsupported creation method before asking for a folder', async () => {
    const parent = new MemoryDirectory()
    const projectDependencies = dependencies(parent)

    await expect(
      createProject(
        { projectName: 'Burung Laut', contentType: 'photo', creationMethod: 'unsupported' as never },
        projectDependencies,
      ),
    ).resolves.toEqual({ kind: 'error', message: 'Creation method is not supported.' })
    expect(projectDependencies.pickDirectory).not.toHaveBeenCalled()
    expect(parent.directories).toEqual(new Map())
  })

  it('does not write any project data when the directory picker is cancelled', async () => {
    const parent = new MemoryDirectory()
    const pickDirectory = vi.fn(() => Promise.reject(new DOMException('User cancelled', 'AbortError')))

    await expect(
      createProject(
        { projectName: 'Burung Laut', contentType: 'photo', creationMethod: 'camera' },
        { pickDirectory, newId: () => '6e9e0cd4-7b2e-46fc-84ad-5a40816bdca1' },
      ),
    ).resolves.toEqual({ kind: 'cancelled' })
    expect(parent.directories).toEqual(new Map())
  })

  it('fails closed when temporary manifest cleanup cannot be confirmed', async () => {
    const directory = new MemoryDirectory()
    directory.removeEntry.mockRejectedValueOnce(new Error('cleanup unavailable'))

    await expect(
      writeProjectManifestAtomically(directory, {
        schema_version: 1,
        project_id: '6e9e0cd4-7b2e-46fc-84ad-5a40816bdca1',
        project_name: 'Burung Laut',
        assets: [],
      }),
    ).rejects.toThrow('Unable to remove the temporary project manifest.')
  })

  it('preserves a recovery workspace when a manifest write fails', async () => {
    const parent = new MemoryDirectory()
    const baseDependencies = dependencies(parent)
    const failingDependencies: ProjectCreationDependencies = {
      ...baseDependencies,
      writeManifest: vi.fn(() => Promise.reject(new Error('disk full'))),
    }

    await expect(
      createProject(
        { projectName: 'Burung Laut', contentType: 'vector', creationMethod: 'manual_digital' },
        failingDependencies,
      ),
    ).resolves.toEqual({
      kind: 'error',
      message: 'Unable to finish the project. Inspect the selected folder before deleting or reusing it.',
    })
    expect(parent.removeEntry).not.toHaveBeenCalled()
    expect(parent.directories.size).toBeGreaterThan(0)
  })
})
