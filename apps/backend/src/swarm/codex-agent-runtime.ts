import { randomUUID } from "node:crypto";
import { SessionManager, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { CodexJsonRpcClient, type JsonRpcNotificationMessage, type JsonRpcRequestMessage } from "./codex-jsonrpc-client.js";
import {
  createCodexToolBridge,
  type CodexDynamicToolCallResponse,
  type CodexToolBridge
} from "./codex-tool-bridge.js";
import {
  buildRuntimeMessageKey,
  consumePendingDeliveryByMessageKey,
  extractMessageKeyFromRuntimeContent,
  normalizeRuntimeError,
  normalizeRuntimeImageAttachments,
  normalizeRuntimeUserMessage,
  previewForLog
} from "./runtime-utils.js";
import { transitionAgentStatus } from "./agent-state-machine.js";
import {
  persistSessionEntryForCustomRuntime,
  requiresManualCustomEntryPersistence
} from "./session-custom-entry-persistence.js";
import type {
  RuntimeImageAttachment,
  RuntimeErrorEvent,
  RuntimeSessionEvent,
  RuntimeUserMessage,
  RuntimeUserMessageInput,
  SwarmAgentRuntime,
  SwarmRuntimeCallbacks
} from "./runtime-types.js";
import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentStatus,
  RequestedDeliveryMode,
  SendMessageReceipt
} from "./types.js";

const CODEX_RUNTIME_STATE_ENTRY_TYPE = "swarm_codex_runtime_state";
const CODEX_SANDBOX_MODE = "danger-full-access";
const MAX_TOOL_ITEM_PREVIEW_BYTES = 2 * 1024;
const MAX_TOOL_ITEM_STRING_BYTES = 256;
const MAX_TOOL_ITEM_PREVIEW_FIELDS = 16;
const TOOL_ITEM_PREVIEW_TRUNCATED_SUFFIX = " [truncated]";

interface CodexRuntimeState {
  threadId: string;
}

interface CodexSandboxSettings {
  sandboxMode: typeof CODEX_SANDBOX_MODE;
  threadConfig: {
    sandbox_mode: typeof CODEX_SANDBOX_MODE;
  };
  turnSandboxPolicy: {
    type: "dangerFullAccess";
  };
}

interface PendingDelivery {
  deliveryId: string;
  messageKey: string;
}

interface QueuedSteer {
  deliveryId: string;
  message: RuntimeUserMessage;
}

export class CodexAgentRuntime implements SwarmAgentRuntime {
  readonly descriptor: AgentDescriptor;

  private readonly callbacks: SwarmRuntimeCallbacks;
  private readonly now: () => string;
  private readonly systemPrompt: string;
  private readonly sessionManager: SessionManager;
  private readonly requiresManualCustomEntryPersistence: boolean;
  private readonly toolBridge: CodexToolBridge;
  private readonly sandboxSettings: CodexSandboxSettings;

  private readonly rpc: CodexJsonRpcClient;

  private status: AgentStatus;
  private threadId: string | undefined;
  private activeTurnId: string | undefined;
  private startRequestPending = false;

  private pendingDeliveries: PendingDelivery[] = [];
  private queuedSteers: QueuedSteer[] = [];
  private readonly toolNameByItemId = new Map<string, string>();

  private constructor(options: {
    descriptor: AgentDescriptor;
    callbacks: SwarmRuntimeCallbacks;
    now?: () => string;
    systemPrompt: string;
    tools: ToolDefinition[];
    runtimeEnv?: Record<string, string | undefined>;
  }) {
    this.descriptor = options.descriptor;
    this.callbacks = options.callbacks;
    this.now = options.now ?? (() => new Date().toISOString());
    this.systemPrompt = options.systemPrompt;
    this.status = options.descriptor.status;

    this.sessionManager = SessionManager.open(options.descriptor.sessionFile);
    this.requiresManualCustomEntryPersistence = requiresManualCustomEntryPersistence(this.sessionManager);
    this.toolBridge = createCodexToolBridge(options.tools);
    this.sandboxSettings = buildCodexSandboxSettings();

    const command = process.env.CODEX_BIN?.trim() || "codex";
    const runtimeEnv: NodeJS.ProcessEnv = {
      ...process.env
    };

    for (const [name, value] of Object.entries(options.runtimeEnv ?? {})) {
      if (typeof value === "string" && value.trim().length > 0) {
        runtimeEnv[name] = value;
      } else {
        delete runtimeEnv[name];
      }
    }

    this.rpc = new CodexJsonRpcClient({
      command,
      args: ["app-server", "--listen", "stdio://"],
      spawnOptions: {
        cwd: options.descriptor.cwd,
        env: runtimeEnv
      },
      onNotification: async (notification) => {
        await this.handleNotification(notification);
      },
      onRequest: async (request) => {
        return await this.handleServerRequest(request);
      },
      onExit: (error) => {
        void this.handleProcessExit(error);
      },
      onStderr: () => {
        // Intentionally ignored. Codex emits debug logs on stderr.
      }
    });
  }

  static async create(options: {
    descriptor: AgentDescriptor;
    callbacks: SwarmRuntimeCallbacks;
    now?: () => string;
    systemPrompt: string;
    tools: ToolDefinition[];
    runtimeEnv?: Record<string, string | undefined>;
  }): Promise<CodexAgentRuntime> {
    const runtime = new CodexAgentRuntime(options);

    try {
      await runtime.initialize();
      return runtime;
    } catch (error) {
      runtime.rpc.dispose();

      const normalized = normalizeCodexStartupError(error);
      runtime.logRuntimeError("startup", normalized, {
        action: "initialize"
      });
      throw normalized;
    }
  }

  getStatus(): AgentStatus {
    return this.status;
  }

  getPendingCount(): number {
    return this.pendingDeliveries.length;
  }

  getContextUsage(): AgentContextUsage | undefined {
    return undefined;
  }

  async sendMessage(
    input: RuntimeUserMessageInput,
    _requestedMode: RequestedDeliveryMode = "auto"
  ): Promise<SendMessageReceipt> {
    this.ensureNotTerminated();

    const message = normalizeRuntimeUserMessage(input);
    const deliveryId = randomUUID();

    if (this.activeTurnId || this.startRequestPending) {
      this.queueSteer(deliveryId, message);
      await this.flushSteersIfPossible();
      await this.emitStatus();

      return {
        targetAgentId: this.descriptor.agentId,
        deliveryId,
        acceptedMode: "steer"
      };
    }

    try {
      await this.startTurn(message);
    } catch (error) {
      await this.recoverFromTurnFailure("prompt_start", error, {
        textPreview: previewForLog(message.text),
        imageCount: message.images?.length ?? 0
      });
      throw error;
    }

    return {
      targetAgentId: this.descriptor.agentId,
      deliveryId,
      acceptedMode: "prompt"
    };
  }

  async terminate(options?: { abort?: boolean }): Promise<void> {
    if (this.status === "terminated") {
      return;
    }

    const shouldAbort = options?.abort ?? true;
    if (shouldAbort && this.threadId && this.activeTurnId) {
      try {
        await this.rpc.request("turn/interrupt", {
          threadId: this.threadId,
          turnId: this.activeTurnId
        });
      } catch (error) {
        this.logRuntimeError("interrupt", error, {
          threadId: this.threadId,
          turnId: this.activeTurnId
        });
        // Ignore best-effort interruption errors during shutdown.
      }
    }

    this.rpc.dispose();

    this.pendingDeliveries = [];
    this.queuedSteers = [];
    this.toolNameByItemId.clear();
    this.threadId = undefined;
    this.activeTurnId = undefined;
    this.startRequestPending = false;

    this.status = transitionAgentStatus(this.status, "terminated");
    this.descriptor.status = this.status;
    this.descriptor.updatedAt = this.now();

    await this.emitStatus();
  }

  async stopInFlight(options?: { abort?: boolean }): Promise<void> {
    if (this.status === "terminated") {
      return;
    }

    const shouldAbort = options?.abort ?? true;
    if (shouldAbort && this.threadId && this.activeTurnId) {
      try {
        await this.rpc.request("turn/interrupt", {
          threadId: this.threadId,
          turnId: this.activeTurnId
        });
      } catch (error) {
        this.logRuntimeError("interrupt", error, {
          threadId: this.threadId,
          turnId: this.activeTurnId
        });
      }
    }

    this.pendingDeliveries = [];
    this.queuedSteers = [];
    this.startRequestPending = false;
    this.activeTurnId = undefined;

    await this.updateStatus("idle");
  }

  async compact(): Promise<unknown> {
    this.ensureNotTerminated();
    throw new Error(`Agent ${this.descriptor.agentId} does not support manual compaction`);
  }

  getCustomEntries(customType: string): unknown[] {
    const entries = this.sessionManager.getEntries();
    const matches: unknown[] = [];

    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === customType) {
        matches.push(entry.data);
      }
    }

    return matches;
  }

  appendCustomEntry(customType: string, data?: unknown): void {
    const entryId = this.sessionManager.appendCustomEntry(customType, data);

    if (!this.requiresManualCustomEntryPersistence) {
      return;
    }

    try {
      persistSessionEntryForCustomRuntime(this.sessionManager, entryId);
    } catch (error) {
      this.logRuntimeError("startup", error, {
        action: "persist_custom_entry",
        customType
      });
    }
  }

  private async initialize(): Promise<void> {
    await this.rpc.request("initialize", {
      clientInfo: {
        name: "swarm",
        title: "Swarm",
        version: "1.0.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });

    this.rpc.notify("initialized");

    await this.ensureAuth();
    await this.bootstrapThread();
  }

  private async ensureAuth(): Promise<void> {
    const account = await this.readAccount();
    if (!account.requiresOpenaiAuth || account.account) {
      return;
    }

    const apiKey = process.env.CODEX_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
    if (apiKey) {
      await this.rpc.request("account/login/start", {
        type: "apiKey",
        apiKey
      });
    }

    const refreshed = await this.readAccount();
    if (!refreshed.requiresOpenaiAuth || refreshed.account) {
      return;
    }

    throw new Error(
      "Codex runtime requires authentication. Run `codex login` or set CODEX_API_KEY in Settings."
    );
  }

  private async readAccount(): Promise<{ requiresOpenaiAuth: boolean; account: unknown }> {
    const result = await this.rpc.request<{
      requiresOpenaiAuth?: unknown;
      account?: unknown;
    }>("account/read", {
      refreshToken: false
    });

    return {
      requiresOpenaiAuth: result.requiresOpenaiAuth === true,
      account: result.account
    };
  }

  private async bootstrapThread(): Promise<void> {
    const persisted = this.readPersistedRuntimeState();
    if (persisted?.threadId) {
      try {
        const resumed = await this.rpc.request<{ thread?: { id?: unknown } }>("thread/resume", {
          threadId: persisted.threadId,
          cwd: this.descriptor.cwd,
          approvalPolicy: "never",
          sandbox: this.sandboxSettings.sandboxMode,
          config: this.sandboxSettings.threadConfig,
          developerInstructions: this.systemPrompt
        });

        const resumedThreadId = parseThreadId(resumed.thread?.id);
        if (resumedThreadId) {
          this.threadId = resumedThreadId;
          this.persistRuntimeState();
          return;
        }
      } catch (error) {
        this.logRuntimeError("thread_resume", error, {
          threadId: persisted.threadId
        });
        // Fall through to thread/start when resume fails.
      }
    }

    const started = await this.rpc.request<{ thread?: { id?: unknown } }>("thread/start", {
      cwd: this.descriptor.cwd,
      approvalPolicy: "never",
      sandbox: this.sandboxSettings.sandboxMode,
      config: this.sandboxSettings.threadConfig,
      developerInstructions: this.systemPrompt,
      dynamicTools: this.toolBridge.dynamicTools
    });

    const startedThreadId = parseThreadId(started.thread?.id);
    if (!startedThreadId) {
      throw new Error("Codex runtime did not return a thread id");
    }

    this.threadId = startedThreadId;
    this.persistRuntimeState();
  }

  private readPersistedRuntimeState(): CodexRuntimeState | undefined {
    const entries = this.getCustomEntries(CODEX_RUNTIME_STATE_ENTRY_TYPE);

    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const maybe = entries[index] as { threadId?: unknown } | undefined;
      if (!maybe || typeof maybe.threadId !== "string" || maybe.threadId.trim().length === 0) {
        continue;
      }

      return {
        threadId: maybe.threadId
      };
    }

    return undefined;
  }

  private persistRuntimeState(): void {
    if (!this.threadId) {
      return;
    }

    this.appendCustomEntry(CODEX_RUNTIME_STATE_ENTRY_TYPE, {
      threadId: this.threadId
    });
  }

  private async startTurn(message: RuntimeUserMessage): Promise<void> {
    this.ensureNotTerminated();

    if (!this.threadId) {
      throw new Error("Codex runtime thread is not initialized");
    }

    this.startRequestPending = true;

    try {
      const response = await this.rpc.request<{ turn?: { id?: unknown } }>("turn/start", {
        threadId: this.threadId,
        cwd: this.descriptor.cwd,
        sandboxPolicy: this.sandboxSettings.turnSandboxPolicy,
        input: toCodexInputItems(message)
      });

      const turnId = parseThreadId(response.turn?.id);
      if (turnId) {
        this.activeTurnId = turnId;
      }

      await this.updateStatus("streaming");
      await this.flushSteersIfPossible();
    } finally {
      this.startRequestPending = false;
    }
  }

  private queueSteer(deliveryId: string, message: RuntimeUserMessage): void {
    this.queuedSteers.push({
      deliveryId,
      message
    });

    this.pendingDeliveries.push({
      deliveryId,
      messageKey: buildRuntimeMessageKey(message)
    });
  }

  private async flushSteersIfPossible(): Promise<void> {
    if (!this.threadId || !this.activeTurnId) {
      return;
    }

    while (this.queuedSteers.length > 0 && this.activeTurnId) {
      const queued = this.queuedSteers[0];

      try {
        await this.rpc.request("turn/steer", {
          threadId: this.threadId,
          expectedTurnId: this.activeTurnId,
          input: toCodexInputItems(queued.message)
        });

        this.queuedSteers.shift();
      } catch (error) {
        await this.recoverFromTurnFailure("steer_delivery", error, {
          queuedDeliveryId: queued.deliveryId,
          queuedCount: this.queuedSteers.length,
          pendingCount: this.pendingDeliveries.length,
          activeTurnId: this.activeTurnId
        });
        break;
      }
    }
  }

  private async handleNotification(notification: JsonRpcNotificationMessage): Promise<void> {
    switch (notification.method) {
      case "turn/started": {
        const turnId = parseThreadId(
          (notification.params as { turn?: { id?: unknown } } | undefined)?.turn?.id
        );

        if (turnId) {
          this.activeTurnId = turnId;
        }

        this.startRequestPending = false;
        await this.emitSessionEvent({ type: "agent_start" });
        await this.emitSessionEvent({ type: "turn_start" });
        await this.updateStatus("streaming");
        await this.flushSteersIfPossible();
        return;
      }

      case "turn/completed": {
        this.startRequestPending = false;
        this.activeTurnId = undefined;

        await this.emitSessionEvent({
          type: "turn_end",
          toolResults: []
        });
        await this.emitSessionEvent({ type: "agent_end" });

        if (this.status !== "terminated") {
          await this.updateStatus("idle");
        }

        if (this.callbacks.onAgentEnd) {
          await this.callbacks.onAgentEnd(this.descriptor.agentId);
        }

        return;
      }

      case "item/started": {
        await this.handleItemEvent("started", notification.params);
        return;
      }

      case "item/completed": {
        await this.handleItemEvent("completed", notification.params);
        return;
      }

      case "item/agentMessage/delta": {
        const params = notification.params as {
          delta?: unknown;
        };

        const delta = typeof params?.delta === "string" ? params.delta : "";
        await this.emitSessionEvent({
          type: "message_update",
          message: {
            role: "assistant",
            content: delta
          }
        });
        return;
      }

      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta": {
        const params = notification.params as {
          itemId?: unknown;
          delta?: unknown;
        };

        const itemId = typeof params?.itemId === "string" ? params.itemId : "unknown";
        const toolName = this.toolNameByItemId.get(itemId) ?? notification.method;

        await this.emitSessionEvent({
          type: "tool_execution_update",
          toolName,
          toolCallId: itemId,
          partialResult: typeof params?.delta === "string" ? params.delta : ""
        });

        return;
      }

      default:
        return;
    }
  }

  private async handleItemEvent(stage: "started" | "completed", params: unknown): Promise<void> {
    const item = parseThreadItemFromNotification(params);
    if (!item) {
      return;
    }

    if (item.type === "userMessage") {
      const message = toRuntimeMessageFromUserItem(item.content);

      if (stage === "started") {
        await this.emitSessionEvent({
          type: "message_start",
          message: {
            role: "user",
            content: message
          }
        });

        const key = extractMessageKeyFromRuntimeContent(message);
        if (key) {
          this.consumePendingMessage(key);
          await this.emitStatus();
        }

        return;
      }

      await this.emitSessionEvent({
        type: "message_end",
        message: {
          role: "user",
          content: message
        }
      });

      return;
    }

    if (item.type === "agentMessage") {
      const eventType = stage === "started" ? "message_start" : "message_end";
      await this.emitSessionEvent({
        type: eventType,
        message: {
          role: "assistant",
          content: item.text
        }
      });
      return;
    }

    if (isToolLikeThreadItem(item.type)) {
      if (stage === "started") {
        const toolName = toolNameForThreadItem(item);
        this.toolNameByItemId.set(item.id, toolName);

        await this.emitSessionEvent({
          type: "tool_execution_start",
          toolName,
          toolCallId: item.id,
          args: summarizeToolItemForEvent(toolName, "start", item)
        });
        return;
      }

      const toolName = this.toolNameByItemId.get(item.id) ?? toolNameForThreadItem(item);
      this.toolNameByItemId.delete(item.id);

      await this.emitSessionEvent({
        type: "tool_execution_end",
        toolName,
        toolCallId: item.id,
        result: summarizeToolItemForEvent(toolName, "end", item),
        isError: threadItemRepresentsError(item)
      });
    }
  }

  private consumePendingMessage(messageKey: string): void {
    consumePendingDeliveryByMessageKey(this.pendingDeliveries, messageKey);
  }

  private async handleServerRequest(request: JsonRpcRequestMessage): Promise<unknown> {
    switch (request.method) {
      case "item/tool/call": {
        const params = request.params as {
          tool?: unknown;
          callId?: unknown;
          arguments?: unknown;
        };

        const tool = typeof params?.tool === "string" ? params.tool : "";
        const callId = typeof params?.callId === "string" ? params.callId : "tool-call";

        const response: CodexDynamicToolCallResponse = await this.toolBridge.handleToolCall({
          tool,
          callId,
          arguments: params?.arguments
        });

        return response;
      }

      case "item/commandExecution/requestApproval":
        return {
          decision: "accept"
        };

      case "item/fileChange/requestApproval":
        return {
          decision: "accept"
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
            answers: []
          };
        }

        return {
          answers
        };
      }

      default:
        throw new Error(`Unsupported server request: ${request.method}`);
    }
  }

  private async handleProcessExit(error: Error): Promise<void> {
    if (this.status === "terminated") {
      return;
    }

    this.logRuntimeError("runtime_exit", error, {
      activeTurnId: this.activeTurnId,
      queuedCount: this.queuedSteers.length,
      pendingCount: this.pendingDeliveries.length
    });
    await this.reportRuntimeError({
      phase: "runtime_exit",
      message: error.message,
      stack: error.stack,
      details: {
        activeTurnId: this.activeTurnId,
        queuedCount: this.queuedSteers.length,
        pendingCount: this.pendingDeliveries.length
      }
    });

    this.pendingDeliveries = [];
    this.queuedSteers = [];
    this.toolNameByItemId.clear();
    this.startRequestPending = false;
    this.activeTurnId = undefined;
    this.threadId = undefined;

    this.status = transitionAgentStatus(this.status, "terminated");
    this.descriptor.status = this.status;
    this.descriptor.updatedAt = this.now();

    await this.emitStatus();

    await this.emitSessionEvent({
      type: "tool_execution_end",
      toolName: "codex-app-server",
      toolCallId: "runtime-exit",
      result: error.message,
      isError: true
    });
  }

  private ensureNotTerminated(): void {
    if (this.status === "terminated") {
      throw new Error(`Agent ${this.descriptor.agentId} is terminated`);
    }
  }

  private async updateStatus(status: AgentStatus): Promise<void> {
    if (this.status === status) {
      await this.emitStatus();
      return;
    }

    const nextStatus = transitionAgentStatus(this.status, status);
    this.status = nextStatus;
    this.descriptor.status = nextStatus;
    this.descriptor.updatedAt = this.now();

    await this.emitStatus();
  }

  private async emitStatus(): Promise<void> {
    await this.callbacks.onStatusChange(
      this.descriptor.agentId,
      this.status,
      this.pendingDeliveries.length,
      this.getContextUsage()
    );
  }

  private async emitSessionEvent(event: RuntimeSessionEvent): Promise<void> {
    if (!this.callbacks.onSessionEvent) {
      return;
    }

    await this.callbacks.onSessionEvent(this.descriptor.agentId, event);
  }

  private async recoverFromTurnFailure(
    phase: RuntimeErrorEvent["phase"],
    error: unknown,
    details?: Record<string, unknown>
  ): Promise<void> {
    const normalized = normalizeRuntimeError(error);
    this.logRuntimeError(phase, error, details);
    await this.reportRuntimeError({
      phase,
      message: normalized.message,
      stack: normalized.stack,
      details
    });

    if (this.status === "terminated") {
      return;
    }

    const hadActiveTurn = this.status === "streaming" || Boolean(this.activeTurnId);
    this.startRequestPending = false;
    this.activeTurnId = undefined;
    await this.updateStatus("idle");

    if (hadActiveTurn) {
      await this.emitSessionEvent({
        type: "turn_end",
        toolResults: []
      });
      await this.emitSessionEvent({ type: "agent_end" });

      if (this.callbacks.onAgentEnd) {
        try {
          await this.callbacks.onAgentEnd(this.descriptor.agentId);
        } catch (callbackError) {
          this.logRuntimeError(phase, callbackError, {
            callback: "onAgentEnd"
          });
        }
      }
    }
  }

  private async reportRuntimeError(error: RuntimeErrorEvent): Promise<void> {
    if (!this.callbacks.onRuntimeError) {
      return;
    }

    try {
      await this.callbacks.onRuntimeError(this.descriptor.agentId, error);
    } catch (callbackError) {
      this.logRuntimeError(error.phase, callbackError, {
        callback: "onRuntimeError"
      });
    }
  }

  private logRuntimeError(
    phase: RuntimeErrorEvent["phase"],
    error: unknown,
    details?: Record<string, unknown>
  ): void {
    const normalized = normalizeRuntimeError(error);
    console.error(`[swarm][${this.now()}] runtime:error`, {
      runtime: "codex-app-server",
      agentId: this.descriptor.agentId,
      phase,
      message: normalized.message,
      stack: normalized.stack,
      ...details
    });
  }
}

// Codex app-server defaults new threads to read-only sandboxing.
// We use danger-full-access so agents have unrestricted filesystem access.
function buildCodexSandboxSettings(): CodexSandboxSettings {
  return {
    sandboxMode: CODEX_SANDBOX_MODE,
    threadConfig: {
      sandbox_mode: CODEX_SANDBOX_MODE,
    },
    turnSandboxPolicy: {
      type: "dangerFullAccess",
    }
  };
}

function normalizeCodexStartupError(error: unknown): Error {
  if (isSpawnEnoentError(error)) {
    return new Error(
      "Codex CLI is not installed or not available on PATH. Install codex or choose a pi-* model preset."
    );
  }

  return error instanceof Error ? error : new Error(String(error));
}

function isSpawnEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function parseThreadId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseThreadItemFromNotification(value: unknown):
  | {
      type: string;
      id: string;
      text?: string;
      content?: unknown[];
      [key: string]: unknown;
    }
  | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const item = (value as { item?: unknown }).item;
  if (!item || typeof item !== "object") {
    return undefined;
  }

  const typed = item as {
    type?: unknown;
    id?: unknown;
    text?: unknown;
    content?: unknown;
  };

  if (typeof typed.type !== "string" || typeof typed.id !== "string") {
    return undefined;
  }

  return {
    ...(item as Record<string, unknown>),
    type: typed.type,
    id: typed.id,
    text: typeof typed.text === "string" ? typed.text : undefined,
    content: Array.isArray(typed.content) ? typed.content : undefined
  };
}

function isToolLikeThreadItem(type: string): boolean {
  return (
    type === "commandExecution" ||
    type === "fileChange" ||
    type === "mcpToolCall" ||
    type === "collabAgentToolCall" ||
    type === "webSearch" ||
    type === "imageView"
  );
}

function toolNameForThreadItem(item: { type: string; [key: string]: unknown }): string {
  switch (item.type) {
    case "commandExecution":
      return "command_execution";

    case "fileChange":
      return "file_change";

    case "mcpToolCall": {
      const server = typeof item.server === "string" ? item.server : "unknown";
      const tool = typeof item.tool === "string" ? item.tool : "unknown";
      return `mcp:${server}/${tool}`;
    }

    case "collabAgentToolCall": {
      const tool = typeof item.tool === "string" ? item.tool : "unknown";
      return `collab:${tool}`;
    }

    case "webSearch":
      return "web_search";

    case "imageView":
      return "image_view";

    default:
      return item.type;
  }
}

function threadItemRepresentsError(item: { type: string; [key: string]: unknown }): boolean {
  switch (item.type) {
    case "commandExecution":
    case "fileChange": {
      const status = typeof item.status === "string" ? item.status : "";
      return status === "failed" || status === "declined";
    }

    case "mcpToolCall":
    case "collabAgentToolCall": {
      const status = typeof item.status === "string" ? item.status : "";
      return status === "failed";
    }

    default:
      return false;
  }
}

function toCodexInputItems(message: RuntimeUserMessage): unknown[] {
  const items: unknown[] = [];
  const text = message.text ?? "";

  if (text.length > 0 || !(message.images && message.images.length > 0)) {
    items.push({
      type: "text",
      text,
      text_elements: []
    });
  }

  for (const image of normalizeRuntimeImageAttachments(message.images)) {
    items.push({
      type: "image",
      url: toDataUrl(image)
    });
  }

  return items;
}

function toRuntimeMessageFromUserItem(content: unknown[] | undefined): unknown {
  if (!content || content.length === 0) {
    return "";
  }

  const textParts: string[] = [];
  const imageParts: RuntimeImageAttachment[] = [];

  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const typed = item as {
      type?: unknown;
      text?: unknown;
      url?: unknown;
    };

    if (typed.type === "text" && typeof typed.text === "string") {
      textParts.push(typed.text);
      continue;
    }

    if (typed.type === "image" && typeof typed.url === "string") {
      const parsed = parseDataUrl(typed.url);
      if (parsed) {
        imageParts.push(parsed);
      }
    }
  }

  const text = textParts.join("\n").trim();

  if (imageParts.length === 0) {
    return text;
  }

  const parts: Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }> = [];

  if (text.length > 0) {
    parts.push({
      type: "text",
      text
    });
  }

  for (const image of imageParts) {
    parts.push({
      type: "image",
      mimeType: image.mimeType,
      data: image.data
    });
  }

  return parts;
}

function toDataUrl(image: RuntimeImageAttachment): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

function parseDataUrl(value: string): RuntimeImageAttachment | undefined {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(value.trim());
  if (!match) {
    return undefined;
  }

  return {
    mimeType: match[1],
    data: match[2]
  };
}

function summarizeToolItemForEvent(
  toolName: string,
  stage: "start" | "end",
  item: { type: string; id: string; [key: string]: unknown }
): Record<string, unknown> {
  const status = typeof item.status === "string" ? item.status : undefined;
  return {
    toolName,
    stage,
    itemId: item.id,
    itemType: item.type,
    status,
    preview: toTruncatedPreviewString(compactToolItemForPreview(item), MAX_TOOL_ITEM_PREVIEW_BYTES)
  };
}

function compactToolItemForPreview(item: { [key: string]: unknown }): Record<string, unknown> {
  const compact: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(item)) {
    if (Object.keys(compact).length >= MAX_TOOL_ITEM_PREVIEW_FIELDS) {
      compact.__truncatedFields = true;
      break;
    }

    const compactValue = compactToolItemValue(value);
    if (compactValue === undefined) {
      continue;
    }
    compact[key] = compactValue;
  }

  return compact;
}

function compactToolItemValue(value: unknown): unknown {
  if (typeof value === "string") {
    return truncateUtf8(value, MAX_TOOL_ITEM_STRING_BYTES);
  }

  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    return `[array(${value.length})]`;
  }

  if (value && typeof value === "object") {
    return "[object]";
  }

  return undefined;
}

function toTruncatedPreviewString(value: unknown, maxBytes: number): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = String(value);
  }

  return truncateUtf8(serialized, maxBytes);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }

  const byteCount = Buffer.byteLength(value, "utf8");
  if (byteCount <= maxBytes) {
    return value;
  }

  const suffixBytes = Buffer.byteLength(TOOL_ITEM_PREVIEW_TRUNCATED_SUFFIX, "utf8");
  if (maxBytes <= suffixBytes) {
    return TOOL_ITEM_PREVIEW_TRUNCATED_SUFFIX;
  }

  const previewBytes = maxBytes - suffixBytes;
  const preview = Buffer.from(value, "utf8").subarray(0, previewBytes).toString("utf8");
  return `${preview}${TOOL_ITEM_PREVIEW_TRUNCATED_SUFFIX}`;
}
