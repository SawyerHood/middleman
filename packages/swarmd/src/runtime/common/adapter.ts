import type {
  BackendCapabilities,
  BackendCheckpoint,
  BackendKind,
  DeliveryMode,
  EventEnvelope,
  SessionContextUsage,
  SessionErrorInfo,
  SessionRuntimeConfig,
  SessionStatus,
  UserInput,
} from "../../core/types/index.js";

export interface HostRpcClient {
  callTool(toolName: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface AdapterCallbacks {
  emitEvent(event: Omit<EventEnvelope, "cursor">): void;
  emitStatusChange(
    status: SessionStatus,
    error?: SessionErrorInfo,
    contextUsage?: SessionContextUsage | null,
  ): void;
  emitCheckpoint(checkpoint: BackendCheckpoint): void;
  emitBackendState?(state: Record<string, unknown>): void;
  log(level: "debug" | "info" | "warn" | "error", message: string, details?: unknown): void;
}

export interface BackendAdapter {
  readonly kind: BackendKind;
  readonly capabilities: BackendCapabilities;

  bootstrap(
    config: SessionRuntimeConfig,
    checkpoint?: BackendCheckpoint,
  ): Promise<{ checkpoint: BackendCheckpoint }>;
  sendInput(
    input: UserInput,
    delivery: DeliveryMode,
  ): Promise<{ acceptedDelivery: DeliveryMode; queued: boolean }>;
  createThread(seed?: UserInput[]): Promise<BackendCheckpoint>;
  forkThread(source: BackendCheckpoint, sourceMessageId?: string): Promise<BackendCheckpoint>;
  resumeThread(checkpoint: BackendCheckpoint): Promise<BackendCheckpoint>;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
  terminate(): Promise<void>;
}

export type AdapterFactory = (callbacks: AdapterCallbacks) => BackendAdapter;
