/** @vitest-environment jsdom */

import { getByText, queryByText, within } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSidebar } from './AgentSidebar'
import type { AgentDescriptor, AgentStatus } from '@middleman/protocol'

function manager(
  agentId: string,
  modelOverrides: Partial<AgentDescriptor['model']> = {},
): AgentDescriptor {
  return {
    agentId,
    managerId: agentId,
    displayName: agentId,
    role: 'manager',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp',
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'high',
      ...modelOverrides,
    },
    sessionFile: `/tmp/${agentId}.jsonl`,
  }
}

function worker(
  agentId: string,
  managerId: string,
  modelOverrides: Partial<AgentDescriptor['model']> = {},
): AgentDescriptor {
  return {
    ...manager(agentId, modelOverrides),
    managerId,
    role: 'worker',
  }
}

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (root) {
    flushSync(() => {
      root?.unmount()
    })
  }

  root = null
  container.remove()
})

function click(element: HTMLElement): void {
  flushSync(() => {
    element.click()
  })
}

function getPrimarySidebar(): HTMLElement {
  const sidebar = container.querySelector('aside')
  if (!sidebar) {
    throw new Error('Expected sidebar to render')
  }

  return sidebar
}

function renderSidebar({
  agents,
  selectedAgentId = null,
  onSelectAgent = vi.fn(),
  onDeleteAgent = vi.fn(),
  onDeleteManager = vi.fn(),
  onOpenTasks = vi.fn(),
  onOpenSettings = vi.fn(),
  isSettingsActive = false,
  isTasksActive = false,
  tasks = [],
  statuses = {},
}: {
  agents: AgentDescriptor[]
  selectedAgentId?: string | null
  onSelectAgent?: (agentId: string) => void
  onDeleteAgent?: (agentId: string) => void
  onDeleteManager?: (managerId: string) => void
  onOpenTasks?: () => void
  onOpenSettings?: () => void
  isSettingsActive?: boolean
  isTasksActive?: boolean
  tasks?: Array<{
    id: string
    managerId: string
    title: string
    status: 'pending' | 'completed'
    createdAt: string
  }>
  statuses?: Record<string, { status: AgentStatus; pendingCount: number }>
}) {
  root = createRoot(container)

  flushSync(() => {
    root?.render(
      createElement(AgentSidebar, {
        connected: true,
        agents,
        statuses,
        selectedAgentId,
        onAddManager: vi.fn(),
        onSelectAgent,
        onDeleteAgent,
        onDeleteManager,
        onOpenTasks,
        onOpenSettings,
        isSettingsActive,
        isTasksActive,
        tasks,
      }),
    )
  })
}

describe('AgentSidebar', () => {
  it('shows workers collapsed by default and toggles expand/collapse per manager', () => {
    renderSidebar({ agents: [manager('manager-alpha'), worker('worker-alpha', 'manager-alpha')] })
    const sidebar = getPrimarySidebar()

    expect(queryByText(sidebar, 'worker-alpha')).toBeNull()

    click(within(sidebar).getByRole('button', { name: 'Expand manager manager-alpha' }))
    expect(queryByText(sidebar, 'worker-alpha')).toBeTruthy()

    click(within(sidebar).getByRole('button', { name: 'Collapse manager manager-alpha' }))
    expect(queryByText(sidebar, 'worker-alpha')).toBeNull()
  })

  it('shows runtime icons from model presets', () => {
    renderSidebar({
      agents: [
        manager('manager-pi', { provider: 'openai-codex', modelId: 'gpt-5.3-codex' }),
        worker('worker-opus', 'manager-pi', { provider: 'anthropic', modelId: 'claude-opus-4-6' }),
        worker('worker-codex', 'manager-pi', { provider: 'openai-codex-app-server', modelId: 'gpt-5.4' }),
        worker('worker-claude-code', 'manager-pi', { provider: 'anthropic-claude-code', modelId: 'claude-opus-4-6' }),
      ],
    })
    const sidebar = getPrimarySidebar()

    click(within(sidebar).getByRole('button', { name: 'Expand manager manager-pi' }))

    expect(container.querySelectorAll('img[src="/pi-logo.svg"]').length).toBeGreaterThanOrEqual(2)
    expect(container.querySelector('img[src="/agents/codex-logo.svg"]')).toBeTruthy()

    const claudeCodeRow = getByText(sidebar, 'worker-claude-code').closest('button') as HTMLButtonElement
    expect(claudeCodeRow).toBeTruthy()
    expect(claudeCodeRow.querySelectorAll('img[src="/agents/claude-logo.svg"]').length).toBe(2)
  })

  it('keeps manager selection behavior working while collapse state changes', () => {
    const onSelectAgent = vi.fn()

    renderSidebar({
      agents: [manager('manager-alpha'), worker('worker-alpha', 'manager-alpha')],
      onSelectAgent,
    })
    const sidebar = getPrimarySidebar()

    const getManagerRowButton = () => getByText(sidebar, 'manager-alpha').closest('button') as HTMLButtonElement
    expect(getManagerRowButton()).toBeTruthy()

    click(getManagerRowButton())
    expect(onSelectAgent).toHaveBeenCalledTimes(1)
    expect(onSelectAgent).toHaveBeenLastCalledWith('manager-alpha')

    click(within(sidebar).getByRole('button', { name: 'Expand manager manager-alpha' }))
    expect(onSelectAgent).toHaveBeenCalledTimes(1)

    click(getManagerRowButton())
    expect(onSelectAgent).toHaveBeenCalledTimes(2)
    expect(onSelectAgent).toHaveBeenLastCalledWith('manager-alpha')
  })

  it('keeps manager and worker selection separate from delete callbacks', () => {
    const onDeleteAgent = vi.fn()
    const onDeleteManager = vi.fn()
    const onSelectAgent = vi.fn()

    renderSidebar({
      agents: [manager('manager-alpha'), worker('worker-alpha', 'manager-alpha')],
      onDeleteAgent,
      onDeleteManager,
      onSelectAgent,
    })
    const sidebar = getPrimarySidebar()

    const managerRowButton = within(sidebar).getByRole('button', { name: 'manager-alpha' })
    click(managerRowButton)
    expect(onSelectAgent).toHaveBeenCalledWith('manager-alpha')
    expect(onDeleteManager).not.toHaveBeenCalled()

    click(within(sidebar).getByRole('button', { name: 'Expand manager manager-alpha' }))
    const workerRowButton = within(sidebar).getByRole('button', { name: 'worker-alpha' })
    click(workerRowButton)
    expect(onSelectAgent).toHaveBeenCalledWith('worker-alpha')
    expect(onDeleteAgent).not.toHaveBeenCalled()
  })

  it('calls onOpenSettings when the settings button is clicked', () => {
    const onOpenSettings = vi.fn()

    renderSidebar({
      agents: [manager('manager-alpha')],
      onOpenSettings,
    })
    const sidebar = getPrimarySidebar()

    click(within(sidebar).getByRole('button', { name: 'Settings' }))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('shows pending task count and calls onOpenTasks when the tasks button is clicked', () => {
    const onOpenTasks = vi.fn()

    renderSidebar({
      agents: [manager('manager-alpha')],
      onOpenTasks,
      tasks: [
        {
          id: 'task-1',
          managerId: 'manager-alpha',
          title: 'Review docs',
          status: 'pending',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    })
    const sidebar = getPrimarySidebar()

    expect(within(sidebar).getByText('1')).toBeTruthy()
    click(within(sidebar).getByRole('button', { name: /^Tasks/ }))
    expect(onOpenTasks).toHaveBeenCalledTimes(1)
  })

})
