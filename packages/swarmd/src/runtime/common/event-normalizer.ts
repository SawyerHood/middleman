import type {
  EventEnvelope,
  EventSource,
  NormalizedEventType,
  SessionStatus,
} from "../../core/types/index.js";
import { generateEventId } from "../../core/ids.js";

export interface NormalizeEventInput {
  sessionId: string;
  threadId: string | null;
  type: NormalizedEventType;
  source?: EventSource;
  payload: unknown;
}

interface BaseBuilderInput {
  sessionId: string;
  threadId: string | null;
  source?: EventSource;
}

type EventPayloadExtras = Record<string, unknown>;

export interface TurnStartedEventInput extends BaseBuilderInput {
  turnId: string;
  payload?: EventPayloadExtras;
}

export interface TurnCompletedEventInput extends BaseBuilderInput {
  turnId: string;
  payload?: EventPayloadExtras;
}

export interface MessageStartedEventInput extends BaseBuilderInput {
  messageId: string;
  role?: string;
  payload?: EventPayloadExtras;
}

export interface MessageDeltaEventInput extends BaseBuilderInput {
  messageId: string;
  delta: string;
  payload?: EventPayloadExtras;
}

export interface MessageCompletedEventInput extends BaseBuilderInput {
  messageId: string;
  payload?: EventPayloadExtras;
}

export interface ToolStartedEventInput extends BaseBuilderInput {
  toolName: string;
  toolCallId?: string;
  toolInput?: unknown;
  payload?: EventPayloadExtras;
}

export interface ToolProgressEventInput extends BaseBuilderInput {
  toolName: string;
  toolCallId?: string;
  progress: unknown;
  payload?: EventPayloadExtras;
}

export interface ToolCompletedEventInput extends BaseBuilderInput {
  toolName: string;
  toolCallId?: string;
  ok: boolean;
  result?: unknown;
  payload?: EventPayloadExtras;
}

export interface SessionStatusEventInput extends BaseBuilderInput {
  status: SessionStatus;
  previousStatus?: SessionStatus;
  payload?: EventPayloadExtras;
}

export interface BackendRawEventInput extends BaseBuilderInput {
  payload: unknown;
}

export function createNormalizedEvent(input: NormalizeEventInput): Omit<EventEnvelope, "cursor"> {
  return {
    id: generateEventId(),
    sessionId: input.sessionId,
    threadId: input.threadId,
    timestamp: new Date().toISOString(),
    source: input.source ?? "worker",
    type: input.type,
    payload: input.payload,
  };
}

function withPayload(
  required: Record<string, unknown>,
  payload?: EventPayloadExtras,
): Record<string, unknown> {
  return { ...(payload ?? {}), ...required };
}

export function turnStartedEvent(input: TurnStartedEventInput): Omit<EventEnvelope, "cursor"> {
  return createNormalizedEvent({
    sessionId: input.sessionId,
    threadId: input.threadId,
    source: input.source,
    type: "turn.started",
    payload: withPayload({ turnId: input.turnId }, input.payload),
  });
}

export function turnCompletedEvent(input: TurnCompletedEventInput): Omit<EventEnvelope, "cursor"> {
  return createNormalizedEvent({
    sessionId: input.sessionId,
    threadId: input.threadId,
    source: input.source,
    type: "turn.completed",
    payload: withPayload({ turnId: input.turnId }, input.payload),
  });
}

export function messageStartedEvent(input: MessageStartedEventInput): Omit<EventEnvelope, "cursor"> {
  return createNormalizedEvent({
    sessionId: input.sessionId,
    threadId: input.threadId,
    source: input.source,
    type: "message.started",
    payload: withPayload(
      {
        messageId: input.messageId,
        ...(input.role === undefined ? {} : { role: input.role }),
      },
      input.payload,
    ),
  });
}

export function messageDeltaEvent(input: MessageDeltaEventInput): Omit<EventEnvelope, "cursor"> {
  return createNormalizedEvent({
    sessionId: input.sessionId,
    threadId: input.threadId,
    source: input.source,
    type: "message.delta",
    payload: withPayload({ messageId: input.messageId, delta: input.delta }, input.payload),
  });
}

export function messageCompletedEvent(input: MessageCompletedEventInput): Omit<EventEnvelope, "cursor"> {
  return createNormalizedEvent({
    sessionId: input.sessionId,
    threadId: input.threadId,
    source: input.source,
    type: "message.completed",
    payload: withPayload({ messageId: input.messageId }, input.payload),
  });
}

export function toolStartedEvent(input: ToolStartedEventInput): Omit<EventEnvelope, "cursor"> {
  return createNormalizedEvent({
    sessionId: input.sessionId,
    threadId: input.threadId,
    source: input.source,
    type: "tool.started",
    payload: withPayload(
      {
        toolName: input.toolName,
        ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
        ...(input.toolInput === undefined ? {} : { input: input.toolInput }),
      },
      input.payload,
    ),
  });
}

export function toolProgressEvent(input: ToolProgressEventInput): Omit<EventEnvelope, "cursor"> {
  return createNormalizedEvent({
    sessionId: input.sessionId,
    threadId: input.threadId,
    source: input.source,
    type: "tool.progress",
    payload: withPayload(
      {
        toolName: input.toolName,
        progress: input.progress,
        ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
      },
      input.payload,
    ),
  });
}

export function toolCompletedEvent(input: ToolCompletedEventInput): Omit<EventEnvelope, "cursor"> {
  return createNormalizedEvent({
    sessionId: input.sessionId,
    threadId: input.threadId,
    source: input.source,
    type: "tool.completed",
    payload: withPayload(
      {
        toolName: input.toolName,
        ok: input.ok,
        ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
        ...(input.result === undefined ? {} : { result: input.result }),
      },
      input.payload,
    ),
  });
}

export function sessionStatusEvent(input: SessionStatusEventInput): Omit<EventEnvelope, "cursor"> {
  return createNormalizedEvent({
    sessionId: input.sessionId,
    threadId: input.threadId,
    source: input.source,
    type: "session.status.changed",
    payload: withPayload(
      {
        status: input.status,
        ...(input.previousStatus === undefined ? {} : { previousStatus: input.previousStatus }),
      },
      input.payload,
    ),
  });
}

export function backendRawEvent(input: BackendRawEventInput): Omit<EventEnvelope, "cursor"> {
  return createNormalizedEvent({
    sessionId: input.sessionId,
    threadId: input.threadId,
    source: input.source ?? "backend",
    type: "backend.raw",
    payload: input.payload,
  });
}
