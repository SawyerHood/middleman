import { describe, expect, it } from "vitest";

import { createConfig } from "../config.js";
import type { ArchetypePromptRegistry } from "../swarm/archetypes/archetype-prompt-registry.js";
import { SwarmRuntimeContextService } from "../swarm/swarm-runtime-context.js";

const REPO_ROOT = process.cwd();

function createService(registry?: ArchetypePromptRegistry) {
  return new SwarmRuntimeContextService({
    config: createConfig({
      installDir: REPO_ROOT,
      projectRoot: REPO_ROOT,
      dataDir: "/tmp/middleman-swarm-runtime-context",
    }),
    cwdAllowlistRoots: [],
    skillMetadataService: {} as never,
    getArchetypePromptRegistry: () =>
      registry ??
      ({
        resolvePrompt: () => undefined,
        listArchetypeIds: () => [],
      } satisfies ArchetypePromptRegistry),
    getSettingsRepo: () =>
      ({
        listEnv: () => ({}),
      }) as never,
    listAgents: () => [],
  });
}

describe("SwarmRuntimeContextService", () => {
  it("renders skill descriptors instead of full skill file contents", () => {
    const service = createService();

    const prompt = service.buildSessionSystemPrompt("You are a worker.", "codex", {
      memoryContextFile: {
        path: "/tmp/memory.md",
        content: "Remember the team's preferences.",
      },
      swarmContextFiles: [
        {
          path: "/repo/SWARM.md",
          content: "Repository policy goes here.",
        },
      ],
      skillDescriptors: [
        {
          skillName: "memory",
          description: "Persist important user preferences and decisions.",
          path: "/skills/memory/SKILL.md",
        },
        {
          skillName: "dev-browser",
          description: "Drive a browser for UI tests.",
          path: "/skills/dev-browser/SKILL.md",
        },
      ],
      additionalSkillPaths: [],
      runtimeEnv: {},
    });

    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain(
      "- memory: Persist important user preferences and decisions. (file: /skills/memory/SKILL.md)",
    );
    expect(prompt).toContain(
      "- dev-browser: Drive a browser for UI tests. (file: /skills/dev-browser/SKILL.md)",
    );
    expect(prompt).not.toContain("## Full Skill Body");
    expect(prompt).not.toContain("Always read every file in this directory.");
  });

  it("appends available archetype ids to manager system prompts", () => {
    const service = createService({
      resolvePrompt: (archetypeId) =>
        archetypeId === "manager" ? "You are the manager." : undefined,
      listArchetypeIds: () => ["manager", "merger"],
    });

    expect(
      service.resolveSystemPromptForDescriptor({
        role: "manager",
        archetypeId: "manager",
      }),
    ).toBe("You are the manager.\n\nAvailable archetypes for spawn_agent: manager, merger");
  });
});
