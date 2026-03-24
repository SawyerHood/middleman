import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { z } from "zod";

import type {
  BackendCapabilities,
  BackendCheckpoint,
  BackendKind,
  DeliveryMode,
  SessionErrorInfo,
  SessionRuntimeConfig,
  UserInput,
} from "../../core/types/index.js";
import {
  deliveryModeSchema,
  sessionContextUsageSchema,
  sessionErrorInfoSchema,
  sessionStatusSchema,
} from "../../core/types/index.js";
import {
  createInitialClaudeCheckpoint,
  createInitialCodexCheckpoint,
  createInitialPiCheckpoint,
  validateCheckpoint,
} from "./checkpoint.js";
import type { AdapterCallbacks, BackendAdapter, HostRpcClient } from "./adapter.js";

const mockRuntimeConfigSchema = z
  .object({
    fixtureFile: z.string().min(1).optional(),
    fixture: z.unknown().optional(),
    scenarioId: z.string().min(1).optional(),
  })
  .refine((value) => value.fixtureFile !== undefined || value.fixture !== undefined, {
    message: "Mock runtime config requires fixtureFile or fixture.",
  });

const scriptedTurnMatchSchema = z.object({
  index: z.number().int().positive().optional(),
  textIncludes: z.string().optional(),
  textMatches: z.string().optional(),
  role: z.enum(["user", "system"]).optional(),
  delivery: deliveryModeSchema.optional(),
});

const scriptedStatusStepSchema = z.object({
  type: z.literal("status"),
  status: sessionStatusSchema,
  error: sessionErrorInfoSchema.optional(),
  contextUsage: sessionContextUsageSchema.nullable().optional(),
});

const scriptedSleepStepSchema = z.object({
  type: z.literal("sleep"),
  ms: z.number().int().nonnegative(),
});

const scriptedToolProgressStepSchema = z.object({
  type: z.literal("tool_progress"),
  toolName: z.string().min(1),
  toolCallId: z.string().min(1).optional(),
  progress: z.unknown().optional(),
});

const scriptedHostCallStepSchema = z.object({
  type: z.literal("host_call"),
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
  toolCallId: z.string().min(1).optional(),
  continueOnError: z.boolean().optional(),
});

const scriptedErrorStepSchema = z.object({
  type: z.literal("error"),
  error: sessionErrorInfoSchema.optional(),
  code: z.string().min(1).optional(),
  message: z.string().min(1).optional(),
  retryable: z.boolean().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

const scriptedWorkerExitStepSchema = z.object({
  type: z.literal("worker_exit"),
  code: z.number().int().optional(),
});

const scriptedMessageBaseSchema = z
  .object({
    messageId: z.string().min(1).optional(),
    role: z.enum(["assistant", "system", "user"]).optional(),
    text: z.string().optional(),
    chunks: z.array(z.string()).optional(),
    chunkDelayMs: z.number().int().nonnegative().optional(),
  })
  .superRefine((value, context) => {
    if (value.text === undefined && value.chunks === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Message steps require text or chunks.",
      });
    }
  });

const scriptedMessageStreamStepSchema = scriptedMessageBaseSchema.extend({
  type: z.literal("message_stream"),
});

const scriptedMessageCompletedStepSchema = scriptedMessageBaseSchema.extend({
  type: z.literal("message_completed"),
});

const scriptedStepSchema = z.discriminatedUnion("type", [
  scriptedStatusStepSchema,
  scriptedSleepStepSchema,
  scriptedToolProgressStepSchema,
  scriptedHostCallStepSchema,
  scriptedErrorStepSchema,
  scriptedWorkerExitStepSchema,
  scriptedMessageStreamStepSchema,
  scriptedMessageCompletedStepSchema,
]);

const scriptedTurnSchema = z.object({
  match: scriptedTurnMatchSchema.optional(),
  steps: z.array(scriptedStepSchema).default([]),
});

const scriptedSessionFixtureSchema = z.object({
  turns: z.array(scriptedTurnSchema).default([]),
});

const scriptedFixtureSchema = z.object({
  sessions: z.record(z.string(), scriptedSessionFixtureSchema).default({}),
});

const scriptedFixtureSetSchema = z.object({
  sessions: z.record(z.string(), scriptedSessionFixtureSchema).optional(),
  scenarios: z.record(z.string(), scriptedFixtureSchema).optional(),
});

type ScriptedMessageStep =
  | z.infer<typeof scriptedMessageStreamStepSchema>
  | z.infer<typeof scriptedMessageCompletedStepSchema>;
type ScriptedStep = z.infer<typeof scriptedStepSchema>;
type ScriptedTurnMatch = z.infer<typeof scriptedTurnMatchSchema>;
type ScriptedTurn = z.infer<typeof scriptedTurnSchema>;
type ScriptedSessionFixture = z.infer<typeof scriptedSessionFixtureSchema>;
export type ScriptedRuntimeFixture = z.infer<typeof scriptedFixtureSchema>;
export type MockRuntimeConfig = z.infer<typeof mockRuntimeConfigSchema>;

const CODEX_MOCK_CAPABILITIES: BackendCapabilities = {
  canResumeThread: true,
  canForkThread: true,
  canInterrupt: true,
  canQueueInput: true,
  canManualCompact: true,
  canReadHistory: true,
  emitsToolProgress: true,
  exposesRawEvents: true,
};

const CLAUDE_MOCK_CAPABILITIES: BackendCapabilities = {
  canResumeThread: true,
  canForkThread: true,
  canInterrupt: true,
  canQueueInput: false,
  canManualCompact: false,
  canReadHistory: true,
  emitsToolProgress: true,
  exposesRawEvents: true,
};

const PI_MOCK_CAPABILITIES: BackendCapabilities = {
  canResumeThread: true,
  canForkThread: true,
  canInterrupt: true,
  canQueueInput: true,
  canManualCompact: true,
  canReadHistory: true,
  emitsToolProgress: true,
  exposesRawEvents: false,
};

function capabilitiesForKind(kind: BackendKind): BackendCapabilities {
  switch (kind) {
    case "codex":
      return CODEX_MOCK_CAPABILITIES;
    case "claude":
      return CLAUDE_MOCK_CAPABILITIES;
    case "pi":
      return PI_MOCK_CAPABILITIES;
  }
}

function createMockCheckpoint(kind: BackendKind, sessionId: string): BackendCheckpoint {
  switch (kind) {
    case "codex":
      return createInitialCodexCheckpoint(`thr_mock_${sessionId}`);
    case "claude":
      return createInitialClaudeCheckpoint(`claude_mock_${sessionId}`);
    case "pi":
      return createInitialPiCheckpoint(`/tmp/${sessionId}.mock-session.json`);
  }
}

function toSessionId(config: SessionRuntimeConfig): string {
  const backendConfig = config.backendConfig;
  const sessionId = backendConfig.swarmdSessionId;
  return typeof sessionId === "string" && sessionId.trim().length > 0
    ? sessionId.trim()
    : "mock-session";
}

function extractInputText(input: UserInput): string {
  return input.parts
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }

      if (part.type === "file") {
        return part.fileName ?? part.path ?? "";
      }

      return "";
    })
    .filter(Boolean)
    .join("\n");
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw new ScriptedTurnInterruptedError();
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();

    const abort = () => {
      clearTimeout(timer);
      reject(new ScriptedTurnInterruptedError());
    };

    signal?.addEventListener("abort", abort, { once: true });
  });
}

function toEventTimestamp(): string {
  return new Date().toISOString();
}

function buildTurnError(step: z.infer<typeof scriptedErrorStepSchema>): SessionErrorInfo {
  if (step.error) {
    return step.error;
  }

  return {
    code: step.code ?? "MOCK_RUNTIME_ERROR",
    message: step.message ?? "Mock runtime failed.",
    retryable: step.retryable ?? false,
    ...(step.details ? { details: step.details } : {}),
  };
}

function resolveMessageText(step: ScriptedMessageStep): string {
  if (typeof step.text === "string") {
    return step.text;
  }

  return (step.chunks ?? []).join("");
}

function resolveMessageChunks(step: ScriptedMessageStep): string[] {
  if (Array.isArray(step.chunks) && step.chunks.length > 0) {
    return step.chunks;
  }

  return [resolveMessageText(step)];
}

function isTurnMatch(
  match: ScriptedTurnMatch | undefined,
  input: UserInput,
  delivery: DeliveryMode,
  turnIndex: number,
): boolean {
  if (!match) {
    return true;
  }

  if (match.index !== undefined && match.index !== turnIndex) {
    return false;
  }

  if (match.role !== undefined && match.role !== input.role) {
    return false;
  }

  if (match.delivery !== undefined && match.delivery !== delivery) {
    return false;
  }

  const text = extractInputText(input);
  if (match.textIncludes !== undefined && !text.includes(match.textIncludes)) {
    return false;
  }

  if (match.textMatches !== undefined && !new RegExp(match.textMatches).test(text)) {
    return false;
  }

  return true;
}

async function loadScriptedFixture(rawConfig: unknown): Promise<ScriptedRuntimeFixture> {
  const config = mockRuntimeConfigSchema.parse(rawConfig);

  let rawFixture: unknown;
  if (config.fixtureFile) {
    const fixtureText = await readFile(config.fixtureFile, "utf8");
    rawFixture = JSON.parse(fixtureText) as unknown;
  } else {
    rawFixture = config.fixture;
  }

  const parsed = scriptedFixtureSetSchema.parse(rawFixture);
  if (config.scenarioId) {
    const scenarioFixture = parsed.scenarios?.[config.scenarioId];
    if (!scenarioFixture) {
      throw new Error(`Mock runtime scenario "${config.scenarioId}" was not found.`);
    }
    return scriptedFixtureSchema.parse(scenarioFixture);
  }

  return scriptedFixtureSchema.parse(parsed);
}

export function hasMockRuntimeConfig(backendConfig: Record<string, unknown> | undefined): boolean {
  return typeof backendConfig?.mockRuntime === "object" && backendConfig.mockRuntime !== null;
}

class ScriptedTurnInterruptedError extends Error {
  constructor() {
    super("Mock runtime turn interrupted.");
  }
}

interface ScriptedBackendAdapterOptions {
  hostRpc?: HostRpcClient;
  exitProcess?: (code: number) => void;
}

interface PendingTurn {
  input: UserInput;
  delivery: DeliveryMode;
  turnIndex: number;
}

export class ScriptedBackendAdapter implements BackendAdapter {
  readonly kind: BackendKind;
  readonly capabilities: BackendCapabilities;

  private checkpoint: BackendCheckpoint | null = null;
  private sessionId = "mock-session";
  private fixture: ScriptedRuntimeFixture = { sessions: {} };
  private sessionFixture: ScriptedSessionFixture = { turns: [] };
  private turnCounter = 0;
  private processingTurn = false;
  private currentAbortController: AbortController | null = null;
  private pendingTurns: PendingTurn[] = [];
  private isShuttingDown = false;

  constructor(
    kind: BackendKind,
    private readonly callbacks: AdapterCallbacks,
    private readonly options: ScriptedBackendAdapterOptions = {},
  ) {
    this.kind = kind;
    this.capabilities = capabilitiesForKind(kind);
  }

  async bootstrap(
    config: SessionRuntimeConfig,
    checkpoint?: BackendCheckpoint,
  ): Promise<{ checkpoint: BackendCheckpoint }> {
    const backendConfig = config.backendConfig;
    if (!hasMockRuntimeConfig(backendConfig)) {
      throw new Error("Mock runtime requested without backendConfig.mockRuntime.");
    }

    this.turnCounter = 0;
    this.isShuttingDown = false;
    this.pendingTurns = [];
    this.sessionId = toSessionId(config);
    this.fixture = await loadScriptedFixture(backendConfig.mockRuntime);
    this.sessionFixture = this.fixture.sessions[this.sessionId] ??
      this.fixture.sessions["*"] ?? { turns: [] };

    this.checkpoint = checkpoint
      ? this.normalizeCheckpoint(checkpoint)
      : createMockCheckpoint(this.kind, this.sessionId);

    return {
      checkpoint: this.checkpoint,
    };
  }

  async sendInput(
    input: UserInput,
    delivery: DeliveryMode,
  ): Promise<{ acceptedDelivery: DeliveryMode; queued: boolean }> {
    const queued = this.processingTurn || this.pendingTurns.length > 0;
    const acceptedDelivery =
      queued && delivery === "auto"
        ? this.capabilities.canQueueInput
          ? "queue"
          : "interrupt"
        : delivery;

    if (acceptedDelivery === "interrupt" && this.currentAbortController) {
      this.currentAbortController.abort();
    }

    this.pendingTurns.push({
      input,
      delivery,
      turnIndex: ++this.turnCounter,
    });
    void this.drainTurnQueue();

    return {
      acceptedDelivery,
      queued,
    };
  }

  async createThread(seed?: UserInput[]): Promise<BackendCheckpoint> {
    const checkpoint = createMockCheckpoint(this.kind, this.sessionId);
    this.checkpoint = checkpoint;
    if (seed && seed.length > 0) {
      for (const input of seed) {
        await this.sendInput(input, "auto");
      }
    }
    this.callbacks.emitCheckpoint(checkpoint);
    return checkpoint;
  }

  async forkThread(source: BackendCheckpoint): Promise<BackendCheckpoint> {
    const checkpoint = this.normalizeCheckpoint(source);
    this.checkpoint = checkpoint;
    this.callbacks.emitCheckpoint(checkpoint);
    return checkpoint;
  }

  async resumeThread(checkpoint: BackendCheckpoint): Promise<BackendCheckpoint> {
    const resumedCheckpoint = this.normalizeCheckpoint(checkpoint);
    this.checkpoint = resumedCheckpoint;
    this.callbacks.emitCheckpoint(resumedCheckpoint);
    return resumedCheckpoint;
  }

  async interrupt(): Promise<void> {
    if (!this.currentAbortController) {
      return;
    }

    this.callbacks.emitStatusChange("interrupting");
    this.currentAbortController.abort();
  }

  async compact(customInstructions?: string): Promise<unknown> {
    if (!this.capabilities.canManualCompact) {
      throw new Error(`Manual compaction is not supported for the ${this.kind} backend.`);
    }

    return {
      compacted: true,
      ...(customInstructions === undefined ? {} : { customInstructions }),
    };
  }

  async stop(): Promise<void> {
    this.isShuttingDown = true;
    this.pendingTurns = [];
    this.currentAbortController?.abort();
  }

  async terminate(): Promise<void> {
    await this.stop();
  }

  private async drainTurnQueue(): Promise<void> {
    if (this.processingTurn || this.isShuttingDown) {
      return;
    }

    const nextTurn = this.pendingTurns.shift();
    if (!nextTurn) {
      return;
    }

    this.processingTurn = true;
    this.currentAbortController = new AbortController();

    try {
      await this.executeTurn(nextTurn, this.currentAbortController.signal);
    } catch (error) {
      if (!(error instanceof ScriptedTurnInterruptedError)) {
        const sessionError = toSessionErrorInfo(error);
        this.callbacks.emitStatusChange("errored", sessionError);
        this.callbacks.emitEvent(
          this.createEvent("session.errored", {
            error: sessionError,
          }),
        );
      }
    } finally {
      const wasInterrupted = this.currentAbortController.signal.aborted;
      this.currentAbortController = null;
      this.processingTurn = false;
      if (wasInterrupted && !this.isShuttingDown) {
        this.callbacks.emitStatusChange("idle");
      }
      void this.drainTurnQueue();
    }
  }

  private async executeTurn(turn: PendingTurn, signal: AbortSignal): Promise<void> {
    const scriptedTurn = this.matchTurn(turn);
    if (!scriptedTurn) {
      this.callbacks.log("debug", "No scripted mock turn matched input.", {
        sessionId: this.sessionId,
        turnIndex: turn.turnIndex,
        role: turn.input.role,
        delivery: turn.delivery,
        text: extractInputText(turn.input),
      });
      return;
    }

    const turnId = `turn-${turn.turnIndex}`;
    this.callbacks.emitEvent(
      this.createEvent("turn.started", {
        turnId,
        inputId: turn.input.id,
        role: turn.input.role,
      }),
    );

    for (const step of scriptedTurn.steps) {
      if (signal.aborted) {
        this.callbacks.emitEvent(
          this.createEvent("turn.interrupted", {
            turnId,
            inputId: turn.input.id,
          }),
        );
        throw new ScriptedTurnInterruptedError();
      }

      await this.executeStep(step, turn, signal);
    }

    this.callbacks.emitEvent(
      this.createEvent("turn.completed", {
        turnId,
        inputId: turn.input.id,
      }),
    );
  }

  private async executeStep(
    step: ScriptedStep,
    turn: PendingTurn,
    signal: AbortSignal,
  ): Promise<void> {
    switch (step.type) {
      case "status":
        this.callbacks.emitStatusChange(step.status, step.error, step.contextUsage ?? undefined);
        break;
      case "sleep":
        await sleep(step.ms, signal);
        break;
      case "tool_progress":
        this.callbacks.emitEvent(
          this.createEvent("tool.progress", {
            toolName: step.toolName,
            toolCallId: step.toolCallId ?? `${step.toolName}-${turn.turnIndex}`,
            progress: step.progress ?? null,
          }),
        );
        break;
      case "message_stream":
      case "message_completed":
        await this.emitMessage(step, signal);
        break;
      case "host_call":
        await this.executeHostCallStep(step);
        break;
      case "error": {
        const error = buildTurnError(step);
        this.callbacks.emitStatusChange("errored", error);
        this.callbacks.emitEvent(
          this.createEvent("session.errored", {
            error,
          }),
        );
        throw new Error(error.message);
      }
      case "worker_exit":
        (this.options.exitProcess ?? ((code: number) => process.exit(code)))(step.code ?? 1);
        break;
    }
  }

  private async emitMessage(step: ScriptedMessageStep, signal: AbortSignal): Promise<void> {
    const messageId = step.messageId ?? randomUUID();
    const role = step.role ?? "assistant";
    const text = resolveMessageText(step);
    const chunks = resolveMessageChunks(step);

    this.callbacks.emitEvent(
      this.createEvent("message.started", {
        messageId,
        role,
        text,
      }),
    );

    if (step.type === "message_stream") {
      for (const chunk of chunks) {
        if (signal.aborted) {
          throw new ScriptedTurnInterruptedError();
        }

        if (chunk.length > 0) {
          this.callbacks.emitEvent(
            this.createEvent("message.delta", {
              messageId,
              role,
              delta: chunk,
            }),
          );
        }

        if ((step.chunkDelayMs ?? 0) > 0) {
          await sleep(step.chunkDelayMs ?? 0, signal);
        }
      }
    }

    this.callbacks.emitEvent(
      this.createEvent("message.completed", {
        messageId,
        role,
        text,
      }),
    );
  }

  private async executeHostCallStep(
    step: z.infer<typeof scriptedHostCallStepSchema>,
  ): Promise<void> {
    const toolCallId = step.toolCallId ?? `${step.tool}-${randomUUID()}`;
    const args = step.args ?? {};

    this.callbacks.emitEvent(
      this.createEvent("tool.started", {
        toolName: step.tool,
        toolCallId,
        input: args,
      }),
    );

    try {
      const result = this.options.hostRpc
        ? await this.options.hostRpc.callTool(step.tool, args)
        : { ok: true };

      this.callbacks.emitEvent(
        this.createEvent("tool.completed", {
          toolName: step.tool,
          toolCallId,
          ok: true,
          result,
        }),
      );
    } catch (error) {
      const sessionError = toSessionErrorInfo(error);
      this.callbacks.emitEvent(
        this.createEvent("tool.completed", {
          toolName: step.tool,
          toolCallId,
          ok: false,
          result: {
            error: sessionError,
          },
        }),
      );

      if (step.continueOnError !== true) {
        throw error;
      }
    }
  }

  private createEvent(type: string, payload: Record<string, unknown>) {
    return {
      id: randomUUID(),
      sessionId: this.sessionId,
      threadId: this.resolveThreadId(),
      timestamp: toEventTimestamp(),
      source: "backend" as const,
      type,
      payload,
    };
  }

  private resolveThreadId(): string | null {
    const checkpoint = this.checkpoint;
    if (!checkpoint) {
      return null;
    }

    if (checkpoint.backend === "codex") {
      return checkpoint.threadId;
    }

    if (checkpoint.backend === "claude") {
      return checkpoint.sessionId;
    }

    return checkpoint.sessionFile;
  }

  private matchTurn(turn: PendingTurn): ScriptedTurn | undefined {
    return this.sessionFixture.turns.find((candidate) =>
      isTurnMatch(candidate.match, turn.input, turn.delivery, turn.turnIndex),
    );
  }

  private normalizeCheckpoint(checkpoint: BackendCheckpoint): BackendCheckpoint {
    validateCheckpoint(checkpoint, this.kind);
    return checkpoint;
  }
}

function toSessionErrorInfo(error: unknown): SessionErrorInfo {
  if (error && typeof error === "object" && "message" in error) {
    return {
      code: "MOCK_RUNTIME_ERROR",
      message: String((error as { message: unknown }).message),
      retryable: false,
    };
  }

  return {
    code: "MOCK_RUNTIME_ERROR",
    message: String(error),
    retryable: false,
  };
}
