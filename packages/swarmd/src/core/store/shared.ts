import type { SessionContextUsage, SessionErrorInfo } from "../types/index.js";

export function nowTimestamp(): string {
  return new Date().toISOString();
}

export function parseJsonValue(value: string | null, fieldName: string): unknown | null {
  if (value === null) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(
      `Failed to parse ${fieldName}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function parseJsonObject(value: string | null, fieldName: string): Record<string, unknown> {
  const parsed = parseJsonValue(value, fieldName);

  if (parsed === null) {
    return {};
  }

  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected ${fieldName} to contain a JSON object`);
  }

  return parsed as Record<string, unknown>;
}

export function parseSessionError(value: string | null): SessionErrorInfo | null {
  const parsed = parseJsonValue(value, "last_error_json");

  if (parsed === null) {
    return null;
  }

  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected last_error_json to contain a JSON object");
  }

  const errorInfo = parsed as Record<string, unknown>;

  if (
    typeof errorInfo.code !== "string" ||
    typeof errorInfo.message !== "string" ||
    typeof errorInfo.retryable !== "boolean"
  ) {
    throw new Error("Expected last_error_json to match SessionErrorInfo");
  }

  const details = errorInfo.details;

  if (details !== undefined && (details === null || typeof details !== "object" || Array.isArray(details))) {
    throw new Error("Expected last_error_json.details to contain a JSON object");
  }

  return {
    code: errorInfo.code,
    message: errorInfo.message,
    retryable: errorInfo.retryable,
    details: details as Record<string, unknown> | undefined
  };
}

export function parseSessionContextUsage(value: string | null): SessionContextUsage | null {
  const parsed = parseJsonValue(value, "context_usage_json");

  if (parsed === null) {
    return null;
  }

  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected context_usage_json to contain a JSON object");
  }

  const usage = parsed as Record<string, unknown>;
  const tokens = usage.tokens;
  const contextWindow = usage.contextWindow;
  const percent = usage.percent;

  if (
    typeof tokens !== "number" ||
    !Number.isFinite(tokens) ||
    tokens < 0 ||
    typeof contextWindow !== "number" ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0 ||
    typeof percent !== "number" ||
    !Number.isFinite(percent)
  ) {
    throw new Error("Expected context_usage_json to match SessionContextUsage");
  }

  return {
    tokens: Math.round(tokens),
    contextWindow: Math.max(1, Math.round(contextWindow)),
    percent: Math.max(0, Math.min(100, percent)),
  };
}

export function serializeJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}
