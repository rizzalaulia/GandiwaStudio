export type GuidedWorkflowState =
  | 'NO_PROJECT'
  | 'PROJECT_EMPTY'
  | 'REVISION_REQUIRED'
  | 'METADATA_REQUIRED'
  | 'AUDIT_REQUIRED'
  | 'AUDIT_RUNNING'
  | 'AUDIT_BLOCKED'
  | 'AUDIT_WARNING'
  | 'APPROVAL_REQUIRED'
  | 'APPROVED'
  | 'EXPORTING'
  | 'EXPORTED'

export type GuidedWorkflowStep = 'prepare' | 'metadata' | 'audit' | 'approval' | 'export'
export type GuidedWorkflowAction =
  | 'open-project'
  | 'prepare-revision'
  | 'complete-metadata'
  | 'run-audit'
  | 'approve-revision'
  | 'export-package'

export type GuidedWorkflowInput = Readonly<{
  project: 'none' | 'active'
  hasAsset: boolean
  revision: 'current' | 'required'
  metadata: 'current' | 'required' | 'invalid'
  audit: 'required' | 'running' | 'pass' | 'warning' | 'blocked' | 'stale'
  approvalGate: 'NOT READY' | 'READY FOR HUMAN APPROVAL' | 'APPROVED / ADOBE-READY' | 'STALE / BLOCKED'
  export: 'idle' | 'running' | 'success'
  preflight?: 'pass' | 'warning' | 'fail'
  blockers: readonly string[]
}>

export type GuidedWorkflowPresentation = Readonly<{
  state: GuidedWorkflowState
  activeStep: GuidedWorkflowStep | null
  title: string
  explanation: string
  primaryActionLabel: string
  actionIntent: GuidedWorkflowAction
  blockers: readonly string[]
  completedSteps: readonly GuidedWorkflowStep[]
}>

const PREPARE: readonly GuidedWorkflowStep[] = []
const PREPARED: readonly GuidedWorkflowStep[] = ['prepare']
const AUDIT_READY: readonly GuidedWorkflowStep[] = ['prepare', 'metadata']
const APPROVAL_READY: readonly GuidedWorkflowStep[] = ['prepare', 'metadata', 'audit']

function presentation(
  input: GuidedWorkflowInput,
  values: Omit<GuidedWorkflowPresentation, 'blockers'>,
): GuidedWorkflowPresentation {
  return { ...values, blockers: input.blockers }
}

export function getGuidedWorkflowPresentation(input: GuidedWorkflowInput): GuidedWorkflowPresentation {
  if (input.project === 'none') {
    return presentation(input, {
      state: 'NO_PROJECT',
      activeStep: null,
      title: 'Open a local project to begin',
      explanation: 'Choose an existing project or create a new local project workspace.',
      primaryActionLabel: 'Open or create project',
      actionIntent: 'open-project',
      completedSteps: PREPARE,
    })
  }

  if (!input.hasAsset) {
    return presentation(input, {
      state: 'PROJECT_EMPTY',
      activeStep: 'prepare',
      title: 'Prepare the first asset revision',
      explanation: 'This project has no asset yet. Choose a source and create a durable revision in the browser-owned project folder.',
      primaryActionLabel: 'Prepare first revision',
      actionIntent: 'prepare-revision',
      completedSteps: PREPARE,
    })
  }

  if (input.revision === 'required') {
    const preflightNote = input.preflight
      ? ' Temporary preflight is only an inspection; it does not create a durable revision.'
      : ''
    return presentation(input, {
      state: 'REVISION_REQUIRED',
      activeStep: 'prepare',
      title: 'Prepare the current asset revision',
      explanation: `Create the submission revision without overwriting the source.${preflightNote}`,
      primaryActionLabel: 'Prepare revision',
      actionIntent: 'prepare-revision',
      completedSteps: PREPARE,
    })
  }

  if (input.metadata !== 'current') {
    return presentation(input, {
      state: 'METADATA_REQUIRED',
      activeStep: 'metadata',
      title: 'Complete the submission metadata',
      explanation: 'Add valid title, keywords, classification, AI disclosure, and release information before running the audit.',
      primaryActionLabel: 'Complete metadata',
      actionIntent: 'complete-metadata',
      completedSteps: PREPARED,
    })
  }

  if (input.audit === 'running') {
    return presentation(input, {
      state: 'AUDIT_RUNNING',
      activeStep: 'audit',
      title: 'Checking the current revision',
      explanation: 'The durable audit is being prepared from the current revision and metadata evidence.',
      primaryActionLabel: 'Audit in progress…',
      actionIntent: 'run-audit',
      completedSteps: AUDIT_READY,
    })
  }

  if (input.audit === 'required') {
    return presentation(input, {
      state: 'AUDIT_REQUIRED',
      activeStep: 'audit',
      title: 'Run the audit for this revision',
      explanation: 'Create current, revision-bound audit evidence before asking for human approval.',
      primaryActionLabel: 'Run audit',
      actionIntent: 'run-audit',
      completedSteps: AUDIT_READY,
    })
  }

  if (input.audit === 'blocked' || input.audit === 'stale') {
    return presentation(input, {
      state: 'AUDIT_BLOCKED',
      activeStep: 'audit',
      title: 'Resolve the audit blocker',
      explanation: 'The current audit is blocked or stale. Review the reason, then run the audit again from current evidence.',
      primaryActionLabel: 'Run audit again',
      actionIntent: 'run-audit',
      completedSteps: AUDIT_READY,
    })
  }

  if (input.export === 'running') {
    return presentation(input, {
      state: 'EXPORTING',
      activeStep: 'export',
      title: 'Writing the Gandiwa export package',
      explanation: 'The browser is rechecking approved evidence while it writes the local package.',
      primaryActionLabel: 'Writing export package…',
      actionIntent: 'export-package',
      completedSteps: APPROVAL_READY,
    })
  }

  if (input.export === 'success') {
    return presentation(input, {
      state: 'EXPORTED',
      activeStep: 'export',
      title: 'Export package completed',
      explanation: 'The package was written to the browser-owned project folder. Gandiwa readiness is not an Adobe acceptance guarantee.',
      primaryActionLabel: 'Export another package',
      actionIntent: 'export-package',
      completedSteps: ['prepare', 'metadata', 'audit', 'approval', 'export'],
    })
  }

  if (input.approvalGate === 'APPROVED / ADOBE-READY') {
    return presentation(input, {
      state: 'APPROVED',
      activeStep: 'export',
      title: 'Gandiwa gate is ready for manual submission',
      explanation: 'Human approval and current evidence are present. Export a browser-local package; this is not a promise of Adobe acceptance.',
      primaryActionLabel: 'Export package',
      actionIntent: 'export-package',
      completedSteps: APPROVAL_READY,
    })
  }

  return presentation(input, {
    state: input.audit === 'warning' ? 'AUDIT_WARNING' : 'APPROVAL_REQUIRED',
    activeStep: 'approval',
    title: input.audit === 'warning' ? 'Review audit warnings and approve' : 'Confirm this revision for submission',
    explanation: input.audit === 'warning'
      ? 'Warnings are visible for human review. They do not disappear merely because the audit can continue.'
      : 'Current metadata and audit evidence are present. Explicit human approval is required before export.',
    primaryActionLabel: 'Confirm for manual submission',
    actionIntent: 'approve-revision',
    completedSteps: APPROVAL_READY,
  })
}
