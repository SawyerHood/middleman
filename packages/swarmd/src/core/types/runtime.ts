import { z } from "zod";

import type { EventEnvelope } from "./events.js";
import { eventEnvelopeSchema } from "./events.js";
import type { DeliveryMode, UserInput } from "./messages.js";
import { deliveryModeSchema, userInputSchema } from "./messages.js";
import type {
  BackendCheckpoint,
  SessionContextUsage,
  SessionErrorInfo,
  SessionRecord,
  SessionRuntimeConfig,
  SessionStatus,
} from "./sessions.js";
import {
  backendCheckpointSchema,
  sessionContextUsageSchema,
  sessionErrorInfoSchema,
  sessionRecordSchema,
  sessionRuntimeConfigSchema,
  sessionStatusSchema,
} from "./sessions.js";

export interface BackendCapabilities {
  canResumeThread: boolean;
  canForkThread: boolean;
  canInterrupt: boolean;
  canQueueInput: boolean;
  canManualCompact: boolean;
  canReadHistory: boolean;
  emitsToolProgress: boolean;
  exposesRawEvents: boolean;
}

export const backendCapabilitiesSchema = z.object({
  canResumeThread: z.boolean(),
  canForkThread: z.boolean(),
  canInterrupt: z.boolean(),
  canQueueInput: z.boolean(),
  canManualCompact: z.boolean(),
  canReadHistory: z.boolean(),
  emitsToolProgress: z.boolean(),
  exposesRawEvents: z.boolean(),
});

export interface OperationRecord {
  id: string;
  sessionId: string;
  type: string;
  status: "pending" | "completed" | "failed";
  resultJson: string | null;
  errorJson: string | null;
  createdAt: string;
  completedAt: string | null;
}

export const operationRecordSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  type: z.string(),
  status: z.enum(["pending", "completed", "failed"]),
  resultJson: z.string().nullable(),
  errorJson: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});

export interface HostCallRequest {
  requestId: string;
  method: "tool_call";
  payload: {
    toolName: string;
    args: Record<string, unknown>;
  };
}

export const hostCallRequestSchema = z.object({
  requestId: z.string(),
  method: z.literal("tool_call"),
  payload: z.object({
    toolName: z.string(),
    args: z.record(z.string(), z.unknown()),
  }),
});

export type WorkerCommand =
  | {
      type: "bootstrap";
      session: SessionRecord;
      config: SessionRuntimeConfig;
    }
  | {
      type: "send_input";
      input: UserInput;
      delivery: DeliveryMode;
      operationId: string;
    }
  | { type: "interrupt"; operationId: string }
  | { type: "stop"; operationId: string }
  | { type: "terminate"; operationId: string }
  | {
      type: "host_call_result";
      requestId: string;
      ok: boolean;
      payload?: unknown;
      error?: SessionErrorInfo;
    }
  | { type: "ping" };

export const workerCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("bootstrap"),
    session: sessionRecordSchema,
    config: sessionRuntimeConfigSchema,
  }),
  z.object({
    type: z.literal("send_input"),
    input: userInputSchema,
    delivery: deliveryModeSchema,
    operationId: z.string(),
  }),
  z.object({
    type: z.literal("interrupt"),
    operationId: z.string(),
  }),
  z.object({
    type: z.literal("stop"),
    operationId: z.string(),
  }),
  z.object({
    type: z.literal("terminate"),
    operationId: z.string(),
  }),
  z.object({
    type: z.literal("host_call_result"),
    requestId: z.string(),
    ok: z.boolean(),
    payload: z.unknown().optional(),
    error: sessionErrorInfoSchema.optional(),
  }),
  z.object({
    type: z.literal("ping"),
  }),
]);

export type WorkerEvent =
  | { type: "ready"; capabilities: BackendCapabilities; checkpoint?: BackendCheckpoint }
  | { type: "fatal_error"; error: SessionErrorInfo }
  | {
      type: "session_status";
      status: SessionStatus;
      error?: SessionErrorInfo;
      contextUsage?: SessionContextUsage | null;
    }
  | { type: "checkpoint"; checkpoint: BackendCheckpoint }
  | { type: "backend_state"; state: Record<string, unknown> }
  | { type: "normalized_event"; event: EventEnvelope }
  | ({
      type: "host_call";
    } & HostCallRequest)
  | {
      type: "command_result";
      operationId: string;
      ok: boolean;
      payload?: unknown;
      error?: SessionErrorInfo;
    }
  | { type: "pong" };

export const workerEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    capabilities: backendCapabilitiesSchema,
    checkpoint: backendCheckpointSchema.optional(),
  }),
  z.object({
    type: z.literal("fatal_error"),
    error: sessionErrorInfoSchema,
  }),
  z.object({
    type: z.literal("session_status"),
    status: sessionStatusSchema,
    error: sessionErrorInfoSchema.optional(),
    contextUsage: sessionContextUsageSchema.nullable().optional(),
  }),
  z.object({
    type: z.literal("checkpoint"),
    checkpoint: backendCheckpointSchema,
  }),
  z.object({
    type: z.literal("backend_state"),
    state: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal("normalized_event"),
    event: eventEnvelopeSchema,
  }),
  z.object({
    type: z.literal("host_call"),
    requestId: z.string(),
    method: z.literal("tool_call"),
    payload: z.object({
      toolName: z.string(),
      args: z.record(z.string(), z.unknown()),
    }),
  }),
  z.object({
    type: z.literal("command_result"),
    operationId: z.string(),
    ok: z.boolean(),
    payload: z.unknown().optional(),
    error: sessionErrorInfoSchema.optional(),
  }),
  z.object({
    type: z.literal("pong"),
  }),
]);
