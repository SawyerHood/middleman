import type { SwarmManager } from "../../swarm/swarm-manager.js";
import { normalizeManagerId } from "../../utils/normalize.js";
import type { SlackIntegrationConfig, SlackIntegrationConfigPublic } from "./slack-types.js";

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const MIN_FILE_BYTES = 1024;
const MAX_FILE_BYTES = 100 * 1024 * 1024;

export function buildSlackProfileId(managerId: string): string {
  return `slack:${normalizeManagerId(managerId)}`;
}

export function createDefaultSlackConfig(managerId: string): SlackIntegrationConfig {
  return {
    profileId: buildSlackProfileId(managerId),
    enabled: false,
    mode: "socket",
    appToken: "",
    botToken: "",
    listen: {
      dm: true,
      channelIds: [],
      includePrivateChannels: false
    },
    response: {
      respondInThread: true,
      replyBroadcast: false,
      wakeWords: ["swarm", "bot"]
    },
    attachments: {
      maxFileBytes: DEFAULT_MAX_FILE_BYTES,
      allowImages: true,
      allowText: true,
      allowBinary: false
    }
  };
}

export async function loadSlackConfig(options: {
  swarmManager: SwarmManager;
  managerId: string;
}): Promise<SlackIntegrationConfig> {
  const profile = options.swarmManager.getIntegrationProfile(options.managerId, "slack");
  if (!profile) {
    return createDefaultSlackConfig(options.managerId);
  }

  return parseSlackConfig(profile.config);
}

export async function saveSlackConfig(options: {
  swarmManager: SwarmManager;
  managerId: string;
  config: SlackIntegrationConfig;
}): Promise<void> {
  options.swarmManager.upsertIntegrationProfile({
    id: options.config.profileId,
    managerId: normalizeManagerId(options.managerId),
    provider: "slack",
    config: options.config as unknown as Record<string, unknown>,
    updatedAt: new Date().toISOString(),
  });
}

export function mergeSlackConfig(
  base: SlackIntegrationConfig,
  patch: unknown
): SlackIntegrationConfig {
  const root = asRecord(patch);
  const listen = asRecord(root.listen);
  const response = asRecord(root.response);
  const attachments = asRecord(root.attachments);

  return {
    profileId: normalizeProfileId(root.profileId, base.profileId),
    enabled: normalizeBoolean(root.enabled, base.enabled),
    mode: "socket",
    appToken: normalizeToken(root.appToken, base.appToken),
    botToken: normalizeToken(root.botToken, base.botToken),
    listen: {
      dm: normalizeBoolean(listen.dm, base.listen.dm),
      channelIds: normalizeStringArray(listen.channelIds, base.listen.channelIds),
      includePrivateChannels: normalizeBoolean(
        listen.includePrivateChannels,
        base.listen.includePrivateChannels
      )
    },
    response: {
      respondInThread: normalizeBoolean(response.respondInThread, base.response.respondInThread),
      replyBroadcast: normalizeBoolean(response.replyBroadcast, base.response.replyBroadcast),
      wakeWords: normalizeWakeWords(response.wakeWords, base.response.wakeWords)
    },
    attachments: {
      maxFileBytes: normalizeFileSize(attachments.maxFileBytes, base.attachments.maxFileBytes),
      allowImages: normalizeBoolean(attachments.allowImages, base.attachments.allowImages),
      allowText: normalizeBoolean(attachments.allowText, base.attachments.allowText),
      allowBinary: normalizeBoolean(attachments.allowBinary, base.attachments.allowBinary)
    }
  };
}

export function maskSlackConfig(config: SlackIntegrationConfig): SlackIntegrationConfigPublic {
  return {
    profileId: config.profileId,
    enabled: config.enabled,
    mode: config.mode,
    appToken: config.appToken ? maskToken(config.appToken) : null,
    botToken: config.botToken ? maskToken(config.botToken) : null,
    hasAppToken: config.appToken.trim().length > 0,
    hasBotToken: config.botToken.trim().length > 0,
    listen: {
      dm: config.listen.dm,
      channelIds: [...config.listen.channelIds],
      includePrivateChannels: config.listen.includePrivateChannels
    },
    response: {
      respondInThread: config.response.respondInThread,
      replyBroadcast: config.response.replyBroadcast,
      wakeWords: [...config.response.wakeWords]
    },
    attachments: {
      maxFileBytes: config.attachments.maxFileBytes,
      allowImages: config.attachments.allowImages,
      allowText: config.attachments.allowText,
      allowBinary: config.attachments.allowBinary
    }
  };
}

function parseSlackConfig(value: unknown): SlackIntegrationConfig {
  const root = requireRecord(value, "Slack config must be an object");
  const listen = requireRecord(root.listen, "Slack config.listen must be an object");
  const response = requireRecord(root.response, "Slack config.response must be an object");
  const attachments = requireRecord(root.attachments, "Slack config.attachments must be an object");

  return {
    profileId: requireNonEmptyString(root.profileId, "Slack config.profileId must be a non-empty string"),
    enabled: requireBoolean(root.enabled, "Slack config.enabled must be a boolean"),
    mode: requireMode(root.mode),
    appToken: requireString(root.appToken, "Slack config.appToken must be a string"),
    botToken: requireString(root.botToken, "Slack config.botToken must be a string"),
    listen: {
      dm: requireBoolean(listen.dm, "Slack config.listen.dm must be a boolean"),
      channelIds: requireStringArray(
        listen.channelIds,
        "Slack config.listen.channelIds must be an array of strings"
      ),
      includePrivateChannels: requireBoolean(
        listen.includePrivateChannels,
        "Slack config.listen.includePrivateChannels must be a boolean"
      )
    },
    response: {
      respondInThread: requireBoolean(
        response.respondInThread,
        "Slack config.response.respondInThread must be a boolean"
      ),
      replyBroadcast: requireBoolean(
        response.replyBroadcast,
        "Slack config.response.replyBroadcast must be a boolean"
      ),
      wakeWords: normalizeWakeWords(
        requireStringArray(
          response.wakeWords,
          "Slack config.response.wakeWords must be an array of strings"
        ),
        []
      )
    },
    attachments: {
      maxFileBytes: normalizeFileSize(
        requireNumber(
          attachments.maxFileBytes,
          "Slack config.attachments.maxFileBytes must be a number"
        ),
        DEFAULT_MAX_FILE_BYTES
      ),
      allowImages: requireBoolean(
        attachments.allowImages,
        "Slack config.attachments.allowImages must be a boolean"
      ),
      allowText: requireBoolean(
        attachments.allowText,
        "Slack config.attachments.allowText must be a boolean"
      ),
      allowBinary: requireBoolean(
        attachments.allowBinary,
        "Slack config.attachments.allowBinary must be a boolean"
      )
    }
  };
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

function normalizeWakeWords(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }

    const cleaned = entry.trim().toLowerCase();
    if (!cleaned || seen.has(cleaned)) {
      continue;
    }

    seen.add(cleaned);
    normalized.push(cleaned);
  }

  return normalized;
}

function normalizeFileSize(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  const rounded = Math.round(value);
  if (rounded < MIN_FILE_BYTES) {
    return MIN_FILE_BYTES;
  }

  if (rounded > MAX_FILE_BYTES) {
    return MAX_FILE_BYTES;
  }

  return rounded;
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

function requireMode(value: unknown): "socket" {
  if (value !== "socket") {
    throw new Error('Slack config.mode must be "socket"');
  }

  return value;
}
