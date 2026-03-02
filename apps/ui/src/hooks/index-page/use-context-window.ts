import { useMemo } from 'react'
import { inferModelPreset } from '@/lib/model-preset'
import type { ManagerWsState } from '@/lib/ws-state'
import type { AgentContextUsage, AgentDescriptor, ConversationEntry, ManagerModelPreset } from '@middleman/protocol'

const CHARS_PER_TOKEN_ESTIMATE = 4
const CONTEXT_WINDOW_BY_PRESET: Record<ManagerModelPreset, number> = {
  'pi-opus': 200_000,
  'pi-codex': 1_048_576,
  'codex-app': 1_048_576,
  'claude-code': 200_000,
}

function contextWindowForAgent(agent: AgentDescriptor | null): number | null {
  if (!agent) {
    return null
  }

  const modelPreset = inferModelPreset(agent)
  return modelPreset ? CONTEXT_WINDOW_BY_PRESET[modelPreset] : null
}

function estimateUsedTokens(messages: ConversationEntry[]): number {
  let totalChars = 0

  for (const entry of messages) {
    if (entry.type !== 'conversation_message') {
      continue
    }

    totalChars += entry.text.length

    for (const attachment of entry.attachments ?? []) {
      if (attachment.type === 'text') {
        totalChars += attachment.text.length
      }
    }
  }

  return Math.ceil(totalChars / CHARS_PER_TOKEN_ESTIMATE)
}

function toContextWindowUsage(
  contextUsage: AgentContextUsage | undefined,
): { usedTokens: number; contextWindow: number } | null {
  if (!contextUsage) {
    return null
  }

  if (
    !Number.isFinite(contextUsage.tokens) ||
    contextUsage.tokens < 0 ||
    !Number.isFinite(contextUsage.contextWindow) ||
    contextUsage.contextWindow <= 0
  ) {
    return null
  }

  return {
    usedTokens: Math.round(contextUsage.tokens),
    contextWindow: Math.max(1, Math.round(contextUsage.contextWindow)),
  }
}

interface UseContextWindowOptions {
  activeAgent: AgentDescriptor | null
  activeAgentId: string | null
  messages: ConversationEntry[]
  statuses: ManagerWsState['statuses']
}

export function useContextWindow({
  activeAgent,
  activeAgentId,
  messages,
  statuses,
}: UseContextWindowOptions): {
  contextWindowUsage: { usedTokens: number; contextWindow: number } | null
} {
  const contextWindow = useMemo(() => contextWindowForAgent(activeAgent), [activeAgent])

  const contextWindowUsage = useMemo(() => {
    const liveFromStatus =
      activeAgentId !== null ? toContextWindowUsage(statuses[activeAgentId]?.contextUsage) : null
    if (liveFromStatus) {
      return liveFromStatus
    }

    const liveFromDescriptor = toContextWindowUsage(activeAgent?.contextUsage)
    if (liveFromDescriptor) {
      return liveFromDescriptor
    }

    if (!contextWindow) {
      return null
    }

    return {
      usedTokens: estimateUsedTokens(messages),
      contextWindow,
    }
  }, [activeAgent, activeAgentId, contextWindow, messages, statuses])

  return {
    contextWindowUsage,
  }
}
