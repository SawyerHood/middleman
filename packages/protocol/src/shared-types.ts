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

export const AGENT_THINKING_LEVELS = ["off", "low", "medium", "high", "xhigh"] as const;
export type AgentThinkingLevel = (typeof AGENT_THINKING_LEVELS)[number];

export interface AgentModelDescriptor {
  provider: string;
  modelId: string;
  thinkingLevel: AgentThinkingLevel;
}

export type ModelPresetIconFamily = "pi-codex" | "pi-claude" | "codex-app" | "claude-code";

export const MANAGER_MODEL_PRESET_REGISTRY = {
  "pi-codex": {
    provider: "openai-codex",
    modelId: "gpt-5.4",
    defaultThinkingLevel: "xhigh",
    contextWindow: 1_048_576,
    telemetryBacked: true,
    availableForManagerCreation: true,
    iconFamily: "pi-codex",
  },
  "pi-codex-mini": {
    provider: "openai-codex",
    modelId: "gpt-5.4-mini",
    defaultThinkingLevel: "medium",
    contextWindow: 1_048_576,
    telemetryBacked: true,
    availableForManagerCreation: true,
    iconFamily: "pi-codex",
  },
  "pi-opus": {
    provider: "anthropic",
    modelId: "claude-opus-4-6",
    defaultThinkingLevel: "xhigh",
    contextWindow: 200_000,
    telemetryBacked: true,
    availableForManagerCreation: true,
    iconFamily: "pi-claude",
  },
  "pi-sonnet": {
    provider: "anthropic",
    modelId: "claude-sonnet-4-6",
    defaultThinkingLevel: "high",
    contextWindow: 200_000,
    telemetryBacked: true,
    availableForManagerCreation: true,
    iconFamily: "pi-claude",
  },
  "pi-haiku": {
    provider: "anthropic",
    modelId: "claude-haiku-4-6",
    defaultThinkingLevel: "medium",
    contextWindow: 200_000,
    telemetryBacked: true,
    availableForManagerCreation: true,
    iconFamily: "pi-claude",
  },
  "codex-app": {
    provider: "openai-codex-app-server",
    modelId: "gpt-5.4",
    defaultThinkingLevel: "xhigh",
    contextWindow: 1_048_576,
    telemetryBacked: true,
    availableForManagerCreation: false,
    iconFamily: "codex-app",
  },
  "codex-app-mini": {
    provider: "openai-codex-app-server",
    modelId: "gpt-5.4-mini",
    defaultThinkingLevel: "medium",
    contextWindow: 1_048_576,
    telemetryBacked: true,
    availableForManagerCreation: false,
    iconFamily: "codex-app",
  },
  "claude-code": {
    provider: "anthropic-claude-code",
    modelId: "claude-opus-4-6",
    defaultThinkingLevel: "xhigh",
    contextWindow: 200_000,
    telemetryBacked: true,
    availableForManagerCreation: false,
    iconFamily: "claude-code",
  },
  "claude-code-sonnet": {
    provider: "anthropic-claude-code",
    modelId: "claude-sonnet-4-6",
    defaultThinkingLevel: "high",
    contextWindow: 200_000,
    telemetryBacked: true,
    availableForManagerCreation: false,
    iconFamily: "claude-code",
  },
  "claude-code-haiku": {
    provider: "anthropic-claude-code",
    modelId: "claude-haiku-4-6",
    defaultThinkingLevel: "medium",
    contextWindow: 200_000,
    telemetryBacked: true,
    availableForManagerCreation: false,
    iconFamily: "claude-code",
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
    iconFamily: ModelPresetIconFamily;
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
