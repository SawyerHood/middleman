import { useCallback, useEffect, useState } from 'react'
import type { AgentStatus, ConversationEntry } from '@middleman/protocol'
import { isWorkingAgentStatus } from '@/lib/agent-status'

export interface PendingResponseStart {
  agentId: string
  messageCount: number
}

function isAssistantResponseSignal(entry: ConversationEntry): boolean {
  if (entry.type === 'conversation_message') {
    return entry.role === 'assistant' || entry.role === 'system'
  }

  if (entry.type === 'conversation_log') {
    return (
      entry.role === 'assistant' &&
      (entry.kind === 'message_start' || entry.kind === 'message_end')
    )
  }

  return false
}

interface UsePendingResponseOptions {
  activeAgentId: string | null
  activeAgentStatus: AgentStatus | null
  messages: ConversationEntry[]
}

export function usePendingResponse({
  activeAgentId,
  activeAgentStatus,
  messages,
}: UsePendingResponseOptions): {
  pendingResponseStart: PendingResponseStart | null
  markPendingResponse: (agentId: string, messageCount: number) => void
  clearPendingResponseForAgent: (agentId: string) => void
  isAwaitingResponseStart: boolean
} {
  const [pendingResponseStart, setPendingResponseStart] = useState<PendingResponseStart | null>(null)

  useEffect(() => {
    if (!pendingResponseStart) {
      return
    }

    if (!activeAgentId || pendingResponseStart.agentId !== activeAgentId) {
      setPendingResponseStart(null)
      return
    }

    if (activeAgentStatus && isWorkingAgentStatus(activeAgentStatus)) {
      setPendingResponseStart(null)
      return
    }

    if (messages.length < pendingResponseStart.messageCount) {
      setPendingResponseStart(null)
      return
    }

    const hasAssistantResponse = messages
      .slice(pendingResponseStart.messageCount)
      .some(isAssistantResponseSignal)

    if (hasAssistantResponse) {
      setPendingResponseStart(null)
    }
  }, [activeAgentId, activeAgentStatus, messages, pendingResponseStart])

  const markPendingResponse = useCallback((agentId: string, messageCount: number) => {
    setPendingResponseStart({ agentId, messageCount })
  }, [])

  const clearPendingResponseForAgent = useCallback((agentId: string) => {
    setPendingResponseStart((previous) =>
      previous?.agentId === agentId ? null : previous,
    )
  }, [])

  const isAwaitingResponseStart =
    pendingResponseStart !== null && pendingResponseStart.agentId === activeAgentId

  return {
    pendingResponseStart,
    markPendingResponse,
    clearPendingResponseForAgent,
    isAwaitingResponseStart,
  }
}
