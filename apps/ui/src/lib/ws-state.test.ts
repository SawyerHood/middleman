import { createStore } from "jotai/vanilla";
import { describe, expect, it } from "vitest";
import type {
  AgentDescriptor,
  ConversationLogEvent,
  ConversationMessageEvent,
} from "@middleman/protocol";
import {
  agentsAtom,
  artifactsAtom,
  messagesAtom,
  targetAgentIdAtom,
  visibleMessagesAtom,
  type ConversationHistoryEntry,
} from "./ws-state";

const manager: AgentDescriptor = {
  agentId: "manager",
  displayName: "Manager",
  role: "manager",
  managerId: "manager",
  status: "idle",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  cwd: "/tmp/project",
  model: {
    provider: "openai",
    modelId: "gpt-5",
    thinkingLevel: "high",
  },
};

function buildConversationMessage(text: string): ConversationMessageEvent {
  return {
    type: "conversation_message",
    agentId: "manager",
    role: "assistant",
    text,
    timestamp: "2026-01-01T00:00:00.000Z",
    source: "speak_to_user",
  };
}

function buildConversationLog(text: string): ConversationLogEvent {
  return {
    type: "conversation_log",
    agentId: "manager",
    timestamp: "2026-01-01T00:00:01.000Z",
    source: "runtime_log",
    kind: "message_start",
    text,
    isError: false,
  };
}

function createManagerStore() {
  const store = createStore();
  store.set(agentsAtom, [manager]);
  store.set(targetAgentIdAtom, manager.agentId);
  return store;
}

describe("ws-state derived atoms", () => {
  it("keeps the visible message slice stable when only hidden logs are appended", () => {
    const store = createManagerStore();
    const visibleMessage = buildConversationMessage("hello");
    store.set(messagesAtom, [visibleMessage] satisfies ConversationHistoryEntry[]);

    const initialVisibleMessages = store.get(visibleMessagesAtom);
    let notifications = 0;
    const unsubscribe = store.sub(visibleMessagesAtom, () => {
      notifications += 1;
    });

    store.set(messagesAtom, [
      visibleMessage,
      buildConversationLog("assistant started"),
    ] satisfies ConversationHistoryEntry[]);

    expect(store.get(visibleMessagesAtom)).toBe(initialVisibleMessages);
    expect(notifications).toBe(0);

    unsubscribe();
  });

  it("keeps collected artifacts stable when message changes do not affect artifact links", () => {
    const store = createManagerStore();
    const visibleMessage = buildConversationMessage("hello");
    store.set(messagesAtom, [visibleMessage] satisfies ConversationHistoryEntry[]);

    const initialArtifacts = store.get(artifactsAtom);
    let notifications = 0;
    const unsubscribe = store.sub(artifactsAtom, () => {
      notifications += 1;
    });

    store.set(messagesAtom, [
      visibleMessage,
      buildConversationLog("assistant started"),
    ] satisfies ConversationHistoryEntry[]);

    expect(store.get(artifactsAtom)).toBe(initialArtifacts);
    expect(notifications).toBe(0);

    unsubscribe();
  });
});
