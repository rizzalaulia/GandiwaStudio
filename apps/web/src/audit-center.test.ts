import { describe, expect, it } from 'vitest'

import { buildAuditCenter, fileAuditIdentity, verdictForFinding, type AuditCenterInput } from './audit-center'

const baseInput = (): AuditCenterInput => ({
  assetRevisionId: 'revision-1',
  assetChecksum: 'a'.repeat(64),
  rulesetId: 'adobe-stock-2026-09-08-v1',
  rulesetVersion: 'adobe-stock-2026-09-08-v1',
  findings: [
    {
      ruleId: 'vector.no-raster',
      verdict: 'FAIL',
      message: 'Raster image detected.',
      evidence: { element: 'image', count: 1 },
    },
  ],
})

describe('fileAuditIdentity', () => {
  it('binds the audit to the file bytes with a lowercase SHA-256 checksum', async () => {
    const file = new File(['hello'], 'asset.svg', { lastModified: 123 })
    const identity = await fileAuditIdentity(file)
    expect(identity.checksum).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
    expect(identity.revisionId).toContain(identity.checksum.slice(0, 16))
  })
})

describe('verdictForFinding', () => {
  it('keeps non-blocking node-count failures as warnings', () => {
    expect(verdictForFinding('vector.node-count', 'fail')).toBe('WARNING')
  })
})

describe('buildAuditCenter', () => {
  it('enriches findings with ruleset, evidence, and remediation', () => {
    const result = buildAuditCenter(baseInput())
    expect(result.status).toBe('FAIL')
    expect(result.exportGate).toBe('BLOCKED')
    expect(result.ruleset).toEqual({ id: baseInput().rulesetId, version: baseInput().rulesetVersion })
    expect(result.findings[0]).toMatchObject({
      ruleId: 'vector.no-raster',
      evidence: { element: 'image', count: 1 },
      blocksExport: true,
    })
    expect(result.findings[0]?.remediation).toContain('Remove')
  })

  it('keeps warning and pass findings visible without blocking export', () => {
    const input = baseInput()
    const result = buildAuditCenter({
      ...input,
      findings: [
        { ruleId: 'vector.node-count', verdict: 'WARNING', message: 'Many nodes.', evidence: { nodes: 10001 } },
        { ruleId: 'vector.valid-document', verdict: 'PASS', message: 'Valid.', evidence: { parser: 'lxml' } },
      ],
    })
    expect(result.status).toBe('WARNING')
    expect(result.exportGate).toBe('CLEAR')
    expect(result.findings.map((finding) => finding.ruleId)).toEqual(['vector.node-count', 'vector.valid-document'])
  })

  it('marks an audit stale when revision or checksum no longer matches', () => {
    const result = buildAuditCenter({ ...baseInput(), currentAssetRevisionId: 'revision-2', currentAssetChecksum: 'b'.repeat(64) })
    expect(result.status).toBe('STALE')
    expect(result.exportGate).toBe('BLOCKED')
    expect(result.staleReason).toContain('revision')
    expect(result.staleReason).toContain('checksum')
  })

  it('exposes a text status label independent of color', () => {
    const result = buildAuditCenter(baseInput())
    expect(result.statusLabel).toBe('FAIL — export blocked')
    expect(result.ariaLabel).toContain('FAIL')
    expect(result.ariaLabel).toContain('export blocked')
  })
})
