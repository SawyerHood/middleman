import { afterEach, describe, expect, it, vi } from "vitest";

import type { EventEnvelope, SessionRuntimeConfig, SessionStatus, UserInput } from "../src/index.js";
import {
  ClaudeEventMapper,
  createClaudeBackendAdapter,
  ClaudeQuerySession,
  type ClaudeSdkMessage,
  type ClaudeSdkModule,
  type ClaudeSdkQueryHandle,
  type ClaudeSdkUserMessage,
} from "../src/index.js";

class FakeClaudeQueryHandle implements ClaudeSdkQueryHandle, AsyncIterator<ClaudeSdkMessage> {
  readonly receivedInputs: ClaudeSdkUserMessage[] = [];

  interruptCalls = 0;

  private readonly events: ClaudeSdkMessage[] = [];
  private readonly eventWaiters: Array<(value: IteratorResult<ClaudeSdkMessage>) => void> = [];
  private closed = false;

  attachPrompt(prompt: AsyncIterable<ClaudeSdkUserMessage>): void {
    void this.consumePrompt(prompt);
  }

  pushEvent(event: ClaudeSdkMessage): void {
    if (this.closed) {
      throw new Error("Fake Claude query handle is closed.");
    }

    const waiter = this.eventWaiters.shift();
    if (waiter) {
      waiter({
        value: event,
        done: false,
      });
      return;
    }

    this.events.push(event);
  }

  close(): void {
    this.closed = true;

    while (this.eventWaiters.length > 0) {
      const waiter = this.eventWaiters.shift();
      waiter?.({
        value: undefined as unknown as ClaudeSdkMessage,
        done: true,
      });
    }
  }

  async interrupt(): Promise<void> {
    this.interruptCalls += 1;
  }

  async initializationResult(): Promise<Record<string, never>> {
    return {};
  }

  async next(): Promise<IteratorResult<ClaudeSdkMessage>> {
    if (this.events.length > 0) {
      const event = this.events.shift();
      if (!event) {
        return {
          value: undefined as unknown as ClaudeSdkMessage,
          done: true,
        };
      }

      return {
        value: event,
        done: false,
      };
    }

    if (this.closed) {
      return {
        value: undefined as unknown as ClaudeSdkMessage,
        done: true,
      };
    }

    return await new Promise<IteratorResult<ClaudeSdkMessage>>((resolve) => {
      this.eventWaiters.push(resolve);
    });
  }

  async return(): Promise<IteratorResult<ClaudeSdkMessage>> {
    this.close();
    return {
      value: undefined as unknown as ClaudeSdkMessage,
      done: true,
    };
  }

  [Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
    return this;
  }

  private async consumePrompt(prompt: AsyncIterable<ClaudeSdkUserMessage>): Promise<void> {
    for await (const message of prompt) {
      this.receivedInputs.push(message);
    }
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function createFailingHandle(error: Error): ClaudeSdkQueryHandle {
  return {
    async interrupt() {},
    async initializationResult(): Promise<never> {
      throw error;
    },
    close() {},
    async return() {
      return {
        value: undefined as unknown as ClaudeSdkMessage,
        done: true,
      };
    },
    async *[Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
      throw error;
    },
  };
}

function createCallbacks() {
  const events: Array<Omit<EventEnvelope, "cursor">> = [];
  const statuses: SessionStatus[] = [];
  const statusChanges: Array<{
    status: SessionStatus;
    contextUsage: unknown;
  }> = [];
  const checkpoints: unknown[] = [];

  return {
    events,
    statuses,
    statusChanges,
    checkpoints,
    callbacks: {
      emitEvent(event: Omit<EventEnvelope, "cursor">) {
        events.push(event);
      },
      emitStatusChange(status: SessionStatus, _error?: unknown, contextUsage?: unknown) {
        statuses.push(status);
        statusChanges.push({ status, contextUsage });
      },
      emitCheckpoint(checkpoint: unknown) {
        checkpoints.push(checkpoint);
      },
      log: vi.fn(),
    },
  };
}

function createConfig(): SessionRuntimeConfig {
  return {
    backend: "claude",
    cwd: "/tmp/swarmd",
    model: "claude-sonnet-4",
    systemPrompt: "You are Claude inside swarmd.",
    backendConfig: {
      sessionId: "ses_claude_adapter_test",
      threadId: "thr_claude_adapter_test",
    },
  };
}

function createUserInput(id: string, text: string): UserInput {
  return {
    id,
    role: "user",
    parts: [
      {
        type: "text",
        text,
      },
    ],
  };
}

function createSystemInput(id: string, text: string): UserInput {
  return {
    id,
    role: "system",
    parts: [
      {
        type: "text",
        text,
      },
    ],
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ClaudeEventMapper", () => {
  it("maps Claude SDK events into normalized swarmd events", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-13T18:00:00.000Z"));

    const mapper = new ClaudeEventMapper();
    const context = {
      sessionId: "ses_mapper",
      threadId: "thr_mapper",
      turnId: "turn_mapper",
    };

    const started = mapper.mapEvent(context, {
      type: "system:init",
      session_id: "claude-session-1",
    });
    const assistant = mapper.mapEvent(context, {
      type: "assistant",
      session_id: "claude-session-1",
      message: {
        id: "msg_1",
        role: "assistant",
        content: [{ type: "text", text: "Hello from Claude" }],
      },
    });
    const taskStarted = mapper.mapEvent(context, {
      type: "task_started",
      session_id: "claude-session-1",
      task_id: "task-1",
      task_type: "tool",
      description: "Search the workspace",
      tool_use_id: "tool-1",
    });
    const progress = mapper.mapEvent(context, {
      type: "tool_progress",
      session_id: "claude-session-1",
      tool_name: "search",
      tool_use_id: "tool-1",
      elapsed_time_seconds: 3,
      task_id: "task-1",
    });
    const toolCompleted = mapper.mapEvent(context, {
      type: "user",
      session_id: "claude-session-1",
      parent_tool_use_id: "tool-1",
      message: {
        role: "user",
        content: "tool completed",
      },
      tool_use_result: {
        content: [{ type: "text", text: "Published message to user (web)." }],
        details: {
          text: "Hello from the manager",
          targetContext: {
            channel: "web",
          },
        },
      },
    });
    const completed = mapper.mapEvent(context, {
      type: "result",
      session_id: "claude-session-1",
      subtype: "success",
      stop_reason: "end_turn",
    });

    expect(started.map((event) => event.type)).toEqual(["session.started", "backend.raw"]);
    expect(assistant.map((event) => event.type)).toEqual([
      "message.started",
      "message.delta",
      "message.completed",
      "backend.raw",
    ]);
    expect(taskStarted.map((event) => event.type)).toEqual(["tool.started", "backend.raw"]);
    expect(progress.map((event) => event.type)).toEqual(["tool.progress", "backend.raw"]);
    expect(toolCompleted.map((event) => event.type)).toEqual(["tool.completed", "backend.raw"]);
    expect(completed.map((event) => event.type)).toEqual(["turn.completed", "backend.raw"]);

    expect(started[0]).toMatchObject({
      sessionId: "ses_mapper",
      threadId: "thr_mapper",
      timestamp: "2026-03-13T18:00:00.000Z",
      source: "backend",
      payload: {
        backend: "claude",
        claudeSessionId: "claude-session-1",
      },
    });
    expect(assistant[1]).toMatchObject({
      type: "message.delta",
      source: "backend",
      payload: {
        messageId: "msg_1",
        delta: "Hello from Claude",
      },
    });
    expect(taskStarted[0]).toMatchObject({
      type: "tool.started",
      payload: {
        toolName: "task:task-1",
        toolCallId: "tool-1",
        input: {
          taskId: "task-1",
          taskType: "tool",
          description: "Search the workspace",
          toolUseId: "tool-1",
        },
      },
    });
    expect(progress[0]).toMatchObject({
      type: "tool.progress",
      payload: {
        toolName: "search",
        toolCallId: "tool-1",
        progress: {
          taskId: "task-1",
          elapsedTimeSeconds: 3,
        },
      },
    });
    expect(toolCompleted[0]).toMatchObject({
      type: "tool.completed",
      payload: {
        toolName: "search",
        toolCallId: "tool-1",
        ok: true,
        result: {
          details: {
            text: "Hello from the manager",
            targetContext: {
              channel: "web",
            },
          },
        },
      },
    });
    expect(completed[0]).toMatchObject({
      type: "turn.completed",
      payload: {
        turnId: "turn_mapper",
        claudeSessionId: "claude-session-1",
        subtype: "success",
        stopReason: "end_turn",
      },
    });
  });

  it("streams assistant text from partial Claude events without completing on thinking-only frames", () => {
    const mapper = new ClaudeEventMapper();
    const context = {
      sessionId: "ses_mapper",
      threadId: "thr_mapper",
      turnId: "turn_mapper",
    };

    const start = mapper.mapEvent(context, {
      type: "stream_event",
      session_id: "claude-session-1",
      event: {
        type: "message_start",
        message: {
          id: "msg_stream_1",
        },
      },
    });
    const thinking = mapper.mapEvent(context, {
      type: "assistant",
      session_id: "claude-session-1",
      message: {
        id: "msg_stream_1",
        role: "assistant",
        content: [{ type: "thinking", thinking: "hidden chain of thought" }],
      },
    });
    const delta = mapper.mapEvent(context, {
      type: "stream_event",
      session_id: "claude-session-1",
      event: {
        type: "content_block_delta",
        delta: {
          type: "text_delta",
          text: "Hello",
        },
      },
    });
    const stop = mapper.mapEvent(context, {
      type: "stream_event",
      session_id: "claude-session-1",
      event: {
        type: "message_stop",
      },
    });

    expect(start.map((event) => event.type)).toEqual(["message.started", "backend.raw"]);
    expect(thinking.map((event) => event.type)).toEqual(["backend.raw"]);
    expect(delta.map((event) => event.type)).toEqual(["message.delta", "backend.raw"]);
    expect(stop.map((event) => event.type)).toEqual(["message.completed", "backend.raw"]);
  });
});

describe("ClaudeQuerySession", () => {
  it("becomes idle during bootstrap when a provisional checkpoint is supplied", async () => {
    const callbacks = createCallbacks();
    const handle = new FakeClaudeQueryHandle();
    const sdk: Pick<ClaudeSdkModule, "query"> = {
      query: vi.fn(({ prompt }) => {
        handle.attachPrompt(prompt);
        return handle;
      }),
    };

    const session = new ClaudeQuerySession({
      sdk,
      callbacks: callbacks.callbacks,
      config: createConfig(),
      sessionId: "ses_runtime",
      threadId: "thr_runtime",
      checkpoint: {
        backend: "claude",
        sessionId: "00000000-0000-4000-8000-000000000000",
      },
      queryOptions: {
        sessionId: "00000000-0000-4000-8000-000000000000",
      },
    });

    await expect(session.start()).resolves.toEqual({
      backend: "claude",
      sessionId: "00000000-0000-4000-8000-000000000000",
    });
    expect(sdk.query).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          settingSources: [],
        }),
      }),
    );
    expect(session.getStatus()).toBe("idle");
    expect(callbacks.checkpoints).toEqual([
      {
        backend: "claude",
        sessionId: "00000000-0000-4000-8000-000000000000",
      },
    ]);

    await session.dispose();
  });

  it("captures Claude stderr and enriches startup failures", async () => {
    const callbacks = createCallbacks();
    const startupError = new Error("Claude Code process exited with code 1");
    const sdk: Pick<ClaudeSdkModule, "query"> = {
      query: vi.fn(({ options }) => {
        options.stderr?.("No conversation found with session ID: stale-session\n");
        return createFailingHandle(startupError);
      }),
    };

    const session = new ClaudeQuerySession({
      sdk,
      callbacks: callbacks.callbacks,
      config: createConfig(),
      sessionId: "ses_runtime",
      threadId: "thr_runtime",
    });

    await expect(session.start()).rejects.toThrow(
      "Claude stderr: No conversation found with session ID: stale-session",
    );
    expect(callbacks.callbacks.log).toHaveBeenCalledWith("debug", "Claude query stderr.", {
      line: "No conversation found with session ID: stale-session",
    });

    await session.dispose();
  });

  it("manages busy and interrupting state while deferring the next prompt", async () => {
    const callbacks = createCallbacks();
    const handle = new FakeClaudeQueryHandle();
    const sdk: Pick<ClaudeSdkModule, "query"> = {
      query: vi.fn(({ prompt }) => {
        handle.attachPrompt(prompt);
        return handle;
      }),
    };

    const session = new ClaudeQuerySession({
      sdk,
      callbacks: callbacks.callbacks,
      config: createConfig(),
      sessionId: "ses_runtime",
      threadId: "thr_runtime",
    });

    const startPromise = session.start();
    handle.pushEvent({
      type: "system:init",
      session_id: "claude-session-live",
    });

    await expect(startPromise).resolves.toEqual({
      backend: "claude",
      sessionId: "claude-session-live",
    });
    expect(session.getStatus()).toBe("idle");

    await expect(session.sendInput(createUserInput("turn-1", "First message"), "auto")).resolves.toEqual({
      acceptedDelivery: "auto",
      queued: false,
    });

    await flush();
    expect(session.getStatus()).toBe("busy");
    expect(handle.receivedInputs).toHaveLength(1);
    expect(handle.receivedInputs[0]).toMatchObject({
      type: "user",
      session_id: "claude-session-live",
      message: {
        role: "user",
        content: "First message",
      },
    });

    await expect(session.sendInput(createUserInput("turn-2", "Second message"), "auto")).resolves.toEqual({
      acceptedDelivery: "interrupt",
      queued: false,
    });

    expect(session.getStatus()).toBe("interrupting");
    expect(handle.interruptCalls).toBe(1);
    expect(handle.receivedInputs).toHaveLength(1);

    handle.pushEvent({
      type: "result",
      session_id: "claude-session-live",
      subtype: "interrupted",
      stop_reason: "interrupted",
    });

    await flush();
    expect(session.getStatus()).toBe("busy");
    expect(handle.receivedInputs).toHaveLength(2);
    expect(handle.receivedInputs[1]).toMatchObject({
      type: "user",
      session_id: "claude-session-live",
      message: {
        role: "user",
        content: "Second message",
      },
    });

    const idlePromise = session.waitForIdle();
    handle.pushEvent({
      type: "result",
      session_id: "claude-session-live",
      subtype: "success",
      stop_reason: "end_turn",
    });

    await idlePromise;
    expect(session.getStatus()).toBe("idle");

    expect(callbacks.statuses).toEqual(["idle", "busy", "interrupting", "busy", "idle"]);
    expect(callbacks.checkpoints).toEqual([
      {
        backend: "claude",
        sessionId: "claude-session-live",
      },
    ]);
    expect(callbacks.events.map((event) => event.type)).toContain("turn.started");
    expect(callbacks.events.map((event) => event.type).filter((type) => type === "turn.completed")).toHaveLength(2);
    expect(
      callbacks.events.filter((event) => event.type === "turn.started").map((event) => event.payload),
    ).toEqual([
      {
        turnId: "turn-1",
        delivery: "auto",
        role: "user",
      },
      {
        turnId: "turn-2",
        delivery: "interrupt",
        role: "user",
      },
    ]);

    await session.dispose();
  });

  it("normalizes system input into a Claude user message", async () => {
    const callbacks = createCallbacks();
    const handle = new FakeClaudeQueryHandle();
    const sdk: Pick<ClaudeSdkModule, "query"> = {
      query: vi.fn(({ prompt }) => {
        handle.attachPrompt(prompt);
        return handle;
      }),
    };

    const session = new ClaudeQuerySession({
      sdk,
      callbacks: callbacks.callbacks,
      config: createConfig(),
      sessionId: "ses_runtime",
      threadId: "thr_runtime",
    });

    const startPromise = session.start();
    handle.pushEvent({
      type: "system:init",
      session_id: "claude-session-live",
    });

    await startPromise;
    await expect(session.sendInput(createSystemInput("turn-system", "Assigned task"), "auto")).resolves.toEqual({
      acceptedDelivery: "auto",
      queued: false,
    });

    await flush();
    expect(handle.receivedInputs).toHaveLength(1);
    expect(handle.receivedInputs[0]).toMatchObject({
      type: "user",
      session_id: "claude-session-live",
      message: {
        role: "user",
        content: "System message:\nAssigned task",
      },
    });
    expect(
      callbacks.events.filter((event) => event.type === "turn.started").map((event) => event.payload),
    ).toEqual([
      {
        turnId: "turn-system",
        delivery: "auto",
        role: "system",
      },
    ]);

    await session.dispose();
  });

  it("derives context usage from the configured Claude model and includes cached input tokens", async () => {
    const callbacks = createCallbacks();
    const handle = new FakeClaudeQueryHandle();
    const sdk: Pick<ClaudeSdkModule, "query"> = {
      query: vi.fn(({ prompt }) => {
        handle.attachPrompt(prompt);
        return handle;
      }),
    };

    const session = new ClaudeQuerySession({
      sdk,
      callbacks: callbacks.callbacks,
      config: createConfig(),
      sessionId: "ses_runtime",
      threadId: "thr_runtime",
    });

    const startPromise = session.start();
    handle.pushEvent({
      type: "system:init",
      session_id: "claude-session-live",
    });

    await startPromise;
    expect(callbacks.statusChanges[0]).toEqual({
      status: "idle",
      contextUsage: null,
    });

    await session.sendInput(createUserInput("turn-1", "First message"), "auto");
    await flush();

    handle.pushEvent({
      type: "result",
      session_id: "claude-session-live",
      subtype: "success",
      stop_reason: "end_turn",
      modelUsage: {
        "claude-haiku-4": {
          inputTokens: 90,
          outputTokens: 10,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: 0,
          contextWindow: 200_000,
          maxOutputTokens: 8_192,
        },
        "claude-sonnet-4": {
          inputTokens: 1_000,
          outputTokens: 400,
          cacheReadInputTokens: 200,
          cacheCreationInputTokens: 300,
          webSearchRequests: 0,
          costUSD: 0,
          contextWindow: 200_000,
          maxOutputTokens: 8_192,
        },
      },
    });

    await flush();

    expect(callbacks.statusChanges.at(-1)).toEqual({
      status: "idle",
      contextUsage: {
        tokens: 1_900,
        contextWindow: 200_000,
        percent: 0.95,
      },
    });

    await session.dispose();
  });

  it("starts a fresh Claude session when resuming a missing conversation checkpoint", async () => {
    const callbacks = createCallbacks();
    const freshHandle = new FakeClaudeQueryHandle();
    const sdk: ClaudeSdkModule = {
      query: vi.fn(({ prompt, options }) => {
        if (options.resume === "stale-session") {
          options.stderr?.("No conversation found with session ID: stale-session\n");
          return createFailingHandle(new Error("Claude Code process exited with code 1"));
        }

        freshHandle.attachPrompt(prompt);
        return freshHandle;
      }),
    };

    const adapter = createClaudeBackendAdapter(callbacks.callbacks, {
      loadSdk: async () => sdk,
    });

    const bootstrapPromise = adapter.bootstrap(createConfig(), {
      backend: "claude",
      sessionId: "stale-session",
    });

    freshHandle.pushEvent({
      type: "system:init",
      session_id: "fresh-session-live",
    });

    await expect(bootstrapPromise).resolves.toEqual({
      checkpoint: {
        backend: "claude",
        sessionId: "fresh-session-live",
      },
    });
    expect(sdk.query).toHaveBeenCalledTimes(2);
    expect(callbacks.callbacks.log).toHaveBeenCalledWith(
      "warn",
      "Claude checkpoint resume failed; starting a fresh session.",
      expect.objectContaining({
        sessionId: "stale-session",
        error: expect.stringContaining("No conversation found"),
      }),
    );

    await adapter.stop();
  });
});
