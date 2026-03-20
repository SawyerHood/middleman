import { generateEventId, generateSessionId } from "../ids.js";
import type { EventBus } from "../events/index.js";
import type { OperationService } from "./operation-service.js";
import type { MessageRepo, OperationRepo, SessionRepo } from "../store/index.js";
import type { RuntimeSupervisor } from "../supervisor/runtime-supervisor.js";
import type {
  BackendCheckpoint,
  BackendKind,
  CreateSessionInput,
  SessionContextUsage,
  SessionErrorInfo,
  SessionRecord,
  SessionRuntimeConfig,
  SessionStatus,
} from "../types/index.js";

const DEFAULT_MODELS: Record<BackendKind, string> = {
  codex: "",
  claude: "claude-sonnet-4-20250514",
  pi: "default",
};

const PERSISTED_ACTIVE_SESSION_STATUSES: SessionStatus[] = [
  "starting",
  "idle",
  "busy",
  "interrupting",
  "stopping",
];
const EXPECTED_SHUTDOWN_SIGNALS = new Set(["SIGINT", "SIGTERM"]);

export class SessionService {
  constructor(
    private sessionRepo: SessionRepo,
    private messageRepo: MessageRepo,
    private operationRepo: OperationRepo,
    private supervisor: RuntimeSupervisor,
    private eventBus: EventBus,
    private operationService: OperationService,
  ) {}

  create(input: CreateSessionInput): SessionRecord {
    const now = new Date().toISOString();
    const sessionId = input.id ?? generateSessionId();

    const session: SessionRecord = {
      id: sessionId,
      backend: input.backend,
      status: "created",
      displayName: input.displayName ?? `${input.backend}-session`,
      cwd: input.cwd,
      model: input.model ?? DEFAULT_MODELS[input.backend] ?? "",
      systemPrompt: input.systemPrompt,
      backendCheckpoint: null,
      createdAt: now,
      updatedAt: now,
      lastError: null,
      contextUsage: null,
    };

    this.sessionRepo.create(session, {
      ...(input.deliveryDefaults ? { deliveryDefaults: input.deliveryDefaults } : {}),
      backendConfig: { ...(input.backendConfig ?? {}) },
    });
    this.emitEvent("session.created", sessionId, null, now, { session });

    if (input.autoStart) {
      void this.start(sessionId).catch(() => {
        // The status/error transition is handled inside start().
      });
    }

    return session;
  }

  requestStart(sessionId: string): string {
    const session = this.getOrThrow(sessionId);
    this.assertNotArchived(sessionId);
    if (!["created", "stopped", "errored"].includes(session.status)) {
      throw new Error(`Cannot start session in status ${session.status}`);
    }

    const operation = this.operationService.create(sessionId, "start");
    void this.start(sessionId, operation.id).catch(() => {
      // Operation completion/failure is handled inside start().
    });

    return operation.id;
  }

  async start(sessionId: string, operationId?: string): Promise<void> {
    const session = this.getOrThrow(sessionId);
    this.assertNotArchived(sessionId);
    if (!["created", "stopped", "errored"].includes(session.status)) {
      throw new Error(`Cannot start session in status ${session.status}`);
    }

    this.updateStatus(sessionId, "starting");

    const backendState = this.getBackendState(sessionId);
    const config: SessionRuntimeConfig = {
      backend: session.backend,
      cwd: session.cwd,
      model: session.model,
      ...(session.systemPrompt === undefined ? {} : { systemPrompt: session.systemPrompt }),
      ...this.sessionRepo.getRuntimeConfig(sessionId),
      ...(backendState ? { backendState } : {}),
    };

    try {
      await this.supervisor.spawnWorker(this.getOrThrow(sessionId), config);
      if (operationId) {
        this.operationService.complete(operationId);
      }
      this.updateStatus(sessionId, "idle");
      this.emitEvent("session.started", sessionId, null, undefined, {
        status: "idle",
      });
    } catch (error) {
      const sessionError = this.toSessionError("START_FAILED", error, true);
      if (operationId) {
        this.operationService.fail(operationId, sessionError);
      }
      this.updateStatus(sessionId, "errored", sessionError);
      this.emitEvent("session.errored", sessionId, null, undefined, {
        error: sessionError,
      });
      throw error;
    }
  }

  requestStop(sessionId: string): string {
    this.getOrThrow(sessionId);
    const operation = this.operationService.create(sessionId, "stop");
    void this.stop(sessionId, operation.id).catch(() => {
      // Operation completion/failure is handled inside stop().
    });

    return operation.id;
  }

  async stop(sessionId: string, operationId?: string): Promise<void> {
    const session = this.getOrThrow(sessionId);
    const resolvedOperationId = operationId ?? this.operationService.create(sessionId, "stop").id;

    if (!this.supervisor.hasWorker(sessionId)) {
      const updated = this.updateStatus(sessionId, "stopped");
      this.operationService.complete(resolvedOperationId);
      if (updated.status === "stopped" && session.status !== "stopped") {
        this.emitEvent("session.stopped", sessionId, null, updated.updatedAt, {});
      }
      return;
    }

    this.updateStatus(sessionId, "stopping");

    try {
      await this.supervisor.stopWorker(sessionId, resolvedOperationId);
      this.operationService.complete(resolvedOperationId);
      const updated = this.updateStatus(sessionId, "stopped");
      this.emitEvent("session.stopped", sessionId, null, updated.updatedAt, {});
    } catch (error) {
      const sessionError = this.toSessionError("STOP_FAILED", error, true);
      this.operationService.fail(resolvedOperationId, sessionError);
      this.updateStatus(sessionId, "errored", sessionError);
      this.emitEvent("session.errored", sessionId, null, undefined, {
        error: sessionError,
      });
      throw error;
    }
  }

  requestTerminate(sessionId: string): string {
    const session = this.getOrThrow(sessionId);
    const operation = this.operationService.create(session.id, "terminate");
    void this.terminate(sessionId, operation.id).catch(() => {
      // Operation completion/failure is handled inside terminate().
    });

    return operation.id;
  }

  async terminate(sessionId: string, operationId?: string): Promise<void> {
    const session = this.getOrThrow(sessionId);
    const resolvedOperationId =
      operationId ?? this.operationService.create(sessionId, "terminate").id;

    if (session.status === "terminated") {
      this.operationService.complete(resolvedOperationId);
      return;
    }

    if (!this.supervisor.hasWorker(sessionId)) {
      const updated = this.updateStatus(sessionId, "terminated");
      this.operationService.complete(resolvedOperationId);
      this.emitEvent("session.terminated", sessionId, null, updated.updatedAt, {});
      return;
    }

    try {
      await this.supervisor.terminateWorker(sessionId, resolvedOperationId);
      this.operationService.complete(resolvedOperationId);
      const updated = this.updateStatus(sessionId, "terminated");
      this.emitEvent("session.terminated", sessionId, null, updated.updatedAt, {});
    } catch (error) {
      const sessionError = this.toSessionError("TERMINATE_FAILED", error, false);
      this.operationService.fail(resolvedOperationId, sessionError);
      this.updateStatus(sessionId, "errored", sessionError);
      this.emitEvent("session.errored", sessionId, null, undefined, {
        error: sessionError,
      });
      throw error;
    }
  }

  getById(id: string): SessionRecord | null {
    return this.sessionRepo.getById(id);
  }

  archiveSession(sessionId: string): void {
    this.getOrThrow(sessionId);
    if (this.supervisor.hasWorker(sessionId)) {
      throw new Error("Cannot archive a running session. Stop or terminate it first.");
    }

    if (this.sessionRepo.isArchived(sessionId)) {
      return;
    }

    this.sessionRepo.archiveSession(sessionId);
  }

  list(filter?: { status?: SessionStatus[]; includeArchived?: boolean }): SessionRecord[] {
    return this.sessionRepo.list(filter);
  }

  reconcilePersistedSessions(): SessionRecord[] {
    const activeSessions = this.sessionRepo.list({
      status: PERSISTED_ACTIVE_SESSION_STATUSES,
    });
    const expectedShutdownErrors = this.sessionRepo
      .list({
        status: ["errored"],
      })
      .filter((session) => isExpectedShutdownSessionError(session.lastError));

    for (const session of activeSessions) {
      this.sessionRepo.updateStatus(session.id, "stopped", null, session.contextUsage);
    }

    for (const session of expectedShutdownErrors) {
      this.sessionRepo.updateStatus(session.id, "stopped", null, session.contextUsage);
    }

    return [...activeSessions, ...expectedShutdownErrors]
      .map((session) => this.sessionRepo.getById(session.id))
      .filter((session): session is SessionRecord => session !== null);
  }

  updateDisplayName(sessionId: string, displayName: string): SessionRecord {
    this.getOrThrow(sessionId);
    this.sessionRepo.updateDisplayName(sessionId, displayName);
    return this.getOrThrow(sessionId);
  }

  updateCheckpoint(sessionId: string, checkpoint: BackendCheckpoint): SessionRecord {
    this.getOrThrow(sessionId);
    this.sessionRepo.updateCheckpoint(sessionId, checkpoint);
    return this.getOrThrow(sessionId);
  }

  applyRuntimeStatus(
    sessionId: string,
    status: SessionStatus,
    error?: SessionErrorInfo | null,
    contextUsage?: SessionContextUsage | null,
  ): SessionRecord {
    this.getOrThrow(sessionId);
    return this.updateStatus(sessionId, status, error, contextUsage);
  }

  reportRuntimeError(sessionId: string, error: SessionErrorInfo): SessionRecord {
    this.getOrThrow(sessionId);
    const updated = this.updateStatus(sessionId, "errored", error);
    this.emitEvent("session.errored", sessionId, null, updated.updatedAt, {
      error,
    });
    return updated;
  }

  delete(sessionId: string): void {
    this.getOrThrow(sessionId);
    if (this.supervisor.hasWorker(sessionId)) {
      throw new Error("Cannot delete a running session. Stop or terminate it first.");
    }

    this.sessionRepo.delete(sessionId);
  }

  getRuntimeConfig(
    sessionId: string,
  ): Pick<SessionRuntimeConfig, "deliveryDefaults" | "backendConfig"> {
    this.getOrThrow(sessionId);
    return this.sessionRepo.getRuntimeConfig(sessionId);
  }

  updateRuntimeConfig(
    sessionId: string,
    runtimeConfig: Pick<SessionRuntimeConfig, "deliveryDefaults" | "backendConfig">,
  ): SessionRecord {
    this.getOrThrow(sessionId);
    this.sessionRepo.updateRuntimeConfig(sessionId, runtimeConfig);
    return this.getOrThrow(sessionId);
  }

  getBackendState(sessionId: string): Record<string, unknown> | null {
    this.getOrThrow(sessionId);
    return this.sessionRepo.getBackendState(sessionId);
  }

  updateBackendState(sessionId: string, state: Record<string, unknown>): SessionRecord {
    this.getOrThrow(sessionId);
    this.sessionRepo.updateBackendState(sessionId, state);
    return this.getOrThrow(sessionId);
  }

  reset(
    sessionId: string,
    input: {
      systemPrompt: string;
      runtimeConfig?: Pick<SessionRuntimeConfig, "deliveryDefaults" | "backendConfig">;
      updatedAt?: string;
    },
  ): SessionRecord {
    this.getOrThrow(sessionId);
    if (this.supervisor.hasWorker(sessionId)) {
      throw new Error("Cannot reset a running session. Stop it first.");
    }

    this.messageRepo.deleteBySession(sessionId);
    this.operationRepo.deleteBySession(sessionId);
    this.sessionRepo.clearBackendState(sessionId);
    this.sessionRepo.resetState(sessionId, input);

    const updated = this.getOrThrow(sessionId);
    this.emitEvent("session.reset", sessionId, null, updated.updatedAt, {});
    return updated;
  }

  handleWorkerExit(sessionId: string, code: number | null, signal: string | null): void {
    const session = this.sessionRepo.getById(sessionId);
    if (
      !session ||
      session.status === "stopping" ||
      session.status === "terminated" ||
      session.status === "errored"
    ) {
      return;
    }

    if (code === 0 && signal === null) {
      const updated = this.updateStatus(sessionId, "stopped");
      this.emitEvent("session.stopped", sessionId, null, updated.updatedAt, {
        code,
        signal,
      });
      return;
    }

    if (isExpectedShutdownExit(code, signal)) {
      const updated = this.updateStatus(sessionId, "stopped");
      this.emitEvent("session.stopped", sessionId, null, updated.updatedAt, {
        code,
        signal,
      });
      return;
    }

    const sessionError: SessionErrorInfo = {
      code: "WORKER_CRASHED",
      message: `Worker exited with code ${code}, signal ${signal}`,
      retryable: true,
      details: {
        code,
        signal,
      },
    };
    this.updateStatus(sessionId, "errored", sessionError);
    this.emitEvent("session.errored", sessionId, null, undefined, {
      error: sessionError,
    });
  }

  handleWorkerError(sessionId: string, error: Error): void {
    const session = this.sessionRepo.getById(sessionId);
    if (!session || session.status === "stopping" || session.status === "terminated") {
      return;
    }

    const sessionError: SessionErrorInfo = {
      code: "WORKER_ERROR",
      message: error.message,
      retryable: true,
    };
    this.updateStatus(sessionId, "errored", sessionError);
    this.emitEvent("session.errored", sessionId, null, undefined, {
      error: sessionError,
    });
  }

  private getOrThrow(id: string): SessionRecord {
    const session = this.sessionRepo.getById(id);
    if (!session) {
      throw new Error(`Session ${id} not found`);
    }

    return session;
  }

  private assertNotArchived(sessionId: string): void {
    if (this.sessionRepo.isArchived(sessionId)) {
      throw new Error(`Cannot start archived session ${sessionId}`);
    }
  }

  private updateStatus(
    sessionId: string,
    status: SessionStatus,
    error?: SessionErrorInfo | null,
    contextUsage?: SessionContextUsage | null,
  ): SessionRecord {
    const previous = this.getOrThrow(sessionId);
    const resolvedError =
      error !== undefined ? error : previous.status === status ? previous.lastError : null;
    const resolvedContextUsage = contextUsage !== undefined ? contextUsage : previous.contextUsage;

    if (
      previous.status === status &&
      areSessionErrorsEqual(previous.lastError, resolvedError) &&
      areContextUsagesEqual(previous.contextUsage, resolvedContextUsage)
    ) {
      return previous;
    }

    this.sessionRepo.updateStatus(sessionId, status, resolvedError, resolvedContextUsage);
    const updated = this.getOrThrow(sessionId);

    if (
      previous.status !== status ||
      !areContextUsagesEqual(previous.contextUsage, updated.contextUsage)
    ) {
      this.emitEvent("session.status.changed", sessionId, null, updated.updatedAt, {
        status,
        ...(previous.status !== status ? { previousStatus: previous.status } : {}),
        contextUsage: updated.contextUsage,
      });
    }

    return updated;
  }

  private emitEvent(
    type: string,
    sessionId: string,
    threadId: string | null,
    timestamp = new Date().toISOString(),
    payload: Record<string, unknown>,
  ): void {
    this.eventBus.publish({
      id: generateEventId(),
      cursor: null,
      sessionId,
      threadId,
      timestamp,
      source: "server",
      type,
      payload,
    });
  }

  private toSessionError(code: string, error: unknown, retryable: boolean): SessionErrorInfo {
    return {
      code,
      message: error instanceof Error ? error.message : String(error),
      retryable,
    };
  }
}

function isExpectedShutdownExit(code: number | null, signal: string | null): boolean {
  return code === null && signal !== null && EXPECTED_SHUTDOWN_SIGNALS.has(signal);
}

function isExpectedShutdownSessionError(error: SessionErrorInfo | null): boolean {
  if (!error || error.code !== "WORKER_CRASHED") {
    return false;
  }

  const signal = readExpectedShutdownSignal(error.details);
  if (signal) {
    return true;
  }

  return /Worker exited with code null, signal (SIGINT|SIGTERM)/.test(error.message);
}

function readExpectedShutdownSignal(details: unknown): string | null {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return null;
  }

  const signal = (details as { signal?: unknown }).signal;
  return typeof signal === "string" && EXPECTED_SHUTDOWN_SIGNALS.has(signal) ? signal : null;
}

function areSessionErrorsEqual(
  left: SessionErrorInfo | null,
  right: SessionErrorInfo | null,
): boolean {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return (
    left.code === right.code &&
    left.message === right.message &&
    left.retryable === right.retryable &&
    JSON.stringify(left.details ?? null) === JSON.stringify(right.details ?? null)
  );
}

function areContextUsagesEqual(
  left: SessionContextUsage | null,
  right: SessionContextUsage | null,
): boolean {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return (
    left.tokens === right.tokens &&
    left.contextWindow === right.contextWindow &&
    left.percent === right.percent
  );
}
