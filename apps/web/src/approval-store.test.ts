/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it } from 'vitest'
import { loadApproval, saveApproval } from './approval-store'

type Node = { files: Map<string, { content: string }>; dirs: Map<string, Node> }
const node = (): Node => ({ files: new Map(), dirs: new Map() })
const directory = (root: Node) => ({
  getDirectoryHandle: async (name: string, options?: { create?: boolean }) => {
    const found = root.dirs.get(name)
    if (!found && !options?.create) throw new DOMException('missing', 'NotFoundError')
    const child = found ?? node()
    root.dirs.set(name, child)
    return directory(child)
  },
  getFileHandle: async (name: string, options?: { create?: boolean }) => {
    const found = root.files.get(name)
    if (!found && !options?.create) throw new DOMException('missing', 'NotFoundError')
    const file = found ?? { content: '' }
    root.files.set(name, file)
    return {
      getFile: async () => ({ text: async () => file.content }),
      createWritable: async () => ({ write: async (content: string) => { file.content = content }, close: async () => undefined }),
    }
  },
})
const id = '123e4567-e89b-12d3-a456-426614174000'
const record = { schemaVersion: 1 as const, status: 'APPROVED' as const, assetId: id, revision: 2, submissionChecksum: 'a'.repeat(64), metadataChecksum: 'b'.repeat(64), auditChecksum: 'c'.repeat(64), rulesetId: 'adobe-stock-2026-09-08-v1', rulesetVersion: 'adobe-stock-2026-09-08-v1', approvedAt: '2026-09-13T00:00:00.000Z', statementVersion: 1 as const }

describe('approval store', () => {
  it('does not create reports or approvals while loading a missing record', async () => {
    const root = node()
    root.files.set('gandiwa-project.json', { content: '{}' })
    const result = await loadApproval(directory(root), id, 2)
    expect(result).toBeUndefined()
    expect(root.dirs.has('reports')).toBe(false)
  })

  it('creates and loads an approval with an exact snapshot', async () => {
    const root = node()
    root.files.set('gandiwa-project.json', { content: '{}' })
    root.dirs.set('reports', node())
    root.dirs.set('metadata', node())
    root.dirs.get('metadata')!.files.set(`${id}.json`, { content: 'metadata' })
    root.dirs.get('reports')!.dirs.set('audits', node())
    root.dirs.get('reports')!.dirs.get('audits')!.files.set(`${id}-r2.json`, { content: 'audit' })
    const saved = await saveApproval({ directory: directory(root), manifestSnapshot: '{}', metadataSnapshot: 'metadata', auditSnapshot: 'audit', record })
    expect((await loadApproval(directory(root), id, 2))?.snapshot).toBe(saved.snapshot)
  })

  it('refuses approval when current metadata or audit evidence differs from its bound snapshots', async () => {
    const root = node()
    root.files.set('gandiwa-project.json', { content: '{}' })
    root.dirs.set('reports', node())
    root.dirs.set('metadata', node())
    root.dirs.get('metadata')!.files.set(`${id}.json`, { content: 'metadata changed externally' })
    root.dirs.get('reports')!.dirs.set('audits', node())
    root.dirs.get('reports')!.dirs.get('audits')!.files.set(`${id}-r2.json`, { content: 'audit changed externally' })
    await expect(saveApproval({ directory: directory(root), manifestSnapshot: '{}', metadataSnapshot: 'metadata', auditSnapshot: 'audit', record })).rejects.toThrow(/evidence changed externally/)
  })

  it('refuses to overwrite an approval without its exact snapshot', async () => {
    const root = node()
    root.files.set('gandiwa-project.json', { content: '{}' })
    root.dirs.set('reports', node())
    root.dirs.set('metadata', node())
    root.dirs.get('metadata')!.files.set(`${id}.json`, { content: 'metadata' })
    root.dirs.get('reports')!.dirs.set('audits', node())
    root.dirs.get('reports')!.dirs.get('audits')!.files.set(`${id}-r2.json`, { content: 'audit' })
    const d = directory(root)
    const saved = await saveApproval({ directory: d, manifestSnapshot: '{}', metadataSnapshot: 'metadata', auditSnapshot: 'audit', record })
    await expect(saveApproval({ directory: d, manifestSnapshot: '{}', metadataSnapshot: 'metadata', auditSnapshot: 'audit', record: { ...record, approvedAt: '2026-09-13T00:00:01.000Z' }, existingSnapshot: `${saved.snapshot}changed` })).rejects.toThrow(/changed externally/)
  })
})
