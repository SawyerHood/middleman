import { generateMessageId } from "../ids.js";
import type { MessageRepo, SessionRepo } from "../store/index.js";
import type { AppendMessageInput, SwarmdMessage } from "../types/index.js";

const ORDER_KEY_SEQUENCE_WIDTH = 6;

interface ParsedOrderKey {
  timestamp: string;
  sequence: number;
}

export class MessageStoreSessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} not found`);
    this.name = "MessageStoreSessionNotFoundError";
  }
}

function formatOrderKey(timestamp: string, sequence: number): string {
  return `${timestamp}-${sequence.toString().padStart(ORDER_KEY_SEQUENCE_WIDTH, "0")}`;
}

function parseOrderKey(orderKey: string): ParsedOrderKey | null {
  const separator = orderKey.lastIndexOf("-");
  if (separator < 0) {
    return null;
  }

  const timestamp = orderKey.slice(0, separator);
  const sequence = Number.parseInt(orderKey.slice(separator + 1), 10);
  if (!Number.isInteger(sequence) || sequence < 0) {
    return null;
  }

  return { timestamp, sequence };
}

export class MessageStore {
  constructor(
    private sessionRepo: SessionRepo,
    private messageRepo: MessageRepo,
  ) {}

  append(sessionId: string, input: AppendMessageInput): SwarmdMessage {
    this.assertSessionExists(sessionId);

    const createdAt = input.createdAt ?? new Date().toISOString();
    const message: SwarmdMessage = {
      id: generateMessageId(),
      sessionId,
      source: input.source,
      sourceMessageId: input.sourceMessageId ?? null,
      kind: input.kind,
      role: input.role,
      content: input.content,
      orderKey: this.generateOrderKey(sessionId, createdAt),
      createdAt,
      metadata: { ...(input.metadata ?? {}) },
    };

    this.messageRepo.create(message);
    return message;
  }

  list(
    sessionId: string,
    options?: {
      after?: string;
      limit?: number;
    },
  ): SwarmdMessage[] {
    this.assertSessionExists(sessionId);

    if (options?.limit !== undefined && options.limit < 1) {
      throw new Error(`Invalid message limit ${options.limit}`);
    }

    return this.messageRepo.listBySession(sessionId, options);
  }

  listVisibleTranscriptMessages(
    sessionId: string,
    options?: {
      includeSendMessageToolResults?: boolean;
    },
  ): SwarmdMessage[] {
    this.assertSessionExists(sessionId);
    return this.messageRepo.listVisibleTranscriptMessages(sessionId, options);
  }

  listManagerScopedHiddenMessages(managerId: string): SwarmdMessage[] {
    this.assertSessionExists(managerId);
    return this.messageRepo.listManagerScopedHiddenMessages(managerId);
  }

  getById(messageId: string): SwarmdMessage | null {
    return this.messageRepo.getById(messageId);
  }

  getLatestBySourceMessageId(sessionId: string, sourceMessageId: string): SwarmdMessage | null {
    this.assertSessionExists(sessionId);
    return this.messageRepo.getLatestBySourceMessageId(sessionId, sourceMessageId);
  }

  annotate(messageId: string, patch: Record<string, unknown>): SwarmdMessage {
    const existing = this.messageRepo.getById(messageId);
    if (!existing) {
      throw new Error(`Message ${messageId} not found`);
    }

    const metadata = Object.assign({}, existing.metadata, patch);
    this.messageRepo.updateMetadata(messageId, metadata);

    return (
      this.messageRepo.getById(messageId) ?? {
        ...existing,
        metadata,
      }
    );
  }

  private assertSessionExists(sessionId: string): void {
    if (!this.sessionRepo.getById(sessionId)) {
      throw new MessageStoreSessionNotFoundError(sessionId);
    }
  }

  private generateOrderKey(sessionId: string, createdAt: string): string {
    const latestOrderKey = this.messageRepo.getLatestOrderKeyForTimestamp(sessionId, createdAt);
    const parsed = latestOrderKey ? parseOrderKey(latestOrderKey) : null;

    if (!parsed || parsed.timestamp !== createdAt) {
      return formatOrderKey(createdAt, 0);
    }

    return formatOrderKey(createdAt, parsed.sequence + 1);
  }
}
