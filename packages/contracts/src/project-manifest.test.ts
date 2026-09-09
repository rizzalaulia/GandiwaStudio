import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { rebuildCreativeIndex, validateProjectManifest } from './index.js'

type ConformanceCase = { fixture: string; valid: boolean }
type ConformanceSuite = { schema_version: number; cases: ConformanceCase[] }

const fixturesUrl = new URL('../../../tests/fixtures/project-manifest/', import.meta.url)

async function readJson<T>(name: string): Promise<T> {
  const content = await readFile(new URL(name, fixturesUrl), 'utf8')
  return JSON.parse(content) as T
}

test('accepts and rejects exactly the shared project manifest fixture corpus', async () => {
  const suite = await readJson<ConformanceSuite>('conformance.json')

  assert.equal(suite.schema_version, 1)
  for (const testCase of suite.cases) {
    const fixture = await readJson<unknown>(testCase.fixture)
    if (testCase.valid) {
      assert.doesNotThrow(() => validateProjectManifest(fixture), testCase.fixture)
    } else {
      assert.throws(() => validateProjectManifest(fixture), testCase.fixture)
    }
  }
})

test('rejects an absolute revision path before any folder-boundary check', async () => {
  const manifest = await readJson<unknown>('invalid-absolute-path.json')

  assert.throws(
    () => validateProjectManifest(manifest),
    /must not be an absolute path/,
  )
})

test('rebuilds only the creative index from a valid manifest', async () => {
  const manifest = await readJson<unknown>('valid-minimal.json')

  assert.deepEqual(rebuildCreativeIndex(manifest), [
    {
      asset_id: 'd6293da2-343a-4e85-98f3-29e2d1a04aa7',
      content_type: 'illustration',
      revision: 1,
      relative_path: 'revisions/d6293da2-343a-4e85-98f3-29e2d1a04aa7/0001/master.png',
    },
  ])
})
