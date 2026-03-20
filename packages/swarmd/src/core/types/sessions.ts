import { z } from "zod";

import type { DeliveryMode } from "./messages.js";
import { deliveryModeSchema } from "./messages.js";

const metadataSchema = z.record(z.string(), z.unknown());

export type BackendCheckpoint =
  | { backend: "codex"; threadId: string }
  | { backend: "claude"; sessionId: string; resumeAtMessageId?: string }
  | { backend: "pi"; sessionFile: string; branchEntryId?: string };

export const backendCheckpointSchema = z.discriminatedUnion("backend", [
  z.object({
    backend: z.literal("codex"),
    threadId: z.string(),
  }),
  z.object({
    backend: z.literal("claude"),
    sessionId: z.string(),
    resumeAtMessageId: z.string().optional(),
  }),
  z.object({
    backend: z.literal("pi"),
    sessionFile: z.string(),
    branchEntryId: z.string().optional(),
  }),
]);

export const backendKinds = ["codex", "claude", "pi"] as const;
export type BackendKind = (typeof backendKinds)[number];
export const backendKindSchema = z.enum(backendKinds);

export const sessionStatuses = [
  "created",
  "starting",
  "idle",
  "busy",
  "interrupting",
  "stopping",
  "stopped",
  "errored",
  "terminated",
] as const;
export type SessionStatus = (typeof sessionStatuses)[number];
export const sessionStatusSchema = z.enum(sessionStatuses);

export interface SessionContextUsage {
  tokens: number;
  contextWindow: number;
  percent: number;
}

export const sessionContextUsageSchema = z.object({
  tokens: z.number().finite().nonnegative(),
  contextWindow: z.number().finite().positive(),
  percent: z.number().finite().min(0).max(100),
});

export interface SessionErrorInfo {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export const sessionErrorInfoSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  details: metadataSchema.optional(),
});

export interface SessionRecord {
  id: string;
  backend: BackendKind;
  status: SessionStatus;
  displayName: string;
  cwd: string;
  model: string;
  systemPrompt?: string;
  backendCheckpoint: BackendCheckpoint | null;
  createdAt: string;
  updatedAt: string;
  lastError: SessionErrorInfo | null;
  contextUsage: SessionContextUsage | null;
}

export const sessionRecordSchema = z.object({
  id: z.string(),
  backend: backendKindSchema,
  status: sessionStatusSchema,
  displayName: z.string(),
  cwd: z.string(),
  model: z.string(),
  systemPrompt: z.string().optional(),
  backendCheckpoint: backendCheckpointSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastError: sessionErrorInfoSchema.nullable(),
  contextUsage: sessionContextUsageSchema.nullable(),
});

export interface CreateSessionInput {
  id?: string;
  backend: BackendKind;
  displayName?: string;
  cwd: string;
  model?: string;
  systemPrompt?: string;
  autoStart?: boolean;
  deliveryDefaults?: { busyMode: DeliveryMode };
  backendConfig?: Record<string, unknown>;
}

export const createSessionInputSchema = z.object({
  id: z.string().min(1).optional(),
  backend: backendKindSchema,
  displayName: z.string().optional(),
  cwd: z.string(),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  autoStart: z.boolean().optional(),
  deliveryDefaults: z
    .object({
      busyMode: deliveryModeSchema,
    })
    .optional(),
  backendConfig: metadataSchema.optional(),
});

export interface SessionRuntimeConfig {
  backend: BackendKind;
  cwd: string;
  model: string;
  systemPrompt?: string;
  deliveryDefaults?: { busyMode: DeliveryMode };
  backendConfig: Record<string, unknown>;
  backendState?: Record<string, unknown>;
}

export const sessionRuntimeConfigSchema = z.object({
  backend: backendKindSchema,
  cwd: z.string(),
  model: z.string(),
  systemPrompt: z.string().optional(),
  deliveryDefaults: z
    .object({
      busyMode: deliveryModeSchema,
    })
    .optional(),
  backendConfig: metadataSchema,
  backendState: metadataSchema.optional(),
});
