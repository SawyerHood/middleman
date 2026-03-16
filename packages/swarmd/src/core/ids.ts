import { nanoid } from "nanoid";
import { z } from "zod";

const idSchema = z.string().min(1);

export type SessionId = string;
export type OperationId = string;
export type EventId = string;
export type MessageId = string;

export const sessionIdSchema = idSchema;
export const operationIdSchema = idSchema;
export const eventIdSchema = idSchema;
export const messageIdSchema = idSchema;

export const generateSessionId = (): SessionId => nanoid();
export const generateOperationId = (): OperationId => nanoid();
export const generateEventId = (): EventId => nanoid();
export const generateMessageId = (): MessageId => nanoid();
