import type { SwarmManager } from "../../swarm/swarm-manager.js";
import { normalizeManagerId } from "../../utils/normalize.js";
import {
  BaseIntegrationService,
  toIntegrationErrorMessage
} from "../base-integration-service.js";
import {
  createDefaultSlackConfig,
  loadSlackConfig,
  maskSlackConfig,
  mergeSlackConfig,
  saveSlackConfig
} from "./slack-config.js";
import { SlackWebApiClient, testSlackAppToken } from "./slack-client.js";
import { SlackDeliveryBridge } from "./slack-delivery.js";
import { SlackInboundRouter } from "./slack-router.js";
import { SlackSocketModeBridge } from "./slack-socket.js";
import {
  SlackStatusTracker,
  type SlackStatusEvent,
  type SlackStatusUpdate
} from "./slack-status.js";
import type {
  SlackChannelDescriptor,
  SlackConnectionTestResult,
  SlackIntegrationConfig,
  SlackIntegrationConfigPublic
} from "./slack-types.js";

export class SlackIntegrationService extends BaseIntegrationService<
  SlackIntegrationConfig,
  SlackIntegrationConfigPublic,
  SlackStatusEvent,
  SlackStatusUpdate
> {
  private slackClient: SlackWebApiClient | null = null;
  private inboundRouter: SlackInboundRouter | null = null;
  private socketBridge: SlackSocketModeBridge | null = null;
  private readonly deliveryBridge: SlackDeliveryBridge;

  private botUserId: string | undefined;
  private teamId: string | undefined;

  constructor(options: { swarmManager: SwarmManager; managerId: string }) {
    const managerId = normalizeManagerId(options.managerId);
    const defaultConfig = createDefaultSlackConfig(managerId);
    const statusTracker = new SlackStatusTracker({
      managerId,
      integrationProfileId: defaultConfig.profileId,
      state: "disabled",
      enabled: false,
      message: "Slack integration disabled"
    });

    super({
      swarmManager: options.swarmManager,
      managerId,
      defaultConfig,
      statusTracker,
      statusEventName: "slack_status",
      loadConfig: loadSlackConfig,
      saveConfig: saveSlackConfig,
      mergeConfig: mergeSlackConfig,
      maskConfig: maskSlackConfig
    });

    this.deliveryBridge = new SlackDeliveryBridge({
      swarmManager: this.swarmManager,
      managerId: this.managerId,
      getConfig: () => this.config,
      getProfileId: () => this.config.profileId,
      getSlackClient: () => this.slackClient,
      onError: (message, error) => {
        this.updateStatus({
          managerId: this.managerId,
          integrationProfileId: this.config.profileId,
          state: "error",
          enabled: this.config.enabled,
          message: `${message}: ${toIntegrationErrorMessage(error)}`,
          teamId: this.teamId,
          botUserId: this.botUserId
        });
      }
    });
  }

  async testConnection(patch?: unknown): Promise<SlackConnectionTestResult> {
    const effectiveConfig = patch ? mergeSlackConfig(this.config, patch) : this.config;

    const appToken = effectiveConfig.appToken.trim();
    const botToken = effectiveConfig.botToken.trim();

    if (!appToken) {
      throw new Error("Slack app token is required");
    }

    if (!botToken) {
      throw new Error("Slack bot token is required");
    }

    const client = new SlackWebApiClient(botToken);
    const auth = await client.testAuth();
    await testSlackAppToken(appToken);

    return {
      ok: true,
      teamId: auth.teamId,
      teamName: auth.teamName,
      botUserId: auth.botUserId
    };
  }

  async listChannels(options?: { includePrivateChannels?: boolean }): Promise<SlackChannelDescriptor[]> {
    const includePrivateChannels =
      options?.includePrivateChannels ?? this.config.listen.includePrivateChannels;
    const token = this.config.botToken.trim();

    if (!token) {
      throw new Error("Slack bot token is required before listing channels");
    }

    const client = this.slackClient ?? new SlackWebApiClient(token);
    return client.listChannels({ includePrivateChannels });
  }

  protected async applyConfig(): Promise<void> {
    await this.stopRuntime();

    this.slackClient = null;
    this.inboundRouter = null;
    this.botUserId = undefined;
    this.teamId = undefined;

    if (!this.config.enabled) {
      this.updateStatus({
        managerId: this.managerId,
        integrationProfileId: this.config.profileId,
        state: "disabled",
        enabled: false,
        message: "Slack integration disabled",
        teamId: undefined,
        botUserId: undefined
      });
      return;
    }

    const appToken = this.config.appToken.trim();
    const botToken = this.config.botToken.trim();

    if (!appToken || !botToken) {
      this.updateStatus({
        managerId: this.managerId,
        integrationProfileId: this.config.profileId,
        state: "error",
        enabled: true,
        message: "Slack app token and bot token are required",
        teamId: undefined,
        botUserId: undefined
      });
      return;
    }

    try {
      const slackClient = new SlackWebApiClient(botToken);
      const auth = await slackClient.testAuth();

      this.slackClient = slackClient;
      this.botUserId = auth.botUserId;
      this.teamId = auth.teamId;

      this.inboundRouter = new SlackInboundRouter({
        swarmManager: this.swarmManager,
        managerId: this.managerId,
        integrationProfileId: this.config.profileId,
        slackClient,
        getConfig: () => this.config,
        getBotUserId: () => this.botUserId,
        onError: (message, error) => {
          this.updateStatus({
            managerId: this.managerId,
            integrationProfileId: this.config.profileId,
            state: "error",
            enabled: this.config.enabled,
            message: `${message}: ${toIntegrationErrorMessage(error)}`,
            teamId: this.teamId,
            botUserId: this.botUserId
          });
        }
      });

      const socketBridge = new SlackSocketModeBridge({
        appToken,
        onEnvelope: async (envelope) => {
          await this.inboundRouter?.handleEnvelope(envelope);
        },
        onStateChange: (state, message) => {
          this.updateStatus({
            managerId: this.managerId,
            integrationProfileId: this.config.profileId,
            state,
            enabled: this.config.enabled,
            message,
            teamId: this.teamId,
            botUserId: this.botUserId
          });
        }
      });

      this.socketBridge = socketBridge;
      await socketBridge.start();

      this.updateStatus({
        managerId: this.managerId,
        integrationProfileId: this.config.profileId,
        state: "connected",
        enabled: true,
        message: "Slack connected",
        teamId: this.teamId,
        botUserId: this.botUserId
      });
    } catch (error) {
      await this.stopRuntime();
      this.updateStatus({
        managerId: this.managerId,
        integrationProfileId: this.config.profileId,
        state: "error",
        enabled: true,
        message: `Slack startup failed: ${toIntegrationErrorMessage(error)}`,
        teamId: this.teamId,
        botUserId: this.botUserId
      });
    }
  }

  protected async stopRuntime(): Promise<void> {
    await this.stopSocket();
  }

  protected startDeliveryBridge(): void {
    this.deliveryBridge.start();
  }

  protected stopDeliveryBridge(): void {
    this.deliveryBridge.stop();
  }

  protected buildLoadConfigErrorStatus(error: unknown): SlackStatusUpdate {
    return {
      managerId: this.managerId,
      integrationProfileId: this.config.profileId,
      state: "error",
      enabled: false,
      message: `Failed to load Slack config: ${toIntegrationErrorMessage(error)}`,
      teamId: undefined,
      botUserId: undefined
    };
  }

  protected buildStoppedStatus(): SlackStatusUpdate {
    return {
      managerId: this.managerId,
      integrationProfileId: this.config.profileId,
      state: this.config.enabled ? "disconnected" : "disabled",
      enabled: this.config.enabled,
      message: this.config.enabled ? "Slack integration stopped" : "Slack integration disabled",
      teamId: this.teamId,
      botUserId: this.botUserId
    };
  }

  private async stopSocket(): Promise<void> {
    if (!this.socketBridge) {
      return;
    }

    const existing = this.socketBridge;
    this.socketBridge = null;

    try {
      await existing.stop();
    } catch {
      // Ignore socket shutdown errors.
    }
  }
}
