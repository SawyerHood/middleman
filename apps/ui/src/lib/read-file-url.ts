import { resolveApiEndpoint } from "./api-endpoint";

const FILE_PROTOCOL = "file:";
const WINDOWS_DRIVE_PATH_PATTERN = /^\/[A-Za-z]:\//;

export function resolveReadFileEndpoint(wsUrl?: string): string {
  return resolveApiEndpoint(wsUrl, "/api/read-file");
}

export function resolveReadFileUrl(wsUrl: string | undefined, path: string): string {
  const endpoint = resolveReadFileEndpoint(wsUrl);
  const separator = endpoint.includes("?") ? "&" : "?";
  return `${endpoint}${separator}path=${encodeURIComponent(path)}`;
}

export function extractLocalFilePath(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== FILE_PROTOCOL) {
      return null;
    }

    if (parsed.host && parsed.host !== "localhost") {
      return null;
    }

    const decodedPath = decodeURIComponent(parsed.pathname);
    if (!decodedPath) {
      return null;
    }

    if (WINDOWS_DRIVE_PATH_PATTERN.test(decodedPath)) {
      return decodedPath.slice(1);
    }

    return decodedPath;
  } catch {
    return null;
  }
}

export function isLocalFileUrl(url: string): boolean {
  return extractLocalFilePath(url) !== null;
}

export function rewriteLocalFileUrl(wsUrl: string | undefined, url: string): string | null {
  const localPath = extractLocalFilePath(url);
  if (!localPath) {
    return null;
  }

  return resolveReadFileUrl(wsUrl, localPath);
}
