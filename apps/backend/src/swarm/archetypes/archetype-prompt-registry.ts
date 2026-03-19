import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { AgentArchetypeId } from "../types.js";

export const BUILTIN_ARCHETYPE_IDS = ["manager", "merger"] as const;
export type BuiltInArchetypeId = (typeof BUILTIN_ARCHETYPE_IDS)[number];

interface BuiltInArchetypeDefinition {
  id: BuiltInArchetypeId;
  fileName: string;
}

const BUILTIN_ARCHETYPE_DEFINITIONS: readonly BuiltInArchetypeDefinition[] = [
  { id: "manager", fileName: "manager.md" },
  { id: "merger", fileName: "merger.md" },
] as const;

export interface ArchetypePromptRegistry {
  resolvePrompt(archetypeId: AgentArchetypeId): string | undefined;
  listArchetypeIds(): AgentArchetypeId[];
}

class MapBackedArchetypePromptRegistry implements ArchetypePromptRegistry {
  constructor(private readonly promptsById: Map<AgentArchetypeId, string>) {}

  resolvePrompt(archetypeId: AgentArchetypeId): string | undefined {
    return this.promptsById.get(archetypeId);
  }

  listArchetypeIds(): AgentArchetypeId[] {
    return Array.from(this.promptsById.keys()).sort((a, b) => a.localeCompare(b));
  }
}

export async function loadArchetypePromptRegistry(options: {
  builtInDir: string;
  projectOverridesDir: string;
}): Promise<ArchetypePromptRegistry> {
  const promptsById = await loadBuiltInPrompts(options.builtInDir);
  const repoOverrides = await loadProjectOverridePrompts(options.projectOverridesDir);

  for (const [id, prompt] of repoOverrides.entries()) {
    promptsById.set(id, prompt);
  }

  return new MapBackedArchetypePromptRegistry(promptsById);
}

export function normalizeArchetypeId(input: string): AgentArchetypeId {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function loadBuiltInPrompts(builtInDir: string): Promise<Map<AgentArchetypeId, string>> {
  const promptsById = new Map<AgentArchetypeId, string>();

  for (const definition of BUILTIN_ARCHETYPE_DEFINITIONS) {
    const filePath = resolveBuiltInPromptPath(builtInDir, definition.fileName);
    const raw = await readFile(filePath, "utf8");
    const prompt = normalizePromptText(raw, definition.id, filePath);
    promptsById.set(definition.id, prompt);
  }

  return promptsById;
}

function resolveBuiltInPromptPath(builtInDir: string, fileName: string): string {
  return resolve(builtInDir, fileName);
}

async function loadProjectOverridePrompts(
  projectOverridesDir: string,
): Promise<Map<AgentArchetypeId, string>> {
  const promptsById = new Map<AgentArchetypeId, string>();

  let entries: Dirent[];
  try {
    entries = await readdir(projectOverridesDir, { withFileTypes: true });
  } catch (error) {
    if (isEnoentError(error)) {
      return promptsById;
    }
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    if (extname(entry.name).toLowerCase() !== ".md") {
      continue;
    }

    const fileNameWithoutExtension = entry.name.slice(0, -3);
    const id = normalizeArchetypeId(fileNameWithoutExtension);
    if (!id) {
      continue;
    }

    const filePath = resolve(projectOverridesDir, entry.name);
    const raw = await readFile(filePath, "utf8");
    const prompt = normalizePromptText(raw, id, filePath);
    promptsById.set(id, prompt);
  }

  return promptsById;
}

function normalizePromptText(raw: string, archetypeId: string, sourcePath: string): string {
  const prompt = raw.trim();
  if (!prompt) {
    throw new Error(`Prompt for archetype \"${archetypeId}\" is empty: ${sourcePath}`);
  }
  return prompt;
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
