import { CronExpressionParser } from "cron-parser";

export function normalizeScheduleText(value: string | undefined, fieldName: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} is required.`);
  }

  return trimmed;
}

export function normalizeOptionalScheduleText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeScheduleTimezone(timezone: string | undefined): string {
  const normalized = timezone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  if (!isValidTimezone(normalized)) {
    throw new Error(`Invalid timezone: ${normalized}`);
  }

  return normalized;
}

export function resolveScheduleName(input: { name?: string; description?: string; message: string }): string {
  const explicitName = normalizeOptionalScheduleText(input.name);
  if (explicitName) {
    return explicitName;
  }

  const description = normalizeOptionalScheduleText(input.description);
  if (description) {
    return description;
  }

  const firstLine = input.message
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  const fallback = firstLine || "Scheduled task";
  return fallback.length <= 80 ? fallback : `${fallback.slice(0, 77)}...`;
}

export function computeNextFireAt(cron: string, timezone: string, afterDate: Date): string {
  const iterator = CronExpressionParser.parse(cron, {
    currentDate: afterDate,
    tz: timezone,
  });
  return iterator.next().toDate().toISOString();
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
