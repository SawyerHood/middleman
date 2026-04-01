import { afterEach, describe, expect, it } from "vitest";

import {
  MessageRepo,
  MessageStore,
  SessionRepo,
  createDatabase,
  runMigrations,
  type Database,
  type SessionRecord,
} from "../src/index.js";

function createSession(sessionId = "message-store-session"): SessionRecord {
  return {
    id: sessionId,
    backend: "codex",
    status: "idle",
    displayName: "Message Store Session",
    cwd: "/tmp/swarmd-message-store",
    model: "gpt-5",
    backendCheckpoint: null,
    createdAt: "2026-03-13T00:00:00.000Z",
    updatedAt: "2026-03-13T00:00:00.000Z",
    lastError: null,
    contextUsage: null,
  };
}

describe("MessageStore", () => {
  const openDatabases: Database[] = [];

  afterEach(() => {
    while (openDatabases.length > 0) {
      openDatabases.pop()?.close();
    }
  });

  it("appends, lists, reads, and annotates stored messages", () => {
    const db = createDatabase(":memory:");
    openDatabases.push(db);
    runMigrations(db);

    const sessionRepo = new SessionRepo(db);
    const messageRepo = new MessageRepo(db);
    const messageStore = new MessageStore(sessionRepo, messageRepo);
    const session = createSession();
    sessionRepo.create(session);

    const first = messageStore.append(session.id, {
      source: "user",
      kind: "text",
      role: "user",
      content: { text: "hello" },
      metadata: { origin: "cli" },
      createdAt: "2026-03-13T00:01:00.000Z",
    });
    const second = messageStore.append(session.id, {
      source: "assistant",
      sourceMessageId: "backend-msg-1",
      kind: "text",
      role: "assistant",
      content: { text: "hi there" },
      metadata: { origin: "capture" },
      createdAt: "2026-03-13T00:01:00.000Z",
    });

    expect(first.orderKey < second.orderKey).toBe(true);
    expect(messageStore.list(session.id)).toEqual([first, second]);
    expect(messageStore.list(session.id, { after: first.orderKey, limit: 1 })).toEqual([second]);
    expect(messageStore.getById(second.id)).toEqual(second);

    const annotated = messageStore.annotate(second.id, {
      origin: "ui",
      reviewed: true,
    });

    expect(annotated).toEqual({
      ...second,
      metadata: {
        origin: "ui",
        reviewed: true,
      },
    });
  });

  it("allocates unique order keys for older timestamps during backfill-style inserts", () => {
    const db = createDatabase(":memory:");
    openDatabases.push(db);
    runMigrations(db);

    const sessionRepo = new SessionRepo(db);
    const messageRepo = new MessageRepo(db);
    const messageStore = new MessageStore(sessionRepo, messageRepo);
    const session = createSession("message-store-backfill");
    sessionRepo.create(session);

    const first = messageStore.append(session.id, {
      source: "assistant",
      kind: "text",
      role: "assistant",
      content: { text: "first at t1" },
      createdAt: "2026-03-13T00:01:00.000Z",
    });
    const second = messageStore.append(session.id, {
      source: "assistant",
      kind: "text",
      role: "assistant",
      content: { text: "later at t2" },
      createdAt: "2026-03-13T00:02:00.000Z",
    });
    const backfilled = messageStore.append(session.id, {
      source: "assistant",
      kind: "text",
      role: "assistant",
      content: { text: "backfilled at t1" },
      createdAt: "2026-03-13T00:01:00.000Z",
    });

    expect(first.orderKey).toBe("2026-03-13T00:01:00.000Z-000000");
    expect(second.orderKey).toBe("2026-03-13T00:02:00.000Z-000000");
    expect(backfilled.orderKey).toBe("2026-03-13T00:01:00.000Z-000001");
    expect(messageStore.list(session.id).map((message) => message.id)).toEqual([
      first.id,
      backfilled.id,
      second.id,
    ]);
  });

  it("pages visible transcript rows at the store boundary", () => {
    const db = createDatabase(":memory:");
    openDatabases.push(db);
    runMigrations(db);

    const sessionRepo = new SessionRepo(db);
    const messageRepo = new MessageRepo(db);
    const messageStore = new MessageStore(sessionRepo, messageRepo);
    const session = createSession("message-store-visible-transcript");
    sessionRepo.create(session);

    const userMessage = messageStore.append(session.id, {
      source: "user",
      kind: "text",
      role: "user",
      content: { text: "hello" },
      metadata: {
        middleman: {
          renderAs: "conversation_message",
        },
      },
      createdAt: "2026-03-13T00:01:00.000Z",
    });
    const assistantMessage = messageStore.append(session.id, {
      source: "assistant",
      kind: "text",
      role: "assistant",
      content: { text: "latest reply" },
      createdAt: "2026-03-13T00:02:00.000Z",
    });
    const speakToUserResult = messageStore.append(session.id, {
      source: "tool",
      kind: "tool_result",
      role: "tool",
      content: {
        toolName: "speak_to_user",
        result: {
          details: {
            text: "visible tool result",
          },
        },
      },
      createdAt: "2026-03-13T00:03:00.000Z",
    });
    const sendMessageResult = messageStore.append(session.id, {
      source: "tool",
      kind: "tool_result",
      role: "tool",
      content: {
        toolName: "send_message_to_agent",
        input: {
          targetAgentId: "manager-1",
          message: "queued for manager",
        },
      },
      createdAt: "2026-03-13T00:04:00.000Z",
    });
    messageStore.append(session.id, {
      source: "tool",
      kind: "tool_result",
      role: "tool",
      content: {
        toolName: "spawn_agent",
      },
      createdAt: "2026-03-13T00:05:00.000Z",
    });

    expect(
      messageStore.listVisibleTranscriptMessages(session.id).map((message) => message.id),
    ).toEqual([userMessage.id, assistantMessage.id, speakToUserResult.id]);
    expect(
      messageStore
        .listVisibleTranscriptMessages(session.id, {
          includeSendMessageToolResults: true,
        })
        .map((message) => message.id),
    ).toEqual([userMessage.id, assistantMessage.id, speakToUserResult.id, sendMessageResult.id]);
    expect(
      messageStore
        .listVisibleTranscriptMessages(session.id, {
          includeSendMessageToolResults: true,
          limit: 2,
        })
        .map((message) => message.id),
    ).toEqual([speakToUserResult.id, sendMessageResult.id]);
    expect(
      messageStore
        .listVisibleTranscriptMessages(session.id, {
          includeSendMessageToolResults: true,
          beforeOrderKey: sendMessageResult.orderKey,
          limit: 2,
        })
        .map((message) => message.id),
    ).toEqual([assistantMessage.id, speakToUserResult.id]);
  });
});
