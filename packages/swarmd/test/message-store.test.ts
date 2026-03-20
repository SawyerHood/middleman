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
});
