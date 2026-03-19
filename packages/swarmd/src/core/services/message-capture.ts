import type { EventBus } from "../events/index.js";
import type { AppendMessageInput, EventEnvelope, StoredMessageActor } from "../types/index.js";
import { MessageStoreSessionNotFoundError, type MessageStore } from "./message-store.js";

interface TrackedMessageState {
  role?: StoredMessageActor;
  text: string;
}

interface TrackedToolState {
  toolName: string;
  input?: unknown;
}

function readObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isStoredMessageActor(value: unknown): value is StoredMessageActor {
  return value === "user" || value === "assistant" || value === "system" || value === "tool";
}

function messageTrackingKey(sessionId: string, sourceMessageId: string): string {
  return `${sessionId}:${sourceMessageId}`;
}

function omitKeys(
  source: Record<string, unknown>,
  omittedKeys: readonly string[],
): Record<string, unknown> {
  const next: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    if (!omittedKeys.includes(key)) {
      next[key] = value;
    }
  }

  return next;
}

export class MessageCapture {
  private readonly trackedMessages = new Map<string, TrackedMessageState>();
  private readonly trackedTools = new Map<string, TrackedToolState>();
  private readonly unsubscribe: () => void;

  constructor(
    private eventBus: EventBus,
    private messageStore: MessageStore,
  ) {
    this.unsubscribe = this.eventBus.subscribe((event) => {
      this.handleEvent(event);
    });
  }

  dispose(): void {
    this.unsubscribe();
    this.trackedMessages.clear();
    this.trackedTools.clear();
  }

  private handleEvent(event: EventEnvelope): void {
    switch (event.type) {
      case "message.started":
        this.trackMessageStart(event);
        break;
      case "message.delta":
        this.trackMessageDelta(event);
        break;
      case "message.completed":
        this.persistCompletedMessage(event);
        break;
      case "tool.started":
        this.trackToolStart(event);
        break;
      case "tool.completed":
        this.persistCompletedTool(event);
        break;
      default:
        break;
    }
  }

  private trackMessageStart(event: EventEnvelope): void {
    const payload = readObject(event.payload);
    const sourceMessageId = readString(payload?.messageId);
    if (!sourceMessageId) {
      return;
    }

    const key = messageTrackingKey(event.sessionId, sourceMessageId);
    const tracked = this.trackedMessages.get(key) ?? { text: "" };
    const role = payload?.role;
    if (isStoredMessageActor(role)) {
      tracked.role = role;
    }

    this.trackedMessages.set(key, tracked);
  }

  private trackMessageDelta(event: EventEnvelope): void {
    const payload = readObject(event.payload);
    const sourceMessageId = readString(payload?.messageId);
    const delta = readString(payload?.delta);
    if (!sourceMessageId || delta === undefined) {
      return;
    }

    const key = messageTrackingKey(event.sessionId, sourceMessageId);
    const tracked = this.trackedMessages.get(key) ?? { text: "" };
    const role = payload?.role;
    if (isStoredMessageActor(role)) {
      tracked.role = role;
    }

    tracked.text += delta;
    this.trackedMessages.set(key, tracked);
  }

  private persistCompletedMessage(event: EventEnvelope): void {
    const payload = readObject(event.payload);
    const sourceMessageId = readString(payload?.messageId);
    if (!sourceMessageId) {
      return;
    }

    const key = messageTrackingKey(event.sessionId, sourceMessageId);
    const tracked = this.trackedMessages.get(key);
    this.trackedMessages.delete(key);

    const role = this.resolveCompletedMessageRole(payload?.role, tracked?.role);
    if (role === "user" || role === "tool") {
      return;
    }

    const content = {
      ...omitKeys(payload ?? {}, ["messageId", "role", "text"]),
      text: typeof payload?.text === "string" ? payload.text : (tracked?.text ?? ""),
    };

    this.safeAppend(event.sessionId, {
      source: role,
      sourceMessageId,
      kind: "text",
      role,
      content,
      createdAt: event.timestamp,
    });
  }

  private trackToolStart(event: EventEnvelope): void {
    const payload = readObject(event.payload);
    const toolCallId = readString(payload?.toolCallId);
    const toolName = readString(payload?.toolName);
    if (!toolCallId || !toolName) {
      return;
    }

    this.trackedTools.set(messageTrackingKey(event.sessionId, toolCallId), {
      toolName,
      input: payload?.input,
    });
  }

  private persistCompletedTool(event: EventEnvelope): void {
    const payload = readObject(event.payload);
    const toolCallId = readString(payload?.toolCallId);
    const toolName = readString(payload?.toolName);
    const tracked = toolCallId
      ? this.trackedTools.get(messageTrackingKey(event.sessionId, toolCallId))
      : undefined;

    if (toolCallId) {
      this.trackedTools.delete(messageTrackingKey(event.sessionId, toolCallId));
    }

    const resolvedToolName = toolName ?? tracked?.toolName;
    if (!resolvedToolName) {
      return;
    }

    const content = {
      ...omitKeys(payload ?? {}, ["toolName", "toolCallId", "ok", "result", "input"]),
      toolName: resolvedToolName,
      toolCallId: toolCallId ?? null,
      ok: payload?.ok === true,
      ...(tracked?.input === undefined && payload?.input === undefined
        ? {}
        : { input: tracked?.input ?? payload?.input }),
      ...(payload?.result === undefined ? {} : { result: payload.result }),
    };

    this.safeAppend(event.sessionId, {
      source: "tool",
      sourceMessageId: toolCallId ?? null,
      kind: "tool_result",
      role: "tool",
      content,
      createdAt: event.timestamp,
    });
  }

  private resolveCompletedMessageRole(
    payloadRole: unknown,
    trackedRole: StoredMessageActor | undefined,
  ): StoredMessageActor {
    if (isStoredMessageActor(payloadRole)) {
      return payloadRole;
    }

    return trackedRole ?? "assistant";
  }

  private safeAppend(sessionId: string, input: AppendMessageInput): void {
    try {
      // Ignore late worker events that arrive after the session has been deleted.
      this.messageStore.append(sessionId, input);
    } catch (error) {
      if (error instanceof MessageStoreSessionNotFoundError) {
        return;
      }

      throw error;
    }
  }
}
