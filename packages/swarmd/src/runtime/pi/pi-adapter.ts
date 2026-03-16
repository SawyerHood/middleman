import type {
  AdapterCallbacks,
  BackendAdapter,
  HostRpcClient,
} from "../common/adapter.js";
import type {
  BackendCapabilities,
  BackendCheckpoint,
  DeliveryMode,
  SessionRuntimeConfig,
  UserInput,
} from "../../core/types/index.js";
import { validateCheckpoint } from "../common/checkpoint.js";
import {
  PiSessionHost,
  type PiModuleLoader,
  type PiSessionHostLike,
} from "./pi-session-host.js";

type PiCheckpoint = Extract<BackendCheckpoint, { backend: "pi" }>;

export interface ResolvedPiDelivery {
  action: "prompt" | "steer" | "followUp";
  acceptedDelivery: DeliveryMode;
  queued: boolean;
}

export interface PiBackendAdapterOptions {
  sessionId: string;
  threadId: string | null;
  host?: PiSessionHostLike;
  loadModule?: PiModuleLoader;
  hostRpc?: HostRpcClient;
}

export const piBackendCapabilities: BackendCapabilities = {
  canResumeThread: true,
  canForkThread: true,
  canInterrupt: true,
  canQueueInput: true,
  canManualCompact: true,
  canReadHistory: true,
  emitsToolProgress: true,
  exposesRawEvents: false,
};

export function resolvePiDeliveryMode(
  delivery: DeliveryMode,
  options: {
    isBusy: boolean;
    busyDefault?: DeliveryMode;
  },
): ResolvedPiDelivery {
  if (!options.isBusy) {
    return {
      action: "prompt",
      acceptedDelivery: delivery,
      queued: false,
    };
  }

  const configuredBusyDefault = options.busyDefault === "queue" ? "queue" : "interrupt";
  const resolvedDelivery = delivery === "auto" ? configuredBusyDefault : delivery;

  if (resolvedDelivery === "queue") {
    return {
      action: "followUp",
      acceptedDelivery: "queue",
      queued: true,
    };
  }

  return {
    action: "steer",
    acceptedDelivery: "interrupt",
    queued: true,
  };
}

export class PiBackendAdapter implements BackendAdapter {
  readonly kind = "pi" as const;
  readonly capabilities = piBackendCapabilities;

  private readonly callbacks: AdapterCallbacks;
  private readonly host: PiSessionHostLike;
  private config: SessionRuntimeConfig | null = null;

  constructor(callbacks: AdapterCallbacks, options: PiBackendAdapterOptions) {
    this.callbacks = callbacks;
    this.host =
      options.host ??
      new PiSessionHost(
        {
          emitEvent: callbacks.emitEvent,
          emitStatusChange: callbacks.emitStatusChange,
          log: callbacks.log,
        },
        {
          sessionId: options.sessionId,
          threadId: options.threadId,
          loadModule: options.loadModule,
          hostRpc: options.hostRpc,
        },
      );
  }

  async bootstrap(
    config: SessionRuntimeConfig,
    checkpoint?: BackendCheckpoint,
  ): Promise<{ checkpoint: BackendCheckpoint }> {
    this.config = config;
    const piCheckpoint = checkpoint ? this.assertPiCheckpoint(checkpoint) : undefined;
    const nextCheckpoint = await this.host.bootstrap(config, piCheckpoint);
    return { checkpoint: nextCheckpoint };
  }

  async sendInput(
    input: UserInput,
    delivery: DeliveryMode,
  ): Promise<{ acceptedDelivery: DeliveryMode; queued: boolean }> {
    const config = this.requireConfig();
    const resolvedDelivery = resolvePiDeliveryMode(delivery, {
      isBusy: this.host.isBusy(),
      busyDefault: config.deliveryDefaults?.busyMode,
    });

    switch (resolvedDelivery.action) {
      case "prompt":
        await this.host.sendPrompt(input);
        break;
      case "steer":
        await this.host.sendSteer(input);
        break;
      case "followUp":
        await this.host.sendFollowUp(input);
        break;
    }

    return {
      acceptedDelivery: resolvedDelivery.acceptedDelivery,
      queued: resolvedDelivery.queued,
    };
  }

  async createThread(seed?: UserInput[]): Promise<BackendCheckpoint> {
    const checkpoint = await this.host.createThread(seed);
    this.callbacks.emitCheckpoint(checkpoint);
    return checkpoint;
  }

  async forkThread(source: BackendCheckpoint, sourceMessageId?: string): Promise<BackendCheckpoint> {
    const checkpoint = await this.host.forkThread(this.assertPiCheckpoint(source), sourceMessageId);
    this.callbacks.emitCheckpoint(checkpoint);
    return checkpoint;
  }

  async resumeThread(checkpoint: BackendCheckpoint): Promise<BackendCheckpoint> {
    const resumedCheckpoint = await this.host.resumeThread(this.assertPiCheckpoint(checkpoint));
    this.callbacks.emitCheckpoint(resumedCheckpoint);
    return resumedCheckpoint;
  }

  async readHistory(
    threadCheckpoint: BackendCheckpoint,
    _options?: {
      cursor?: string;
      limit?: number;
    },
  ) {
    this.assertPiCheckpoint(threadCheckpoint);

    return {
      entries: [],
      cursor: {
        cursor: null,
        hasMore: false,
      },
    };
  }

  async interrupt(): Promise<void> {
    await this.host.interrupt();
  }

  async stop(): Promise<void> {
    await this.host.stop();
  }

  async terminate(): Promise<void> {
    await this.host.terminate();
  }

  private requireConfig(): SessionRuntimeConfig {
    if (this.config === null) {
      throw new Error("Pi backend adapter has not been bootstrapped.");
    }

    return this.config;
  }

  private assertPiCheckpoint(checkpoint: BackendCheckpoint): PiCheckpoint {
    validateCheckpoint(checkpoint, "pi");
    return checkpoint as PiCheckpoint;
  }
}
