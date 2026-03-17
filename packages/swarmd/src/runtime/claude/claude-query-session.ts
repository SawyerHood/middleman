import type {
  BackendCheckpoint,
  DeliveryMode,
  SessionContextUsage,
  SessionErrorInfo,
  SessionRuntimeConfig,
  SessionStatus,
  UserInput,
} from "../../core/types/index.js";
import { createNormalizedEvent, turnStartedEvent } from "../common/index.js";
import type { AdapterCallbacks } from "../common/adapter.js";
import {
  ClaudeEventMapper,
  extractClaudeSessionId,
  isClaudeInitEvent,
  isClaudeResultEvent,
  type ClaudeSdkMessage,
} from "./claude-mapper.js";

type ClaudeCheckpoint = Extract<BackendCheckpoint, { backend: "claude" }>;

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
  settled: boolean;
};

type PendingInterruptedInput = {
  input: UserInput;
  acceptedDelivery: DeliveryMode;
};

type ClaudeSdkInputContent =
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
    };

export interface ClaudeSdkUserMessage {
  type: "user";
  session_id?: string;
  parent_tool_use_id?: string | null;
  message: {
    role: "user" | "system";
    content: string | ClaudeSdkInputContent[];
  };
}

export interface ClaudeSdkQueryOptions {
  cwd: string;
  model?: string;
  systemPrompt?: string;
  sessionId?: string;
  resume?: string;
  resumeSessionAt?: string;
  forkSession?: boolean;
  persistSession?: boolean;
  includePartialMessages?: boolean;
  mcpServers?: Record<string, unknown>;
  allowedTools?: string[];
  abortController?: AbortController;
  permissionMode?: string;
  allowDangerouslySkipPermissions?: boolean;
  settingSources?: string[];
  debug?: boolean;
  debugFile?: string;
  stderr?: (data: string) => void;
}

export interface ClaudeSdkQueryHandle extends AsyncIterable<ClaudeSdkMessage> {
  interrupt(): Promise<void>;
  initializationResult?(): Promise<unknown>;
  close?(): void;
  return?(value?: unknown): Promise<IteratorResult<ClaudeSdkMessage>>;
}

export interface ClaudeSdkModule {
  query(args: {
    prompt: AsyncIterable<ClaudeSdkUserMessage>;
    options: ClaudeSdkQueryOptions;
  }): ClaudeSdkQueryHandle;
}

export interface ClaudeQuerySessionOptions {
  sdk: Pick<ClaudeSdkModule, "query">;
  callbacks: AdapterCallbacks;
  config: SessionRuntimeConfig;
  sessionId: string;
  threadId: string | null;
  checkpoint?: ClaudeCheckpoint;
  mcpServers?: Record<string, unknown>;
  allowedTools?: string[];
  queryOptions?: Pick<
    ClaudeSdkQueryOptions,
    "forkSession" | "resume" | "resumeSessionAt" | "sessionId"
  >;
}

export class ClaudeQuerySession {
  private readonly mapper = new ClaudeEventMapper();
  private readonly abortController = new AbortController();
  private readonly started = createDeferred<ClaudeCheckpoint>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly recentStderrLines: string[] = [];

  private state: SessionStatus = "starting";
  private currentCheckpoint: ClaudeCheckpoint | undefined;
  private queryHandle: ClaudeSdkQueryHandle | undefined;
  private consumePromise: Promise<void> | undefined;

  private activeTurnId: string | null = null;
  private pendingInterruptedInput: PendingInterruptedInput | null = null;

  private inputQueue: ClaudeSdkUserMessage[] = [];
  private inputResolve: ((value: IteratorResult<ClaudeSdkUserMessage>) => void) | null = null;
  private inputDone = false;

  private stopRequested = false;
  private terminateRequested = false;
  private finalStatusEmitted = false;
  private lastContextUsage: SessionContextUsage | null = null;
  private pendingStderr = "";

  constructor(private readonly options: ClaudeQuerySessionOptions) {
    this.currentCheckpoint = options.checkpoint;
  }

  getStatus(): SessionStatus {
    return this.state;
  }

  getCheckpoint(): ClaudeCheckpoint | undefined {
    return this.currentCheckpoint;
  }

  async start(): Promise<ClaudeCheckpoint> {
    if (this.queryHandle) {
      return this.currentCheckpoint ?? this.started.promise;
    }

    this.queryHandle = this.options.sdk.query({
      prompt: this.createInputStream(),
      options: {
        cwd: this.options.config.cwd,
        model: this.options.config.model,
        systemPrompt: this.options.config.systemPrompt,
        ...this.options.queryOptions,
        persistSession: true,
        includePartialMessages: true,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        ...(this.options.mcpServers ? { mcpServers: this.options.mcpServers } : {}),
        ...(this.options.allowedTools ? { allowedTools: this.options.allowedTools } : {}),
        settingSources: [],
        stderr: (data) => {
          this.captureStderr(data);
        },
        abortController: this.abortController,
      },
    });

    this.consumePromise = this.consume();
    try {
      await this.queryHandle.initializationResult?.();
    } catch (error) {
      throw this.enrichError(error);
    }

    if (this.currentCheckpoint) {
      this.publishCheckpoint(this.currentCheckpoint);
    }

    if (this.state === "starting" && !this.activeTurnId) {
      await this.setStatus("idle");
    }

    return this.currentCheckpoint ?? this.started.promise;
  }

  async sendInput(
    input: UserInput,
    delivery: DeliveryMode,
  ): Promise<{ acceptedDelivery: DeliveryMode; queued: boolean }> {
    this.ensureUsable();

    if (this.state === "busy" || this.state === "interrupting") {
      if (delivery === "queue") {
        throw new Error("Claude backend does not support queued input while a turn is in flight.");
      }

      if (this.pendingInterruptedInput) {
        throw new Error("Claude backend already has a pending interrupted input.");
      }

      this.pendingInterruptedInput = {
        input,
        acceptedDelivery: "interrupt",
      };

      if (this.state !== "interrupting") {
        await this.interrupt();
      }

      return {
        acceptedDelivery: "interrupt",
        queued: false,
      };
    }

    const acceptedDelivery = delivery === "queue" ? "auto" : delivery;
    await this.dispatchInput(input, acceptedDelivery);

    return {
      acceptedDelivery,
      queued: false,
    };
  }

  async interrupt(): Promise<void> {
    this.ensureUsable();

    if (!this.queryHandle || (this.state !== "busy" && this.state !== "interrupting")) {
      return;
    }

    await this.setStatus("interrupting");

    try {
      await this.queryHandle.interrupt();
    } catch (error) {
      this.options.callbacks.log("warn", "Claude query interruption failed.", {
        error: toErrorMessage(error),
      });
      throw error;
    }
  }

  async waitForIdle(): Promise<void> {
    if (isIdleLike(this.state) && !this.pendingInterruptedInput && !this.activeTurnId) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.idleWaiters.add(resolve);
    });
  }

  async stop(): Promise<void> {
    await this.shutdown("stopped", true);
  }

  async terminate(): Promise<void> {
    await this.shutdown("terminated", true);
  }

  async dispose(): Promise<void> {
    await this.shutdown("stopped", false);
  }

  private async consume(): Promise<void> {
    try {
      for await (const event of this.queryHandle ?? []) {
        this.captureCheckpoint(event);
        this.captureContextUsage(event);

        if (isClaudeInitEvent(event) && this.state === "starting" && !this.activeTurnId) {
          await this.setStatus("idle");
        }

        const normalizedEvents = this.mapper.mapEvent(
          {
            sessionId: this.options.sessionId,
            threadId: this.options.threadId,
            turnId: this.activeTurnId,
          },
          event,
        );

        for (const normalizedEvent of normalizedEvents) {
          this.options.callbacks.emitEvent(normalizedEvent);
        }

        if (isClaudeResultEvent(event)) {
          await this.handleResultBoundary();
        }
      }

      if (!this.stopRequested && !this.terminateRequested) {
        throw new Error("Claude query stream ended unexpectedly.");
      }
    } catch (error) {
      if (this.stopRequested || this.terminateRequested) {
        return;
      }

      const recentStderr = this.getRecentStderr();
      const enrichedError = enrichClaudeError(error, recentStderr);
      this.options.callbacks.log("error", "Claude query session failed.", {
        error: toErrorMessage(enrichedError),
        ...(recentStderr.length > 0 ? { stderr: recentStderr } : {}),
      });

      if (!this.started.settled) {
        this.started.reject(enrichedError);
      }

      const sessionError = toSessionErrorInfo("CLAUDE_QUERY_FAILED", enrichedError, true);
      await this.setStatus("errored", sessionError);
      this.options.callbacks.emitEvent(
        createNormalizedEvent({
          sessionId: this.options.sessionId,
          threadId: this.options.threadId,
          source: "worker",
          type: "session.errored",
          payload: {
            backend: "claude",
            message: toErrorMessage(enrichedError),
          },
        }),
      );
    }
  }

  private async handleResultBoundary(): Promise<void> {
    this.activeTurnId = null;

    if (this.pendingInterruptedInput) {
      const pending = this.pendingInterruptedInput;
      this.pendingInterruptedInput = null;
      await this.dispatchInput(pending.input, pending.acceptedDelivery);
      return;
    }

    if (!this.stopRequested && !this.terminateRequested) {
      await this.setStatus("idle");
    }
  }

  private captureCheckpoint(event: ClaudeSdkMessage): void {
    const sessionId = extractClaudeSessionId(event);
    if (!sessionId) {
      return;
    }

    const nextCheckpoint: ClaudeCheckpoint =
      this.currentCheckpoint?.sessionId === sessionId &&
      typeof this.currentCheckpoint.resumeAtMessageId === "string"
        ? {
            backend: "claude",
            sessionId,
            resumeAtMessageId: this.currentCheckpoint.resumeAtMessageId,
          }
        : {
            backend: "claude",
            sessionId,
          };

    if (sameCheckpoint(this.currentCheckpoint, nextCheckpoint)) {
      return;
    }

    this.currentCheckpoint = nextCheckpoint;
    this.publishCheckpoint(nextCheckpoint);
  }

  private publishCheckpoint(checkpoint: ClaudeCheckpoint): void {
    this.options.callbacks.emitCheckpoint(checkpoint);

    if (!this.started.settled) {
      this.started.resolve(checkpoint);
    }
  }

  private async dispatchInput(input: UserInput, acceptedDelivery: DeliveryMode): Promise<void> {
    this.activeTurnId = input.id;

    this.options.callbacks.emitEvent(
      turnStartedEvent({
        sessionId: this.options.sessionId,
        threadId: this.options.threadId,
        turnId: input.id,
        payload: {
          delivery: acceptedDelivery,
          role: input.role,
        },
      }),
    );

    this.pushInput(toClaudeUserMessage(input, this.currentCheckpoint?.sessionId));
    await this.setStatus("busy");
  }

  private createInputStream(): AsyncIterable<ClaudeSdkUserMessage> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<ClaudeSdkUserMessage>> => {
          if (this.inputQueue.length > 0) {
            const next = this.inputQueue.shift();
            if (!next) {
              return {
                value: undefined as unknown as ClaudeSdkUserMessage,
                done: true,
              };
            }

            return {
              value: next,
              done: false,
            };
          }

          if (this.inputDone) {
            return {
              value: undefined as unknown as ClaudeSdkUserMessage,
              done: true,
            };
          }

          return await new Promise<IteratorResult<ClaudeSdkUserMessage>>((resolve) => {
            this.inputResolve = resolve;
          });
        },
        return: async (): Promise<IteratorResult<ClaudeSdkUserMessage>> => {
          this.finishInput();
          return {
            value: undefined as unknown as ClaudeSdkUserMessage,
            done: true,
          };
        },
      }),
    };
  }

  private pushInput(message: ClaudeSdkUserMessage): void {
    if (this.inputDone) {
      throw new Error("Claude input stream is already closed.");
    }

    if (this.inputResolve) {
      const resolve = this.inputResolve;
      this.inputResolve = null;
      resolve({
        value: message,
        done: false,
      });
      return;
    }

    this.inputQueue.push(message);
  }

  private finishInput(): void {
    this.inputDone = true;

    if (!this.inputResolve) {
      return;
    }

    const resolve = this.inputResolve;
    this.inputResolve = null;
    resolve({
      value: undefined as unknown as ClaudeSdkUserMessage,
      done: true,
    });
  }

  private ensureUsable(): void {
    if (this.stopRequested || this.terminateRequested || this.state === "stopped") {
      throw new Error("Claude query session is stopped.");
    }

    if (this.state === "terminated") {
      throw new Error("Claude query session is terminated.");
    }

    if (this.state === "errored") {
      throw new Error("Claude query session is errored.");
    }

    if (!this.queryHandle) {
      throw new Error("Claude query session has not been started.");
    }
  }

  private async shutdown(target: "stopped" | "terminated", emitFinalEvent: boolean): Promise<void> {
    if (target === "terminated") {
      this.terminateRequested = true;
    } else {
      this.stopRequested = true;
    }

    this.pendingInterruptedInput = null;
    this.activeTurnId = null;

    await this.setStatus("stopping");
    this.finishInput();

    try {
      await this.queryHandle?.interrupt();
    } catch {
      // Best-effort interruption during shutdown.
    }

    try {
      await this.queryHandle?.return?.();
    } catch {
      // Best-effort generator teardown.
    }

    this.abortController.abort();
    this.queryHandle?.close?.();

    await this.consumePromise?.catch(() => {
      // Shutdown should not surface stream teardown failures.
    });

    if (emitFinalEvent) {
      await this.emitFinalStatus(target);
    } else {
      this.settleIdleWaiters();
    }
  }

  private async emitFinalStatus(target: "stopped" | "terminated"): Promise<void> {
    if (this.finalStatusEmitted) {
      return;
    }

    this.finalStatusEmitted = true;
    await this.setStatus(target);
    this.options.callbacks.emitEvent(
      createNormalizedEvent({
        sessionId: this.options.sessionId,
        threadId: this.options.threadId,
        source: "worker",
        type: target === "terminated" ? "session.terminated" : "session.stopped",
        payload: {
          backend: "claude",
        },
      }),
    );
  }

  private async setStatus(next: SessionStatus, error?: SessionErrorInfo): Promise<void> {
    const contextUsage = this.lastContextUsage;
    if (this.state === next && error === undefined) {
      if (isIdleLike(next)) {
        this.settleIdleWaiters();
      }
      return;
    }

    this.state = next;
    this.options.callbacks.emitStatusChange(next, error, contextUsage);

    if (isIdleLike(next)) {
      this.settleIdleWaiters();
    }
  }

  private settleIdleWaiters(): void {
    for (const resolve of this.idleWaiters) {
      resolve();
    }

    this.idleWaiters.clear();
  }

  private captureStderr(data: string): void {
    if (data.length === 0) {
      return;
    }

    const combined = `${this.pendingStderr}${data}`;
    const lines = combined.split(/\r?\n/u);
    this.pendingStderr = lines.pop() ?? "";

    for (const line of lines) {
      this.recordStderrLine(line);
    }
  }

  private recordStderrLine(line: string): void {
    const normalizedLine = line.trim();
    if (normalizedLine.length === 0) {
      return;
    }

    this.recentStderrLines.push(normalizedLine);
    if (this.recentStderrLines.length > MAX_CLAUDE_STDERR_LINES) {
      this.recentStderrLines.shift();
    }

    this.options.callbacks.log("debug", "Claude query stderr.", {
      line: normalizedLine,
    });
  }

  private flushPendingStderr(): void {
    if (this.pendingStderr.length === 0) {
      return;
    }

    const line = this.pendingStderr;
    this.pendingStderr = "";
    this.recordStderrLine(line);
  }

  private getRecentStderr(): string[] {
    this.flushPendingStderr();
    return [...this.recentStderrLines];
  }

  private enrichError(error: unknown): Error {
    return enrichClaudeError(error, this.getRecentStderr());
  }

  private captureContextUsage(event: ClaudeSdkMessage): void {
    const nextUsage = extractClaudeContextUsage(event, this.options.config.model);
    if (!nextUsage || areContextUsagesEqual(this.lastContextUsage, nextUsage)) {
      return;
    }

    this.lastContextUsage = nextUsage;
    this.options.callbacks.emitStatusChange(this.state, undefined, nextUsage);
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => {
    // Consumers may await this later; suppress unhandled rejections when startup fails early.
  });

  const deferred: Deferred<T> = {
    promise,
    resolve(value) {
      if (deferred.settled) {
        return;
      }

      deferred.settled = true;
      resolvePromise(value);
    },
    reject(error) {
      if (deferred.settled) {
        return;
      }

      deferred.settled = true;
      rejectPromise(error);
    },
    settled: false,
  };

  return deferred;
}

function isIdleLike(status: SessionStatus): boolean {
  return status === "idle" || status === "stopped" || status === "terminated" || status === "errored";
}

const MAX_CLAUDE_STDERR_LINES = 20;
const MAX_CLAUDE_STDERR_SUMMARY_LINES = 3;

function sameCheckpoint(left: ClaudeCheckpoint | undefined, right: ClaudeCheckpoint): boolean {
  return (
    left?.sessionId === right.sessionId && left?.resumeAtMessageId === right.resumeAtMessageId
  );
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function enrichClaudeError(error: unknown, stderrLines: readonly string[]): Error {
  const baseError = error instanceof Error ? error : new Error(toErrorMessage(error));
  const stderrSummary = summarizeClaudeStderr(stderrLines);
  if (!stderrSummary || baseError.message.includes(stderrSummary)) {
    return baseError;
  }

  const enrichedError = new Error(`${baseError.message}. Claude stderr: ${stderrSummary}`);
  enrichedError.name = baseError.name;
  return enrichedError;
}

function summarizeClaudeStderr(stderrLines: readonly string[]): string | null {
  if (stderrLines.length === 0) {
    return null;
  }

  return stderrLines.slice(-MAX_CLAUDE_STDERR_SUMMARY_LINES).join(" | ");
}

function toSessionErrorInfo(code: string, error: unknown, retryable: boolean): SessionErrorInfo {
  return {
    code,
    message: toErrorMessage(error),
    retryable,
  };
}

function extractClaudeContextUsage(
  event: ClaudeSdkMessage,
  configuredModel?: string,
): SessionContextUsage | null {
  const usageContainer = readObject(event.modelUsage) ?? readObject(event.usage);
  if (!usageContainer) {
    return null;
  }

  const usageEntry = selectClaudeUsageEntry(usageContainer, configuredModel);
  if (!usageEntry) {
    return null;
  }

  const inputTokens = readFiniteNumber(usageEntry.inputTokens) ?? readFiniteNumber(usageEntry.input_tokens) ?? 0;
  const cacheReadInputTokens =
    readFiniteNumber(usageEntry.cacheReadInputTokens) ??
    readFiniteNumber(usageEntry.cache_read_input_tokens) ??
    0;
  const cacheCreationInputTokens =
    readFiniteNumber(usageEntry.cacheCreationInputTokens) ??
    readFiniteNumber(usageEntry.cache_creation_input_tokens) ??
    0;
  const outputTokens =
    readFiniteNumber(usageEntry.outputTokens) ?? readFiniteNumber(usageEntry.output_tokens) ?? 0;
  const contextWindow =
    readFiniteNumber(usageEntry.contextWindow) ?? readFiniteNumber(usageEntry.context_window);
  if (
    contextWindow === undefined ||
    contextWindow <= 0
  ) {
    return null;
  }

  const tokens =
    Math.max(0, inputTokens) +
    Math.max(0, cacheReadInputTokens) +
    Math.max(0, cacheCreationInputTokens) +
    Math.max(0, outputTokens);
  return {
    tokens,
    contextWindow,
    percent: Math.max(0, Math.min(100, (tokens / contextWindow) * 100)),
  };
}

function selectClaudeUsageEntry(
  usageContainer: Record<string, unknown>,
  configuredModel?: string,
): Record<string, unknown> | null {
  if (isClaudeUsageEntry(usageContainer)) {
    return usageContainer;
  }

  const entries = Object.entries(usageContainer).filter(([, value]) => isClaudeUsageEntry(value));
  if (entries.length === 0) {
    return null;
  }

  if (configuredModel) {
    const normalizedConfiguredModel = normalizeModelKey(configuredModel);
    const exactMatch = entries.find(([modelKey]) => normalizeModelKey(modelKey) === normalizedConfiguredModel);
    if (exactMatch) {
      return exactMatch[1] as Record<string, unknown>;
    }
  }

  return (
    entries
      .map(([, value]) => value as Record<string, unknown>)
      .sort((left, right) => totalClaudeUsageTokens(right) - totalClaudeUsageTokens(left))[0] ?? null
  );
}

function isClaudeUsageEntry(value: unknown): value is Record<string, unknown> {
  const entry = readObject(value);
  return entry !== null && readFiniteNumber(entry.contextWindow ?? entry.context_window) !== undefined;
}

function totalClaudeUsageTokens(entry: Record<string, unknown>): number {
  return (
    (readFiniteNumber(entry.inputTokens) ?? readFiniteNumber(entry.input_tokens) ?? 0) +
    (readFiniteNumber(entry.cacheReadInputTokens) ?? readFiniteNumber(entry.cache_read_input_tokens) ?? 0) +
    (readFiniteNumber(entry.cacheCreationInputTokens) ??
      readFiniteNumber(entry.cache_creation_input_tokens) ??
      0) +
    (readFiniteNumber(entry.outputTokens) ?? readFiniteNumber(entry.output_tokens) ?? 0)
  );
}

function normalizeModelKey(model: string): string {
  return model.trim().toLowerCase();
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

function toClaudeUserMessage(input: UserInput, sessionId?: string): ClaudeSdkUserMessage {
  const contentBlocks: ClaudeSdkInputContent[] = [];

  for (const part of input.parts) {
    switch (part.type) {
      case "text":
        contentBlocks.push({
          type: "text",
          text: part.text,
        });
        break;

      case "image":
        contentBlocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: part.mimeType,
            data: part.data,
          },
        });
        break;

      case "file":
        contentBlocks.push({
          type: "text",
          text: describeFileAttachment(part),
        });
        break;
    }
  }

  if (contentBlocks.length === 0) {
    contentBlocks.push({
      type: "text",
      text: "",
    });
  }

  const content =
    contentBlocks.length === 1 && contentBlocks[0]?.type === "text"
      ? contentBlocks[0].text
      : contentBlocks;

  return {
    type: "user",
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: input.role,
      content,
    },
  };
}

function describeFileAttachment(part: Extract<UserInput["parts"][number], { type: "file" }>): string {
  const identifier = part.fileName ?? part.path ?? "unnamed-file";
  return `Attached file: ${identifier} (${part.mimeType})`;
}
