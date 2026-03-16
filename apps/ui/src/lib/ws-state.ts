import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentStatus,
  ConversationEntry,
  SlackStatusEvent,
  TelegramStatusEvent,
} from '@middleman/protocol'

export type ConversationHistoryEntry = Extract<
  ConversationEntry,
  { type: 'conversation_message' | 'conversation_log' }
>
export type AgentActivityEntry = Extract<
  ConversationEntry,
  { type: 'agent_message' | 'agent_tool_call' }
>

export interface ManagerWsState {
  connected: boolean
  hasReceivedAgentsSnapshot: boolean
  targetAgentId: string | null
  subscribedAgentId: string | null
  messages: ConversationHistoryEntry[]
  activityMessages: AgentActivityEntry[]
  agents: AgentDescriptor[]
  managerOrder: string[]
  statuses: Record<string, { status: AgentStatus; pendingCount: number; contextUsage?: AgentContextUsage }>
  lastError: string | null
  slackStatus: SlackStatusEvent | null
  telegramStatus: TelegramStatusEvent | null
}

export function createInitialManagerWsState(targetAgentId: string | null): ManagerWsState {
  return {
    connected: false,
    hasReceivedAgentsSnapshot: false,
    targetAgentId,
    subscribedAgentId: null,
    messages: [],
    activityMessages: [],
    agents: [],
    managerOrder: [],
    statuses: {},
    lastError: null,
    slackStatus: null,
    telegramStatus: null,
  }
}
