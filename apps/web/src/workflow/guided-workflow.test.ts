import { describe, expect, it } from 'vitest'

import { getGuidedWorkflowPresentation, type GuidedWorkflowInput } from './guided-workflow'

const baseInput: GuidedWorkflowInput = {
  project: 'active',
  hasAsset: true,
  revision: 'current',
  metadata: 'current',
  audit: 'pass',
  approvalGate: 'READY FOR HUMAN APPROVAL',
  export: 'idle',
  blockers: [],
}

describe('getGuidedWorkflowPresentation', () => {
  it('guides a project with no asset to prepare the first asset', () => {
    const presentation = getGuidedWorkflowPresentation({
      ...baseInput,
      hasAsset: false,
      revision: 'required',
      metadata: 'required',
      audit: 'required',
      approvalGate: 'NOT READY',
    })

    expect(presentation.state).toBe('PROJECT_EMPTY')
    expect(presentation.activeStep).toBe('prepare')
    expect(presentation.primaryActionLabel).toBe('Prepare first revision')
    expect(presentation.actionIntent).toBe('prepare-revision')
    expect(presentation.completedSteps).toEqual([])
  })

  it('keeps temporary preflight separate from durable revision preparation', () => {
    const presentation = getGuidedWorkflowPresentation({
      ...baseInput,
      revision: 'required',
      metadata: 'required',
      audit: 'required',
      approvalGate: 'NOT READY',
      preflight: 'pass',
    })

    expect(presentation.state).toBe('REVISION_REQUIRED')
    expect(presentation.activeStep).toBe('prepare')
    expect(presentation.primaryActionLabel).toBe('Prepare revision')
    expect(presentation.actionIntent).toBe('prepare-revision')
    expect(presentation.explanation).toMatch(/temporary preflight/i)
    expect(presentation.completedSteps).toEqual([])
  })

  it('opens metadata as the only heavy task after a current revision', () => {
    const presentation = getGuidedWorkflowPresentation({
      ...baseInput,
      metadata: 'required',
      audit: 'required',
      approvalGate: 'NOT READY',
    })

    expect(presentation.state).toBe('METADATA_REQUIRED')
    expect(presentation.activeStep).toBe('metadata')
    expect(presentation.primaryActionLabel).toBe('Complete metadata')
    expect(presentation.actionIntent).toBe('complete-metadata')
    expect(presentation.completedSteps).toEqual(['prepare'])
  })

  it('requires a fresh audit before approval when metadata is current', () => {
    const presentation = getGuidedWorkflowPresentation({
      ...baseInput,
      audit: 'required',
      approvalGate: 'NOT READY',
    })

    expect(presentation.state).toBe('AUDIT_REQUIRED')
    expect(presentation.activeStep).toBe('audit')
    expect(presentation.primaryActionLabel).toBe('Run audit')
    expect(presentation.actionIntent).toBe('run-audit')
    expect(presentation.completedSteps).toEqual(['prepare', 'metadata'])
  })

  it('keeps approval blocked for stale or failing audit evidence', () => {
    for (const audit of ['blocked', 'stale'] as const) {
      const presentation = getGuidedWorkflowPresentation({
        ...baseInput,
        audit,
        approvalGate: 'STALE / BLOCKED',
        blockers: ['Current audit evidence is unavailable or blocked.'],
      })

      expect(presentation.state).toBe('AUDIT_BLOCKED')
      expect(presentation.activeStep).toBe('audit')
      expect(presentation.actionIntent).toBe('run-audit')
      expect(presentation.primaryActionLabel).toBe('Run audit again')
      expect(presentation.blockers).toContain('Current audit evidence is unavailable or blocked.')
    }
  })

  it('shows warnings while still requiring human approval', () => {
    const presentation = getGuidedWorkflowPresentation({
      ...baseInput,
      audit: 'warning',
      approvalGate: 'READY FOR HUMAN APPROVAL',
    })

    expect(presentation.state).toBe('AUDIT_WARNING')
    expect(presentation.activeStep).toBe('approval')
    expect(presentation.primaryActionLabel).toBe('Confirm for manual submission')
    expect(presentation.completedSteps).toEqual(['prepare', 'metadata', 'audit'])
    expect(presentation.explanation).toMatch(/warning/i)
  })

  it('never exposes export while approval is not current', () => {
    const presentation = getGuidedWorkflowPresentation({
      ...baseInput,
      audit: 'pass',
      approvalGate: 'STALE / BLOCKED',
      blockers: ['Approval evidence is stale.'],
    })

    expect(presentation.state).toBe('APPROVAL_REQUIRED')
    expect(presentation.activeStep).toBe('approval')
    expect(presentation.actionIntent).toBe('approve-revision')
    expect(presentation.completedSteps).toEqual(['prepare', 'metadata', 'audit'])
    expect(presentation.blockers).toContain('Approval evidence is stale.')
  })

  it('makes current approval the only route to export and labels Adobe-ready honestly', () => {
    const presentation = getGuidedWorkflowPresentation({
      ...baseInput,
      audit: 'pass',
      approvalGate: 'APPROVED / ADOBE-READY',
    })

    expect(presentation.state).toBe('APPROVED')
    expect(presentation.activeStep).toBe('export')
    expect(presentation.primaryActionLabel).toBe('Export package')
    expect(presentation.actionIntent).toBe('export-package')
    expect(presentation.title).toMatch(/Gandiwa gate/i)
  })

  it('represents exporting and success without claiming Adobe acceptance', () => {
    expect(getGuidedWorkflowPresentation({ ...baseInput, approvalGate: 'APPROVED / ADOBE-READY', export: 'running' })).toMatchObject({
      state: 'EXPORTING',
      activeStep: 'export',
      primaryActionLabel: 'Writing export package…',
    })
    expect(getGuidedWorkflowPresentation({ ...baseInput, approvalGate: 'APPROVED / ADOBE-READY', export: 'success' })).toMatchObject({
      state: 'EXPORTED',
      activeStep: 'export',
      primaryActionLabel: 'Export another package',
    })
  })

  it('reports no project as an actionable empty state', () => {
    const presentation = getGuidedWorkflowPresentation({
      ...baseInput,
      project: 'none',
      hasAsset: false,
      revision: 'required',
      metadata: 'required',
      audit: 'required',
      approvalGate: 'NOT READY',
    })

    expect(presentation.state).toBe('NO_PROJECT')
    expect(presentation.activeStep).toBeNull()
    expect(presentation.primaryActionLabel).toBe('Open or create project')
    expect(presentation.actionIntent).toBe('open-project')
  })
})
