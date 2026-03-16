import { useMemo } from 'react'
import { inferModelPreset } from '@/lib/model-preset'
import type { ManagerWsState } from '@/lib/ws-state'
import type {
  AgentContextUsage,
  AgentDescriptor,
  ConversationEntry,
  ConversationMessageAttachment,
  ConversationTextAttachment,
} from '@middleman/protocol'

const CHARS_PER_TOKEN_ESTIMATE = 4
const CONTEXT_WINDOW_BY_PRESET = {
  'pi-opus': 200_000,
  'pi-codex': 1_048_576,
  'codex-app': 1_048_576,
  'claude-code': 200_000,
} as const

function contextWindowForAgent(agent: AgentDescriptor | null): number | null {
  if (!agent) {
    return null
  }

  const modelPreset = inferModelPreset(agent)
  return modelPreset ? CONTEXT_WINDOW_BY_PRESET[modelPreset] : null
}

function isTextAttachmentWithContent(
  attachment: ConversationMessageAttachment,
): attachment is ConversationTextAttachment {
  return attachment.type === 'text' && 'text' in attachment && typeof attachment.text === 'string'
}

function estimateUsedTokens(messages: ConversationEntry[]): number {
  let totalChars = 0

  for (const entry of messages) {
    if (entry.type !== 'conversation_message') {
      continue
    }

    totalChars += entry.text.length

    for (const attachment of entry.attachments ?? []) {
      if (isTextAttachmentWithContent(attachment)) {
        totalChars += attachment.text.length
      }
    }
  }

  return Math.ceil(totalChars / CHARS_PER_TOKEN_ESTIMATE)
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
  const realContextUsage = useMemo<AgentContextUsage | null>(() => {
    if (!activeAgentId) {
      return activeAgent?.contextUsage ?? null
    }

    return statuses[activeAgentId]?.contextUsage ?? activeAgent?.contextUsage ?? null
  }, [activeAgent, activeAgentId, statuses])

  const fallbackContextWindow = useMemo(() => contextWindowForAgent(activeAgent), [activeAgent])

  const contextWindowUsage = useMemo(() => {
    if (realContextUsage) {
      return {
        usedTokens: realContextUsage.tokens,
        contextWindow: realContextUsage.contextWindow,
      }
    }

    if (!fallbackContextWindow) {
      return null
    }

    return {
      usedTokens: estimateUsedTokens(messages),
      contextWindow: fallbackContextWindow,
    }
  }, [fallbackContextWindow, messages, realContextUsage])

  return {
    contextWindowUsage:
      contextWindowUsage && contextWindowUsage.contextWindow > 0 ? contextWindowUsage : null,
  }
}
