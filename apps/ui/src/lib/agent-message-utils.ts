import type { AgentDescriptor, ConversationEntry } from '@middleman/protocol'

export type AgentMessageEntry = Extract<ConversationEntry, { type: 'agent_message' }>

export type AgentLookup = ReadonlyMap<string, AgentDescriptor>

export function buildAgentLookup(agents: AgentDescriptor[]): AgentLookup {
  return new Map(agents.map((agent) => [agent.agentId, agent]))
}

export function resolveAgentDescriptor(
  agentId: string | undefined,
  agentLookup: AgentLookup,
): AgentDescriptor | null {
  const normalizedAgentId = agentId?.trim()
  if (!normalizedAgentId) {
    return null
  }

  return agentLookup.get(normalizedAgentId) ?? null
}

export function resolveAgentLabel(
  agentId: string | undefined,
  agentLookup: AgentLookup,
  fallbackLabel: string,
): string {
  const normalizedAgentId = agentId?.trim()
  if (!normalizedAgentId) {
    return fallbackLabel
  }

  return resolveAgentDescriptor(normalizedAgentId, agentLookup)?.displayName?.trim() || normalizedAgentId
}

export function isManagerInvolvedAgentMessage(
  message: AgentMessageEntry,
  managerId: string,
): boolean {
  return (
    message.source === 'agent_to_agent' &&
    (message.fromAgentId === managerId || message.toAgentId === managerId)
  )
}

export function isInternalAgentMessage(message: AgentMessageEntry): boolean {
  return message.source === 'agent_to_agent'
}
