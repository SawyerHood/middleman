import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionRuntimeConfig, UserInput } from "../src/index.js";
import { createCodexBackendAdapter } from "../src/index.js";
import {
  CodexJsonRpcClient,
  decodeJsonRpcMessage,
  encodeJsonRpcMessage,
  type CodexJsonRpcClientTransport,
} from "../src/runtime/codex/codex-jsonrpc-client.js";
import { mapCodexNotificationToEvents } from "../src/runtime/codex/codex-mapper.js";

class FakeTransport extends EventEmitter implements CodexJsonRpcClientTransport {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    this.signalCode = typeof signal === "string" ? signal : null;
    queueMicrotask(() => {
      this.emit("exit", this.exitCode, this.signalCode);
    });
    return true;
  }
}

function collectLines(stream: PassThrough): { lines: string[] } {
  const lines: string[] = [];
  let buffer = "";

  stream.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      lines.push(buffer.slice(0, newlineIndex + 1));
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
  });

  return { lines };
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
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

function createAdapterCallbacks() {
  const statuses: string[] = [];
  return {
    statuses,
    callbacks: {
      emitEvent: vi.fn(),
      emitStatusChange(status: string) {
        statuses.push(status);
      },
      emitCheckpoint: vi.fn(),
      log: vi.fn(),
    },
  };
}

function createAdapterConfig(
  serverScript: string,
  backendConfigOverrides?: Record<string, unknown>,
): SessionRuntimeConfig {
  return {
    backend: "codex",
    cwd: process.cwd(),
    model: "gpt-5.4",
    systemPrompt: "You are Codex inside swarmd.",
    backendConfig: {
      sessionId: "ses_codex_adapter_test",
      command: "node",
      args: ["-e", serverScript],
      requestTimeoutMs: 1_000,
      ...(backendConfigOverrides ?? {}),
    },
  };
}

function createUserInput(text: string): UserInput {
  return {
    id: "input-1",
    role: "user",
    parts: [
      {
        type: "text",
        text,
      },
    ],
  };
}

function createPendingTurnInterruptServerScript(): string {
  return String.raw`
const readline = require("node:readline");

const threadId = "thr_interrupt_edge";
let turnId = null;

const reader = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function sendResult(id, result) {
  send({ id, result });
}

function notify(method, params) {
  send({ method, params });
}

reader.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  const message = JSON.parse(trimmed);
  const { id, method } = message;

  switch (method) {
    case "initialize":
      sendResult(id, {});
      return;
    case "initialized":
      return;
    case "thread/start":
      sendResult(id, {
        thread: {
          id: threadId,
          status: { type: "idle" },
          turns: [],
        },
      });
      notify("thread/started", {
        thread: {
          id: threadId,
          status: { type: "idle" },
        },
      });
      return;
    case "turn/start":
      turnId = "turn-edge-1";
      sendResult(id, {
        turn: {},
      });
      setTimeout(() => {
        notify("turn/started", {
          threadId,
          turn: { id: turnId, status: "inProgress" },
        });
      }, 20);
      return;
    case "turn/interrupt":
      sendResult(id, {});
      setTimeout(() => {
        notify("turn/completed", {
          threadId,
          turn: { id: turnId, status: "completed" },
        });
      }, 5);
      setTimeout(() => {
        notify("thread/status/changed", {
          threadId,
          status: { type: "idle" },
        });
      }, 10);
      return;
    default:
      sendResult(id, {});
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});
`;
}

describe("codex mapper", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("maps core Codex notifications to normalized backend events", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-13T18:00:00.000Z"));

    const sessionId = "ses_codex_mapper";
    const threadId = "thr_backend_1";

    const turnStarted = mapCodexNotificationToEvents(
      {
        method: "turn/started",
        params: {
          threadId,
          turn: { id: "turn-1", status: "inProgress" },
        },
      },
      { sessionId },
    );

    const messageStarted = mapCodexNotificationToEvents(
      {
        method: "item/started",
        params: {
          threadId,
          turnId: "turn-1",
          item: { type: "agentMessage", id: "msg-1", text: "", phase: null },
        },
      },
      { sessionId },
    );

    const messageDelta = mapCodexNotificationToEvents(
      {
        method: "item/agentMessage/delta",
        params: {
          threadId,
          turnId: "turn-1",
          itemId: "msg-1",
          delta: "Hello",
        },
      },
      { sessionId },
    );

    const toolCompleted = mapCodexNotificationToEvents(
      {
        method: "item/completed",
        params: {
          threadId,
          turnId: "turn-1",
          item: {
            type: "dynamicToolCall",
            id: "tool-1",
            tool: "search",
            arguments: { query: "swarmd" },
            status: "completed",
            success: true,
            contentItems: [{ type: "output_text", text: "done" }],
            durationMs: 18,
          },
        },
      },
      { sessionId },
    );

    const statusChanged = mapCodexNotificationToEvents(
      {
        method: "thread/status/changed",
        params: {
          threadId,
          status: { type: "active", activeFlags: [] },
        },
      },
      { sessionId, previousStatus: "idle" },
    );

    expect(turnStarted).toEqual([
      {
        id: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
        sessionId,
        threadId,
        timestamp: "2026-03-13T18:00:00.000Z",
        source: "backend",
        type: "turn.started",
        payload: { turnId: "turn-1", status: "inProgress" },
      },
    ]);

    expect(messageStarted).toEqual([
      {
        id: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
        sessionId,
        threadId,
        timestamp: "2026-03-13T18:00:00.000Z",
        source: "backend",
        type: "message.started",
        payload: { messageId: "msg-1", role: "assistant", turnId: "turn-1", phase: null },
      },
    ]);

    expect(messageDelta).toEqual([
      {
        id: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
        sessionId,
        threadId,
        timestamp: "2026-03-13T18:00:00.000Z",
        source: "backend",
        type: "message.delta",
        payload: { messageId: "msg-1", delta: "Hello", turnId: "turn-1" },
      },
    ]);

    expect(toolCompleted).toEqual([
      {
        id: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
        sessionId,
        threadId,
        timestamp: "2026-03-13T18:00:00.000Z",
        source: "backend",
        type: "tool.completed",
        payload: {
          toolName: "dynamic:search",
          ok: true,
          toolCallId: "tool-1",
          result: {
            status: "completed",
            success: true,
            contentItems: [{ type: "output_text", text: "done" }],
            durationMs: 18,
          },
          turnId: "turn-1",
          itemType: "dynamicToolCall",
          status: "completed",
        },
      },
    ]);

    expect(statusChanged).toEqual([
      {
        id: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
        sessionId,
        threadId,
        timestamp: "2026-03-13T18:00:00.000Z",
        source: "backend",
        type: "session.status.changed",
        payload: {
          status: "busy",
          previousStatus: "idle",
          rawStatus: { type: "active", activeFlags: [] },
        },
      },
    ]);
  });

  it("maps streaming tool progress with tracked tool names", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-13T18:05:00.000Z"));

    expect(
      mapCodexNotificationToEvents(
        {
          method: "item/commandExecution/outputDelta",
          params: {
            threadId: "thr_progress",
            turnId: "turn-progress",
            itemId: "cmd-1",
            delta: "npm test\n",
          },
        },
        {
          sessionId: "ses_progress",
          toolNameByItemId: new Map([["cmd-1", "command_execution"]]),
        },
      ),
    ).toEqual([
      {
        id: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
        sessionId: "ses_progress",
        threadId: "thr_progress",
        timestamp: "2026-03-13T18:05:00.000Z",
        source: "backend",
        type: "tool.progress",
        payload: {
          toolName: "command_execution",
          progress: {
            delta: "npm test\n",
            raw: {
              threadId: "thr_progress",
              turnId: "turn-progress",
              itemId: "cmd-1",
              delta: "npm test\n",
            },
          },
          toolCallId: "cmd-1",
          turnId: "turn-progress",
        },
      },
    ]);
  });

  it("preserves dynamic tool call details for replayable host tool results", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-13T18:06:00.000Z"));

    const events = mapCodexNotificationToEvents(
      {
        method: "item/completed",
        params: {
          threadId: "thr_details",
          turnId: "turn-details",
          item: {
            type: "dynamicToolCall",
            id: "tool-speak",
            tool: "speak_to_user",
            status: "completed",
            success: true,
            contentItems: [{ type: "output_text", text: "Published message to user (web)." }],
            details: {
              text: "Hello from replay",
              targetContext: {
                channel: "web",
              },
            },
          },
        },
      },
      { sessionId: "ses_details" },
    );

    expect(events).toEqual([
      {
        id: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
        sessionId: "ses_details",
        threadId: "thr_details",
        timestamp: "2026-03-13T18:06:00.000Z",
        source: "backend",
        type: "tool.completed",
        payload: {
          toolName: "dynamic:speak_to_user",
          toolCallId: "tool-speak",
          ok: true,
          result: {
            status: "completed",
            success: true,
            contentItems: [{ type: "output_text", text: "Published message to user (web)." }],
            details: {
              text: "Hello from replay",
              targetContext: {
                channel: "web",
              },
            },
            durationMs: undefined,
          },
          turnId: "turn-details",
          itemType: "dynamicToolCall",
          status: "completed",
        },
      },
    ]);
  });
});

describe("codex JSON-RPC client", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("encodes and decodes JSON-RPC messages", () => {
    expect(
      encodeJsonRpcMessage({
        id: 7,
        method: "turn/start",
        params: { threadId: "thr_1" },
      }),
    ).toBe('{"id":7,"method":"turn/start","params":{"threadId":"thr_1"}}\n');

    expect(
      decodeJsonRpcMessage('{"id":7,"method":"turn/start","params":{"threadId":"thr_1"}}\n'),
    ).toEqual({
      id: 7,
      method: "turn/start",
      params: { threadId: "thr_1" },
    });

    expect(decodeJsonRpcMessage('{"id":7,"result":{"ok":true}}\n')).toEqual({
      id: 7,
      result: { ok: true },
    });
  });

  it("writes initialize plus initialized and resolves request responses over the transport", async () => {
    const transport = new FakeTransport();
    const writes = collectLines(transport.stdin);
    const client = new CodexJsonRpcClient({
      command: "codex",
      transport,
    });

    const initializePromise = client.initialize({
      clientInfo: {
        name: "swarmd",
        title: "swarmd",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });

    await waitForCondition(() => writes.lines.length === 1);
    expect(decodeJsonRpcMessage(writes.lines[0]!)).toEqual({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "swarmd",
          title: "swarmd",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: true,
        },
      },
    });

    transport.stdout.write(encodeJsonRpcMessage({ id: 1, result: {} }));
    await initializePromise;

    await waitForCondition(() => writes.lines.length === 2);
    expect(decodeJsonRpcMessage(writes.lines[1]!)).toEqual({
      method: "initialized",
    });

    const turnPromise = client.sendRequest<{ turn: { id: string } }>("turn/start", {
      threadId: "thr_1",
    });

    await waitForCondition(() => writes.lines.length === 3);
    expect(decodeJsonRpcMessage(writes.lines[2]!)).toEqual({
      id: 2,
      method: "turn/start",
      params: { threadId: "thr_1" },
    });

    transport.stdout.write(
      encodeJsonRpcMessage({
        id: 2,
        result: {
          turn: { id: "turn-1" },
        },
      }),
    );

    await expect(turnPromise).resolves.toEqual({
      turn: { id: "turn-1" },
    });

    client.dispose();
  });
});

describe("CodexBackendAdapter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits raw notifications only when experimentalRawEvents is enabled", async () => {
    const callbacks = createAdapterCallbacks();
    const adapter = createCodexBackendAdapter(callbacks.callbacks);

    await adapter.bootstrap(
      createAdapterConfig(createPendingTurnInterruptServerScript(), {
        experimentalRawEvents: true,
      }),
    );

    await waitForCondition(() => callbacks.callbacks.emitEvent.mock.calls.length > 0);
    const eventTypes = callbacks.callbacks.emitEvent.mock.calls.map(
      ([event]) => (event as { type: string }).type,
    );

    expect(eventTypes).toContain("backend.raw");

    await adapter.stop();
  });

  it("interrupts a turn that has been requested but has not reported turn/started yet", async () => {
    const callbacks = createAdapterCallbacks();
    const adapter = createCodexBackendAdapter(callbacks.callbacks);

    await adapter.bootstrap(createAdapterConfig(createPendingTurnInterruptServerScript()));
    await adapter.sendInput(createUserInput("Please stop this turn."), "auto");
    await adapter.interrupt();

    await waitForCondition(() => callbacks.statuses.includes("interrupting"));
    await waitForCondition(() => callbacks.statuses.at(-1) === "idle");

    expect(callbacks.statuses).toContain("busy");
    expect(callbacks.statuses).toContain("interrupting");

    await adapter.stop();
  });
});
