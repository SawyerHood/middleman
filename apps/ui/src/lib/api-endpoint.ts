export function resolveApiEndpoint(wsUrl: string | undefined, path: string): string {
  if (!wsUrl) {
    return path;
  }

  try {
    const parsed = new URL(wsUrl);
    parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
    parsed.pathname = path;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return path;
  }
}
