import { describe, expect, it } from 'vitest'
import type { AgentDescriptor, ConversationEntry } from '@middleman/protocol'
import { deriveVisibleMessages } from './use-visible-messages'

const manager: AgentDescriptor = {
  agentId: 'manager',
  displayName: 'Manager',
  role: 'manager',
  managerId: 'manager',
  status: 'idle',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  cwd: '/tmp/project',
  model: {
    provider: 'openai',
    modelId: 'gpt-5',
    thinkingLevel: 'high',
  },
}

const worker: AgentDescriptor = {
  ...manager,
  agentId: 'worker-1',
  displayName: 'Worker 1',
  role: 'worker',
  managerId: 'manager',
}

describe('useVisibleMessages', () => {
  it('keeps manager transcript views on conversation messages without merging activity', () => {
    const messages: ConversationEntry[] = [
      {
        type: 'conversation_message',
        agentId: 'manager',
        role: 'user',
        text: 'hello',
        timestamp: '2026-01-01T00:00:00.000Z',
        source: 'user_input',
      },
      {
        type: 'conversation_message',
        agentId: 'worker-1',
        role: 'assistant',
        text: 'done',
        timestamp: '2026-01-01T00:00:01.000Z',
        source: 'speak_to_user',
      },
    ]
    const activityMessages: ConversationEntry[] = [
      {
        type: 'agent_tool_call',
        agentId: 'manager',
        actorAgentId: 'worker-1',
        timestamp: '2026-01-01T00:00:00.500Z',
        kind: 'tool_execution_start',
        toolName: 'bash',
        toolCallId: 'tool-1',
        text: '{"command":"echo hi"}',
      },
    ]

    const result = deriveVisibleMessages({
      messages,
      activityMessages,
      agents: [manager, worker],
      activeAgent: manager,
    })

    expect(result.allMessages).toBe(messages)
    expect(result.visibleMessages).toEqual(messages)
  })

  it('keeps runtime error logs visible in manager transcript views', () => {
    const messages: ConversationEntry[] = [
      {
        type: 'conversation_log',
        agentId: 'manager',
        timestamp: '2026-01-01T00:00:00.000Z',
        source: 'runtime_log',
        kind: 'message_end',
        text: 'Missing authentication for openai-codex. Configure credentials in Settings.',
        isError: true,
      },
    ]

    const result = deriveVisibleMessages({
      messages,
      activityMessages: [],
      agents: [manager],
      activeAgent: manager,
    })

    expect(result.visibleMessages).toEqual(messages)
  })

  it('merges activity into worker detail timelines', () => {
    const messages: ConversationEntry[] = [
      {
        type: 'conversation_message',
        agentId: 'worker-1',
        role: 'assistant',
        text: 'after',
        timestamp: '2026-01-01T00:00:02.000Z',
        source: 'speak_to_user',
      },
    ]
    const activityMessages: ConversationEntry[] = [
      {
        type: 'agent_message',
        agentId: 'worker-1',
        timestamp: '2026-01-01T00:00:01.000Z',
        source: 'agent_to_agent',
        fromAgentId: 'manager',
        toAgentId: 'worker-1',
        text: 'before',
      },
    ]

    const result = deriveVisibleMessages({
      messages,
      activityMessages,
      agents: [manager, worker],
      activeAgent: worker,
    })

    expect(result.allMessages.map((entry) => entry.type)).toEqual([
      'agent_message',
      'conversation_message',
    ])
    expect(result.visibleMessages).toEqual(result.allMessages)
  })

  it('hides worker internal chatter when disabled', () => {
    const messages: ConversationEntry[] = [
      {
        type: 'conversation_message',
        agentId: 'worker-1',
        role: 'assistant',
        text: 'after',
        timestamp: '2026-01-01T00:00:02.000Z',
        source: 'speak_to_user',
      },
    ]
    const activityMessages: ConversationEntry[] = [
      {
        type: 'agent_message',
        agentId: 'worker-1',
        timestamp: '2026-01-01T00:00:01.000Z',
        source: 'agent_to_agent',
        fromAgentId: 'manager',
        toAgentId: 'worker-1',
        text: 'before',
      },
    ]

    const result = deriveVisibleMessages({
      messages,
      activityMessages,
      agents: [manager, worker],
      activeAgent: worker,
      showInternalChatter: false,
    })

    expect(result.allMessages.map((entry) => entry.type)).toEqual([
      'agent_message',
      'conversation_message',
    ])
    expect(result.visibleMessages).toEqual(messages)
  })

  it('includes manager-scoped internal chatter when enabled', () => {
    const messages: ConversationEntry[] = [
      {
        type: 'conversation_message',
        agentId: 'manager',
        role: 'user',
        text: 'hello',
        timestamp: '2026-01-01T00:00:00.000Z',
        source: 'user_input',
      },
      {
        type: 'conversation_message',
        agentId: 'manager',
        role: 'assistant',
        text: 'done',
        timestamp: '2026-01-01T00:00:03.000Z',
        source: 'speak_to_user',
      },
    ]
    const activityMessages: ConversationEntry[] = [
      {
        type: 'agent_message',
        agentId: 'manager',
        timestamp: '2026-01-01T00:00:01.000Z',
        source: 'agent_to_agent',
        fromAgentId: 'manager',
        toAgentId: 'worker-1',
        text: 'investigate',
      },
      {
        type: 'agent_message',
        agentId: 'manager',
        timestamp: '2026-01-01T00:00:02.000Z',
        source: 'agent_to_agent',
        fromAgentId: 'other-manager',
        toAgentId: 'manager',
        text: 'need a hand',
      },
    ]
    const otherManager: AgentDescriptor = {
      ...manager,
      agentId: 'other-manager',
      displayName: 'Other Manager',
      managerId: 'other-manager',
    }

    const result = deriveVisibleMessages({
      messages,
      activityMessages,
      agents: [manager, worker, otherManager],
      activeAgent: manager,
      showInternalChatter: true,
    })

    expect(result.visibleMessages.map((entry) => entry.type)).toEqual([
      'conversation_message',
      'agent_message',
      'agent_message',
      'conversation_message',
    ])
    expect(result.visibleMessages.filter((entry) => entry.type === 'agent_message')).toHaveLength(2)
  })

  it('hides manager-scoped internal chatter when disabled', () => {
    const messages: ConversationEntry[] = [
      {
        type: 'conversation_message',
        agentId: 'manager',
        role: 'user',
        text: 'hello',
        timestamp: '2026-01-01T00:00:00.000Z',
        source: 'user_input',
      },
    ]
    const activityMessages: ConversationEntry[] = [
      {
        type: 'agent_message',
        agentId: 'manager',
        timestamp: '2026-01-01T00:00:01.000Z',
        source: 'agent_to_agent',
        fromAgentId: 'manager',
        toAgentId: 'other-manager',
        text: 'ping',
      },
    ]
    const otherManager: AgentDescriptor = {
      ...manager,
      agentId: 'other-manager',
      displayName: 'Other Manager',
      managerId: 'other-manager',
    }

    const result = deriveVisibleMessages({
      messages,
      activityMessages,
      agents: [manager, otherManager],
      activeAgent: manager,
      showInternalChatter: false,
    })

    expect(result.visibleMessages).toEqual(messages)
  })
})
