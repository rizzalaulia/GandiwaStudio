// Issue #26 (opsi B) — Galeri page model.
// The gallery is a permanent, faithful view of the browser-owned project
// folder: one group per asset, revisions newest-first. Downloadable = the
// prepared submission file + metadata/audit sidecars. Raw sources are shown
// for context but never offered for download.

export type GalleryEntryKind = 'source' | 'revision' | 'metadata' | 'audit'

export type GalleryEntry = Readonly<{
  kind: GalleryEntryKind
  path: string
  fileName: string
  sizeBytes?: number
  assetId?: string
  revision?: number
  contentType?: string
  submissionFormat?: string
  preparedAt?: string
}>

export type DownloadableEntry = GalleryEntry & Readonly<{ sizeLabel: string }>

export type GalleryAssetGroup = Readonly<{
  assetId: string
  currentRevision: number | null
  approvedRevision: number | null
  currentIsApproved: boolean
  revisions: GalleryEntry[]
  source: GalleryEntry | null
  meta: GalleryEntry[]
}>

function formatBytes(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) {
    return '—'
  }
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function collectDownloadables(
  entries: ReadonlyArray<GalleryEntry>,
): DownloadableEntry[] {
  const downloadables = entries.filter((entry) => entry.kind !== 'source')
  const labelled = downloadables.map((entry) => ({
    ...entry,
    sizeLabel: formatBytes(entry.sizeBytes),
  }))
  return labelled.sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0))
}

export function groupGalleryByAsset(
  entries: ReadonlyArray<GalleryEntry>,
): GalleryAssetGroup[] {
  const byAsset = new Map<string, GalleryEntry[]>()
  for (const entry of entries) {
    if (entry.kind === 'source') {
      continue
    }
    const assetId = entry.assetId
    if (!assetId) {
      continue
    }
    const bucket = byAsset.get(assetId) ?? []
    bucket.push(entry)
    byAsset.set(assetId, bucket)
  }
  const groups: GalleryAssetGroup[] = []
  for (const [assetId, bucket] of byAsset) {
    const revisions = bucket
      .filter((entry) => entry.kind === 'revision')
      .sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0))
    const source = bucket.find((entry) => entry.kind === 'source') ?? null
    const meta = bucket.filter((entry) => entry.kind !== 'revision')
    const currentRevision = revisions.length > 0 ? revisions[0]!.revision ?? null : null
    groups.push({
      assetId,
      currentRevision,
      approvedRevision: null,
      currentIsApproved: false,
      revisions,
      source,
      meta,
    })
  }
  return groups.sort((a, b) => a.assetId.localeCompare(b.assetId))
}

export function describeGalleryEntry(
  entries: ReadonlyArray<GalleryEntry>,
  context: { assetId: string; approvedRevision: number | null },
): {
  currentRevision: number | null
  approvedRevision: number | null
  currentIsApproved: boolean
  entries: DownloadableEntry[]
} {
  const revisions = entries.filter(
    (entry) => entry.kind === 'revision' && entry.assetId === context.assetId,
  )
  const sorted = revisions.sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0))
  const currentRevision = sorted.length > 0 ? sorted[0]!.revision ?? null : null
  const approvedRevision = context.approvedRevision
  return {
    currentRevision,
    approvedRevision,
    currentIsApproved: currentRevision !== null && currentRevision === approvedRevision,
    entries: collectDownloadables(entries),
  }
}
