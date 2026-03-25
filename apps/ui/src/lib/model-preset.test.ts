import { describe, expect, it } from "vitest";
import { inferModelPreset, inferModelPresetIconFamily } from "./model-preset";
import type { AgentDescriptor } from "@middleman/protocol";

function buildAgent(
  provider: string,
  modelId: string,
  thinkingLevel: AgentDescriptor["model"]["thinkingLevel"] = "medium",
): AgentDescriptor {
  return {
    agentId: "agent-1",
    managerId: "manager-1",
    displayName: "Agent 1",
    role: "worker",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp/project",
    model: {
      provider,
      modelId,
      thinkingLevel,
    },
  };
}

describe("inferModelPreset", () => {
  it.each([
    ["openai-codex", "gpt-5.4-mini", "pi-codex-mini"],
    ["anthropic", "claude-sonnet-4-6", "pi-sonnet"],
    ["anthropic", "claude-haiku-4-6", "pi-haiku"],
    ["openai-codex-app-server", "gpt-5.4-mini", "codex-app-mini"],
    ["anthropic-claude-code", "claude-sonnet-4-6", "claude-code-sonnet"],
    ["anthropic-claude-code", "claude-haiku-4-6", "claude-code-haiku"],
  ] as const)("maps %s/%s to %s", (provider, modelId, expectedPreset) => {
    expect(inferModelPreset(buildAgent(provider, modelId))).toBe(expectedPreset);
  });

  it("returns undefined for unknown descriptors", () => {
    expect(inferModelPreset(buildAgent("anthropic", "claude-unknown"))).toBeUndefined();
  });

  it.each([
    ["openai-codex", "gpt-5.4-mini", "pi-codex"],
    ["anthropic", "claude-sonnet-4-6", "pi-claude"],
    ["openai-codex-app-server", "gpt-5.4-mini", "codex-app"],
    ["anthropic-claude-code", "claude-haiku-4-6", "claude-code"],
  ] as const)("maps %s/%s to icon family %s", (provider, modelId, expectedIconFamily) => {
    expect(inferModelPresetIconFamily(buildAgent(provider, modelId))).toBe(expectedIconFamily);
  });
});
