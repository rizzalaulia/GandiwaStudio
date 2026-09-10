export const ADOBE_STOCK_MVP_RULESET_ID = 'adobe-stock-2026-09-08-v1' as const

export type ContentType = 'photo' | 'illustration' | 'vector'
export type EvaluatorType = 'prompt' | 'deterministic_postcheck' | 'ai_review' | 'human_confirmation'
export type Severity = 'error' | 'warning' | 'info'
export type Verdict = 'PASS' | 'WARNING' | 'FAIL'
export type ExportGate = 'CLEAR' | 'BLOCKED'

export type RuleSource = Readonly<{
  url: string
  retrieved_on: string
  version: string
}>

export type RuleDefinition = Readonly<{
  id: string
  applies_to: readonly ContentType[]
  source: RuleSource
  evaluator_type: EvaluatorType
  severity: Severity
  blocks_export: boolean
  fixture_ids: readonly string[]
}>

export type Ruleset = Readonly<{
  id: string
  version: string
  sources: readonly RuleSource[]
  rules: readonly RuleDefinition[]
  fixture_ids: readonly string[]
}>

export type RulesetSnapshot = Readonly<{
  ruleset_id: string
  ruleset_version: string
  rules: readonly RuleDefinition[]
}>

export type AuditFindingInput = Readonly<{
  rule_id: string
  verdict: Verdict
  evidence: Readonly<Record<string, unknown>>
}>

export type AuditFinding = Readonly<AuditFindingInput & {
  rule_version: string
  source: RuleSource
  evaluator_type: EvaluatorType
  severity: Severity
  blocks_export: boolean
}>

export type AuditRun = Readonly<{
  asset_revision_id: string
  ruleset_id: string
  ruleset_version: string
  asset_checksum: string
  findings: readonly AuditFinding[]
  export_gate: ExportGate
}>

const UPLOAD_GUIDELINES: RuleSource = {
  url: 'https://helpx.adobe.com/stock/contributor/content-policies-guidelines/content-policies/content-upload-guidelines.html',
  retrieved_on: '2026-09-08',
  version: ADOBE_STOCK_MVP_RULESET_ID,
}

const GENERATIVE_AI_GUIDELINES: RuleSource = {
  url: 'https://helpx.adobe.com/stock/contributor/submit-your-content/submit-generative-ai-content/generative-ai-content-guidelines.html',
  retrieved_on: '2026-09-08',
  version: ADOBE_STOCK_MVP_RULESET_ID,
}

const GENERATIVE_AI_FAQ: RuleSource = {
  url: 'https://helpx.adobe.com/stock/contributor/submit-your-content/submit-generative-ai-content/adobe-stock-generative-ai-faq.html',
  retrieved_on: '2026-09-08',
  version: ADOBE_STOCK_MVP_RULESET_ID,
}

const VECTOR_TECHNICAL_REQUIREMENTS: RuleSource = {
  url: 'https://helpx.adobe.com/stock/contributor/submit-your-content/submit-vectors/technical-requirements-for-vector-submissions.html',
  retrieved_on: '2026-09-08',
  version: ADOBE_STOCK_MVP_RULESET_ID,
}

const RULE_FIXTURES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'universal.readable-file': ['jpeg-corrupt', 'revision-after-approval'],
  'universal.mime-matches-format': ['mime-extension-mismatch'],
  'universal.generated-ai-disclosure': ['metadata-ai-missing-disclosure'],
  'photo.submission-format': ['photo-png-requires-conversion'],
  'photo.minimum-megapixels': ['photo-jpeg-below-4mp', 'photo-jpeg-at-least-4mp'],
  'photo.jpeg-alpha': ['photo-jpeg-at-least-4mp'],
  'illustration-raster.submission-format': ['illustration-raster-submission'],
  'illustration-raster.minimum-megapixels': ['illustration-raster-submission'],
  'vector.submission-format': ['svg-valid-simple'],
  'vector.valid-document': ['svg-valid-simple', 'svg-invalid-viewbox'],
  'vector.no-raster': ['svg-embedded-raster'],
  'vector.no-active-content': ['svg-script', 'svg-event-handler'],
  'vector.no-external-resource': ['svg-external-url'],
  'vector.no-live-text': ['svg-live-text'],
  'vector.no-empty-path': ['svg-empty-path'],
  'vector.resolved-references': ['svg-valid-simple', 'svg-broken-reference'],
  'vector.node-count': ['vector-node-threshold'],
  'universal.visual-legal-screening': ['ai-visual-legal-screening'],
})

function rule(
  id: string,
  appliesTo: readonly ContentType[],
  source: RuleSource,
  evaluatorType: EvaluatorType,
  severity: Severity,
  blocksExport: boolean,
): RuleDefinition {
  const fixtureIds = RULE_FIXTURES[id]
  if (fixtureIds === undefined || fixtureIds.length === 0) throw new Error(`rule requires sourced fixture: ${id}`)
  return Object.freeze({
    id,
    applies_to: Object.freeze([...appliesTo]),
    source: Object.freeze({ ...source }),
    evaluator_type: evaluatorType,
    severity,
    blocks_export: blocksExport,
    fixture_ids: Object.freeze([...fixtureIds]),
  })
}

const RULES: readonly RuleDefinition[] = Object.freeze([
  rule('universal.readable-file', ['photo', 'illustration', 'vector'], UPLOAD_GUIDELINES, 'deterministic_postcheck', 'error', true),
  rule('universal.mime-matches-format', ['photo', 'illustration', 'vector'], UPLOAD_GUIDELINES, 'deterministic_postcheck', 'error', true),
  rule('universal.generated-ai-disclosure', ['photo', 'illustration', 'vector'], GENERATIVE_AI_GUIDELINES, 'human_confirmation', 'error', true),
  rule('photo.submission-format', ['photo'], UPLOAD_GUIDELINES, 'deterministic_postcheck', 'error', true),
  rule('photo.minimum-megapixels', ['photo'], UPLOAD_GUIDELINES, 'deterministic_postcheck', 'error', true),
  rule('photo.jpeg-alpha', ['photo'], UPLOAD_GUIDELINES, 'deterministic_postcheck', 'error', true),
  rule('illustration-raster.submission-format', ['illustration'], UPLOAD_GUIDELINES, 'deterministic_postcheck', 'error', true),
  rule('illustration-raster.minimum-megapixels', ['illustration'], UPLOAD_GUIDELINES, 'deterministic_postcheck', 'error', true),
  rule('vector.submission-format', ['illustration', 'vector'], VECTOR_TECHNICAL_REQUIREMENTS, 'deterministic_postcheck', 'error', true),
  rule('vector.valid-document', ['illustration', 'vector'], VECTOR_TECHNICAL_REQUIREMENTS, 'deterministic_postcheck', 'error', true),
  rule('vector.no-raster', ['illustration', 'vector'], VECTOR_TECHNICAL_REQUIREMENTS, 'deterministic_postcheck', 'error', true),
  rule('vector.no-active-content', ['illustration', 'vector'], VECTOR_TECHNICAL_REQUIREMENTS, 'deterministic_postcheck', 'error', true),
  rule('vector.no-external-resource', ['illustration', 'vector'], VECTOR_TECHNICAL_REQUIREMENTS, 'deterministic_postcheck', 'error', true),
  rule('vector.no-live-text', ['illustration', 'vector'], VECTOR_TECHNICAL_REQUIREMENTS, 'deterministic_postcheck', 'error', true),
  rule('vector.no-empty-path', ['illustration', 'vector'], VECTOR_TECHNICAL_REQUIREMENTS, 'deterministic_postcheck', 'error', true),
  rule('vector.resolved-references', ['illustration', 'vector'], VECTOR_TECHNICAL_REQUIREMENTS, 'deterministic_postcheck', 'error', true),
  rule('vector.node-count', ['illustration', 'vector'], VECTOR_TECHNICAL_REQUIREMENTS, 'deterministic_postcheck', 'warning', false),
  rule('universal.visual-legal-screening', ['photo', 'illustration', 'vector'], UPLOAD_GUIDELINES, 'ai_review', 'warning', false),
])

export const ADOBE_STOCK_MVP_RULESET: Ruleset = Object.freeze({
  id: ADOBE_STOCK_MVP_RULESET_ID,
  version: ADOBE_STOCK_MVP_RULESET_ID,
  sources: Object.freeze([UPLOAD_GUIDELINES, GENERATIVE_AI_GUIDELINES, GENERATIVE_AI_FAQ, VECTOR_TECHNICAL_REQUIREMENTS].map((source) => Object.freeze({ ...source }))),
  rules: RULES,
  fixture_ids: Object.freeze([
    'photo-jpeg-below-4mp',
    'photo-jpeg-at-least-4mp',
    'photo-png-requires-conversion',
    'jpeg-corrupt',
    'mime-extension-mismatch',
    'svg-valid-simple',
    'svg-embedded-raster',
    'svg-script',
    'svg-event-handler',
    'svg-external-url',
    'svg-live-text',
    'svg-broken-reference',
    'svg-invalid-viewbox',
    'svg-empty-path',
    'revision-after-approval',
    'metadata-ai-missing-disclosure',
    'illustration-raster-submission',
    'vector-node-threshold',
    'ai-visual-legal-screening',
  ]),
})

function requireNonEmptyString(value: string, name: string): void {
  if (value.length === 0) throw new Error(`${name} must be a non-empty string`)
}

function requireChecksum(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('asset_checksum must be a lowercase SHA-256 checksum')
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value)) deepFreeze(nested)
  }
  return value
}

export function createRulesetSnapshot(ruleset: Ruleset): RulesetSnapshot {
  requireNonEmptyString(ruleset.id, 'ruleset.id')
  requireNonEmptyString(ruleset.version, 'ruleset.version')
  if (ruleset.sources.length === 0 || ruleset.fixture_ids.length === 0 || ruleset.rules.length === 0) {
    throw new Error('ruleset requires sources, rules, and sourced fixtures')
  }
  const ruleIds = new Set<string>()
  for (const definition of ruleset.rules) {
    requireNonEmptyString(definition.id, 'rule.id')
    if (ruleIds.has(definition.id)) throw new Error(`duplicate rule id: ${definition.id}`)
    ruleIds.add(definition.id)
    if (!ruleset.sources.some(
      (source) => source.url === definition.source.url
        && source.retrieved_on === definition.source.retrieved_on
        && source.version === definition.source.version,
    )) {
      throw new Error(`rule source is absent from ruleset: ${definition.id}`)
    }
    if (definition.fixture_ids.length === 0 || definition.fixture_ids.some((id) => !ruleset.fixture_ids.includes(id))) {
      throw new Error(`rule requires sourced fixture: ${definition.id}`)
    }
  }
  return deepFreeze({
    ruleset_id: ruleset.id,
    ruleset_version: ruleset.version,
    rules: ruleset.rules.map((definition) => ({
      ...definition,
      applies_to: [...definition.applies_to],
      fixture_ids: [...definition.fixture_ids],
      source: { ...definition.source },
    })),
  })
}

export type FixtureExpectation = Readonly<{
  id: string
  source_url: string
  asset_revision_id: string
  asset_checksum: string
  findings: readonly AuditFindingInput[]
  export_gate: ExportGate
}>

export function evaluateFixtureCorpus(snapshot: RulesetSnapshot, fixtures: readonly FixtureExpectation[]): number {
  const expectedFixtureIds = new Set(snapshot.rules.flatMap((rule) => rule.fixture_ids))
  const actualFixtureIds = new Set<string>()
  for (const fixture of fixtures) {
    requireNonEmptyString(fixture.id, 'fixture.id')
    if (actualFixtureIds.has(fixture.id)) throw new Error(`duplicate fixture id: ${fixture.id}`)
    actualFixtureIds.add(fixture.id)
    const referencedRules = fixture.findings.map((finding) => snapshot.rules.find((rule) => rule.id === finding.rule_id))
    if (referencedRules.some((rule) => rule === undefined)) throw new Error(`fixture references an unknown rule: ${fixture.id}`)
    if (!referencedRules.some((rule) => rule?.source.url === fixture.source_url)) {
      throw new Error(`fixture source does not match a referenced rule: ${fixture.id}`)
    }
    const run = createAuditRun({
      snapshot,
      asset_revision_id: fixture.asset_revision_id,
      asset_checksum: fixture.asset_checksum,
      findings: fixture.findings,
    })
    if (run.export_gate !== fixture.export_gate) throw new Error(`fixture gate mismatch: ${fixture.id}`)
  }
  if (expectedFixtureIds.size !== actualFixtureIds.size || [...expectedFixtureIds].some((id) => !actualFixtureIds.has(id))) {
    throw new Error('ruleset requires sourced fixture changes')
  }
  const fixtureById = new Map(fixtures.map((fixture) => [fixture.id, fixture]))
  for (const rule of snapshot.rules) {
    for (const fixtureId of rule.fixture_ids) {
      const fixture = fixtureById.get(fixtureId)
      if (fixture === undefined || fixture.source_url !== rule.source.url) {
        throw new Error(`fixture source is missing for rule: ${rule.id}`)
      }
      if (!fixture.findings.some((finding) => finding.rule_id === rule.id)) {
        throw new Error(`fixture does not exercise rule: ${rule.id}`)
      }
    }
  }
  return fixtures.length
}

export function createAuditRun(input: Readonly<{
  snapshot: RulesetSnapshot
  asset_revision_id: string
  asset_checksum: string
  findings: readonly AuditFindingInput[]
}>): AuditRun {
  requireNonEmptyString(input.asset_revision_id, 'asset_revision_id')
  requireChecksum(input.asset_checksum)
  const ruleById = new Map(input.snapshot.rules.map((definition) => [definition.id, definition]))
  const findings = input.findings.map((finding) => {
    const definition = ruleById.get(finding.rule_id)
    if (definition === undefined) throw new Error(`finding references unknown rule: ${finding.rule_id}`)
    if (!['PASS', 'WARNING', 'FAIL'].includes(finding.verdict)) throw new Error(`finding verdict is invalid: ${finding.verdict}`)
    return {
      rule_id: definition.id,
      rule_version: definition.source.version,
      source: deepFreeze({ ...definition.source }),
      evaluator_type: definition.evaluator_type,
      verdict: finding.verdict,
      severity: definition.severity,
      blocks_export: definition.blocks_export,
      evidence: deepFreeze({ ...finding.evidence }),
    }
  })
  return deepFreeze({
    asset_revision_id: input.asset_revision_id,
    ruleset_id: input.snapshot.ruleset_id,
    ruleset_version: input.snapshot.ruleset_version,
    asset_checksum: input.asset_checksum,
    findings,
    export_gate: findings.some((finding) => finding.verdict === 'FAIL' && finding.blocks_export) ? 'BLOCKED' : 'CLEAR',
  })
}
