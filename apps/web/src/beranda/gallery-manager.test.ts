import { describe, expect, it } from 'vitest'

import {
  collectDownloadables,
  describeGalleryEntry,
  groupGalleryByAsset,
  type GalleryEntry,
} from './gallery-manager'

// Issue #26 (opsi B) — Galeri page model.
// The gallery is a permanent, faithful view of the browser-owned project
// folder: one section per asset, revisions newest-first, every prepared or
// approved revision downloadable, every raw source clearly not.

const RAW: GalleryEntry = {
  kind: 'source' as const,
  path: 'sources/kucing.jpeg',
  fileName: 'kucing.jpeg',
  sizeBytes: 967144,
}

const REV = (rev: number, overrides: Partial<GalleryEntry> = {}): GalleryEntry => ({
  kind: 'revision' as const,
  path: `revisions/asset-a/rev-${rev}.jpeg`,
  fileName: `rev-${rev}.jpeg`,
  sizeBytes: 2_400_000 + rev,
  assetId: 'asset-a',
  revision: rev,
  contentType: 'illustration',
  submissionFormat: 'jpeg',
  preparedAt: `2026-09-22T10:0${rev}:00Z`,
  ...overrides,
})

describe('gallery-manager (Galeri page model)', () => {
  it('collects only what is downloadable: prepared revisions and their metadata sidecars', () => {
    const entries: GalleryEntry[] = [
      RAW,
      REV(1),
      REV(2),
      { kind: 'metadata', path: 'metadata/asset-a/rev-2.json', fileName: 'rev-2.json', sizeBytes: 512, assetId: 'asset-a', revision: 2 },
      { kind: 'audit', path: 'audits/asset-a/rev-2.json', fileName: 'audit-2.json', sizeBytes: 2048, assetId: 'asset-a', revision: 2 },
    ]
    const downloads = collectDownloadables(entries)
    expect(downloads.map((entry) => entry.fileName)).toEqual(['rev-2.jpeg', 'rev-2.json', 'audit-2.json', 'rev-1.jpeg'])
    expect(downloads.some((entry) => entry.path === RAW.path)).toBe(false)
  })

  it('orders revisions newest-first inside each asset group', () => {
    const groups = groupGalleryByAsset([REV(1), REV(3), REV(2)])
    expect(groups.map((group) => group.assetId)).toEqual(['asset-a'])
    expect(groups[0]?.revisions.map((entry) => entry.revision)).toEqual([3, 2, 1])
  })

  it('empties honestly: a fresh project shows an empty state, not a fake grid', () => {
    const groups = groupGalleryByAsset([])
    expect(groups).toEqual([])
  })

  it('names the newest revision as current and exposes its approval state', () => {
    const described = describeGalleryEntry([REV(1), REV(2)], { assetId: 'asset-a', approvedRevision: 1 })
    expect(described.currentRevision).toBe(2)
    expect(described.approvedRevision).toBe(1)
    expect(described.currentIsApproved).toBe(false)
    const approved = describeGalleryEntry([REV(1), REV(2)], { assetId: 'asset-a', approvedRevision: 2 })
    expect(approved.currentIsApproved).toBe(true)
  })

  it('keeps human-readable sizes on entries for the permanent grid', () => {
    const described = describeGalleryEntry([REV(1)], { assetId: 'asset-a', approvedRevision: null })
    expect(described.entries[0]?.sizeLabel).toContain('MB')
  })
})
