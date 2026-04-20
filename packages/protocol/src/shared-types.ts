export type AgentStatus =
  | "created"
  | "starting"
  | "idle"
  | "busy"
  | "compacting"
  | "interrupting"
  | "stopping"
  | "stopped"
  | "errored"
  | "terminated";

export const AGENT_THINKING_LEVELS = ["off", "low", "medium", "high", "xhigh"] as const;
export type AgentThinkingLevel = (typeof AGENT_THINKING_LEVELS)[number];

export interface AgentModelDescriptor {
  provider: string;
  modelId: string;
  thinkingLevel: AgentThinkingLevel;
}

export type ModelPresetAuthProvider = "openai-codex" | "anthropic";
export type ModelPresetIconFamily = "pi-codex" | "pi-claude" | "codex-app" | "claude-code";

export const MANAGER_MODEL_PRESET_REGISTRY = {
  "pi-codex": {
    provider: "openai-codex",
    modelId: "gpt-5.4",
    defaultThinkingLevel: "xhigh",
    contextWindow: 1_048_576,
    telemetryBacked: true,
    availableForManagerCreation: true,
    authProvider: "openai-codex",
    iconFamily: "pi-codex",
    supportsManualCompaction: true,
  },
  "pi-codex-mini": {
    provider: "openai-codex",
    modelId: "gpt-5.4-mini",
    defaultThinkingLevel: "medium",
    contextWindow: 1_048_576,
    telemetryBacked: true,
    availableForManagerCreation: true,
    authProvider: "openai-codex",
    iconFamily: "pi-codex",
    supportsManualCompaction: true,
  },
  "pi-opus": {
    provider: "anthropic",
    modelId: "claude-opus-4-7",
    defaultThinkingLevel: "xhigh",
    contextWindow: 200_000,
    telemetryBacked: true,
    availableForManagerCreation: true,
    authProvider: "anthropic",
    iconFamily: "pi-claude",
    supportsManualCompaction: true,
  },
  "pi-sonnet": {
    provider: "anthropic",
    modelId: "claude-sonnet-4-6",
    defaultThinkingLevel: "high",
    contextWindow: 200_000,
    telemetryBacked: true,
    availableForManagerCreation: true,
    authProvider: "anthropic",
    iconFamily: "pi-claude",
    supportsManualCompaction: true,
  },
  "pi-haiku": {
    provider: "anthropic",
    modelId: "claude-haiku-4-6",
    defaultThinkingLevel: "medium",
    contextWindow: 200_000,
    telemetryBacked: true,
    availableForManagerCreation: true,
    authProvider: "anthropic",
    iconFamily: "pi-claude",
    supportsManualCompaction: true,
  },
  "codex-app": {
    provider: "openai-codex-app-server",
    modelId: "gpt-5.4",
    defaultThinkingLevel: "xhigh",
    contextWindow: 1_048_576,
    telemetryBacked: true,
    availableForManagerCreation: false,
    authProvider: "openai-codex",
    iconFamily: "codex-app",
    supportsManualCompaction: false,
  },
  "codex-app-mini": {
    provider: "openai-codex-app-server",
    modelId: "gpt-5.4-mini",
    defaultThinkingLevel: "medium",
    contextWindow: 1_048_576,
    telemetryBacked: true,
    availableForManagerCreation: false,
    authProvider: "openai-codex",
    iconFamily: "codex-app",
    supportsManualCompaction: false,
  },
  "claude-code": {
    provider: "anthropic-claude-code",
    modelId: "claude-opus-4-7",
    defaultThinkingLevel: "xhigh",
    contextWindow: 200_000,
    telemetryBacked: true,
    availableForManagerCreation: false,
    authProvider: "anthropic",
    iconFamily: "claude-code",
    supportsManualCompaction: false,
  },
  "claude-code-sonnet": {
    provider: "anthropic-claude-code",
    modelId: "claude-sonnet-4-6",
    defaultThinkingLevel: "high",
    contextWindow: 200_000,
    telemetryBacked: true,
    availableForManagerCreation: false,
    authProvider: "anthropic",
    iconFamily: "claude-code",
    supportsManualCompaction: false,
  },
  "claude-code-haiku": {
    provider: "anthropic-claude-code",
    modelId: "claude-haiku-4-6",
    defaultThinkingLevel: "medium",
    contextWindow: 200_000,
    telemetryBacked: true,
    availableForManagerCreation: false,
    authProvider: "anthropic",
    iconFamily: "claude-code",
    supportsManualCompaction: false,
  },
} as const satisfies Record<
  string,
  {
    provider: string;
    modelId: string;
    defaultThinkingLevel: AgentThinkingLevel;
    contextWindow: number;
    telemetryBacked: boolean;
    availableForManagerCreation: boolean;
    authProvider: ModelPresetAuthProvider;
    iconFamily: ModelPresetIconFamily;
    supportsManualCompaction: boolean;
  }
>;

type ManagerModelPresetRegistry = typeof MANAGER_MODEL_PRESET_REGISTRY;

export type ManagerModelPreset = keyof ManagerModelPresetRegistry;
export type ManagerModelPresetDefinition = ManagerModelPresetRegistry[ManagerModelPreset];
export type CreateManagerModelPreset = {
  [Preset in keyof ManagerModelPresetRegistry]: ManagerModelPresetRegistry[Preset]["availableForManagerCreation"] extends true
    ? Preset
    : never;
}[keyof ManagerModelPresetRegistry];

export const MANAGER_MODEL_PRESETS = Object.freeze(
  Object.keys(MANAGER_MODEL_PRESET_REGISTRY) as ManagerModelPreset[],
) as readonly ManagerModelPreset[];
export const CREATE_MANAGER_MODEL_PRESETS = Object.freeze(
  MANAGER_MODEL_PRESETS.filter(
    (preset): preset is CreateManagerModelPreset =>
      MANAGER_MODEL_PRESET_REGISTRY[preset].availableForManagerCreation,
  ),
) as readonly CreateManagerModelPreset[];

const MODEL_PRESET_BY_DESCRIPTOR_KEY = new Map<string, ManagerModelPreset>(
  MANAGER_MODEL_PRESETS.map((preset) => {
    const definition = MANAGER_MODEL_PRESET_REGISTRY[preset];
    return [buildManagerModelPresetDescriptorKey(definition.provider, definition.modelId), preset];
  }),
);

export function getManagerModelPresetDefinition(
  preset: ManagerModelPreset,
): ManagerModelPresetDefinition {
  return MANAGER_MODEL_PRESET_REGISTRY[preset];
}

export function inferManagerModelPresetDefinitionFromDescriptor(
  descriptor: Pick<AgentModelDescriptor, "provider" | "modelId"> | undefined,
): ManagerModelPresetDefinition | undefined {
  const preset = inferManagerModelPresetFromDescriptor(descriptor);
  return preset ? MANAGER_MODEL_PRESET_REGISTRY[preset] : undefined;
}

export function inferManagerModelPresetFromDescriptor(
  descriptor: Pick<AgentModelDescriptor, "provider" | "modelId"> | undefined,
): ManagerModelPreset | undefined {
  if (!descriptor) {
    return undefined;
  }

  return MODEL_PRESET_BY_DESCRIPTOR_KEY.get(
    buildManagerModelPresetDescriptorKey(descriptor.provider, descriptor.modelId),
  );
}

export function inferManagerModelPresetAuthProviderFromDescriptor(
  descriptor: Pick<AgentModelDescriptor, "provider" | "modelId"> | undefined,
): ModelPresetAuthProvider | undefined {
  return inferManagerModelPresetDefinitionFromDescriptor(descriptor)?.authProvider;
}

export function inferManagerModelPresetIconFamilyFromDescriptor(
  descriptor: Pick<AgentModelDescriptor, "provider" | "modelId"> | undefined,
): ModelPresetIconFamily | undefined {
  return inferManagerModelPresetDefinitionFromDescriptor(descriptor)?.iconFamily;
}

export function supportsManualCompactionForDescriptor(
  descriptor: Pick<AgentModelDescriptor, "provider" | "modelId"> | undefined,
): boolean {
  return (
    inferManagerModelPresetDefinitionFromDescriptor(descriptor)?.supportsManualCompaction ?? false
  );
}

function buildManagerModelPresetDescriptorKey(provider: string, modelId: string): string {
  return `${provider.trim().toLowerCase()}::${modelId.trim().toLowerCase()}`;
}

export interface AgentContextUsage {
  tokens: number;
  contextWindow: number;
  percent: number;
}

export interface AgentDescriptor {
  agentId: string;
  managerId: string;
  displayName: string;
  role: "manager" | "worker";
  archetypeId?: string;
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  model: AgentModelDescriptor;
  contextUsage?: AgentContextUsage;
}

export interface NoteSummary {
  path: string;
  name: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  sizeBytes: number;
}

export interface NoteDocument extends NoteSummary {
  content: string;
}

export interface NoteTreeFile extends NoteSummary {
  kind: "file";
}

export interface NoteFolder {
  kind: "folder";
  path: string;
  name: string;
  children: NoteTreeNode[];
}

export type NoteTreeNode = NoteTreeFile | NoteFolder;

export type DeliveryMode = "auto" | "followUp" | "steer";
export type AcceptedDeliveryMode = "prompt" | "followUp" | "steer";

export type MessageChannel = "web";

export interface MessageSourceContext {
  channel: MessageChannel;
}

export type MessageTargetContext = Pick<MessageSourceContext, "channel">;

export interface DirectoryItem {
  name: string;
  path: string;
}
