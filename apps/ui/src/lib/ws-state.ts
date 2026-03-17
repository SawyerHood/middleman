import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentStatus,
  ConversationEntry,
} from "@middleman/protocol";

export type ConversationHistoryEntry = Extract<
  ConversationEntry,
  { type: "conversation_message" | "conversation_log" }
>;
export type AgentActivityEntry = Extract<
  ConversationEntry,
  { type: "agent_message" | "agent_tool_call" }
>;

export interface ManagerWsState {
  connected: boolean;
  hasReceivedAgentsSnapshot: boolean;
  targetAgentId: string | null;
  subscribedAgentId: string | null;
  messages: ConversationHistoryEntry[];
  activityMessages: AgentActivityEntry[];
  oldestHistoryCursor: string | null;
  hasOlderHistory: boolean;
  isLoadingOlderHistory: boolean;
  isLoadingHistory: boolean;
  agents: AgentDescriptor[];
  managerOrder: string[];
  statuses: Record<
    string,
    {
      status: AgentStatus;
      pendingCount: number;
      contextUsage?: AgentContextUsage;
    }
  >;
  lastError: string | null;
}

export function createInitialManagerWsState(
  targetAgentId: string | null,
): ManagerWsState {
  return {
    connected: false,
    hasReceivedAgentsSnapshot: false,
    targetAgentId,
    subscribedAgentId: null,
    messages: [],
    activityMessages: [],
    oldestHistoryCursor: null,
    hasOlderHistory: false,
    isLoadingOlderHistory: false,
    isLoadingHistory: false,
    agents: [],
    managerOrder: [],
    statuses: {},
    lastError: null,
  };
}
