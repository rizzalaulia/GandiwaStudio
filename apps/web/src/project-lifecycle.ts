import { type ProjectManifest, validateProjectManifest } from '@gandiwa/contracts'

import { loadRememberedProjectDirectory, rememberProjectDirectory } from './project-handle-store'

const PROJECT_MANIFEST_NAME = 'gandiwa-project.json'

type PermissionStateLike = 'granted' | 'denied' | 'prompt'

export interface FileLike {
  text(): Promise<string>
}

export interface FileHandleLike {
  getFile(): Promise<FileLike>
}

export interface DirectoryHandleLike {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>
  queryPermission(descriptor: { mode: 'read' }): Promise<PermissionStateLike>
  requestPermission(descriptor: { mode: 'read' }): Promise<PermissionStateLike>
}

export type ProjectLifecycleDependencies = Readonly<{
  pickDirectory: () => Promise<DirectoryHandleLike>
  rememberDirectory: (directory: DirectoryHandleLike) => Promise<void>
}>

export type OpenProjectResult =
  | Readonly<{
    kind: 'opened'
    directory: DirectoryHandleLike
    manifest: ProjectManifest
    manifestSnapshot: string
    reopenWarning?: string
  }>
  | Readonly<{ kind: 'cancelled' }>
  | Readonly<{ kind: 'error'; message: string }>

export type ExternalManifestChange =
  | Readonly<{ kind: 'unchanged' }>
  | Readonly<{ kind: 'changed'; manifest: ProjectManifest; manifestSnapshot: string }>
  | Readonly<{ kind: 'error'; message: string }>

function isPickerCancellation(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === 'AbortError'
}

async function recoverReadPermission(directory: DirectoryHandleLike): Promise<boolean> {
  const descriptor = { mode: 'read' } as const
  if (await directory.queryPermission(descriptor) === 'granted') return true
  return (await directory.requestPermission(descriptor)) === 'granted'
}

async function readManifest(directory: DirectoryHandleLike): Promise<Readonly<{ manifest: ProjectManifest; snapshot: string }>> {
  const file = await directory.getFileHandle(PROJECT_MANIFEST_NAME, { create: false })
  const snapshot = await (await file.getFile()).text()
  let parsed: unknown
  try {
    parsed = JSON.parse(snapshot)
  } catch {
    throw new Error('The project manifest is not valid JSON and was not modified.')
  }
  if (
    typeof parsed === 'object'
    && parsed !== null
    && 'schema_version' in parsed
    && typeof (parsed as { schema_version?: unknown }).schema_version === 'number'
    && Number.isInteger((parsed as { schema_version: number }).schema_version)
    && (parsed as { schema_version: number }).schema_version > 1
  ) {
    throw new Error('This project uses a newer manifest schema and was not modified.')
  }
  try {
    return { manifest: validateProjectManifest(parsed), snapshot }
  } catch {
    throw new Error('The project manifest is invalid and was not modified.')
  }
}

export async function reopenProject(directory: DirectoryHandleLike): Promise<OpenProjectResult> {
  try {
    if (!(await recoverReadPermission(directory))) {
      return { kind: 'error', message: 'Read permission was not granted for the selected project folder.' }
    }
    const { manifest, snapshot } = await readManifest(directory)
    return { kind: 'opened', directory, manifest, manifestSnapshot: snapshot }
  } catch (cause) {
    return { kind: 'error', message: cause instanceof Error ? cause.message : 'Unable to reopen the project without modifying it.' }
  }
}

export async function reopenProjectFromUserGesture(directory: DirectoryHandleLike): Promise<OpenProjectResult> {
  const permission = directory.requestPermission({ mode: 'read' })
  try {
    if ((await permission) !== 'granted') {
      return { kind: 'error', message: 'Read permission was not granted for the remembered project folder.' }
    }
    const { manifest, snapshot } = await readManifest(directory)
    return { kind: 'opened', directory, manifest, manifestSnapshot: snapshot }
  } catch (cause) {
    return { kind: 'error', message: cause instanceof Error ? cause.message : 'Unable to reopen the project without modifying it.' }
  }
}

export async function loadRememberedProject(
  loadDirectory: () => Promise<DirectoryHandleLike | undefined> = () => loadRememberedProjectDirectory<DirectoryHandleLike>(),
): Promise<DirectoryHandleLike | undefined> {
  return loadDirectory()
}

export async function openProject(dependencies: ProjectLifecycleDependencies): Promise<OpenProjectResult> {
  let directory: DirectoryHandleLike
  try {
    directory = await dependencies.pickDirectory()
  } catch (cause) {
    if (isPickerCancellation(cause)) return { kind: 'cancelled' }
    return { kind: 'error', message: 'Unable to access the selected project folder.' }
  }

  const result = await reopenProject(directory)
  if (result.kind !== 'opened') return result
  try {
    await dependencies.rememberDirectory(directory)
    return result
  } catch {
    return { ...result, reopenWarning: 'The project opened, but local reopen access could not be remembered.' }
  }
}

export async function detectExternalManifestChange(
  directory: DirectoryHandleLike,
  manifestSnapshot: string,
): Promise<ExternalManifestChange> {
  try {
    const { manifest, snapshot } = await readManifest(directory)
    if (snapshot === manifestSnapshot) return { kind: 'unchanged' }
    return { kind: 'changed', manifest, manifestSnapshot: snapshot }
  } catch (cause) {
    return { kind: 'error', message: cause instanceof Error ? cause.message : 'Unable to read the current project manifest.' }
  }
}

export function browserProjectLifecycleDependencies(): ProjectLifecycleDependencies {
  const picker = (window as Window & { showDirectoryPicker?: () => Promise<DirectoryHandleLike> }).showDirectoryPicker
  if (!picker) throw new Error('This browser does not support local project folders. Use current Chrome or Edge.')
  return {
    pickDirectory: () => picker.call(window),
    rememberDirectory: (directory) => rememberProjectDirectory(directory),
  }
}
