import { ADOBE_STOCK_MVP_RULESET } from '@gandiwa/adobe-rules'

export type AuditStatus = 'PASS' | 'WARNING' | 'FAIL' | 'STALE'
export type AuditVerdict = 'PASS' | 'WARNING' | 'FAIL'

export type AuditFindingInput = Readonly<{
  ruleId: string
  verdict: AuditVerdict
  message: string
  evidence: Readonly<Record<string, unknown>>
}>

export type AuditCenterInput = Readonly<{
  assetRevisionId: string
  assetChecksum: string
  rulesetId: string
  rulesetVersion: string
  findings: readonly AuditFindingInput[]
  currentAssetRevisionId?: string
  currentAssetChecksum?: string
}>

export type AuditFinding = Readonly<AuditFindingInput & {
  ruleVersion: string
  remediation: string
  blocksExport: boolean
}>

export type AuditCenterResult = Readonly<{
  status: AuditStatus
  statusLabel: string
  ariaLabel: string
  exportGate: 'CLEAR' | 'BLOCKED'
  ruleset: Readonly<{ id: string; version: string }>
  asset: Readonly<{ revisionId: string; checksum: string }>
  findings: readonly AuditFinding[]
  staleReason: string | null
}>

const RULES_BY_ID = new Map(ADOBE_STOCK_MVP_RULESET.rules.map((rule) => [rule.id, rule]))

export function verdictForFinding(ruleId: string, reportVerdict: 'pass' | 'warning' | 'fail'): AuditVerdict {
  if (reportVerdict === 'pass') return 'PASS'
  const rule = RULES_BY_ID.get(ruleId)
  if (!rule) throw new Error(`Audit finding references unknown rule: ${ruleId}`)
  return reportVerdict === 'fail' && !rule.blocks_export ? 'WARNING' : reportVerdict === 'warning' ? 'WARNING' : 'FAIL'
}

const REMEDIATIONS: Record<string, string> = {
  'vector.no-raster': 'Remove embedded or linked raster images, then run the audit again.',
  'vector.no-active-content': 'Remove scripts, event handlers, and active SVG content, then run the audit again.',
  'vector.no-external-resource': 'Remove external resources or unsafe CSS/URI references, then run the audit again.',
  'vector.valid-document': 'Fix the SVG structure and unsupported elements or attributes, then run the audit again.',
  'vector.no-live-text': 'Convert live text to approved vector geometry or remove it, then run the audit again.',
  'vector.no-empty-path': 'Remove empty paths, then run the audit again.',
  'vector.resolved-references': 'Resolve or remove broken local references, then run the audit again.',
}

function remediationFor(ruleId: string, verdict: AuditVerdict): string {
  if (verdict === 'PASS') return 'No remediation required.'
  return REMEDIATIONS[ruleId] ?? 'Review the evidence, apply the rule requirement, then run the audit again.'
}

export async function fileAuditIdentity(file: File): Promise<Readonly<{ revisionId: string; checksum: string }>> {
  const bytes = await file.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const checksum = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return { revisionId: `file-${file.name}-${file.size}-${file.lastModified}-${checksum.slice(0, 16)}`, checksum }
}

export function buildAuditCenter(input: AuditCenterInput): AuditCenterResult {
  const revisionChanged = input.currentAssetRevisionId !== undefined && input.currentAssetRevisionId !== input.assetRevisionId
  const checksumChanged = input.currentAssetChecksum !== undefined && input.currentAssetChecksum !== input.assetChecksum
  const staleParts = [revisionChanged ? 'asset revision changed' : null, checksumChanged ? 'asset checksum changed' : null].filter((part): part is string => part !== null)
  const staleReason = staleParts.length > 0 ? `Audit is stale: ${staleParts.join(' and ')}.` : null
  if (input.rulesetId !== ADOBE_STOCK_MVP_RULESET.id || input.rulesetVersion !== ADOBE_STOCK_MVP_RULESET.version) {
    throw new Error('Audit ruleset does not match the locked Adobe Stock MVP ruleset.')
  }
  const findings = input.findings.map((finding) => {
    const rule = RULES_BY_ID.get(finding.ruleId)
    if (!rule) throw new Error(`Audit finding references unknown rule: ${finding.ruleId}`)
    return {
      ...finding,
      ruleVersion: rule.source.version,
      remediation: remediationFor(finding.ruleId, finding.verdict),
      blocksExport: rule.blocks_export && finding.verdict === 'FAIL',
    }
  })
  const hasBlockingFailure = findings.some((finding) => finding.blocksExport)
  const status: AuditStatus = staleReason ? 'STALE' : hasBlockingFailure ? 'FAIL' : findings.some((finding) => finding.verdict === 'WARNING') ? 'WARNING' : 'PASS'
  const exportGate = status === 'STALE' || hasBlockingFailure ? 'BLOCKED' : 'CLEAR'
  const statusLabel = status === 'STALE' ? 'STALE — audit must be rerun' : `${status} — export ${exportGate === 'BLOCKED' ? 'blocked' : 'clear'}`
  return {
    status,
    statusLabel,
    ariaLabel: `Audit status ${status}; ${exportGate === 'BLOCKED' ? 'export blocked' : 'export clear'}`,
    exportGate,
    ruleset: { id: input.rulesetId, version: input.rulesetVersion },
    asset: { revisionId: input.assetRevisionId, checksum: input.assetChecksum },
    findings,
    staleReason,
  }
}
