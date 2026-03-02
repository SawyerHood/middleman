import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolDefinition } from '@mariozechner/pi-coding-agent'
import type { RuntimeSessionEvent } from '../swarm/runtime-types.js'
import type { AgentDescriptor } from '../swarm/types.js'

const sdkMockState = vi.hoisted(() => ({
  instances: [] as any[],
  lastQueryParams: undefined as any,
}))

const bridgeMockState = vi.hoisted(() => ({
  buildClaudeCodeMcpServer: vi.fn(() => ({
    type: 'sdk',
    name: 'middleman-swarm',
    instance: {},
  })),
  getClaudeCodeAllowedToolNames: vi.fn(
    (tools: Array<{ name: string }>, options?: { serverName?: string }) => {
      const serverName = options?.serverName ?? 'middleman-swarm'
      return tools.map((tool) => `mcp__${serverName}__${tool.name}`)
    },
  ),
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  class MockAbortError extends Error {}

  class MockQuery {
    private queue: unknown[] = []
    private resolvers: Array<(value: IteratorResult<any>) => void> = []
    private done = false

    interrupt = vi.fn(async () => {})
    close = vi.fn(() => {
      this.finish()
    })
    setPermissionMode = vi.fn(async () => {})
    setModel = vi.fn(async () => {})
    setMaxThinkingTokens = vi.fn(async () => {})
    initializationResult = vi.fn(async () => ({}))
    supportedCommands = vi.fn(async () => [])
    supportedModels = vi.fn(async () => [])
    supportedAgents = vi.fn(async () => [])
    mcpServerStatus = vi.fn(async () => [])
    accountInfo = vi.fn(async () => ({}))
    rewindFiles = vi.fn(async () => ({ canRewind: false }))
    reconnectMcpServer = vi.fn(async () => {})
    toggleMcpServer = vi.fn(async () => {})
    setMcpServers = vi.fn(async () => ({ added: [], removed: [], errors: [] }))
    streamInput = vi.fn(async () => {})
    stopTask = vi.fn(async () => {})

    async next() {
      if (this.queue.length > 0) {
        return {
          done: false,
          value: this.queue.shift(),
        }
      }

      if (this.done) {
        return {
          done: true,
          value: undefined,
        }
      }

      return await new Promise<IteratorResult<any>>((resolve) => {
        this.resolvers.push(resolve)
      })
    }

    async return() {
      this.finish()
      return {
        done: true,
        value: undefined,
      }
    }

    push(message: unknown): void {
      if (this.done) {
        return
      }

      const resolve = this.resolvers.shift()
      if (resolve) {
        resolve({
          done: false,
          value: message,
        })
        return
      }

      this.queue.push(message)
    }

    finish(): void {
      this.done = true
      while (this.resolvers.length > 0) {
        const resolve = this.resolvers.shift()
        resolve?.({
          done: true,
          value: undefined,
        })
      }
    }
  }

  return {
    AbortError: MockAbortError,
    query: vi.fn((params: unknown) => {
      sdkMockState.lastQueryParams = params
      const query = new MockQuery()
      ;(query as any)[Symbol.asyncIterator] = function () {
        return this
      }
      sdkMockState.instances.push(query)
      return query
    }),
  }
})

vi.mock('../swarm/claude-code-tool-bridge.js', () => ({
  CLAUDE_CODE_MCP_SERVER_NAME: 'middleman-swarm',
  buildClaudeCodeMcpServer: bridgeMockState.buildClaudeCodeMcpServer,
  getClaudeCodeAllowedToolNames: bridgeMockState.getClaudeCodeAllowedToolNames,
}))

import { ClaudeCodeRuntime } from '../swarm/claude-code-runtime.js'

function makeDescriptor(baseDir: string): AgentDescriptor {
  return {
    agentId: 'claude-worker',
    displayName: 'Claude Worker',
    role: 'worker',
    managerId: 'manager',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: baseDir,
    model: {
      provider: 'anthropic-claude-code',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'xhigh',
    },
    sessionFile: join(baseDir, 'sessions', 'claude-worker.jsonl'),
  }
}

function makeTools(): ToolDefinition[] {
  return [
    {
      name: 'list_agents',
      label: 'List Agents',
      description: 'List swarm agents',
      parameters: {},
      execute: async () => ({
        content: [{ type: 'text', text: 'ok' }],
      }),
    } as unknown as ToolDefinition,
    {
      name: 'send_message_to_agent',
      label: 'Send Message',
      description: 'Send a message to another agent',
      parameters: {},
      execute: async () => ({
        content: [{ type: 'text', text: 'queued' }],
      }),
    } as unknown as ToolDefinition,
  ]
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  sdkMockState.instances.length = 0
  sdkMockState.lastQueryParams = undefined
  bridgeMockState.buildClaudeCodeMcpServer.mockClear()
  bridgeMockState.getClaudeCodeAllowedToolNames.mockClear()
})

describe('ClaudeCodeRuntime', () => {
  it('routes prompt/steer delivery modes and consumes pending deliveries from echoed user messages', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'swarm-claude-runtime-'))
    const descriptor = makeDescriptor(baseDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    const statuses: Array<{ status: string; pendingCount: number }> = []
    const sessionEvents: RuntimeSessionEvent[] = []
    const runtimeErrors: Array<{ phase: string; message: string }> = []

    const runtime = await ClaudeCodeRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async (_agentId, status, pendingCount) => {
          statuses.push({ status, pendingCount })
        },
        onSessionEvent: async (_agentId, event) => {
          sessionEvents.push(event)
        },
        onRuntimeError: async (_agentId, error) => {
          runtimeErrors.push({ phase: error.phase, message: error.message })
        },
        onAgentEnd: async () => {},
      },
      systemPrompt: 'You are a test Claude runtime.',
      tools: makeTools(),
      runtimeEnv: {
        SWARM_DATA_DIR: '/tmp/swarm-data',
      },
    })

    const queryParams = sdkMockState.lastQueryParams
    expect(queryParams?.options?.permissionMode).toBe('bypassPermissions')
    expect(queryParams?.options?.allowDangerouslySkipPermissions).toBe(true)
    expect(queryParams?.options?.model).toBe('claude-opus-4-6')
    expect(queryParams?.options?.mcpServers).toMatchObject({
      'middleman-swarm': {
        type: 'sdk',
      },
    })
    expect(queryParams?.options?.allowedTools).toEqual([
      'mcp__middleman-swarm__list_agents',
      'mcp__middleman-swarm__send_message_to_agent',
    ])

    const firstReceipt = await runtime.sendMessage('first prompt')
    const queuedReceipt = await runtime.sendMessage('queued steer')

    expect(firstReceipt.acceptedMode).toBe('prompt')
    expect(queuedReceipt.acceptedMode).toBe('steer')
    expect(runtime.getPendingCount()).toBe(1)

    const query = sdkMockState.instances[0]
    query.push({
      type: 'system',
      subtype: 'init',
      session_id: 'session-1',
    })

    query.push({
      type: 'user',
      message: {
        role: 'user',
        content: 'queued steer',
      },
      parent_tool_use_id: null,
      session_id: 'session-1',
    })

    await flush()
    expect(runtime.getPendingCount()).toBe(0)

    query.push({
      type: 'result',
      subtype: 'success',
      result: 'ok',
      duration_ms: 10,
      duration_api_ms: 8,
      is_error: false,
      num_turns: 1,
      stop_reason: null,
      total_cost_usd: 0,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      modelUsage: {
        'claude-opus-4-6': {
          inputTokens: 10,
          outputTokens: 5,
          contextWindow: 200000,
        },
      },
      permission_denials: [],
      uuid: 'result-1',
      session_id: 'session-1',
    })

    await flush()

    expect(runtime.getStatus()).toBe('idle')
    expect(runtime.getContextUsage()).toEqual({
      tokens: 15,
      contextWindow: 200000,
      percent: 0.0075,
    })

    expect(sessionEvents.map((event) => event.type)).toEqual(
      expect.arrayContaining(['agent_start', 'message_start', 'message_end', 'agent_end']),
    )
    expect(runtimeErrors).toEqual([])
    expect(statuses.at(-1)).toMatchObject({ status: 'idle', pendingCount: 0 })

    await runtime.terminate({ abort: false })
  })

  it('maps stream deltas and tool lifecycle events from SDK messages', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'swarm-claude-runtime-'))
    const descriptor = makeDescriptor(baseDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    const sessionEvents: RuntimeSessionEvent[] = []

    const runtime = await ClaudeCodeRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async () => {},
        onSessionEvent: async (_agentId, event) => {
          sessionEvents.push(event)
        },
        onAgentEnd: async () => {},
      },
      systemPrompt: 'You are a test Claude runtime.',
      tools: makeTools(),
    })

    await runtime.sendMessage('run tool')

    const query = sdkMockState.instances[0]
    query.push({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: {
          type: 'text_delta',
          text: 'partial text',
        },
      },
      parent_tool_use_id: null,
      uuid: 'stream-1',
      session_id: 'session-1',
    })

    query.push({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'Using tool now',
          },
          {
            type: 'tool_use',
            id: 'tool-call-1',
            name: 'send_message_to_agent',
            input: {
              targetAgentId: 'worker-2',
              message: 'hello',
            },
          },
        ],
      },
      parent_tool_use_id: null,
      uuid: 'assistant-1',
      session_id: 'session-1',
    })

    query.push({
      type: 'tool_progress',
      tool_use_id: 'tool-call-1',
      tool_name: 'send_message_to_agent',
      parent_tool_use_id: null,
      elapsed_time_seconds: 1,
      uuid: 'progress-1',
      session_id: 'session-1',
    })

    query.push({
      type: 'user',
      message: {
        role: 'user',
        content: '',
      },
      parent_tool_use_id: 'tool-call-1',
      isSynthetic: true,
      tool_use_result: {
        status: 'completed',
      },
      session_id: 'session-1',
    })

    query.push({
      type: 'result',
      subtype: 'success',
      result: 'done',
      duration_ms: 10,
      duration_api_ms: 8,
      is_error: false,
      num_turns: 1,
      stop_reason: null,
      total_cost_usd: 0,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      modelUsage: {
        'claude-opus-4-6': {
          inputTokens: 10,
          outputTokens: 5,
          contextWindow: 200000,
        },
      },
      permission_denials: [],
      uuid: 'result-1',
      session_id: 'session-1',
    })

    await flush()

    expect(sessionEvents).toEqual(
      expect.arrayContaining([
        {
          type: 'message_update',
          message: {
            role: 'assistant',
            content: 'partial text',
          },
        },
        {
          type: 'tool_execution_start',
          toolName: 'send_message_to_agent',
          toolCallId: 'tool-call-1',
          args: {
            targetAgentId: 'worker-2',
            message: 'hello',
          },
        },
        {
          type: 'tool_execution_update',
          toolName: 'send_message_to_agent',
          toolCallId: 'tool-call-1',
          partialResult: {
            elapsedTimeSeconds: 1,
            taskId: undefined,
          },
        },
        {
          type: 'tool_execution_end',
          toolName: 'send_message_to_agent',
          toolCallId: 'tool-call-1',
          result: {
            status: 'completed',
          },
          isError: false,
        },
      ]),
    )

    await runtime.terminate({ abort: false })
  })

  it('resumes persisted sessions and supports stop/terminate lifecycle controls', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'swarm-claude-runtime-'))
    const descriptor = makeDescriptor(baseDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    const runtimePrototype = ClaudeCodeRuntime.prototype as any
    const originalReadPersistedState = runtimePrototype.readPersistedRuntimeState
    runtimePrototype.readPersistedRuntimeState = () => ({
      sessionId: 'persisted-session-1',
    })

    try {
      const runtime = await ClaudeCodeRuntime.create({
        descriptor,
        callbacks: {
          onStatusChange: async () => {},
        },
        systemPrompt: 'You are a test Claude runtime.',
        tools: makeTools(),
      })

      expect(sdkMockState.lastQueryParams?.options?.resume).toBe('persisted-session-1')

      await runtime.sendMessage('interrupt me')
      await runtime.sendMessage('queued steer')
      expect((runtime as any).inputQueue.length).toBe(2)
      expect(runtime.getPendingCount()).toBe(1)

      await runtime.stopInFlight()

      const query = sdkMockState.instances[0]
      expect(query.interrupt).toHaveBeenCalledTimes(1)
      expect(runtime.getStatus()).toBe('idle')
      expect(runtime.getPendingCount()).toBe(0)
      expect((runtime as any).inputQueue.length).toBe(0)

      await runtime.terminate({ abort: false })

      expect(query.close).toHaveBeenCalledTimes(1)
      expect(runtime.getStatus()).toBe('terminated')
    } finally {
      runtimePrototype.readPersistedRuntimeState = originalReadPersistedState
    }
  })

  it('terminates runtime and rejects new sends when SDK stream exits unexpectedly', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'swarm-claude-runtime-'))
    const descriptor = makeDescriptor(baseDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    const statuses: string[] = []
    const runtimeErrors: Array<{ phase: string; message: string }> = []

    const runtime = await ClaudeCodeRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async (_agentId, status) => {
          statuses.push(status)
        },
        onRuntimeError: async (_agentId, error) => {
          runtimeErrors.push({ phase: error.phase, message: error.message })
        },
      },
      systemPrompt: 'You are a test Claude runtime.',
      tools: makeTools(),
    })

    const query = sdkMockState.instances[0]
    query.finish()

    await flush()

    expect(runtime.getStatus()).toBe('terminated')
    expect(statuses.at(-1)).toBe('terminated')
    expect(runtimeErrors.at(-1)?.phase).toBe('runtime_exit')
    await expect(runtime.sendMessage('after exit')).rejects.toThrow(/terminated|unavailable/i)
  })

  it('ignores replayed user and assistant messages to avoid duplicate projection', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'swarm-claude-runtime-'))
    const descriptor = makeDescriptor(baseDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    const sessionEvents: RuntimeSessionEvent[] = []

    const runtime = await ClaudeCodeRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async () => {},
        onSessionEvent: async (_agentId, event) => {
          sessionEvents.push(event)
        },
      },
      systemPrompt: 'You are a test Claude runtime.',
      tools: makeTools(),
    })

    const query = sdkMockState.instances[0]
    query.push({
      type: 'user',
      isReplay: true,
      message: {
        role: 'user',
        content: 'historical user',
      },
      parent_tool_use_id: null,
      session_id: 'session-1',
    })
    query.push({
      type: 'assistant',
      isReplay: true,
      message: {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'historical assistant',
          },
        ],
      },
      parent_tool_use_id: null,
      session_id: 'session-1',
    })
    query.push({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'fresh assistant',
          },
        ],
      },
      parent_tool_use_id: null,
      session_id: 'session-1',
    })

    await flush()

    const messageEvents = sessionEvents.filter(
      (event) => event.type === 'message_start' || event.type === 'message_end',
    )

    expect(messageEvents).toEqual([
      {
        type: 'message_start',
        message: {
          role: 'assistant',
          content: 'fresh assistant',
        },
      },
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: 'fresh assistant',
        },
      },
    ])

    await runtime.terminate({ abort: false })
  })
})
