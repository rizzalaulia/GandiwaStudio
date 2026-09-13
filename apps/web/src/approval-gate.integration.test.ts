import { describe, expect, it } from 'vitest'
import { evaluateApprovalGate, type ApprovalGateInput } from './approval-gate'
const checksum = 'a'.repeat(64)
const identity = '123e4567-e89b-12d3-a456-426614174000'
const audit = { schemaVersion: 1 as const, assetId: identity, revision: 2, submissionChecksum: checksum, metadataChecksum: checksum, rulesetId: 'adobe-stock-2026-09-08-v1', rulesetVersion: 'adobe-stock-2026-09-08-v1', findings: [], createdAt: '2026-09-13T00:00:00.000Z' }
const base = (): ApprovalGateInput => ({ assetId: identity, revision: 2, submissionChecksum: checksum, metadataChecksum: checksum, auditChecksum: checksum, rulesetId: audit.rulesetId, rulesetVersion: audit.rulesetVersion, metadataValid: true, audit })
describe('approval gate invalidation', () => {
  it('blocks a changed submission checksum', () => expect(evaluateApprovalGate({ ...base(), submissionChecksum: 'b'.repeat(64) }).status).toBe('STALE / BLOCKED'))
  it('keeps warning-only audits eligible for explicit approval', () => expect(evaluateApprovalGate({ ...base(), audit: { ...audit, findings: [{ ruleId: 'universal.visual-legal-screening', verdict: 'WARNING', message: 'review', evidence: {} }] } }).status).toBe('READY FOR HUMAN APPROVAL'))
  it('blocks generative metadata failure supplied by the caller', () => expect(evaluateApprovalGate({ ...base(), metadataValid: false }).status).toBe('NOT READY'))
})
