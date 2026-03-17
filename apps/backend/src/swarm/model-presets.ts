import type {
  AgentModelDescriptor,
  ManagerSwarmModelPreset,
  SwarmModelPreset,
} from "./types.js";
import { MANAGER_SWARM_MODEL_PRESETS, SWARM_MODEL_PRESETS } from "./types.js";

export const DEFAULT_SWARM_MODEL_PRESET: SwarmModelPreset = "pi-codex";
const PI_CODEX_MODEL_ID = "gpt-5.4";
const LEGACY_PI_CODEX_MODEL_ID = "gpt-5.3-codex";
const CODEX_APP_MODEL_ID = "gpt-5.4";
const LEGACY_CODEX_APP_MODEL_ID = "default";

const MODEL_PRESET_DESCRIPTORS: Record<SwarmModelPreset, AgentModelDescriptor> = {
  "pi-codex": {
    provider: "openai-codex",
    modelId: PI_CODEX_MODEL_ID,
    thinkingLevel: "xhigh"
  },
  "pi-opus": {
    // Anthropic OAuth tokens trigger Claude Code auth headers in pi-ai,
    // matching the existing Claude Code integration path.
    provider: "anthropic",
    modelId: "claude-opus-4-6",
    thinkingLevel: "xhigh"
  },
  "codex-app": {
    provider: "openai-codex-app-server",
    modelId: CODEX_APP_MODEL_ID,
    thinkingLevel: "xhigh"
  },
  "claude-code": {
    provider: "anthropic-claude-code",
    modelId: "claude-opus-4-6",
    thinkingLevel: "xhigh"
  }
};

const VALID_SWARM_MODEL_PRESET_VALUES = new Set<string>(SWARM_MODEL_PRESETS);
const VALID_MANAGER_SWARM_MODEL_PRESET_VALUES = new Set<string>(
  MANAGER_SWARM_MODEL_PRESETS,
);

export function describeSwarmModelPresets(): string {
  return SWARM_MODEL_PRESETS.join("|");
}

export function describeManagerSwarmModelPresets(): string {
  return MANAGER_SWARM_MODEL_PRESETS.join("|");
}

export function isSwarmModelPreset(value: unknown): value is SwarmModelPreset {
  return typeof value === "string" && VALID_SWARM_MODEL_PRESET_VALUES.has(value);
}

export function isManagerSwarmModelPreset(value: unknown): value is ManagerSwarmModelPreset {
  return typeof value === "string" && VALID_MANAGER_SWARM_MODEL_PRESET_VALUES.has(value);
}

export function parseSwarmModelPreset(value: unknown, fieldName: string): SwarmModelPreset | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isSwarmModelPreset(value)) {
    throw new Error(`${fieldName} must be one of ${describeSwarmModelPresets()}`);
  }

  return value;
}

export function parseManagerSwarmModelPreset(
  value: unknown,
  fieldName: string
): ManagerSwarmModelPreset | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isManagerSwarmModelPreset(value)) {
    throw new Error(`${fieldName} must be one of ${describeManagerSwarmModelPresets()}`);
  }

  return value;
}

export function resolveModelDescriptorFromPreset(preset: SwarmModelPreset): AgentModelDescriptor {
  const descriptor = MODEL_PRESET_DESCRIPTORS[preset];
  return {
    provider: descriptor.provider,
    modelId: descriptor.modelId,
    thinkingLevel: descriptor.thinkingLevel
  };
}

export function inferSwarmModelPresetFromDescriptor(
  descriptor: Pick<AgentModelDescriptor, "provider" | "modelId"> | undefined
): SwarmModelPreset | undefined {
  if (!descriptor) {
    return undefined;
  }

  const provider = descriptor.provider?.trim().toLowerCase();
  const modelId = descriptor.modelId?.trim().toLowerCase();

  if (provider === "openai-codex" && (modelId === PI_CODEX_MODEL_ID || modelId === LEGACY_PI_CODEX_MODEL_ID)) {
    return "pi-codex";
  }

  if (provider === "anthropic" && modelId === "claude-opus-4-6") {
    return "pi-opus";
  }

  if (
    provider === "openai-codex-app-server" &&
    (modelId === CODEX_APP_MODEL_ID || modelId === LEGACY_CODEX_APP_MODEL_ID)
  ) {
    return "codex-app";
  }

  if (provider === "anthropic-claude-code" && modelId === "claude-opus-4-6") {
    return "claude-code";
  }

  return undefined;
}

export function normalizeSwarmModelDescriptor(
  descriptor: Pick<AgentModelDescriptor, "provider" | "modelId"> | undefined,
  fallbackPreset: SwarmModelPreset = DEFAULT_SWARM_MODEL_PRESET
): AgentModelDescriptor {
  const preset = inferSwarmModelPresetFromDescriptor(descriptor) ?? fallbackPreset;
  return resolveModelDescriptorFromPreset(preset);
}
