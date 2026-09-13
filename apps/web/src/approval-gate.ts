import { ADOBE_STOCK_MVP_RULESET, ADOBE_STOCK_MVP_RULESET_ID } from '@gandiwa/adobe-rules'

export type AuditFinding = Readonly<{ ruleId: string; verdict: 'PASS' | 'WARNING' | 'FAIL'; message: string; evidence: Readonly<Record<string, unknown>> }>
export type DurableAuditSnapshot = Readonly<{ schemaVersion: 1; assetId: string; revision: number; submissionChecksum: string; metadataChecksum: string; rulesetId: string; rulesetVersion: string; findings: readonly AuditFinding[]; createdAt: string }>
export type ApprovalRecord = Readonly<{ schemaVersion: 1; status: 'APPROVED'; assetId: string; revision: number; submissionChecksum: string; metadataChecksum: string; auditChecksum: string; rulesetId: string; rulesetVersion: string; approvedAt: string; statementVersion: 1 }>
export type ApprovalGateInput = Readonly<{ assetId: string; revision: number; submissionChecksum: string; metadataChecksum: string; auditChecksum: string; rulesetId: string; rulesetVersion: string; metadataValid: boolean; audit?: DurableAuditSnapshot; approval?: ApprovalRecord }>
export type ApprovalGateResult = Readonly<{ status: 'NOT READY' | 'READY FOR HUMAN APPROVAL' | 'APPROVED / ADOBE-READY' | 'STALE / BLOCKED'; adobeReady: boolean; exportGate: 'BLOCKED' | 'CLEAR'; reasons: readonly string[] }>
const HEX = /^[a-f0-9]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/
const APPROVAL_KEYS = ['schemaVersion', 'status', 'assetId', 'revision', 'submissionChecksum', 'metadataChecksum', 'auditChecksum', 'rulesetId', 'rulesetVersion', 'approvedAt', 'statementVersion'] as const
const AUDIT_KEYS = ['schemaVersion', 'assetId', 'revision', 'submissionChecksum', 'metadataChecksum', 'rulesetId', 'rulesetVersion', 'findings', 'createdAt'] as const
const FINDING_KEYS = ['ruleId', 'verdict', 'message', 'evidence'] as const
function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key)) }
function validFinding(value: unknown): value is AuditFinding {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const finding = value as Record<string, unknown>
  return hasExactKeys(finding, FINDING_KEYS) && typeof finding.ruleId === 'string' && (finding.verdict === 'PASS' || finding.verdict === 'WARNING' || finding.verdict === 'FAIL') && typeof finding.message === 'string' && typeof finding.evidence === 'object' && finding.evidence !== null && !Array.isArray(finding.evidence)
}
function validAudit(value: unknown): value is DurableAuditSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const audit = value as Record<string, unknown>
  return hasExactKeys(audit, AUDIT_KEYS) && audit.schemaVersion === 1 && typeof audit.assetId === 'string' && UUID.test(audit.assetId) && Number.isInteger(audit.revision) && (audit.revision as number) > 0 && typeof audit.submissionChecksum === 'string' && HEX.test(audit.submissionChecksum) && typeof audit.metadataChecksum === 'string' && HEX.test(audit.metadataChecksum) && audit.rulesetId === ADOBE_STOCK_MVP_RULESET_ID && audit.rulesetVersion === ADOBE_STOCK_MVP_RULESET_ID && Array.isArray(audit.findings) && audit.findings.every(validFinding) && typeof audit.createdAt === 'string' && ISO.test(audit.createdAt)
}
function validApproval(value: unknown): value is ApprovalRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== APPROVAL_KEYS.length || !APPROVAL_KEYS.every((key) => Object.hasOwn(record, key))) return false
  return record.schemaVersion === 1 && record.status === 'APPROVED' && record.statementVersion === 1
    && typeof record.assetId === 'string' && UUID.test(record.assetId)
    && Number.isInteger(record.revision) && (record.revision as number) > 0
    && typeof record.submissionChecksum === 'string' && HEX.test(record.submissionChecksum)
    && typeof record.metadataChecksum === 'string' && HEX.test(record.metadataChecksum)
    && typeof record.auditChecksum === 'string' && HEX.test(record.auditChecksum)
    && record.rulesetId === ADOBE_STOCK_MVP_RULESET_ID && record.rulesetVersion === ADOBE_STOCK_MVP_RULESET_ID
    && typeof record.approvedAt === 'string' && ISO.test(record.approvedAt)
}
export function evaluateApprovalGate(i: ApprovalGateInput): ApprovalGateResult {
  const reasons: string[] = []
  if (i.approval && !validApproval(i.approval)) reasons.push('Approval record is malformed or invalid.')
  const a = i.audit
  const auditValid = !a || validAudit(a)
  if (a && !auditValid) reasons.push('Audit snapshot is malformed or invalid.')
  if (!i.metadataValid) reasons.push('Metadata is missing or invalid.')
  if (!a) reasons.push('No durable audit snapshot exists.')
  else if (auditValid) {
    if (a.assetId !== i.assetId || a.revision !== i.revision || a.submissionChecksum !== i.submissionChecksum || a.metadataChecksum !== i.metadataChecksum) reasons.push('Audit is stale or does not match the current submission and metadata.')
    if (a.rulesetId !== i.rulesetId || a.rulesetVersion !== i.rulesetVersion || a.rulesetId !== ADOBE_STOCK_MVP_RULESET_ID) reasons.push('Audit ruleset does not match the locked ruleset.')
    for (const finding of a.findings) {
      const definition = ADOBE_STOCK_MVP_RULESET.rules.find((rule) => rule.id === finding.ruleId)
      if (!definition) reasons.push(`Audit contains an unknown ruleset finding: ${finding.ruleId}.`)
      else if (finding.verdict === 'FAIL' && definition.blocks_export) reasons.push(`Audit contains a blocking FAIL: ${finding.ruleId}.`)
    }
  }
  if (![i.submissionChecksum, i.metadataChecksum, i.auditChecksum].every((x) => HEX.test(x))) reasons.push('A required checksum is invalid.')
  const p = i.approval
  const exact = !!p && p.schemaVersion === 1 && p.status === 'APPROVED' && p.statementVersion === 1 && p.assetId === i.assetId && p.revision === i.revision && p.submissionChecksum === i.submissionChecksum && p.metadataChecksum === i.metadataChecksum && p.auditChecksum === i.auditChecksum && p.rulesetId === i.rulesetId && p.rulesetVersion === i.rulesetVersion
  if (p && !exact) reasons.push('Existing approval is stale or does not match the current evidence.')
  if (reasons.length) return { status: p ? 'STALE / BLOCKED' : (reasons.some((r) => r.includes('stale') || r.includes('ruleset') || r.includes('FAIL') || r.includes('malformed')) ? 'STALE / BLOCKED' : 'NOT READY'), adobeReady: false, exportGate: 'BLOCKED', reasons }
  if (!exact) return { status: 'READY FOR HUMAN APPROVAL', adobeReady: false, exportGate: 'BLOCKED', reasons: ['Explicit human approval is required.'] }
  return { status: 'APPROVED / ADOBE-READY', adobeReady: true, exportGate: 'CLEAR', reasons: [] }
}
