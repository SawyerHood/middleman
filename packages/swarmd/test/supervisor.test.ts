import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { RuntimeSupervisor } from "../src/core/supervisor/runtime-supervisor.js";
import { WorkerProtocolHost } from "../src/core/supervisor/worker-protocol.js";
import type {
  BackendCapabilities,
  SessionRuntimeConfig,
  SessionRecord,
  WorkerEvent,
} from "../src/core/types/index.js";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const compiledWorkerEntryPath = resolve(repoRoot, "dist/runtime/worker-entry.js");
const fakeCodexAppServerPath = resolve(repoRoot, "test/fixtures/fake-codex-app-server.mjs");
const tscBinPath = require.resolve("typescript/bin/tsc");
const expectedCapabilities: BackendCapabilities = {
  canResumeThread: true,
  canForkThread: true,
  canInterrupt: true,
  canQueueInput: true,
  canManualCompact: true,
  canReadHistory: true,
  emitsToolProgress: true,
  exposesRawEvents: true,
};

function buildRuntimeWorker(): void {
  const result = spawnSync(process.execPath, [tscBinPath], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "TypeScript build failed.");
  }

  if (!existsSync(compiledWorkerEntryPath)) {
    throw new Error(`Compiled worker entry was not found at ${compiledWorkerEntryPath}.`);
  }
}

function createSessionRecord(id = "session-supervisor-test"): SessionRecord {
  return {
    id,
    backend: "codex",
    status: "created",
    displayName: "Supervisor Test Session",
    cwd: repoRoot,
    model: "gpt-5",
    systemPrompt: "You are swarmd.",
    metadata: {},
    backendCheckpoint: null,
    createdAt: "2026-03-13T00:00:00.000Z",
    updatedAt: "2026-03-13T00:00:00.000Z",
    lastError: null,
    contextUsage: null,
  };
}

function createMockRuntimeConfig(sessionId: string, responseText: string): SessionRuntimeConfig {
  return {
    backend: "codex",
    cwd: repoRoot,
    model: "gpt-5",
    systemPrompt: "You are swarmd.",
    backendConfig: {
      mockRuntime: {
        fixture: {
          sessions: {
            [sessionId]: {
              turns: [
                {
                  match: { index: 1 },
                  steps: [
                    { type: "status", status: "busy" },
                    {
                      type: "message_stream",
                      chunks: [responseText],
                    },
                    { type: "status", status: "idle" },
                  ],
                },
              ],
            },
          },
        },
      },
    },
  };
}

function createRuntimeConfig(): SessionRuntimeConfig {
  return {
    backend: "codex",
    cwd: repoRoot,
    model: "gpt-5",
    systemPrompt: "You are swarmd.",
    backendConfig: {
      command: process.execPath,
      args: [fakeCodexAppServerPath],
    },
  };
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  if (hasExited(child)) {
    return Promise.resolve({
      code: child.exitCode,
      signal: child.signalCode,
    });
  }

  return new Promise((resolve) => {
    const onExit = (code: number | null, signal: string | null) => {
      child.off("error", onError);
      resolve({ code, signal });
    };
    const onError = () => {
      child.off("exit", onExit);
      resolve({
        code: child.exitCode,
        signal: child.signalCode,
      });
    };

    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (hasExited(child)) {
    return;
  }

  const exitPromise = waitForExit(child);
  child.kill("SIGTERM");

  const terminated = await Promise.race([
    exitPromise.then(() => true),
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 500);
      timer.unref?.();
    }),
  ]);

  if (!terminated && !hasExited(child)) {
    child.kill("SIGKILL");
  }

  await exitPromise;
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 0);
      timer.unref?.();
    });
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition.`);
}

function createEventController(protocol: WorkerProtocolHost): {
  events: WorkerEvent[];
  waitForEvent: (
    predicate: (event: WorkerEvent) => boolean,
    timeoutMs?: number,
  ) => Promise<WorkerEvent>;
} {
  const events: WorkerEvent[] = [];
  const waiters = new Set<{
    predicate: (event: WorkerEvent) => boolean;
    resolve: (event: WorkerEvent) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  protocol.onEvent((event) => {
    events.push(event);

    for (const waiter of [...waiters]) {
      if (!waiter.predicate(event)) {
        continue;
      }

      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(event);
    }
  });

  return {
    events,
    waitForEvent: (predicate, timeoutMs = 3_000) => {
      const matchedEvent = events.find(predicate);
      if (matchedEvent) {
        return Promise.resolve(matchedEvent);
      }

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`Timed out waiting for worker event after ${timeoutMs}ms.`));
        }, timeoutMs);
        timer.unref?.();

        const waiter = {
          predicate,
          resolve,
          reject,
          timer,
        };
        waiters.add(waiter);
      });
    },
  };
}

function spawnCompiledWorker() {
  const child = spawn(process.execPath, [compiledWorkerEntryPath], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("Compiled worker process is missing piped stdio.");
  }

  const protocol = new WorkerProtocolHost(child.stdin, child.stdout);
  return {
    child,
    protocol,
    ...createEventController(protocol),
  };
}

describe("RuntimeSupervisor", () => {
  const childProcesses: ChildProcess[] = [];
  const supervisors: RuntimeSupervisor[] = [];

  beforeAll(() => {
    buildRuntimeWorker();
  });

  afterEach(async () => {
    await Promise.all(
      supervisors.splice(0).map((supervisor) =>
        supervisor.shutdownAll().catch(() => {
          // Best-effort cleanup for tests.
        }),
      ),
    );

    await Promise.all(
      childProcesses.splice(0).map((child) =>
        terminateChild(child).catch(() => {
          // Best-effort cleanup for tests.
        }),
      ),
    );
  });

  it("speaks ping/pong and bootstraps a compiled Codex worker over the JSONL protocol", async () => {
    const session = createSessionRecord("session-protocol-test");
    const config = createRuntimeConfig();
    const { child, protocol, waitForEvent } = spawnCompiledWorker();
    childProcesses.push(child);

    protocol.send({ type: "ping" });
    await expect(waitForEvent((event) => event.type === "pong")).resolves.toEqual({ type: "pong" });

    protocol.send({ type: "bootstrap", session, config });
    await expect(waitForEvent((event) => event.type === "ready")).resolves.toMatchObject({
      type: "ready",
      capabilities: expectedCapabilities,
      checkpoint: {
        backend: "codex",
        threadId: "thr_fake_1",
      },
    });
  });

  it("routes send_input through the supervisor and emits normalized Codex events for the session", async () => {
    const session = createSessionRecord("session-runtime-supervisor-test");
    const config = createRuntimeConfig();
    const workerEvents: WorkerEvent[] = [];
    const workerExits: Array<{ sessionId: string; code: number | null; signal: string | null }> =
      [];
    const workerErrors: Error[] = [];
    const supervisor = new RuntimeSupervisor(
      {
        onWorkerEvent: (_sessionId, event) => {
          workerEvents.push(event);
        },
        onWorkerExit: (sessionId, code, signal) => {
          workerExits.push({ sessionId, code, signal });
        },
        onWorkerError: (_sessionId, error) => {
          workerErrors.push(error);
        },
      },
      {
        heartbeatIntervalMs: 1_000,
        heartbeatTimeoutMs: 1_000,
      },
    );
    supervisors.push(supervisor);

    const handle = await supervisor.spawnWorker(session, config);

    expect(handle.capabilities).toEqual(expectedCapabilities);
    expect(supervisor.hasWorker(session.id)).toBe(true);

    supervisor.sendCommand(session.id, {
      type: "send_input",
      operationId: "operation-send-test",
      delivery: "auto",
      input: {
        id: "input-1",
        role: "user",
        parts: [{ type: "text", text: "say hello" }],
      },
    });

    await waitForCondition(() =>
      workerEvents.some(
        (event) =>
          event.type === "command_result" &&
          event.operationId === "operation-send-test" &&
          event.ok,
      ),
    );

    const commandResult = workerEvents.find(
      (event) =>
        event.type === "command_result" && event.operationId === "operation-send-test" && event.ok,
    );
    expect(commandResult).toMatchObject({
      type: "command_result",
      operationId: "operation-send-test",
      ok: true,
      payload: {
        acceptedDelivery: "auto",
        queued: false,
      },
    });

    await waitForCondition(() =>
      workerEvents.some(
        (event) =>
          event.type === "normalized_event" &&
          event.event.type === "message.completed" &&
          event.event.sessionId === session.id,
      ),
    );

    const completedEvent = workerEvents.find(
      (event) =>
        event.type === "normalized_event" &&
        event.event.type === "message.completed" &&
        event.event.sessionId === session.id,
    );
    expect(completedEvent).toMatchObject({
      type: "normalized_event",
      event: {
        sessionId: session.id,
        threadId: "thr_fake_1",
        type: "message.completed",
        payload: {
          text: "hello from fake codex",
        },
      },
    });

    expect(workerEvents).toContainEqual({
      type: "normalized_event",
      event: expect.objectContaining({
        sessionId: session.id,
        threadId: "thr_fake_1",
        type: "message.delta",
        payload: expect.objectContaining({
          delta: "hello from fake codex",
        }),
      }),
    });

    expect(workerEvents).toContainEqual({
      type: "normalized_event",
      event: expect.objectContaining({
        sessionId: session.id,
        threadId: "thr_fake_1",
        type: "session.status.changed",
      }),
    });

    await supervisor.stopWorker(session.id, "operation-stop-test", 50);

    expect(supervisor.hasWorker(session.id)).toBe(false);
    expect(workerErrors).toEqual([]);
    expect(workerExits).toHaveLength(1);
    expect(workerExits[0]?.sessionId).toBe(session.id);
    expect(hasExited(handle.process)).toBe(true);
  });

  it("selects the scripted mock adapter in worker-entry when backendConfig.mockRuntime is present", async () => {
    const session = createSessionRecord("session-mock-runtime-test");
    const config = createMockRuntimeConfig(session.id, "hello from scripted mock");
    const { child, protocol, waitForEvent } = spawnCompiledWorker();
    childProcesses.push(child);

    protocol.send({ type: "bootstrap", session, config });
    await expect(waitForEvent((event) => event.type === "ready")).resolves.toMatchObject({
      type: "ready",
      capabilities: expectedCapabilities,
      checkpoint: {
        backend: "codex",
        threadId: `thr_mock_${session.id}`,
      },
    });

    protocol.send({
      type: "send_input",
      operationId: "operation-mock-runtime",
      delivery: "auto",
      input: {
        id: "input-mock-runtime",
        role: "user",
        parts: [{ type: "text", text: "hello mock runtime" }],
      },
    });

    await expect(
      waitForEvent(
        (event) =>
          event.type === "normalized_event" &&
          event.event.type === "message.completed" &&
          event.event.sessionId === session.id,
      ),
    ).resolves.toMatchObject({
      type: "normalized_event",
      event: {
        sessionId: session.id,
        threadId: `thr_mock_${session.id}`,
        type: "message.completed",
        payload: {
          text: "hello from scripted mock",
        },
      },
    });
  });
});
