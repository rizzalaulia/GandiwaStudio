import { ADOBE_STOCK_MVP_RULESET_ID } from '@gandiwa/adobe-rules'

export type AuditFinding = Readonly<{ ruleId: string; verdict: 'PASS' | 'WARNING' | 'FAIL'; message: string; evidence: Readonly<Record<string, unknown>> }>
export type DurableAuditSnapshot = Readonly<{ schemaVersion: 1; assetId: string; revision: number; submissionChecksum: string; rulesetId: string; rulesetVersion: string; findings: readonly AuditFinding[]; createdAt: string }>
export type ApprovalRecord = Readonly<{ schemaVersion: 1; status: 'APPROVED'; assetId: string; revision: number; submissionChecksum: string; metadataChecksum: string; auditChecksum: string; rulesetId: string; rulesetVersion: string; approvedAt: string; statementVersion: 1 }>
export type ApprovalGateInput = Readonly<{ assetId: string; revision: number; submissionChecksum: string; metadataChecksum: string; auditChecksum: string; rulesetId: string; rulesetVersion: string; metadataValid: boolean; audit?: DurableAuditSnapshot; approval?: ApprovalRecord }>
export type ApprovalGateResult = Readonly<{ status: 'NOT READY' | 'READY FOR HUMAN APPROVAL' | 'APPROVED / ADOBE-READY' | 'STALE / BLOCKED'; adobeReady: boolean; exportGate: 'BLOCKED' | 'CLEAR'; reasons: readonly string[] }>
const HEX = /^[a-f0-9]{64}$/
export function evaluateApprovalGate(i: ApprovalGateInput): ApprovalGateResult {
  const reasons: string[] = []
  if (!i.metadataValid) reasons.push('Metadata is missing or invalid.')
  const a = i.audit
  if (!a) reasons.push('No durable audit snapshot exists.')
  else {
    if (a.assetId !== i.assetId || a.revision !== i.revision || a.submissionChecksum !== i.submissionChecksum) reasons.push('Audit is stale or does not match the submission.')
    if (a.rulesetId !== i.rulesetId || a.rulesetVersion !== i.rulesetVersion || a.rulesetId !== ADOBE_STOCK_MVP_RULESET_ID) reasons.push('Audit ruleset does not match the locked ruleset.')
    if (a.findings.some((f) => f.verdict === 'FAIL')) reasons.push('Audit contains a blocking FAIL.')
  }
  if (![i.submissionChecksum, i.metadataChecksum, i.auditChecksum].every((x) => HEX.test(x))) reasons.push('A required checksum is invalid.')
  const p = i.approval
  const exact = !!p && p.schemaVersion === 1 && p.status === 'APPROVED' && p.statementVersion === 1 && p.assetId === i.assetId && p.revision === i.revision && p.submissionChecksum === i.submissionChecksum && p.metadataChecksum === i.metadataChecksum && p.auditChecksum === i.auditChecksum && p.rulesetId === i.rulesetId && p.rulesetVersion === i.rulesetVersion
  if (reasons.length) return { status: p ? 'STALE / BLOCKED' : (reasons.some((r) => r.includes('stale') || r.includes('ruleset') || r.includes('FAIL')) ? 'STALE / BLOCKED' : 'NOT READY'), adobeReady: false, exportGate: 'BLOCKED', reasons }
  if (!exact) return { status: 'READY FOR HUMAN APPROVAL', adobeReady: false, exportGate: 'BLOCKED', reasons: ['Explicit human approval is required.'] }
  return { status: 'APPROVED / ADOBE-READY', adobeReady: true, exportGate: 'CLEAR', reasons: [] }
}
