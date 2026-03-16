import type { EventEnvelope } from "../../core/types/index.js";
import {
  createNormalizedEvent,
  messageCompletedEvent,
  messageDeltaEvent,
  messageStartedEvent,
  toolCompletedEvent,
  toolProgressEvent,
  toolStartedEvent,
  turnCompletedEvent,
  turnStartedEvent,
} from "../common/event-normalizer.js";

export interface PiTextContent {
  type: "text";
  text: string;
}

export interface PiImageContent {
  type: "image";
  mimeType: string;
  data: string;
}

export interface PiToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface PiThinkingContent {
  type: "thinking";
  thinking: string;
}

export interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface PiUserMessage {
  role: "user";
  content: string | Array<PiTextContent | PiImageContent>;
  timestamp: number;
}

export interface PiAssistantMessage {
  role: "assistant";
  content: Array<PiTextContent | PiThinkingContent | PiToolCallContent>;
  provider: string;
  model: string;
  api: string;
  usage: PiUsage;
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  errorMessage?: string;
  timestamp: number;
}

export interface PiToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: Array<PiTextContent | PiImageContent>;
  details?: unknown;
  isError: boolean;
  timestamp: number;
}

export type PiMessage = PiUserMessage | PiAssistantMessage | PiToolResultMessage | Record<string, unknown>;

export type PiAssistantMessageEvent =
  | { type: "start"; partial: PiAssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: PiAssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: PiAssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: PiAssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: PiAssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: PiAssistantMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: PiAssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: PiAssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: PiAssistantMessage }
  | {
      type: "toolcall_end";
      contentIndex: number;
      toolCall: PiToolCallContent;
      partial: PiAssistantMessage;
    }
  | { type: "done"; reason: "stop" | "length" | "toolUse"; message: PiAssistantMessage }
  | { type: "error"; reason: "aborted" | "error"; error: PiAssistantMessage };

export type PiSessionEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: PiMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: PiMessage; toolResults: PiToolResultMessage[] }
  | { type: "message_start"; message: PiMessage }
  | {
      type: "message_update";
      message: PiMessage;
      assistantMessageEvent: PiAssistantMessageEvent;
    }
  | { type: "message_end"; message: PiMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: unknown;
      partialResult: unknown;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    }
  | { type: "auto_compaction_start"; reason: "threshold" | "overflow" }
  | {
      type: "auto_compaction_end";
      result: unknown;
      aborted: boolean;
      willRetry: boolean;
      errorMessage?: string;
    }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string };

export interface PiMapperContext {
  sessionId: string;
  threadId: string | null;
}

function getMessageRole(message: PiMessage): string | undefined {
  return typeof message === "object" && message !== null && "role" in message
    ? String((message as { role: unknown }).role)
    : undefined;
}

function buildMessageCompletedPayload(message: PiMessage): Record<string, unknown> | undefined {
  const role = getMessageRole(message);
  if (role === undefined) {
    return undefined;
  }

  if (role === "assistant") {
    const assistantMessage = message as PiAssistantMessage;
    return {
      role,
      stopReason: assistantMessage.stopReason,
      ...(assistantMessage.errorMessage === undefined
        ? {}
        : { errorMessage: assistantMessage.errorMessage }),
    };
  }

  if (role === "toolResult") {
    const toolResultMessage = message as PiToolResultMessage;
    return {
      role,
      toolCallId: toolResultMessage.toolCallId,
      toolName: toolResultMessage.toolName,
      isError: toolResultMessage.isError,
    };
  }

  return { role };
}

export function extractPiMessageDelta(event: Extract<PiSessionEvent, { type: "message_update" }>): string | null {
  switch (event.assistantMessageEvent.type) {
    case "text_delta":
    case "thinking_delta":
    case "toolcall_delta":
      return event.assistantMessageEvent.delta;
    default:
      return null;
  }
}

export class PiEventMapper {
  private readonly sessionId: string;
  private readonly threadId: string | null;
  private turnCounter = 0;
  private messageCounter = 0;
  private currentTurnId: string | undefined;
  private currentMessageId: string | undefined;

  constructor(context: PiMapperContext) {
    this.sessionId = context.sessionId;
    this.threadId = context.threadId;
  }

  mapEvent(event: PiSessionEvent): Array<Omit<EventEnvelope, "cursor">> {
    switch (event.type) {
      case "agent_start":
        return [
          createNormalizedEvent({
            sessionId: this.sessionId,
            threadId: this.threadId,
            source: "backend",
            type: "session.started",
            payload: { backend: "pi" },
          }),
        ];
      case "agent_end":
        this.currentTurnId = undefined;
        this.currentMessageId = undefined;
        return [
          createNormalizedEvent({
            sessionId: this.sessionId,
            threadId: this.threadId,
            source: "backend",
            type: "session.stopped",
            payload: { backend: "pi" },
          }),
        ];
      case "turn_start": {
        const turnId = this.nextTurnId();
        this.currentTurnId = turnId;
        return [
          turnStartedEvent({
            sessionId: this.sessionId,
            threadId: this.threadId,
            source: "backend",
            turnId,
          }),
        ];
      }
      case "turn_end": {
        const turnId = this.getCurrentTurnId();
        const role = getMessageRole(event.message);
        this.currentTurnId = undefined;
        return [
          turnCompletedEvent({
            sessionId: this.sessionId,
            threadId: this.threadId,
            source: "backend",
            turnId,
            payload: {
              ...(role === undefined ? {} : { role }),
              toolResultCount: event.toolResults.length,
            },
          }),
        ];
      }
      case "message_start": {
        const messageId = this.nextMessageId();
        this.currentMessageId = messageId;
        return [
          messageStartedEvent({
            sessionId: this.sessionId,
            threadId: this.threadId,
            source: "backend",
            messageId,
            role: getMessageRole(event.message),
          }),
        ];
      }
      case "message_update": {
        const delta = extractPiMessageDelta(event);
        if (delta === null) {
          return [];
        }

        const messageId = this.getCurrentMessageId();
        return [
          messageDeltaEvent({
            sessionId: this.sessionId,
            threadId: this.threadId,
            source: "backend",
            messageId,
            delta,
            payload: {
              ...(getMessageRole(event.message) === undefined ? {} : { role: getMessageRole(event.message) }),
            },
          }),
        ];
      }
      case "message_end": {
        const messageId = this.getCurrentMessageId();
        this.currentMessageId = undefined;
        return [
          messageCompletedEvent({
            sessionId: this.sessionId,
            threadId: this.threadId,
            source: "backend",
            messageId,
            payload: buildMessageCompletedPayload(event.message),
          }),
        ];
      }
      case "tool_execution_start":
        return [
          toolStartedEvent({
            sessionId: this.sessionId,
            threadId: this.threadId,
            source: "backend",
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            toolInput: event.args,
          }),
        ];
      case "tool_execution_update":
        return [
          toolProgressEvent({
            sessionId: this.sessionId,
            threadId: this.threadId,
            source: "backend",
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            progress: event.partialResult,
            payload: {
              input: event.args,
            },
          }),
        ];
      case "tool_execution_end":
        return [
          toolCompletedEvent({
            sessionId: this.sessionId,
            threadId: this.threadId,
            source: "backend",
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            ok: !event.isError,
            result: event.result,
          }),
        ];
      default:
        return [];
    }
  }

  private nextTurnId(): string {
    this.turnCounter += 1;
    return `pi-turn-${this.turnCounter}`;
  }

  private nextMessageId(): string {
    this.messageCounter += 1;
    return `pi-message-${this.messageCounter}`;
  }

  private getCurrentTurnId(): string {
    if (this.currentTurnId === undefined) {
      this.currentTurnId = this.nextTurnId();
    }

    return this.currentTurnId;
  }

  private getCurrentMessageId(): string {
    if (this.currentMessageId === undefined) {
      this.currentMessageId = this.nextMessageId();
    }

    return this.currentMessageId;
  }
}
