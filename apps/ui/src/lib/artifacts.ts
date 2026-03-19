export interface ArtifactReference {
  path: string;
  fileName: string;
  href: string;
  title?: string;
}

export interface ArtifactObsidianTarget {
  vault: string;
  file: string;
}

export interface ArtifactEditorTargets {
  notesPath?: string;
  obsidian?: ArtifactObsidianTarget;
}

const ARTIFACT_SHORTCODE_PATTERN = /\[artifact:([^\]\n]+)\]/gi;
const SWARM_FILE_PREFIX = "swarm-file://";
const VSCODE_FILE_LINK_PATTERN = /^vscode(?:-insiders)?:\/\/file\/+/i;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[a-zA-Z]:[\\/]/;
const URL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\d+\-.]*:/;
const ARTIFACT_LINK_TEXT_PATTERN = /^artifact:/i;
const LOCAL_FILE_PREFIX_PATTERN = /^(\/|\.\/|\.\.\/)/;
const LIKELY_DOMAIN_PATH_PATTERN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+\//i;

interface ParseArtifactReferenceOptions {
  title?: string | null;
}

export function normalizeArtifactShortcodes(content: string): string {
  return content.replace(ARTIFACT_SHORTCODE_PATTERN, (match, rawPath) => {
    const normalizedPath = String(rawPath).trim();
    if (!normalizedPath) {
      return match;
    }

    return `[artifact:${normalizedPath}](${toSwarmFileHref(normalizedPath)})`;
  });
}

export function parseArtifactReference(
  href: string | undefined,
  options?: ParseArtifactReferenceOptions,
): ArtifactReference | null {
  if (!href) {
    return null;
  }

  const trimmed = href.trim();
  if (!trimmed) {
    return null;
  }

  const title = normalizeArtifactTitle(options?.title);
  const lowered = trimmed.toLowerCase();

  if (lowered.startsWith(SWARM_FILE_PREFIX)) {
    const rawPath = trimmed.slice(SWARM_FILE_PREFIX.length).split(/[?#]/, 1)[0];
    const decodedPath = safeDecodeURIComponent(rawPath);
    if (!decodedPath) {
      return null;
    }

    return createArtifactReference(decodedPath, trimmed, title);
  }

  if (VSCODE_FILE_LINK_PATTERN.test(trimmed)) {
    const rawPath = trimmed.replace(VSCODE_FILE_LINK_PATTERN, "").split(/[?#]/, 1)[0];
    const decodedPath = safeDecodeURIComponent(rawPath);
    if (!decodedPath) {
      return null;
    }

    const normalizedPath =
      decodedPath.startsWith("/") || WINDOWS_ABSOLUTE_PATH_PATTERN.test(decodedPath)
        ? decodedPath
        : `/${decodedPath}`;

    return createArtifactReference(normalizedPath, trimmed, title);
  }

  if (!isLocalFilePath(trimmed)) {
    return null;
  }

  const rawPath = trimmed.split(/[?#]/, 1)[0];
  const decodedPath = safeDecodeURIComponent(rawPath);
  if (!decodedPath) {
    return null;
  }

  return createArtifactReference(decodedPath, trimmed, title);
}

export function toSwarmFileHref(path: string): string {
  const normalizedPath = path.trim();
  if (!normalizedPath) {
    return SWARM_FILE_PREFIX;
  }

  return `${SWARM_FILE_PREFIX}${encodeURI(normalizedPath)}`;
}

export function toVscodeHref(path: string): string {
  return toEditorProtocolHref("vscode", path);
}

export function toVscodeInsidersHref(path: string): string {
  return toEditorProtocolHref("vscode-insiders", path);
}

export function toCursorHref(path: string): string {
  return toEditorProtocolHref("cursor", path);
}

export function toObsidianHref(target: ArtifactObsidianTarget): string {
  const vault = target.vault.trim();
  const file = target.file.trim();
  if (!vault || !file) {
    return "obsidian://open";
  }

  return `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(file)}`;
}

function toEditorProtocolHref(protocol: string, path: string): string {
  const normalizedPath = path.trim();
  if (!normalizedPath) {
    return `${protocol}://file`;
  }

  const prefixedPath =
    normalizedPath.startsWith("/") || WINDOWS_ABSOLUTE_PATH_PATTERN.test(normalizedPath)
      ? normalizedPath
      : `/${normalizedPath}`;

  return `${protocol}://file${encodeURI(prefixedPath)}`;
}

function createArtifactReference(path: string, href: string, title?: string): ArtifactReference {
  const trimmedPath = path.trim();

  return {
    path: trimmedPath,
    fileName: fileNameFromPath(trimmedPath),
    href,
    ...(title ? { title } : {}),
  };
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function fileNameFromPath(path: string): string {
  const withoutTrailingSlash = path.replace(/[\\/]+$/, "");
  if (!withoutTrailingSlash) {
    return path;
  }

  const segments = withoutTrailingSlash.split(/[\\/]/);
  return segments[segments.length - 1] || withoutTrailingSlash;
}

function normalizeArtifactTitle(title: string | null | undefined): string | undefined {
  const trimmedTitle = title?.trim();
  if (!trimmedTitle) {
    return undefined;
  }

  if (ARTIFACT_LINK_TEXT_PATTERN.test(trimmedTitle)) {
    return undefined;
  }

  return trimmedTitle;
}

function isLocalFilePath(href: string): boolean {
  const rawPath = href.split(/[?#]/, 1)[0]?.trim();
  if (!rawPath) {
    return false;
  }

  if (rawPath.startsWith("//")) {
    return false;
  }

  if (URL_SCHEME_PATTERN.test(rawPath) && !WINDOWS_ABSOLUTE_PATH_PATTERN.test(rawPath)) {
    return false;
  }

  if (!hasFileExtension(rawPath)) {
    return false;
  }

  if (LOCAL_FILE_PREFIX_PATTERN.test(rawPath) || WINDOWS_ABSOLUTE_PATH_PATTERN.test(rawPath)) {
    return true;
  }

  if (LIKELY_DOMAIN_PATH_PATTERN.test(rawPath)) {
    return false;
  }

  return rawPath.includes("/") || rawPath.includes("\\");
}

function hasFileExtension(path: string): boolean {
  const fileName = fileNameFromPath(path);
  const lastDotIndex = fileName.lastIndexOf(".");
  if (lastDotIndex < 0 || lastDotIndex === fileName.length - 1) {
    return false;
  }

  const extension = fileName.slice(lastDotIndex + 1);
  return /^[a-z0-9][a-z0-9_-]*$/i.test(extension);
}
