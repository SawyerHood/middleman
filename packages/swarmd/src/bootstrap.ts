import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { loadConfig, type SwarmdConfig } from "./config/env.js";
import { EventBus } from "./core/events/index.js";
import { MessageCapture } from "./core/services/message-capture.js";
import { MessageService } from "./core/services/message-service.js";
import { MessageStore } from "./core/services/message-store.js";
import { OperationService } from "./core/services/operation-service.js";
import { SessionService } from "./core/services/session-service.js";
import { RecoveryManager, RuntimeSupervisor } from "./core/supervisor/index.js";
import {
  MessageRepo,
  OperationRepo,
  SessionRepo,
  createDatabase,
  runMigrations,
  type Database,
  type MigrationDefinition,
} from "./core/store/index.js";
import type { HostCallRequest } from "./core/types/index.js";

export interface CreateCoreOptions {
  migrations?: readonly MigrationDefinition[];
  onHostCall?: (sessionId: string, request: HostCallRequest) => Promise<unknown>;
  runRecovery?: boolean;
}

export interface SwarmdCoreHandle {
  config: SwarmdConfig;
  db: Database;
  supervisor: RuntimeSupervisor;
  sessionService: SessionService;
  messageService: MessageService;
  messageStore: MessageStore;
  operationService: OperationService;
  eventBus: EventBus;
  recoveryManager: RecoveryManager;
  archiveSession(sessionId: string): void;
  shutdown(): Promise<void>;
}

export async function createCore(
  configOverrides?: Partial<SwarmdConfig>,
  options?: CreateCoreOptions,
): Promise<SwarmdCoreHandle> {
  const loadedConfig = loadConfig(configOverrides);
  const dataDir = resolve(loadedConfig.dataDir);

  await mkdir(dataDir, { recursive: true });

  const dbPath = loadedConfig.dbPath || resolve(dataDir, "swarmd.db");
  const config: SwarmdConfig = {
    ...loadedConfig,
    dataDir,
    dbPath,
  };

  const db = createDatabase(dbPath);
  runMigrations(db, { migrations: options?.migrations });

  const sessionRepo = new SessionRepo(db);
  const messageRepo = new MessageRepo(db);
  const operationRepo = new OperationRepo(db);

  const eventBus = new EventBus();
  const messageStore = new MessageStore(sessionRepo, messageRepo);
  const messageCapture = new MessageCapture(eventBus, messageStore);
  const operationService = new OperationService(operationRepo, eventBus);
  let sessionService!: SessionService;

  const supervisor = new RuntimeSupervisor({
    onWorkerEvent: (sessionId, event) => {
      if (event.type === "normalized_event") {
        eventBus.publish(event.event);
        return;
      }

      if (event.type === "ready" && event.checkpoint) {
        sessionService.updateCheckpoint(sessionId, event.checkpoint);
        return;
      }

      if (event.type === "fatal_error") {
        sessionService.reportRuntimeError(sessionId, event.error);
        return;
      }

      if (event.type === "session_status") {
        sessionService.applyRuntimeStatus(
          sessionId,
          event.status,
          event.error ?? undefined,
          event.contextUsage,
        );
        return;
      }

      if (event.type === "checkpoint") {
        sessionService.updateCheckpoint(sessionId, event.checkpoint);
        return;
      }

      if (event.type === "backend_state") {
        sessionService.updateBackendState(sessionId, event.state);
        return;
      }

      if (event.type === "command_result") {
        if (event.ok) {
          operationService.complete(event.operationId, event.payload ?? {});
          return;
        }

        if (event.error) {
          operationService.fail(event.operationId, event.error);
        }
      }
    },
    onWorkerExit: (sessionId, code, signal) => {
      sessionService.handleWorkerExit(sessionId, code, signal);
    },
    onWorkerError: (sessionId, error) => {
      sessionService.handleWorkerError(sessionId, error);
    },
    onHostCall: async (sessionId, request) => {
      if (!options?.onHostCall) {
        throw new Error(`No host call handler registered for ${request.method}.`);
      }

      return await options.onHostCall(sessionId, request);
    },
  });

  sessionService = new SessionService(
    sessionRepo,
    messageRepo,
    operationRepo,
    supervisor,
    eventBus,
    operationService,
  );
  const messageService = new MessageService(
    sessionRepo,
    supervisor,
    operationService,
    messageStore,
  );
  const recoveryManager = new RecoveryManager({
    sessionRepo,
    sessionService,
  });

  if (options?.runRecovery !== false) {
    await recoveryManager.recover();
  }

  return {
    config,
    db,
    supervisor,
    sessionService,
    messageService,
    messageStore,
    operationService,
    eventBus,
    recoveryManager,
    archiveSession(sessionId: string) {
      sessionService.archiveSession(sessionId);
    },
    async shutdown() {
      messageCapture.dispose();
      await supervisor.shutdownAll();
      db.close();
    },
  };
}
