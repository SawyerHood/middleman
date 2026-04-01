import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createCore } from "swarmd";
import { createConfig } from "../config.js";
import { SwarmManager } from "../swarm/swarm-manager.js";
import {
  MIDDLEMAN_STORE_MIGRATIONS,
  MiddlemanAgentRepo,
  MiddlemanManagerOrderRepo,
} from "../swarm/swarm-sql.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const BOOTSTRAP_MANAGER_ID = "__bootstrap_manager__";

describe("SwarmManager bootstrap transcript", () => {
  it("returns empty history when the bootstrap manager session does not exist yet", async () => {
    const dataDir = await mkdtemp(resolve(tmpdir(), "middleman-swarm-bootstrap-"));
    const swarmManager = new SwarmManager(
      createConfig({
        installDir: REPO_ROOT,
        projectRoot: REPO_ROOT,
        dataDir,
      }),
    );

    try {
      await swarmManager.boot();

      expect(swarmManager.getVisibleTranscript(BOOTSTRAP_MANAGER_ID)).toEqual([]);
    } finally {
      await swarmManager.shutdown();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("rehydrates persisted agents and history without restarting runtimes", async () => {
    const dataDir = await mkdtemp(resolve(tmpdir(), "middleman-swarm-restore-"));
    const dbPath = resolve(dataDir, "swarmd.db");
    const seededCore = await createCore(
      {
        dataDir,
        dbPath,
      },
      {
        migrations: MIDDLEMAN_STORE_MIGRATIONS,
        runRecovery: false,
      },
    );

    const agentRepo = new MiddlemanAgentRepo(seededCore.db);
    const managerOrderRepo = new MiddlemanManagerOrderRepo(seededCore.db);
    seededCore.sessionService.create({
      id: "manager-1",
      backend: "codex",
      cwd: REPO_ROOT,
      model: "gpt-5.4",
      displayName: "Manager 1",
      systemPrompt: "manager prompt",
    });
    seededCore.sessionService.create({
      id: "worker-1",
      backend: "codex",
      cwd: REPO_ROOT,
      model: "gpt-5.4",
      displayName: "Worker 1",
      systemPrompt: "worker prompt",
    });
    seededCore.sessionService.applyRuntimeStatus("manager-1", "idle");
    seededCore.sessionService.applyRuntimeStatus("worker-1", "busy", undefined, {
      tokens: 48_000,
      contextWindow: 200_000,
      percent: 24,
    });

    agentRepo.create({
      sessionId: "manager-1",
      role: "manager",
      managerSessionId: "manager-1",
      archetypeId: "manager",
      memoryOwnerSessionId: "manager-1",
    });
    agentRepo.create({
      sessionId: "worker-1",
      role: "worker",
      managerSessionId: "manager-1",
      memoryOwnerSessionId: "manager-1",
    });
    managerOrderRepo.ensure(["manager-1"]);

    seededCore.messageStore.append("manager-1", {
      source: "user",
      kind: "text",
      role: "user",
      content: {
        text: "hello manager",
        parts: [{ type: "text", text: "hello manager" }],
      },
      metadata: {
        middleman: {
          version: 1,
          agentId: "manager-1",
          managerId: "manager-1",
          renderAs: "conversation_message",
          source: "user_input",
        },
      },
    });
    seededCore.messageStore.append("manager-1", {
      source: "assistant",
      kind: "text",
      role: "assistant",
      content: {
        text: "welcome back",
      },
      metadata: {
        middleman: {
          version: 1,
          agentId: "manager-1",
          managerId: "manager-1",
        },
      },
    });
    seededCore.messageStore.append("worker-1", {
      source: "user",
      kind: "text",
      role: "user",
      content: {
        text: "finish the task",
        parts: [{ type: "text", text: "finish the task" }],
      },
      metadata: {
        middleman: {
          version: 1,
          agentId: "worker-1",
          managerId: "manager-1",
          renderAs: "conversation_message",
          source: "user_input",
        },
      },
    });
    seededCore.messageStore.append("worker-1", {
      source: "assistant",
      kind: "text",
      role: "assistant",
      content: {
        text: "already on it",
      },
      metadata: {
        middleman: {
          version: 1,
          agentId: "worker-1",
          managerId: "manager-1",
        },
      },
    });

    await seededCore.shutdown();

    const swarmManager = new SwarmManager(
      createConfig({
        installDir: REPO_ROOT,
        projectRoot: REPO_ROOT,
        dataDir,
      }),
    );

    try {
      await swarmManager.boot();

      expect(swarmManager.listAgents()).toEqual([
        expect.objectContaining({
          agentId: "manager-1",
          role: "manager",
          managerId: "manager-1",
          status: "stopped",
        }),
        expect.objectContaining({
          agentId: "worker-1",
          role: "worker",
          managerId: "manager-1",
          status: "stopped",
          contextUsage: {
            tokens: 48_000,
            contextWindow: 200_000,
            percent: 24,
          },
        }),
      ]);
      expect(
        swarmManager
          .getVisibleTranscript("manager-1")
          .map((entry) => (entry.type === "conversation_message" ? entry.text : "")),
      ).toEqual(["hello manager", "welcome back"]);
      expect(
        swarmManager
          .getVisibleTranscript("worker-1")
          .map((entry) => (entry.type === "conversation_message" ? entry.text : "")),
      ).toEqual(["finish the task", "already on it"]);
    } finally {
      await swarmManager.shutdown();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
