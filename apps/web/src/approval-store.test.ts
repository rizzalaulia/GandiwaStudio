import { describe, expect, it } from 'vitest'
import { loadApproval, saveApproval } from './approval-store'

/* eslint-disable @typescript-eslint/require-await */
type Node = { files: Map<string, { content: string }>; dirs: Map<string, Node> }
const node = (): Node => ({ files: new Map(), dirs: new Map() })
const handle = (root: Node, name: string, create = false) => {
  const file = root.files.get(name)
  if (file) return Promise.resolve({ getFile: async () => ({ text: async () => file.content }), createWritable: async () => ({ write: async (value: string) => { file.content = value }, close: async () => {} }) })
  if (!create) return Promise.reject(new DOMException('missing', 'NotFoundError'))
  const created = { content: '' }; root.files.set(name, created)
  return Promise.resolve({ getFile: async () => ({ text: async () => created.content }), createWritable: async () => ({ write: async (value: string) => { created.content = value }, close: async () => {} }) })
}
const directory = (root: Node) => ({ getDirectoryHandle: async (name: string, options?: { create?: boolean }) => { const existing = root.dirs.get(name); if (existing) return directory(existing); if (!options?.create) throw new DOMException('missing', 'NotFoundError'); const created = node(); root.dirs.set(name, created); return directory(created) }, getFileHandle: (name: string, options?: { create?: boolean }) => handle(root, name, options?.create) })
const id = '123e4567-e89b-12d3-a456-426614174000'
const record = { schemaVersion: 1 as const, status: 'APPROVED' as const, assetId: id, revision: 2, submissionChecksum: 'a'.repeat(64), metadataChecksum: 'b'.repeat(64), auditChecksum: 'c'.repeat(64), rulesetId: 'adobe-stock-2026-09-08-v1', rulesetVersion: 'adobe-stock-2026-09-08-v1', approvedAt: '2026-09-13T00:00:00.000Z', statementVersion: 1 as const }
describe('approval store', () => {
  it('saves and loads a validated approval record', async () => { const root = node(); root.files.set('gandiwa-project.json', { content: '{}' }); root.dirs.set('reports', node()); const d = directory(root); const saved = await saveApproval({ directory: d, manifestSnapshot: '{}', record }); expect((await loadApproval(d, id, 2))?.record).toEqual(saved.record) })
  it('refuses a changed manifest before saving', async () => { const root = node(); root.files.set('gandiwa-project.json', { content: 'changed' }); await expect(saveApproval({ directory: directory(root), manifestSnapshot: '{}', record })).rejects.toThrow(/manifest changed/) })
  it('refuses to overwrite an approval without its exact snapshot', async () => { const root = node(); root.files.set('gandiwa-project.json', { content: '{}' }); root.dirs.set('reports', node()); const d = directory(root); await saveApproval({ directory: d, manifestSnapshot: '{}', record }); await expect(saveApproval({ directory: d, manifestSnapshot: '{}', record })).rejects.toThrow(/changed externally/) })
})
