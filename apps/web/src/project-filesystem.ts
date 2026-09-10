import {
  type ContentType,
  type CreationMethod,
  type ProjectManifest,
  validateProjectManifest,
} from '@gandiwa/contracts'

const PROJECT_MANIFEST_NAME = 'gandiwa-project.json'
const PROJECT_TEMP_PREFIX = '.gandiwa-project.'
const PROJECT_DIRECTORIES = ['sources', 'generated', 'revisions', 'previews', 'metadata', 'reports', 'exports'] as const
const GENERATED_CONTENT_DIRECTORIES = ['photo', 'illustration', 'vector'] as const
const PROJECT_NAME_LIMIT = 80
const CONTENT_TYPES: readonly ContentType[] = ['photo', 'illustration', 'vector']
const CREATION_METHODS: readonly CreationMethod[] = ['camera', 'manual_digital', 'generative_ai', 'mixed']

export type ProjectCreationInput = Readonly<{
  projectName: string
  contentType: ContentType
  creationMethod: CreationMethod
}>

export type ProjectCreationResult =
  | Readonly<{ kind: 'created'; projectName: string; contentType: ContentType; creationMethod: CreationMethod }>
  | Readonly<{ kind: 'cancelled' }>
  | Readonly<{ kind: 'error'; message: string }>

export interface FileSystemWritableFileStreamLike {
  write(data: string): Promise<void>
  close(): Promise<void>
}

export interface FileSystemFileHandleLike {
  createWritable(): Promise<FileSystemWritableFileStreamLike>
}

export interface FileSystemDirectoryHandleLike {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FileSystemDirectoryHandleLike>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandleLike>
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>
  values(): AsyncIterable<unknown>
}

export type ProjectCreationDependencies = Readonly<{
  pickDirectory: () => Promise<FileSystemDirectoryHandleLike>
  newId: () => string
  writeManifest?: (directory: FileSystemDirectoryHandleLike, manifest: ProjectManifest) => Promise<void>
}>

function isPickerCancellation(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === 'AbortError'
}

function normalizeProjectName(value: string): string {
  const projectName = value.trim()
  if (!projectName) throw new Error('Project name is required.')
  if (projectName.length > PROJECT_NAME_LIMIT) throw new Error(`Project name must be ${PROJECT_NAME_LIMIT} characters or fewer.`)
  if (projectName === '.' || projectName === '..' || projectName.includes('\\') || projectName.includes('/') || projectName.includes('\0')) {
    throw new Error('Project name cannot contain a path separator.')
  }
  return projectName
}

function validateAssetIntent(input: ProjectCreationInput): string | null {
  if (!CONTENT_TYPES.includes(input.contentType)) return 'Content type is not supported.'
  if (!CREATION_METHODS.includes(input.creationMethod)) return 'Creation method is not supported.'
  return null
}

function initialManifest(projectName: string, projectId: string): ProjectManifest {
  return validateProjectManifest({
    schema_version: 1,
    project_id: projectId,
    project_name: projectName,
    assets: [],
  })
}

async function assertFileIsAbsent(directory: FileSystemDirectoryHandleLike, name: string): Promise<void> {
  try {
    await directory.getFileHandle(name, { create: false })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'NotFoundError') return
    throw cause
  }
  throw new Error(`Refusing to overwrite existing file: ${name}`)
}

async function writeTextFile(directory: FileSystemDirectoryHandleLike, name: string, content: string): Promise<void> {
  const file = await directory.getFileHandle(name, { create: true })
  const stream = await file.createWritable()
  await stream.write(content)
  await stream.close()
}

export async function writeProjectManifestAtomically(
  directory: FileSystemDirectoryHandleLike,
  manifest: ProjectManifest,
): Promise<void> {
  const content = `${JSON.stringify(manifest, null, 2)}\n`
  const temporaryName = `${PROJECT_TEMP_PREFIX}${manifest.project_id}.tmp`

  let writeFailure: unknown
  try {
    await assertFileIsAbsent(directory, temporaryName)
    await writeTextFile(directory, temporaryName, content)
    // File System Access commits a writable stream only on close(). The API has
    // no portable rename, so a new project writes its final manifest last.
    await assertFileIsAbsent(directory, PROJECT_MANIFEST_NAME)
    await writeTextFile(directory, PROJECT_MANIFEST_NAME, content)
  } catch (cause) {
    writeFailure = cause
  }

  try {
    await directory.removeEntry(temporaryName)
  } catch {
    throw new Error('Unable to remove the temporary project manifest.')
  }
  if (writeFailure instanceof Error) throw writeFailure
  if (writeFailure) throw new Error('Unable to write the project manifest.')
}

async function createProjectStructure(directory: FileSystemDirectoryHandleLike): Promise<void> {
  for (const name of PROJECT_DIRECTORIES) {
    await directory.getDirectoryHandle(name, { create: true })
  }
  const generated = await directory.getDirectoryHandle('generated', { create: false })
  for (const name of GENERATED_CONTENT_DIRECTORIES) {
    await generated.getDirectoryHandle(name, { create: true })
  }
}

async function directoryIsEmpty(directory: FileSystemDirectoryHandleLike): Promise<boolean> {
  for await (const _entry of directory.values()) {
    return false
  }
  return true
}

export async function createProject(
  input: ProjectCreationInput,
  dependencies: ProjectCreationDependencies,
): Promise<ProjectCreationResult> {
  let projectName: string
  try {
    projectName = normalizeProjectName(input.projectName)
  } catch (cause) {
    return { kind: 'error', message: cause instanceof Error ? cause.message : 'Project details are invalid.' }
  }
  const assetIntentError = validateAssetIntent(input)
  if (assetIntentError) return { kind: 'error', message: assetIntentError }

  let manifest: ProjectManifest
  try {
    manifest = initialManifest(projectName, dependencies.newId())
  } catch {
    return { kind: 'error', message: 'Unable to prepare a valid project identity.' }
  }
  let projectDirectory: FileSystemDirectoryHandleLike
  try {
    projectDirectory = await dependencies.pickDirectory()
  } catch (cause) {
    if (isPickerCancellation(cause)) return { kind: 'cancelled' }
    return { kind: 'error', message: 'Unable to access the selected folder. No project was created.' }
  }

  try {
    if (!(await directoryIsEmpty(projectDirectory))) {
      return { kind: 'error', message: 'Choose an empty folder for a new Gandiwa project. No files were written.' }
    }
  } catch {
    return { kind: 'error', message: 'Unable to inspect the selected folder. No project was created.' }
  }

  try {
    await createProjectStructure(projectDirectory)
    await (dependencies.writeManifest ?? writeProjectManifestAtomically)(projectDirectory, manifest)
    return {
      kind: 'created',
      projectName,
      contentType: input.contentType,
      creationMethod: input.creationMethod,
    }
  } catch {
    return {
      kind: 'error',
      message: 'Unable to finish the project. Inspect the selected folder before deleting or reusing it.',
    }
  }
}

export function browserProjectCreationDependencies(): ProjectCreationDependencies {
  const picker = (window as Window & { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandleLike> }).showDirectoryPicker
  if (!picker) {
    throw new Error('This browser does not support local project folders. Use current Chrome or Edge.')
  }
  return {
    pickDirectory: () => picker.call(window),
    newId: () => crypto.randomUUID(),
  }
}
