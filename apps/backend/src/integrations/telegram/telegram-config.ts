import type { SwarmManager } from "../../swarm/swarm-manager.js";
import { normalizeManagerId } from "../../utils/normalize.js";
import type {
  TelegramIntegrationConfig,
  TelegramIntegrationConfigPublic,
  TelegramParseMode
} from "./telegram-types.js";

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const MIN_FILE_BYTES = 1024;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MIN_POLL_TIMEOUT_SECONDS = 0;
const MAX_POLL_TIMEOUT_SECONDS = 60;
const MIN_POLL_LIMIT = 1;
const MAX_POLL_LIMIT = 100;

export function buildTelegramProfileId(managerId: string): string {
  return `telegram:${normalizeManagerId(managerId)}`;
}

export function createDefaultTelegramConfig(managerId: string): TelegramIntegrationConfig {
  return {
    profileId: buildTelegramProfileId(managerId),
    enabled: false,
    mode: "polling",
    botToken: "",
    allowedUserIds: [],
    polling: {
      timeoutSeconds: 25,
      limit: 100,
      dropPendingUpdatesOnStart: true
    },
    delivery: {
      parseMode: "HTML",
      disableLinkPreview: true,
      replyToInboundMessageByDefault: false
    },
    attachments: {
      maxFileBytes: DEFAULT_MAX_FILE_BYTES,
      allowImages: true,
      allowText: true,
      allowBinary: false
    }
  };
}

export async function loadTelegramConfig(options: {
  swarmManager: SwarmManager;
  managerId: string;
}): Promise<TelegramIntegrationConfig> {
  const profile = options.swarmManager.getIntegrationProfile(options.managerId, "telegram");
  if (!profile) {
    return createDefaultTelegramConfig(options.managerId);
  }

  return parseTelegramConfig(profile.config);
}

export async function saveTelegramConfig(options: {
  swarmManager: SwarmManager;
  managerId: string;
  config: TelegramIntegrationConfig;
}): Promise<void> {
  options.swarmManager.upsertIntegrationProfile({
    id: options.config.profileId,
    managerId: normalizeManagerId(options.managerId),
    provider: "telegram",
    config: options.config as unknown as Record<string, unknown>,
    updatedAt: new Date().toISOString(),
  });
}

export function mergeTelegramConfig(
  base: TelegramIntegrationConfig,
  patch: unknown
): TelegramIntegrationConfig {
  const root = asRecord(patch);
  const polling = asRecord(root.polling);
  const delivery = asRecord(root.delivery);
  const attachments = asRecord(root.attachments);

  return {
    profileId: normalizeProfileId(root.profileId, base.profileId),
    enabled: normalizeBoolean(root.enabled, base.enabled),
    mode: "polling",
    botToken: normalizeToken(root.botToken, base.botToken),
    allowedUserIds: normalizeStringArray(root.allowedUserIds, base.allowedUserIds),
    polling: {
      timeoutSeconds: normalizeInteger(
        polling.timeoutSeconds,
        base.polling.timeoutSeconds,
        MIN_POLL_TIMEOUT_SECONDS,
        MAX_POLL_TIMEOUT_SECONDS
      ),
      limit: normalizeInteger(polling.limit, base.polling.limit, MIN_POLL_LIMIT, MAX_POLL_LIMIT),
      dropPendingUpdatesOnStart: normalizeBoolean(
        polling.dropPendingUpdatesOnStart,
        base.polling.dropPendingUpdatesOnStart
      )
    },
    delivery: {
      parseMode: normalizeParseMode(delivery.parseMode, base.delivery.parseMode),
      disableLinkPreview: normalizeBoolean(
        delivery.disableLinkPreview,
        base.delivery.disableLinkPreview
      ),
      replyToInboundMessageByDefault: normalizeBoolean(
        delivery.replyToInboundMessageByDefault,
        base.delivery.replyToInboundMessageByDefault
      )
    },
    attachments: {
      maxFileBytes: normalizeFileSize(attachments.maxFileBytes, base.attachments.maxFileBytes),
      allowImages: normalizeBoolean(attachments.allowImages, base.attachments.allowImages),
      allowText: normalizeBoolean(attachments.allowText, base.attachments.allowText),
      allowBinary: normalizeBoolean(attachments.allowBinary, base.attachments.allowBinary)
    }
  };
}

export function maskTelegramConfig(config: TelegramIntegrationConfig): TelegramIntegrationConfigPublic {
  return {
    profileId: config.profileId,
    enabled: config.enabled,
    mode: config.mode,
    botToken: config.botToken ? maskToken(config.botToken) : null,
    hasBotToken: config.botToken.trim().length > 0,
    allowedUserIds: [...config.allowedUserIds],
    polling: {
      timeoutSeconds: config.polling.timeoutSeconds,
      limit: config.polling.limit,
      dropPendingUpdatesOnStart: config.polling.dropPendingUpdatesOnStart
    },
    delivery: {
      parseMode: config.delivery.parseMode,
      disableLinkPreview: config.delivery.disableLinkPreview,
      replyToInboundMessageByDefault: config.delivery.replyToInboundMessageByDefault
    },
    attachments: {
      maxFileBytes: config.attachments.maxFileBytes,
      allowImages: config.attachments.allowImages,
      allowText: config.attachments.allowText,
      allowBinary: config.attachments.allowBinary
    }
  };
}

function parseTelegramConfig(value: unknown): TelegramIntegrationConfig {
  const root = requireRecord(value, "Telegram config must be an object");
  const polling = requireRecord(root.polling, "Telegram config.polling must be an object");
  const delivery = requireRecord(root.delivery, "Telegram config.delivery must be an object");
  const attachments = requireRecord(root.attachments, "Telegram config.attachments must be an object");

  return {
    profileId: requireNonEmptyString(
      root.profileId,
      "Telegram config.profileId must be a non-empty string"
    ),
    enabled: requireBoolean(root.enabled, "Telegram config.enabled must be a boolean"),
    mode: requireConnectionMode(root.mode),
    botToken: requireString(root.botToken, "Telegram config.botToken must be a string"),
    allowedUserIds: requireStringArray(
      root.allowedUserIds,
      "Telegram config.allowedUserIds must be an array of strings"
    ),
    polling: {
      timeoutSeconds: normalizeInteger(
        requireNumber(
          polling.timeoutSeconds,
          "Telegram config.polling.timeoutSeconds must be a number"
        ),
        25,
        MIN_POLL_TIMEOUT_SECONDS,
        MAX_POLL_TIMEOUT_SECONDS
      ),
      limit: normalizeInteger(
        requireNumber(polling.limit, "Telegram config.polling.limit must be a number"),
        100,
        MIN_POLL_LIMIT,
        MAX_POLL_LIMIT
      ),
      dropPendingUpdatesOnStart: requireBoolean(
        polling.dropPendingUpdatesOnStart,
        "Telegram config.polling.dropPendingUpdatesOnStart must be a boolean"
      )
    },
    delivery: {
      parseMode: requireParseMode(delivery.parseMode),
      disableLinkPreview: requireBoolean(
        delivery.disableLinkPreview,
        "Telegram config.delivery.disableLinkPreview must be a boolean"
      ),
      replyToInboundMessageByDefault: requireBoolean(
        delivery.replyToInboundMessageByDefault,
        "Telegram config.delivery.replyToInboundMessageByDefault must be a boolean"
      )
    },
    attachments: {
      maxFileBytes: normalizeFileSize(
        requireNumber(
          attachments.maxFileBytes,
          "Telegram config.attachments.maxFileBytes must be a number"
        ),
        DEFAULT_MAX_FILE_BYTES
      ),
      allowImages: requireBoolean(
        attachments.allowImages,
        "Telegram config.attachments.allowImages must be a boolean"
      ),
      allowText: requireBoolean(
        attachments.allowText,
        "Telegram config.attachments.allowText must be a boolean"
      ),
      allowBinary: requireBoolean(
        attachments.allowBinary,
        "Telegram config.attachments.allowBinary must be a boolean"
      )
    }
  };
}

function normalizeParseMode(value: unknown, fallback: TelegramParseMode): TelegramParseMode {
  return value === "HTML" ? "HTML" : fallback;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }

    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

function normalizeInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  const rounded = Math.round(value);

  if (rounded < min) {
    return min;
  }

  if (rounded > max) {
    return max;
  }

  return rounded;
}

function normalizeFileSize(value: unknown, fallback: number): number {
  return normalizeInteger(value, fallback, MIN_FILE_BYTES, MAX_FILE_BYTES);
}

function normalizeToken(value: unknown, fallback: string): string {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "string") {
    return fallback;
  }

  return value.trim();
}

function normalizeProfileId(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function maskToken(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "********";
  }

  if (trimmed.length <= 8) {
    return `${trimmed.slice(0, 2)}******`;
  }

  return `${trimmed.slice(0, 5)}…${trimmed.slice(-3)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }

  return value as Record<string, unknown>;
}

function requireBoolean(value: unknown, message: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(message);
  }

  return value;
}

function requireNumber(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(message);
  }

  return value;
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== "string") {
    throw new Error(message);
  }

  return value.trim();
}

function requireNonEmptyString(value: unknown, message: string): string {
  const parsed = requireString(value, message);
  if (!parsed) {
    throw new Error(message);
  }

  return parsed;
}

function requireStringArray(value: unknown, message: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(message);
  }

  return normalizeStringArray(value, []);
}

function requireConnectionMode(value: unknown): "polling" {
  if (value !== "polling") {
    throw new Error('Telegram config.mode must be "polling"');
  }

  return value;
}

function requireParseMode(value: unknown): TelegramParseMode {
  if (value !== "HTML") {
    throw new Error('Telegram config.delivery.parseMode must be "HTML"');
  }

  return value;
}
