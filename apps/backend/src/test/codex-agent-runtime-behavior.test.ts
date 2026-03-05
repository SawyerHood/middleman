import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeErrorEvent, RuntimeSessionEvent } from '../swarm/runtime-types.js'
import type { AgentDescriptor, AgentStatus } from '../swarm/types.js'

const rpcMockState = vi.hoisted(() => ({
  requestImpl: vi.fn<(...args: [any, string, unknown?]) => Promise<unknown>>(async () => ({})),
  instances: [] as any[],
}))

vi.mock('../swarm/codex-jsonrpc-client.js', () => ({
  CodexJsonRpcClient: class MockCodexJsonRpcClient {
    readonly options: {
      onNotification?: (notification: unknown) => Promise<void> | void
      onRequest?: (request: unknown) => Promise<unknown>
      onExit?: (error: Error) => void
    }

    readonly requestCalls: Array<{ method: string; params: unknown }> = []
    readonly notifyCalls: Array<{ method: string; params: unknown }> = []
    disposed = false

    constructor(options: {
      onNotification?: (notification: unknown) => Promise<void> | void
      onRequest?: (request: unknown) => Promise<unknown>
      onExit?: (error: Error) => void
    }) {
      this.options = options
      rpcMockState.instances.push(this)
    }

    async request(method: string, params?: unknown): Promise<unknown> {
      this.requestCalls.push({ method, params })
      return await rpcMockState.requestImpl(this, method, params)
    }

    notify(method: string, params?: unknown): void {
      this.notifyCalls.push({ method, params })
    }

    dispose(): void {
      this.disposed = true
    }

    async emitNotification(notification: unknown): Promise<void> {
      await this.options.onNotification?.(notification)
    }

    emitExit(error: Error): void {
      this.options.onExit?.(error)
    }
  },
}))

import { CodexAgentRuntime } from '../swarm/codex-agent-runtime.js'

function makeDescriptor(baseDir: string): AgentDescriptor {
  return {
    agentId: 'codex-worker',
    displayName: 'Codex Worker',
    role: 'worker',
    managerId: 'manager',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: baseDir,
    model: {
      provider: 'openai-codex-app-server',
      modelId: 'default',
      thinkingLevel: 'xhigh',
    },
    sessionFile: join(baseDir, 'sessions', 'codex-worker.jsonl'),
  }
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve = (_value: T): void => {}
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })

  return { promise, resolve }
}

beforeEach(() => {
  rpcMockState.instances.length = 0
  rpcMockState.requestImpl.mockReset()
  rpcMockState.requestImpl.mockImplementation(async () => ({}))
})

describe('CodexAgentRuntime behavior', () => {
  it('authenticates with CODEX_API_KEY and resumes a persisted thread', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'swarm-codex-runtime-'))
    const descriptor = makeDescriptor(tempDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    const runtimePrototype = CodexAgentRuntime.prototype as any
    const originalReadPersistedState = runtimePrototype.readPersistedRuntimeState
    runtimePrototype.readPersistedRuntimeState = () => ({
      threadId: 'persisted-thread',
    })

    const previousApiKey = process.env.CODEX_API_KEY
    process.env.CODEX_API_KEY = 'sk-test-key'

    try {
      let accountReadCalls = 0

      rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string, params: unknown) => {
        if (method === 'initialize') {
          return {}
        }

        if (method === 'account/read') {
          accountReadCalls += 1
          if (accountReadCalls === 1) {
            return { requiresOpenaiAuth: true, account: null }
          }

          return { requiresOpenaiAuth: true, account: { id: 'acct-1' } }
        }

        if (method === 'account/login/start') {
          expect(params).toMatchObject({
            type: 'apiKey',
            apiKey: 'sk-test-key',
          })
          return { ok: true }
        }

        if (method === 'thread/resume') {
          expect(params).toMatchObject({
            threadId: 'persisted-thread',
            cwd: descriptor.cwd,
          })
          return { thread: { id: 'resumed-thread' } }
        }

        throw new Error(`Unexpected method: ${method}`)
      })

      const runtime = await CodexAgentRuntime.create({
        descriptor,
        callbacks: {
          onStatusChange: async () => {},
        },
        systemPrompt: 'You are a test codex runtime.',
        tools: [],
      })

      const instance = rpcMockState.instances[0]
      const calledMethods = instance.requestCalls.map((entry: { method: string }) => entry.method)

      expect(calledMethods).toContain('account/login/start')
      expect(calledMethods).toContain('thread/resume')
      expect(calledMethods).not.toContain('thread/start')

      await runtime.terminate({ abort: false })
    } finally {
      runtimePrototype.readPersistedRuntimeState = originalReadPersistedState
      if (previousApiKey === undefined) {
        delete process.env.CODEX_API_KEY
      } else {
        process.env.CODEX_API_KEY = previousApiKey
      }
    }
  })

  it('falls back to thread/start when thread/resume fails and throws when auth is still missing', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'swarm-codex-runtime-'))
    const descriptor = makeDescriptor(tempDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    const runtimePrototype = CodexAgentRuntime.prototype as any
    const originalReadPersistedState = runtimePrototype.readPersistedRuntimeState
    runtimePrototype.readPersistedRuntimeState = () => ({
      threadId: 'stale-thread',
    })

    try {
      rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string) => {
        if (method === 'initialize') {
          return {}
        }

        if (method === 'account/read') {
          return { requiresOpenaiAuth: false, account: { id: 'acct-2' } }
        }

        if (method === 'thread/resume') {
          throw new Error('resume failed')
        }

        if (method === 'thread/start') {
          return { thread: { id: 'new-thread' } }
        }

        throw new Error(`Unexpected method: ${method}`)
      })

      const runtime = await CodexAgentRuntime.create({
        descriptor: makeDescriptor(tempDir),
        callbacks: {
          onStatusChange: async () => {},
        },
        systemPrompt: 'You are a test codex runtime.',
        tools: [],
      })

      const instance = rpcMockState.instances[0]
      const calledMethods = instance.requestCalls.map((entry: { method: string }) => entry.method)
      expect(calledMethods).toContain('thread/resume')
      expect(calledMethods).toContain('thread/start')

      await runtime.terminate({ abort: false })

      rpcMockState.instances.length = 0
      rpcMockState.requestImpl.mockReset()
      rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string) => {
        if (method === 'initialize') {
          return {}
        }

        if (method === 'account/read') {
          return { requiresOpenaiAuth: true, account: null }
        }

        return {}
      })

      await expect(
        CodexAgentRuntime.create({
          descriptor: makeDescriptor(tempDir),
          callbacks: {
            onStatusChange: async () => {},
          },
          systemPrompt: 'You are a test codex runtime.',
          tools: [],
        }),
      ).rejects.toThrow('Codex runtime requires authentication.')

      const failedInstance = rpcMockState.instances[0]
      expect(failedInstance.disposed).toBe(true)
    } finally {
      runtimePrototype.readPersistedRuntimeState = originalReadPersistedState
    }
  })

  it('persists custom session entries even without assistant session messages', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'swarm-codex-runtime-'))
    const descriptor = makeDescriptor(tempDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string) => {
      if (method === 'initialize') {
        return {}
      }

      if (method === 'account/read') {
        return { requiresOpenaiAuth: false, account: { id: 'acct-1' } }
      }

      if (method === 'thread/start') {
        return { thread: { id: 'thread-1' } }
      }

      throw new Error(`Unexpected method: ${method}`)
    })

    const runtime = await CodexAgentRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async () => {},
      },
      systemPrompt: 'You are a test codex runtime.',
      tools: [],
    })

    runtime.appendCustomEntry('swarm_codex_runtime_state', {
      threadId: 'thread-1',
    })
    runtime.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_log',
      agentId: descriptor.agentId,
      timestamp: new Date().toISOString(),
      source: 'runtime_log',
      kind: 'message_end',
      role: 'assistant',
      text: 'persisted output',
    })

    await runtime.terminate({ abort: false })

    const serialized = await readFile(descriptor.sessionFile, 'utf8')
    const lines = serialized
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { type?: string; customType?: string; data?: unknown })

    expect(lines[0]?.type).toBe('session')
    expect(
      lines.some(
        (entry) =>
          entry.type === 'custom' &&
          entry.customType === 'swarm_codex_runtime_state' &&
          (entry.data as { threadId?: string }).threadId === 'thread-1',
      ),
    ).toBe(true)
    expect(
      lines.some(
        (entry) =>
          entry.type === 'custom' &&
          entry.customType === 'swarm_conversation_entry' &&
          (entry.data as { type?: string }).type === 'conversation_log',
      ),
    ).toBe(true)
  })

  it('queues steer while turn/start is pending and flushes steers in order once start resolves', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'swarm-codex-runtime-'))
    const descriptor = makeDescriptor(tempDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    const turnStartDeferred = createDeferred<{ turn: { id: string } }>()

    rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string, params: unknown) => {
      if (method === 'initialize') {
        return {}
      }

      if (method === 'account/read') {
        return { requiresOpenaiAuth: false, account: { id: 'acct-1' } }
      }

      if (method === 'thread/start') {
        return { thread: { id: 'thread-1' } }
      }

      if (method === 'turn/start') {
        return await turnStartDeferred.promise
      }

      if (method === 'turn/steer') {
        return {
          accepted: true,
          input: params,
        }
      }

      throw new Error(`Unexpected method: ${method}`)
    })

    const runtime = await CodexAgentRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async () => {},
      },
      systemPrompt: 'You are a test codex runtime.',
      tools: [],
    })

    const firstPromise = runtime.sendMessage('first prompt')
    await Promise.resolve()

    const queuedOne = await runtime.sendMessage('queued steer one')
    const queuedTwo = await runtime.sendMessage('queued steer two')
    expect(queuedOne.acceptedMode).toBe('steer')
    expect(queuedTwo.acceptedMode).toBe('steer')

    turnStartDeferred.resolve({ turn: { id: 'turn-1' } })

    const first = await firstPromise
    expect(first.acceptedMode).toBe('prompt')

    const instance = rpcMockState.instances[0]
    const requestMethods = instance.requestCalls.map((entry: { method: string }) => entry.method)
    const steerCalls = instance.requestCalls.filter((entry: { method: string }) => entry.method === 'turn/steer')

    expect(requestMethods).toEqual(expect.arrayContaining(['turn/start', 'turn/steer', 'turn/steer']))
    expect(steerCalls).toHaveLength(2)
    expect(steerCalls[0]?.params).toMatchObject({
      expectedTurnId: 'turn-1',
    })
    expect(steerCalls[1]?.params).toMatchObject({
      expectedTurnId: 'turn-1',
    })

    await runtime.terminate({ abort: false })
  })

  it('translates turn notifications, handles runtime exit, and reports terminated status', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'swarm-codex-runtime-'))
    const descriptor = makeDescriptor(tempDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    const statuses: AgentStatus[] = []
    const sessionEvents: RuntimeSessionEvent[] = []
    const runtimeErrors: RuntimeErrorEvent[] = []
    let agentEndCalls = 0

    rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string) => {
      if (method === 'initialize') {
        return {}
      }

      if (method === 'account/read') {
        return { requiresOpenaiAuth: false, account: { id: 'acct-1' } }
      }

      if (method === 'thread/start') {
        return { thread: { id: 'thread-1' } }
      }

      return {}
    })

    const runtime = await CodexAgentRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async (_agentId, status) => {
          statuses.push(status)
        },
        onSessionEvent: async (_agentId, event) => {
          sessionEvents.push(event)
        },
        onRuntimeError: async (_agentId, event) => {
          runtimeErrors.push(event)
        },
        onAgentEnd: async () => {
          agentEndCalls += 1
        },
      },
      systemPrompt: 'You are a test codex runtime.',
      tools: [],
    })

    const instance = rpcMockState.instances[0]
    await instance.emitNotification({
      method: 'turn/started',
      params: {
        turn: { id: 'turn-42' },
      },
    })
    await instance.emitNotification({
      method: 'item/agentMessage/delta',
      params: {
        delta: 'Hello from codex',
      },
    })
    await instance.emitNotification({
      method: 'turn/completed',
    })

    expect(statuses).toContain('streaming')
    expect(statuses).toContain('idle')
    expect(agentEndCalls).toBe(1)
    expect(sessionEvents).toContainEqual(
      expect.objectContaining({
        type: 'message_update',
        message: {
          role: 'assistant',
          content: 'Hello from codex',
        },
      }),
    )

    instance.emitExit(new Error('app-server crashed'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(runtimeErrors).toContainEqual(
      expect.objectContaining({
        phase: 'runtime_exit',
        message: 'app-server crashed',
      }),
    )
    expect(runtime.getStatus()).toBe('terminated')
    expect(statuses.at(-1)).toBe('terminated')
    expect(sessionEvents).toContainEqual(
      expect.objectContaining({
        type: 'tool_execution_end',
        toolName: 'codex-app-server',
        isError: true,
      }),
    )
    await expect(runtime.sendMessage('after exit')).rejects.toThrow('is terminated')
  })

  it('interrupts active turns during terminate() and clears pending queues', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'swarm-codex-runtime-'))
    const descriptor = makeDescriptor(tempDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string) => {
      if (method === 'initialize') {
        return {}
      }

      if (method === 'account/read') {
        return { requiresOpenaiAuth: false, account: { id: 'acct-1' } }
      }

      if (method === 'thread/start') {
        return { thread: { id: 'thread-1' } }
      }

      if (method === 'turn/start') {
        return { turn: { id: 'turn-1' } }
      }

      if (method === 'turn/steer') {
        return { ok: true }
      }

      if (method === 'turn/interrupt') {
        return { interrupted: true }
      }

      throw new Error(`Unexpected method: ${method}`)
    })

    const runtime = await CodexAgentRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async () => {},
      },
      systemPrompt: 'You are a test codex runtime.',
      tools: [],
    })

    await runtime.sendMessage('start a turn')
    await runtime.sendMessage('queue while active')
    expect(runtime.getPendingCount()).toBe(1)

    await runtime.terminate()

    const instance = rpcMockState.instances[0]
    expect(
      instance.requestCalls.some(
        (entry: { method: string; params: { turnId?: string } }) =>
          entry.method === 'turn/interrupt' && entry.params?.turnId === 'turn-1',
      ),
    ).toBe(true)
    expect(runtime.getPendingCount()).toBe(0)
    expect(runtime.getStatus()).toBe('terminated')
  })
})
