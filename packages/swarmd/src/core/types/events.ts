import { z } from "zod";

export const eventSources = ["server", "worker", "backend"] as const;
export type EventSource = (typeof eventSources)[number];
export const eventSourceSchema = z.enum(eventSources);

export interface EventEnvelope<TPayload = unknown> {
  id: string;
  cursor: string | null;
  sessionId: string;
  threadId: string | null;
  timestamp: string;
  source: EventSource;
  type: string;
  payload: TPayload;
}

export const eventEnvelopeSchema = z.object({
  id: z.string(),
  cursor: z.string().nullable(),
  sessionId: z.string(),
  threadId: z.string().nullable(),
  timestamp: z.string(),
  source: eventSourceSchema,
  type: z.string(),
  payload: z.unknown(),
});

export const normalizedEventTypes = [
  "session.created",
  "session.started",
  "session.status.changed",
  "session.stopped",
  "session.terminated",
  "session.errored",
  "turn.started",
  "turn.completed",
  "turn.interrupted",
  "turn.failed",
  "message.started",
  "message.delta",
  "message.completed",
  "tool.started",
  "tool.progress",
  "tool.completed",
  "operation.completed",
  "backend.raw",
] as const;

export type NormalizedEventType = (typeof normalizedEventTypes)[number];
export const normalizedEventTypeSchema = z.enum(normalizedEventTypes);
