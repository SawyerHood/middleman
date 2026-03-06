import type { AgentStatus } from "./agent-state-machine.js";

export type AgentRole = "manager" | "worker";

export type AgentArchetypeId = string;

export type { AgentStatus };

export const SWARM_MODEL_PRESETS = ["pi-codex", "pi-opus", "codex-app", "claude-code"] as const;

export type SwarmModelPreset = (typeof SWARM_MODEL_PRESETS)[number];

export interface AgentModelDescriptor {
  provider: string;
  modelId: string;
  thinkingLevel: string;
}

export interface AgentContextUsage {
  tokens: number;
  contextWindow: number;
  percent: number;
}

export interface AgentDescriptor {
  agentId: string;
  displayName: string;
  role: AgentRole;
  managerId: string;
  archetypeId?: AgentArchetypeId;
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  model: AgentModelDescriptor;
  sessionFile: string;
  contextUsage?: AgentContextUsage;
}

export interface AgentsStoreFile {
  agents: AgentDescriptor[];
}

export type UserTaskStatus = "pending" | "completed";

export interface UserTaskComment {
  id: string;
  body: string;
  createdAt: string;
  type: "completion";
}

export interface UserTask {
  id: string;
  managerId: string;
  title: string;
  description?: string;
  status: UserTaskStatus;
  createdAt: string;
  completedAt?: string;
  completionComment?: string;
  comments?: UserTaskComment[];
}

export type RequestedDeliveryMode = "auto" | "followUp" | "steer";

export type AcceptedDeliveryMode = "prompt" | "followUp" | "steer";

export type MessageChannel = "web" | "slack" | "telegram";

export interface MessageSourceContext {
  channel: MessageChannel;
  channelId?: string;
  userId?: string;
  messageId?: string;
  threadTs?: string;
  integrationProfileId?: string;
  channelType?: "dm" | "channel" | "group" | "mpim";
  teamId?: string;
}

export type MessageTargetContext = Pick<
  MessageSourceContext,
  "channel" | "channelId" | "userId" | "threadTs" | "integrationProfileId"
>;

export interface SendMessageReceipt {
  targetAgentId: string;
  deliveryId: string;
  acceptedMode: AcceptedDeliveryMode;
}

export interface SpawnAgentInput {
  agentId: string;
  archetypeId?: AgentArchetypeId;
  systemPrompt?: string;
  model?: SwarmModelPreset;
  cwd?: string;
  initialMessage?: string;
}

export interface SwarmPaths {
  rootDir: string;
  dataDir: string;
  swarmDir: string;
  sessionsDir: string;
  uploadsDir: string;
  authDir: string;
  authFile: string;
  agentDir: string;
  managerAgentDir: string;
  repoArchetypesDir: string;
  memoryDir: string;
  memoryFile?: string;
  repoMemorySkillFile: string;
  agentsStoreFile: string;
  secretsFile: string;
  schedulesFile?: string;
}

export interface SkillEnvRequirement {
  name: string;
  description?: string;
  required: boolean;
  helpUrl?: string;
  skillName: string;
  isSet: boolean;
  maskedValue?: string;
}

export type SettingsAuthProviderName = "anthropic" | "openai-codex";

export interface SettingsAuthProvider {
  provider: SettingsAuthProviderName;
  configured: boolean;
  authType?: "api_key" | "oauth" | "unknown";
  maskedValue?: string;
}

export interface SwarmConfig {
  host: string;
  port: number;
  debug: boolean;
  allowNonManagerSubscriptions: boolean;
  managerId?: string;
  managerDisplayName: string;
  defaultModel: AgentModelDescriptor;
  defaultCwd: string;
  cwdAllowlistRoots: string[];
  paths: SwarmPaths;
}

export interface ConversationImageAttachment {
  type?: "image";
  mimeType: string;
  data: string;
  fileName?: string;
  filePath?: string;
}

export interface ConversationTextAttachment {
  type: "text";
  mimeType: string;
  text: string;
  fileName?: string;
  filePath?: string;
}

export interface ConversationBinaryAttachment {
  type: "binary";
  mimeType: string;
  data: string;
  fileName?: string;
  filePath?: string;
}

export type ConversationAttachment =
  | ConversationImageAttachment
  | ConversationTextAttachment
  | ConversationBinaryAttachment;

export interface ConversationAttachmentMetadata {
  type?: "image" | "text" | "binary";
  mimeType: string;
  fileName?: string;
  filePath?: string;
  sizeBytes?: number;
}

export type ConversationMessageAttachment = ConversationAttachment | ConversationAttachmentMetadata;

export interface ConversationMessageEvent {
  type: "conversation_message";
  agentId: string;
  role: "user" | "assistant" | "system";
  text: string;
  attachments?: ConversationMessageAttachment[];
  timestamp: string;
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
  source: "user_to_agent" | "agent_to_agent";
  fromAgentId?: string;
  toAgentId: string;
  text: string;
  sourceContext?: MessageSourceContext;
  requestedDelivery?: RequestedDeliveryMode;
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
  kind: AgentToolCallKind;
  toolName?: string;
  toolCallId?: string;
  text: string;
  isError?: boolean;
}

export type ConversationEntryEvent =
  | ConversationMessageEvent
  | ConversationLogEvent
  | AgentMessageEvent
  | AgentToolCallEvent;

export interface AgentStatusEvent {
  type: "agent_status";
  agentId: string;
  status: AgentStatus;
  pendingCount: number;
  contextUsage?: AgentContextUsage;
}

export interface AgentsSnapshotEvent {
  type: "agents_snapshot";
  agents: AgentDescriptor[];
}
