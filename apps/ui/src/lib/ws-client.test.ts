import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManagerWsClient, WS_CLIENT_BUILD_HASH } from "./ws-client";
import type { AgentDescriptor } from "@middleman/protocol";

const TEST_BUILD_HASH = WS_CLIENT_BUILD_HASH;

type ListenerMap = Record<string, Array<(event?: any) => void>>;

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly sentPayloads: string[] = [];
  readonly listeners: ListenerMap = {};

  readyState = FakeWebSocket.OPEN;

  constructor(_url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event?: any) => void): void {
    this.listeners[type] ??= [];
    this.listeners[type].push(listener);
  }

  send(payload: string): void {
    this.sentPayloads.push(payload);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close");
  }

  emit(type: string, event?: any): void {
    const handlers = this.listeners[type] ?? [];
    for (const handler of handlers) {
      handler(event);
    }
  }
}

function emitServerEvent(socket: FakeWebSocket, event: unknown): void {
  socket.emit("message", {
    data: JSON.stringify(event),
  });
}

function managerDescriptor(
  agentId: string,
  createdAt: string,
): AgentDescriptor {
  return {
    agentId,
    managerId: agentId,
    displayName: agentId,
    role: "manager",
    status: "idle",
    createdAt,
    updatedAt: createdAt,
    cwd: "/tmp",
    model: {
      provider: "openai-codex",
      modelId: "gpt-5.3-codex",
      thinkingLevel: "medium",
    },
  };
}

describe("ManagerWsClient", () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalWindow = (globalThis as any).window;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.useFakeTimers();
    (globalThis as any).window = {};
    (globalThis as any).WebSocket = FakeWebSocket;
  });

  afterEach(() => {
    vi.useRealTimers();
    (globalThis as any).WebSocket = originalWebSocket;
    (globalThis as any).window = originalWindow;
  });

  it("subscribes on connect and sends user_message commands to the active agent", () => {
    const client = new ManagerWsClient("ws://127.0.0.1:8787", "manager");

    const snapshots: ReturnType<typeof client.getState>[] = [];
    client.subscribe((state) => {
      snapshots.push(state);
    });

    client.start();
    vi.advanceTimersByTime(60);

    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();

    socket.emit("open");
    expect(socket.sentPayloads).toHaveLength(1);
    expect(JSON.parse(socket.sentPayloads[0])).toEqual({
      type: "subscribe",
      agentId: "manager",
    });

    emitServerEvent(socket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      buildHash: TEST_BUILD_HASH,
      subscribedAgentId: "manager",
    });

    client.sendUserMessage("hello manager");

    expect(JSON.parse(socket.sentPayloads[1])).toEqual({
      type: "user_message",
      text: "hello manager",
      agentId: "manager",
    });

    emitServerEvent(socket, {
      type: "conversation_message",
      agentId: "manager",
      role: "assistant",
      text: "hello from manager",
      timestamp: new Date().toISOString(),
      source: "speak_to_user",
    });

    const latestMessage = snapshots.at(-1)?.messages.at(-1);
    expect(latestMessage?.type).toBe("conversation_message");
    if (latestMessage?.type === "conversation_message") {
      expect(latestMessage.text).toBe("hello from manager");
    }

    client.destroy();
  });

  it("subscribes without forcing manager id when no initial target is provided", () => {
    const client = new ManagerWsClient("ws://127.0.0.1:8787");

    client.start();
    vi.advanceTimersByTime(60);

    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();

    socket.emit("open");
    expect(socket.sentPayloads).toHaveLength(1);
    expect(JSON.parse(socket.sentPayloads[0])).toEqual({ type: "subscribe" });

    emitServerEvent(socket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      buildHash: TEST_BUILD_HASH,
      subscribedAgentId: "release-manager",
    });

    expect(client.getState().targetAgentId).toBe("release-manager");
    expect(client.getState().subscribedAgentId).toBe("release-manager");

    client.destroy();
  });

  it("does not reload after reconnect when the backend build matches", () => {
    const reload = vi.fn();
    (globalThis as any).window = {
      location: {
        reload,
      },
    };

    const client = new ManagerWsClient("ws://127.0.0.1:8787", "manager");

    client.start();
    vi.advanceTimersByTime(60);

    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();

    socket.emit("open");
    expect(reload).not.toHaveBeenCalled();

    socket.close();
    vi.advanceTimersByTime(1200);

    const reconnectedSocket = FakeWebSocket.instances[1];
    expect(reconnectedSocket).toBeDefined();

    reconnectedSocket.emit("open");
    expect(reload).not.toHaveBeenCalled();

    emitServerEvent(reconnectedSocket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      buildHash: TEST_BUILD_HASH,
      subscribedAgentId: "manager",
    });

    expect(reload).not.toHaveBeenCalled();

    client.destroy();
  });

  it("reloads after reconnect when the backend build hash changes", () => {
    const reload = vi.fn();
    (globalThis as any).window = {
      location: {
        reload,
      },
    };

    const client = new ManagerWsClient("ws://127.0.0.1:8787", "manager");

    client.start();
    vi.advanceTimersByTime(60);

    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();

    socket.emit("open");

    emitServerEvent(socket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      buildHash: TEST_BUILD_HASH,
      subscribedAgentId: "manager",
    });

    socket.close();
    vi.advanceTimersByTime(1200);

    const reconnectedSocket = FakeWebSocket.instances[1];
    expect(reconnectedSocket).toBeDefined();

    reconnectedSocket.emit("open");
    expect(reload).not.toHaveBeenCalled();

    emitServerEvent(reconnectedSocket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      buildHash: "different-build",
      subscribedAgentId: "manager",
    });

    expect(reload).toHaveBeenCalledTimes(1);

    client.destroy();
  });

  it("sends attachment-only user messages when images are provided", () => {
    const client = new ManagerWsClient("ws://127.0.0.1:8787", "manager");

    client.start();
    vi.advanceTimersByTime(60);

    const socket = FakeWebSocket.instances[0];
    socket.emit("open");

    emitServerEvent(socket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      buildHash: TEST_BUILD_HASH,
      subscribedAgentId: "manager",
    });

    client.sendUserMessage("", {
      attachments: [
        {
          mimeType: "image/png",
          data: "aGVsbG8=",
          fileName: "diagram.png",
        },
      ],
    });

    expect(JSON.parse(socket.sentPayloads.at(-1) ?? "")).toEqual({
      type: "user_message",
      text: "",
      attachments: [
        {
          mimeType: "image/png",
          data: "aGVsbG8=",
          fileName: "diagram.png",
        },
      ],
      agentId: "manager",
    });

    client.destroy();
  });

  it("sends text and binary attachments in user messages", () => {
    const client = new ManagerWsClient("ws://127.0.0.1:8787", "manager");

    client.start();
    vi.advanceTimersByTime(60);

    const socket = FakeWebSocket.instances[0];
    socket.emit("open");

    emitServerEvent(socket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      buildHash: TEST_BUILD_HASH,
      subscribedAgentId: "manager",
    });

    client.sendUserMessage("", {
      attachments: [
        {
          type: "text",
          mimeType: "text/markdown",
          text: "# Notes",
          fileName: "notes.md",
        },
        {
          type: "binary",
          mimeType: "application/pdf",
          data: "aGVsbG8=",
          fileName: "design.pdf",
        },
      ],
    });

    expect(JSON.parse(socket.sentPayloads.at(-1) ?? "")).toEqual({
      type: "user_message",
      text: "",
      attachments: [
        {
          type: "text",
          mimeType: "text/markdown",
          text: "# Notes",
          fileName: "notes.md",
        },
        {
          type: "binary",
          mimeType: "application/pdf",
          data: "aGVsbG8=",
          fileName: "design.pdf",
        },
      ],
      agentId: "manager",
    });

    client.destroy();
  });

  it("can switch subscriptions and route outgoing/incoming messages by selected agent", () => {
    const client = new ManagerWsClient("ws://127.0.0.1:8787", "manager");
    const snapshots: ReturnType<typeof client.getState>[] = [];

    client.subscribe((state) => {
      snapshots.push(state);
    });

    client.start();
    vi.advanceTimersByTime(60);

    const socket = FakeWebSocket.instances[0];
    socket.emit("open");

    emitServerEvent(socket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      buildHash: TEST_BUILD_HASH,
      subscribedAgentId: "manager",
    });

    client.subscribeToAgent("worker-1");

    expect(JSON.parse(socket.sentPayloads.at(-1) ?? "")).toEqual({
      type: "subscribe",
      agentId: "worker-1",
    });

    emitServerEvent(socket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      buildHash: TEST_BUILD_HASH,
      subscribedAgentId: "worker-1",
    });

    emitServerEvent(socket, {
      type: "conversation_history",
      agentId: "worker-1",
      messages: [],
    });

    client.sendUserMessage("hello worker");

    expect(JSON.parse(socket.sentPayloads.at(-1) ?? "")).toEqual({
      type: "user_message",
      text: "hello worker",
      agentId: "worker-1",
    });

    emitServerEvent(socket, {
      type: "conversation_message",
      agentId: "manager",
      role: "assistant",
      text: "manager output",
      timestamp: new Date().toISOString(),
      source: "speak_to_user",
    });

    expect(
      snapshots
        .at(-1)
        ?.messages.some(
          (message) =>
            message.type === "conversation_message" &&
            message.text === "manager output",
        ),
    ).toBe(false);

    emitServerEvent(socket, {
      type: "conversation_message",
      agentId: "worker-1",
      role: "assistant",
      text: "worker output",
      timestamp: new Date().toISOString(),
      source: "system",
    });

    const latestWorkerMessage = snapshots.at(-1)?.messages.at(-1);
    expect(latestWorkerMessage?.type).toBe("conversation_message");
    if (latestWorkerMessage?.type === "conversation_message") {
      expect(latestWorkerMessage.text).toBe("worker output");
    }
    expect(snapshots.at(-1)?.targetAgentId).toBe("worker-1");
    expect(snapshots.at(-1)?.subscribedAgentId).toBe("worker-1");

    client.destroy();
  });

  it("marks history as loading until replacement history arrives for a switched agent", () => {
    const client = new ManagerWsClient("ws://127.0.0.1:8787", "manager");

    const snapshots: ReturnType<typeof client.getState>[] = [];
    client.subscribe((state) => {
      snapshots.push(state);
    });

    client.start();
    vi.advanceTimersByTime(60);

    const socket = FakeWebSocket.instances[0];
    socket.emit("open");

    emitServerEvent(socket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      buildHash: TEST_BUILD_HASH,
      subscribedAgentId: "manager",
    });

    emitServerEvent(socket, {
      type: "conversation_history",
      agentId: "manager",
      mode: "replace",
      messages: [
        {
          type: "conversation_message",
          agentId: "manager",
          role: "assistant",
          text: "hello manager",
          timestamp: new Date().toISOString(),
          source: "speak_to_user",
        },
        {
          type: "agent_message",
          agentId: "manager",
          timestamp: new Date().toISOString(),
          source: "agent_to_agent",
          fromAgentId: "worker-2",
          toAgentId: "manager",
          text: "manager activity",
        },
      ],
      hasMore: true,
    });

    const loadedState = snapshots.at(-1);
    expect(loadedState?.messages).toHaveLength(1);
    expect(loadedState?.activityMessages).toHaveLength(1);
    expect(loadedState?.hasOlderHistory).toBe(true);
    expect(loadedState?.oldestHistoryCursor).not.toBeNull();

    client.subscribeToAgent("worker-1");

    const switchingState = snapshots.at(-1);
    expect(switchingState?.targetAgentId).toBe("worker-1");
    expect(switchingState?.messages).toEqual(loadedState?.messages ?? []);
    expect(switchingState?.activityMessages).toEqual(
      loadedState?.activityMessages ?? [],
    );
    expect(switchingState?.oldestHistoryCursor).toBeNull();
    expect(switchingState?.hasOlderHistory).toBe(false);
    expect(switchingState?.isLoadingHistory).toBe(true);

    emitServerEvent(socket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      buildHash: TEST_BUILD_HASH,
      subscribedAgentId: "worker-1",
    });

    expect(snapshots.at(-1)?.isLoadingHistory).toBe(true);

    emitServerEvent(socket, {
      type: "conversation_history",
      agentId: "worker-1",
      mode: "replace",
      messages: [],
    });

    expect(snapshots.at(-1)?.isLoadingHistory).toBe(false);

    client.destroy();
  });

  it("subscribes and unsubscribes agent detail streams for worker views", () => {
    const client = new ManagerWsClient("ws://127.0.0.1:8787", "manager");

    client.start();
    vi.advanceTimersByTime(60);

    const socket = FakeWebSocket.instances[0];
    socket.emit("open");

    emitServerEvent(socket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      buildHash: TEST_BUILD_HASH,
      subscribedAgentId: "worker-1",
    });

    client.subscribeToAgentDetail("worker-1");

    expect(JSON.parse(socket.sentPayloads.at(-1) ?? "")).toEqual({
      type: "subscribe_agent_detail",
      agentId: "worker-1",
    });

    emitServerEvent(socket, {
      type: "conversation_history",
      agentId: "worker-1",
      messages: [
        {
          type: "conversation_message",
          agentId: "worker-1",
          role: "assistant",
          text: "worker response",
          timestamp: new Date().toISOString(),
          source: "system",
        },
        {
          type: "conversation_log",
          agentId: "worker-1",
          timestamp: new Date().toISOString(),
          source: "runtime_log",
          kind: "message_end",
          text: "Missing authentication for openai-codex. Configure credentials in Settings.",
          isError: true,
        },
        {
          type: "agent_message",
          agentId: "worker-1",
          timestamp: new Date().toISOString(),
          source: "agent_to_agent",
          fromAgentId: "manager",
          toAgentId: "worker-1",
          text: "worker instruction",
        },
        {
          type: "agent_tool_call",
          agentId: "worker-1",
          actorAgentId: "worker-1",
          timestamp: new Date().toISOString(),
          kind: "tool_execution_update",
          toolName: "bash",
          toolCallId: "detail-tool",
          text: '{"ok":true}',
        },
      ],
    });

    const state = client.getState();
    expect(state.messages.map((entry) => entry.type)).toEqual([
      "conversation_message",
      "conversation_log",
    ]);
    expect(state.activityMessages.map((entry) => entry.type)).toEqual([
      "agent_message",
      "agent_tool_call",
    ]);
    expect(state.lastError).toBe(
      "Missing authentication for openai-codex. Configure credentials in Settings.",
    );

    client.unsubscribeFromAgentDetail();
    expect(JSON.parse(socket.sentPayloads.at(-1) ?? "")).toEqual({
      type: "unsubscribe_agent_detail",
      agentId: "worker-1",
    });

    client.destroy();
  });

  it("requests and prepends older history without replacing the current transcript", () => {
    const client = new ManagerWsClient("ws://127.0.0.1:8787", "manager");

    client.start();
    vi.advanceTimersByTime(60);

    const socket = FakeWebSocket.instances[0];
    socket.emit("open");

    emitServerEvent(socket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      buildHash: TEST_BUILD_HASH,
      subscribedAgentId: "manager",
    });

    emitServerEvent(socket, {
      type: "conversation_history",
      agentId: "manager",
      mode: "replace",
      hasMore: true,
      messages: [
        {
          type: "conversation_message",
          agentId: "manager",
          role: "assistant",
          text: "newer",
          timestamp: "2026-03-14T00:00:02.000Z",
          historyCursor: "2026-03-14T00:00:02.000Z|manager|message-2",
          source: "speak_to_user",
        },
      ],
    });

    client.loadOlderHistory("manager");

    expect(JSON.parse(socket.sentPayloads.at(-1) ?? "")).toEqual({
      type: "load_older_history",
      agentId: "manager",
      before: "2026-03-14T00:00:02.000Z|manager|message-2",
    });
    expect(client.getState().isLoadingOlderHistory).toBe(true);

    emitServerEvent(socket, {
      type: "conversation_history",
      agentId: "manager",
      mode: "prepend",
      hasMore: false,
      messages: [
        {
          type: "conversation_message",
          agentId: "manager",
          role: "user",
          text: "older",
          timestamp: "2026-03-14T00:00:01.000Z",
          historyCursor: "2026-03-14T00:00:01.000Z|manager|message-1",
          source: "user_input",
        },
      ],
    });

    expect(client.getState().messages.map((entry) => entry.text)).toEqual([
      "older",
      "newer",
    ]);
    expect(client.getState().oldestHistoryCursor).toBe(
      "2026-03-14T00:00:01.000Z|manager|message-1",
    );
    expect(client.getState().hasOlderHistory).toBe(false);
    expect(client.getState().isLoadingOlderHistory).toBe(false);

    client.destroy();
  });

  it("re-subscribes active worker detail streams after reconnect", () => {
    const reload = vi.fn();
    (globalThis as any).window = {
      location: {
        reload,
      },
    };

    const client = new ManagerWsClient("ws://127.0.0.1:8787", "manager");

    client.start();
    vi.advanceTimersByTime(60);

    const socket = FakeWebSocket.instances[0];
    socket.emit("open");

    emitServerEvent(socket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      buildHash: TEST_BUILD_HASH,
      subscribedAgentId: "worker-1",
    });

    client.subscribeToAgentDetail("worker-1");
    socket.close();

    vi.advanceTimersByTime(1200);
    const reconnectedSocket = FakeWebSocket.instances[1];
    expect(reconnectedSocket).toBeDefined();

    reconnectedSocket.emit("open");

    const reconnectPayloads = reconnectedSocket.sentPayloads.map((payload) =>
      JSON.parse(payload),
    );
    expect(reconnectPayloads).toEqual([
      { type: "subscribe", agentId: "manager" },
      { type: "subscribe_agent_detail", agentId: "worker-1" },
    ]);

    client.destroy();
  });

  it("preserves conversation messages when history includes many tool-call events", () => {
    const client = new ManagerWsClient("ws://127.0.0.1:8787", "history-manager");

    client.start();
    vi.advanceTimersByTime(60);

    const socket = FakeWebSocket.instances[0];
    socket.emit("open");

    emitServerEvent(socket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      buildHash: TEST_BUILD_HASH,
      subscribedAgentId: "history-manager",
    });

    const baseTime = Date.now();
    const conversationMessages = Array.from({ length: 120 }, (_, index) => ({
      type: "conversation_message" as const,
      agentId: "history-manager",
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `message-${index}`,
      timestamp: new Date(baseTime + index).toISOString(),
      source:
        index % 2 === 0 ? ("user_input" as const) : ("speak_to_user" as const),
    }));

    const toolMessages = Array.from({ length: 480 }, (_, index) => ({
      type: "agent_tool_call" as const,
      agentId: "history-manager",
      actorAgentId: "history-worker",
      timestamp: new Date(baseTime + 120 + index).toISOString(),
      kind: "tool_execution_update" as const,
      toolName: "bash",
      toolCallId: `call-${index}`,
      text: '{"ok":true}',
    }));

    emitServerEvent(socket, {
      type: "conversation_history",
      agentId: "history-manager",
      messages: [...conversationMessages, ...toolMessages],
    });

    const state = client.getState();
    expect(state.messages).toHaveLength(120);
    expect(state.activityMessages).toHaveLength(480);
    expect(
      state.messages.filter(
        (message) => message.type === "conversation_message",
      ),
    ).toHaveLength(120);

    client.destroy();
  });

  it("stores conversation_log events for the selected agent and ignores other threads", () => {
    const client = new ManagerWsClient("ws://127.0.0.1:8787", "manager");

    client.start();
    vi.advanceTimersByTime(60);

    const socket = FakeWebSocket.instances[0];
    socket.emit("open");

    emitServerEvent(socket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      buildHash: TEST_BUILD_HASH,
      subscribedAgentId: "worker-1",
    });

    emitServerEvent(socket, {
      type: "conversation_log",
      agentId: "manager",
      timestamp: new Date().toISOString(),
      source: "runtime_log",
      kind: "tool_execution_start",
      toolName: "read",
      toolCallId: "call-1",
      text: '{"path":"README.md"}',
    });

    expect(client.getState().messages).toHaveLength(0);
    expect(client.getState().activityMessages).toHaveLength(0);

    emitServerEvent(socket, {
      type: "conversation_log",
      agentId: "worker-1",
      timestamp: new Date().toISOString(),
      source: "runtime_log",
      kind: "tool_execution_end",
      toolName: "read",
      toolCallId: "call-1",
      text: '{"ok":true}',
      isError: false,
    });

    const lastMessage = client.getState().messages.at(-1);
    expect(lastMessage?.type).toBe("conversation_log");
    if (lastMessage?.type === "conversation_log") {
      expect(lastMessage.kind).toBe("tool_execution_end");
      expect(lastMessage.toolName).toBe("read");
    }
    expect(client.getState().lastError).toBeNull();

    emitServerEvent(socket, {
      type: "conversation_log",
      agentId: "worker-1",
      timestamp: new Date().toISOString(),
      source: "runtime_log",
      kind: "message_end",
      text: "Missing authentication for openai-codex. Configure credentials in Settings.",
      isError: true,
    });

    expect(client.getState().lastError).toBe(
      "Missing authentication for openai-codex. Configure credentials in Settings.",
    );

    client.destroy();
  });

  it("clears stale lastError when history shows later successful output", () => {
    const client = new ManagerWsClient("ws://127.0.0.1:8787", "manager");

    client.start();
    vi.advanceTimersByTime(60);

    const socket = FakeWebSocket.instances[0];
    socket.emit("open");

    emitServerEvent(socket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      buildHash: TEST_BUILD_HASH,
      subscribedAgentId: "worker-1",
    });

    emitServerEvent(socket, {
      type: "conversation_history",
      agentId: "worker-1",
      messages: [
        {
          type: "conversation_log",
          agentId: "worker-1",
          timestamp: new Date(Date.now() - 1_000).toISOString(),
          source: "runtime_log",
          kind: "message_end",
          text: "Worker exited with code null, signal SIGINT",
          isError: true,
        },
        {
          type: "conversation_message",
          agentId: "worker-1",
          role: "assistant",
          text: "Recovered and completed the task.",
          timestamp: new Date().toISOString(),
          source: "system",
        },
      ],
    });

    expect(client.getState().lastError).toBeNull();

    client.destroy();
  });

  it("clears lastError after the selected agent starts working again", () => {
    const client = new ManagerWsClient("ws://127.0.0.1:8787", "manager");

    client.start();
    vi.advanceTimersByTime(60);

    const socket = FakeWebSocket.instances[0];
    socket.emit("open");

    emitServerEvent(socket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      buildHash: TEST_BUILD_HASH,
      subscribedAgentId: "worker-1",
    });

    emitServerEvent(socket, {
      type: "conversation_log",
      agentId: "worker-1",
      timestamp: new Date().toISOString(),
      source: "runtime_log",
      kind: "message_end",
      text: "Worker exited with code null, signal SIGINT",
      isError: true,
    });

    expect(client.getState().lastError).toBe(
      "Worker exited with code null, signal SIGINT",
    );

    emitServerEvent(socket, {
      type: "agent_status",
      agentId: "worker-1",
      status: "busy",
      pendingCount: 0,
    });

    expect(client.getState().lastError).toBeNull();

    client.destroy();
  });

  it("batches buffered websocket events into a single listener notification per frame", () => {
    const client = new ManagerWsClient("ws://127.0.0.1:8787", "manager");
    const snapshots: ReturnType<typeof client.getState>[] = [];
    const pendingFrameCallbacks = new Map<number, FrameRequestCallback>();
    let nextFrameHandle = 1;
    (globalThis as any).window.requestAnimationFrame = (
      callback: FrameRequestCallback,
    ) => {
      const handle = nextFrameHandle++;
      pendingFrameCallbacks.set(handle, callback);
      return handle;
    };
    (globalThis as any).window.cancelAnimationFrame = (handle: number) => {
      pendingFrameCallbacks.delete(handle);
    };

    client.subscribe((state) => {
      snapshots.push(state);
    });

    client.start();
    vi.advanceTimersByTime(60);

    const socket = FakeWebSocket.instances[0];
    socket.emit("open");

    emitServerEvent(socket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      buildHash: TEST_BUILD_HASH,
      subscribedAgentId: "manager",
    });

    const snapshotsAfterReady = snapshots.length;
    const contextUsage = {
      tokens: 12_000,
      contextWindow: 200_000,
      percent: 6,
    };

    emitServerEvent(socket, {
      type: "agents_snapshot",
      agents: [managerDescriptor("manager", "2026-01-01T00:00:00.000Z")],
    });
    emitServerEvent(socket, {
      type: "agent_status",
      agentId: "manager",
      status: "busy",
      pendingCount: 2,
      contextUsage,
    });
    emitServerEvent(socket, {
      type: "conversation_message",
      agentId: "manager",
      role: "assistant",
      text: "batched update",
      timestamp: new Date().toISOString(),
      source: "speak_to_user",
    });

    expect(client.getState().hasReceivedAgentsSnapshot).toBe(false);
    expect(snapshots).toHaveLength(snapshotsAfterReady);
    expect(pendingFrameCallbacks.size).toBe(1);

    const frameCallbacks = [...pendingFrameCallbacks.values()];
    pendingFrameCallbacks.clear();
    for (const callback of frameCallbacks) {
      callback(16);
    }

    expect(snapshots).toHaveLength(snapshotsAfterReady + 1);
    expect(client.getState().hasReceivedAgentsSnapshot).toBe(true);
    expect(client.getState().messages.at(-1)).toMatchObject({
      type: "conversation_message",
      text: "batched update",
    });
    expect(client.getState().statuses.manager).toEqual({
      status: "busy",
      pendingCount: 2,
      contextUsage,
    });
    expect(client.getState().agents[0]).toMatchObject({
      agentId: "manager",
      status: "busy",
      contextUsage,
    });

    client.destroy();
  });

  it("flushes buffered events before processing immediate conversation history", () => {
    const client = new ManagerWsClient("ws://127.0.0.1:8787", "manager");
    const pendingFrameCallbacks = new Map<number, FrameRequestCallback>();
    let nextFrameHandle = 1;
    (globalThis as any).window.requestAnimationFrame = (
      callback: FrameRequestCallback,
    ) => {
      const handle = nextFrameHandle++;
      pendingFrameCallbacks.set(handle, callback);
      return handle;
    };
    (globalThis as any).window.cancelAnimationFrame = (handle: number) => {
      pendingFrameCallbacks.delete(handle);
    };

    client.start();
    vi.advanceTimersByTime(60);

    const socket = FakeWebSocket.instances[0];
    socket.emit("open");

    emitServerEvent(socket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      buildHash: TEST_BUILD_HASH,
      subscribedAgentId: "manager",
    });

    emitServerEvent(socket, {
      type: "agents_snapshot",
      agents: [managerDescriptor("manager", "2026-01-01T00:00:00.000Z")],
    });

    expect(client.getState().hasReceivedAgentsSnapshot).toBe(false);
    expect(pendingFrameCallbacks.size).toBe(1);

    emitServerEvent(socket, {
      type: "conversation_history",
      agentId: "manager",
      messages: [
        {
          type: "conversation_message",
          agentId: "manager",
          role: "assistant",
          text: "history",
          timestamp: new Date().toISOString(),
          source: "speak_to_user",
        },
      ],
    });

    expect(client.getState().hasReceivedAgentsSnapshot).toBe(true);
    expect(client.getState().messages).toHaveLength(1);
    expect(pendingFrameCallbacks.size).toBe(0);

    client.destroy();
  });

  it("stores agent activity events for the selected agent and ignores other threads", () => {
    const client = new ManagerWsClient("ws://127.0.0.1:8787", "manager");

    client.start();
    vi.advanceTimersByTime(60);

    const socket = FakeWebSocket.instances[0];
    socket.emit("open");

    emitServerEvent(socket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      buildHash: TEST_BUILD_HASH,
      subscribedAgentId: "manager",
    });

    emitServerEvent(socket, {
      type: "agent_message",
      agentId: "other-manager",
      timestamp: new Date().toISOString(),
      source: "agent_to_agent",
      fromAgentId: "worker-a",
      toAgentId: "worker-b",
      text: "ignore me",
      requestedDelivery: "auto",
      acceptedMode: "steer",
    });

    expect(client.getState().messages).toHaveLength(0);

    emitServerEvent(socket, {
      type: "agent_message",
      agentId: "manager",
      timestamp: new Date().toISOString(),
      source: "agent_to_agent",
      fromAgentId: "manager",
      toAgentId: "worker-1",
      text: "run this task",
      requestedDelivery: "auto",
      acceptedMode: "steer",
    });

    emitServerEvent(socket, {
      type: "agent_tool_call",
      agentId: "manager",
      actorAgentId: "worker-1",
      timestamp: new Date().toISOString(),
      kind: "tool_execution_start",
      toolName: "read",
      toolCallId: "call-2",
      text: '{"path":"README.md"}',
    });

    const activityMessages = client.getState().activityMessages;
    expect(activityMessages).toHaveLength(2);
    expect(activityMessages[0]?.type).toBe("agent_message");
    expect(activityMessages[1]?.type).toBe("agent_tool_call");

    client.destroy();
  });

  it("sends explicit followUp delivery when requested", () => {
    const client = new ManagerWsClient("ws://127.0.0.1:8787", "worker-1");

    client.start();
    vi.advanceTimersByTime(60);

    const socket = FakeWebSocket.instances[0];
    socket.emit("open");

    emitServerEvent(socket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      buildHash: TEST_BUILD_HASH,
      subscribedAgentId: "worker-1",
    });

    client.sendUserMessage("queued update", {
      agentId: "worker-1",
      delivery: "followUp",
    });

    expect(JSON.parse(socket.sentPayloads.at(-1) ?? "")).toEqual({
      type: "user_message",
      text: "queued update",
      agentId: "worker-1",
      delivery: "followUp",
    });

    client.destroy();
  });

  it("sends kill_agent command when deleting a sub-agent", () => {
    const client = new ManagerWsClient("ws://127.0.0.1:8787", "manager");

    client.start();
    vi.advanceTimersByTime(60);

    const socket = FakeWebSocket.instances[0];
    socket.emit("open");

    emitServerEvent(socket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      buildHash: TEST_BUILD_HASH,
      subscribedAgentId: "manager",
    });

    client.deleteAgent("worker-2");

    expect(JSON.parse(socket.sentPayloads.at(-1) ?? "")).toEqual({
      type: "kill_agent",
      agentId: "worker-2",
    });

    client.destroy();
  });

  it("sends stop_all_agents and resolves from stop_all_agents_result event", async () => {
    const client = new ManagerWsClient("ws://127.0.0.1:8787", "manager");

    client.start();
    vi.advanceTimersByTime(60);

    const socket = FakeWebSocket.instances[0];
    socket.emit("open");

    emitServerEvent(socket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      buildHash: TEST_BUILD_HASH,
      subscribedAgentId: "manager",
    });

    const stopPromise = client.stopAllAgents("manager");
    const stopPayload = JSON.parse(socket.sentPayloads.at(-1) ?? "{}");

    expect(stopPayload).toMatchObject({
      type: "stop_all_agents",
      managerId: "manager",
    });
    expect(typeof stopPayload.requestId).toBe("string");

    emitServerEvent(socket, {
      type: "stop_all_agents_result",
      requestId: stopPayload.requestId,
      managerId: "manager",
      stoppedWorkerIds: ["worker-1", "worker-2"],
      managerStopped: true,
    });

    await expect(stopPromise).resolves.toEqual({
      managerId: "manager",
      stoppedWorkerIds: ["worker-1", "worker-2"],
      managerStopped: true,
    });

    client.destroy();
  });

  it("clears only the current thread messages on conversation_reset", () => {
    const client = new ManagerWsClient("ws://127.0.0.1:47187", "manager");
    const snapshots: ReturnType<typeof client.getState>[] = [];

    client.subscribe((state) => {
      snapshots.push(state);
    });

    client.start();
    vi.advanceTimersByTime(60);

    const socket = FakeWebSocket.instances[0];
    socket.emit("open");

    emitServerEvent(socket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      buildHash: TEST_BUILD_HASH,
      subscribedAgentId: "manager",
    });

    emitServerEvent(socket, {
      type: "agents_snapshot",
      agents: [
        {
          agentId: "manager",
          managerId: "manager",
          displayName: "Manager",
          role: "manager",
          status: "idle",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          cwd: "/tmp",
          model: {
            provider: "openai-codex",
            modelId: "gpt-5.3-codex",
            thinkingLevel: "xhigh",
          },
        },
      ],
    });

    emitServerEvent(socket, {
      type: "agent_status",
      agentId: "manager",
      status: "busy",
      pendingCount: 2,
    });

    emitServerEvent(socket, {
      type: "conversation_message",
      agentId: "manager",
      role: "assistant",
      text: "working...",
      timestamp: new Date().toISOString(),
      source: "speak_to_user",
    });

    emitServerEvent(socket, {
      type: "agent_tool_call",
      agentId: "manager",
      actorAgentId: "manager",
      timestamp: new Date().toISOString(),
      kind: "tool_execution_update",
      toolName: "read",
      toolCallId: "call-3",
      text: '{"ok":true}',
    });

    emitServerEvent(socket, {
      type: "error",
      code: "TEST_ERROR",
      message: "transient error",
    });

    const beforeReset = snapshots.at(-1);
    expect(beforeReset?.messages.length).toBeGreaterThan(0);
    expect(beforeReset?.activityMessages.length).toBeGreaterThan(0);
    expect(beforeReset?.agents.length).toBeGreaterThan(0);
    expect(Object.keys(beforeReset?.statuses ?? {})).toContain("manager");
    expect(beforeReset?.lastError).toBe("transient error");

    emitServerEvent(socket, {
      type: "conversation_reset",
      agentId: "manager",
      timestamp: new Date().toISOString(),
      reason: "user_new_command",
    });

    const afterReset = snapshots.at(-1);
    expect(afterReset?.connected).toBe(true);
    expect(afterReset?.subscribedAgentId).toBe("manager");
    expect(afterReset?.messages).toHaveLength(0);
    expect(afterReset?.activityMessages).toHaveLength(0);
    expect(afterReset?.agents).toHaveLength(1);
    expect(Object.keys(afterReset?.statuses ?? {})).toContain("manager");
    expect(afterReset?.lastError).toBeNull();

    client.destroy();
  });

  it("sends create_manager and resolves with manager_created event", async () => {
    const client = new ManagerWsClient("ws://127.0.0.1:8787", "manager");

    client.start();
    vi.advanceTimersByTime(60);

    const socket = FakeWebSocket.instances[0];
    socket.emit("open");

    emitServerEvent(socket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      buildHash: TEST_BUILD_HASH,
      subscribedAgentId: "manager",
    });

    const creationPromise = client.createManager({
      name: "release-manager",
      cwd: "/tmp/release",
      model: "pi-codex",
    });

    const sentCreatePayload = JSON.parse(socket.sentPayloads.at(-1) ?? "{}");
    expect(sentCreatePayload.type).toBe("create_manager");
    expect(sentCreatePayload.name).toBe("release-manager");
    expect(sentCreatePayload.cwd).toBe("/tmp/release");
    expect(sentCreatePayload.model).toBe("pi-codex");
    expect(typeof sentCreatePayload.requestId).toBe("string");

    emitServerEvent(socket, {
      type: "manager_created",
      requestId: sentCreatePayload.requestId,
      manager: {
        agentId: "release-manager",
        managerId: "manager",
        displayName: "Release Manager",
        role: "manager",
        status: "idle",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        cwd: "/tmp/release",
        model: {
          provider: "openai-codex",
          modelId: "gpt-5.3-codex",
          thinkingLevel: "high",
        },
      },
    });

    await expect(creationPromise).resolves.toMatchObject({
      agentId: "release-manager",
    });
    expect(
      client
        .getState()
        .agents.some((agent) => agent.agentId === "release-manager"),
    ).toBe(true);

    client.destroy();
  });

  it("defaults create_manager model to pi-codex when omitted", async () => {
    const client = new ManagerWsClient("ws://127.0.0.1:8787", "manager");

    client.start();
    vi.advanceTimersByTime(60);

    const socket = FakeWebSocket.instances[0];
    socket.emit("open");

    emitServerEvent(socket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      buildHash: TEST_BUILD_HASH,
      subscribedAgentId: "manager",
    });

    const creationPromise = client.createManager({
      name: "release-manager",
      cwd: "/tmp/release",
    });

    const sentCreatePayload = JSON.parse(socket.sentPayloads.at(-1) ?? "{}");
    expect(sentCreatePayload.model).toBe("pi-codex");

    emitServerEvent(socket, {
      type: "manager_created",
      requestId: sentCreatePayload.requestId,
      manager: {
        agentId: "release-manager",
        managerId: "manager",
        displayName: "Release Manager",
        role: "manager",
        status: "idle",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        cwd: "/tmp/release",
        model: {
          provider: "openai-codex",
          modelId: "gpt-5.4",
          thinkingLevel: "xhigh",
        },
      },
    });

    await expect(creationPromise).resolves.toMatchObject({
      agentId: "release-manager",
    });

    client.destroy();
  });

  it("stores manager order from snapshots and applies manager_order_updated events", () => {
    const client = new ManagerWsClient("ws://127.0.0.1:8787", "manager");

    client.start();
    vi.advanceTimersByTime(60);

    const socket = FakeWebSocket.instances[0];
    socket.emit("open");

    emitServerEvent(socket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      buildHash: TEST_BUILD_HASH,
      subscribedAgentId: "manager",
    });

    emitServerEvent(socket, {
      type: "agents_snapshot",
      agents: [
        managerDescriptor("manager", "2026-01-01T00:00:00.000Z"),
        managerDescriptor("manager-2", "2026-01-01T00:01:00.000Z"),
        managerDescriptor("manager-3", "2026-01-01T00:02:00.000Z"),
      ],
    });

    expect(client.getState().managerOrder).toEqual([
      "manager",
      "manager-2",
      "manager-3",
    ]);

    emitServerEvent(socket, {
      type: "manager_order_updated",
      managerIds: ["manager-3", "manager", "manager-2"],
    });

    expect(client.getState().managerOrder).toEqual([
      "manager-3",
      "manager",
      "manager-2",
    ]);
    expect(
      client
        .getState()
        .agents.filter((agent) => agent.role === "manager")
        .map((agent) => agent.agentId),
    ).toEqual(["manager-3", "manager", "manager-2"]);

    client.destroy();
  });

  it("optimistically reorders managers and rolls back when reorder_managers fails", async () => {
    const client = new ManagerWsClient("ws://127.0.0.1:8787", "manager");

    client.start();
    vi.advanceTimersByTime(60);

    const socket = FakeWebSocket.instances[0];
    socket.emit("open");

    emitServerEvent(socket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      buildHash: TEST_BUILD_HASH,
      subscribedAgentId: "manager",
    });

    emitServerEvent(socket, {
      type: "agents_snapshot",
      agents: [
        managerDescriptor("manager", "2026-01-01T00:00:00.000Z"),
        managerDescriptor("manager-2", "2026-01-01T00:01:00.000Z"),
        managerDescriptor("manager-3", "2026-01-01T00:02:00.000Z"),
      ],
    });

    const reorderPromise = client.reorderManagers([
      "manager-3",
      "manager",
      "manager-2",
    ]);
    const reorderPayload = JSON.parse(socket.sentPayloads.at(-1) ?? "{}");

    expect(reorderPayload).toMatchObject({
      type: "reorder_managers",
      managerIds: ["manager-3", "manager", "manager-2"],
    });
    expect(client.getState().managerOrder).toEqual([
      "manager-3",
      "manager",
      "manager-2",
    ]);

    emitServerEvent(socket, {
      type: "error",
      code: "REORDER_MANAGERS_FAILED",
      message: "Unable to persist order.",
      requestId: reorderPayload.requestId,
    });

    await expect(reorderPromise).rejects.toThrow(
      "REORDER_MANAGERS_FAILED: Unable to persist order.",
    );
    expect(client.getState().managerOrder).toEqual([
      "manager",
      "manager-2",
      "manager-3",
    ]);

    client.destroy();
  });

  it("sends directory picker commands and resolves response events", async () => {
    const client = new ManagerWsClient("ws://127.0.0.1:8787", "manager");

    client.start();
    vi.advanceTimersByTime(60);

    const socket = FakeWebSocket.instances[0];
    socket.emit("open");

    emitServerEvent(socket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      buildHash: TEST_BUILD_HASH,
      subscribedAgentId: "manager",
    });

    const listPromise = client.listDirectories("/tmp");
    const listPayload = JSON.parse(socket.sentPayloads.at(-1) ?? "{}");

    expect(listPayload).toMatchObject({
      type: "list_directories",
      path: "/tmp",
    });
    expect(typeof listPayload.requestId).toBe("string");

    emitServerEvent(socket, {
      type: "directories_listed",
      requestId: listPayload.requestId,
      path: "/tmp",
      directories: ["/tmp/a", "/tmp/b"],
    });

    await expect(listPromise).resolves.toEqual({
      path: "/tmp",
      directories: ["/tmp/a", "/tmp/b"],
    });

    const validatePromise = client.validateDirectory("/tmp/a");
    const validatePayload = JSON.parse(socket.sentPayloads.at(-1) ?? "{}");

    expect(validatePayload).toMatchObject({
      type: "validate_directory",
      path: "/tmp/a",
    });

    emitServerEvent(socket, {
      type: "directory_validated",
      requestId: validatePayload.requestId,
      path: "/tmp/a",
      valid: true,
    });

    await expect(validatePromise).resolves.toEqual({
      path: "/tmp/a",
      valid: true,
      message: null,
    });

    const pickPromise = client.pickDirectory("/tmp");
    const pickPayload = JSON.parse(socket.sentPayloads.at(-1) ?? "{}");

    expect(pickPayload).toMatchObject({
      type: "pick_directory",
      defaultPath: "/tmp",
    });

    emitServerEvent(socket, {
      type: "directory_picked",
      requestId: pickPayload.requestId,
      path: "/tmp/picked",
    });

    await expect(pickPromise).resolves.toBe("/tmp/picked");

    client.destroy();
  });

  it("rejects delete_manager when backend returns an error", async () => {
    const client = new ManagerWsClient("ws://127.0.0.1:8787", "manager");

    client.start();
    vi.advanceTimersByTime(60);

    const socket = FakeWebSocket.instances[0];
    socket.emit("open");

    emitServerEvent(socket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      buildHash: TEST_BUILD_HASH,
      subscribedAgentId: "manager",
    });

    const deletePromise = client.deleteManager("manager");
    const deletePayload = JSON.parse(socket.sentPayloads.at(-1) ?? "{}");

    emitServerEvent(socket, {
      type: "error",
      code: "DELETE_MANAGER_FAILED",
      message: "Delete failed for testing.",
      requestId: deletePayload.requestId,
    });

    await expect(deletePromise).rejects.toThrow(
      "DELETE_MANAGER_FAILED: Delete failed for testing.",
    );
    expect(client.getState().lastError).toBe("Delete failed for testing.");

    client.destroy();
  });

  it("falls back to the primary manager when selected manager is deleted", () => {
    const client = new ManagerWsClient("ws://127.0.0.1:8787", "manager");

    client.start();
    vi.advanceTimersByTime(60);

    const socket = FakeWebSocket.instances[0];
    socket.emit("open");

    emitServerEvent(socket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      buildHash: TEST_BUILD_HASH,
      subscribedAgentId: "manager-2",
    });

    emitServerEvent(socket, {
      type: "agents_snapshot",
      agents: [
        {
          agentId: "manager",
          managerId: "manager",
          displayName: "Primary Manager",
          role: "manager",
          status: "idle",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          cwd: "/tmp",
          model: {
            provider: "openai-codex",
            modelId: "gpt-5.3-codex",
            thinkingLevel: "medium",
          },
        },
        {
          agentId: "manager-2",
          managerId: "manager",
          displayName: "Manager 2",
          role: "manager",
          status: "idle",
          createdAt: "2026-01-01T00:01:00.000Z",
          updatedAt: "2026-01-01T00:01:00.000Z",
          cwd: "/tmp/secondary",
          model: {
            provider: "openai-codex",
            modelId: "gpt-5.3-codex",
            thinkingLevel: "medium",
          },
        },
      ],
    });

    emitServerEvent(socket, {
      type: "manager_deleted",
      managerId: "manager-2",
      terminatedWorkerIds: [],
    });

    expect(client.getState().targetAgentId).toBe("manager");

    const subscribePayload = JSON.parse(socket.sentPayloads.at(-1) ?? "{}");
    expect(subscribePayload).toMatchObject({
      type: "subscribe",
      agentId: "manager",
    });

    client.destroy();
  });

  it("keeps an explicitly selected errored manager thread active so its error remains visible", () => {
    const client = new ManagerWsClient("ws://127.0.0.1:8787", "manager");

    client.start();
    vi.advanceTimersByTime(60);

    const socket = FakeWebSocket.instances[0];
    socket.emit("open");

    emitServerEvent(socket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      buildHash: TEST_BUILD_HASH,
      subscribedAgentId: "manager",
    });

    emitServerEvent(socket, {
      type: "conversation_history",
      agentId: "manager",
      messages: [
        {
          type: "conversation_log",
          agentId: "manager",
          timestamp: new Date().toISOString(),
          source: "runtime_log",
          kind: "message_end",
          text: "Missing authentication for openai-codex. Configure credentials in Settings.",
          isError: true,
        },
      ],
    });

    emitServerEvent(socket, {
      type: "agents_snapshot",
      agents: [
        {
          agentId: "manager",
          managerId: "manager",
          displayName: "Manager",
          role: "manager",
          status: "errored",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
          cwd: "/tmp",
          model: {
            provider: "openai-codex",
            modelId: "gpt-5.4",
            thinkingLevel: "medium",
          },
        },
      ],
    });

    expect(client.getState().targetAgentId).toBe("manager");
    expect(client.getState().subscribedAgentId).toBe("manager");
    expect(client.getState().messages).toHaveLength(1);
    expect(client.getState().lastError).toBe(
      "Missing authentication for openai-codex. Configure credentials in Settings.",
    );

    client.destroy();
  });

  it("clears selection when the last manager is deleted and blocks sends until a new agent exists", () => {
    const client = new ManagerWsClient("ws://127.0.0.1:8787", "manager");

    client.start();
    vi.advanceTimersByTime(60);

    const socket = FakeWebSocket.instances[0];
    socket.emit("open");

    emitServerEvent(socket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      buildHash: TEST_BUILD_HASH,
      subscribedAgentId: "manager",
    });

    emitServerEvent(socket, {
      type: "agents_snapshot",
      agents: [
        {
          agentId: "manager",
          managerId: "manager",
          displayName: "Manager",
          role: "manager",
          status: "idle",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          cwd: "/tmp",
          model: {
            provider: "openai-codex",
            modelId: "gpt-5.3-codex",
            thinkingLevel: "medium",
          },
        },
      ],
    });

    emitServerEvent(socket, {
      type: "manager_deleted",
      managerId: "manager",
      terminatedWorkerIds: [],
    });

    expect(client.getState().targetAgentId).toBeNull();
    expect(client.getState().subscribedAgentId).toBeNull();

    const sentCountBefore = socket.sentPayloads.length;
    client.sendUserMessage("hello?");

    expect(socket.sentPayloads).toHaveLength(sentCountBefore);
    expect(client.getState().lastError).toContain("No active agent selected");

    client.destroy();
  });
});
