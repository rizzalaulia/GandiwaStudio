import { describe, expect, it } from 'vitest'
import { loadDurableAudit, saveDurableAudit } from './durable-audit-store'

/* eslint-disable @typescript-eslint/require-await */

type Node = { files: Map<string, { content: string }>; dirs: Map<string, Node> }
const node = (): Node => ({ files: new Map(), dirs: new Map() })
const directory = (root: Node) => ({ getDirectoryHandle: async (name: string, options?: { create?: boolean }) => { const existing = root.dirs.get(name); if (existing) return directory(existing); if (!options?.create) throw new DOMException('missing', 'NotFoundError'); const created = node(); root.dirs.set(name, created); return directory(created) }, getFileHandle: async (name: string, options?: { create?: boolean }) => { const existing = root.files.get(name); if (existing) return { getFile: async () => ({ text: async () => existing.content }), createWritable: async () => ({ write: async (value: string) => { existing.content = value }, close: async () => {} }) }; if (!options?.create) throw new DOMException('missing', 'NotFoundError'); const created = { content: '' }; root.files.set(name, created); return { getFile: async () => ({ text: async () => created.content }), createWritable: async () => ({ write: async (value: string) => { created.content = value }, close: async () => {} }) } } })
const id = '123e4567-e89b-12d3-a456-426614174000'
const audit = { schemaVersion: 1 as const, assetId: id, revision: 2, submissionChecksum: 'a'.repeat(64), rulesetId: 'adobe-stock-2026-09-08-v1', rulesetVersion: 'adobe-stock-2026-09-08-v1', findings: [], createdAt: '2026-09-13T00:00:00.000Z' }
describe('durable audit store', () => {
  it('saves and loads a durable audit snapshot with checksum', async () => { const root = node(); root.files.set('gandiwa-project.json', { content: '{}' }); root.dirs.set('reports', node()); const d = directory(root); const saved = await saveDurableAudit({ directory: d, manifestSnapshot: '{}', audit }); expect((await loadDurableAudit(d, id, 2))?.checksum).toHaveLength(64); expect(saved.audit).toEqual(audit) })
  it('returns missing when reports/audits does not exist', async () => { const root = node(); expect(await loadDurableAudit(directory(root), id, 2)).toBeUndefined() })
  it('rejects a changed manifest before writing', async () => { const root = node(); root.files.set('gandiwa-project.json', { content: 'changed' }); root.dirs.set('reports', node()); await expect(saveDurableAudit({ directory: directory(root), manifestSnapshot: '{}', audit })).rejects.toThrow(/manifest changed/) })
})
