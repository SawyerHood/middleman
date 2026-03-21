import type { AgentDescriptor, ManagerModelPreset } from "@middleman/protocol";

const MODEL_PRESET_BY_DESCRIPTOR_KEY = new Map<string, ManagerModelPreset>([
  ["openai-codex::gpt-5.4", "pi-codex"],
  ["openai-codex::gpt-5.4-mini", "pi-codex-mini"],
  ["anthropic::claude-opus-4-6", "pi-opus"],
  ["anthropic::claude-sonnet-4-6", "pi-sonnet"],
  ["anthropic::claude-haiku-4-6", "pi-haiku"],
  ["openai-codex-app-server::gpt-5.4", "codex-app"],
  ["openai-codex-app-server::gpt-5.4-mini", "codex-app-mini"],
  ["anthropic-claude-code::claude-opus-4-6", "claude-code"],
  ["anthropic-claude-code::claude-sonnet-4-6", "claude-code-sonnet"],
  ["anthropic-claude-code::claude-haiku-4-6", "claude-code-haiku"],
]);

export function inferModelPreset(agent: AgentDescriptor): ManagerModelPreset | undefined {
  const provider = agent.model.provider.trim().toLowerCase();
  const modelId = agent.model.modelId.trim().toLowerCase();
  return MODEL_PRESET_BY_DESCRIPTOR_KEY.get(`${provider}::${modelId}`);
}
