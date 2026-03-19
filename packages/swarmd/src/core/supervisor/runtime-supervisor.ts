import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  BackendCapabilities,
  HostCallRequest,
  SessionRuntimeConfig,
  SessionRecord,
  WorkerCommand,
  WorkerEvent,
} from "../types/index.js";
import { LineReader, WorkerProtocolHost } from "./worker-protocol.js";

const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 10_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_TERMINATE_TIMEOUT_MS = 5_000;

function resolveWorkerEntryPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(currentDir, "../../runtime/worker-entry.js"),
    resolve(currentDir, "../../../dist/runtime/worker-entry.js"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Unable to locate compiled worker entry. Checked: ${candidates.join(", ")}. Run "npx tsc" first.`,
  );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function formatExitReason(code: number | null, signal: string | null): string {
  if (signal) {
    return `signal ${signal}`;
  }

  if (code !== null) {
    return `exit code ${code}`;
  }

  return "unknown reason";
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export interface WorkerHandle {
  sessionId: string;
  pid: number;
  capabilities: BackendCapabilities | null;
  protocol: WorkerProtocolHost;
  process: ChildProcess;
}

export interface SupervisorCallbacks {
  onWorkerEvent: (sessionId: string, event: WorkerEvent) => void;
  onWorkerExit: (sessionId: string, code: number | null, signal: string | null) => void;
  onWorkerError: (sessionId: string, error: Error) => void;
  onHostCall?: (sessionId: string, request: HostCallRequest) => Promise<unknown>;
}

export class RuntimeSupervisor {
  private workers = new Map<string, WorkerHandle>();
  private callbacks: SupervisorCallbacks;
  private heartbeatIntervalMs: number;
  private heartbeatTimeoutMs: number;
  private heartbeatTimers = new Map<string, NodeJS.Timeout>();
  private heartbeatTimeouts = new Map<string, NodeJS.Timeout>();
  private awaitingHeartbeat = new Set<string>();

  constructor(
    callbacks: SupervisorCallbacks,
    options?: {
      heartbeatIntervalMs?: number;
      heartbeatTimeoutMs?: number;
    },
  ) {
    this.callbacks = callbacks;
    this.heartbeatIntervalMs = options?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimeoutMs = options?.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  }

  async spawnWorker(session: SessionRecord, config: SessionRuntimeConfig): Promise<WorkerHandle> {
    if (this.workers.has(session.id)) {
      throw new Error(`Worker already running for session ${session.id}.`);
    }

    const workerEntryPath = resolveWorkerEntryPath();
    const child = spawn(process.execPath, [workerEntryPath], {
      cwd: session.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new Error(`Worker process for session ${session.id} is missing piped stdio.`);
    }

    const protocol = new WorkerProtocolHost(child.stdin, child.stdout);
    const handle: WorkerHandle = {
      sessionId: session.id,
      pid: child.pid ?? -1,
      capabilities: null,
      protocol,
      process: child,
    };

    this.workers.set(session.id, handle);
    this.pipeStderr(session.id, child.stderr);

    let settleReady: ((error?: Error) => void) | null = null;
    const readyPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `Worker ${session.id} did not emit a ready event within ${DEFAULT_BOOTSTRAP_TIMEOUT_MS}ms.`,
          ),
        );
      }, DEFAULT_BOOTSTRAP_TIMEOUT_MS);
      timeout.unref?.();

      settleReady = (error?: Error) => {
        clearTimeout(timeout);
        if (error) {
          reject(error);
          return;
        }

        resolve();
      };
    });

    let readyHandled = false;
    const resolveReady = (error?: Error) => {
      if (readyHandled) {
        return;
      }

      readyHandled = true;
      settleReady?.(error);
    };

    protocol.onEvent((event) => {
      if (event.type === "pong") {
        this.acknowledgeHeartbeat(session.id);
        return;
      }

      if (event.type === "fatal_error") {
        const workerError = new Error(event.error.message);
        if (!readyHandled) {
          resolveReady(workerError);
          return;
        }

        this.callbacks.onWorkerError(session.id, workerError);
        return;
      }

      if (event.type === "host_call") {
        void this.handleHostCall(session.id, handle, event);
        return;
      }

      if (event.type === "ready") {
        handle.capabilities = event.capabilities;
        resolveReady();
      }

      this.callbacks.onWorkerEvent(session.id, event);
    });

    child.once("error", (error) => {
      const workerError = toError(error);
      resolveReady(workerError);

      if (child.pid === undefined) {
        this.cleanupWorker(session.id);
      }

      this.callbacks.onWorkerError(session.id, workerError);
    });

    child.once("exit", (code, signal) => {
      if (!readyHandled) {
        resolveReady(
          new Error(
            `Worker ${session.id} exited before ready with ${formatExitReason(code, signal)}.`,
          ),
        );
      }

      this.cleanupWorker(session.id);
      this.callbacks.onWorkerExit(session.id, code, signal);
    });

    try {
      protocol.send({
        type: "bootstrap",
        session,
        config,
      });
      await readyPromise;
    } catch (error) {
      if (this.workers.has(session.id)) {
        await this.terminateWorker(session.id, `bootstrap-${Date.now()}`);
      }

      throw toError(error);
    }

    this.startHeartbeat(session.id);
    return handle;
  }

  sendCommand(sessionId: string, cmd: WorkerCommand): void {
    const handle = this.workers.get(sessionId);
    if (!handle) {
      throw new Error(`No worker is running for session ${sessionId}.`);
    }

    handle.protocol.send(cmd);
  }

  async stopWorker(
    sessionId: string,
    operationId: string,
    timeoutMs = DEFAULT_STOP_TIMEOUT_MS,
  ): Promise<void> {
    const handle = this.workers.get(sessionId);
    if (!handle) {
      return;
    }

    this.stopHeartbeat(sessionId);
    const exitPromise = waitForExit(handle.process);

    try {
      handle.protocol.send({ type: "stop", operationId });
    } catch (error) {
      this.callbacks.onWorkerError(sessionId, toError(error));
    }

    const stopped = await Promise.race([
      exitPromise.then(() => true),
      delay(timeoutMs).then(() => false),
    ]);

    if (!stopped) {
      await this.terminateWorker(sessionId, operationId);
      return;
    }

    await exitPromise;
  }

  async terminateWorker(sessionId: string, operationId: string): Promise<void> {
    const handle = this.workers.get(sessionId);
    if (!handle) {
      return;
    }

    this.stopHeartbeat(sessionId);
    const exitPromise = waitForExit(handle.process);

    try {
      handle.protocol.send({ type: "terminate", operationId });
    } catch {
      // Process signaling below is the real termination path.
    }

    if (!hasExited(handle.process)) {
      handle.process.kill("SIGTERM");
    }

    const terminated = await Promise.race([
      exitPromise.then(() => true),
      delay(DEFAULT_TERMINATE_TIMEOUT_MS).then(() => false),
    ]);

    if (!terminated && !hasExited(handle.process)) {
      handle.process.kill("SIGKILL");
    }

    await exitPromise;
  }

  getWorker(sessionId: string): WorkerHandle | undefined {
    return this.workers.get(sessionId);
  }

  hasWorker(sessionId: string): boolean {
    return this.workers.has(sessionId);
  }

  getActiveSessionIds(): string[] {
    return [...this.workers.keys()];
  }

  async shutdownAll(): Promise<void> {
    const sessionIds = this.getActiveSessionIds();
    const results = await Promise.allSettled(
      sessionIds.map((sessionId, index) =>
        this.stopWorker(sessionId, `shutdown-${Date.now()}-${index}`),
      ),
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);

    if (failures.length > 0) {
      throw new AggregateError(failures, "Failed to shut down one or more workers.");
    }
  }

  private startHeartbeat(sessionId: string): void {
    this.stopHeartbeat(sessionId);

    const timer = setInterval(() => {
      const handle = this.workers.get(sessionId);
      if (!handle) {
        this.stopHeartbeat(sessionId);
        return;
      }

      if (this.awaitingHeartbeat.has(sessionId)) {
        return;
      }

      try {
        handle.protocol.send({ type: "ping" });
      } catch (error) {
        this.callbacks.onWorkerError(sessionId, toError(error));
        void this.terminateWorker(sessionId, `heartbeat-send-${Date.now()}`).catch(
          (terminateError) => {
            this.callbacks.onWorkerError(sessionId, toError(terminateError));
          },
        );
        return;
      }

      this.awaitingHeartbeat.add(sessionId);
      const timeout = setTimeout(() => {
        this.handleHeartbeatTimeout(sessionId);
      }, this.heartbeatTimeoutMs);
      timeout.unref?.();
      this.heartbeatTimeouts.set(sessionId, timeout);
    }, this.heartbeatIntervalMs);
    timer.unref?.();

    this.heartbeatTimers.set(sessionId, timer);
  }

  private stopHeartbeat(sessionId: string): void {
    const timer = this.heartbeatTimers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this.heartbeatTimers.delete(sessionId);
    }

    const timeout = this.heartbeatTimeouts.get(sessionId);
    if (timeout) {
      clearTimeout(timeout);
      this.heartbeatTimeouts.delete(sessionId);
    }

    this.awaitingHeartbeat.delete(sessionId);
  }

  private handleHeartbeatTimeout(sessionId: string): void {
    if (!this.workers.has(sessionId)) {
      this.stopHeartbeat(sessionId);
      return;
    }

    this.stopHeartbeat(sessionId);
    this.callbacks.onWorkerError(
      sessionId,
      new Error(`Heartbeat timed out for worker ${sessionId}.`),
    );
    void this.terminateWorker(sessionId, `heartbeat-timeout-${Date.now()}`).catch((error) => {
      this.callbacks.onWorkerError(sessionId, toError(error));
    });
  }

  private acknowledgeHeartbeat(sessionId: string): void {
    const timeout = this.heartbeatTimeouts.get(sessionId);
    if (timeout) {
      clearTimeout(timeout);
      this.heartbeatTimeouts.delete(sessionId);
    }

    this.awaitingHeartbeat.delete(sessionId);
  }

  private cleanupWorker(sessionId: string): void {
    const handle = this.workers.get(sessionId);
    if (!handle) {
      return;
    }

    this.stopHeartbeat(sessionId);
    handle.protocol.close();
    this.workers.delete(sessionId);
  }

  private pipeStderr(sessionId: string, stream: NodeJS.ReadableStream): void {
    const reader = new LineReader(stream);

    void (async () => {
      try {
        for await (const line of reader) {
          if (line.length > 0) {
            console.debug(`[worker:${sessionId}:stderr] ${line}`);
          }
        }
      } catch (error) {
        console.debug(`[worker:${sessionId}:stderr] ${toError(error).message}`);
      }
    })();
  }

  private async handleHostCall(
    sessionId: string,
    handle: WorkerHandle,
    request: HostCallRequest,
  ): Promise<void> {
    if (!this.callbacks.onHostCall) {
      handle.protocol.send({
        type: "host_call_result",
        requestId: request.requestId,
        ok: false,
        error: {
          code: "HOST_CALL_UNSUPPORTED",
          message: `No host call handler registered for ${request.method}.`,
          retryable: false,
        },
      });
      return;
    }

    try {
      const payload = await this.callbacks.onHostCall(sessionId, request);
      handle.protocol.send({
        type: "host_call_result",
        requestId: request.requestId,
        ok: true,
        ...(payload === undefined ? {} : { payload }),
      });
    } catch (error) {
      handle.protocol.send({
        type: "host_call_result",
        requestId: request.requestId,
        ok: false,
        error: {
          code: "HOST_CALL_FAILED",
          message: toError(error).message,
          retryable: false,
        },
      });
    }
  }
}
