import { randomUUID } from "node:crypto";

import type {
  BackendCapabilities,
  BackendCheckpoint,
  DeliveryMode,
  SessionRuntimeConfig,
  UserInput,
} from "../../core/types/index.js";
import { isClaudeCheckpoint, validateCheckpoint } from "../common/checkpoint.js";
import type { AdapterCallbacks, BackendAdapter, HostRpcClient } from "../common/adapter.js";
import {
  buildHostToolDefinitions,
  createClaudeHostToolServer,
  type ClaudeHostToolServer,
  type MiddlemanRole,
} from "../common/host-tools.js";
import {
  ClaudeQuerySession,
  type ClaudeQuerySessionOptions,
  type ClaudeSdkModule,
} from "./claude-query-session.js";

type ClaudeCheckpoint = Extract<BackendCheckpoint, { backend: "claude" }>;

export interface ClaudeBackendAdapterOptions {
  loadSdk?: () => Promise<ClaudeSdkModule>;
  hostRpc?: HostRpcClient;
}

export const CLAUDE_BACKEND_CAPABILITIES: BackendCapabilities = {
  canResumeThread: true,
  canForkThread: true,
  canInterrupt: true,
  canQueueInput: false,
  canManualCompact: false,
  canReadHistory: true,
  emitsToolProgress: true,
  exposesRawEvents: true,
};

export class ClaudeBackendAdapter implements BackendAdapter {
  readonly kind = "claude" as const;
  readonly capabilities = CLAUDE_BACKEND_CAPABILITIES;

  private config: SessionRuntimeConfig | null = null;
  private activeSession: ClaudeQuerySession | null = null;
  private sdkPromise: Promise<ClaudeSdkModule> | null = null;
  private envelopeSessionId = "claude-session";
  private envelopeThreadId: string | null = null;
  private hostTools: ClaudeHostToolServer | null = null;

  constructor(
    private readonly callbacks: AdapterCallbacks,
    private readonly options: ClaudeBackendAdapterOptions = {},
  ) {}

  async bootstrap(
    config: SessionRuntimeConfig,
    checkpoint?: BackendCheckpoint,
  ): Promise<{ checkpoint: BackendCheckpoint }> {
    this.config = config;
    applyEnvOverrides(readStringRecord((config.backendConfig as Record<string, unknown>)?.env));
    this.resolveEnvelopeIds(config, checkpoint);
    this.hostTools = await this.resolveHostTools(config);

    let nextCheckpoint: BackendCheckpoint;
    if (checkpoint) {
      nextCheckpoint = await this.resumeThread(this.normalizeClaudeCheckpoint(checkpoint));
    } else {
      const freshCheckpoint = this.createFreshCheckpoint();
      nextCheckpoint = await this.activateSession(freshCheckpoint, {
        sessionId: freshCheckpoint.sessionId,
      });
    }

    return { checkpoint: nextCheckpoint };
  }

  async sendInput(
    input: UserInput,
    delivery: DeliveryMode,
  ): Promise<{ acceptedDelivery: DeliveryMode; queued: boolean }> {
    return await this.requireSession().sendInput(input, delivery);
  }

  async createThread(seed?: UserInput[]): Promise<BackendCheckpoint> {
    const checkpoint = this.createFreshCheckpoint();
    const startedCheckpoint = await this.activateSession(checkpoint, {
      sessionId: checkpoint.sessionId,
    });

    if (seed) {
      for (const input of seed) {
        await this.requireSession().sendInput(input, "auto");
        await this.requireSession().waitForIdle();
      }
    }

    return this.requireSession().getCheckpoint() ?? startedCheckpoint;
  }

  async forkThread(
    source: BackendCheckpoint,
    sourceMessageId?: string,
  ): Promise<BackendCheckpoint> {
    const sourceCheckpoint = this.normalizeClaudeCheckpoint(source);
    const checkpoint = this.createFreshCheckpoint();
    return await this.activateSession(checkpoint, {
      forkSession: true,
      resume: sourceCheckpoint.sessionId,
      ...((sourceMessageId ?? sourceCheckpoint.resumeAtMessageId)
        ? { resumeSessionAt: sourceMessageId ?? sourceCheckpoint.resumeAtMessageId }
        : {}),
      sessionId: checkpoint.sessionId,
    });
  }

  async resumeThread(checkpoint: BackendCheckpoint): Promise<BackendCheckpoint> {
    const claudeCheckpoint = this.normalizeClaudeCheckpoint(checkpoint);
    try {
      return await this.activateSession(claudeCheckpoint, {
        resume: claudeCheckpoint.sessionId,
        ...(claudeCheckpoint.resumeAtMessageId
          ? { resumeSessionAt: claudeCheckpoint.resumeAtMessageId }
          : {}),
      });
    } catch (error) {
      if (!isMissingClaudeConversation(error)) {
        throw error;
      }

      this.callbacks.log("warn", "Claude checkpoint resume failed; starting a fresh session.", {
        sessionId: claudeCheckpoint.sessionId,
        error: toErrorMessage(error),
      });

      const freshCheckpoint = this.createFreshCheckpoint();
      return await this.activateSession(freshCheckpoint, {
        sessionId: freshCheckpoint.sessionId,
      });
    }
  }

  async readHistory(
    threadCheckpoint: BackendCheckpoint,
    _options?: {
      cursor?: string;
      limit?: number;
    },
  ) {
    this.normalizeClaudeCheckpoint(threadCheckpoint);

    return {
      entries: [],
      cursor: {
        cursor: null,
        hasMore: false,
      },
    };
  }

  async interrupt(): Promise<void> {
    await this.requireSession().interrupt();
  }

  async stop(): Promise<void> {
    if (!this.activeSession) {
      return;
    }

    const session = this.activeSession;
    this.activeSession = null;
    await session.stop();
  }

  async terminate(): Promise<void> {
    if (!this.activeSession) {
      return;
    }

    const session = this.activeSession;
    this.activeSession = null;
    await session.terminate();
  }

  private async activateSession(
    checkpoint: ClaudeCheckpoint,
    queryOptions: ClaudeQuerySessionOptions["queryOptions"],
  ): Promise<ClaudeCheckpoint> {
    const config = this.requireConfig();
    const sdk = await this.getSdk();

    await this.disposeCurrentSession();

    const session = new ClaudeQuerySession({
      sdk,
      callbacks: this.callbacks,
      config,
      sessionId: this.envelopeSessionId,
      threadId: this.envelopeThreadId,
      checkpoint,
      ...(this.hostTools
        ? { mcpServers: { [this.hostTools.serverName]: this.hostTools.server } }
        : {}),
      ...(this.hostTools ? { allowedTools: this.hostTools.allowedTools } : {}),
      queryOptions,
    });

    this.activeSession = session;
    return await session.start();
  }

  private async disposeCurrentSession(): Promise<void> {
    if (!this.activeSession) {
      return;
    }

    const session = this.activeSession;
    this.activeSession = null;
    await session.dispose();
  }

  private async getSdk(): Promise<ClaudeSdkModule> {
    if (this.sdkPromise) {
      return await this.sdkPromise;
    }

    this.sdkPromise = (this.options.loadSdk ?? loadClaudeSdkModule)();
    return await this.sdkPromise;
  }

  private requireConfig(): SessionRuntimeConfig {
    if (!this.config) {
      throw new Error("Claude backend adapter has not been bootstrapped.");
    }

    return this.config;
  }

  private requireSession(): ClaudeQuerySession {
    if (!this.activeSession) {
      throw new Error("Claude backend adapter does not have an active query session.");
    }

    return this.activeSession;
  }

  private normalizeClaudeCheckpoint(checkpoint: BackendCheckpoint): ClaudeCheckpoint {
    validateCheckpoint(checkpoint, "claude");
    if (!isClaudeCheckpoint(checkpoint)) {
      throw new Error("Invalid Claude checkpoint.");
    }

    return checkpoint;
  }

  private resolveEnvelopeIds(config: SessionRuntimeConfig, checkpoint?: BackendCheckpoint): void {
    const configuredSessionId =
      readNonEmptyString(config.backendConfig.swarmdSessionId) ??
      readNonEmptyString(config.backendConfig.sessionId);
    const configuredThreadId =
      readNonEmptyString(config.backendConfig.swarmdThreadId) ??
      readNonEmptyString(config.backendConfig.threadId);

    this.envelopeSessionId =
      configuredSessionId ??
      (checkpoint?.backend === "claude" ? `claude:${checkpoint.sessionId}` : "claude-session");
    this.envelopeThreadId = configuredThreadId ?? this.envelopeThreadId;
  }

  private createFreshCheckpoint(): ClaudeCheckpoint {
    return {
      backend: "claude",
      sessionId: this.createBackendSessionId(),
    };
  }

  private createBackendSessionId(): string {
    return randomUUID();
  }

  private async resolveHostTools(
    config: SessionRuntimeConfig,
  ): Promise<ClaudeHostToolServer | null> {
    const role = readMiddlemanRole(readMiddlemanConfig(config.backendConfig)?.role);
    if (!role || !this.options.hostRpc) {
      return null;
    }

    return await createClaudeHostToolServer(this.options.hostRpc, buildHostToolDefinitions(role));
  }
}

export async function loadClaudeSdkModule(): Promise<ClaudeSdkModule> {
  try {
    const dynamicImport = new Function("specifier", "return import(specifier);") as (
      specifier: string,
    ) => Promise<unknown>;
    const imported = await dynamicImport("@anthropic-ai/claude-agent-sdk");
    return normalizeClaudeSdkModule(imported);
  } catch (error) {
    if (isMissingClaudeSdk(error)) {
      throw new Error(
        'Claude backend requires "@anthropic-ai/claude-agent-sdk" to be installed by the runtime consumer.',
      );
    }

    throw error;
  }
}

export function createClaudeBackendAdapter(
  callbacks: AdapterCallbacks,
  options?: ClaudeBackendAdapterOptions,
): BackendAdapter {
  return new ClaudeBackendAdapter(callbacks, options);
}

function normalizeClaudeSdkModule(value: unknown): ClaudeSdkModule {
  const maybeModule =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;

  if (!maybeModule || typeof maybeModule.query !== "function") {
    throw new Error('Claude Agent SDK module is missing the required "query" entry point.');
  }

  return maybeModule as unknown as ClaudeSdkModule;
}

function isMissingClaudeSdk(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
    return true;
  }

  return error.message.includes("@anthropic-ai/claude-agent-sdk");
}

function isMissingClaudeConversation(error: unknown): boolean {
  return toErrorMessage(error).toLowerCase().includes("no conversation found");
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" && entry.length > 0) {
      record[key] = entry;
    }
  }

  return Object.keys(record).length > 0 ? record : undefined;
}

function applyEnvOverrides(overrides: Record<string, string> | undefined): void {
  if (!overrides) {
    return;
  }

  for (const [key, value] of Object.entries(overrides)) {
    process.env[key] = value;
  }
}

function readMiddlemanConfig(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? ((value as Record<string, unknown>).middleman as Record<string, unknown> | undefined)
    : undefined;
}

function readMiddlemanRole(value: unknown): MiddlemanRole | undefined {
  return value === "manager" || value === "worker" ? value : undefined;
}
