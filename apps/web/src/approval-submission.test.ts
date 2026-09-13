import { describe, expect, it } from 'vitest'
import { resolveApprovalSubmission } from './approval-submission'

/* eslint-disable @typescript-eslint/require-await */

const id = '123e4567-e89b-12d3-a456-426614174000'
const revision = { revision: 2, generation_format: 'jpeg' as const, working_format: 'jpeg' as const, master_format: 'jpeg' as const, submission_format: 'jpeg' as const, relative_path: 'revisions/123/2/master.jpeg' }
const manifest = { schema_version: 1 as const, project_id: id, project_name: 'Test', assets: [{ asset_id: id, content_type: 'photo' as const, creation_method: 'camera' as const, revisions: [revision] }] }
type Node = { files: Map<string, File>; dirs: Map<string, Node> }
const node = (): Node => ({ files: new Map(), dirs: new Map() })
const directory = (root: Node) => ({ getDirectoryHandle: async (name: string) => { const found = root.dirs.get(name); if (!found) throw new DOMException('missing', 'NotFoundError'); return directory(found) }, getFileHandle: async (name: string) => { const file = root.files.get(name); if (!file) throw new DOMException('missing', 'NotFoundError'); return { getFile: async () => file } } }) as never
const metadata = JSON.stringify({ schemaVersion: 1, title: 'Bird', keywords: ['bird', 'sky', 'sea', 'light', 'nature'], category: 'animals', contentType: 'photo', creationMethod: 'camera', generatedWithAi: false, aiDisclosure: '', releaseStatus: 'not_required' })
describe('approval submission resolver', () => {
  it('reads nested revision bytes and computes actual checksum', async () => { const root = node(); root.files.set('gandiwa-project.json', new File(['manifest'], 'gandiwa-project.json')); const bytes = new Uint8Array([1, 2, 3]); const revisions = node(); const asset = node(); const number = node(); number.files.set('master.jpeg', new File([bytes], 'master.jpeg', { type: 'image/jpeg' })); asset.dirs.set('2', number); revisions.dirs.set('123', asset); root.dirs.set('revisions', revisions); const metadataDirectory = node(); metadataDirectory.files.set(`${id}.json`, new File([metadata], `${id}.json`)); root.dirs.set('metadata', metadataDirectory); const result = await resolveApprovalSubmission({ directory: directory(root), manifest, manifestSnapshot: 'manifest', assetId: id, revision: 2 }); expect(result.path).toBe('revisions/123/2/master.jpeg'); expect(result.submissionChecksum).toHaveLength(64); expect(result.file.size).toBe(3) })
  it('rejects traversal paths', async () => { const root = node(); root.files.set('gandiwa-project.json', new File(['manifest'], 'gandiwa-project.json')); const badManifest = { schema_version: 1 as const, project_id: id, project_name: 'Test', assets: [{ asset_id: id, content_type: 'photo' as const, creation_method: 'camera' as const, revisions: [{ revision: 2, generation_format: 'jpeg' as const, working_format: 'jpeg' as const, master_format: 'jpeg' as const, submission_format: 'jpeg' as const, relative_path: 'revisions/../secret.jpeg' }] }] }; await expect(resolveApprovalSubmission({ directory: directory(root), manifest: badManifest, manifestSnapshot: 'manifest', assetId: id, revision: 2 })).rejects.toThrow(/path is invalid/) })
})
