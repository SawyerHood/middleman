import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseSkillFrontmatter, type ParsedSkillEnvDeclaration } from "./skill-frontmatter.js";
import type { SwarmConfig } from "./types.js";

const REPO_BUILT_IN_SKILLS_RELATIVE_DIR = "apps/backend/src/swarm/skills/builtins";
const SKILL_FILE_NAME = "SKILL.md";
const REQUIRED_SKILL_NAMES = [
  "memory",
  "brave-search",
  "cron-scheduling",
  "image-generation",
] as const;

export interface SkillMetadata {
  skillName: string;
  description?: string;
  path: string;
  env: ParsedSkillEnvDeclaration[];
}

interface SkillMetadataServiceDependencies {
  config: SwarmConfig;
}

interface SkillPathCandidate {
  skillDirectoryName: string;
  path: string;
}

export class SkillMetadataService {
  private skillMetadata: SkillMetadata[] = [];

  constructor(private readonly deps: SkillMetadataServiceDependencies) {}

  getSkillMetadata(): SkillMetadata[] {
    return this.skillMetadata.map((metadata) => ({
      skillName: metadata.skillName,
      description: metadata.description,
      path: metadata.path,
      env: [...metadata.env],
    }));
  }

  getAdditionalSkillPaths(): string[] {
    return this.skillMetadata.map((metadata) => metadata.path);
  }

  async ensureSkillMetadataLoaded(): Promise<void> {
    if (this.skillMetadata.length > 0) {
      return;
    }

    await this.reloadSkillMetadata();
  }

  async reloadSkillMetadata(): Promise<void> {
    const scannedCandidates = await this.scanSkillPathCandidates();
    const skillPathIndex = this.buildSkillPathIndex(scannedCandidates);

    const requiredSkillPaths = [
      this.resolveMemorySkillPath(skillPathIndex),
      this.resolveBraveSearchSkillPath(skillPathIndex),
      this.resolveCronSchedulingSkillPath(skillPathIndex),
      this.resolveImageGenerationSkillPath(skillPathIndex),
    ];

    const metadata: SkillMetadata[] = [];
    const seenSkillNames = new Set<string>();

    for (const skillPath of requiredSkillPaths) {
      const markdown = await readFile(skillPath, "utf8");
      const parsed = parseSkillFrontmatter(markdown);
      const fallbackSkillName = this.resolveSkillNameFromPath(skillPath);
      const skillName = (parsed.name ?? fallbackSkillName).trim();
      const normalizedSkillName = normalizeSkillName(skillName);
      if (seenSkillNames.has(normalizedSkillName)) {
        continue;
      }

      seenSkillNames.add(normalizedSkillName);
      metadata.push({
        skillName,
        description: parsed.description?.trim() || undefined,
        path: skillPath,
        env: parsed.env,
      });
    }

    this.skillMetadata = metadata;
  }

  private resolveMemorySkillPath(skillPathIndex: Map<string, string[]>): string {
    return this.resolveRequiredSkillPath(
      "memory",
      skillPathIndex,
      this.deps.config.paths.projectMemorySkillFile,
    );
  }

  private resolveBraveSearchSkillPath(skillPathIndex: Map<string, string[]>): string {
    return this.resolveRequiredSkillPath("brave-search", skillPathIndex);
  }

  private resolveCronSchedulingSkillPath(skillPathIndex: Map<string, string[]>): string {
    return this.resolveRequiredSkillPath("cron-scheduling", skillPathIndex);
  }

  private resolveImageGenerationSkillPath(skillPathIndex: Map<string, string[]>): string {
    return this.resolveRequiredSkillPath("image-generation", skillPathIndex);
  }

  private resolveRequiredSkillPath(
    skillName: (typeof REQUIRED_SKILL_NAMES)[number],
    skillPathIndex: Map<string, string[]>,
    explicitOverridePath?: string,
  ): string {
    if (typeof explicitOverridePath === "string" && existsSync(explicitOverridePath)) {
      return explicitOverridePath;
    }

    const normalizedSkillName = normalizeSkillName(skillName);
    const paths = skillPathIndex.get(normalizedSkillName) ?? [];
    if (paths.length > 0) {
      return paths[0];
    }

    throw new Error(`Missing built-in ${skillName} skill file`);
  }

  private async scanSkillPathCandidates(): Promise<SkillPathCandidate[]> {
    const candidates: SkillPathCandidate[] = [];
    const repositoryBuiltInSkillsDir = resolve(
      this.deps.config.paths.projectRoot,
      REPO_BUILT_IN_SKILLS_RELATIVE_DIR,
    );

    candidates.push(
      ...(await this.scanSkillFilesInDirectory(this.deps.config.paths.projectSkillsDir)),
    );
    candidates.push(
      ...(await this.scanSkillFilesInDirectory(this.deps.config.paths.installSkillsDir)),
    );
    candidates.push(...(await this.scanSkillFilesInDirectory(repositoryBuiltInSkillsDir)));

    return candidates;
  }

  private async scanSkillFilesInDirectory(directory: string): Promise<SkillPathCandidate[]> {
    let entries: Array<{ isDirectory: () => boolean; name: string }>;

    try {
      const dirEntries = await readdir(directory, { withFileTypes: true, encoding: "utf8" });
      entries = dirEntries.map((entry) => ({
        isDirectory: () => entry.isDirectory(),
        name: String(entry.name),
      }));
    } catch {
      return [];
    }

    const skillDirectories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));

    const candidates: SkillPathCandidate[] = [];
    for (const skillDirectoryName of skillDirectories) {
      const skillPath = join(directory, skillDirectoryName, SKILL_FILE_NAME);
      if (!existsSync(skillPath)) {
        continue;
      }

      candidates.push({
        skillDirectoryName,
        path: skillPath,
      });
    }

    return candidates;
  }

  private buildSkillPathIndex(candidates: SkillPathCandidate[]): Map<string, string[]> {
    const index = new Map<string, string[]>();

    for (const candidate of candidates) {
      const normalizedSkillName = normalizeSkillName(candidate.skillDirectoryName);
      const existing = index.get(normalizedSkillName) ?? [];
      if (!existing.includes(candidate.path)) {
        existing.push(candidate.path);
      }
      index.set(normalizedSkillName, existing);
    }

    return index;
  }

  private resolveSkillNameFromPath(path: string): string {
    const segments = path.split(/[\\/]+/g).filter((segment) => segment.length > 0);
    if (segments.length < 2) {
      return "unknown";
    }

    // .../<skill-name>/SKILL.md
    return segments[segments.length - 2] ?? "unknown";
  }
}

function normalizeSkillName(skillName: string): string {
  return skillName.trim().toLowerCase();
}
