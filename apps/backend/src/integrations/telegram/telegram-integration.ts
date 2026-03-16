import type { SwarmManager } from "../../swarm/swarm-manager.js";
import { normalizeManagerId } from "../../utils/normalize.js";
import {
  BaseIntegrationService,
  toIntegrationErrorMessage
} from "../base-integration-service.js";
import {
  createDefaultTelegramConfig,
  loadTelegramConfig,
  maskTelegramConfig,
  mergeTelegramConfig,
  saveTelegramConfig
} from "./telegram-config.js";
import { TelegramBotApiClient } from "./telegram-client.js";
import { TelegramDeliveryBridge } from "./telegram-delivery.js";
import { TelegramPollingBridge } from "./telegram-polling.js";
import { TelegramInboundRouter } from "./telegram-router.js";
import {
  TelegramStatusTracker,
  type TelegramStatusEvent,
  type TelegramStatusUpdate
} from "./telegram-status.js";
import type {
  TelegramConnectionTestResult,
  TelegramIntegrationConfig,
  TelegramIntegrationConfigPublic
} from "./telegram-types.js";

export class TelegramIntegrationService extends BaseIntegrationService<
  TelegramIntegrationConfig,
  TelegramIntegrationConfigPublic,
  TelegramStatusEvent,
  TelegramStatusUpdate
> {
  private telegramClient: TelegramBotApiClient | null = null;
  private inboundRouter: TelegramInboundRouter | null = null;
  private pollingBridge: TelegramPollingBridge | null = null;
  private readonly deliveryBridge: TelegramDeliveryBridge;

  private botId: string | undefined;
  private botUsername: string | undefined;
  private nextUpdateOffset: number | undefined;

  constructor(options: { swarmManager: SwarmManager; managerId: string }) {
    const managerId = normalizeManagerId(options.managerId);
    const defaultConfig = createDefaultTelegramConfig(managerId);
    const statusTracker = new TelegramStatusTracker({
      managerId,
      integrationProfileId: defaultConfig.profileId,
      state: "disabled",
      enabled: false,
      message: "Telegram integration disabled"
    });

    super({
      swarmManager: options.swarmManager,
      managerId,
      defaultConfig,
      statusTracker,
      statusEventName: "telegram_status",
      loadConfig: loadTelegramConfig,
      saveConfig: saveTelegramConfig,
      mergeConfig: mergeTelegramConfig,
      maskConfig: maskTelegramConfig
    });

    this.deliveryBridge = new TelegramDeliveryBridge({
      swarmManager: this.swarmManager,
      managerId: this.managerId,
      getConfig: () => this.config,
      getProfileId: () => this.config.profileId,
      getTelegramClient: () => this.telegramClient,
      onError: (message, error) => {
        this.updateStatus({
          managerId: this.managerId,
          integrationProfileId: this.config.profileId,
          state: "error",
          enabled: this.config.enabled,
          message: `${message}: ${toIntegrationErrorMessage(error)}`,
          botId: this.botId,
          botUsername: this.botUsername
        });
      }
    });
  }

  async testConnection(patch?: unknown): Promise<TelegramConnectionTestResult> {
    const effectiveConfig = patch ? mergeTelegramConfig(this.config, patch) : this.config;

    const botToken = effectiveConfig.botToken.trim();
    if (!botToken) {
      throw new Error("Telegram bot token is required");
    }

    const client = new TelegramBotApiClient(botToken);
    const auth = await client.testAuth();

    return {
      ok: true,
      botId: auth.botId,
      botUsername: auth.botUsername,
      botDisplayName: auth.botDisplayName
    };
  }

  protected async applyConfig(): Promise<void> {
    await this.stopRuntime();

    this.telegramClient = null;
    this.inboundRouter = null;
    this.botId = undefined;
    this.botUsername = undefined;
    this.nextUpdateOffset = undefined;

    if (!this.config.enabled) {
      this.updateStatus({
        managerId: this.managerId,
        integrationProfileId: this.config.profileId,
        state: "disabled",
        enabled: false,
        message: "Telegram integration disabled",
        botId: undefined,
        botUsername: undefined
      });
      return;
    }

    const botToken = this.config.botToken.trim();
    if (!botToken) {
      this.updateStatus({
        managerId: this.managerId,
        integrationProfileId: this.config.profileId,
        state: "error",
        enabled: true,
        message: "Telegram bot token is required",
        botId: undefined,
        botUsername: undefined
      });
      return;
    }

    try {
      const telegramClient = new TelegramBotApiClient(botToken);
      const auth = await telegramClient.testAuth();

      this.telegramClient = telegramClient;
      this.botId = auth.botId;
      this.botUsername = auth.botUsername;

      this.inboundRouter = new TelegramInboundRouter({
        swarmManager: this.swarmManager,
        managerId: this.managerId,
        integrationProfileId: this.config.profileId,
        getConfig: () => this.config,
        getBotId: () => this.botId,
        onError: (message, error) => {
          this.updateStatus({
            managerId: this.managerId,
            integrationProfileId: this.config.profileId,
            state: "error",
            enabled: this.config.enabled,
            message: `${message}: ${toIntegrationErrorMessage(error)}`,
            botId: this.botId,
            botUsername: this.botUsername
          });
        }
      });

      const pollingBridge = new TelegramPollingBridge({
        telegramClient,
        getPollingConfig: () => this.config.polling,
        getOffset: () => this.nextUpdateOffset,
        setOffset: (offset) => {
          this.nextUpdateOffset = offset;
        },
        onUpdate: async (update) => {
          await this.inboundRouter?.handleUpdate(update);
        },
        onStateChange: (state, message) => {
          this.updateStatus({
            managerId: this.managerId,
            integrationProfileId: this.config.profileId,
            state,
            enabled: this.config.enabled,
            message,
            botId: this.botId,
            botUsername: this.botUsername
          });
        }
      });

      this.pollingBridge = pollingBridge;
      await pollingBridge.start();

      this.updateStatus({
        managerId: this.managerId,
        integrationProfileId: this.config.profileId,
        state: "connected",
        enabled: true,
        message: "Telegram connected",
        botId: this.botId,
        botUsername: this.botUsername
      });
    } catch (error) {
      await this.stopRuntime();
      this.updateStatus({
        managerId: this.managerId,
        integrationProfileId: this.config.profileId,
        state: "error",
        enabled: true,
        message: `Telegram startup failed: ${toIntegrationErrorMessage(error)}`,
        botId: this.botId,
        botUsername: this.botUsername
      });
    }
  }

  protected async stopRuntime(): Promise<void> {
    await this.stopPolling();
  }

  protected startDeliveryBridge(): void {
    this.deliveryBridge.start();
  }

  protected stopDeliveryBridge(): void {
    this.deliveryBridge.stop();
  }

  protected buildLoadConfigErrorStatus(error: unknown): TelegramStatusUpdate {
    return {
      managerId: this.managerId,
      integrationProfileId: this.config.profileId,
      state: "error",
      enabled: false,
      message: `Failed to load Telegram config: ${toIntegrationErrorMessage(error)}`,
      botId: undefined,
      botUsername: undefined
    };
  }

  protected buildStoppedStatus(): TelegramStatusUpdate {
    return {
      managerId: this.managerId,
      integrationProfileId: this.config.profileId,
      state: this.config.enabled ? "disconnected" : "disabled",
      enabled: this.config.enabled,
      message: this.config.enabled ? "Telegram integration stopped" : "Telegram integration disabled",
      botId: this.botId,
      botUsername: this.botUsername
    };
  }

  private async stopPolling(): Promise<void> {
    if (!this.pollingBridge) {
      return;
    }

    const existing = this.pollingBridge;
    this.pollingBridge = null;

    try {
      await existing.stop();
    } catch {
      // Ignore polling shutdown errors.
    }
  }
}
