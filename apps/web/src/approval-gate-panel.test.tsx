import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'


afterEach(() => cleanup())
import { ApprovalGatePanel } from './App'

const submission = {
  assetId: '123e4567-e89b-12d3-a456-426614174000',
  revision: 2,
  path: 'revisions/2/submission.jpeg',
  file: new File(['jpeg'], 'submission.jpeg', { type: 'image/jpeg' }),
  contentType: 'photo' as const,
  creationMethod: 'camera' as const,
  submissionChecksum: 'a'.repeat(64),
  metadataChecksum: 'b'.repeat(64),
  manifestSnapshot: '{"schema_version":1}',
}

describe('ApprovalGatePanel', () => {
  it('disables human confirmation after approval has already been recorded', () => {
    render(
      <ApprovalGatePanel
        gate={{ status: 'APPROVED / ADOBE-READY', adobeReady: true, exportGate: 'CLEAR', reasons: [] }}
        asset={{ assetId: submission.assetId, revision: submission.revision }}
        audit={null}
        submission={submission}
        metadataValid
        metadataChecksum={'b'.repeat(64)}
        auditChecksum={'c'.repeat(64)}
        busy={false}
        message={null}
        onAudit={vi.fn()}
        onApprove={vi.fn()}
      />,
    )

    expect(screen.getByText(/Metadata checksum/)).toBeVisible()
    expect(screen.getByText(/Audit checksum/)).toBeVisible()
    expect(screen.getByRole('button', { name: /confirm this revision/i })).toBeDisabled()
  })

  it('enables human confirmation only when the gate is ready', () => {
    render(
      <ApprovalGatePanel
        gate={{ status: 'READY FOR HUMAN APPROVAL', adobeReady: false, exportGate: 'BLOCKED', reasons: ['Explicit human approval is required.'] }}
        asset={{ assetId: submission.assetId, revision: submission.revision }}
        audit={null}
        submission={submission}
        metadataValid
        metadataChecksum={'b'.repeat(64)}
        auditChecksum={'c'.repeat(64)}
        busy={false}
        message={null}
        onAudit={vi.fn()}
        onApprove={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: /confirm this revision/i })).toBeEnabled()
  })
})
