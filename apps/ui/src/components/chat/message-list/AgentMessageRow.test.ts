/** @vitest-environment jsdom */

import { getByRole, queryByRole } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentDescriptor } from '@middleman/protocol'
import { buildAgentLookup } from '@/lib/agent-message-utils'
import { AgentMessageRow } from './AgentMessageRow'
import type { AgentMessageEntry } from './types'

function agent(
  overrides: Partial<AgentDescriptor> & Pick<AgentDescriptor, 'agentId' | 'managerId' | 'role'>,
): AgentDescriptor {
  return {
    displayName: overrides.agentId,
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp/project',
    model: {
      provider: 'openai-codex-app-server',
      modelId: 'gpt-5.4',
      thinkingLevel: 'xhigh',
    },
    ...overrides,
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

function renderAgentMessageRow({
  message,
  agents,
}: {
  message: AgentMessageEntry
  agents: AgentDescriptor[]
}) {
  root = createRoot(container)

  flushSync(() => {
    root?.render(
      createElement(AgentMessageRow, {
        message,
        agentLookup: buildAgentLookup(agents),
      }),
    )
  })
}

describe('AgentMessageRow', () => {
  it('collapses manager-to-manager chatter by default and lets it expand', () => {
    renderAgentMessageRow({
      agents: [
        agent({ agentId: 'manager-a', managerId: 'manager-a', role: 'manager', displayName: 'Manager A' }),
        agent({ agentId: 'manager-b', managerId: 'manager-b', role: 'manager', displayName: 'Manager B' }),
      ],
      message: {
        type: 'agent_message',
        agentId: 'manager-a',
        timestamp: '2026-01-01T00:00:01.000Z',
        source: 'agent_to_agent',
        fromAgentId: 'manager-a',
        toAgentId: 'manager-b',
        text: 'Please sync on the deployment window and confirm the handoff.',
      },
    })

    const toggle = getByRole(container, 'button', { name: /expand/i })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    flushSync(() => {
      toggle.click()
    })

    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(container.textContent).toContain('Collapse')
    expect(container.textContent).toContain('Please sync on the deployment window')
  })

  it('keeps non-manager agent messages expanded', () => {
    renderAgentMessageRow({
      agents: [
        agent({ agentId: 'manager-a', managerId: 'manager-a', role: 'manager', displayName: 'Manager A' }),
        agent({ agentId: 'worker-a', managerId: 'manager-a', role: 'worker', displayName: 'Worker A' }),
      ],
      message: {
        type: 'agent_message',
        agentId: 'manager-a',
        timestamp: '2026-01-01T00:00:01.000Z',
        source: 'agent_to_agent',
        fromAgentId: 'manager-a',
        toAgentId: 'worker-a',
        text: 'Investigate the failing test and report back.',
      },
    })

    expect(queryByRole(container, 'button', { name: /expand|collapse/i })).toBeNull()
    expect(container.textContent).toContain('Investigate the failing test and report back.')
  })
})
