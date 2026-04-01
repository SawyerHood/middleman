export function shouldEmitRawBackendEvents(
  backendConfig: Record<string, unknown> | undefined,
): boolean {
  if (readBoolean(backendConfig?.experimentalRawEvents) === true) {
    return true;
  }

  const envValue =
    process.env.MIDDLEMAN_DEBUG_RAW_BACKEND_EVENTS ?? process.env.SWARMD_DEBUG_RAW_EVENTS;
  if (!envValue) {
    return false;
  }

  const normalized = envValue.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
