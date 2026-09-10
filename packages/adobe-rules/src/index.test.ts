import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  ADOBE_STOCK_MVP_RULESET,
  createAuditRun,
  createRulesetSnapshot,
  evaluateFixtureCorpus,
} from './index.js'

type FixtureCase = Readonly<{
  id: string
  source_url: string
  asset_revision_id: string
  asset_checksum: string
  findings: readonly { rule_id: string; verdict: 'PASS' | 'WARNING' | 'FAIL'; evidence: Record<string, unknown> }[]
  export_gate: 'CLEAR' | 'BLOCKED'
}>

type FixtureCorpus = Readonly<{
  ruleset_id: string
  cases: readonly FixtureCase[]
}>

async function readFixtureCorpus(): Promise<FixtureCorpus> {
  const file = new URL('../fixtures/adobe-stock-mvp.json', import.meta.url)
  return JSON.parse(await readFile(file, 'utf8')) as FixtureCorpus
}

test('preserves every official source listed in the locked Adobe ruleset', () => {
  assert.deepEqual(
    ADOBE_STOCK_MVP_RULESET.sources.map((source) => source.url),
    [
      'https://helpx.adobe.com/stock/contributor/content-policies-guidelines/content-policies/content-upload-guidelines.html',
      'https://helpx.adobe.com/stock/contributor/submit-your-content/submit-generative-ai-content/generative-ai-content-guidelines.html',
      'https://helpx.adobe.com/stock/contributor/submit-your-content/submit-generative-ai-content/adobe-stock-generative-ai-faq.html',
      'https://helpx.adobe.com/stock/contributor/submit-your-content/submit-vectors/technical-requirements-for-vector-submissions.html',
    ],
  )
})

test('binds a deterministic blocking FAIL to one revision, ruleset, and checksum', () => {
  const snapshot = createRulesetSnapshot(ADOBE_STOCK_MVP_RULESET)

  const run = createAuditRun({
    snapshot,
    asset_revision_id: 'revision-0001',
    asset_checksum: 'a'.repeat(64),
    findings: [
      {
        rule_id: 'photo.submission-format',
        verdict: 'FAIL',
        evidence: { actual_format: 'png', required_format: 'jpeg' },
      },
    ],
  })

  assert.equal(run.asset_revision_id, 'revision-0001')
  assert.equal(run.ruleset_id, 'adobe-stock-2026-09-08-v1')
  assert.equal(run.asset_checksum, 'a'.repeat(64))
  assert.deepEqual(run.findings[0], {
    rule_id: 'photo.submission-format',
    rule_version: 'adobe-stock-2026-09-08-v1',
    source: {
      url: 'https://helpx.adobe.com/stock/contributor/content-policies-guidelines/content-policies/content-upload-guidelines.html',
      retrieved_on: '2026-09-08',
      version: 'adobe-stock-2026-09-08-v1',
    },
    evaluator_type: 'deterministic_postcheck',
    verdict: 'FAIL',
    severity: 'error',
    blocks_export: true,
    evidence: { actual_format: 'png', required_format: 'jpeg' },
  })
  assert.equal(run.export_gate, 'BLOCKED')
})

test('evaluates every sourced synthetic fixture with a deterministic result', async () => {
  const corpus = await readFixtureCorpus()
  const snapshot = createRulesetSnapshot(ADOBE_STOCK_MVP_RULESET)

  assert.equal(corpus.ruleset_id, snapshot.ruleset_id)
  assert.deepEqual(corpus.cases.map((fixture) => fixture.id), ADOBE_STOCK_MVP_RULESET.fixture_ids)
  assert.equal(evaluateFixtureCorpus(snapshot, corpus.cases), corpus.cases.length)

  for (const fixture of corpus.cases) {
    assert.ok(
      snapshot.rules.some((rule) => rule.source.url === fixture.source_url),
      `${fixture.id} must name an official ruleset source`,
    )
    const run = createAuditRun({
      snapshot,
      asset_revision_id: fixture.asset_revision_id,
      asset_checksum: fixture.asset_checksum,
      findings: fixture.findings,
    })
    assert.equal(run.export_gate, fixture.export_gate, fixture.id)
  }
})

test('rejects a ruleset snapshot when a rule has no sourced fixture', () => {
  const unsourced = {
    ...ADOBE_STOCK_MVP_RULESET,
    fixture_ids: ADOBE_STOCK_MVP_RULESET.fixture_ids.filter((id) => id !== 'svg-empty-path'),
  }

  assert.throws(() => createRulesetSnapshot(unsourced), /sourced fixture/i)
})

test('rejects a rule whose source metadata diverges from the declared ruleset source', () => {
  const rules = ADOBE_STOCK_MVP_RULESET.rules.map((rule) => ({
    ...rule,
    applies_to: [...rule.applies_to],
    fixture_ids: [...rule.fixture_ids],
    source: { ...rule.source },
  }))
  rules[0]!.source.retrieved_on = '2026-09-09'

  assert.throws(
    () => createRulesetSnapshot({ ...ADOBE_STOCK_MVP_RULESET, rules }),
    /rule source is absent from ruleset/i,
  )
})

test('freezes the job snapshot so later ruleset mutations cannot change a bound audit', () => {
  const mutableRuleset = {
    ...ADOBE_STOCK_MVP_RULESET,
    rules: ADOBE_STOCK_MVP_RULESET.rules.map((rule) => ({
      ...rule,
      applies_to: [...rule.applies_to],
      fixture_ids: [...rule.fixture_ids],
      source: { ...rule.source },
    })),
  }
  const snapshot = createRulesetSnapshot(mutableRuleset)
  mutableRuleset.rules[3]!.blocks_export = false

  const run = createAuditRun({
    snapshot,
    asset_revision_id: 'revision-immutable-snapshot',
    asset_checksum: 'c'.repeat(64),
    findings: [{ rule_id: 'photo.submission-format', verdict: 'FAIL', evidence: {} }],
  })

  assert.equal(run.findings[0]?.blocks_export, true)
  assert.equal(run.export_gate, 'BLOCKED')
})

test('rejects a corpus when a rule claims a fixture that never exercises that rule', async () => {
  const corpus = await readFixtureCorpus()
  const snapshot = createRulesetSnapshot(ADOBE_STOCK_MVP_RULESET)
  const borrowedFixtureRule = {
    ...snapshot.rules[0]!,
    id: 'universal.fixture-coverage-regression',
    fixture_ids: ['photo-jpeg-below-4mp'],
  }
  const alteredSnapshot = {
    ...snapshot,
    rules: [...snapshot.rules, borrowedFixtureRule],
  }

  assert.throws(() => evaluateFixtureCorpus(alteredSnapshot, corpus.cases), /does not exercise rule/i)
})

test('keeps warning-only and AI review findings clear of the deterministic export gate', () => {
  const snapshot = createRulesetSnapshot(ADOBE_STOCK_MVP_RULESET)
  const run = createAuditRun({
    snapshot,
    asset_revision_id: 'revision-warning-only',
    asset_checksum: 'b'.repeat(64),
    findings: [
      { rule_id: 'vector.node-count', verdict: 'WARNING', evidence: { nodes: 100001 } },
      { rule_id: 'universal.visual-legal-screening', verdict: 'WARNING', evidence: { confidence: 0.7 } },
    ],
  })

  assert.equal(run.export_gate, 'CLEAR')
})
