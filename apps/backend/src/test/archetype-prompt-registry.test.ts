import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadArchetypePromptRegistry } from "../swarm/archetypes/archetype-prompt-registry.js";

const BUILT_IN_ARCHETYPES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "swarm",
  "archetypes",
  "builtins",
);

describe("loadArchetypePromptRegistry", () => {
  it("loads built-in manager and merger prompts", async () => {
    const root = await mkdtemp(join(tmpdir(), "swarm-archetype-prompt-test-"));
    const projectOverridesDir = join(root, ".swarm", "archetypes");

    const registry = await loadArchetypePromptRegistry({
      builtInDir: BUILT_IN_ARCHETYPES_DIR,
      projectOverridesDir,
    });

    expect(registry.resolvePrompt("manager")).toContain(
      "You are the manager agent in a multi-agent swarm.",
    );
    expect(registry.resolvePrompt("merger")).toContain(
      "You are the merger agent in a multi-agent swarm.",
    );
  });

  it("applies repo markdown overrides with precedence by archetype id", async () => {
    const root = await mkdtemp(join(tmpdir(), "swarm-archetype-prompt-test-"));
    const projectOverridesDir = join(root, ".swarm", "archetypes");
    await mkdir(projectOverridesDir, { recursive: true });

    await writeFile(join(projectOverridesDir, "manager.md"), "repo manager override\n", "utf8");

    const registry = await loadArchetypePromptRegistry({
      builtInDir: BUILT_IN_ARCHETYPES_DIR,
      projectOverridesDir,
    });

    expect(registry.resolvePrompt("manager")).toBe("repo manager override");
    expect(registry.resolvePrompt("merger")).toContain(
      "You are the merger agent in a multi-agent swarm.",
    );
  });
});
