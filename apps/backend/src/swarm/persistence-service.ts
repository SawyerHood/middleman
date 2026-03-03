import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getScheduleFilePath } from "../scheduler/schedule-storage.js";
import { getAgentMemoryPath as getAgentMemoryPathForDataDir } from "./memory-paths.js";
import type { AgentDescriptor, AgentsStoreFile, SwarmConfig } from "./types.js";

const DEFAULT_MEMORY_FILE_CONTENT = `# Swarm Memory

## User Preferences
- (none yet)

## Project Facts
- (none yet)

## Decisions
- (none yet)

## Open Follow-ups
- (none yet)
`;

interface PersistenceServiceDependencies {
  config: SwarmConfig;
  descriptors: Map<string, AgentDescriptor>;
  sortedDescriptors: () => AgentDescriptor[];
  getConfiguredManagerId: () => string | undefined;
  resolveMemoryOwnerAgentId: (descriptor: AgentDescriptor) => string;
  validateAgentDescriptor: (value: unknown) => AgentDescriptor | string;
  extractDescriptorAgentId: (value: unknown) => string | undefined;
  logDebug: (message: string, details?: unknown) => void;
}

export class PersistenceService {
  constructor(private readonly deps: PersistenceServiceDependencies) {}

  async ensureDirectories(): Promise<void> {
    const dirs = [
      this.deps.config.paths.dataDir,
      this.deps.config.paths.swarmDir,
      this.deps.config.paths.sessionsDir,
      this.deps.config.paths.uploadsDir,
      this.deps.config.paths.authDir,
      this.deps.config.paths.memoryDir,
      this.deps.config.paths.agentDir,
      this.deps.config.paths.managerAgentDir
    ];

    for (const dir of dirs) {
      await mkdir(dir, { recursive: true });
    }
  }

  async ensureMemoryFilesForBoot(): Promise<void> {
    const memoryAgentIds = new Set<string>();
    const configuredManagerId = this.deps.getConfiguredManagerId();
    if (configuredManagerId) {
      memoryAgentIds.add(configuredManagerId);
    }

    for (const descriptor of this.deps.descriptors.values()) {
      memoryAgentIds.add(descriptor.agentId);
      if (descriptor.role === "worker") {
        memoryAgentIds.add(this.deps.resolveMemoryOwnerAgentId(descriptor));
      }
    }

    for (const agentId of memoryAgentIds) {
      await this.ensureAgentMemoryFile(agentId);
    }
  }

  async ensureAgentMemoryFile(agentId: string): Promise<void> {
    const memoryFilePath = this.getAgentMemoryPath(agentId);

    try {
      await readFile(memoryFilePath, "utf8");
      return;
    } catch (error) {
      if (!isEnoentError(error)) {
        throw error;
      }
    }

    await mkdir(dirname(memoryFilePath), { recursive: true });
    await writeFile(memoryFilePath, DEFAULT_MEMORY_FILE_CONTENT, "utf8");
  }

  async deleteManagerSessionFile(sessionFile: string): Promise<void> {
    try {
      await unlink(sessionFile);
    } catch (error) {
      if (isEnoentError(error)) {
        return;
      }
      throw error;
    }
  }

  async deleteManagerSchedulesFile(managerId: string): Promise<void> {
    const schedulesFile = getScheduleFilePath(this.deps.config.paths.dataDir, managerId);

    try {
      await unlink(schedulesFile);
    } catch (error) {
      if (isEnoentError(error)) {
        return;
      }
      throw error;
    }
  }

  async loadStore(): Promise<AgentsStoreFile> {
    try {
      const raw = await readFile(this.deps.config.paths.agentsStoreFile, "utf8");
      const parsed = JSON.parse(raw) as AgentsStoreFile;
      if (!Array.isArray(parsed.agents)) {
        return { agents: [] };
      }

      const validAgents: AgentDescriptor[] = [];
      for (const [index, candidate] of parsed.agents.entries()) {
        const validated = this.deps.validateAgentDescriptor(candidate);
        if (typeof validated === "string") {
          const maybeAgentId = this.deps.extractDescriptorAgentId(candidate);
          const descriptorHint = maybeAgentId ? `agentId=${maybeAgentId}` : `index=${index}`;
          console.warn(
            `[swarm] Skipping invalid descriptor (${descriptorHint}) in ${this.deps.config.paths.agentsStoreFile}: ${validated}`
          );
          continue;
        }

        validAgents.push(validated);
      }

      return {
        agents: validAgents
      };
    } catch {
      return { agents: [] };
    }
  }

  async saveStore(): Promise<void> {
    const payload: AgentsStoreFile = {
      agents: this.deps.sortedDescriptors()
    };

    const target = this.deps.config.paths.agentsStoreFile;
    const tmp = `${target}.tmp`;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(tmp, target);
  }

  private getAgentMemoryPath(agentId: string): string {
    return getAgentMemoryPathForDataDir(this.deps.config.paths.dataDir, agentId);
  }
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
