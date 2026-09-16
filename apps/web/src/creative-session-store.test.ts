import { describe, expect, it } from 'vitest'

import {
  loadCreativeSession,
  saveCreativeSession,
  type CreativeSessionDirectory,
} from './creative-session-store'

class File {
  content = ''
  getFile() { return Promise.resolve({ text: () => Promise.resolve(this.content) }) }
  createWritable() { return Promise.resolve({ write: (value: string) => { this.content = value; return Promise.resolve() }, close: () => Promise.resolve() }) }
}
class Directory implements CreativeSessionDirectory {
  directories = new Map<string, Directory>()
  files = new Map<string, File>()
  getDirectoryHandle(name: string, options?: { create?: boolean }) { const found = this.directories.get(name); if (found) return Promise.resolve(found); if (!options?.create) return Promise.reject(new DOMException('missing', 'NotFoundError')); const made = new Directory(); this.directories.set(name, made); return Promise.resolve(made) }
  getFileHandle(name: string, options?: { create?: boolean }) { const found = this.files.get(name); if (found) return Promise.resolve(found); if (!options?.create) return Promise.reject(new DOMException('missing', 'NotFoundError')); const made = new File(); this.files.set(name, made); return Promise.resolve(made) }
}

const session = {
  schemaVersion: 1 as const,
  sessionId: '123e4567-e89b-12d3-a456-426614174000',
  topic: 'Ceramic mug still life',
  rounds: [{ questions: ['Who is the buyer?', 'What mood?', 'Where is the light?'], recommendation: 'Use one hero object.', humanAnswer: 'Warm editorial', createdAt: '2026-09-16T00:00:00Z', model: '9router-reasoning' }],
  prompt: { promptText: 'Ceramic mug on linen, 2400x1667', negativePrompt: 'logo, brand, watermark, random text', contentType: 'photo', creationMethod: 'generative_ai', providerId: 'fal.ai', modelId: 'fal-ai/flux/dev', targetWidth: 2400, targetHeight: 1667, aspectRatio: '3:2', orientation: 'landscape', stockConstraints: ['no_logo', 'no_brand', 'no_watermark', 'no_random_text', 'no_fake_ui', 'no_unintentional_crop', 'no_malformed_anatomy', 'no_copyrighted_property'], negativeSpaceDecision: 'right third open' },
  approvals: [],
  revisions: [],
} as const

describe('creative session sidecar', () => {
  it('writes a versioned project-local sidecar without changing the manifest', async () => {
    const root = new Directory(); const manifest = new File(); manifest.content = '{"project":"snapshot"}'; root.files.set('gandiwa-project.json', manifest)
    const saved = await saveCreativeSession({ directory: root, manifestSnapshot: manifest.content, session, sidecarSnapshot: undefined })
    expect(manifest.content).toBe('{"project":"snapshot"}')
    expect(saved.checksum).toMatch(/^[0-9a-f]{64}$/)
    expect(root.directories.get('creative-sessions')!.files.get(`${session.sessionId}.json`)!.content).toContain('Ceramic mug still life')
  })

  it('loads only a valid versioned sidecar and preserves exact snapshot', async () => {
    const root = new Directory(); const folder = new Directory(); root.directories.set('creative-sessions', folder); const file = new File(); file.content = `${JSON.stringify(session)}\n`; folder.files.set(`${session.sessionId}.json`, file)
    const loaded = await loadCreativeSession(root, session.sessionId)
    expect(loaded?.session).toEqual(session)
    expect(loaded?.snapshot).toBe(file.content)
  })

  it('refuses external sidecar or manifest changes before durable write', async () => {
    const root = new Directory(); const manifest = new File(); manifest.content = '{"project":"snapshot"}'; root.files.set('gandiwa-project.json', manifest); const folder = new Directory(); root.directories.set('creative-sessions', folder); const file = new File(); file.content = `${JSON.stringify(session)}\n`; folder.files.set(`${session.sessionId}.json`, file)
    await expect(saveCreativeSession({ directory: root, manifestSnapshot: manifest.content, session, sidecarSnapshot: undefined })).rejects.toThrow('creative session changed externally')
    const loaded = await loadCreativeSession(root, session.sessionId)
    file.content = `${JSON.stringify({ ...session, topic: 'external' })}\n`
    await expect(saveCreativeSession({ directory: root, manifestSnapshot: manifest.content, session, sidecarSnapshot: loaded!.snapshot })).rejects.toThrow('creative session changed externally')
    expect(file.content).toContain('external')
  })

  it('rejects corrupt, noncanonical, or incomplete 3-in-1 sidecars without rewriting them', async () => {
    const root = new Directory(); const folder = new Directory(); root.directories.set('creative-sessions', folder); const file = new File(); file.content = '{bad'; folder.files.set(`${session.sessionId}.json`, file)
    await expect(loadCreativeSession(root, session.sessionId)).rejects.toThrow('saved creative session is invalid')
    expect(file.content).toBe('{bad')
    file.content = `${JSON.stringify({ ...session, rounds: [{ ...session.rounds[0], questions: ['only one'] }] })}\n`
    await expect(loadCreativeSession(root, session.sessionId)).rejects.toThrow('saved creative session is invalid')
    expect(file.content).toContain('only one')
    file.content = `${JSON.stringify({ ...session, approvals: [{ stage: 'prompt', human: 'Guru' }] })}\n`
    await expect(loadCreativeSession(root, session.sessionId)).rejects.toThrow('saved creative session is invalid')
    expect(file.content).toContain('"prompt"')
    file.content = `${JSON.stringify({ ...session, revisions: [{ revisionId: 'revision-1', promptDigest: 'digest', providerId: 'fal.ai', modelId: 'fal-ai/flux/dev', providerJobId: 'job-1', adapterVersion: 'adapter/1', createdAt: '2026-09-16T00:00:00Z' }] })}\n`
    await expect(loadCreativeSession(root, session.sessionId)).rejects.toThrow('saved creative session is invalid')
    expect(file.content).toContain('"revision-1"')
    file.content = `${JSON.stringify({ ...session, prompt: { ...session.prompt, contentType: undefined, orientation: undefined, stockConstraints: undefined } })}\n`
    await expect(loadCreativeSession(root, session.sessionId)).rejects.toThrow('saved creative session is invalid')
    expect(file.content).toContain('Ceramic mug on linen')
    file.content = `${JSON.stringify({ ...session, prompt: { ...session.prompt, stockConstraints: [] } })}\n`
    await expect(loadCreativeSession(root, session.sessionId)).rejects.toThrow('saved creative session is invalid')
    file.content = `${JSON.stringify({ ...session, revisions: [{ revisionId: 'revision-1', promptDigest: 'digest', providerId: 'fal.ai', modelId: 'fal-ai/flux/dev', providerJobId: 'job-1', adapterVersion: 'adapter/1', parameters: {}, createdAt: '2026-09-16T00:00:00Z' }] })}\n`
    await expect(loadCreativeSession(root, session.sessionId)).rejects.toThrow('saved creative session is invalid')
    await expect(loadCreativeSession(root, 'not-a-uuid')).rejects.toThrow('session ID is invalid')
  })
})
