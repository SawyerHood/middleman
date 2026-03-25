import {
  AGENT_THINKING_LEVELS,
  CREATE_MANAGER_MODEL_PRESETS,
  getManagerModelPresetDefinition,
  inferManagerModelPresetAuthProviderFromDescriptor,
  inferManagerModelPresetFromDescriptor,
} from "@middleman/protocol";
import type {
  AgentModelDescriptor,
  AgentThinkingLevel,
  SettingsAuthProviderName,
  SwarmModelPreset,
} from "./types.js";
import { SWARM_MODEL_PRESETS } from "./types.js";

export const DEFAULT_SWARM_MODEL_PRESET: SwarmModelPreset = "pi-codex";
export type CreateManagerSwarmModelPreset = (typeof CREATE_MANAGER_MODEL_PRESETS)[number];
export const DEFAULT_CREATE_MANAGER_MODEL_PRESET: CreateManagerSwarmModelPreset = "pi-codex";

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
  const descriptor = getManagerModelPresetDefinition(preset);
  return {
    provider: descriptor.provider,
    modelId: descriptor.modelId,
    thinkingLevel: thinkingLevel ?? descriptor.defaultThinkingLevel,
  };
}

export function inferSwarmModelPresetFromDescriptor(
  descriptor: Pick<AgentModelDescriptor, "provider" | "modelId"> | undefined,
): SwarmModelPreset | undefined {
  return inferManagerModelPresetFromDescriptor(descriptor);
}

export function inferSettingsAuthProviderFromDescriptor(
  descriptor: Pick<AgentModelDescriptor, "provider" | "modelId"> | undefined,
): SettingsAuthProviderName | undefined {
  return inferManagerModelPresetAuthProviderFromDescriptor(descriptor);
}
