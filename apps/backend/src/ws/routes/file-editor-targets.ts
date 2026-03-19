import { stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { resolveNotesDir } from "../../notes/note-storage.js";

const OBSIDIAN_CONFIG_DIRECTORY = ".obsidian";
const MIDDLEMAN_NOTE_EXTENSION = ".md";

export interface FileEditorTargets {
  notesPath?: string;
  obsidian?: {
    vault: string;
    file: string;
  };
}

export async function resolveFileEditorTargets(options: {
  dataDir: string;
  filePath: string;
}): Promise<FileEditorTargets> {
  const { dataDir, filePath } = options;
  const [obsidianTarget] = await Promise.all([resolveObsidianTarget(filePath)]);

  const targets: FileEditorTargets = {};
  const notesPath = resolveMiddlemanNotesPath({
    dataDir,
    filePath,
  });

  if (notesPath) {
    targets.notesPath = notesPath;
  }

  if (obsidianTarget) {
    targets.obsidian = obsidianTarget;
  }

  return targets;
}

function resolveMiddlemanNotesPath(options: { dataDir: string; filePath: string }): string | null {
  const { dataDir, filePath } = options;
  if (!filePath.toLowerCase().endsWith(MIDDLEMAN_NOTE_EXTENSION)) {
    return null;
  }

  return toRelativeEditorPath(resolveNotesDir(dataDir), filePath);
}

async function resolveObsidianTarget(
  filePath: string,
): Promise<FileEditorTargets["obsidian"] | null> {
  const vaultRoot = await findNearestObsidianVaultRoot(filePath);
  if (!vaultRoot) {
    return null;
  }

  const relativeFilePath = toRelativeEditorPath(vaultRoot, filePath);
  if (!relativeFilePath) {
    return null;
  }

  return {
    vault: basename(vaultRoot) || vaultRoot,
    file: relativeFilePath,
  };
}

async function findNearestObsidianVaultRoot(filePath: string): Promise<string | null> {
  let currentDirectory = dirname(filePath);

  while (true) {
    if (await isDirectory(resolve(currentDirectory, OBSIDIAN_CONFIG_DIRECTORY))) {
      return currentDirectory;
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return null;
    }

    currentDirectory = parentDirectory;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function toRelativeEditorPath(rootPath: string, filePath: string): string | null {
  const relativePath = relative(rootPath, filePath);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return null;
  }

  return relativePath.split(sep).join("/");
}
