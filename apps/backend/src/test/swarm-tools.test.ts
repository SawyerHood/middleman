import { describe, expect, it } from 'vitest'
import { buildSwarmTools, type SwarmToolHost } from '../swarm/swarm-tools.js'
import type { AgentDescriptor, SendMessageReceipt, SpawnAgentInput, UserTask } from '../swarm/types.js'

function makeTask(): UserTask {
  return {
    id: 'task-1',
    managerId: 'manager',
    title: 'Review the deployment',
    status: 'pending',
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

function makeManagerDescriptor(): AgentDescriptor {
  return {
    agentId: 'manager',
    displayName: 'manager',
    role: 'manager',
    managerId: 'manager',
    archetypeId: 'manager',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp/swarm',
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'xhigh',
    },
    sessionFile: '/tmp/swarm/manager.jsonl',
  }
}

function makeWorkerDescriptor(agentId: string): AgentDescriptor {
  return {
    agentId,
    displayName: agentId,
    role: 'worker',
    managerId: 'manager',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp/swarm',
    model: {
      provider: 'anthropic',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'xhigh',
    },
    sessionFile: `/tmp/swarm/${agentId}.jsonl`,
  }
}

function makeHost(spawnImpl: (callerAgentId: string, input: SpawnAgentInput) => Promise<AgentDescriptor>): SwarmToolHost {
  return {
    listAgents(): AgentDescriptor[] {
      return [makeManagerDescriptor()]
    },
    spawnAgent: spawnImpl,
    async killAgent(): Promise<void> {},
    async sendMessage(): Promise<SendMessageReceipt> {
      return {
        targetAgentId: 'worker',
        deliveryId: 'delivery-1',
        acceptedMode: 'prompt',
      }
    },
    async publishToUser(): Promise<{ targetContext: { channel: 'web' } }> {
      return {
        targetContext: { channel: 'web' },
      }
    },
    async assignTask(): Promise<UserTask> {
      return makeTask()
    },
    async getOutstandingTasks(): Promise<UserTask[]> {
      return [makeTask()]
    },
  }
}

describe('buildSwarmTools', () => {
  it('returns only active agents with a compact payload for list_agents', async () => {
    const activeManager = makeManagerDescriptor()
    const activeWorker = makeWorkerDescriptor('worker-active')
    const stoppedWorker: AgentDescriptor = {
      ...makeWorkerDescriptor('worker-stopped'),
      status: 'stopped',
    }
    const terminatedWorker: AgentDescriptor = {
      ...makeWorkerDescriptor('worker-terminated'),
      status: 'terminated',
    }

    const host: SwarmToolHost = {
      listAgents: () => [activeManager, activeWorker, stoppedWorker, terminatedWorker],
      spawnAgent: async () => makeWorkerDescriptor('worker'),
      killAgent: async () => {},
      sendMessage: async () => ({
        targetAgentId: 'worker',
        deliveryId: 'delivery-1',
        acceptedMode: 'prompt',
      }),
      publishToUser: async () => ({
        targetContext: { channel: 'web' },
      }),
      assignTask: async () => makeTask(),
      getOutstandingTasks: async () => [makeTask()],
    }

    const tools = buildSwarmTools(host, makeManagerDescriptor())
    const listAgentsTool = tools.find((tool) => tool.name === 'list_agents')
    expect(listAgentsTool).toBeDefined()

    const result = await listAgentsTool!.execute(
      'tool-call',
      {},
      undefined,
      undefined,
      undefined as any,
    )

    expect(result.details).toEqual({
      agents: [
        {
          agentId: 'manager',
          role: 'manager',
          managerId: 'manager',
          status: 'idle',
          model: {
            provider: 'openai-codex',
            modelId: 'gpt-5.3-codex',
            thinkingLevel: 'xhigh',
          },
        },
        {
          agentId: 'worker-active',
          role: 'worker',
          managerId: 'manager',
          status: 'idle',
          model: {
            provider: 'anthropic',
            modelId: 'claude-opus-4-6',
            thinkingLevel: 'xhigh',
          },
        },
      ],
    })
    const textContent = result.content.find((block) => block.type === 'text')
    expect(textContent?.text).toContain('"agentId": "manager"')
    expect(textContent?.text).toContain('"agentId": "worker-active"')
    expect(textContent?.text).not.toContain('worker-stopped')
    expect(textContent?.text).not.toContain('worker-terminated')
    expect(textContent?.text).not.toContain('sessionFile')
    expect(textContent?.text).not.toContain('cwd')
    expect(textContent?.text).not.toContain('displayName')

    const resultWithInactive = await listAgentsTool!.execute(
      'tool-call',
      {
        includeTerminated: true,
      },
      undefined,
      undefined,
      undefined as any,
    )

    expect(resultWithInactive.details).toEqual({
      agents: [
        {
          agentId: 'manager',
          role: 'manager',
          managerId: 'manager',
          status: 'idle',
          model: {
            provider: 'openai-codex',
            modelId: 'gpt-5.3-codex',
            thinkingLevel: 'xhigh',
          },
        },
        {
          agentId: 'worker-active',
          role: 'worker',
          managerId: 'manager',
          status: 'idle',
          model: {
            provider: 'anthropic',
            modelId: 'claude-opus-4-6',
            thinkingLevel: 'xhigh',
          },
        },
        {
          agentId: 'worker-stopped',
          role: 'worker',
          managerId: 'manager',
          status: 'stopped',
          model: {
            provider: 'anthropic',
            modelId: 'claude-opus-4-6',
            thinkingLevel: 'xhigh',
          },
        },
        {
          agentId: 'worker-terminated',
          role: 'worker',
          managerId: 'manager',
          status: 'terminated',
          model: {
            provider: 'anthropic',
            modelId: 'claude-opus-4-6',
            thinkingLevel: 'xhigh',
          },
        },
      ],
    })
    const includeInactiveText = resultWithInactive.content.find((block) => block.type === 'text')
    expect(includeInactiveText?.text).toContain('worker-stopped')
    expect(includeInactiveText?.text).toContain('worker-terminated')
    expect(includeInactiveText?.text).not.toContain('sessionFile')
    expect(includeInactiveText?.text).not.toContain('cwd')
  })

  it('propagates spawn_agent model preset to host.spawnAgent', async () => {
    let receivedInput: SpawnAgentInput | undefined

    const host = makeHost(async (_callerAgentId, input) => {
      receivedInput = input
      return makeWorkerDescriptor('worker-opus')
    })

    const tools = buildSwarmTools(host, makeManagerDescriptor())
    const spawnTool = tools.find((tool) => tool.name === 'spawn_agent')
    expect(spawnTool).toBeDefined()

    const result = await spawnTool!.execute(
      'tool-call',
      {
        agentId: 'Worker Opus',
        model: 'pi-opus',
      },
      undefined,
      undefined,
      undefined as any,
    )

    expect(receivedInput?.model).toBe('pi-opus')
    expect(result.details).toMatchObject({
      agentId: 'worker-opus',
      model: {
        provider: 'anthropic',
        modelId: 'claude-opus-4-6',
        thinkingLevel: 'xhigh',
      },
    })
  })

  it('rejects invalid spawn_agent model presets with a clear error', async () => {
    const host = makeHost(async () => makeWorkerDescriptor('worker'))

    const tools = buildSwarmTools(host, makeManagerDescriptor())
    const spawnTool = tools.find((tool) => tool.name === 'spawn_agent')
    expect(spawnTool).toBeDefined()

    await expect(
      spawnTool!.execute(
        'tool-call',
        {
          agentId: 'Worker Invalid',
          model: 'not-allowed-model',
        } as any,
        undefined,
        undefined,
        undefined as any,
      ),
    ).rejects.toThrow('spawn_agent.model must be one of pi-codex|pi-opus|codex-app|claude-code')
  })

  it('wires assign_task and get_outstanding_tasks through the host', async () => {
    const assignedTask = makeTask()
    const assignTask = async () => assignedTask
    const getOutstandingTasks = async () => [assignedTask]
    const host: SwarmToolHost = {
      ...makeHost(async () => makeWorkerDescriptor('worker')),
      assignTask,
      getOutstandingTasks,
    }

    const tools = buildSwarmTools(host, makeManagerDescriptor())
    const assignTool = tools.find((tool) => tool.name === 'assign_task')
    const outstandingTool = tools.find((tool) => tool.name === 'get_outstanding_tasks')

    expect(assignTool).toBeDefined()
    expect(outstandingTool).toBeDefined()

    const assigned = await assignTool!.execute(
      'tool-call',
      {
        title: 'Review the deployment',
        description: 'Double-check the final status update.',
      },
      undefined,
      undefined,
      undefined as any,
    )
    expect(assigned.details).toMatchObject({
      id: 'task-1',
      title: 'Review the deployment',
    })

    const outstanding = await outstandingTool!.execute(
      'tool-call',
      {},
      undefined,
      undefined,
      undefined as any,
    )
    expect(outstanding.details).toEqual({
      tasks: [assignedTask],
    })
  })

  it('forwards speak_to_user target metadata and returns resolved target context', async () => {
    let receivedTarget: { channel: 'web' | 'slack' | 'telegram'; channelId?: string; userId?: string; threadTs?: string } | undefined

    const host: SwarmToolHost = {
      listAgents: () => [makeManagerDescriptor()],
      spawnAgent: async () => makeWorkerDescriptor('worker'),
      killAgent: async () => {},
      sendMessage: async () => ({
        targetAgentId: 'worker',
        deliveryId: 'delivery-1',
        acceptedMode: 'prompt',
      }),
      publishToUser: async (_agentId, _text, _source, targetContext) => {
        receivedTarget = targetContext
        return {
          targetContext: {
            channel: targetContext?.channel ?? 'web',
            channelId: targetContext?.channelId,
            userId: targetContext?.userId,
            threadTs: targetContext?.threadTs,
          },
        }
      },
      assignTask: async () => makeTask(),
      getOutstandingTasks: async () => [makeTask()],
    }

    const tools = buildSwarmTools(host, makeManagerDescriptor())
    const speakTool = tools.find((tool) => tool.name === 'speak_to_user')
    expect(speakTool).toBeDefined()

    const result = await speakTool!.execute(
      'tool-call',
      {
        text: 'Reply in Slack thread',
        target: {
          channel: 'slack',
          channelId: 'C12345',
          threadTs: '173.456',
        },
      },
      undefined,
      undefined,
      undefined as any,
    )

    expect(receivedTarget).toEqual({
      channel: 'slack',
      channelId: 'C12345',
      threadTs: '173.456',
    })
    expect(result.details).toMatchObject({
      published: true,
      targetContext: {
        channel: 'slack',
        channelId: 'C12345',
        threadTs: '173.456',
      },
    })
  })
})
