import { EventEmitter } from "node:events";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import { normalizeManagerId } from "../utils/normalize.js";

type IntegrationConfigShape = {
  profileId: string;
  enabled: boolean;
};

export interface IntegrationStatusTracker<TStatusEvent, TStatusUpdate> {
  on(event: "status", listener: (event: TStatusEvent) => void): this;
  getSnapshot(): TStatusEvent;
  update(next: TStatusUpdate): TStatusEvent;
}

export interface BaseIntegrationServiceOptions<
  TConfig extends IntegrationConfigShape,
  TPublicConfig,
  TStatusEvent,
  TStatusUpdate
> {
  swarmManager: SwarmManager;
  managerId: string;
  defaultConfig: TConfig;
  statusTracker: IntegrationStatusTracker<TStatusEvent, TStatusUpdate>;
  statusEventName: string;
  loadConfig: (options: { swarmManager: SwarmManager; managerId: string }) => Promise<TConfig>;
  saveConfig: (options: {
    swarmManager: SwarmManager;
    managerId: string;
    config: TConfig;
  }) => Promise<void>;
  mergeConfig: (base: TConfig, patch: unknown) => TConfig;
  maskConfig: (config: TConfig) => TPublicConfig;
}

export abstract class BaseIntegrationService<
  TConfig extends IntegrationConfigShape,
  TPublicConfig,
  TStatusEvent,
  TStatusUpdate
> extends EventEmitter {
  protected readonly swarmManager: SwarmManager;
  protected readonly managerId: string;
  protected config: TConfig;
  protected readonly statusTracker: IntegrationStatusTracker<TStatusEvent, TStatusUpdate>;

  private readonly statusEventName: string;
  private readonly loadConfigFn: (options: {
    swarmManager: SwarmManager;
    managerId: string;
  }) => Promise<TConfig>;
  private readonly saveConfigFn: (options: {
    swarmManager: SwarmManager;
    managerId: string;
    config: TConfig;
  }) => Promise<void>;
  private readonly mergeConfigFn: (base: TConfig, patch: unknown) => TConfig;
  private readonly maskConfigFn: (config: TConfig) => TPublicConfig;

  private started = false;
  private lifecycle: Promise<void> = Promise.resolve();

  constructor(
    options: BaseIntegrationServiceOptions<TConfig, TPublicConfig, TStatusEvent, TStatusUpdate>
  ) {
    super();

    this.swarmManager = options.swarmManager;
    this.managerId = normalizeManagerId(options.managerId);
    this.config = options.defaultConfig;
    this.statusTracker = options.statusTracker;
    this.statusEventName = options.statusEventName;
    this.loadConfigFn = options.loadConfig;
    this.saveConfigFn = options.saveConfig;
    this.mergeConfigFn = options.mergeConfig;
    this.maskConfigFn = options.maskConfig;

    this.statusTracker.on("status", (event: TStatusEvent) => {
      this.emit(this.statusEventName, event);
    });
  }

  async start(): Promise<void> {
    return this.runExclusive(async () => {
      if (this.started) {
        return;
      }

      this.started = true;
      this.startDeliveryBridge();

      try {
        this.config = await this.loadConfigFn({
          swarmManager: this.swarmManager,
          managerId: this.managerId
        });
      } catch (error) {
        this.updateStatus(this.buildLoadConfigErrorStatus(error));
        return;
      }

      await this.applyConfig();
    });
  }

  async stop(): Promise<void> {
    return this.runExclusive(async () => {
      if (!this.started) {
        return;
      }

      await this.stopRuntime();
      this.stopDeliveryBridge();
      this.started = false;
      this.updateStatus(this.buildStoppedStatus());
    });
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  getMaskedConfig(): TPublicConfig {
    return this.maskConfigFn(this.config);
  }

  getStatus(): TStatusEvent {
    return this.statusTracker.getSnapshot();
  }

  getManagerId(): string {
    return this.managerId;
  }

  getProfileId(): string {
    return this.config.profileId;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  async updateConfig(patch: unknown): Promise<{ config: TPublicConfig; status: TStatusEvent }> {
    return this.runExclusive(async () => {
      const nextConfig = this.mergeConfigFn(this.config, patch);

      await this.saveConfigFn({
        swarmManager: this.swarmManager,
        managerId: this.managerId,
        config: nextConfig
      });
      this.config = nextConfig;

      if (this.started) {
        await this.applyConfig();
      }

      return {
        config: this.getMaskedConfig(),
        status: this.getStatus()
      };
    });
  }

  async disable(): Promise<{ config: TPublicConfig; status: TStatusEvent }> {
    return this.updateConfig({ enabled: false });
  }

  protected isStarted(): boolean {
    return this.started;
  }

  protected updateStatus(next: TStatusUpdate): TStatusEvent {
    return this.statusTracker.update(next);
  }

  protected abstract applyConfig(): Promise<void>;
  protected abstract stopRuntime(): Promise<void>;
  protected abstract startDeliveryBridge(): void;
  protected abstract stopDeliveryBridge(): void;
  protected abstract buildLoadConfigErrorStatus(error: unknown): TStatusUpdate;
  protected abstract buildStoppedStatus(): TStatusUpdate;

  private async runExclusive<T>(action: () => Promise<T>): Promise<T> {
    const next = this.lifecycle.then(action, action);
    this.lifecycle = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}

export function toIntegrationErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
