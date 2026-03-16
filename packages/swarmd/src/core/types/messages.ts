import { z } from "zod";

export const metadataSchema = z.record(z.string(), z.unknown());

export const deliveryModes = ["auto", "interrupt", "queue"] as const;
export type DeliveryMode = (typeof deliveryModes)[number];
export const deliveryModeSchema = z.enum(deliveryModes);

export const storedMessageActors = ["user", "assistant", "system", "tool"] as const;
export type StoredMessageActor = (typeof storedMessageActors)[number];
export const storedMessageActorSchema = z.enum(storedMessageActors);

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }
  | {
      type: "file";
      mimeType: string;
      fileName?: string;
      path?: string;
      data?: string;
    };

export const contentPartSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("image"),
    mimeType: z.string(),
    data: z.string(),
  }),
  z.object({
    type: z.literal("file"),
    mimeType: z.string(),
    fileName: z.string().optional(),
    path: z.string().optional(),
    data: z.string().optional(),
  }),
]);

export interface UserInput {
  id: string;
  role: "user" | "system";
  parts: ContentPart[];
  metadata?: Record<string, unknown>;
}

export const userInputSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "system"]),
  parts: z.array(contentPartSchema),
  metadata: metadataSchema.optional(),
});

export interface MessageReceipt {
  operationId: string;
  sessionId: string;
  acceptedDelivery: DeliveryMode;
  queued: boolean;
}

export const messageReceiptSchema = z.object({
  operationId: z.string(),
  sessionId: z.string(),
  acceptedDelivery: deliveryModeSchema,
  queued: z.boolean(),
});

export interface SwarmdMessage {
  id: string;
  sessionId: string;
  source: StoredMessageActor;
  sourceMessageId: string | null;
  kind: string;
  role: StoredMessageActor;
  content: unknown;
  orderKey: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface AppendMessageInput {
  source: StoredMessageActor;
  sourceMessageId?: string | null;
  kind: string;
  role: StoredMessageActor;
  content: unknown;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}
