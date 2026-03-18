import {
  MANAGER_MODEL_PRESETS,
  type AcceptedDeliveryMode,
  type AgentMessageEvent,
  type AgentToolCallEvent,
  type AgentToolCallKind,
  type ConversationAttachment,
  type ConversationAttachmentMetadata,
  type ConversationBinaryAttachment,
  type ConversationEntryEvent,
  type ConversationImageAttachment,
  type ConversationLogEvent,
  type ConversationLogKind,
  type ConversationMessageAttachment,
  type ConversationMessageEvent,
  type ConversationTextAttachment,
  type DeliveryMode,
  type ManagerModelPreset,
  type MessageSourceContext,
  type MessageTargetContext,
} from "@middleman/protocol";

export type AgentRole = "manager" | "worker";

export type AgentArchetypeId = string;

export type AgentStatus =
  | "created"
  | "starting"
  | "idle"
  | "busy"
  | "interrupting"
  | "stopping"
  | "stopped"
  | "errored"
  | "terminated";

export const SWARM_MODEL_PRESETS = MANAGER_MODEL_PRESETS;

export type SwarmModelPreset = ManagerModelPreset;

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
  contextUsage?: AgentContextUsage;
}

export type RequestedDeliveryMode = DeliveryMode;

export type {
  AcceptedDeliveryMode,
  AgentMessageEvent,
  AgentToolCallEvent,
  AgentToolCallKind,
  ConversationAttachment,
  ConversationAttachmentMetadata,
  ConversationBinaryAttachment,
  ConversationEntryEvent,
  ConversationImageAttachment,
  ConversationLogEvent,
  ConversationLogKind,
  ConversationMessageAttachment,
  ConversationMessageEvent,
  ConversationTextAttachment,
  MessageSourceContext,
  MessageTargetContext,
};

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
  installDir: string;
  installAssetsDir: string;
  installArchetypesDir: string;
  installSkillsDir: string;
  cliBinDir: string;
  uiDir: string;
  projectRoot: string;
  projectSwarmDir: string;
  projectArchetypesDir: string;
  projectSkillsDir: string;
  projectMemorySkillFile: string;
  dataDir: string;
  swarmdDbFile: string;
  runtimeScratchDir: string;
  configFile: string;
  configEnvFile: string;
  runDir: string;
  logsDir: string;
  uploadsDir: string;
  authDir: string;
  authFile: string;
  memoryDir: string;
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
  defaultModel: AgentModelDescriptor;
  defaultCwd: string;
  cwdAllowlistRoots: string[];
  paths: SwarmPaths;
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
