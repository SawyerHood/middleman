import { describe, expect, it } from 'vitest'
import { buildManagerTreeRows, chooseFallbackAgentId, getPrimaryManagerId } from './agent-hierarchy'
import type { AgentDescriptor } from '@middleman/protocol'

function manager(agentId: string, managerId = agentId): AgentDescriptor {
  return {
    agentId,
    managerId,
    displayName: agentId,
    role: 'manager',
    status: 'idle',
    createdAt: `2026-01-01T00:00:0${agentId.endsWith('2') ? '1' : '0'}.000Z`,
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp',
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.4',
      thinkingLevel: 'medium',
    },
  }
}

function worker(agentId: string, managerId: string): AgentDescriptor {
  return {
    agentId,
    managerId,
    displayName: agentId,
    role: 'worker',
    status: 'idle',
    createdAt: '2026-01-01T00:00:02.000Z',
    updatedAt: '2026-01-01T00:00:02.000Z',
    cwd: '/tmp',
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.4',
      thinkingLevel: 'medium',
    },
  }
}

describe('agent-hierarchy', () => {
  it('groups workers under owning managers without re-sorting manager order', () => {
    const agents: AgentDescriptor[] = [
      manager('manager-2', 'manager'),
      manager('manager'),
      worker('worker-a', 'manager'),
      worker('worker-b', 'manager-2'),
      worker('worker-orphan', 'missing-manager'),
    ]

    const { managerRows, orphanWorkers } = buildManagerTreeRows(agents)

    expect(managerRows).toHaveLength(2)
    expect(managerRows[0]?.manager.agentId).toBe('manager-2')
    expect(managerRows[0]?.workers.map((entry) => entry.agentId)).toEqual(['worker-b'])
    expect(managerRows[1]?.manager.agentId).toBe('manager')
    expect(managerRows[1]?.workers.map((entry) => entry.agentId)).toEqual(['worker-a'])
    expect(orphanWorkers.map((entry) => entry.agentId)).toEqual(['worker-orphan'])
  })

  it('chooses a primary manager from the incoming manager order', () => {
    const agents: AgentDescriptor[] = [manager('manager-2', 'manager'), manager('manager')]
    expect(getPrimaryManagerId(agents)).toBe('manager-2')
  })

  it('supports an explicit manager order override', () => {
    const agents: AgentDescriptor[] = [manager('beta'), manager('alpha')]
    expect(getPrimaryManagerId(agents, ['alpha', 'beta'])).toBe('alpha')
  })

  it('chooses fallback target preferring a primary manager', () => {
    const agents: AgentDescriptor[] = [
      manager('manager'),
      manager('manager-2', 'manager'),
      worker('worker-a', 'manager-2'),
    ]

    expect(chooseFallbackAgentId(agents, [], 'worker-a')).toBe('worker-a')
    expect(chooseFallbackAgentId(agents, ['manager-2', 'manager'], 'missing-agent')).toBe('manager-2')
  })

  it('keeps stopped and errored agents visible for restore and transcript replay', () => {
    const stoppedManager = { ...manager('manager-stopped'), status: 'stopped' as const }
    const erroredWorker = { ...worker('worker-error', 'manager-stopped'), status: 'errored' as const }

    const { managerRows, orphanWorkers } = buildManagerTreeRows([stoppedManager, erroredWorker])

    expect(managerRows).toHaveLength(1)
    expect(managerRows[0]?.manager.agentId).toBe('manager-stopped')
    expect(managerRows[0]?.workers.map((entry) => entry.agentId)).toEqual(['worker-error'])
    expect(orphanWorkers).toHaveLength(0)
    expect(getPrimaryManagerId([stoppedManager])).toBe('manager-stopped')
    expect(chooseFallbackAgentId([stoppedManager, erroredWorker], [], null)).toBe('manager-stopped')
  })
})
