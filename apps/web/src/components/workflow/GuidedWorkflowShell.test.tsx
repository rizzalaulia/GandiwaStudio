import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

function setViewport(width: number) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === '(max-width: 1279px)' ? width <= 1279 : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  })
}

import { GuidedWorkflowShell } from './GuidedWorkflowShell'
import type { GuidedWorkflowPresentation } from '../../workflow/guided-workflow'

const presentation: GuidedWorkflowPresentation = {
  state: 'METADATA_REQUIRED',
  activeStep: 'metadata',
  title: 'Complete the submission metadata',
  explanation: 'Add valid metadata before audit.',
  primaryActionLabel: 'Complete metadata',
  actionIntent: 'complete-metadata',
  blockers: [],
  completedSteps: ['prepare'],
}

describe('GuidedWorkflowShell', () => {
  afterEach(() => cleanup())

  it('renders the project regions and one primary task action', () => {
    const onOpenInspector = vi.fn()
    render(
      <GuidedWorkflowShell
        projectName="Botanical Forms"
        assetSummary="Illustration · revision r002"
        presentation={presentation}
        onOpenInspector={onOpenInspector}
        task={<button data-testid="primary-workflow-action">Complete metadata</button>}
        inspector={<p>Metadata is incomplete.</p>}
      />,
    )

    expect(screen.getByRole('navigation', { name: 'Project navigation' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Workspace' })).toHaveAttribute('href', '#workflow')
    const projectFiles = screen.getByRole('button', { name: 'Project files' })
    const auditHistory = screen.getByRole('button', { name: 'Audit history' })
    expect(projectFiles).toHaveAttribute('aria-controls', 'workflow-inspector')
    expect(auditHistory).toHaveAttribute('aria-controls', 'workflow-inspector')
    fireEvent.click(projectFiles)
    fireEvent.click(auditHistory)
    expect(onOpenInspector).toHaveBeenNthCalledWith(1, 'project-files')
    expect(onOpenInspector).toHaveBeenNthCalledWith(2, 'audit-history')
    expect(screen.getByRole('banner', { name: 'Project header' })).toHaveTextContent('Botanical Forms')
    expect(screen.getByRole('navigation', { name: 'Production workflow' })).toHaveTextContent('Complete metadata')
    expect(screen.getByRole('region', { name: 'Current workflow task' })).toHaveTextContent('Complete the submission metadata')
    expect(screen.getAllByTestId('primary-workflow-action')).toHaveLength(1)
    expect(screen.getByRole('complementary', { name: 'Contextual inspector' })).toHaveTextContent('Metadata is incomplete.')
  })

  it('renders a breadcrumb and sidebar status without a second project header', () => {
    render(
      <GuidedWorkflowShell
        projectName="Botanical Forms"
        assetSummary="Illustration · revision r002"
        breadcrumb={['Projects', 'Botanical Forms', 'asset-01', 'revision r002']}
        statusItems={[
          { label: 'Backend available', tone: 'ok' },
          { label: 'Folder permission granted', tone: 'ok' },
        ]}
        presentation={presentation}
        onOpenInspector={() => undefined}
        task={<button data-testid="primary-workflow-action">Complete metadata</button>}
        inspector={<p>Details</p>}
      />,
    )

    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' })
    expect(breadcrumb).toHaveTextContent('Projects / Botanical Forms / asset-01 / revision r002')

    const status = screen.getByRole('list', { name: 'Project status' })
    expect(status).toHaveTextContent('Backend available')
    expect(status).toHaveTextContent('Folder permission granted')
  })

  it('marks the current workflow step and exposes inspector as a keyboard button', () => {
    render(
      <GuidedWorkflowShell
        projectName="Botanical Forms"
        assetSummary="Illustration · revision r002"
        presentation={presentation}
        onOpenInspector={() => undefined}
        task={<button data-testid="primary-workflow-action">Complete metadata</button>}
        inspector={<p>Details</p>}
      />,
    )

    expect(screen.getByRole('listitem', { name: /Metadata.*current/i })).toHaveAttribute('aria-current', 'step')
    expect(screen.getByRole('button', { name: 'Open contextual inspector' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Open contextual inspector' })).toHaveAttribute('aria-controls', 'workflow-inspector')
  })

  it('keeps the persistent inspector on desktop instead of opening a duplicate drawer', () => {
    setViewport(1366)
    render(
      <GuidedWorkflowShell
        projectName="Botanical Forms"
        assetSummary="Illustration · revision r002"
        presentation={presentation}
        onOpenInspector={() => undefined}
        task={<button data-testid="primary-workflow-action">Complete metadata</button>}
        inspector={<p>Details</p>}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open contextual inspector' }))

    expect(screen.getByRole('complementary', { name: 'Contextual inspector' })).toBeVisible()
    expect(screen.queryByRole('dialog', { name: 'Contextual inspector' })).not.toBeInTheDocument()
  })

  it('opens a focused drawer at the tablet breakpoint and returns focus after Escape', () => {
    setViewport(1150)
    const onOpenInspector = vi.fn()
    render(
      <GuidedWorkflowShell
        projectName="Botanical Forms"
        assetSummary="Illustration · revision r002"
        presentation={presentation}
        onOpenInspector={onOpenInspector}
        task={<button data-testid="primary-workflow-action">Complete metadata</button>}
        inspector={<p>Details</p>}
      />,
    )

    const trigger = screen.getByRole('button', { name: 'Open contextual inspector' })
    trigger.focus()
    fireEvent.click(trigger)

    const drawer = screen.getByRole('dialog', { name: 'Contextual inspector' })
    expect(onOpenInspector).toHaveBeenCalledOnce()
    expect(drawer).toBeVisible()
    expect(document.querySelector('.guided-sidebar')).toHaveAttribute('aria-hidden', 'true')
    expect(document.querySelector('.guided-workspace')).toHaveAttribute('aria-hidden', 'true')
    const close = screen.getByRole('button', { name: 'Close details' })
    expect(close).toHaveFocus()

    fireEvent.keyDown(close, { key: 'Tab' })
    expect(close).toHaveFocus()

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' })

    expect(screen.queryByRole('dialog', { name: 'Contextual inspector' })).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('returns focus to the sidebar control that opened the tablet inspector drawer', () => {
    setViewport(1150)
    render(
      <GuidedWorkflowShell
        projectName="Botanical Forms"
        assetSummary="Illustration · revision r002"
        presentation={presentation}
        onOpenInspector={() => undefined}
        task={<button data-testid="primary-workflow-action">Complete metadata</button>}
        inspector={<p>Details</p>}
      />,
    )

    const projectFiles = screen.getByRole('button', { name: 'Project files' })
    fireEvent.click(projectFiles)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close details' }), { key: 'Escape' })

    expect(projectFiles).toHaveFocus()
  })

  it('keeps project lifecycle actions inside the guided shell frame', () => {
    render(
      <GuidedWorkflowShell
        projectName="Botanical Forms"
        assetSummary="Illustration · revision r002"
        presentation={presentation}
        onOpenInspector={() => undefined}
        task={<button data-testid="primary-workflow-action">Complete metadata</button>}
        inspector={<p>Details</p>}
        projectActions={<button>Check for external changes</button>}
      />,
    )

    const shell = document.querySelector('.guided-shell')
    const actions = document.querySelector('.guided-project-actions')
    expect(actions).not.toBeNull()
    expect(shell?.contains(actions)).toBe(true)
  })
})
