import { AGENT_THINKING_LEVELS, CREATE_MANAGER_MODEL_PRESETS } from "@middleman/protocol";
import type { AgentModelDescriptor, AgentThinkingLevel, SwarmModelPreset } from "./types.js";
import { SWARM_MODEL_PRESETS } from "./types.js";

export const DEFAULT_SWARM_MODEL_PRESET: SwarmModelPreset = "pi-codex";
export type CreateManagerSwarmModelPreset = (typeof CREATE_MANAGER_MODEL_PRESETS)[number];
export const DEFAULT_CREATE_MANAGER_MODEL_PRESET: CreateManagerSwarmModelPreset = "pi-codex";
const GPT_5_4_MODEL_ID = "gpt-5.4";
const GPT_5_4_MINI_MODEL_ID = "gpt-5.4-mini";
const CLAUDE_OPUS_4_6_MODEL_ID = "claude-opus-4-6";
const CLAUDE_SONNET_4_6_MODEL_ID = "claude-sonnet-4-6";
const CLAUDE_HAIKU_4_6_MODEL_ID = "claude-haiku-4-6";

const MODEL_PRESET_DESCRIPTORS: Record<SwarmModelPreset, AgentModelDescriptor> = {
  "pi-codex": {
    provider: "openai-codex",
    modelId: GPT_5_4_MODEL_ID,
    thinkingLevel: "xhigh",
  },
  "pi-codex-mini": {
    provider: "openai-codex",
    modelId: GPT_5_4_MINI_MODEL_ID,
    thinkingLevel: "medium",
  },
  "pi-opus": {
    // Anthropic OAuth tokens trigger Claude Code auth headers in pi-ai,
    // matching the existing Claude Code integration path.
    provider: "anthropic",
    modelId: CLAUDE_OPUS_4_6_MODEL_ID,
    thinkingLevel: "xhigh",
  },
  "pi-sonnet": {
    provider: "anthropic",
    modelId: CLAUDE_SONNET_4_6_MODEL_ID,
    thinkingLevel: "high",
  },
  "pi-haiku": {
    provider: "anthropic",
    modelId: CLAUDE_HAIKU_4_6_MODEL_ID,
    thinkingLevel: "medium",
  },
  "codex-app": {
    provider: "openai-codex-app-server",
    modelId: GPT_5_4_MODEL_ID,
    thinkingLevel: "xhigh",
  },
  "codex-app-mini": {
    provider: "openai-codex-app-server",
    modelId: GPT_5_4_MINI_MODEL_ID,
    thinkingLevel: "medium",
  },
  "claude-code": {
    provider: "anthropic-claude-code",
    modelId: CLAUDE_OPUS_4_6_MODEL_ID,
    thinkingLevel: "xhigh",
  },
  "claude-code-sonnet": {
    provider: "anthropic-claude-code",
    modelId: CLAUDE_SONNET_4_6_MODEL_ID,
    thinkingLevel: "high",
  },
  "claude-code-haiku": {
    provider: "anthropic-claude-code",
    modelId: CLAUDE_HAIKU_4_6_MODEL_ID,
    thinkingLevel: "medium",
  },
};

const MODEL_PRESET_BY_DESCRIPTOR_KEY = new Map<string, SwarmModelPreset>(
  Object.entries(MODEL_PRESET_DESCRIPTORS).map(([preset, descriptor]) => [
    `${descriptor.provider.toLowerCase()}::${descriptor.modelId.toLowerCase()}`,
    preset as SwarmModelPreset,
  ]),
);

const VALID_SWARM_MODEL_PRESET_VALUES = new Set<string>(SWARM_MODEL_PRESETS);
const VALID_CREATE_MANAGER_MODEL_PRESET_VALUES = new Set<string>(CREATE_MANAGER_MODEL_PRESETS);
const VALID_SWARM_THINKING_LEVEL_VALUES = new Set<string>(AGENT_THINKING_LEVELS);

export function describeSwarmModelPresets(): string {
  return SWARM_MODEL_PRESETS.join("|");
}

export function describeCreateManagerModelPresets(): string {
  return CREATE_MANAGER_MODEL_PRESETS.join("|");
}

export function describeSwarmThinkingLevels(): string {
  return AGENT_THINKING_LEVELS.join("|");
}

export function isSwarmModelPreset(value: unknown): value is SwarmModelPreset {
  return typeof value === "string" && VALID_SWARM_MODEL_PRESET_VALUES.has(value);
}

export function isCreateManagerModelPreset(value: unknown): value is CreateManagerSwarmModelPreset {
  return typeof value === "string" && VALID_CREATE_MANAGER_MODEL_PRESET_VALUES.has(value);
}

export function isSwarmThinkingLevel(value: unknown): value is AgentThinkingLevel {
  return typeof value === "string" && VALID_SWARM_THINKING_LEVEL_VALUES.has(value);
}

export function parseSwarmModelPreset(
  value: unknown,
  fieldName: string,
): SwarmModelPreset | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isSwarmModelPreset(value)) {
    throw new Error(`${fieldName} must be one of ${describeSwarmModelPresets()}`);
  }

  return value;
}

export function parseSwarmThinkingLevel(
  value: unknown,
  fieldName: string,
): AgentThinkingLevel | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isSwarmThinkingLevel(value)) {
    throw new Error(`${fieldName} must be one of ${describeSwarmThinkingLevels()}`);
  }

  return value;
}

export function parseCreateManagerModelPreset(
  value: unknown,
  fieldName: string,
): CreateManagerSwarmModelPreset | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isCreateManagerModelPreset(value)) {
    throw new Error(`${fieldName} must be one of ${describeCreateManagerModelPresets()}`);
  }

  return value;
}

export function resolveCreateManagerModelPreset(
  value: unknown,
  fieldName: string,
): CreateManagerSwarmModelPreset {
  return parseCreateManagerModelPreset(value, fieldName) ?? DEFAULT_CREATE_MANAGER_MODEL_PRESET;
}

export function resolveModelDescriptorFromPreset(
  preset: SwarmModelPreset,
  thinkingLevel?: AgentThinkingLevel,
): AgentModelDescriptor {
  const descriptor = MODEL_PRESET_DESCRIPTORS[preset];
  return {
    provider: descriptor.provider,
    modelId: descriptor.modelId,
    thinkingLevel: thinkingLevel ?? descriptor.thinkingLevel,
  };
}

export function inferSwarmModelPresetFromDescriptor(
  descriptor: Pick<AgentModelDescriptor, "provider" | "modelId"> | undefined,
): SwarmModelPreset | undefined {
  if (!descriptor) {
    return undefined;
  }

  const provider = descriptor.provider?.trim().toLowerCase();
  const modelId = descriptor.modelId?.trim().toLowerCase();
  return provider && modelId
    ? MODEL_PRESET_BY_DESCRIPTOR_KEY.get(`${provider}::${modelId}`)
    : undefined;
}
