import type {
  ContentPart,
  DeliveryMode,
  MessageReceipt,
  SessionStatus,
  UserInput,
} from "../types/index.js";
import type { SessionRepo } from "../store/index.js";
import type { RuntimeSupervisor } from "../supervisor/runtime-supervisor.js";
import type { OperationService } from "./operation-service.js";
import type { MessageStore } from "./message-store.js";

type SendableSessionStatus = "idle" | "busy" | "starting";

function isSendableSessionStatus(status: SessionStatus): status is SendableSessionStatus {
  return status === "idle" || status === "busy" || status === "starting";
}

function isTextPart(part: ContentPart): part is Extract<ContentPart, { type: "text" }> {
  return part.type === "text";
}

function buildStoredInputContent(parts: ContentPart[]): Record<string, unknown> {
  if (parts.every(isTextPart)) {
    return {
      text: parts.map((part) => part.text).join(""),
      parts,
    };
  }

  return { parts };
}

function getStoredInputKind(parts: ContentPart[]): string {
  return parts.every(isTextPart) ? "text" : "input";
}

export class MessageService {
  constructor(
    private sessionRepo: SessionRepo,
    private supervisor: RuntimeSupervisor,
    private operationService: OperationService,
    private messageStore: MessageStore,
  ) {}

  send(
    sessionId: string,
    parts: ContentPart[],
    options?: {
      delivery?: DeliveryMode;
      role?: "user" | "system";
      metadata?: Record<string, unknown>;
    },
  ): MessageReceipt {
    const session = this.sessionRepo.getById(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    if (!isSendableSessionStatus(session.status)) {
      throw new Error(`Session ${sessionId} is ${session.status}, cannot send messages`);
    }

    if (!this.supervisor.hasWorker(sessionId)) {
      throw new Error(`No running worker for session ${sessionId}`);
    }

    const requestedDelivery = options?.delivery ?? "auto";
    const resolvedDelivery = this.resolveDelivery(requestedDelivery, session.status);
    const operation = this.operationService.create(sessionId, "send_input");

    const input: UserInput = {
      id: operation.id,
      role: options?.role ?? "user",
      parts,
      metadata: options?.metadata,
    };

    this.messageStore.append(sessionId, {
      source: input.role,
      kind: getStoredInputKind(parts),
      role: input.role,
      content: buildStoredInputContent(parts),
      metadata: input.metadata,
    });

    this.supervisor.sendCommand(sessionId, {
      type: "send_input",
      input,
      delivery: resolvedDelivery,
      operationId: operation.id,
    });

    return {
      operationId: operation.id,
      sessionId,
      acceptedDelivery: resolvedDelivery,
      queued: resolvedDelivery === "queue",
    };
  }

  interrupt(sessionId: string): string {
    const session = this.sessionRepo.getById(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    if (!this.supervisor.hasWorker(sessionId)) {
      throw new Error(`No running worker for session ${sessionId}`);
    }

    const operation = this.operationService.create(sessionId, "interrupt");
    this.supervisor.sendCommand(sessionId, {
      type: "interrupt",
      operationId: operation.id,
    });

    return operation.id;
  }

  compact(sessionId: string, customInstructions?: string): string {
    const session = this.sessionRepo.getById(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    if (!this.supervisor.hasWorker(sessionId)) {
      throw new Error(`No running worker for session ${sessionId}`);
    }

    const operation = this.operationService.create(sessionId, "compact");
    this.supervisor.sendCommand(sessionId, {
      type: "compact",
      operationId: operation.id,
      ...(customInstructions === undefined ? {} : { customInstructions }),
    });

    return operation.id;
  }

  private resolveDelivery(
    requested: DeliveryMode,
    sessionState: SendableSessionStatus,
  ): DeliveryMode {
    if (requested !== "auto") {
      return requested;
    }

    return sessionState === "busy" ? "queue" : "auto";
  }
}
