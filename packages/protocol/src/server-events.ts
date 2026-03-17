import type { ConversationMessageAttachment } from "./attachments.js";
import type {
  AcceptedDeliveryMode,
  AgentContextUsage,
  AgentDescriptor,
  AgentStatus,
  DeliveryMode,
  DirectoryItem,
  MessageSourceContext,
} from "./shared-types.js";

export interface ConversationMessageEvent {
  type: "conversation_message";
  agentId: string;
  role: "user" | "assistant" | "system";
  text: string;
  attachments?: ConversationMessageAttachment[];
  timestamp: string;
  historyCursor?: string;
  source: "user_input" | "speak_to_user" | "system";
  sourceContext?: MessageSourceContext;
}

export type ConversationLogKind =
  | "message_start"
  | "message_end"
  | "tool_execution_start"
  | "tool_execution_update"
  | "tool_execution_end";

export interface ConversationLogEvent {
  type: "conversation_log";
  agentId: string;
  timestamp: string;
  historyCursor?: string;
  source: "runtime_log";
  kind: ConversationLogKind;
  role?: "user" | "assistant" | "system";
  toolName?: string;
  toolCallId?: string;
  text: string;
  isError?: boolean;
}

export interface AgentMessageEvent {
  type: "agent_message";
  agentId: string;
  timestamp: string;
  historyCursor?: string;
  source: "user_to_agent" | "agent_to_agent";
  fromAgentId?: string;
  toAgentId: string;
  text: string;
  sourceContext?: MessageSourceContext;
  requestedDelivery?: DeliveryMode;
  acceptedMode?: AcceptedDeliveryMode;
  attachmentCount?: number;
}

export type AgentToolCallKind = Extract<
  ConversationLogKind,
  "tool_execution_start" | "tool_execution_update" | "tool_execution_end"
>;

export interface AgentToolCallEvent {
  type: "agent_tool_call";
  agentId: string;
  actorAgentId: string;
  timestamp: string;
  historyCursor?: string;
  kind: AgentToolCallKind;
  toolName?: string;
  toolCallId?: string;
  text: string;
  isError?: boolean;
}

export interface ManagerCreatedEvent {
  type: "manager_created";
  manager: AgentDescriptor;
  requestId?: string;
}

export interface ManagerDeletedEvent {
  type: "manager_deleted";
  managerId: string;
  terminatedWorkerIds: string[];
  requestId?: string;
}

export interface ManagerOrderUpdatedEvent {
  type: "manager_order_updated";
  managerIds: string[];
  requestId?: string;
}

export interface StopAllAgentsResultEvent {
  type: "stop_all_agents_result";
  managerId: string;
  stoppedWorkerIds: string[];
  managerStopped: boolean;
  requestId?: string;
}

export interface DirectoriesListedEvent {
  type: "directories_listed";
  path: string;
  directories: string[];
  requestId?: string;
  requestedPath?: string;
  resolvedPath?: string;
  roots?: string[];
  entries?: DirectoryItem[];
}

export interface DirectoryValidatedEvent {
  type: "directory_validated";
  path: string;
  valid: boolean;
  message?: string;
  requestId?: string;
  requestedPath?: string;
  roots?: string[];
  resolvedPath?: string;
}

export interface DirectoryPickedEvent {
  type: "directory_picked";
  path: string | null;
  requestId?: string;
}

export type ConversationEntry =
  | ConversationMessageEvent
  | ConversationLogEvent
  | AgentMessageEvent
  | AgentToolCallEvent;

export type ConversationEntryEvent = ConversationEntry;

export interface ConversationHistoryEvent {
  type: "conversation_history";
  agentId: string;
  messages: ConversationEntry[];
  mode?: "replace" | "prepend";
  hasMore?: boolean;
}

export interface AgentStatusEvent {
  type: "agent_status";
  agentId: string;
  status: AgentStatus;
  pendingCount: number;
  contextUsage?: AgentContextUsage | null;
}

export interface AgentsSnapshotEvent {
  type: "agents_snapshot";
  agents: AgentDescriptor[];
}

export type ServerEvent =
  | {
      type: "ready";
      serverTime: string;
      subscribedAgentId: string;
      buildHash: string;
    }
  | {
      type: "conversation_reset";
      agentId: string;
      timestamp: string;
      reason: "user_new_command" | "api_reset";
    }
  | ConversationHistoryEvent
  | ConversationEntry
  | AgentStatusEvent
  | AgentsSnapshotEvent
  | ManagerCreatedEvent
  | ManagerDeletedEvent
  | ManagerOrderUpdatedEvent
  | StopAllAgentsResultEvent
  | DirectoriesListedEvent
  | DirectoryValidatedEvent
  | DirectoryPickedEvent
  | { type: "error"; code: string; message: string; requestId?: string };
