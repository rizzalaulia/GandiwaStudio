export const PROJECT_MANIFEST_SCHEMA_VERSION = 1 as const

export type ContentType = 'photo' | 'illustration' | 'vector'
export type CreationMethod = 'camera' | 'manual_digital' | 'generative_ai' | 'mixed'
export type AssetFormat = 'png' | 'jpeg' | 'svg'

export type ProjectRevision = Readonly<{
  revision: number
  generation_format: AssetFormat
  working_format: AssetFormat
  master_format: AssetFormat
  submission_format: AssetFormat
  relative_path: string
}>

export type ProjectAsset = Readonly<{
  asset_id: string
  content_type: ContentType
  creation_method: CreationMethod
  revisions: readonly ProjectRevision[]
}>

export type ProjectManifest = Readonly<{
  schema_version: typeof PROJECT_MANIFEST_SCHEMA_VERSION
  project_id: string
  project_name: string
  assets: readonly ProjectAsset[]
}>

export type CreativeIndexEntry = Readonly<{
  asset_id: string
  content_type: ContentType
  revision: number
  relative_path: string
}>

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const FORMATS = new Set<AssetFormat>(['png', 'jpeg', 'svg'])
const CONTENT_TYPES = new Set<ContentType>(['photo', 'illustration', 'vector'])
const CREATION_METHODS = new Set<CreationMethod>(['camera', 'manual_digital', 'generative_ai', 'mixed'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${context} must be an object`)
  return value
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  context: string,
): void {
  const expectedKeys = new Set(expected)
  const actual = Object.keys(value)
  const missing = expected.filter((key) => !Object.hasOwn(value, key))
  const extra = actual.filter((key) => !expectedKeys.has(key))
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`${context} keys must be exact; missing=${missing.join(',')}, extra=${extra.join(',')}`)
  }
}

function requireString(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${context} must be a non-empty string`)
  }
  return value
}

function requireUuid(value: unknown, context: string): string {
  const rendered = requireString(value, context)
  if (!UUID_PATTERN.test(rendered)) throw new Error(`${context} must be a lowercase canonical UUID`)
  return rendered
}

function requireContentType(value: unknown, context: string): ContentType {
  const rendered = requireString(value, context)
  if (!CONTENT_TYPES.has(rendered as ContentType)) throw new Error(`${context} is invalid`)
  return rendered as ContentType
}

function requireFormat(value: unknown, context: string): AssetFormat {
  const rendered = requireString(value, context)
  if (!FORMATS.has(rendered as AssetFormat)) throw new Error(`${context} is invalid`)
  return rendered as AssetFormat
}

function requireCreationMethod(value: unknown, context: string): CreationMethod {
  const rendered = requireString(value, context)
  if (!CREATION_METHODS.has(rendered as CreationMethod)) throw new Error(`${context} is invalid`)
  return rendered as CreationMethod
}

function requireRelativePath(value: unknown, context: string): string {
  const path = requireString(value, context)
  if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path)) {
    throw new Error(`${context} must not be an absolute path`)
  }
  if (path.includes('\\')) throw new Error(`${context} must use portable '/' separators`)
  const segments = path.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment.includes('\0'))) {
    throw new Error(`${context} must be a normalized relative path`)
  }
  return path
}

function validateFormatRoute(contentType: ContentType, revision: Record<string, unknown>, context: string): void {
  const generation = requireFormat(revision.generation_format, `${context}.generation_format`)
  const working = requireFormat(revision.working_format, `${context}.working_format`)
  const master = requireFormat(revision.master_format, `${context}.master_format`)
  const submission = requireFormat(revision.submission_format, `${context}.submission_format`)

  if (contentType === 'vector') {
    if ([generation, working, master, submission].some((format) => format !== 'svg')) {
      throw new Error(`${context} vector revisions must use SVG for every format`)
    }
  } else if (contentType === 'photo') {
    if ([generation, working, master].includes('svg') || submission !== 'jpeg') {
      throw new Error(`${context} photo revisions require raster work and JPEG submission`)
    }
  } else if (generation === 'svg') {
    if ([generation, working, master, submission].some((format) => format !== 'svg')) {
      throw new Error(`${context} native-vector illustration revisions must use SVG throughout`)
    }
  } else if ([working, master].includes('svg') || submission !== 'jpeg') {
    throw new Error(`${context} raster illustration revisions require raster work and JPEG submission`)
  }

  const path = requireRelativePath(revision.relative_path, `${context}.relative_path`)
  if (!path.startsWith('revisions/')) throw new Error(`${context}.relative_path must stay inside revisions/`)
  if (!path.endsWith(`.${master}`)) {
    throw new Error(`${context}.relative_path extension must match master_format`)
  }
}

export function validateProjectManifest(value: unknown): ProjectManifest {
  const manifest = requireRecord(value, 'manifest')
  requireExactKeys(manifest, ['schema_version', 'project_id', 'project_name', 'assets'], 'manifest')
  if (manifest.schema_version !== PROJECT_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`manifest.schema_version must equal ${PROJECT_MANIFEST_SCHEMA_VERSION}`)
  }
  requireUuid(manifest.project_id, 'manifest.project_id')
  requireString(manifest.project_name, 'manifest.project_name')
  if (!Array.isArray(manifest.assets)) throw new Error('manifest.assets must be an array')

  const assetIds = new Set<string>()
  const paths = new Set<string>()
  for (const [assetIndex, rawAsset] of manifest.assets.entries()) {
    const assetContext = `manifest.assets[${assetIndex}]`
    const asset = requireRecord(rawAsset, assetContext)
    requireExactKeys(asset, ['asset_id', 'content_type', 'creation_method', 'revisions'], assetContext)
    const assetId = requireUuid(asset.asset_id, `${assetContext}.asset_id`)
    if (assetIds.has(assetId)) throw new Error(`${assetContext}.asset_id must be unique`)
    assetIds.add(assetId)
    const contentType = requireContentType(asset.content_type, `${assetContext}.content_type`)
    requireCreationMethod(asset.creation_method, `${assetContext}.creation_method`)
    if (!Array.isArray(asset.revisions) || asset.revisions.length === 0) {
      throw new Error(`${assetContext}.revisions must be a non-empty array`)
    }

    const revisions = new Set<number>()
    for (const [revisionIndex, rawRevision] of asset.revisions.entries()) {
      const revisionContext = `${assetContext}.revisions[${revisionIndex}]`
      const revision = requireRecord(rawRevision, revisionContext)
      requireExactKeys(
        revision,
        ['revision', 'generation_format', 'working_format', 'master_format', 'submission_format', 'relative_path'],
        revisionContext,
      )
      if (!Number.isInteger(revision.revision) || (revision.revision as number) < 1) {
        throw new Error(`${revisionContext}.revision must be a positive integer`)
      }
      const revisionNumber = revision.revision as number
      if (revisions.has(revisionNumber)) throw new Error(`${revisionContext}.revision must be unique per asset`)
      revisions.add(revisionNumber)
      validateFormatRoute(contentType, revision, revisionContext)
      const path = requireRelativePath(revision.relative_path, `${revisionContext}.relative_path`)
      if (paths.has(path)) throw new Error(`${revisionContext}.relative_path must be unique across the project`)
      paths.add(path)
    }
  }

  return value as ProjectManifest
}

export function rebuildCreativeIndex(value: unknown): readonly CreativeIndexEntry[] {
  const manifest = validateProjectManifest(value)
  return manifest.assets.flatMap((asset) =>
    asset.revisions.map((revision) => ({
      asset_id: asset.asset_id,
      content_type: asset.content_type,
      revision: revision.revision,
      relative_path: revision.relative_path,
    })),
  )
}
