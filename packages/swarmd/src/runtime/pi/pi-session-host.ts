import type {
  BackendCheckpoint,
  EventEnvelope,
  SessionContextUsage,
  SessionErrorInfo,
  SessionRuntimeConfig,
  SessionStatus,
  UserInput,
} from "../../core/types/index.js";
import { createNormalizedEvent } from "../common/index.js";
import { validateCheckpoint } from "../common/checkpoint.js";
import type { HostRpcClient } from "../common/adapter.js";
import {
  buildHostToolDefinitions,
  createPiHostTools,
  type MiddlemanRole,
  type PiHostToolDefinition,
} from "../common/host-tools.js";
import {
  type PiImageContent,
  PiEventMapper,
  type PiAssistantMessage,
  type PiMessage,
  type PiSessionEvent,
  type PiTextContent,
} from "./pi-mapper.js";

type PiCheckpoint = Extract<BackendCheckpoint, { backend: "pi" }>;
type PiThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh";

export interface PiModelLike {
  provider: string;
  id: string;
  reasoning?: boolean;
  contextWindow?: number;
}

export interface PiGetModelModule {
  getModel(provider: string, id: string): PiModelLike;
}

export interface PiSessionManagerLike {
  appendMessage(message: PiMessage): string;
  branch(entryId: string): void;
  getSessionFile(): string | undefined;
  getSessionDir(): string;
  getCwd(): string;
  _rewriteFile?(): void;
}

export interface PiSessionManagerStatic {
  create(cwd: string, sessionDir?: string): PiSessionManagerLike;
  open(path: string, sessionDir?: string): PiSessionManagerLike;
  forkFrom(sourcePath: string, targetCwd: string, sessionDir?: string): PiSessionManagerLike;
}

export interface PiAgentLike {
  setSystemPrompt(prompt: string): void;
}

export interface PiAgentSessionLike {
  readonly isStreaming: boolean;
  readonly sessionManager: PiSessionManagerLike;
  readonly agent?: PiAgentLike;
  readonly model?: PiModelLike;
  prompt(message: string, options?: { images?: PiImageContent[] }): Promise<void>;
  steer(message: string, images?: PiImageContent[]): Promise<void> | void;
  followUp(message: string, images?: PiImageContent[]): Promise<void> | void;
  abort(): Promise<void>;
  compact(): Promise<unknown>;
  getContextUsage?():
    | {
        tokens: number | null;
        contextWindow: number;
        percent: number | null;
      }
    | undefined;
  subscribe(listener: (event: PiSessionEvent) => void): () => void;
  dispose(): void;
  _baseSystemPrompt?: string;
}

export interface PiCreateAgentSessionOptions {
  cwd?: string;
  agentDir?: string;
  authStorage?: unknown;
  modelRegistry?: unknown;
  model?: PiModelLike;
  thinkingLevel?: PiThinkingLevel;
  tools?: unknown[];
  resourceLoader?: unknown;
  sessionManager?: PiSessionManagerLike;
  customTools?: unknown[];
}

export interface PiCreateAgentSessionResult {
  session: PiAgentSessionLike;
}

export interface PiModuleLike {
  createAgentSession(options?: PiCreateAgentSessionOptions): Promise<PiCreateAgentSessionResult>;
  SessionManager: PiSessionManagerStatic;
  AuthStorage?: {
    create(authPath?: string): unknown;
  };
  ModelRegistry?: {
    new (authStorage: unknown, modelsJsonPath?: string): unknown;
    create?(authStorage: unknown, modelsJsonPath?: string): unknown;
  };
  DefaultResourceLoader?: new (options: {
    cwd?: string;
    agentDir?: string;
    additionalSkillPaths?: string[];
    systemPrompt?: string;
    agentsFilesOverride?: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
      agentsFiles: Array<{ path: string; content: string }>;
    };
    appendSystemPromptOverride?: (base: string[]) => string[];
  }) => {
    reload(): Promise<void>;
  };
  createCodingTools?: (
    cwd: string,
    options?: {
      bash?: {
        spawnHook?: (context: BashSpawnContextLike) => BashSpawnContextLike;
      };
    },
  ) => unknown[];
}

export type PiModuleLoader = () => Promise<PiModuleLike>;

export interface PiSessionHostCallbacks {
  emitEvent(event: Omit<EventEnvelope, "cursor">): void;
  emitStatusChange(
    status: SessionStatus,
    error?: SessionErrorInfo,
    contextUsage?: SessionContextUsage | null,
  ): void;
  emitBackendState?(state: Record<string, unknown>): void;
  log(level: "debug" | "info" | "warn" | "error", message: string, details?: unknown): void;
}

export interface PiSessionHostOptions {
  sessionId: string;
  threadId: string | null;
  loadModule?: PiModuleLoader;
  hostRpc?: HostRpcClient;
}

export interface PiSessionHostLike {
  bootstrap(config: SessionRuntimeConfig, checkpoint?: PiCheckpoint): Promise<PiCheckpoint>;
  createThread(seed?: UserInput[]): Promise<PiCheckpoint>;
  forkThread(source: PiCheckpoint, sourceMessageId?: string): Promise<PiCheckpoint>;
  resumeThread(checkpoint: PiCheckpoint): Promise<PiCheckpoint>;
  isBusy(): boolean;
  sendPrompt(input: UserInput): Promise<void>;
  sendSteer(input: UserInput): Promise<void>;
  sendFollowUp(input: UserInput): Promise<void>;
  interrupt(): Promise<void>;
  compact(): Promise<unknown>;
  stop(): Promise<void>;
  terminate(): Promise<void>;
}

interface PiBackendConfig {
  agentDir?: string;
  sessionDir?: string;
  authFile?: string;
  env?: Record<string, string | undefined>;
  additionalSkillPaths?: string[];
  memoryContextFile?: {
    path?: string;
    content?: string;
  };
  swarmContextFiles?: Array<{
    path?: string;
    content?: string;
  }>;
  modelProvider?: string;
  modelId?: string;
  thinkingLevel?: PiThinkingLevel;
  middleman?: {
    role?: MiddlemanRole;
  };
}

interface BashSpawnContextLike {
  env?: Record<string, string | undefined>;
}

interface NormalizedUserInput {
  text: string;
  images: PiImageContent[];
}

async function defaultPiModuleLoader(): Promise<PiModuleLike> {
  try {
    const load = new Function("specifier", "return import(specifier);") as (
      specifier: string,
    ) => Promise<unknown>;
    const mod = (await load("@mariozechner/pi-coding-agent")) as Partial<PiModuleLike>;
    if (typeof mod.createAgentSession !== "function" || mod.SessionManager === undefined) {
      throw new Error("Missing createAgentSession or SessionManager export.");
    }

    return mod as PiModuleLike;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Pi backend requires @mariozechner/pi-coding-agent to be installed and resolvable at runtime. ${message}`,
    );
  }
}

async function loadPiAiModule(): Promise<PiGetModelModule | null> {
  try {
    const load = new Function("specifier", "return import(specifier);") as (
      specifier: string,
    ) => Promise<unknown>;
    return (await load("@mariozechner/pi-ai")) as PiGetModelModule;
  } catch {
    return null;
  }
}

function getPiBackendConfig(config: SessionRuntimeConfig): PiBackendConfig {
  return config.backendConfig as PiBackendConfig;
}

function readPiThinkingLevel(value: unknown): PiThinkingLevel | undefined {
  switch (value) {
    case "off":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return value;
    default:
      return undefined;
  }
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readStringRecord(value: unknown): Record<string, string> | undefined {
  const object = readObject(value);
  if (!object) {
    return undefined;
  }

  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(object)) {
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

function mergeRuntimeContextFiles(
  baseAgentsFiles: Array<{ path: string; content: string }>,
  options: {
    memoryContextFile?: { path: string; content: string };
    swarmContextFiles: Array<{ path: string; content: string }>;
  },
): Array<{ path: string; content: string }> {
  if (!options.memoryContextFile && options.swarmContextFiles.length === 0) {
    return baseAgentsFiles;
  }

  const swarmContextPaths = new Set(options.swarmContextFiles.map((entry) => entry.path));
  const withoutSwarmAndMemory = baseAgentsFiles.filter(
    (entry) => entry.path !== options.memoryContextFile?.path && !swarmContextPaths.has(entry.path),
  );

  return [
    ...withoutSwarmAndMemory,
    ...options.swarmContextFiles,
    ...(options.memoryContextFile ? [options.memoryContextFile] : []),
  ];
}

function parseConfiguredModel(
  config: SessionRuntimeConfig,
): { provider: string; modelId: string } | null {
  const backendConfig = getPiBackendConfig(config);
  if (backendConfig.modelProvider && backendConfig.modelId) {
    return {
      provider: backendConfig.modelProvider,
      modelId: backendConfig.modelId,
    };
  }

  const match = /^([^/:]+)[/:](.+)$/.exec(config.model);
  if (!match) {
    return null;
  }

  return {
    provider: match[1],
    modelId: match[2],
  };
}

async function resolveModel(config: SessionRuntimeConfig): Promise<PiModelLike | undefined> {
  const parsed = parseConfiguredModel(config);
  if (parsed === null) {
    return undefined;
  }

  const aiModule = await loadPiAiModule();
  return aiModule?.getModel(parsed.provider, parsed.modelId);
}

function resolveConfiguredThinkingLevel(config: SessionRuntimeConfig): PiThinkingLevel | undefined {
  return readPiThinkingLevel(getPiBackendConfig(config).thinkingLevel);
}

function convertUserInputToPiInput(input: UserInput): NormalizedUserInput {
  const textParts: string[] = [];
  const images: PiImageContent[] = [];

  for (const part of input.parts) {
    switch (part.type) {
      case "text":
        textParts.push(part.text);
        break;
      case "image":
        images.push({
          type: "image",
          mimeType: part.mimeType,
          data: part.data,
        });
        break;
      case "file":
        textParts.push(
          `[file${part.fileName ? `: ${part.fileName}` : ""}${part.path ? ` (${part.path})` : ""}]`,
        );
        break;
    }
  }

  const text = textParts.join("\n");
  return {
    text: input.role === "system" ? `System message:\n${text}`.trim() : text,
    images,
  };
}

function buildSeedMessage(input: UserInput): PiMessage {
  const normalized = convertUserInputToPiInput(input);
  const content: Array<PiTextContent | PiImageContent> = [];

  if (normalized.text.length > 0) {
    content.push({
      type: "text",
      text: normalized.text,
    });
  }

  content.push(...normalized.images);

  return {
    role: "user",
    content,
    timestamp: Date.now(),
  };
}

function forcePersistSessionFile(manager: PiSessionManagerLike): void {
  if (typeof manager._rewriteFile !== "function") {
    throw new Error(
      "Pi SessionManager does not expose _rewriteFile(), so session persistence could not be forced.",
    );
  }

  manager._rewriteFile();
}

function normalizeCheckpoint(
  checkpoint: PiCheckpoint,
  sessionManager: PiSessionManagerLike,
): PiCheckpoint {
  const sessionFile = sessionManager.getSessionFile();
  if (!sessionFile) {
    throw new Error("Pi session manager did not provide a session file path.");
  }

  return {
    backend: "pi",
    sessionFile,
    ...(checkpoint.branchEntryId === undefined ? {} : { branchEntryId: checkpoint.branchEntryId }),
  };
}

function applySystemPrompt(session: PiAgentSessionLike, systemPrompt: string | undefined): void {
  if (!systemPrompt) {
    return;
  }

  session._baseSystemPrompt = systemPrompt;
  session.agent?.setSystemPrompt(systemPrompt);
}

export class PiSessionHost implements PiSessionHostLike {
  private readonly callbacks: PiSessionHostCallbacks;
  private readonly sessionId: string;
  private readonly threadId: string | null;
  private readonly loadModule: PiModuleLoader;
  private readonly hostRpc?: HostRpcClient;
  private config: SessionRuntimeConfig | null = null;
  private session: PiAgentSessionLike | null = null;
  private status: SessionStatus = "created";
  private dispatchPending = false;
  private manualCompacting = false;
  private autoCompacting = false;
  private unsubscribe: (() => void) | null = null;
  private mapper: PiEventMapper;
  private lastContextUsage: SessionContextUsage | null = null;
  private contextWindow: number | null = null;

  constructor(callbacks: PiSessionHostCallbacks, options: PiSessionHostOptions) {
    this.callbacks = callbacks;
    this.sessionId = options.sessionId;
    this.threadId = options.threadId;
    this.loadModule = options.loadModule ?? defaultPiModuleLoader;
    this.hostRpc = options.hostRpc;
    this.mapper = new PiEventMapper({
      sessionId: this.sessionId,
      threadId: this.threadId,
    });
  }

  async bootstrap(config: SessionRuntimeConfig, checkpoint?: PiCheckpoint): Promise<PiCheckpoint> {
    this.config = config;
    this.lastContextUsage = null;
    this.contextWindow = null;
    this.manualCompacting = false;
    this.autoCompacting = false;
    this.setStatus("starting");

    const targetCheckpoint = checkpoint ?? (await this.createThread());
    const loadedCheckpoint = await this.attachToThread(targetCheckpoint);
    this.setStatus("idle");
    return loadedCheckpoint;
  }

  async createThread(seed?: UserInput[]): Promise<PiCheckpoint> {
    const config = this.requireConfig();
    const piModule = await this.loadModule();
    const backendConfig = getPiBackendConfig(config);
    const sessionManager = piModule.SessionManager.create(config.cwd, backendConfig.sessionDir);

    for (const input of seed ?? []) {
      sessionManager.appendMessage(buildSeedMessage(input));
    }

    forcePersistSessionFile(sessionManager);

    const sessionFile = sessionManager.getSessionFile();
    if (!sessionFile) {
      throw new Error("Pi SessionManager.create() did not return a session file.");
    }

    return {
      backend: "pi",
      sessionFile,
    };
  }

  async forkThread(source: PiCheckpoint, sourceMessageId?: string): Promise<PiCheckpoint> {
    validateCheckpoint(source, "pi");

    const config = this.requireConfig();
    const piModule = await this.loadModule();
    const backendConfig = getPiBackendConfig(config);
    const sessionManager = piModule.SessionManager.forkFrom(
      source.sessionFile,
      config.cwd,
      backendConfig.sessionDir,
    );
    const sessionFile = sessionManager.getSessionFile();
    if (!sessionFile) {
      throw new Error("Pi SessionManager.forkFrom() did not return a session file.");
    }

    return {
      backend: "pi",
      sessionFile,
      ...(sourceMessageId === undefined ? {} : { branchEntryId: sourceMessageId }),
    };
  }

  async resumeThread(checkpoint: PiCheckpoint): Promise<PiCheckpoint> {
    validateCheckpoint(checkpoint, "pi");
    const loadedCheckpoint = await this.attachToThread(checkpoint);
    this.setStatus("idle");
    return loadedCheckpoint;
  }

  isBusy(): boolean {
    return (
      this.dispatchPending ||
      this.session?.isStreaming === true ||
      this.status === "busy" ||
      this.isCompacting()
    );
  }

  async sendPrompt(input: UserInput): Promise<void> {
    const session = this.requireSession();
    const normalized = convertUserInputToPiInput(input);
    this.dispatchPending = true;
    this.setStatus("busy");

    void session
      .prompt(
        normalized.text,
        normalized.images.length > 0 ? { images: normalized.images } : undefined,
      )
      .catch((error) => {
        this.dispatchPending = false;
        const message = describePiRuntimeError(error);
        const sessionError: SessionErrorInfo = {
          code: "PROMPT_DISPATCH_FAILED",
          message,
          retryable: true,
        };
        this.setStatus("errored", sessionError);
        this.callbacks.log("error", "Pi prompt dispatch failed.", {
          error: message,
          inputId: input.id,
        });
        this.callbacks.emitEvent(
          createNormalizedEvent({
            sessionId: this.sessionId,
            threadId: this.threadId,
            source: "worker",
            type: "session.errored",
            payload: {
              error: {
                code: "PROMPT_DISPATCH_FAILED",
                message,
                retryable: true,
              },
            },
          }),
        );
      })
      .finally(() => {
        this.dispatchPending = false;
        this.restoreIdleStatusAfterCompaction();
      });
  }

  async sendSteer(input: UserInput): Promise<void> {
    const session = this.requireSession();
    const normalized = convertUserInputToPiInput(input);
    await Promise.resolve(
      session.steer(normalized.text, normalized.images.length > 0 ? normalized.images : undefined),
    );
  }

  async sendFollowUp(input: UserInput): Promise<void> {
    const session = this.requireSession();
    const normalized = convertUserInputToPiInput(input);
    await Promise.resolve(
      session.followUp(
        normalized.text,
        normalized.images.length > 0 ? normalized.images : undefined,
      ),
    );
  }

  async interrupt(): Promise<void> {
    if (this.session === null || !this.isBusy()) {
      return;
    }

    this.setStatus("interrupting");
    this.dispatchPending = false;
    await this.session.abort();
    if (this.status !== "stopped" && this.status !== "terminated" && !this.isCompacting()) {
      this.setStatus("idle");
    }
  }

  async compact(): Promise<unknown> {
    const session = this.requireSession();
    if (this.isCompacting()) {
      throw new Error(`Manual compaction is already in progress for ${this.sessionId}.`);
    }

    this.manualCompacting = true;
    this.setStatus("compacting");

    try {
      return await session.compact();
    } finally {
      this.manualCompacting = false;
      this.restoreIdleStatusAfterCompaction();
    }
  }

  async stop(): Promise<void> {
    this.setStatus("stopping");
    await this.disposeCurrentSession({ abort: this.isBusy() });
    this.setStatus("stopped");
  }

  async terminate(): Promise<void> {
    await this.disposeCurrentSession({ abort: true });
    this.setStatus("terminated");
  }

  private async attachToThread(checkpoint: PiCheckpoint): Promise<PiCheckpoint> {
    validateCheckpoint(checkpoint, "pi");
    const config = this.requireConfig();
    const piModule = await this.loadModule();
    const backendConfig = getPiBackendConfig(config);
    const envOverrides = readStringRecord(backendConfig.env);

    await this.disposeCurrentSession({ abort: this.isBusy() });
    applyEnvOverrides(envOverrides);

    const sessionManager = piModule.SessionManager.open(
      checkpoint.sessionFile,
      backendConfig.sessionDir,
    );
    if (checkpoint.branchEntryId !== undefined) {
      sessionManager.branch(checkpoint.branchEntryId);
    }

    const model = await resolveModel(config);
    this.contextWindow = model?.contextWindow ?? null;
    if (model === undefined && parseConfiguredModel(config) !== null) {
      this.callbacks.log(
        "warn",
        "Unable to resolve configured Pi model; falling back to Pi defaults.",
        {
          model: config.model,
        },
      );
    }

    const hostTools = this.resolveHostTools(config) ?? undefined;
    const authStorage =
      backendConfig.authFile && piModule.AuthStorage
        ? piModule.AuthStorage.create(backendConfig.authFile)
        : undefined;
    const modelRegistry =
      authStorage && piModule.ModelRegistry
        ? typeof piModule.ModelRegistry.create === "function"
          ? piModule.ModelRegistry.create(authStorage)
          : new piModule.ModelRegistry(authStorage)
        : undefined;
    const thinkingLevel = resolveConfiguredThinkingLevel(config);
    const tools = piModule.createCodingTools
      ? piModule.createCodingTools(config.cwd, {
          bash: {
            spawnHook: (context) => ({
              ...context,
              env: {
                ...context.env,
                ...envOverrides,
              },
            }),
          },
        })
      : undefined;
    const memoryContextFile =
      backendConfig.memoryContextFile?.path && backendConfig.memoryContextFile?.content
        ? {
            path: backendConfig.memoryContextFile.path,
            content: backendConfig.memoryContextFile.content,
          }
        : undefined;
    const swarmContextFiles = Array.isArray(backendConfig.swarmContextFiles)
      ? backendConfig.swarmContextFiles
          .map((entry) => {
            const object = readObject(entry);
            const path = readString(object?.path);
            const content = readString(object?.content);
            return path && content ? { path, content } : null;
          })
          .filter((entry): entry is { path: string; content: string } => entry !== null)
      : [];
    const resourceLoader = piModule.DefaultResourceLoader
      ? new piModule.DefaultResourceLoader({
          cwd: config.cwd,
          agentDir: backendConfig.agentDir,
          additionalSkillPaths: backendConfig.additionalSkillPaths,
          ...(readString(backendConfig.middleman?.role) === "manager" && config.systemPrompt
            ? {
                systemPrompt: config.systemPrompt,
                appendSystemPromptOverride: () => [],
              }
            : {
                appendSystemPromptOverride: (base) =>
                  config.systemPrompt ? [...base, config.systemPrompt] : base,
              }),
          ...(memoryContextFile || swarmContextFiles.length > 0
            ? {
                agentsFilesOverride: (base) => ({
                  agentsFiles: mergeRuntimeContextFiles(base.agentsFiles, {
                    memoryContextFile,
                    swarmContextFiles,
                  }),
                }),
              }
            : {}),
        })
      : undefined;

    await resourceLoader?.reload();

    const { session } = await piModule.createAgentSession({
      cwd: config.cwd,
      agentDir: backendConfig.agentDir,
      ...(authStorage ? { authStorage } : {}),
      ...(modelRegistry ? { modelRegistry } : {}),
      model,
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...(tools ? { tools } : {}),
      ...(resourceLoader ? { resourceLoader } : {}),
      sessionManager,
      ...(hostTools ? { customTools: hostTools } : {}),
    });

    if (!resourceLoader) {
      applySystemPrompt(session, config.systemPrompt);
    }

    this.mapper = new PiEventMapper({
      sessionId: this.sessionId,
      threadId: this.threadId,
    });
    this.session = session;
    this.lastContextUsage = normalizePiSessionContextUsage(session.getContextUsage?.()) ?? null;
    this.unsubscribe = session.subscribe((event) => {
      this.handleSessionEvent(event);
    });

    return normalizeCheckpoint(checkpoint, sessionManager);
  }

  private handleSessionEvent(event: PiSessionEvent): void {
    if (event.type === "agent_start") {
      this.dispatchPending = false;
      this.setStatus("busy");
    } else if (event.type === "agent_end") {
      this.dispatchPending = false;
      this.restoreIdleStatusAfterCompaction();
    } else if (event.type === "auto_compaction_start") {
      this.autoCompacting = true;
      if (this.status !== "stopped" && this.status !== "terminated") {
        this.setStatus("busy");
      }
    } else if (event.type === "auto_compaction_end") {
      this.autoCompacting = false;
      this.restoreIdleStatusAfterCompaction();
    }

    this.captureContextUsage(event);

    for (const normalizedEvent of this.mapper.mapEvent(event)) {
      this.callbacks.emitEvent(normalizedEvent);
    }
  }

  private async disposeCurrentSession(options: { abort: boolean }): Promise<void> {
    const session = this.session;
    this.session = null;

    if (session === null) {
      this.unsubscribe?.();
      this.unsubscribe = null;
      return;
    }

    this.unsubscribe?.();
    this.unsubscribe = null;
    this.dispatchPending = false;
    this.manualCompacting = false;
    this.autoCompacting = false;

    try {
      if (options.abort) {
        await session.abort();
      }
    } catch (error) {
      this.callbacks.log("warn", "Pi session abort failed during disposal.", { error });
    } finally {
      session.dispose();
    }
  }

  private requireConfig(): SessionRuntimeConfig {
    if (this.config === null) {
      throw new Error("Pi session host has not been bootstrapped.");
    }

    return this.config;
  }

  private requireSession(): PiAgentSessionLike {
    if (this.session === null) {
      throw new Error("Pi session host has no active session.");
    }

    return this.session;
  }

  private isCompacting(): boolean {
    return this.manualCompacting || this.autoCompacting;
  }

  private restoreIdleStatusAfterCompaction(): void {
    if (
      this.status !== "stopped" &&
      this.status !== "terminated" &&
      this.status !== "errored" &&
      !this.dispatchPending &&
      this.session?.isStreaming !== true &&
      !this.isCompacting() &&
      (this.status === "busy" || this.status === "compacting")
    ) {
      this.setStatus("idle");
    }
  }

  private setStatus(
    status: SessionStatus,
    error?: SessionErrorInfo,
    contextUsage?: SessionContextUsage | null,
  ): void {
    const resolvedContextUsage = contextUsage === undefined ? this.lastContextUsage : contextUsage;
    if (
      this.status === status &&
      error === undefined &&
      areContextUsagesEqual(this.lastContextUsage, resolvedContextUsage ?? null)
    ) {
      return;
    }

    this.status = status;
    this.callbacks.emitStatusChange(status, error, resolvedContextUsage);
  }

  private captureContextUsage(event: PiSessionEvent): void {
    const nextUsage = extractPiContextUsage(event, this.session, this.contextWindow);
    if (nextUsage === undefined) {
      return;
    }

    if (areContextUsagesEqual(this.lastContextUsage, nextUsage)) {
      return;
    }

    this.lastContextUsage = nextUsage;
    this.callbacks.emitStatusChange(this.status, undefined, nextUsage);
  }

  private resolveHostTools(config: SessionRuntimeConfig): PiHostToolDefinition[] | null {
    const role = readMiddlemanRole(getPiBackendConfig(config).middleman?.role);
    if (!role || !this.hostRpc) {
      return null;
    }

    return createPiHostTools(this.hostRpc, buildHostToolDefinitions(role));
  }
}

function readMiddlemanRole(value: unknown): MiddlemanRole | undefined {
  return value === "manager" || value === "worker" ? value : undefined;
}

function describePiRuntimeError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    if (message.length > 0) {
      return message;
    }
  }

  if (typeof error === "string") {
    const message = error.trim();
    if (message.length > 0) {
      return message;
    }
  }

  const errorObject = readObject(error);
  const directMessage = readString(errorObject?.message);
  if (directMessage) {
    return directMessage;
  }

  const nestedErrorMessage = readString(readObject(errorObject?.error)?.message);
  if (nestedErrorMessage) {
    return nestedErrorMessage;
  }

  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== "{}") {
      return serialized;
    }
  } catch {
    // Ignore JSON serialization errors and fall back to the generic message below.
  }

  return "Pi runtime failed.";
}

function extractPiContextUsage(
  event: PiSessionEvent,
  session: PiAgentSessionLike | null,
  contextWindow: number | null,
): SessionContextUsage | null | undefined {
  const sessionUsage = normalizePiSessionContextUsage(session?.getContextUsage?.());
  if (sessionUsage !== undefined) {
    return sessionUsage;
  }

  if (!contextWindow || contextWindow <= 0) {
    return undefined;
  }

  const assistantMessage =
    event.type === "message_end"
      ? readPiAssistantMessage(event.message)
      : event.type === "turn_end"
        ? readPiAssistantMessage(event.message)
        : null;
  const totalTokens = assistantMessage?.usage?.totalTokens;
  if (typeof totalTokens !== "number" || !Number.isFinite(totalTokens) || totalTokens < 0) {
    return undefined;
  }

  return {
    tokens: Math.round(totalTokens),
    contextWindow,
    percent: Math.max(0, Math.min(100, (totalTokens / contextWindow) * 100)),
  };
}

function normalizePiSessionContextUsage(
  usage:
    | {
        tokens: number | null;
        contextWindow: number;
        percent: number | null;
      }
    | undefined,
): SessionContextUsage | null | undefined {
  if (!usage) {
    return undefined;
  }

  if (
    typeof usage.contextWindow !== "number" ||
    !Number.isFinite(usage.contextWindow) ||
    usage.contextWindow <= 0
  ) {
    return undefined;
  }

  if (usage.tokens === null || usage.percent === null) {
    return null;
  }

  if (
    typeof usage.tokens !== "number" ||
    !Number.isFinite(usage.tokens) ||
    usage.tokens < 0 ||
    typeof usage.percent !== "number" ||
    !Number.isFinite(usage.percent)
  ) {
    return undefined;
  }

  return {
    tokens: Math.round(usage.tokens),
    contextWindow: Math.round(usage.contextWindow),
    percent: Math.max(0, Math.min(100, usage.percent)),
  };
}

function readPiAssistantMessage(message: PiMessage): PiAssistantMessage | null {
  if (
    message &&
    typeof message === "object" &&
    !Array.isArray(message) &&
    (message as { role?: unknown }).role === "assistant" &&
    typeof (message as { usage?: unknown }).usage === "object" &&
    (message as { usage?: unknown }).usage !== null
  ) {
    return message as PiAssistantMessage;
  }

  return null;
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
