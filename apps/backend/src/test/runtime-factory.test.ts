import { describe, expect, it, vi } from 'vitest'
import { RuntimeFactory } from '../swarm/runtime-factory.js'
import type { AgentDescriptor } from '../swarm/types.js'

function makeDescriptor(provider: string, modelId: string): AgentDescriptor {
  return {
    agentId: `${provider}-${modelId}`,
    displayName: `${provider}-${modelId}`,
    role: 'worker',
    managerId: 'manager',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp',
    model: {
      provider,
      modelId,
      thinkingLevel: 'xhigh',
    },
    sessionFile: '/tmp/session.jsonl',
  }
}

function makeFactory(): RuntimeFactory {
  return new RuntimeFactory({
    host: {} as any,
    config: {} as any,
    now: () => '2026-01-01T00:00:00.000Z',
    logDebug: () => {},
    getMemoryRuntimeResources: async () => ({
      memoryContextFile: {
        path: '/tmp/memory.md',
        content: '',
      },
      additionalSkillPaths: [],
    }),
    getSwarmContextFiles: async () => [],
    mergeRuntimeContextFiles: (base) => base,
    callbacks: {
      onStatusChange: async () => {},
      onSessionEvent: async () => {},
      onAgentEnd: async () => {},
      onRuntimeError: async () => {},
    },
  })
}

describe('RuntimeFactory routing', () => {
  it('routes providers to the expected runtime constructors', async () => {
    const factory = makeFactory()

    const piRuntime = { runtime: 'pi' } as any
    const codexRuntime = { runtime: 'codex' } as any
    const claudeRuntime = { runtime: 'claude-code' } as any

    const createPiRuntimeForDescriptor = vi.fn(async () => piRuntime)
    const createCodexRuntimeForDescriptor = vi.fn(async () => codexRuntime)
    const createClaudeCodeRuntimeForDescriptor = vi.fn(async () => claudeRuntime)

    ;(factory as any).createPiRuntimeForDescriptor = createPiRuntimeForDescriptor
    ;(factory as any).createCodexRuntimeForDescriptor = createCodexRuntimeForDescriptor
    ;(factory as any).createClaudeCodeRuntimeForDescriptor = createClaudeCodeRuntimeForDescriptor

    const piDescriptor = makeDescriptor('openai-codex', 'gpt-5.3-codex')
    const codexDescriptor = makeDescriptor('openai-codex-app-server', 'default')
    const claudeDescriptor = makeDescriptor('anthropic-claude-code', 'claude-opus-4-6')

    await expect(factory.createRuntimeForDescriptor(piDescriptor, 'pi-system')).resolves.toBe(piRuntime)
    await expect(factory.createRuntimeForDescriptor(codexDescriptor, 'codex-system')).resolves.toBe(codexRuntime)
    await expect(factory.createRuntimeForDescriptor(claudeDescriptor, 'claude-system')).resolves.toBe(claudeRuntime)

    expect(createPiRuntimeForDescriptor).toHaveBeenCalledTimes(1)
    expect(createPiRuntimeForDescriptor).toHaveBeenCalledWith(piDescriptor, 'pi-system')

    expect(createCodexRuntimeForDescriptor).toHaveBeenCalledTimes(1)
    expect(createCodexRuntimeForDescriptor).toHaveBeenCalledWith(codexDescriptor, 'codex-system')

    expect(createClaudeCodeRuntimeForDescriptor).toHaveBeenCalledTimes(1)
    expect(createClaudeCodeRuntimeForDescriptor).toHaveBeenCalledWith(claudeDescriptor, 'claude-system')
  })
})
