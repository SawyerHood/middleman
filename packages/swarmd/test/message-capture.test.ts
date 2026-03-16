import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EventBus,
  MessageCapture,
  MessageRepo,
  MessageStore,
  SessionRepo,
  messageCompletedEvent,
  messageDeltaEvent,
  messageStartedEvent,
  toolCompletedEvent,
  toolStartedEvent,
  createDatabase,
  runMigrations,
  type Database,
  type EventEnvelope,
  type SessionRecord,
} from "../src/index.js";

interface CaptureTestContext {
  capture: MessageCapture;
  db: Database;
  eventBus: EventBus;
  messageStore: MessageStore;
  session: SessionRecord;
}

interface DisposableCaptureContext {
  capture: MessageCapture;
  db: Database;
}

function createSession(): SessionRecord {
  return {
    id: "capture-session",
    backend: "codex",
    status: "idle",
    displayName: "Capture Session",
    cwd: "/tmp/swarmd-message-capture",
    model: "gpt-5",
    metadata: {},
    backendCheckpoint: null,
    createdAt: "2026-03-13T00:00:00.000Z",
    updatedAt: "2026-03-13T00:00:00.000Z",
    lastError: null,
    contextUsage: null,
  };
}

function createTestContext(): CaptureTestContext {
  const db = createDatabase(":memory:");
  runMigrations(db);

  const sessionRepo = new SessionRepo(db);
  const messageRepo = new MessageRepo(db);
  const eventBus = new EventBus();
  const messageStore = new MessageStore(sessionRepo, messageRepo);
  const capture = new MessageCapture(eventBus, messageStore);
  const session = createSession();

  sessionRepo.create(session);

  return {
    capture,
    db,
    eventBus,
    messageStore,
    session,
  };
}

function createTestContextWithoutSession(): Omit<CaptureTestContext, "session"> {
  const db = createDatabase(":memory:");
  runMigrations(db);

  const sessionRepo = new SessionRepo(db);
  const messageRepo = new MessageRepo(db);
  const eventBus = new EventBus();
  const messageStore = new MessageStore(sessionRepo, messageRepo);
  const capture = new MessageCapture(eventBus, messageStore);

  return {
    capture,
    db,
    eventBus,
    messageStore,
  };
}

function publish(eventBus: EventBus, event: Omit<EventEnvelope, "cursor">): void {
  eventBus.publish({
    ...event,
    cursor: null,
  });
}

describe("MessageCapture", () => {
  const contexts: DisposableCaptureContext[] = [];

  afterEach(() => {
    vi.useRealTimers();

    while (contexts.length > 0) {
      const context = contexts.pop();
      context?.capture.dispose();
      context?.db.close();
    }
  });

  it("captures assistant and tool completions into the message store", () => {
    vi.useFakeTimers();
    const context = createTestContext();
    contexts.push(context);

    vi.setSystemTime(new Date("2026-03-13T18:00:00.000Z"));
    publish(
      context.eventBus,
      messageStartedEvent({
        sessionId: context.session.id,
        threadId: null,
        source: "backend",
        messageId: "assistant-1",
        role: "assistant",
      }),
    );

    vi.setSystemTime(new Date("2026-03-13T18:00:01.000Z"));
    publish(
      context.eventBus,
      messageDeltaEvent({
        sessionId: context.session.id,
        threadId: null,
        source: "backend",
        messageId: "assistant-1",
        delta: "Hello ",
      }),
    );

    vi.setSystemTime(new Date("2026-03-13T18:00:02.000Z"));
    publish(
      context.eventBus,
      messageDeltaEvent({
        sessionId: context.session.id,
        threadId: null,
        source: "backend",
        messageId: "assistant-1",
        delta: "world",
      }),
    );

    vi.setSystemTime(new Date("2026-03-13T18:00:03.000Z"));
    publish(
      context.eventBus,
      messageCompletedEvent({
        sessionId: context.session.id,
        threadId: null,
        source: "backend",
        messageId: "assistant-1",
        payload: {
          stopReason: "end_turn",
        },
      }),
    );

    vi.setSystemTime(new Date("2026-03-13T18:00:04.000Z"));
    publish(
      context.eventBus,
      toolStartedEvent({
        sessionId: context.session.id,
        threadId: null,
        source: "backend",
        toolName: "search",
        toolCallId: "tool-1",
        toolInput: { query: "swarmd" },
      }),
    );

    vi.setSystemTime(new Date("2026-03-13T18:00:05.000Z"));
    publish(
      context.eventBus,
      toolCompletedEvent({
        sessionId: context.session.id,
        threadId: null,
        source: "backend",
        toolName: "search",
        toolCallId: "tool-1",
        ok: true,
        result: { hits: 1 },
      }),
    );

    vi.setSystemTime(new Date("2026-03-13T18:00:06.000Z"));
    publish(
      context.eventBus,
      messageCompletedEvent({
        sessionId: context.session.id,
        threadId: null,
        source: "backend",
        messageId: "user-1",
        payload: {
          role: "user",
          text: "ignored duplicate user echo",
        },
      }),
    );

    expect(context.messageStore.list(context.session.id)).toEqual([
      expect.objectContaining({
        sessionId: context.session.id,
        source: "assistant",
        sourceMessageId: "assistant-1",
        kind: "text",
        role: "assistant",
        createdAt: "2026-03-13T18:00:03.000Z",
        content: {
          stopReason: "end_turn",
          text: "Hello world",
        },
      }),
      expect.objectContaining({
        sessionId: context.session.id,
        source: "tool",
        sourceMessageId: "tool-1",
        kind: "tool_result",
        role: "tool",
        createdAt: "2026-03-13T18:00:05.000Z",
        content: {
          toolName: "search",
          toolCallId: "tool-1",
          ok: true,
          input: { query: "swarmd" },
          result: { hits: 1 },
        },
      }),
    ]);
  });

  it("ignores late worker events after the session has been deleted", () => {
    const context = createTestContextWithoutSession();
    contexts.push(context);

    expect(() => {
      publish(
        context.eventBus,
        messageCompletedEvent({
          sessionId: "deleted-session",
          threadId: null,
          source: "backend",
          messageId: "assistant-1",
          payload: {
            role: "assistant",
            text: "ignored after deletion",
          },
        }),
      );
    }).not.toThrow();
  });

  it("rethrows unexpected persistence failures instead of silently dropping them", () => {
    const context = createTestContext();
    contexts.push(context);

    vi.spyOn(context.messageStore, "append").mockImplementation(() => {
      throw new Error("disk full");
    });

    expect(() => {
      publish(
        context.eventBus,
        messageCompletedEvent({
          sessionId: context.session.id,
          threadId: null,
          source: "backend",
          messageId: "assistant-1",
          payload: {
            role: "assistant",
            text: "should fail loudly",
          },
        }),
      );
    }).toThrow("disk full");
  });
});
