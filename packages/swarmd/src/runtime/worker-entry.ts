#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import type {
  HostCallRequest,
  SessionErrorInfo,
  SessionRuntimeConfig,
  WorkerCommand,
} from "../core/types/index.js";
import { WorkerProtocolClient } from "../core/supervisor/worker-protocol.js";
import type { AdapterCallbacks, BackendAdapter, HostRpcClient } from "./common/adapter.js";
import { createClaudeBackendAdapter } from "./claude/index.js";
import { createCodexBackendAdapter } from "./codex/index.js";
import { hasMockRuntimeConfig, ScriptedBackendAdapter } from "./common/scripted-backend-adapter.js";
import { PiBackendAdapter } from "./pi/index.js";

function toSessionErrorInfo(error: unknown): SessionErrorInfo {
  if (error && typeof error === "object" && "message" in error) {
    const message = String((error as { message: unknown }).message);
    return {
      code: "BACKEND_ERROR",
      message,
      retryable: false,
    };
  }

  return {
    code: "BACKEND_ERROR",
    message: String(error),
    retryable: false,
  };
}

async function main(): Promise<void> {
  const client = new WorkerProtocolClient();
  let adapter: BackendAdapter | null = null;
  const pendingHostCalls = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  const hostRpc: HostRpcClient = {
    callTool(toolName, args) {
      const requestId = randomUUID();

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingHostCalls.delete(requestId);
          reject(new Error(`Timed out waiting for host tool call ${toolName}.`));
        }, 30_000);
        timeout.unref?.();

        pendingHostCalls.set(requestId, {
          resolve,
          reject,
          timeout,
        });

        client.send({
          type: "host_call",
          requestId,
          method: "tool_call",
          payload: {
            toolName,
            args,
          },
        } satisfies HostCallRequest & { type: "host_call" });
      });
    },
  };

  const callbacks: AdapterCallbacks = {
    emitEvent: (event) => {
      client.send({
        type: "normalized_event",
        event: {
          ...event,
          cursor: null,
        },
      });
    },
    emitStatusChange: (status, error, contextUsage) => {
      client.send({
        type: "session_status",
        status,
        ...(error ? { error } : {}),
        ...(contextUsage !== undefined ? { contextUsage } : {}),
      });
    },
    emitCheckpoint: (checkpoint) => {
      client.send({
        type: "checkpoint",
        checkpoint,
      });
    },
    emitBackendState: (state) => {
      client.send({
        type: "backend_state",
        state,
      });
    },
    log: (level, message, details) => {
      const suffix = details === undefined ? "" : ` ${JSON.stringify(details)}`;
      process.stderr.write(`[worker:${level}] ${message}${suffix}\n`);
    },
  };

  async function withAdapter<T>(
    cmd: WorkerCommand,
    run: (activeAdapter: BackendAdapter) => Promise<T>,
  ): Promise<void> {
    if (adapter === null) {
      if ("operationId" in cmd) {
        client.send({
          type: "command_result",
          operationId: cmd.operationId,
          ok: false,
          error: {
            code: "NOT_READY",
            message: "Worker has not completed bootstrap.",
            retryable: false,
          },
        });
      }
      return;
    }

    try {
      const payload = await run(adapter);
      if ("operationId" in cmd) {
        client.send({
          type: "command_result",
          operationId: cmd.operationId,
          ok: true,
          ...(payload === undefined ? {} : { payload }),
        });
      }
    } catch (error) {
      if ("operationId" in cmd) {
        client.send({
          type: "command_result",
          operationId: cmd.operationId,
          ok: false,
          error: toSessionErrorInfo(error),
        });
      } else {
        throw error;
      }
    }
  }

  client.onCommand(async (cmd) => {
    switch (cmd.type) {
      case "ping":
        client.send({ type: "pong" });
        break;
      case "bootstrap": {
        let nextAdapter: BackendAdapter | null = null;

        try {
          nextAdapter = createBackendAdapter(cmd, callbacks, hostRpc);
          const runtimeConfig = attachSwarmEnvelopeConfig(cmd);
          const { checkpoint } = await nextAdapter.bootstrap(
            runtimeConfig,
            cmd.session.backendCheckpoint ?? undefined,
          );

          adapter = nextAdapter;
          client.send({
            type: "ready",
            capabilities: nextAdapter.capabilities,
            ...(checkpoint ? { checkpoint } : {}),
          });
        } catch (error) {
          const sessionError = toSessionErrorInfo(error);
          await nextAdapter?.terminate().catch(() => undefined);
          client.send({
            type: "fatal_error",
            error: sessionError,
          });
          callbacks.log("error", "Worker bootstrap failed.", sessionError);
          process.exit(1);
        }
        break;
      }
      case "send_input":
        await withAdapter(cmd, async (activeAdapter) =>
          activeAdapter.sendInput(cmd.input, cmd.delivery),
        );
        break;
      case "interrupt":
        await withAdapter(cmd, async (activeAdapter) => {
          await activeAdapter.interrupt();
          return undefined;
        });
        break;
      case "host_call_result": {
        const pending = pendingHostCalls.get(cmd.requestId);
        if (!pending) {
          break;
        }

        clearTimeout(pending.timeout);
        pendingHostCalls.delete(cmd.requestId);

        if (cmd.ok) {
          pending.resolve(cmd.payload);
          break;
        }

        pending.reject(new Error(cmd.error?.message ?? "Unknown host call failure."));
        break;
      }
      case "stop":
        if (adapter !== null) {
          await adapter.stop();
        }
        process.exit(0);
        break;
      case "terminate":
        if (adapter !== null) {
          await adapter.terminate();
        }
        process.exit(0);
        break;
    }
  });
}

function createBackendAdapter(
  cmd: Extract<WorkerCommand, { type: "bootstrap" }>,
  callbacks: AdapterCallbacks,
  hostRpc: HostRpcClient,
): BackendAdapter {
  if (hasMockRuntimeConfig(cmd.config.backendConfig)) {
    return new ScriptedBackendAdapter(cmd.config.backend, callbacks, { hostRpc });
  }

  switch (cmd.config.backend) {
    case "codex":
      return createCodexBackendAdapter(callbacks, { hostRpc });
    case "claude":
      return createClaudeBackendAdapter(callbacks, { hostRpc });
    case "pi":
      return new PiBackendAdapter(callbacks, {
        sessionId: cmd.session.id,
        threadId: null,
        hostRpc,
      });
  }
}

function attachSwarmEnvelopeConfig(
  cmd: Extract<WorkerCommand, { type: "bootstrap" }>,
): SessionRuntimeConfig {
  return {
    ...cmd.config,
    backendConfig: {
      ...cmd.config.backendConfig,
      swarmdSessionId: cmd.session.id,
    },
  };
}

main().catch((err: unknown) => {
  console.error("Worker fatal:", err);
  process.exit(1);
});
