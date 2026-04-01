import { readdir, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

const CWD_ERROR_MESSAGES = {
  REQUIRED: "Directory path must be a non-empty string.",
  NOT_FOUND: "Directory does not exist.",
  NOT_DIRECTORY: "Path is not a directory.",
  LIST_FAILED: "Unable to list directories for the requested path.",
} as const;

export type DirectoryValidationErrorCode =
  | "DIRECTORY_REQUIRED"
  | "DIRECTORY_NOT_FOUND"
  | "DIRECTORY_NOT_DIRECTORY"
  | "DIRECTORY_LIST_FAILED";

export class DirectoryValidationError extends Error {
  readonly code: DirectoryValidationErrorCode;

  constructor(code: DirectoryValidationErrorCode, message: string) {
    super(message);
    this.name = "DirectoryValidationError";
    this.code = code;
  }
}

export interface CwdPolicy {
  rootDir: string;
  allowlistRoots: string[];
}

export interface DirectorySummary {
  name: string;
  path: string;
}

export interface DirectoryListingResult {
  requestedPath?: string;
  resolvedPath: string;
  roots: string[];
  directories: DirectorySummary[];
}

export interface DirectoryValidationResult {
  requestedPath: string;
  roots: string[];
  valid: boolean;
  resolvedPath?: string;
  message?: string;
}

export function normalizeAllowlistRoots(roots: string[]): string[] {
  const normalized = new Set<string>();

  for (const root of roots) {
    const trimmed = root.trim();
    if (!trimmed) continue;

    normalized.add(resolve(trimmed));
  }

  return Array.from(normalized).sort((a, b) => a.localeCompare(b));
}

export function resolveDirectoryPath(input: string, rootDir: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new DirectoryValidationError("DIRECTORY_REQUIRED", CWD_ERROR_MESSAGES.REQUIRED);
  }

  return trimmed.startsWith("/") ? resolve(trimmed) : resolve(rootDir, trimmed);
}

export async function validateDirectoryPath(
  input: string,
  policy: Pick<CwdPolicy, "rootDir">,
): Promise<string> {
  const resolved = resolveDirectoryPath(input, policy.rootDir);

  let stats;
  try {
    stats = await stat(resolved);
  } catch {
    throw new DirectoryValidationError("DIRECTORY_NOT_FOUND", CWD_ERROR_MESSAGES.NOT_FOUND);
  }

  if (!stats.isDirectory()) {
    throw new DirectoryValidationError("DIRECTORY_NOT_DIRECTORY", CWD_ERROR_MESSAGES.NOT_DIRECTORY);
  }

  return resolveToRealPath(resolved);
}

export async function listDirectories(
  requestedPath: string | undefined,
  policy: CwdPolicy,
): Promise<DirectoryListingResult> {
  const baseInput = requestedPath?.trim().length ? requestedPath : policy.rootDir;
  const resolvedPath = await validateDirectoryPath(baseInput, policy);
  const roots: string[] = [];

  try {
    const entries = await readdir(resolvedPath, { withFileTypes: true });
    const directories = (
      await Promise.all(
        entries.map(async (entry): Promise<DirectorySummary | null> => {
          if (!entry.isDirectory()) {
            return null;
          }

          return {
            name: entry.name,
            path: await resolveToRealPath(resolve(resolvedPath, entry.name)),
          };
        }),
      )
    ).filter((entry): entry is DirectorySummary => entry !== null);

    directories.sort((a, b) => a.name.localeCompare(b.name));

    return {
      requestedPath,
      resolvedPath,
      roots,
      directories,
    };
  } catch {
    throw new DirectoryValidationError("DIRECTORY_LIST_FAILED", CWD_ERROR_MESSAGES.LIST_FAILED);
  }
}

export async function validateDirectory(
  requestedPath: string,
  policy: CwdPolicy,
): Promise<DirectoryValidationResult> {
  const roots: string[] = [];

  try {
    const resolvedPath = await validateDirectoryPath(requestedPath, policy);
    return {
      requestedPath,
      roots,
      valid: true,
      resolvedPath,
    };
  } catch (error) {
    if (error instanceof DirectoryValidationError) {
      return {
        requestedPath,
        roots,
        valid: false,
        message: error.message,
      };
    }

    return {
      requestedPath,
      roots,
      valid: false,
      message: CWD_ERROR_MESSAGES.NOT_FOUND,
    };
  }
}

async function resolveToRealPath(pathValue: string): Promise<string> {
  try {
    return resolve(await realpath(pathValue));
  } catch {
    return resolve(pathValue);
  }
}
