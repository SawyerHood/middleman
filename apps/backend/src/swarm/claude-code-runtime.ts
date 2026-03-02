import { randomUUID } from "node:crypto";
import {
  AbortError,
  query,
  type McpSdkServerConfigWithInstance,
  type Options,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage
} from "@anthropic-ai/claude-agent-sdk";
import { SessionManager, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { transitionAgentStatus } from "./agent-state-machine.js";
import {
  buildClaudeCodeMcpServer,
  CLAUDE_CODE_MCP_SERVER_NAME,
  getClaudeCodeAllowedToolNames
} from "./claude-code-tool-bridge.js";
import {
  buildRuntimeMessageKey,
  consumePendingDeliveryByMessageKey,
  extractMessageKeyFromRuntimeContent,
  normalizeRuntimeError,
  normalizeRuntimeImageAttachments,
  normalizeRuntimeUserMessage
} from "./runtime-utils.js";
import type {
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

const CLAUDE_CODE_RUNTIME_STATE_ENTRY_TYPE = "swarm_claude_code_runtime_state";

interface ClaudeCodeRuntimeState {
  sessionId: string;
}

interface PendingDelivery {
  deliveryId: string;
  messageKey: string;
}

export class ClaudeCodeRuntime implements SwarmAgentRuntime {
  readonly descriptor: AgentDescriptor;

  private readonly callbacks: SwarmRuntimeCallbacks;
  private readonly now: () => string;
  private readonly systemPrompt: string;
  private readonly sessionManager: SessionManager;
  private readonly runtimeEnv: Record<string, string | undefined>;
  private readonly tools: ToolDefinition[];

  private readonly abortController = new AbortController();
  private readonly mcpServer: McpSdkServerConfigWithInstance;

  private query: Query | undefined;
  private status: AgentStatus;
  private claudeSessionId: string | undefined;
  private lastContextUsage: AgentContextUsage | undefined;
  private pendingDeliveries: PendingDelivery[] = [];
  private isProcessing = false;
  private isCompacting = false;

  private readonly activeToolNameByCallId = new Map<string, string>();

  private inputResolve: ((value: IteratorResult<SDKUserMessage>) => void) | null = null;
  private readonly inputQueue: SDKUserMessage[] = [];
  private inputDone = false;

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
    this.tools = options.tools;
    this.runtimeEnv = options.runtimeEnv ?? {};

    this.status = options.descriptor.status;
    this.sessionManager = SessionManager.open(options.descriptor.sessionFile);
    this.mcpServer = buildClaudeCodeMcpServer(options.tools, {
      serverName: CLAUDE_CODE_MCP_SERVER_NAME
    });
  }

  static async create(options: {
    descriptor: AgentDescriptor;
    callbacks: SwarmRuntimeCallbacks;
    now?: () => string;
    systemPrompt: string;
    tools: ToolDefinition[];
    runtimeEnv?: Record<string, string | undefined>;
  }): Promise<ClaudeCodeRuntime> {
    const runtime = new ClaudeCodeRuntime(options);
    runtime.startQuery();
    void runtime.consumeStream();
    return runtime;
  }

  getStatus(): AgentStatus {
    return this.status;
  }

  getPendingCount(): number {
    return this.pendingDeliveries.length;
  }

  getContextUsage(): AgentContextUsage | undefined {
    return this.lastContextUsage;
  }

  async sendMessage(
    input: RuntimeUserMessageInput,
    _requestedMode: RequestedDeliveryMode = "auto"
  ): Promise<SendMessageReceipt> {
    this.ensureNotTerminated();
    this.ensureQueryAvailable();

    const message = normalizeRuntimeUserMessage(input);
    const deliveryId = randomUUID();
    const sdkMessage = toSdkUserMessage(message, this.claudeSessionId);

    if (this.isProcessing) {
      this.pendingDeliveries.push({
        deliveryId,
        messageKey: buildRuntimeMessageKey(message)
      });
      this.pushInput(sdkMessage);
      await this.emitStatus();

      return {
        targetAgentId: this.descriptor.agentId,
        deliveryId,
        acceptedMode: "steer"
      };
    }

    this.isProcessing = true;
    this.pushInput(sdkMessage);

    await this.updateStatus("streaming");
    await this.emitSessionEvent({ type: "agent_start" });

    return {
      targetAgentId: this.descriptor.agentId,
      deliveryId,
      acceptedMode: "prompt"
    };
  }

  async terminate(_options?: { abort?: boolean }): Promise<void> {
    if (this.status === "terminated") {
      return;
    }

    this.inputDone = true;
    this.resolveInputDone();

    this.query?.close();
    this.query = undefined;

    this.pendingDeliveries = [];
    this.isProcessing = false;
    this.isCompacting = false;
    this.activeToolNameByCallId.clear();

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
    if (shouldAbort && this.query && this.isProcessing) {
      try {
        await this.query.interrupt();
      } catch (error) {
        this.logRuntimeError("interrupt", error);
      }
    }

    this.pendingDeliveries = [];
    this.clearInputQueue();
    this.isProcessing = false;
    this.activeToolNameByCallId.clear();

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
    this.sessionManager.appendCustomEntry(customType, data);
  }

  private startQuery(): void {
    const persistedState = this.readPersistedRuntimeState();

    const env: NodeJS.ProcessEnv = {
      ...process.env
    };

    for (const [name, value] of Object.entries(this.runtimeEnv)) {
      if (typeof value === "string" && value.trim().length > 0) {
        env[name] = value;
      } else {
        delete env[name];
      }
    }

    env.CLAUDE_AGENT_SDK_CLIENT_APP = "middleman-swarm/1.0.0";

    const model = this.descriptor.model.modelId?.trim();

    const options: Options = {
      abortController: this.abortController,
      cwd: this.descriptor.cwd,
      systemPrompt: this.systemPrompt,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      mcpServers: {
        [CLAUDE_CODE_MCP_SERVER_NAME]: this.mcpServer
      },
      allowedTools: getClaudeCodeAllowedToolNames(this.tools, {
        serverName: CLAUDE_CODE_MCP_SERVER_NAME
      }),
      includePartialMessages: true,
      settingSources: [],
      persistSession: true,
      env,
      ...(persistedState?.sessionId ? { resume: persistedState.sessionId } : {}),
      ...(model ? { model } : {})
    };

    this.query = query({
      prompt: this.createInputIterable(),
      options
    });
  }

  private async consumeStream(): Promise<void> {
    const queryInstance = this.query;
    if (!queryInstance) {
      return;
    }

    let streamError: unknown;

    try {
      for await (const message of queryInstance) {
        this.captureSessionId(message);
        await this.handleSdkMessage(message);
      }
    } catch (error) {
      if (this.status === "terminated") {
        return;
      }

      streamError = error;
    } finally {
      if (this.status === "terminated") {
        return;
      }

      await this.handleUnexpectedStreamExit(streamError);
    }
  }

  private async handleSdkMessage(message: SDKMessage): Promise<void> {
    switch (message.type) {
      case "system":
        await this.handleSystemMessage(message as Extract<SDKMessage, { type: "system" }>);
        return;

      case "user":
        await this.handleUserMessage(message as SDKUserMessage & { isReplay?: boolean });
        return;

      case "assistant":
        await this.handleAssistantMessage(message as Extract<SDKMessage, { type: "assistant" }>);
        return;

      case "stream_event": {
        const delta = extractStreamEventTextDelta((message as Extract<SDKMessage, { type: "stream_event" }>).event);
        if (!delta) {
          return;
        }

        await this.emitSessionEvent({
          type: "message_update",
          message: {
            role: "assistant",
            content: delta
          }
        });
        return;
      }

      case "tool_progress": {
        const toolProgress = message as Extract<SDKMessage, { type: "tool_progress" }>;
        await this.emitSessionEvent({
          type: "tool_execution_update",
          toolName: toolProgress.tool_name,
          toolCallId: toolProgress.tool_use_id,
          partialResult: {
            elapsedTimeSeconds: toolProgress.elapsed_time_seconds,
            taskId: toolProgress.task_id
          }
        });
        return;
      }

      case "result":
        await this.handleResultMessage(message as SDKResultMessage);
        return;

      default:
        return;
    }
  }

  private async handleSystemMessage(
    message: Extract<SDKMessage, { type: "system" }>
  ): Promise<void> {
    switch (message.subtype) {
      case "init":
        await this.emitSessionEvent({ type: "agent_start" });
        return;

      case "status": {
        const isCompacting = message.status === "compacting";

        if (isCompacting && !this.isCompacting) {
          this.isCompacting = true;
          await this.emitSessionEvent({ type: "auto_compaction_start" });
          return;
        }

        if (!isCompacting && this.isCompacting) {
          this.isCompacting = false;
          await this.emitSessionEvent({ type: "auto_compaction_end" });
        }

        return;
      }

      case "task_started": {
        await this.emitSessionEvent({
          type: "tool_execution_start",
          toolName: `task:${message.task_id}`,
          toolCallId: message.task_id,
          args: {
            description: message.description,
            taskType: message.task_type,
            toolUseId: message.tool_use_id
          }
        });
        return;
      }

      case "task_progress": {
        await this.emitSessionEvent({
          type: "tool_execution_update",
          toolName: `task:${message.task_id}`,
          toolCallId: message.task_id,
          partialResult: {
            description: message.description,
            usage: message.usage,
            lastToolName: message.last_tool_name,
            toolUseId: message.tool_use_id
          }
        });
        return;
      }

      case "task_notification": {
        await this.emitSessionEvent({
          type: "tool_execution_end",
          toolName: `task:${message.task_id}`,
          toolCallId: message.task_id,
          result: {
            summary: message.summary,
            outputFile: message.output_file,
            status: message.status,
            usage: message.usage,
            toolUseId: message.tool_use_id
          },
          isError: message.status !== "completed"
        });
        return;
      }

      default:
        return;
    }
  }

  private async handleUserMessage(
    message: SDKUserMessage & {
      isReplay?: boolean;
    }
  ): Promise<void> {
    if (message.isReplay) {
      return;
    }

    if (
      typeof message.parent_tool_use_id === "string" &&
      message.parent_tool_use_id.length > 0 &&
      message.tool_use_result !== undefined
    ) {
      const toolName = this.activeToolNameByCallId.get(message.parent_tool_use_id) ?? "tool";
      this.activeToolNameByCallId.delete(message.parent_tool_use_id);

      await this.emitSessionEvent({
        type: "tool_execution_end",
        toolName,
        toolCallId: message.parent_tool_use_id,
        result: message.tool_use_result,
        isError: toolUseResultRepresentsError(message.tool_use_result)
      });
      return;
    }

    if (!message.isReplay && !this.isProcessing) {
      this.isProcessing = true;
      await this.updateStatus("streaming");
      await this.emitSessionEvent({ type: "agent_start" });
    }

    const content = extractMessageParamContent(message.message);

    await this.emitSessionEvent({
      type: "message_start",
      message: {
        role: "user",
        content
      }
    });

    await this.emitSessionEvent({
      type: "message_end",
      message: {
        role: "user",
        content
      }
    });

    if (message.isReplay) {
      return;
    }

    const messageKey = extractMessageKeyFromRuntimeContent(content);
    if (!messageKey) {
      return;
    }

    consumePendingDeliveryByMessageKey(this.pendingDeliveries, messageKey);
    await this.emitStatus();
  }

  private async handleAssistantMessage(
    message: Extract<SDKMessage, { type: "assistant" }> & {
      isReplay?: boolean;
    }
  ): Promise<void> {
    if (message.isReplay) {
      return;
    }

    const content = extractAssistantContent(message.message);

    await this.emitSessionEvent({
      type: "message_start",
      message: {
        role: "assistant",
        content
      }
    });

    for (const toolUse of extractAssistantToolUses(message.message)) {
      this.activeToolNameByCallId.set(toolUse.id, toolUse.name);

      await this.emitSessionEvent({
        type: "tool_execution_start",
        toolName: toolUse.name,
        toolCallId: toolUse.id,
        args: toolUse.input
      });
    }

    await this.emitSessionEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content
      }
    });
  }

  private async handleResultMessage(message: SDKResultMessage): Promise<void> {
    this.lastContextUsage = normalizeContextUsage(message.modelUsage);

    const wasProcessing = this.isProcessing;
    this.isProcessing = false;

    if (this.status !== "terminated") {
      await this.updateStatus("idle");
    }

    if (wasProcessing) {
      await this.emitSessionEvent({ type: "agent_end" });
      if (this.callbacks.onAgentEnd) {
        await this.callbacks.onAgentEnd(this.descriptor.agentId);
      }
    }

    if (message.subtype === "success") {
      return;
    }

    const details: Record<string, unknown> = {
      subtype: message.subtype,
      stopReason: message.stop_reason,
      permissionDenials: message.permission_denials
    };

    if ("errors" in message) {
      details.errors = message.errors;
    }

    await this.reportRuntimeError({
      phase: "prompt_dispatch",
      message: extractResultErrorMessage(message),
      details
    });
  }

  private createInputIterable(): AsyncIterable<SDKUserMessage> {
    const self = this;

    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<SDKUserMessage>> {
            if (self.inputQueue.length > 0) {
              const value = self.inputQueue.shift()!;
              return { value, done: false };
            }

            if (self.inputDone) {
              return {
                value: undefined as unknown as SDKUserMessage,
                done: true
              };
            }

            return await new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
              self.inputResolve = resolve;
            });
          },
          async return(): Promise<IteratorResult<SDKUserMessage>> {
            self.inputDone = true;
            self.resolveInputDone();
            return {
              value: undefined as unknown as SDKUserMessage,
              done: true
            };
          }
        };
      }
    };
  }

  private pushInput(message: SDKUserMessage): void {
    if (this.inputDone) {
      return;
    }

    if (this.inputResolve) {
      const resolve = this.inputResolve;
      this.inputResolve = null;
      resolve({ value: message, done: false });
      return;
    }

    this.inputQueue.push(message);
  }

  private clearInputQueue(): void {
    this.inputQueue.length = 0;
  }

  private resolveInputDone(): void {
    if (!this.inputResolve) {
      return;
    }

    const resolve = this.inputResolve;
    this.inputResolve = null;
    resolve({
      value: undefined as unknown as SDKUserMessage,
      done: true
    });
  }

  private captureSessionId(message: SDKMessage): void {
    const maybeSessionId = (message as { session_id?: unknown }).session_id;

    if (typeof maybeSessionId !== "string" || maybeSessionId.trim().length === 0) {
      return;
    }

    if (this.claudeSessionId === maybeSessionId) {
      return;
    }

    this.claudeSessionId = maybeSessionId;
    this.persistRuntimeState();
  }

  private readPersistedRuntimeState(): ClaudeCodeRuntimeState | undefined {
    const entries = this.getCustomEntries(CLAUDE_CODE_RUNTIME_STATE_ENTRY_TYPE);

    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const maybe = entries[index] as { sessionId?: unknown } | undefined;
      if (!maybe || typeof maybe.sessionId !== "string" || maybe.sessionId.trim().length === 0) {
        continue;
      }

      return {
        sessionId: maybe.sessionId
      };
    }

    return undefined;
  }

  private persistRuntimeState(): void {
    if (!this.claudeSessionId) {
      return;
    }

    this.appendCustomEntry(CLAUDE_CODE_RUNTIME_STATE_ENTRY_TYPE, {
      sessionId: this.claudeSessionId
    });
  }

  private ensureNotTerminated(): void {
    if (this.status === "terminated") {
      throw new Error(`Agent ${this.descriptor.agentId} is terminated`);
    }
  }

  private ensureQueryAvailable(): void {
    if (this.query && !this.inputDone) {
      return;
    }

    throw new Error(`Agent ${this.descriptor.agentId} runtime stream is unavailable`);
  }

  private async handleUnexpectedStreamExit(error: unknown): Promise<void> {
    if (this.status === "terminated") {
      return;
    }

    if (this.isCompacting) {
      this.isCompacting = false;
      await this.emitSessionEvent({ type: "auto_compaction_end" });
    }

    const hadInFlightTurn = this.isProcessing;
    const normalized =
      error instanceof AbortError
        ? {
            message: "Claude Code runtime stream was interrupted",
            stack: error.stack
          }
        : error
          ? normalizeRuntimeError(error)
          : {
              message: "Claude Code runtime stream exited unexpectedly",
              stack: undefined
            };

    if (error) {
      this.logRuntimeError("runtime_exit", error, {
        hadInFlightTurn,
        pendingCount: this.pendingDeliveries.length
      });
    } else {
      this.logRuntimeError("runtime_exit", new Error(normalized.message), {
        hadInFlightTurn,
        pendingCount: this.pendingDeliveries.length
      });
    }

    await this.reportRuntimeError({
      phase: "runtime_exit",
      message: normalized.message,
      stack: normalized.stack,
      details: {
        hadInFlightTurn,
        pendingCount: this.pendingDeliveries.length
      }
    });

    this.pendingDeliveries = [];
    this.clearInputQueue();
    this.activeToolNameByCallId.clear();
    this.isProcessing = false;
    this.inputDone = true;
    this.resolveInputDone();
    this.query = undefined;

    if (hadInFlightTurn) {
      await this.emitSessionEvent({ type: "agent_end" });
      if (this.callbacks.onAgentEnd) {
        await this.callbacks.onAgentEnd(this.descriptor.agentId);
      }
    }

    this.status = transitionAgentStatus(this.status, "terminated");
    this.descriptor.status = this.status;
    this.descriptor.updatedAt = this.now();

    await this.emitStatus();
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
      runtime: "anthropic-claude-code",
      agentId: this.descriptor.agentId,
      phase,
      message: normalized.message,
      stack: normalized.stack,
      ...details
    });
  }
}

function extractResultErrorMessage(message: SDKResultMessage): string {
  if (message.subtype === "success") {
    return "Query completed successfully";
  }

  const firstError = message.errors.find((entry) => typeof entry === "string" && entry.trim().length > 0);
  if (firstError) {
    return firstError;
  }

  return `Claude Code runtime returned ${message.subtype}`;
}

function normalizeContextUsage(
  modelUsage: SDKResultMessage["modelUsage"]
): AgentContextUsage | undefined {
  const firstEntry = Object.values(modelUsage ?? {})[0] as
    | {
        inputTokens?: unknown;
        outputTokens?: unknown;
        contextWindow?: unknown;
      }
    | undefined;

  if (!firstEntry) {
    return undefined;
  }

  const inputTokens = typeof firstEntry.inputTokens === "number" ? firstEntry.inputTokens : NaN;
  const outputTokens = typeof firstEntry.outputTokens === "number" ? firstEntry.outputTokens : NaN;
  const contextWindow = typeof firstEntry.contextWindow === "number" ? firstEntry.contextWindow : NaN;

  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens) || !Number.isFinite(contextWindow)) {
    return undefined;
  }

  if (contextWindow <= 0) {
    return undefined;
  }

  const tokens = Math.max(0, inputTokens) + Math.max(0, outputTokens);

  return {
    tokens,
    contextWindow,
    percent: (tokens / contextWindow) * 100
  };
}

function extractMessageParamContent(message: unknown): unknown {
  if (!message || typeof message !== "object") {
    return "";
  }

  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const normalized: Array<
    | {
        type: "text";
        text: string;
      }
    | {
        type: "image";
        mimeType: string;
        data: string;
      }
  > = [];

  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }

    const typed = block as {
      type?: unknown;
      text?: unknown;
      source?: {
        type?: unknown;
        media_type?: unknown;
        data?: unknown;
      };
    };

    if (typed.type === "text" && typeof typed.text === "string") {
      normalized.push({
        type: "text",
        text: typed.text
      });
      continue;
    }

    const source = typed.source;
    if (
      typed.type === "image" &&
      source &&
      typeof source === "object" &&
      source.type === "base64" &&
      typeof source.media_type === "string" &&
      source.media_type.startsWith("image/") &&
      typeof source.data === "string"
    ) {
      normalized.push({
        type: "image",
        mimeType: source.media_type,
        data: source.data
      });
    }
  }

  if (normalized.length === 1 && normalized[0]?.type === "text") {
    return normalized[0].text;
  }

  return normalized;
}

function extractAssistantContent(message: unknown): unknown {
  if (!message || typeof message !== "object") {
    return "";
  }

  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return "";
  }

  const textChunks: string[] = [];

  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }

    const typed = block as {
      type?: unknown;
      text?: unknown;
    };

    if (typed.type === "text" && typeof typed.text === "string") {
      textChunks.push(typed.text);
    }
  }

  return textChunks.join("\n").trim();
}

function extractAssistantToolUses(message: unknown): Array<{
  id: string;
  name: string;
  input: unknown;
}> {
  if (!message || typeof message !== "object") {
    return [];
  }

  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return [];
  }

  const toolUses: Array<{
    id: string;
    name: string;
    input: unknown;
  }> = [];

  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }

    const typed = block as {
      type?: unknown;
      id?: unknown;
      name?: unknown;
      input?: unknown;
    };

    if (typed.type !== "tool_use") {
      continue;
    }

    if (typeof typed.id !== "string" || typed.id.length === 0) {
      continue;
    }

    if (typeof typed.name !== "string" || typed.name.length === 0) {
      continue;
    }

    toolUses.push({
      id: typed.id,
      name: typed.name,
      input: typed.input
    });
  }

  return toolUses;
}

function extractStreamEventTextDelta(event: unknown): string | undefined {
  if (!event || typeof event !== "object") {
    return undefined;
  }

  const eventType = (event as { type?: unknown }).type;

  if (eventType === "content_block_delta") {
    const delta = (event as {
      delta?: {
        type?: unknown;
        text?: unknown;
      };
    }).delta;

    if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
      return delta.text;
    }

    return undefined;
  }

  if (eventType === "content_block_start") {
    const contentBlock = (event as {
      content_block?: {
        type?: unknown;
        text?: unknown;
      };
    }).content_block;

    if (
      contentBlock?.type === "text" &&
      typeof contentBlock.text === "string" &&
      contentBlock.text.length > 0
    ) {
      return contentBlock.text;
    }
  }

  return undefined;
}

function toolUseResultRepresentsError(result: unknown): boolean {
  if (!result || typeof result !== "object") {
    return false;
  }

  const maybe = result as {
    is_error?: unknown;
    isError?: unknown;
    error?: unknown;
    status?: unknown;
  };

  if (maybe.is_error === true || maybe.isError === true || maybe.error === true) {
    return true;
  }

  if (typeof maybe.status === "string") {
    const normalized = maybe.status.trim().toLowerCase();
    return normalized === "failed" || normalized === "error";
  }

  return false;
}

function toSdkUserMessage(message: RuntimeUserMessage, sessionId: string | undefined): SDKUserMessage {
  const normalizedImages = normalizeRuntimeImageAttachments(message.images);

  if (normalizedImages.length === 0) {
    return {
      type: "user",
      message: {
        role: "user",
        content: message.text
      },
      parent_tool_use_id: null,
      session_id: sessionId ?? ""
    };
  }

  const content: Array<
    | {
        type: "text";
        text: string;
      }
    | {
        type: "image";
        source: {
          type: "base64";
          media_type: string;
          data: string;
        };
      }
  > = [];

  if (message.text.trim().length > 0) {
    content.push({
      type: "text",
      text: message.text
    });
  }

  for (const image of normalizedImages) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: image.mimeType,
        data: image.data
      }
    });
  }

  return {
    type: "user",
    message: {
      role: "user",
      content: content as unknown
    } as SDKUserMessage["message"],
    parent_tool_use_id: null,
    session_id: sessionId ?? ""
  };
}
