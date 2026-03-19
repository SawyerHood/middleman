import { CREATE_MANAGER_MODEL_PRESETS } from "@middleman/protocol";
import type { AgentModelDescriptor, SwarmModelPreset } from "./types.js";
import { SWARM_MODEL_PRESETS } from "./types.js";

export const DEFAULT_SWARM_MODEL_PRESET: SwarmModelPreset = "pi-codex";
export type CreateManagerSwarmModelPreset = (typeof CREATE_MANAGER_MODEL_PRESETS)[number];
export const DEFAULT_CREATE_MANAGER_MODEL_PRESET: CreateManagerSwarmModelPreset = "pi-codex";
const GPT_5_4_MODEL_ID = "gpt-5.4";

const MODEL_PRESET_DESCRIPTORS: Record<SwarmModelPreset, AgentModelDescriptor> = {
  "pi-codex": {
    provider: "openai-codex",
    modelId: GPT_5_4_MODEL_ID,
    thinkingLevel: "xhigh",
  },
  "pi-opus": {
    // Anthropic OAuth tokens trigger Claude Code auth headers in pi-ai,
    // matching the existing Claude Code integration path.
    provider: "anthropic",
    modelId: "claude-opus-4-6",
    thinkingLevel: "xhigh",
  },
  "codex-app": {
    provider: "openai-codex-app-server",
    modelId: GPT_5_4_MODEL_ID,
    thinkingLevel: "xhigh",
  },
  "claude-code": {
    provider: "anthropic-claude-code",
    modelId: "claude-opus-4-6",
    thinkingLevel: "xhigh",
  },
};

const VALID_SWARM_MODEL_PRESET_VALUES = new Set<string>(SWARM_MODEL_PRESETS);
const VALID_CREATE_MANAGER_MODEL_PRESET_VALUES = new Set<string>(CREATE_MANAGER_MODEL_PRESETS);

export function describeSwarmModelPresets(): string {
  return SWARM_MODEL_PRESETS.join("|");
}

export function describeCreateManagerModelPresets(): string {
  return CREATE_MANAGER_MODEL_PRESETS.join("|");
}

export function isSwarmModelPreset(value: unknown): value is SwarmModelPreset {
  return typeof value === "string" && VALID_SWARM_MODEL_PRESET_VALUES.has(value);
}

export function isCreateManagerModelPreset(value: unknown): value is CreateManagerSwarmModelPreset {
  return typeof value === "string" && VALID_CREATE_MANAGER_MODEL_PRESET_VALUES.has(value);
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

export function resolveModelDescriptorFromPreset(preset: SwarmModelPreset): AgentModelDescriptor {
  const descriptor = MODEL_PRESET_DESCRIPTORS[preset];
  return {
    provider: descriptor.provider,
    modelId: descriptor.modelId,
    thinkingLevel: descriptor.thinkingLevel,
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

  if (provider === "openai-codex" && modelId === GPT_5_4_MODEL_ID) {
    return "pi-codex";
  }

  if (provider === "anthropic" && modelId === "claude-opus-4-6") {
    return "pi-opus";
  }

  if (provider === "openai-codex-app-server" && modelId === GPT_5_4_MODEL_ID) {
    return "codex-app";
  }

  if (provider === "anthropic-claude-code" && modelId === "claude-opus-4-6") {
    return "claude-code";
  }

  return undefined;
}
