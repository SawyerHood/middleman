import type {
  BackendCapabilities,
  BackendCheckpoint,
  DeliveryMode,
  SessionContextUsage,
  SessionErrorInfo,
  SessionRuntimeConfig,
  SessionStatus,
  UserInput,
} from "../../core/types/index.js";
import { backendRawEvent } from "../common/event-normalizer.js";
import {
  createInitialCodexCheckpoint,
  isCodexCheckpoint,
  validateCheckpoint,
} from "../common/checkpoint.js";
import type { AdapterCallbacks, BackendAdapter, HostRpcClient } from "../common/adapter.js";
import {
  buildHostToolDefinitions,
  createCodexHostToolBridge,
  type CodexHostToolBridge,
  type MiddlemanRole,
} from "../common/host-tools.js";
import {
  CodexJsonRpcClient,
  type CodexJsonRpcClientOptions,
  type JsonRpcNotificationMessage,
  type JsonRpcRequestMessage,
} from "./codex-jsonrpc-client.js";
import {
  codexToolNameForItem,
  isCodexToolLikeItem,
  mapCodexNotificationToEvents,
  mapCodexThreadStatusToSessionStatus,
} from "./codex-mapper.js";

interface QueuedInput {
  input: UserInput;
  delivery: DeliveryMode;
}

interface ResolvedCodexConfig {
  sessionId: string;
  command: string;
  args: string[];
  spawnOptions: CodexJsonRpcClientOptions["spawnOptions"];
  requestTimeoutMs: number;
  approvalPolicy: "never" | "on-request" | "untrusted" | "on-failure";
  sandbox: "danger-full-access" | "workspace-write" | "read-only";
  clientInfo: {
    name: string;
    title: string;
    version: string;
  };
  experimentalApi: boolean;
  experimentalRawEvents: boolean;
  persistExtendedHistory: boolean;
  ephemeralThreads: boolean;
  hostToolsRole?: MiddlemanRole;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_FORCE_EXIT_TIMEOUT_MS = 2_000;
const DEFAULT_CODEX_COMMAND = process.env.CODEX_BIN?.trim() || "codex";
const DEFAULT_CODEX_ARGS = ["app-server", "--listen", "stdio://"];

export interface CodexBackendAdapterOptions {
  hostRpc?: HostRpcClient;
}

export class CodexBackendAdapter implements BackendAdapter {
  readonly kind = "codex" as const;
  readonly capabilities: BackendCapabilities = {
    canResumeThread: true,
    canForkThread: true,
    canInterrupt: true,
    canQueueInput: true,
    canManualCompact: true,
    canReadHistory: true,
    emitsToolProgress: true,
    exposesRawEvents: true,
  };

  readonly #callbacks: AdapterCallbacks;
  readonly #options: CodexBackendAdapterOptions;

  #client: CodexJsonRpcClient | null = null;
  #config: SessionRuntimeConfig | null = null;
  #resolvedConfig: ResolvedCodexConfig | null = null;
  #hostToolBridge: CodexHostToolBridge | null = null;
  #status: SessionStatus = "created";
  #currentThreadId: string | null = null;
  #activeTurnId: string | null = null;
  #startRequestPending = false;
  #queuedSteers: QueuedInput[] = [];
  #queuedTurns: QueuedInput[] = [];
  #interruptOnTurnStart = false;
  #toolNameByItemId = new Map<string, string>();
  #shutdownMode: "running" | "stopping" | "terminating" = "running";
  #lastContextUsage: SessionContextUsage | null = null;

  constructor(callbacks: AdapterCallbacks, options: CodexBackendAdapterOptions = {}) {
    this.#callbacks = callbacks;
    this.#options = options;
  }

  async bootstrap(
    config: SessionRuntimeConfig,
    checkpoint?: BackendCheckpoint,
  ): Promise<{ checkpoint: BackendCheckpoint }> {
    if (this.#client) {
      await this.terminate();
    }

    this.#config = config;
    this.#resolvedConfig = resolveCodexConfig(config);
    this.#hostToolBridge =
      this.#options.hostRpc && this.#resolvedConfig.hostToolsRole
        ? createCodexHostToolBridge(
            this.#options.hostRpc,
            buildHostToolDefinitions(this.#resolvedConfig.hostToolsRole),
          )
        : null;
    this.#shutdownMode = "running";
    this.#queuedSteers = [];
    this.#queuedTurns = [];
    this.#toolNameByItemId.clear();
    this.#activeTurnId = null;
    this.#currentThreadId = null;
    this.#lastContextUsage = null;

    this.#updateStatus("starting");

    this.#client = new CodexJsonRpcClient({
      command: this.#resolvedConfig.command,
      args: this.#resolvedConfig.args,
      spawnOptions: this.#resolvedConfig.spawnOptions,
      requestTimeoutMs: this.#resolvedConfig.requestTimeoutMs,
      onNotification: async (notification) => {
        await this.#handleNotification(notification);
      },
      onRequest: async (request) => {
        return await this.#handleServerRequest(request);
      },
      onStderr: (line) => {
        this.#callbacks.log("debug", "codex stderr", { line });
      },
      onExit: (error) => {
        void this.#handleProcessExit(error);
      },
    });

    try {
      await this.#client.initialize({
        clientInfo: this.#resolvedConfig.clientInfo,
        capabilities: {
          experimentalApi: this.#resolvedConfig.experimentalApi,
        },
      });

      const nextCheckpoint = checkpoint
        ? await this.resumeThread(checkpoint)
        : await this.#createThreadInternal(undefined);

      if (this.#status === "starting") {
        this.#updateStatus(this.#activeTurnId ? "busy" : "idle");
      }

      return {
        checkpoint: nextCheckpoint,
      };
    } catch (error) {
      this.#updateStatus("errored", toSessionErrorInfo("CODEX_BOOTSTRAP_FAILED", error, true));
      this.#callbacks.log("error", "codex bootstrap failed", {
        error: serializeError(error),
      });
      this.#client?.dispose();
      this.#client = null;
      throw error;
    }
  }

  async sendInput(
    input: UserInput,
    delivery: DeliveryMode,
  ): Promise<{ acceptedDelivery: DeliveryMode; queued: boolean }> {
    this.#ensureReady();

    if (!this.#isBusy()) {
      await this.#startTurn(input);
      return {
        acceptedDelivery: delivery,
        queued: false,
      };
    }

    if (delivery === "interrupt") {
      this.#queuedTurns.push({ input, delivery });

      if (this.#activeTurnId) {
        await this.interrupt();
      } else {
        this.#interruptOnTurnStart = true;
      }

      return {
        acceptedDelivery: "interrupt",
        queued: true,
      };
    }

    if (!this.#activeTurnId) {
      this.#queuedSteers.push({ input, delivery });
      return {
        acceptedDelivery: "queue",
        queued: true,
      };
    }

    await this.#clientRequest("turn/steer", {
      threadId: this.#currentThreadId,
      expectedTurnId: this.#activeTurnId,
      input: toCodexInputItems(input),
    });

    return {
      acceptedDelivery: "queue",
      queued: false,
    };
  }

  async createThread(seed?: UserInput[]): Promise<BackendCheckpoint> {
    this.#ensureReady();
    return await this.#createThreadInternal(seed);
  }

  async forkThread(source: BackendCheckpoint, sourceMessageId?: string): Promise<BackendCheckpoint> {
    this.#ensureReady();
    validateCheckpoint(source, "codex");
    if (!isCodexCheckpoint(source)) {
      throw new Error("Expected a Codex checkpoint.");
    }

    if (sourceMessageId) {
      this.#callbacks.log("debug", "codex thread fork ignores sourceMessageId", {
        sourceMessageId,
      });
    }

    const response = await this.#clientRequest<{ thread?: unknown }>("thread/fork", {
      threadId: source.threadId,
      ...(this.#model() ? { model: this.#model() } : {}),
      cwd: this.#config?.cwd,
      approvalPolicy: this.#resolvedConfig?.approvalPolicy,
      sandbox: this.#resolvedConfig?.sandbox,
      config: sandboxThreadConfig(this.#resolvedConfig?.sandbox),
      developerInstructions: this.#config?.systemPrompt,
      ephemeral: this.#resolvedConfig?.ephemeralThreads,
      persistExtendedHistory: this.#resolvedConfig?.persistExtendedHistory ?? true,
    });

    return this.#applyThreadResponse(response.thread);
  }

  async resumeThread(checkpoint: BackendCheckpoint): Promise<BackendCheckpoint> {
    this.#ensureReady();
    validateCheckpoint(checkpoint, "codex");
    if (!isCodexCheckpoint(checkpoint)) {
      throw new Error("Expected a Codex checkpoint.");
    }

    const response = await this.#clientRequest<{ thread?: unknown }>("thread/resume", {
      threadId: checkpoint.threadId,
      ...(this.#model() ? { model: this.#model() } : {}),
      cwd: this.#config?.cwd,
      approvalPolicy: this.#resolvedConfig?.approvalPolicy,
      sandbox: this.#resolvedConfig?.sandbox,
      config: sandboxThreadConfig(this.#resolvedConfig?.sandbox),
      developerInstructions: this.#config?.systemPrompt,
      persistExtendedHistory: this.#resolvedConfig?.persistExtendedHistory ?? true,
    });

    return this.#applyThreadResponse(response.thread);
  }

  async readHistory(
    threadCheckpoint: BackendCheckpoint,
    _options?: {
      cursor?: string;
      limit?: number;
    },
  ) {
    validateCheckpoint(threadCheckpoint, "codex");
    if (!isCodexCheckpoint(threadCheckpoint)) {
      throw new Error("Expected a Codex checkpoint.");
    }

    return {
      entries: [],
      cursor: {
        cursor: null,
        hasMore: false,
      },
    };
  }

  async interrupt(): Promise<void> {
    this.#ensureReady();

    if (!this.#currentThreadId || !this.#activeTurnId) {
      return;
    }

    this.#updateStatus("interrupting");
    await this.#clientRequest("turn/interrupt", {
      threadId: this.#currentThreadId,
      turnId: this.#activeTurnId,
    });
  }

  async stop(): Promise<void> {
    if (!this.#client) {
      return;
    }

    this.#shutdownMode = "stopping";
    this.#updateStatus("stopping");

    try {
      if (this.#currentThreadId && this.#activeTurnId) {
        await this.#clientRequest("turn/interrupt", {
          threadId: this.#currentThreadId,
          turnId: this.#activeTurnId,
        }).catch((error) => {
          this.#callbacks.log("warn", "codex interrupt during stop failed", {
            error: serializeError(error),
          });
        });
      }

      this.#client.requestShutdown();
      const gracefulExit = await this.#client.waitForExit(DEFAULT_STOP_TIMEOUT_MS);
      if (!gracefulExit) {
        this.#client.kill("SIGTERM");
        await this.#client.waitForExit(DEFAULT_FORCE_EXIT_TIMEOUT_MS);
      }
    } finally {
      this.#cleanupState();
      this.#updateStatus("stopped");
    }
  }

  async terminate(): Promise<void> {
    if (!this.#client) {
      return;
    }

    this.#shutdownMode = "terminating";
    this.#client.dispose("SIGTERM");
    const exited = await this.#client.waitForExit(DEFAULT_FORCE_EXIT_TIMEOUT_MS);
    if (!exited) {
      this.#client.kill("SIGKILL");
      await this.#client.waitForExit(DEFAULT_FORCE_EXIT_TIMEOUT_MS);
    }

    this.#cleanupState();
    this.#updateStatus("terminated");
  }

  async #createThreadInternal(seed?: UserInput[]): Promise<BackendCheckpoint> {
    if (seed && seed.length > 0) {
      this.#callbacks.log("warn", "codex thread creation ignores seed messages", {
        seedCount: seed.length,
      });
    }

    const response = await this.#clientRequest<{ thread?: unknown }>("thread/start", {
      ...(this.#model() ? { model: this.#model() } : {}),
      cwd: this.#config?.cwd,
      approvalPolicy: this.#resolvedConfig?.approvalPolicy,
      sandbox: this.#resolvedConfig?.sandbox,
      config: sandboxThreadConfig(this.#resolvedConfig?.sandbox),
      developerInstructions: this.#config?.systemPrompt,
      ephemeral: this.#resolvedConfig?.ephemeralThreads,
      experimentalRawEvents: this.#resolvedConfig?.experimentalRawEvents ?? false,
      persistExtendedHistory: this.#resolvedConfig?.persistExtendedHistory ?? true,
      ...(this.#hostToolBridge ? { dynamicTools: this.#hostToolBridge.dynamicTools } : {}),
    });

    return this.#applyThreadResponse(response.thread);
  }

  async #startTurn(input: UserInput): Promise<void> {
    this.#ensureReady();

    this.#startRequestPending = true;

    try {
      const response = await this.#clientRequest<{ turn?: unknown }>("turn/start", {
        threadId: this.#currentThreadId,
        cwd: this.#config?.cwd,
        input: toCodexInputItems(input),
      });

      const turnId = readTurnId(response.turn);
      if (turnId) {
        this.#activeTurnId = turnId;
      }

      this.#updateStatus("busy");
      await this.#flushQueuedSteers();
    } finally {
      this.#startRequestPending = false;
    }
  }

  async #flushQueuedSteers(): Promise<void> {
    if (!this.#client || !this.#currentThreadId || !this.#activeTurnId) {
      return;
    }

    while (this.#queuedSteers.length > 0 && this.#activeTurnId) {
      const next = this.#queuedSteers[0];
      if (!next) {
        return;
      }

      try {
        await this.#clientRequest("turn/steer", {
          threadId: this.#currentThreadId,
          expectedTurnId: this.#activeTurnId,
          input: toCodexInputItems(next.input),
        });

        this.#queuedSteers.shift();
      } catch (error) {
        this.#callbacks.log("warn", "codex queued steer delivery failed", {
          error: serializeError(error),
          pendingSteers: this.#queuedSteers.length,
        });
        break;
      }
    }
  }

  async #handleNotification(notification: JsonRpcNotificationMessage): Promise<void> {
    this.#emitRawNotification(notification);
    this.#emitMappedNotifications(notification);

    switch (notification.method) {
      case "thread/started": {
        const thread = readObject(notification.params, "thread");
        const threadId = readString(thread?.id);
        if (threadId) {
          this.#currentThreadId = threadId;
          this.#callbacks.emitCheckpoint(createInitialCodexCheckpoint(threadId));
        }

        const mappedStatus = mapCodexThreadStatusToSessionStatus(thread?.status);
        if (mappedStatus) {
          this.#updateStatus(mappedStatus);
        }
        return;
      }

      case "turn/started": {
        const turn = readObject(notification.params, "turn");
        const turnId = readString(turn?.id);
        if (turnId) {
          this.#activeTurnId = turnId;
        }

        this.#startRequestPending = false;
        this.#updateStatus("busy");

        if (this.#interruptOnTurnStart) {
          this.#interruptOnTurnStart = false;
          await this.interrupt();
          return;
        }

        await this.#flushQueuedSteers();
        return;
      }

      case "turn/completed": {
        const turn = readObject(notification.params, "turn");
        const turnFailed =
          readString(turn?.status) === "failed" ||
          turn?.error != null;

        this.#activeTurnId = null;
        this.#startRequestPending = false;

        if (this.#shutdownMode !== "running") {
          return;
        }

        if (this.#status === "errored") {
          return;
        }

        if (turnFailed) {
          this.#updateStatus(
            "errored",
            toSessionErrorInfo("CODEX_TURN_FAILED", turn?.error ?? "Codex turn failed.", true),
          );
          return;
        }

        const nextQueuedTurn = this.#queuedTurns.shift() ?? this.#queuedSteers.shift();
        if (nextQueuedTurn) {
          try {
            await this.#startTurn(nextQueuedTurn.input);
          } catch (error) {
            this.#callbacks.log("error", "codex queued turn start failed", {
              error: serializeError(error),
            });
            this.#updateStatus("errored", toSessionErrorInfo("CODEX_TURN_START_FAILED", error, true));
          }
          return;
        }

        this.#updateStatus("idle");
        return;
      }

      case "item/started": {
        const item = readObject(notification.params, "item");
        const parsedItem = parseToolLikeItem(item);
        if (parsedItem && isCodexToolLikeItem(parsedItem)) {
          this.#toolNameByItemId.set(parsedItem.id, codexToolNameForItem(parsedItem));
        }
        return;
      }

      case "item/completed": {
        const item = readObject(notification.params, "item");
        const parsedItem = parseToolLikeItem(item);
        if (parsedItem && isCodexToolLikeItem(parsedItem)) {
          this.#toolNameByItemId.delete(parsedItem.id);
        }
        return;
      }

      case "thread/status/changed": {
        const status = mapCodexThreadStatusToSessionStatus(readObject(notification.params)?.status);
        if (status) {
          this.#updateStatus(status);
        }
        return;
      }

      case "thread/tokenUsage/updated": {
        const nextUsage = extractCodexContextUsage(notification.params);
        if (nextUsage && !areContextUsagesEqual(this.#lastContextUsage, nextUsage)) {
          this.#lastContextUsage = nextUsage;
          this.#callbacks.emitStatusChange(this.#status, undefined, nextUsage);
        }
        return;
      }

      default:
        return;
    }
  }

  async #handleProcessExit(error: Error): Promise<void> {
    this.#startRequestPending = false;
    this.#activeTurnId = null;
    this.#toolNameByItemId.clear();

    if (this.#shutdownMode !== "running") {
      return;
    }

    this.#callbacks.log("error", "codex process exited unexpectedly", {
      error: serializeError(error),
    });
    this.#updateStatus("errored", toSessionErrorInfo("CODEX_PROCESS_EXIT", error, true));
  }

  #applyThreadResponse(threadValue: unknown): BackendCheckpoint {
    const thread = readObject(threadValue);
    const threadId = readString(thread?.id);
    if (!threadId) {
      throw new Error("Codex did not return a thread id.");
    }

    this.#currentThreadId = threadId;
    this.#activeTurnId = readActiveTurnId(thread?.turns);

    const checkpoint = createInitialCodexCheckpoint(threadId);
    this.#callbacks.emitCheckpoint(checkpoint);

    const mappedStatus = mapCodexThreadStatusToSessionStatus(thread?.status);
    if (mappedStatus) {
      this.#updateStatus(mappedStatus);
    }

    return checkpoint;
  }

  #emitRawNotification(notification: JsonRpcNotificationMessage): void {
    if (!this.#resolvedConfig) {
      return;
    }

    const rawEvent = backendRawEvent({
      sessionId: this.#resolvedConfig.sessionId,
      threadId: readString(readObject(notification.params)?.threadId) ?? this.#currentThreadId,
      payload: notification,
    });
    this.#callbacks.emitEvent(rawEvent);
  }

  #emitMappedNotifications(notification: JsonRpcNotificationMessage): void {
    if (!this.#resolvedConfig) {
      return;
    }

    const events = mapCodexNotificationToEvents(notification, {
      sessionId: this.#resolvedConfig.sessionId,
      threadId: this.#currentThreadId,
      previousStatus: this.#status,
      toolNameByItemId: this.#toolNameByItemId,
    });

    for (const event of events) {
      this.#callbacks.emitEvent(event);
    }
  }

  async #clientRequest<T>(method: string, params?: unknown): Promise<T> {
    if (!this.#client || !this.#resolvedConfig) {
      throw new Error("Codex backend adapter is not bootstrapped.");
    }

    return await this.#client.sendRequest<T>(method, params, this.#resolvedConfig.requestTimeoutMs);
  }

  #ensureReady(): void {
    if (!this.#client || !this.#config || !this.#resolvedConfig) {
      throw new Error("Codex backend adapter is not bootstrapped.");
    }

    if (!this.#currentThreadId && this.#status !== "starting") {
      throw new Error("Codex backend adapter does not have an active thread.");
    }
  }

  #isBusy(): boolean {
    return this.#startRequestPending || this.#activeTurnId !== null || this.#status === "busy";
  }

  #updateStatus(
    status: SessionStatus,
    error?: SessionErrorInfo,
    contextUsage?: SessionContextUsage | null,
  ): void {
    const resolvedContextUsage = contextUsage === undefined ? this.#lastContextUsage : contextUsage;
    if (
      this.#status === status &&
      error === undefined &&
      areContextUsagesEqual(this.#lastContextUsage, resolvedContextUsage ?? null)
    ) {
      return;
    }

    this.#status = status;
    this.#callbacks.emitStatusChange(status, error, resolvedContextUsage);
  }

  #cleanupState(): void {
    this.#client = null;
    this.#activeTurnId = null;
    this.#currentThreadId = null;
    this.#startRequestPending = false;
    this.#queuedSteers = [];
    this.#queuedTurns = [];
    this.#interruptOnTurnStart = false;
    this.#toolNameByItemId.clear();
  }

  #model(): string | undefined {
    return readString(this.#config?.model);
  }

  async #handleServerRequest(request: JsonRpcRequestMessage): Promise<unknown> {
    switch (request.method) {
      case "item/tool/call": {
        if (!this.#hostToolBridge) {
          throw new Error("No host tool bridge configured for this Codex session.");
        }

        const params = request.params as {
          tool?: unknown;
          callId?: unknown;
          arguments?: unknown;
        };

        return await this.#hostToolBridge.handleToolCall({
          tool: typeof params?.tool === "string" ? params.tool : "",
          callId: typeof params?.callId === "string" ? params.callId : "tool-call",
          arguments: params?.arguments,
        });
      }

      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        return {
          decision: "accept",
        };

      case "item/tool/requestUserInput": {
        const questions =
          (request.params as { questions?: Array<{ id?: unknown }> } | undefined)?.questions ?? [];
        const answers: Record<string, { answers: string[] }> = {};

        for (const question of questions) {
          if (!question || typeof question.id !== "string") {
            continue;
          }

          answers[question.id] = {
            answers: [],
          };
        }

        return {
          answers,
        };
      }

      default:
        throw new Error(`Unsupported server request: ${request.method}`);
    }
  }
}

function resolveCodexConfig(config: SessionRuntimeConfig): ResolvedCodexConfig {
  const backendConfig = config.backendConfig;
  const envOverrides = readStringRecord(backendConfig.env);

  return {
    sessionId:
      readString(backendConfig.swarmdSessionId) ??
      readString(backendConfig.sessionId) ??
      "codex-session",
    command: readString(backendConfig.command) ?? DEFAULT_CODEX_COMMAND,
    args: readStringArray(backendConfig.args) ?? DEFAULT_CODEX_ARGS,
    spawnOptions: {
      cwd: readString(backendConfig.cwd) ?? config.cwd,
      env: {
        ...process.env,
        ...envOverrides,
      },
    },
    requestTimeoutMs: readPositiveNumber(backendConfig.requestTimeoutMs) ?? DEFAULT_REQUEST_TIMEOUT_MS,
    approvalPolicy: readApprovalPolicy(backendConfig.approvalPolicy) ?? "never",
    sandbox: readSandboxMode(backendConfig.sandbox) ?? "danger-full-access",
    clientInfo: {
      name: readString(readObject(backendConfig.clientInfo)?.name) ?? "swarmd",
      title: readString(readObject(backendConfig.clientInfo)?.title) ?? "swarmd",
      version: readString(readObject(backendConfig.clientInfo)?.version) ?? "0.1.0",
    },
    experimentalApi: readBoolean(backendConfig.experimentalApi) ?? true,
    experimentalRawEvents: readBoolean(backendConfig.experimentalRawEvents) ?? false,
    persistExtendedHistory: readBoolean(backendConfig.persistExtendedHistory) ?? true,
    ephemeralThreads: readBoolean(backendConfig.ephemeralThreads) ?? false,
    hostToolsRole: readMiddlemanRole(readObject(backendConfig.middleman)?.role),
  };
}

function readMiddlemanRole(value: unknown): MiddlemanRole | undefined {
  return value === "manager" || value === "worker" ? value : undefined;
}

function toCodexInputItems(input: UserInput): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];

  for (const part of input.parts) {
    switch (part.type) {
      case "text":
        items.push({
          type: "text",
          text: part.text,
          text_elements: [],
        });
        break;
      case "image":
        items.push({
          type: "image",
          url: `data:${part.mimeType};base64,${part.data}`,
        });
        break;
      case "file":
        if (part.path) {
          items.push({
            type: "mention",
            name: part.fileName ?? part.path.split("/").at(-1) ?? "file",
            path: part.path,
          });
          break;
        }

        if (part.data) {
          const text = decodeBase64Utf8(part.data);
          if (text !== null) {
            items.push({
              type: "text",
              text,
              text_elements: [],
            });
          }
        }
        break;
    }
  }

  if (items.length === 0) {
    items.push({
      type: "text",
      text: "",
      text_elements: [],
    });
  }

  return items;
}

function sandboxThreadConfig(sandbox: ResolvedCodexConfig["sandbox"] | undefined): Record<string, string> {
  return {
    sandbox_mode: sandbox ?? "danger-full-access",
  };
}

function readActiveTurnId(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }

  for (let index = value.length - 1; index >= 0; index -= 1) {
    const turn = readObject(value[index]);
    if (readString(turn?.status) !== "inProgress") {
      continue;
    }

    return readString(turn?.id) ?? null;
  }

  return null;
}

function readTurnId(value: unknown): string | null {
  return readString(readObject(value)?.id) ?? null;
}

function parseToolLikeItem(value: unknown): ({ id: string; type: string } & Record<string, unknown>) | null {
  const item = readObject(value);
  const id = readString(item?.id);
  const type = readString(item?.type);
  if (!item || !id || !type) {
    return null;
  }

  return {
    ...item,
    id,
    type,
  };
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
      ...(typeof (error as Error & { code?: unknown }).code === "number"
        ? { code: (error as Error & { code?: unknown }).code }
        : {}),
    };
  }

  const objectError = readObject(error);
  if (objectError) {
    return {
      ...objectError,
      message: readString(objectError.message) ?? String(error),
    };
  }

  return {
    message: String(error),
  };
}

function toSessionErrorInfo(code: string, error: unknown, retryable: boolean): SessionErrorInfo {
  const details = serializeError(error);
  const message = readString(details.message) ?? "Codex runtime failed.";

  return {
    code,
    message,
    retryable,
    ...(Object.keys(details).length > 0 ? { details } : {}),
  };
}

function extractCodexContextUsage(params: unknown): SessionContextUsage | null {
  const tokenUsage = readObject(params, "tokenUsage");
  if (!tokenUsage) {
    return null;
  }

  const last = readObject(tokenUsage.last) ?? readObject(tokenUsage.last_token_usage);
  const contextWindow =
    readPositiveNumber(tokenUsage.modelContextWindow) ??
    readPositiveNumber(tokenUsage.model_context_window);
  if (!last || !contextWindow) {
    return null;
  }

  const tokens =
    readNonNegativeNumber(last.totalTokens) ??
    readNonNegativeNumber(last.total_tokens) ??
    (
      (readNonNegativeNumber(last.inputTokens) ?? readNonNegativeNumber(last.input_tokens) ?? 0) +
      (readNonNegativeNumber(last.outputTokens) ?? readNonNegativeNumber(last.output_tokens) ?? 0)
    );

  return {
    tokens,
    contextWindow,
    percent: Math.max(0, Math.min(100, (tokens / contextWindow) * 100)),
  };
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

function readObject(value: unknown, key?: string): Record<string, unknown> | undefined {
  const candidate = key ? (value as Record<string, unknown> | undefined)?.[key] : value;
  return candidate && typeof candidate === "object" ? (candidate as Record<string, unknown>) : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const values = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return values.length > 0 ? values : undefined;
}

function readStringRecord(value: unknown): Record<string, string | undefined> | undefined {
  const record = readObject(value);
  if (!record) {
    return undefined;
  }

  const output: Record<string, string | undefined> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "string") {
      output[key] = entry;
    }
  }

  return output;
}

function readApprovalPolicy(value: unknown): ResolvedCodexConfig["approvalPolicy"] | undefined {
  switch (value) {
    case "never":
    case "on-request":
    case "untrusted":
    case "on-failure":
      return value;
    default:
      return undefined;
  }
}

function readSandboxMode(value: unknown): ResolvedCodexConfig["sandbox"] | undefined {
  switch (value) {
    case "danger-full-access":
    case "workspace-write":
    case "read-only":
      return value;
    default:
      return undefined;
  }
}

function decodeBase64Utf8(data: string): string | null {
  try {
    return Buffer.from(data, "base64").toString("utf8");
  } catch {
    return null;
  }
}

export function createCodexBackendAdapter(
  callbacks: AdapterCallbacks,
  options?: CodexBackendAdapterOptions,
): BackendAdapter {
  return new CodexBackendAdapter(callbacks, options);
}
