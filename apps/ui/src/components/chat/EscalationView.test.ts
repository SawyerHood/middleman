/** @vitest-environment jsdom */

import { getByText, queryByText } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EscalationView } from './EscalationView'
import type { AgentDescriptor, UserEscalation } from '@middleman/protocol'

type ResolveEscalationHandler = (input: {
  escalationId: string
  choice: string
  isCustom: boolean
}) => Promise<void>

function buildManager(agentId: string): AgentDescriptor {
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
      provider: 'openai-codex-app-server',
      modelId: 'gpt-5.4',
      thinkingLevel: 'high',
    },
    sessionFile: `/tmp/${agentId}.jsonl`,
  }
}

function buildEscalation(
  escalationId: string,
  title: string,
  description: string,
  createdAt: string,
): UserEscalation {
  return {
    id: escalationId,
    managerId: 'manager-alpha',
    title,
    description,
    options: ['Approve', 'Decline'],
    status: 'open',
    createdAt,
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

function renderEscalationView(
  onResolveEscalation = vi.fn<ResolveEscalationHandler>().mockResolvedValue(undefined),
) {
  root = createRoot(container)

  flushSync(() => {
    root?.render(
      createElement(EscalationView, {
        escalations: [
          buildEscalation('esc-1', 'Review deployment', 'Needs a decision before deploy.', '2026-03-06T12:00:00.000Z'),
          buildEscalation(
            'esc-2',
            'Follow-up required',
            'A second escalation should still be selectable.',
            '2026-03-06T11:00:00.000Z',
          ),
        ],
        managers: [buildManager('manager-alpha')],
        onBack: vi.fn(),
        onResolveEscalation,
        onToggleMobileSidebar: vi.fn(),
      }),
    )
  })

  return { onResolveEscalation }
}

function getDetailCloseButton(): HTMLButtonElement {
  const button = container.querySelector('aside button[aria-label="Close task details"]')
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error('Expected close button to render in escalation detail panel')
  }

  return button
}

describe('EscalationView', () => {
  it('closes the detail panel without resolving the escalation', () => {
    const { onResolveEscalation } = renderEscalationView()

    const firstEscalationRow = getByText(container, 'Review deployment').closest('button')
    expect(firstEscalationRow).toBeTruthy()

    click(firstEscalationRow as HTMLButtonElement)

    expect(getByText(container, 'Needs a decision before deploy.')).toBeTruthy()

    click(getDetailCloseButton())

    expect(queryByText(container, 'Needs a decision before deploy.')).toBeNull()
    expect(onResolveEscalation).not.toHaveBeenCalled()

    const secondEscalationRow = getByText(container, 'Follow-up required').closest('button')
    expect(secondEscalationRow).toBeTruthy()

    click(secondEscalationRow as HTMLButtonElement)

    expect(getByText(container, 'A second escalation should still be selectable.')).toBeTruthy()
  })
})
