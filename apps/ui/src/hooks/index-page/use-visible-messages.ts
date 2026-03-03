import { useMemo } from 'react'
import type { AgentDescriptor, ConversationEntry } from '@middleman/protocol'

function toEpochMillis(timestamp: string): number {
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) ? parsed : 0
}

function mergeConversationAndActivityMessages(
  messages: ConversationEntry[],
  activityMessages: ConversationEntry[],
): ConversationEntry[] {
  if (activityMessages.length === 0) {
    return messages
  }

  if (messages.length === 0) {
    return activityMessages
  }

  const merged: ConversationEntry[] = []
  let conversationIndex = 0
  let activityIndex = 0

  while (conversationIndex < messages.length && activityIndex < activityMessages.length) {
    const conversationMessage = messages[conversationIndex]
    const activityMessage = activityMessages[activityIndex]

    if (toEpochMillis(conversationMessage.timestamp) <= toEpochMillis(activityMessage.timestamp)) {
      merged.push(conversationMessage)
      conversationIndex += 1
      continue
    }

    merged.push(activityMessage)
    activityIndex += 1
  }

  if (conversationIndex < messages.length) {
    merged.push(...messages.slice(conversationIndex))
  }

  if (activityIndex < activityMessages.length) {
    merged.push(...activityMessages.slice(activityIndex))
  }

  return merged
}

function buildManagerScopedAgentIds(agents: AgentDescriptor[], managerId: string): Set<string> {
  const scopedAgentIds = new Set<string>([managerId])

  for (const agent of agents) {
    if (agent.agentId === managerId || agent.managerId === managerId) {
      scopedAgentIds.add(agent.agentId)
    }
  }

  return scopedAgentIds
}

function isUserTranscriptEntry(entry: ConversationEntry): boolean {
  if (entry.type !== 'conversation_message') {
    return false
  }

  return entry.source === 'user_input' || entry.source === 'speak_to_user'
}

function isManagerScopedTranscriptEntry(
  entry: ConversationEntry,
  scopedAgentIds: ReadonlySet<string>,
): boolean {
  return isUserTranscriptEntry(entry) && scopedAgentIds.has(entry.agentId)
}

interface UseVisibleMessagesOptions {
  messages: ConversationEntry[]
  activityMessages: ConversationEntry[]
  agents: AgentDescriptor[]
  activeAgent: AgentDescriptor | null
}

export function useVisibleMessages({
  messages,
  activityMessages,
  agents,
  activeAgent,
}: UseVisibleMessagesOptions): {
  allMessages: ConversationEntry[]
  visibleMessages: ConversationEntry[]
} {
  const managerScopedAgentIds = useMemo(() => {
    if (activeAgent?.role !== 'manager') {
      return null
    }

    return buildManagerScopedAgentIds(agents, activeAgent.agentId)
  }, [activeAgent, agents])

  const allMessages = useMemo(
    () => mergeConversationAndActivityMessages(messages, activityMessages),
    [activityMessages, messages],
  )

  const visibleMessages = useMemo(() => {
    if (activeAgent?.role === 'manager' && managerScopedAgentIds) {
      return allMessages.filter((entry) =>
        isManagerScopedTranscriptEntry(entry, managerScopedAgentIds),
      )
    }

    return messages.filter((entry) => {
      if (entry.type !== 'conversation_message') {
        return true
      }

      return (entry.sourceContext?.channel ?? 'web') === 'web'
    })
  }, [activeAgent, allMessages, managerScopedAgentIds, messages])

  return {
    allMessages,
    visibleMessages,
  }
}
