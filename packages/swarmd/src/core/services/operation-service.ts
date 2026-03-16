import { generateEventId, generateOperationId } from "../ids.js";
import type { EventEnvelope, OperationRecord, SessionErrorInfo } from "../types/index.js";
import type { EventBus } from "../events/index.js";
import type { OperationRepo } from "../store/index.js";

interface CompletedOperationPayload {
  operationId: string;
  status: "completed";
  result: unknown;
}

interface FailedOperationPayload {
  operationId: string;
  status: "failed";
  error: SessionErrorInfo;
}

type OperationCompletedEventPayload = CompletedOperationPayload | FailedOperationPayload;

export class OperationService {
  constructor(
    private repo: OperationRepo,
    private eventBus: EventBus
  ) {}

  create(sessionId: string, type: string): OperationRecord {
    const now = new Date().toISOString();
    const operation: OperationRecord = {
      id: generateOperationId(),
      sessionId,
      type,
      status: "pending",
      resultJson: null,
      errorJson: null,
      createdAt: now,
      completedAt: null
    };

    this.repo.create(operation);

    return operation;
  }

  complete(operationId: string, result: unknown = {}): OperationRecord {
    this.repo.complete(operationId, result);

    const operation = this.repo.getById(operationId);

    if (!operation) {
      throw new Error(`Operation ${operationId} not found after completion`);
    }

    this.publishCompletedEvent(operation, {
      operationId,
      status: "completed",
      result
    });

    return operation;
  }

  fail(operationId: string, error: SessionErrorInfo): OperationRecord {
    this.repo.fail(operationId, error);

    const operation = this.repo.getById(operationId);

    if (!operation) {
      throw new Error(`Operation ${operationId} not found after failure`);
    }

    this.publishCompletedEvent(operation, {
      operationId,
      status: "failed",
      error
    });

    return operation;
  }

  getById(id: string): OperationRecord | null {
    return this.repo.getById(id);
  }

  listBySession(sessionId: string): OperationRecord[] {
    return this.repo.listBySession(sessionId);
  }

  private publishCompletedEvent(
    operation: OperationRecord,
    payload: OperationCompletedEventPayload
  ): EventEnvelope<OperationCompletedEventPayload> {
    return this.eventBus.publish({
      id: generateEventId(),
      cursor: null,
      sessionId: operation.sessionId,
      threadId: null,
      timestamp: new Date().toISOString(),
      source: "server",
      type: "operation.completed",
      payload
    });
  }
}
