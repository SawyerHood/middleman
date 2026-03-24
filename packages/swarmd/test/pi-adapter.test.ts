import { describe, expect, it, vi } from "vitest";

import {
  PiBackendAdapter,
  PiEventMapper,
  PiSessionHost,
  extractPiMessageDelta,
  resolvePiDeliveryMode,
  type PiSessionHostLike,
  type PiSessionEvent,
} from "../src/index.js";

function createCallbacks() {
  return {
    emitEvent: vi.fn(),
    emitStatusChange: vi.fn(),
    emitBackendState: vi.fn(),
    emitCheckpoint: vi.fn(),
    log: vi.fn(),
  };
}

function createUserInput() {
  return {
    id: "input-1",
    role: "user" as const,
    parts: [{ type: "text" as const, text: "hello pi" }],
  };
}

describe("PiEventMapper", () => {
  it("maps Pi lifecycle, message, and tool events into normalized events", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-13T18:00:00.000Z"));

    const mapper = new PiEventMapper({
      sessionId: "ses_pi",
      threadId: "thr_pi",
    });

    const assistantMessage = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "Done" }],
      provider: "openai",
      model: "gpt-5",
      api: "openai-responses",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop" as const,
      timestamp: Date.now(),
    };

    const events: PiSessionEvent[] = [
      { type: "agent_start" },
      { type: "turn_start" },
      { type: "message_start", message: assistantMessage },
      {
        type: "message_update",
        message: assistantMessage,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "Done",
          partial: assistantMessage,
        },
      },
      {
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "read",
        args: { path: "README.md" },
      },
      {
        type: "tool_execution_update",
        toolCallId: "tool-1",
        toolName: "read",
        args: { path: "README.md" },
        partialResult: { bytes: 42 },
      },
      {
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "read",
        result: { bytes: 42, ok: true },
        isError: false,
      },
      { type: "message_end", message: assistantMessage },
      {
        type: "turn_end",
        message: assistantMessage,
        toolResults: [],
      },
      {
        type: "agent_end",
        messages: [assistantMessage],
      },
    ];

    const normalized = events.flatMap((event) => mapper.mapEvent(event));

    expect(normalized.map((event) => event.type)).toEqual([
      "session.started",
      "turn.started",
      "message.started",
      "message.delta",
      "tool.started",
      "tool.progress",
      "tool.completed",
      "message.completed",
      "turn.completed",
      "session.stopped",
    ]);

    expect(normalized[1]).toMatchObject({
      source: "backend",
      payload: { turnId: "pi-turn-1" },
      timestamp: "2026-03-13T18:00:00.000Z",
    });
    expect(normalized[2]).toMatchObject({
      payload: { messageId: "pi-message-1", role: "assistant" },
    });
    expect(normalized[3]).toMatchObject({
      payload: { messageId: "pi-message-1", delta: "Done", role: "assistant" },
    });
    expect(normalized[4]).toMatchObject({
      payload: {
        toolName: "read",
        toolCallId: "tool-1",
        input: { path: "README.md" },
      },
    });
    expect(normalized[5]).toMatchObject({
      payload: {
        toolName: "read",
        toolCallId: "tool-1",
        progress: { bytes: 42 },
        input: { path: "README.md" },
      },
    });
    expect(normalized[6]).toMatchObject({
      payload: {
        toolName: "read",
        toolCallId: "tool-1",
        ok: true,
        result: { bytes: 42, ok: true },
      },
    });
    expect(normalized[7]).toMatchObject({
      payload: {
        messageId: "pi-message-1",
        role: "assistant",
        stopReason: "stop",
      },
    });
    expect(normalized[8]).toMatchObject({
      payload: {
        turnId: "pi-turn-1",
        role: "assistant",
        toolResultCount: 0,
      },
    });
  });

  it("ignores message_update events that do not contain deltas", () => {
    const assistantMessage = {
      role: "assistant" as const,
      content: [],
      provider: "openai",
      model: "gpt-5",
      api: "openai-responses",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop" as const,
      timestamp: Date.now(),
    };

    expect(
      extractPiMessageDelta({
        type: "message_update",
        message: assistantMessage,
        assistantMessageEvent: {
          type: "text_start",
          contentIndex: 0,
          partial: assistantMessage,
        },
      }),
    ).toBeNull();
  });

  it("surfaces auto compaction events as backend raw events", () => {
    const mapper = new PiEventMapper({
      sessionId: "ses_pi",
      threadId: "thr_pi",
    });

    const normalized = [
      mapper.mapEvent({ type: "auto_compaction_start", reason: "threshold" }),
      mapper.mapEvent({
        type: "auto_compaction_end",
        result: { compacted: true },
        aborted: false,
        willRetry: false,
      }),
    ].flat();

    expect(normalized).toEqual([
      expect.objectContaining({
        type: "backend.raw",
        source: "backend",
        payload: {
          type: "auto_compaction_start",
          reason: "threshold",
        },
      }),
      expect.objectContaining({
        type: "backend.raw",
        source: "backend",
        payload: {
          type: "auto_compaction_end",
          result: { compacted: true },
          aborted: false,
          willRetry: false,
        },
      }),
    ]);
  });
});

describe("Pi delivery resolution", () => {
  it("routes idle input to prompt", () => {
    expect(
      resolvePiDeliveryMode("auto", {
        isBusy: false,
        busyDefault: "queue",
      }),
    ).toEqual({
      action: "prompt",
      acceptedDelivery: "auto",
      queued: false,
    });
  });

  it("uses follow-up delivery when busy and queueing is requested", () => {
    expect(
      resolvePiDeliveryMode("auto", {
        isBusy: true,
        busyDefault: "queue",
      }),
    ).toEqual({
      action: "followUp",
      acceptedDelivery: "queue",
      queued: true,
    });
  });

  it("uses steer delivery when busy and interruption is requested", () => {
    expect(
      resolvePiDeliveryMode("interrupt", {
        isBusy: true,
        busyDefault: "queue",
      }),
    ).toEqual({
      action: "steer",
      acceptedDelivery: "interrupt",
      queued: true,
    });
  });
});

describe("PiBackendAdapter", () => {
  it("dispatches through a mocked host without requiring Pi to be installed", async () => {
    const host: PiSessionHostLike = {
      bootstrap: vi.fn().mockResolvedValue({
        backend: "pi",
        sessionFile: "/tmp/pi-session.jsonl",
      }),
      createThread: vi.fn(),
      forkThread: vi.fn(),
      resumeThread: vi.fn(),
      isBusy: vi.fn().mockReturnValue(true),
      sendPrompt: vi.fn(),
      sendSteer: vi.fn().mockResolvedValue(undefined),
      sendFollowUp: vi.fn(),
      interrupt: vi.fn(),
      compact: vi.fn(),
      stop: vi.fn(),
      terminate: vi.fn(),
    };
    const callbacks = createCallbacks();
    const adapter = new PiBackendAdapter(callbacks, {
      sessionId: "ses_pi",
      threadId: "thr_pi",
      host,
    });

    await adapter.bootstrap(
      {
        backend: "pi",
        cwd: "/tmp/project",
        model: "openai/gpt-5",
        deliveryDefaults: { busyMode: "queue" },
        backendConfig: {},
      },
      undefined,
    );

    const receipt = await adapter.sendInput(createUserInput(), "auto");

    expect(host.sendPrompt).not.toHaveBeenCalled();
    expect(host.sendSteer).not.toHaveBeenCalled();
    expect(host.sendFollowUp).toHaveBeenCalledTimes(1);
    expect(receipt).toEqual({
      acceptedDelivery: "queue",
      queued: true,
    });
  });
});

describe("PiSessionHost", () => {
  it("emits session.errored when prompt dispatch fails after startup", async () => {
    const sessionManager = {
      appendMessage: vi.fn(),
      branch: vi.fn(),
      getSessionFile: vi.fn().mockReturnValue("/tmp/pi-session.jsonl"),
      getSessionDir: vi.fn().mockReturnValue("/tmp"),
      getCwd: vi.fn().mockReturnValue("/tmp"),
      _rewriteFile: vi.fn(),
    };

    const session = {
      isStreaming: false,
      sessionManager,
      prompt: vi.fn().mockRejectedValue({}),
      steer: vi.fn(),
      followUp: vi.fn(),
      abort: vi.fn(),
      compact: vi.fn(),
      subscribe: vi.fn().mockReturnValue(() => {}),
      dispose: vi.fn(),
    };

    const callbacks = createCallbacks();
    const host = new PiSessionHost(callbacks, {
      sessionId: "ses_pi",
      threadId: "thr_pi",
      loadModule: async () => ({
        createAgentSession: vi.fn().mockResolvedValue({ session }),
        SessionManager: {
          create: vi.fn().mockReturnValue(sessionManager),
          open: vi.fn().mockReturnValue(sessionManager),
          forkFrom: vi.fn().mockReturnValue(sessionManager),
        },
      }),
    });

    await host.bootstrap({
      backend: "pi",
      cwd: "/tmp/project",
      model: "openai-codex/gpt-5.4",
      backendConfig: {
        authFile: "/tmp/auth.json",
        modelProvider: "openai-codex",
        modelId: "gpt-5.4",
      },
    });

    await host.sendPrompt(createUserInput());

    await vi.waitFor(() => {
      expect(callbacks.emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "session.errored",
          sessionId: "ses_pi",
          threadId: "thr_pi",
          payload: {
            error: {
              code: "PROMPT_DISPATCH_FAILED",
              message: "Pi runtime failed.",
              retryable: true,
            },
          },
        }),
      );
    });

    expect(callbacks.emitStatusChange).toHaveBeenCalledWith(
      "errored",
      {
        code: "PROMPT_DISPATCH_FAILED",
        message: "Pi runtime failed.",
        retryable: true,
      },
      null,
    );
  });

  it("uses Pi session context usage snapshots and clears stale usage after compaction", async () => {
    let listener: ((event: PiSessionEvent) => void) | null = null;
    const sessionManager = {
      appendMessage: vi.fn(),
      branch: vi.fn(),
      getSessionFile: vi.fn().mockReturnValue("/tmp/pi-session.jsonl"),
      getSessionDir: vi.fn().mockReturnValue("/tmp"),
      getCwd: vi.fn().mockReturnValue("/tmp"),
      _rewriteFile: vi.fn(),
    };

    const getContextUsage = vi
      .fn()
      .mockReturnValueOnce({
        tokens: 120_000,
        contextWindow: 262_144,
        percent: 45.7763671875,
      })
      .mockReturnValueOnce({
        tokens: 130_000,
        contextWindow: 262_144,
        percent: 49.591064453125,
      })
      .mockReturnValueOnce({
        tokens: null,
        contextWindow: 262_144,
        percent: null,
      });

    const session = {
      isStreaming: false,
      sessionManager,
      prompt: vi.fn(),
      steer: vi.fn(),
      followUp: vi.fn(),
      abort: vi.fn(),
      compact: vi.fn(),
      getContextUsage,
      subscribe: vi.fn().mockImplementation((nextListener: (event: PiSessionEvent) => void) => {
        listener = nextListener;
        return () => {
          listener = null;
        };
      }),
      dispose: vi.fn(),
    };

    const callbacks = createCallbacks();
    const host = new PiSessionHost(callbacks, {
      sessionId: "ses_pi",
      threadId: "thr_pi",
      loadModule: async () => ({
        createAgentSession: vi.fn().mockResolvedValue({ session }),
        SessionManager: {
          create: vi.fn().mockReturnValue(sessionManager),
          open: vi.fn().mockReturnValue(sessionManager),
          forkFrom: vi.fn().mockReturnValue(sessionManager),
        },
      }),
    });

    await host.bootstrap({
      backend: "pi",
      cwd: "/tmp/project",
      model: "openai-codex/gpt-5.4",
      backendConfig: {
        authFile: "/tmp/auth.json",
        modelProvider: "openai-codex",
        modelId: "gpt-5.4",
      },
    });

    expect(callbacks.emitStatusChange).toHaveBeenCalledWith("idle", undefined, {
      tokens: 120_000,
      contextWindow: 262_144,
      percent: 45.7763671875,
    });

    listener?.({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Done" }],
        provider: "openai-codex",
        model: "gpt-5.4",
        api: "openai-responses",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    });

    expect(callbacks.emitStatusChange).toHaveBeenCalledWith("idle", undefined, {
      tokens: 130_000,
      contextWindow: 262_144,
      percent: 49.591064453125,
    });

    listener?.({
      type: "auto_compaction_end",
      result: undefined,
      aborted: false,
      willRetry: false,
    });

    expect(callbacks.emitStatusChange).toHaveBeenCalledWith("idle", undefined, null);
  });

  it("treats manual compaction as a busy lifecycle and emits backend state", async () => {
    let resolveCompact: ((value: unknown) => void) | null = null;
    const compactPromise = new Promise((resolve) => {
      resolveCompact = resolve;
    });
    const sessionManager = {
      appendMessage: vi.fn(),
      branch: vi.fn(),
      getSessionFile: vi.fn().mockReturnValue("/tmp/pi-session.jsonl"),
      getSessionDir: vi.fn().mockReturnValue("/tmp"),
      getCwd: vi.fn().mockReturnValue("/tmp"),
      _rewriteFile: vi.fn(),
    };

    const session = {
      isStreaming: false,
      sessionManager,
      prompt: vi.fn(),
      steer: vi.fn(),
      followUp: vi.fn(),
      abort: vi.fn(),
      compact: vi.fn().mockReturnValue(compactPromise),
      subscribe: vi.fn().mockReturnValue(() => {}),
      dispose: vi.fn(),
    };

    const callbacks = createCallbacks();
    const host = new PiSessionHost(callbacks, {
      sessionId: "ses_pi",
      threadId: "thr_pi",
      loadModule: async () => ({
        createAgentSession: vi.fn().mockResolvedValue({ session }),
        SessionManager: {
          create: vi.fn().mockReturnValue(sessionManager),
          open: vi.fn().mockReturnValue(sessionManager),
          forkFrom: vi.fn().mockReturnValue(sessionManager),
        },
      }),
    });

    await host.bootstrap({
      backend: "pi",
      cwd: "/tmp/project",
      model: "openai-codex/gpt-5.4",
      backendConfig: {
        authFile: "/tmp/auth.json",
        modelProvider: "openai-codex",
        modelId: "gpt-5.4",
      },
    });

    const pendingCompaction = host.compact("Keep the latest plan");

    expect(host.isBusy()).toBe(true);
    expect(session.compact).toHaveBeenCalledWith("Keep the latest plan");
    expect(callbacks.emitBackendState).toHaveBeenCalledWith({ lifecycle: "compacting" });

    resolveCompact?.({ compacted: true });

    await expect(pendingCompaction).resolves.toEqual({ compacted: true });
    expect(host.isBusy()).toBe(false);
    expect(callbacks.emitBackendState).toHaveBeenLastCalledWith({});
    expect(callbacks.emitStatusChange).toHaveBeenLastCalledWith("idle", undefined, null);
  });

  it("rejects duplicate manual compaction requests", async () => {
    const compactPromise = new Promise(() => undefined);
    const sessionManager = {
      appendMessage: vi.fn(),
      branch: vi.fn(),
      getSessionFile: vi.fn().mockReturnValue("/tmp/pi-session.jsonl"),
      getSessionDir: vi.fn().mockReturnValue("/tmp"),
      getCwd: vi.fn().mockReturnValue("/tmp"),
      _rewriteFile: vi.fn(),
    };

    const session = {
      isStreaming: false,
      sessionManager,
      prompt: vi.fn(),
      steer: vi.fn(),
      followUp: vi.fn(),
      abort: vi.fn(),
      compact: vi.fn().mockReturnValue(compactPromise),
      subscribe: vi.fn().mockReturnValue(() => {}),
      dispose: vi.fn(),
    };

    const host = new PiSessionHost(createCallbacks(), {
      sessionId: "ses_pi",
      threadId: "thr_pi",
      loadModule: async () => ({
        createAgentSession: vi.fn().mockResolvedValue({ session }),
        SessionManager: {
          create: vi.fn().mockReturnValue(sessionManager),
          open: vi.fn().mockReturnValue(sessionManager),
          forkFrom: vi.fn().mockReturnValue(sessionManager),
        },
      }),
    });

    await host.bootstrap({
      backend: "pi",
      cwd: "/tmp/project",
      model: "openai-codex/gpt-5.4",
      backendConfig: {
        authFile: "/tmp/auth.json",
        modelProvider: "openai-codex",
        modelId: "gpt-5.4",
      },
    });

    void host.compact();

    await expect(host.compact()).rejects.toThrow(
      "Manual compaction is already in progress for ses_pi.",
    );
  });
});
