import { getOrderedManagers } from './manager-order'
import type { AgentDescriptor } from '@middleman/protocol'

function byCreatedAtThenId(a: AgentDescriptor, b: AgentDescriptor): number {
  const createdOrder = a.createdAt.localeCompare(b.createdAt)
  if (createdOrder !== 0) return createdOrder
  return a.agentId.localeCompare(b.agentId)
}

export function getPrimaryManagerId(
  agents: AgentDescriptor[],
  managerOrder: string[] = [],
): string | null {
  return getOrderedManagers(agents, managerOrder)[0]?.agentId ?? null
}

export interface ManagerTreeRow {
  manager: AgentDescriptor
  workers: AgentDescriptor[]
}

export function buildManagerTreeRows(
  agents: AgentDescriptor[],
  managerOrder: string[] = [],
): {
  managerRows: ManagerTreeRow[]
  orphanWorkers: AgentDescriptor[]
} {
  const managers = getOrderedManagers(agents, managerOrder)
  const workers = agents.filter((agent) => agent.role === 'worker').sort(byCreatedAtThenId)

  const workersByManager = new Map<string, AgentDescriptor[]>()
  for (const worker of workers) {
    const entries = workersByManager.get(worker.managerId)
    if (entries) {
      entries.push(worker)
    } else {
      workersByManager.set(worker.managerId, [worker])
    }
  }

  const managerRows = managers.map((manager) => ({
    manager,
    workers: workersByManager.get(manager.agentId) ?? [],
  }))

  const managerIds = new Set(managers.map((manager) => manager.agentId))
  const orphanWorkers = workers.filter((worker) => !managerIds.has(worker.managerId))

  return { managerRows, orphanWorkers }
}

export function chooseFallbackAgentId(
  agents: AgentDescriptor[],
  managerOrder: string[] = [],
  preferredAgentId?: string | null,
): string | null {
  if (agents.length === 0) {
    return null
  }

  if (preferredAgentId && agents.some((agent) => agent.agentId === preferredAgentId)) {
    return preferredAgentId
  }

  const primaryManagerId = getPrimaryManagerId(agents, managerOrder)
  if (primaryManagerId) {
    return primaryManagerId
  }

  return [...agents].sort(byCreatedAtThenId)[0]?.agentId ?? null
}
