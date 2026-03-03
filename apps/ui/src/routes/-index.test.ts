/** @vitest-environment jsdom */

import { fireEvent, getAllByRole, getByLabelText, getByRole, queryByText } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MANAGER_MODEL_PRESETS } from '@middleman/protocol'
import { TooltipProvider } from '@/components/ui/tooltip'
import { IndexPage } from './index'

const CREATE_MANAGER_MODEL_PRESETS = MANAGER_MODEL_PRESETS.filter(
  (modelPreset) => modelPreset !== 'codex-app',
)

type ListenerMap = Record<string, Array<(event?: any) => void>>

class FakeWebSocket {
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readonly sentPayloads: string[] = []
  readonly listeners: ListenerMap = {}

  readyState = FakeWebSocket.OPEN

  constructor(_url: string) {
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: (event?: any) => void): void {
    this.listeners[type] ??= []
    this.listeners[type].push(listener)
  }

  send(payload: string): void {
    this.sentPayloads.push(payload)
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.emit('close')
  }

  emit(type: string, event?: any): void {
    const handlers = this.listeners[type] ?? []
    for (const handler of handlers) {
      handler(event)
    }
  }
}

function emitServerEvent(socket: FakeWebSocket, event: unknown): void {
  socket.emit('message', {
    data: JSON.stringify(event),
  })
}

function click(element: HTMLElement): void {
  flushSync(() => {
    element.click()
  })
}

function changeValue(element: HTMLInputElement, value: string): void {
  flushSync(() => {
    fireEvent.change(element, {
      target: { value },
    })
  })
}

function buildManager(agentId: string, cwd: string) {
  return {
    agentId,
    managerId: agentId,
    displayName: agentId,
    role: 'manager' as const,
    status: 'idle' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cwd,
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'high',
    },
    sessionFile: `/tmp/${agentId}.jsonl`,
  }
}

function buildWorker(agentId: string, managerId: string, cwd: string) {
  return {
    agentId,
    managerId,
    displayName: agentId,
    role: 'worker' as const,
    status: 'idle' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cwd,
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'high',
    },
    sessionFile: `/tmp/${agentId}.jsonl`,
  }
}

let container: HTMLDivElement
let root: Root | null = null

const originalWebSocket = globalThis.WebSocket
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView

beforeEach(() => {
  FakeWebSocket.instances = []
  vi.useFakeTimers()
  ;(globalThis as any).WebSocket = FakeWebSocket
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  })

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

  vi.useRealTimers()
  ;(globalThis as any).WebSocket = originalWebSocket
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: originalScrollIntoView,
  })
})

async function renderPage(): Promise<FakeWebSocket> {
  root = createRoot(container)

  flushSync(() => {
    root?.render(
      createElement(
        TooltipProvider,
        null,
        createElement(IndexPage),
      ),
    )
  })

  await Promise.resolve()
  vi.advanceTimersByTime(60)

  const socket = FakeWebSocket.instances[0]
  expect(socket).toBeDefined()

  socket.emit('open')
  expect(JSON.parse(socket.sentPayloads.at(0) ?? '{}')).toEqual({ type: 'subscribe' })
  emitServerEvent(socket, {
    type: 'ready',
    serverTime: new Date().toISOString(),
    subscribedAgentId: 'manager',
  })

  return socket
}

describe('IndexPage create manager model selection', () => {
  it('shows only allowed model presets and defaults to pi-codex', async () => {
    await renderPage()

    click(getAllByRole(container, 'button', { name: 'Add manager' })[0]!)

    const modelSelect = getByRole(document.body, 'combobox', { name: 'Model' })
    expect(modelSelect.textContent).toContain('pi-codex')

    click(modelSelect as HTMLElement)

    const optionValues = getAllByRole(document.body, 'option').map((option) => option.textContent?.trim() ?? '')
    expect(optionValues).toEqual([...CREATE_MANAGER_MODEL_PRESETS])
  })

  it('sends selected model in create_manager payload', async () => {
    const socket = await renderPage()

    click(getAllByRole(container, 'button', { name: 'Add manager' })[0]!)

    changeValue(getByLabelText(document.body, 'Name') as HTMLInputElement, 'release-manager')
    changeValue(getByLabelText(document.body, 'Working directory') as HTMLInputElement, '/tmp/release')

    const modelSelect = getByRole(document.body, 'combobox', { name: 'Model' })
    click(modelSelect as HTMLElement)
    click(getByRole(document.body, 'option', { name: 'pi-opus' }))

    click(getByRole(document.body, 'button', { name: 'Create manager' }))

    const validatePayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')
    expect(validatePayload.type).toBe('validate_directory')
    expect(validatePayload.path).toBe('/tmp/release')

    emitServerEvent(socket, {
      type: 'directory_validated',
      requestId: validatePayload.requestId,
      path: '/tmp/release',
      valid: true,
    })

    await vi.advanceTimersByTimeAsync(0)

    const parsedPayloads = socket.sentPayloads.map((payload) => JSON.parse(payload))
    const createPayload = parsedPayloads.find((payload) => payload.type === 'create_manager')

    expect(createPayload).toMatchObject({
      type: 'create_manager',
      name: 'release-manager',
      cwd: '/tmp/release',
      model: 'pi-opus',
    })
    expect(typeof createPayload?.requestId).toBe('string')

    emitServerEvent(socket, {
      type: 'manager_created',
      requestId: createPayload?.requestId,
      manager: buildManager('release-manager', '/tmp/release'),
    })

    await vi.advanceTimersByTimeAsync(0)
  })

  it('shows only user input and speak_to_user transcript entries for the selected manager context', async () => {
    const socket = await renderPage()

    emitServerEvent(socket, {
      type: 'agents_snapshot',
      agents: [
        buildManager('manager', '/tmp/manager'),
        buildWorker('worker-owned', 'manager', '/tmp/manager'),
        buildManager('other-manager', '/tmp/other-manager'),
        buildWorker('worker-foreign', 'other-manager', '/tmp/other-manager'),
      ],
    })

    emitServerEvent(socket, {
      type: 'conversation_history',
      agentId: 'manager',
      messages: [
        {
          type: 'conversation_message',
          agentId: 'manager',
          role: 'assistant',
          text: 'manager reply',
          timestamp: new Date().toISOString(),
          source: 'speak_to_user',
        },
        {
          type: 'conversation_message',
          agentId: 'manager',
          role: 'user',
          text: 'user asks manager',
          timestamp: new Date().toISOString(),
          source: 'user_input',
        },
        {
          type: 'conversation_message',
          agentId: 'worker-owned',
          role: 'assistant',
          text: 'owned worker reply',
          timestamp: new Date().toISOString(),
          source: 'speak_to_user',
        },
        {
          type: 'conversation_message',
          agentId: 'worker-foreign',
          role: 'assistant',
          text: 'foreign worker reply',
          timestamp: new Date().toISOString(),
          source: 'speak_to_user',
        },
        {
          type: 'agent_message',
          agentId: 'manager',
          timestamp: new Date().toISOString(),
          source: 'agent_to_agent',
          fromAgentId: 'worker-owned',
          toAgentId: 'worker-owned',
          text: 'owned worker chatter',
        },
        {
          type: 'agent_tool_call',
          agentId: 'manager',
          actorAgentId: 'manager',
          timestamp: new Date().toISOString(),
          kind: 'tool_execution_start',
          toolName: 'speak_to_user',
          toolCallId: 'manager-call',
          text: '{"text":"hello"}',
        },
        {
          type: 'agent_tool_call',
          agentId: 'manager',
          actorAgentId: 'worker-owned',
          timestamp: new Date().toISOString(),
          kind: 'tool_execution_start',
          toolName: 'read',
          toolCallId: 'owned-call',
          text: '{"path":"README.md"}',
        },
        {
          type: 'agent_message',
          agentId: 'manager',
          timestamp: new Date().toISOString(),
          source: 'agent_to_agent',
          fromAgentId: 'worker-foreign',
          toAgentId: 'worker-foreign',
          text: 'foreign worker chatter',
        },
        {
          type: 'agent_tool_call',
          agentId: 'manager',
          actorAgentId: 'worker-foreign',
          timestamp: new Date().toISOString(),
          kind: 'tool_execution_start',
          toolName: 'read',
          toolCallId: 'foreign-call',
          text: '{"path":"SECRET.md"}',
        },
      ],
    })

    await vi.advanceTimersByTimeAsync(0)

    expect(queryByText(container, 'manager reply')).not.toBeNull()
    expect(queryByText(container, 'user asks manager')).not.toBeNull()
    expect(queryByText(container, 'owned worker reply')).not.toBeNull()
    expect(queryByText(container, 'owned worker chatter')).toBeNull()
    expect(queryByText(container, /manager-call/)).toBeNull()
    expect(queryByText(container, /owned-call/)).toBeNull()
    expect(queryByText(container, 'foreign worker reply')).toBeNull()
    expect(queryByText(container, 'foreign worker chatter')).toBeNull()
    expect(queryByText(container, /foreign-call/)).toBeNull()
  })
})
