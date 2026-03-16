import { afterEach, describe, expect, it, vi } from "vitest";

import {
  backendRawEvent,
  createInitialClaudeCheckpoint,
  createInitialCodexCheckpoint,
  createInitialPiCheckpoint,
  createNormalizedEvent,
  isClaudeCheckpoint,
  isCodexCheckpoint,
  isPiCheckpoint,
  messageCompletedEvent,
  messageDeltaEvent,
  messageStartedEvent,
  sessionStatusEvent,
  toolCompletedEvent,
  toolProgressEvent,
  toolStartedEvent,
  turnCompletedEvent,
  turnStartedEvent,
  validateCheckpoint,
} from "../src/index.js";

describe("checkpoint utilities", () => {
  it("identifies backend-specific checkpoints", () => {
    const codex = createInitialCodexCheckpoint("thread-1");
    const claude = createInitialClaudeCheckpoint("session-1");
    const pi = createInitialPiCheckpoint("/tmp/pi-session.json");

    expect(isCodexCheckpoint(codex)).toBe(true);
    expect(isCodexCheckpoint(claude)).toBe(false);
    expect(isClaudeCheckpoint(claude)).toBe(true);
    expect(isClaudeCheckpoint(pi)).toBe(false);
    expect(isPiCheckpoint(pi)).toBe(true);
    expect(isPiCheckpoint(codex)).toBe(false);
  });

  it("throws when validating a checkpoint against the wrong backend", () => {
    expect(() => validateCheckpoint(createInitialClaudeCheckpoint("session-2"), "codex")).toThrow(
      "Checkpoint backend mismatch: expected codex, got claude",
    );
  });
});

describe("event normalizer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates normalized events with generated ids and default source", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-13T12:34:56.000Z"));

    expect(
      createNormalizedEvent({
        sessionId: "ses_123",
        threadId: "thr_123",
        type: "turn.started",
        payload: { turnId: "turn-1" },
      }),
    ).toEqual({
      id: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
      sessionId: "ses_123",
      threadId: "thr_123",
      timestamp: "2026-03-13T12:34:56.000Z",
      source: "worker",
      type: "turn.started",
      payload: { turnId: "turn-1" },
    });
  });

  it("builds the common normalized event shapes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-13T13:00:00.000Z"));

    const sessionId = "ses_456";
    const threadId = "thr_456";

    const events = [
      turnStartedEvent({ sessionId, threadId, turnId: "turn-1", payload: { stage: "plan" } }),
      turnCompletedEvent({ sessionId, threadId, turnId: "turn-1", payload: { tokens: 42 } }),
      messageStartedEvent({
        sessionId,
        threadId,
        messageId: "msg-1",
        role: "assistant",
      }),
      messageDeltaEvent({
        sessionId,
        threadId,
        messageId: "msg-1",
        delta: "hello",
      }),
      messageCompletedEvent({
        sessionId,
        threadId,
        messageId: "msg-1",
        payload: { finishReason: "stop" },
      }),
      toolStartedEvent({
        sessionId,
        threadId,
        toolName: "search",
        toolCallId: "tool-1",
        toolInput: { query: "swarmd" },
      }),
      toolProgressEvent({
        sessionId,
        threadId,
        toolName: "search",
        toolCallId: "tool-1",
        progress: { step: 1, total: 2 },
      }),
      toolCompletedEvent({
        sessionId,
        threadId,
        toolName: "search",
        toolCallId: "tool-1",
        ok: true,
        result: { hits: 3 },
      }),
      sessionStatusEvent({
        sessionId,
        threadId: null,
        status: "busy",
        previousStatus: "idle",
      }),
      backendRawEvent({
        sessionId,
        threadId,
        payload: { rawType: "token", data: "abc" },
      }),
    ];

    expect(events.map((event) => event.type)).toEqual([
      "turn.started",
      "turn.completed",
      "message.started",
      "message.delta",
      "message.completed",
      "tool.started",
      "tool.progress",
      "tool.completed",
      "session.status.changed",
      "backend.raw",
    ]);

    for (const event of events) {
      expect(event.id).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(event.sessionId).toBe(sessionId);
      expect(event.timestamp).toBe("2026-03-13T13:00:00.000Z");
    }

    expect(events[0]).toMatchObject({
      threadId,
      source: "worker",
      payload: { turnId: "turn-1", stage: "plan" },
    });
    expect(events[2]).toMatchObject({
      payload: { messageId: "msg-1", role: "assistant" },
    });
    expect(events[3]).toMatchObject({
      payload: { messageId: "msg-1", delta: "hello" },
    });
    expect(events[5]).toMatchObject({
      payload: { toolName: "search", toolCallId: "tool-1", input: { query: "swarmd" } },
    });
    expect(events[7]).toMatchObject({
      payload: { toolName: "search", toolCallId: "tool-1", ok: true, result: { hits: 3 } },
    });
    expect(events[8]).toMatchObject({
      threadId: null,
      payload: { status: "busy", previousStatus: "idle" },
    });
    expect(events[9]).toMatchObject({
      source: "backend",
      payload: { rawType: "token", data: "abc" },
    });
  });
});
