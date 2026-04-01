import type { EventEnvelope } from "../../core/types/index.js";
import {
  backendRawEvent,
  createNormalizedEvent,
  messageCompletedEvent,
  messageDeltaEvent,
  messageStartedEvent,
  toolCompletedEvent,
  toolProgressEvent,
  toolStartedEvent,
  turnCompletedEvent,
} from "../common/index.js";

type UnknownRecord = Record<string, unknown>;

export interface ClaudeSdkMessage extends UnknownRecord {
  type: string;
  subtype?: string;
  session_id?: string;
  isReplay?: boolean;
}

export interface ClaudeEventContext {
  sessionId: string;
  threadId: string | null;
  turnId?: string | null;
}

export interface ClaudeEventMapperOptions {
  emitRawEvents?: boolean;
}

export class ClaudeEventMapper {
  private assistantMessageCounter = 0;
  private startedAssistantMessages = new Set<string>();
  private completedAssistantMessages = new Set<string>();
  private streamedAssistantMessages = new Set<string>();
  private activeStreamAssistantMessageId: string | null = null;
  private toolNameByCallId = new Map<string, string>();

  constructor(private readonly options: ClaudeEventMapperOptions = {}) {}

  mapEvent(
    context: ClaudeEventContext,
    event: ClaudeSdkMessage,
  ): Array<Omit<EventEnvelope, "cursor">> {
    const normalized: Array<Omit<EventEnvelope, "cursor">> = [];

    switch (describeClaudeEvent(event)) {
      case "system:init": {
        normalized.push(
          createNormalizedEvent({
            sessionId: context.sessionId,
            threadId: context.threadId,
            source: "backend",
            type: "session.started",
            payload: withDefinedFields({
              backend: "claude",
              claudeSessionId: extractClaudeSessionId(event),
            }),
          }),
        );
        break;
      }

      case "assistant": {
        if (event.isReplay === true) {
          break;
        }

        const messageId = this.resolveAssistantMessageId(event);
        if (this.streamedAssistantMessages.has(messageId)) {
          break;
        }

        const role = readNonEmptyString(readObject(event.message)?.role) ?? "assistant";
        const text = extractAssistantText(event);
        if (text.length === 0) {
          break;
        }

        if (!this.startedAssistantMessages.has(messageId)) {
          this.startedAssistantMessages.add(messageId);
          normalized.push(
            messageStartedEvent({
              sessionId: context.sessionId,
              threadId: context.threadId,
              source: "backend",
              messageId,
              role,
            }),
          );
        }

        if (text.length > 0) {
          normalized.push(
            messageDeltaEvent({
              sessionId: context.sessionId,
              threadId: context.threadId,
              source: "backend",
              messageId,
              delta: text,
            }),
          );
        }

        if (isAssistantMessageComplete(event) && !this.completedAssistantMessages.has(messageId)) {
          this.completedAssistantMessages.add(messageId);
          normalized.push(
            messageCompletedEvent({
              sessionId: context.sessionId,
              threadId: context.threadId,
              source: "backend",
              messageId,
            }),
          );
        }

        break;
      }

      case "user": {
        if (event.isReplay === true) {
          break;
        }

        const toolCallId = readNonEmptyString(event.parent_tool_use_id);
        if (!toolCallId || event.tool_use_result === undefined) {
          break;
        }

        const toolName = this.resolveToolName(event, toolCallId);
        this.toolNameByCallId.delete(toolCallId);
        normalized.push(
          toolCompletedEvent({
            sessionId: context.sessionId,
            threadId: context.threadId,
            source: "backend",
            toolName,
            toolCallId,
            ok: !isClaudeToolResultError(event.tool_use_result),
            result: event.tool_use_result,
          }),
        );
        break;
      }

      case "stream_event:message_start": {
        const messageId = extractStreamAssistantMessageId(event);
        if (!messageId) {
          break;
        }

        this.activeStreamAssistantMessageId = messageId;
        this.streamedAssistantMessages.add(messageId);

        if (!this.startedAssistantMessages.has(messageId)) {
          this.startedAssistantMessages.add(messageId);
          normalized.push(
            messageStartedEvent({
              sessionId: context.sessionId,
              threadId: context.threadId,
              source: "backend",
              messageId,
              role: "assistant",
            }),
          );
        }

        break;
      }

      case "stream_event:content_block_delta": {
        const messageId = this.activeStreamAssistantMessageId;
        const delta = extractTextDeltaFromStreamEvent(event);
        if (!messageId || delta.length === 0) {
          break;
        }

        if (!this.startedAssistantMessages.has(messageId)) {
          this.startedAssistantMessages.add(messageId);
          normalized.push(
            messageStartedEvent({
              sessionId: context.sessionId,
              threadId: context.threadId,
              source: "backend",
              messageId,
              role: "assistant",
            }),
          );
        }

        normalized.push(
          messageDeltaEvent({
            sessionId: context.sessionId,
            threadId: context.threadId,
            source: "backend",
            messageId,
            delta,
          }),
        );

        break;
      }

      case "stream_event:message_stop": {
        const messageId = this.activeStreamAssistantMessageId;
        this.activeStreamAssistantMessageId = null;

        if (!messageId || this.completedAssistantMessages.has(messageId)) {
          break;
        }

        this.completedAssistantMessages.add(messageId);
        normalized.push(
          messageCompletedEvent({
            sessionId: context.sessionId,
            threadId: context.threadId,
            source: "backend",
            messageId,
          }),
        );
        break;
      }

      case "task_started":
      case "system:task_started": {
        const toolCallId = resolveToolCallId(event);
        const toolName = this.resolveToolName(event, toolCallId);
        if (toolCallId) {
          this.toolNameByCallId.set(toolCallId, toolName);
        }

        normalized.push(
          toolStartedEvent({
            sessionId: context.sessionId,
            threadId: context.threadId,
            source: "backend",
            toolName,
            toolCallId,
            toolInput: withDefinedFields({
              taskId: readNonEmptyString(event.task_id),
              taskType: readNonEmptyString(event.task_type),
              description: readNonEmptyString(event.description),
              toolUseId: readNonEmptyString(event.tool_use_id),
            }),
          }),
        );
        break;
      }

      case "tool_progress":
      case "task_progress":
      case "system:task_progress": {
        const toolCallId = resolveToolCallId(event);
        const toolName = this.resolveToolName(event, toolCallId);
        if (toolCallId) {
          this.toolNameByCallId.set(toolCallId, toolName);
        }

        normalized.push(
          toolProgressEvent({
            sessionId: context.sessionId,
            threadId: context.threadId,
            source: "backend",
            toolName,
            toolCallId,
            progress: withDefinedFields({
              taskId: readNonEmptyString(event.task_id),
              description: readNonEmptyString(event.description),
              elapsedTimeSeconds: readFiniteNumber(event.elapsed_time_seconds),
              usage: readObject(event.usage),
              lastToolName: readNonEmptyString(event.last_tool_name),
            }),
          }),
        );
        break;
      }

      case "result": {
        if (context.turnId) {
          normalized.push(
            turnCompletedEvent({
              sessionId: context.sessionId,
              threadId: context.threadId,
              source: "backend",
              turnId: context.turnId,
              payload: withDefinedFields({
                claudeSessionId: extractClaudeSessionId(event),
                subtype: readNonEmptyString(event.subtype),
                stopReason: readNonEmptyString(event.stop_reason),
                resultId: readNonEmptyString(event.id),
              }),
            }),
          );
        }

        this.activeStreamAssistantMessageId = null;
        this.streamedAssistantMessages.clear();
        this.toolNameByCallId.clear();
        break;
      }

      default:
        break;
    }

    if (this.options.emitRawEvents === true) {
      normalized.push(
        backendRawEvent({
          sessionId: context.sessionId,
          threadId: context.threadId,
          payload: event,
        }),
      );
    }

    return normalized;
  }

  private resolveAssistantMessageId(event: ClaudeSdkMessage): string {
    return (
      readNonEmptyString(readObject(event.message)?.id) ??
      readNonEmptyString(event.message_id) ??
      readNonEmptyString(event.id) ??
      `claude-msg-${++this.assistantMessageCounter}`
    );
  }

  private resolveToolName(event: ClaudeSdkMessage, toolCallId?: string): string {
    const explicitName =
      readNonEmptyString(event.tool_name) ?? readNonEmptyString(event.last_tool_name);
    if (explicitName) {
      return explicitName;
    }

    if (toolCallId) {
      const remembered = this.toolNameByCallId.get(toolCallId);
      if (remembered) {
        return remembered;
      }
    }

    return readNonEmptyString(event.task_id)
      ? `task:${event.task_id}`
      : (toolCallId ?? "claude-tool");
  }
}

export function describeClaudeEvent(event: ClaudeSdkMessage): string {
  if (event.type === "stream_event") {
    const streamEventType = readNonEmptyString(readObject(event.event)?.type);
    return streamEventType ? `stream_event:${streamEventType}` : event.type;
  }

  if (event.type === "system" && typeof event.subtype === "string") {
    return `system:${event.subtype}`;
  }

  return event.type;
}

export function extractClaudeSessionId(event: ClaudeSdkMessage): string | undefined {
  return readNonEmptyString(event.session_id);
}

export function isClaudeInitEvent(event: ClaudeSdkMessage): boolean {
  return describeClaudeEvent(event) === "system:init";
}

export function isClaudeResultEvent(event: ClaudeSdkMessage): boolean {
  return describeClaudeEvent(event) === "result";
}

function extractAssistantText(event: ClaudeSdkMessage): string {
  const directDelta = event.delta;
  if (typeof directDelta === "string") {
    return directDelta;
  }

  const objectDelta = readObject(directDelta);
  if (objectDelta) {
    const deltaText = readNonEmptyString(objectDelta.text);
    if (deltaText) {
      return deltaText;
    }
  }

  const message = readObject(event.message);
  const content = message?.content ?? event.content;
  return extractTextFromContent(content);
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const chunks: string[] = [];

  for (const block of content) {
    const typed = readObject(block);
    if (!typed) {
      continue;
    }

    if (typed.type === "text" && typeof typed.text === "string") {
      chunks.push(typed.text);
      continue;
    }

    const delta = readObject(typed.delta);
    if (delta?.type === "text_delta" && typeof delta.text === "string") {
      chunks.push(delta.text);
    }
  }

  return chunks.join("");
}

function extractStreamAssistantMessageId(event: ClaudeSdkMessage): string | undefined {
  return readNonEmptyString(readObject(readObject(event.event)?.message)?.id);
}

function extractTextDeltaFromStreamEvent(event: ClaudeSdkMessage): string {
  const delta = readObject(readObject(event.event)?.delta);
  return delta?.type === "text_delta" && typeof delta.text === "string" ? delta.text : "";
}

function isAssistantMessageComplete(event: ClaudeSdkMessage): boolean {
  if (event.partial === true) {
    return false;
  }

  if (event.complete === false || event.done === false || event.is_final === false) {
    return false;
  }

  const hasExplicitCompletionFlag =
    event.complete === true || event.done === true || event.is_final === true;

  if (hasExplicitCompletionFlag) {
    return true;
  }

  return typeof event.delta !== "string";
}

function resolveToolCallId(event: ClaudeSdkMessage): string | undefined {
  return readNonEmptyString(event.tool_use_id) ?? readNonEmptyString(event.task_id);
}

function isClaudeToolResultError(value: unknown): boolean {
  const object = readObject(value);
  return object?.isError === true || object?.is_error === true;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readObject(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function withDefinedFields(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
