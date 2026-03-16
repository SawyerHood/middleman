import { EventEmitter } from "node:events";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import { normalizeManagerId } from "../utils/normalize.js";
import { SlackIntegrationService } from "./slack/slack-integration.js";
import type { SlackStatusEvent } from "./slack/slack-status.js";
import type { SlackChannelDescriptor, SlackConnectionTestResult, SlackIntegrationConfigPublic } from "./slack/slack-types.js";
import { TelegramIntegrationService } from "./telegram/telegram-integration.js";
import type { TelegramStatusEvent } from "./telegram/telegram-status.js";
import type {
  TelegramConnectionTestResult,
  TelegramIntegrationConfigPublic
} from "./telegram/telegram-types.js";

type IntegrationProvider = "slack" | "telegram";

export class IntegrationRegistryService extends EventEmitter {
  private readonly swarmManager: SwarmManager;
  private readonly defaultManagerId: string | undefined;
  private readonly slackProfiles = new Map<string, SlackIntegrationService>();
  private readonly telegramProfiles = new Map<string, TelegramIntegrationService>();
  private started = false;
  private lifecycle: Promise<void> = Promise.resolve();

  private readonly forwardSlackStatus = (event: SlackStatusEvent): void => {
    this.emit("slack_status", event);
  };

  private readonly forwardTelegramStatus = (event: TelegramStatusEvent): void => {
    this.emit("telegram_status", event);
  };

  constructor(options: {
    swarmManager: SwarmManager;
    defaultManagerId?: string;
  }) {
    super();
    this.swarmManager = options.swarmManager;
    this.defaultManagerId =
      normalizeOptionalManagerId(options.defaultManagerId) ??
      normalizeOptionalManagerId(this.swarmManager.getConfig().managerId);
  }

  async start(): Promise<void> {
    return this.runExclusive(async () => {
      if (this.started) {
        return;
      }

      this.started = true;

      const managerIds = await this.discoverKnownManagerIds();
      for (const managerId of managerIds) {
        await this.startProfileInternal(managerId, "slack");
        await this.startProfileInternal(managerId, "telegram");
      }
    });
  }

  async stop(): Promise<void> {
    return this.runExclusive(async () => {
      if (!this.started) {
        return;
      }

      for (const profile of this.slackProfiles.values()) {
        await profile.stop();
        profile.off("slack_status", this.forwardSlackStatus);
      }

      for (const profile of this.telegramProfiles.values()) {
        await profile.stop();
        profile.off("telegram_status", this.forwardTelegramStatus);
      }

      this.slackProfiles.clear();
      this.telegramProfiles.clear();
      this.started = false;
    });
  }

  async startProfile(managerId: string, provider: IntegrationProvider): Promise<void> {
    return this.runExclusive(async () => {
      this.started = true;
      await this.startProfileInternal(managerId, provider);
    });
  }

  async stopProfile(managerId: string, provider: IntegrationProvider): Promise<void> {
    return this.runExclusive(async () => {
      const normalizedManagerId = normalizeManagerId(managerId);
      if (provider === "slack") {
        await this.stopSlackProfileInternal(normalizedManagerId);
        return;
      }

      await this.stopTelegramProfileInternal(normalizedManagerId);
    });
  }

  async unregisterManager(managerId: string): Promise<void> {
    return this.runExclusive(async () => {
      await this.unregisterManagerInternal(normalizeManagerId(managerId));
    });
  }

  async syncManagers(managerIds: Iterable<string>): Promise<void> {
    return this.runExclusive(async () => {
      this.started = true;

      const normalizedManagerIds = new Set(
        [...managerIds].map((managerId) => normalizeManagerId(managerId)),
      );

      for (const managerId of normalizedManagerIds) {
        await this.startProfileInternal(managerId, "slack");
        await this.startProfileInternal(managerId, "telegram");
      }

      const knownManagerIds = new Set<string>([
        ...this.slackProfiles.keys(),
        ...this.telegramProfiles.keys(),
      ]);

      for (const managerId of knownManagerIds) {
        if (normalizedManagerIds.has(managerId)) {
          continue;
        }

        await this.unregisterManagerInternal(managerId);
      }
    });
  }

  getStatus(managerId: string, provider: "slack"): SlackStatusEvent;
  getStatus(managerId: string, provider: "telegram"): TelegramStatusEvent;
  getStatus(managerId: string, provider: IntegrationProvider): SlackStatusEvent | TelegramStatusEvent {
    const normalizedManagerId = normalizeManagerId(managerId);

    if (provider === "slack") {
      const profile = this.slackProfiles.get(normalizedManagerId);
      if (profile) {
        return profile.getStatus();
      }

      return {
        type: "slack_status",
        managerId: normalizedManagerId,
        integrationProfileId: `slack:${normalizedManagerId}`,
        state: "disabled",
        enabled: false,
        updatedAt: new Date().toISOString(),
        message: "Slack integration disabled"
      };
    }

    const profile = this.telegramProfiles.get(normalizedManagerId);
    if (profile) {
      return profile.getStatus();
    }

    return {
      type: "telegram_status",
      managerId: normalizedManagerId,
      integrationProfileId: `telegram:${normalizedManagerId}`,
      state: "disabled",
      enabled: false,
      updatedAt: new Date().toISOString(),
      message: "Telegram integration disabled"
    };
  }

  async getSlackSnapshot(
    managerId: string
  ): Promise<{ config: SlackIntegrationConfigPublic; status: SlackStatusEvent }> {
    const profile = await this.ensureSlackProfileStarted(managerId);
    return {
      config: profile.getMaskedConfig(),
      status: profile.getStatus()
    };
  }

  async updateSlackConfig(
    managerId: string,
    patch: unknown
  ): Promise<{ config: SlackIntegrationConfigPublic; status: SlackStatusEvent }> {
    const profile = await this.ensureSlackProfileStarted(managerId);
    return profile.updateConfig(patch);
  }

  async disableSlack(
    managerId: string
  ): Promise<{ config: SlackIntegrationConfigPublic; status: SlackStatusEvent }> {
    const profile = await this.ensureSlackProfileStarted(managerId);
    return profile.disable();
  }

  async testSlackConnection(managerId: string, patch?: unknown): Promise<SlackConnectionTestResult> {
    const profile = await this.ensureSlackProfileStarted(managerId);
    return profile.testConnection(patch);
  }

  async listSlackChannels(
    managerId: string,
    options?: { includePrivateChannels?: boolean }
  ): Promise<SlackChannelDescriptor[]> {
    const profile = await this.ensureSlackProfileStarted(managerId);
    return profile.listChannels(options);
  }

  async getTelegramSnapshot(
    managerId: string
  ): Promise<{ config: TelegramIntegrationConfigPublic; status: TelegramStatusEvent }> {
    const profile = await this.ensureTelegramProfileStarted(managerId);
    return {
      config: profile.getMaskedConfig(),
      status: profile.getStatus()
    };
  }

  async updateTelegramConfig(
    managerId: string,
    patch: unknown
  ): Promise<{ config: TelegramIntegrationConfigPublic; status: TelegramStatusEvent }> {
    const profile = await this.ensureTelegramProfileStarted(managerId);
    return profile.updateConfig(patch);
  }

  async disableTelegram(
    managerId: string
  ): Promise<{ config: TelegramIntegrationConfigPublic; status: TelegramStatusEvent }> {
    const profile = await this.ensureTelegramProfileStarted(managerId);
    return profile.disable();
  }

  async testTelegramConnection(
    managerId: string,
    patch?: unknown
  ): Promise<TelegramConnectionTestResult> {
    const profile = await this.ensureTelegramProfileStarted(managerId);
    return profile.testConnection(patch);
  }

  private async ensureSlackProfileStarted(managerId: string): Promise<SlackIntegrationService> {
    const normalizedManagerId = normalizeManagerId(managerId);
    await this.startProfile(normalizedManagerId, "slack");
    return this.getOrCreateSlackProfile(normalizedManagerId);
  }

  private async ensureTelegramProfileStarted(managerId: string): Promise<TelegramIntegrationService> {
    const normalizedManagerId = normalizeManagerId(managerId);
    await this.startProfile(normalizedManagerId, "telegram");
    return this.getOrCreateTelegramProfile(normalizedManagerId);
  }

  private async startProfileInternal(managerId: string, provider: IntegrationProvider): Promise<void> {
    const normalizedManagerId = normalizeManagerId(managerId);

    if (provider === "slack") {
      const profile = this.getOrCreateSlackProfile(normalizedManagerId);
      await profile.start();
      return;
    }

    const profile = this.getOrCreateTelegramProfile(normalizedManagerId);
    await profile.start();
  }

  private async unregisterManagerInternal(managerId: string): Promise<void> {
    await this.stopSlackProfileInternal(managerId);
    await this.stopTelegramProfileInternal(managerId);
  }

  private async stopSlackProfileInternal(managerId: string): Promise<void> {
    const profile = this.slackProfiles.get(managerId);
    if (!profile) {
      return;
    }

    await profile.stop();
    profile.off("slack_status", this.forwardSlackStatus);
    this.slackProfiles.delete(managerId);
  }

  private async stopTelegramProfileInternal(managerId: string): Promise<void> {
    const profile = this.telegramProfiles.get(managerId);
    if (!profile) {
      return;
    }

    await profile.stop();
    profile.off("telegram_status", this.forwardTelegramStatus);
    this.telegramProfiles.delete(managerId);
  }

  private getOrCreateSlackProfile(managerId: string): SlackIntegrationService {
    const normalizedManagerId = normalizeManagerId(managerId);
    const existing = this.slackProfiles.get(normalizedManagerId);
    if (existing) {
      return existing;
    }

    const profile = new SlackIntegrationService({
      swarmManager: this.swarmManager,
      managerId: normalizedManagerId
    });
    profile.on("slack_status", this.forwardSlackStatus);
    this.slackProfiles.set(normalizedManagerId, profile);
    return profile;
  }

  private getOrCreateTelegramProfile(managerId: string): TelegramIntegrationService {
    const normalizedManagerId = normalizeManagerId(managerId);
    const existing = this.telegramProfiles.get(normalizedManagerId);
    if (existing) {
      return existing;
    }

    const profile = new TelegramIntegrationService({
      swarmManager: this.swarmManager,
      managerId: normalizedManagerId
    });
    profile.on("telegram_status", this.forwardTelegramStatus);
    this.telegramProfiles.set(normalizedManagerId, profile);
    return profile;
  }

  private async discoverKnownManagerIds(): Promise<Set<string>> {
    const managerIds = new Set<string>();
    if (this.defaultManagerId) {
      managerIds.add(this.defaultManagerId);
    }

    for (const descriptor of this.swarmManager.listAgents()) {
      if (descriptor.role !== "manager") {
        continue;
      }

      managerIds.add(descriptor.agentId);
    }

    for (const provider of ["slack", "telegram"] as const) {
      for (const profile of this.swarmManager.listIntegrationProfiles(provider)) {
        managerIds.add(profile.managerId);
      }
    }

    return managerIds;
  }

  private async runExclusive<T>(action: () => Promise<T>): Promise<T> {
    const next = this.lifecycle.then(action, action);
    this.lifecycle = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}

function normalizeOptionalManagerId(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
