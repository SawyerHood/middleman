import type { AgentDescriptor } from '@middleman/protocol'

function moveItem<T>(items: readonly T[], fromIndex: number, toIndex: number): T[] {
  const nextItems = [...items]
  const [movedItem] = nextItems.splice(fromIndex, 1)

  if (movedItem === undefined) {
    return nextItems
  }

  nextItems.splice(toIndex, 0, movedItem)
  return nextItems
}

export function normalizeManagerOrder(
  managerOrder: string[],
  agents: AgentDescriptor[],
): string[] {
  const managers = agents.filter((agent) => agent.role === 'manager')
  const managerIds = new Set(managers.map((agent) => agent.agentId))
  const nextManagerOrder: string[] = []
  const seenManagerIds = new Set<string>()

  for (const managerId of managerOrder) {
    if (!managerIds.has(managerId) || seenManagerIds.has(managerId)) {
      continue
    }

    nextManagerOrder.push(managerId)
    seenManagerIds.add(managerId)
  }

  for (const manager of managers) {
    if (seenManagerIds.has(manager.agentId)) {
      continue
    }

    nextManagerOrder.push(manager.agentId)
    seenManagerIds.add(manager.agentId)
  }

  return nextManagerOrder
}

export function getOrderedManagers(
  agents: AgentDescriptor[],
  managerOrder: string[],
): AgentDescriptor[] {
  const managers = agents.filter((agent) => agent.role === 'manager')
  const managerById = new Map(
    managers.map((manager) => [manager.agentId, manager] as const),
  )

  return normalizeManagerOrder(managerOrder, agents)
    .map((managerId) => managerById.get(managerId))
    .filter((manager): manager is AgentDescriptor => manager !== undefined)
}

export function reorderAgentsByManagerOrder(
  agents: AgentDescriptor[],
  managerOrder: string[],
): AgentDescriptor[] {
  const orderedManagers = getOrderedManagers(agents, managerOrder)
  const workers = agents.filter((agent) => agent.role === 'worker')
  return [...orderedManagers, ...workers]
}

export function moveVisibleManagersWithinOrder(options: {
  agents: AgentDescriptor[]
  managerOrder: string[]
  visibleManagerIds: string[]
  activeId: string
  overId: string
}): string[] {
  const { agents, managerOrder, visibleManagerIds, activeId, overId } = options
  const fullManagerOrder = normalizeManagerOrder(managerOrder, agents)
  const fromIndex = visibleManagerIds.indexOf(activeId)
  const toIndex = visibleManagerIds.indexOf(overId)

  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
    return fullManagerOrder
  }

  const reorderedVisibleManagerIds = moveItem(visibleManagerIds, fromIndex, toIndex)
  const visibleManagerIdSet = new Set(visibleManagerIds)
  let reorderedVisibleIndex = 0

  return fullManagerOrder.map((managerId) => {
    if (!visibleManagerIdSet.has(managerId)) {
      return managerId
    }

    const nextManagerId = reorderedVisibleManagerIds[reorderedVisibleIndex]
    reorderedVisibleIndex += 1
    return nextManagerId ?? managerId
  })
}
