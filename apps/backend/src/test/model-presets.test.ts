import { MANAGER_MODEL_PRESETS } from "@middleman/protocol";
import { describe, expect, it } from "vitest";
import {
  inferSettingsAuthProviderFromDescriptor,
  inferSwarmModelPresetFromDescriptor,
  parseSwarmModelPreset,
  parseSwarmThinkingLevel,
  resolveModelDescriptorFromPreset,
} from "../swarm/model-presets.js";

describe("model presets", () => {
  it.each([
    ["pi-codex", { provider: "openai-codex", modelId: "gpt-5.4", thinkingLevel: "xhigh" }],
    [
      "pi-codex-mini",
      { provider: "openai-codex", modelId: "gpt-5.4-mini", thinkingLevel: "medium" },
    ],
    ["pi-opus", { provider: "anthropic", modelId: "claude-opus-4-7", thinkingLevel: "xhigh" }],
    ["pi-sonnet", { provider: "anthropic", modelId: "claude-sonnet-4-6", thinkingLevel: "high" }],
    ["pi-haiku", { provider: "anthropic", modelId: "claude-haiku-4-6", thinkingLevel: "medium" }],
    [
      "codex-app",
      { provider: "openai-codex-app-server", modelId: "gpt-5.4", thinkingLevel: "xhigh" },
    ],
    [
      "codex-app-mini",
      {
        provider: "openai-codex-app-server",
        modelId: "gpt-5.4-mini",
        thinkingLevel: "medium",
      },
    ],
    [
      "claude-code",
      {
        provider: "anthropic-claude-code",
        modelId: "claude-opus-4-7",
        thinkingLevel: "xhigh",
      },
    ],
    [
      "claude-code-sonnet",
      {
        provider: "anthropic-claude-code",
        modelId: "claude-sonnet-4-6",
        thinkingLevel: "high",
      },
    ],
    [
      "claude-code-haiku",
      {
        provider: "anthropic-claude-code",
        modelId: "claude-haiku-4-6",
        thinkingLevel: "medium",
      },
    ],
  ] as const)("resolves %s to the expected descriptor", (preset, descriptor) => {
    expect(resolveModelDescriptorFromPreset(preset)).toEqual(descriptor);
  });

  it.each([
    ["pi-codex", { provider: "openai-codex", modelId: "gpt-5.4" }],
    ["pi-codex-mini", { provider: "openai-codex", modelId: "gpt-5.4-mini" }],
    ["pi-opus", { provider: "anthropic", modelId: "claude-opus-4-7" }],
    ["pi-sonnet", { provider: "anthropic", modelId: "claude-sonnet-4-6" }],
    ["pi-haiku", { provider: "anthropic", modelId: "claude-haiku-4-6" }],
    ["codex-app", { provider: "openai-codex-app-server", modelId: "gpt-5.4" }],
    ["codex-app-mini", { provider: "openai-codex-app-server", modelId: "gpt-5.4-mini" }],
    ["claude-code", { provider: "anthropic-claude-code", modelId: "claude-opus-4-7" }],
    ["claude-code-sonnet", { provider: "anthropic-claude-code", modelId: "claude-sonnet-4-6" }],
    ["claude-code-haiku", { provider: "anthropic-claude-code", modelId: "claude-haiku-4-6" }],
  ] as const)("infers %s from the descriptor", (preset, descriptor) => {
    expect(inferSwarmModelPresetFromDescriptor(descriptor)).toBe(preset);
  });

  it("includes all supported presets in parse validation errors", () => {
    expect(() => parseSwarmModelPreset("invalid", "spawn_agent.model")).toThrow(
      `spawn_agent.model must be one of ${MANAGER_MODEL_PRESETS.join("|")}`,
    );
  });

  it("allows spawn_agent thinking level overrides", () => {
    expect(resolveModelDescriptorFromPreset("codex-app-mini", "low")).toEqual({
      provider: "openai-codex-app-server",
      modelId: "gpt-5.4-mini",
      thinkingLevel: "low",
    });
  });

  it("returns undefined when descriptor inference cannot match a preset", () => {
    expect(
      inferSwarmModelPresetFromDescriptor({
        provider: "anthropic",
        modelId: "claude-unknown",
      }),
    ).toBeUndefined();
  });

  it("keeps exact thinking levels for base presets", () => {
    expect(resolveModelDescriptorFromPreset("codex-app")).toEqual({
      provider: "openai-codex-app-server",
      modelId: "gpt-5.4",
      thinkingLevel: "xhigh",
    });
  });

  it("validates supported thinking levels", () => {
    expect(parseSwarmThinkingLevel("off", "spawn_agent.thinkingLevel")).toBe("off");
    expect(() => parseSwarmThinkingLevel("max", "spawn_agent.thinkingLevel")).toThrow(
      "spawn_agent.thinkingLevel must be one of off|low|medium|high|xhigh",
    );
  });

  it.each([
    [{ provider: "openai-codex", modelId: "gpt-5.4" }, "openai-codex"],
    [{ provider: "openai-codex-app-server", modelId: "gpt-5.4-mini" }, "openai-codex"],
    [{ provider: "anthropic", modelId: "claude-opus-4-7" }, "anthropic"],
    [{ provider: "anthropic-claude-code", modelId: "claude-haiku-4-6" }, "anthropic"],
  ] as const)("infers auth provider %s for descriptor %#", (descriptor, expected) => {
    expect(inferSettingsAuthProviderFromDescriptor(descriptor)).toBe(expected);
  });
});
