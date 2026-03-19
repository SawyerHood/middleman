import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import mime from "mime";
import type { NoteDocument, NoteFolder, NoteSummary, NoteTreeNode } from "@middleman/protocol";

const NOTES_DIRECTORY_NAME = "notes";
const NOTES_ATTACHMENTS_DIRECTORY_NAME = "attachments";
const MARKDOWN_EXTENSION = ".md";
const NOTE_PATH_MAX_LENGTH = 512;
const NOTE_SEGMENT_MAX_LENGTH = 180;
const NOTE_ATTACHMENT_FALLBACK_EXTENSION = "png";

interface NormalizedNotePath {
  path: string;
  name: string;
  segments: string[];
  parentSegments: string[];
}

export class NoteStorageError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "NoteStorageError";
    this.statusCode = statusCode;
  }
}

export function resolveNotesDir(dataDir: string): string {
  return resolve(dataDir, NOTES_DIRECTORY_NAME);
}

export async function listNotesTree(dataDir: string): Promise<NoteTreeNode[]> {
  const notesDir = await ensureNotesDir(dataDir);
  return listTreeEntries(notesDir, []);
}

export async function readNote(dataDir: string, rawPath: string): Promise<NoteDocument> {
  const notePath = normalizeNotePath(rawPath);
  const notesDir = await ensureNotesDir(dataDir);
  const filePath = await resolveExistingEntryPath(notesDir, notePath, "file");

  const [content, fileStats] = await Promise.all([readFile(filePath, "utf8"), stat(filePath)]);

  return {
    ...toStoredNoteSummary(notePath.path, fileStats, content),
    content,
  };
}

export async function saveNote(
  dataDir: string,
  rawPath: string,
  content: string,
): Promise<{ created: boolean; note: NoteDocument }> {
  const notePath = normalizeNotePath(rawPath);
  const notesDir = await ensureNotesDir(dataDir);
  const parentDirectoryPath = await ensureDirectoryChain(notesDir, notePath.parentSegments);
  const filePath = resolve(parentDirectoryPath, notePath.name);
  const tempPath = resolve(parentDirectoryPath, `.${notePath.name}.${randomUUID()}.tmp`);
  let created = false;

  try {
    await assertRegularNoteFile(filePath, notePath.path);
  } catch (error) {
    if (isMissingFileError(error)) {
      created = true;
    } else {
      throw error;
    }
  }

  try {
    await writeFile(tempPath, content, { encoding: "utf8", flag: "wx" });
    await rename(tempPath, filePath);
  } catch (error) {
    await removeIfExists(tempPath);
    throw error;
  }

  return {
    created,
    note: await readNote(dataDir, notePath.path),
  };
}

export async function renameNote(
  dataDir: string,
  rawPath: string,
  rawNewPath: string,
): Promise<NoteDocument> {
  const currentPath = normalizeNotePath(rawPath);
  const nextPath = normalizeNotePath(rawNewPath, "newFilename");

  if (currentPath.path === nextPath.path) {
    return readNote(dataDir, currentPath.path);
  }

  const notesDir = await ensureNotesDir(dataDir);
  const sourcePath = await resolveExistingEntryPath(notesDir, currentPath, "file");
  const targetParentDirectoryPath = await ensureDirectoryChain(notesDir, nextPath.parentSegments);
  const targetPath = resolve(targetParentDirectoryPath, nextPath.name);

  await assertRenameTargetAvailable(sourcePath, targetPath, nextPath.path);
  await rename(sourcePath, targetPath);

  return readNote(dataDir, nextPath.path);
}

export async function deleteNote(dataDir: string, rawPath: string): Promise<void> {
  const notePath = normalizeNotePath(rawPath);
  const notesDir = await ensureNotesDir(dataDir);
  const filePath = await resolveExistingEntryPath(notesDir, notePath, "file");
  await unlink(filePath);
}

export async function createFolder(
  dataDir: string,
  rawPath: string,
): Promise<{ created: boolean; folder: NoteFolder }> {
  const folderPath = normalizeFolderPath(rawPath);
  const notesDir = await ensureNotesDir(dataDir);
  const parentDirectoryPath = await ensureDirectoryChain(notesDir, folderPath.parentSegments);
  const targetPath = resolve(parentDirectoryPath, folderPath.name);
  let created = false;

  try {
    await assertRegularDirectory(targetPath, folderPath.path, false);
  } catch (error) {
    if (isMissingFileError(error)) {
      await mkdir(targetPath);
      created = true;
    } else {
      throw error;
    }
  }

  return {
    created,
    folder: {
      kind: "folder",
      path: folderPath.path,
      name: folderPath.name,
      children: [],
    },
  };
}

export async function deleteFolder(dataDir: string, rawPath: string): Promise<void> {
  const folderPath = normalizeFolderPath(rawPath);
  const notesDir = await ensureNotesDir(dataDir);
  const directoryPath = await resolveExistingEntryPath(notesDir, folderPath, "directory");
  await rm(directoryPath, { recursive: true, force: false });
}

export async function saveNoteAttachment(
  dataDir: string,
  options: {
    data: Buffer;
    fileName?: string;
    mimeType?: string;
  },
): Promise<{ filename: string; path: string; filePath: string }> {
  const attachmentsDir = await ensureNoteAttachmentsDir(dataDir);
  const extension = resolveAttachmentExtension(options);
  const fileName = buildAttachmentFileName(options.data, extension);
  const filePath = resolve(attachmentsDir, fileName);
  const tempPath = resolve(attachmentsDir, `.${fileName}.${randomUUID()}.tmp`);

  try {
    await writeFile(tempPath, options.data, { flag: "wx" });
    await rename(tempPath, filePath);
  } catch (error) {
    await removeIfExists(tempPath);
    throw error;
  }

  return {
    filename: fileName,
    path: `${NOTES_ATTACHMENTS_DIRECTORY_NAME}/${fileName}`,
    filePath,
  };
}

export async function readNoteAttachment(
  dataDir: string,
  rawFilename: string,
): Promise<{ filename: string; path: string; filePath: string }> {
  const filename = normalizeAttachmentFileName(rawFilename);
  const attachmentsDir = await ensureNoteAttachmentsDir(dataDir);
  const filePath = resolve(attachmentsDir, filename);

  try {
    await assertRegularAttachmentFile(filePath, filename);
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new NoteStorageError(404, `Attachment "${filename}" was not found.`);
    }

    throw error;
  }

  return {
    filename,
    path: `${NOTES_ATTACHMENTS_DIRECTORY_NAME}/${filename}`,
    filePath,
  };
}

async function listTreeEntries(
  directoryPath: string,
  parentSegments: string[],
): Promise<NoteTreeNode[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const nodes = await Promise.all(
    entries.map(async (entry): Promise<NoteTreeNode | null> => {
      const currentSegments = [...parentSegments, entry.name];
      const currentPath = currentSegments.join("/");
      const absolutePath = resolve(directoryPath, entry.name);

      if (entry.isSymbolicLink()) {
        return null;
      }

      if (
        parentSegments.length === 0 &&
        entry.isDirectory() &&
        entry.name === NOTES_ATTACHMENTS_DIRECTORY_NAME
      ) {
        return null;
      }

      if (entry.isDirectory()) {
        return {
          kind: "folder",
          path: currentPath,
          name: entry.name,
          children: await listTreeEntries(absolutePath, currentSegments),
        };
      }

      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(MARKDOWN_EXTENSION)) {
        return null;
      }

      const [content, fileStats] = await Promise.all([
        readFile(absolutePath, "utf8"),
        stat(absolutePath),
      ]);

      return {
        kind: "file",
        ...toStoredNoteSummary(currentPath, fileStats, content),
      };
    }),
  );

  return sortTreeNodes(nodes.filter((node): node is NoteTreeNode => node !== null));
}

async function ensureNotesDir(dataDir: string): Promise<string> {
  const notesDir = resolveNotesDir(dataDir);
  await mkdir(notesDir, { recursive: true });
  await assertRegularDirectory(notesDir, NOTES_DIRECTORY_NAME, true);
  return notesDir;
}

async function ensureNoteAttachmentsDir(dataDir: string): Promise<string> {
  const notesDir = await ensureNotesDir(dataDir);
  const attachmentsDir = resolve(notesDir, NOTES_ATTACHMENTS_DIRECTORY_NAME);
  await mkdir(attachmentsDir, { recursive: true });
  await assertRegularDirectory(attachmentsDir, NOTES_ATTACHMENTS_DIRECTORY_NAME, false);
  return attachmentsDir;
}

async function ensureDirectoryChain(notesDir: string, segments: string[]): Promise<string> {
  let currentPath = notesDir;
  const walkedSegments: string[] = [];

  for (const segment of segments) {
    walkedSegments.push(segment);
    const relativePath = walkedSegments.join("/");
    const nextPath = resolve(currentPath, segment);

    try {
      await assertRegularDirectory(nextPath, relativePath, false);
    } catch (error) {
      if (isMissingFileError(error)) {
        await mkdir(nextPath);
      } else {
        throw error;
      }
    }

    currentPath = nextPath;
  }

  return currentPath;
}

async function resolveExistingEntryPath(
  notesDir: string,
  normalizedPath: NormalizedNotePath,
  expectedKind: "file" | "directory",
): Promise<string> {
  let currentPath = notesDir;
  const walkedSegments: string[] = [];

  for (const [index, segment] of normalizedPath.segments.entries()) {
    walkedSegments.push(segment);
    const relativePath = walkedSegments.join("/");
    const nextPath = resolve(currentPath, segment);
    const isLeaf = index === normalizedPath.segments.length - 1;

    try {
      if (isLeaf) {
        if (expectedKind === "file") {
          await assertRegularNoteFile(nextPath, normalizedPath.path);
        } else {
          await assertRegularDirectory(nextPath, normalizedPath.path, false);
        }
      } else {
        await assertRegularDirectory(nextPath, relativePath, false);
      }
    } catch (error) {
      if (isMissingFileError(error)) {
        const itemLabel = expectedKind === "file" ? "Note" : "Folder";
        throw new NoteStorageError(404, `${itemLabel} "${normalizedPath.path}" was not found.`);
      }

      throw error;
    }

    currentPath = nextPath;
  }

  return currentPath;
}

async function assertRenameTargetAvailable(
  sourcePath: string,
  targetPath: string,
  notePath: string,
): Promise<void> {
  try {
    const [sourceStats, targetStats] = await Promise.all([lstat(sourcePath), lstat(targetPath)]);

    if (sourceStats.dev === targetStats.dev && sourceStats.ino === targetStats.ino) {
      return;
    }

    throw new NoteStorageError(409, `Note "${notePath}" already exists.`);
  } catch (error) {
    if (isMissingFileError(error)) {
      return;
    }

    throw error;
  }
}

async function assertRegularNoteFile(filePath: string, notePath: string): Promise<void> {
  await assertRegularFile(filePath, `Note "${notePath}"`);
}

async function assertRegularAttachmentFile(filePath: string, filename: string): Promise<void> {
  await assertRegularFile(filePath, `Attachment "${filename}"`);
}

async function assertRegularFile(filePath: string, label: string): Promise<void> {
  const fileStats = await lstat(filePath);

  if (fileStats.isSymbolicLink()) {
    throw new NoteStorageError(400, `${label} must not be a symbolic link.`);
  }

  if (!fileStats.isFile()) {
    throw new NoteStorageError(400, `${label} must be a regular file.`);
  }
}

async function assertRegularDirectory(
  directoryPath: string,
  relativePath: string,
  isNotesRoot: boolean,
): Promise<void> {
  const directoryStats = await lstat(directoryPath);
  const directoryLabel = isNotesRoot ? "Notes directory" : `Folder "${relativePath}"`;

  if (directoryStats.isSymbolicLink()) {
    throw new NoteStorageError(400, `${directoryLabel} must not be a symbolic link.`);
  }

  if (!directoryStats.isDirectory()) {
    throw new NoteStorageError(400, `${directoryLabel} must be a directory.`);
  }
}

function normalizeNotePath(rawPath: string, fieldLabel = "path"): NormalizedNotePath {
  const normalizedPath = normalizeRelativePath(rawPath, fieldLabel);

  if (!normalizedPath.path.toLowerCase().endsWith(MARKDOWN_EXTENSION)) {
    throw new NoteStorageError(400, `${fieldLabel} must end with "${MARKDOWN_EXTENSION}".`);
  }

  return normalizedPath;
}

function normalizeFolderPath(rawPath: string): NormalizedNotePath {
  return normalizeRelativePath(rawPath, "folderPath");
}

function normalizeRelativePath(rawPath: string, fieldLabel: string): NormalizedNotePath {
  const path = rawPath.trim();

  if (path.length === 0) {
    throw new NoteStorageError(400, `${fieldLabel} must be a non-empty string.`);
  }

  if (path.length > NOTE_PATH_MAX_LENGTH) {
    throw new NoteStorageError(
      400,
      `${fieldLabel} must be at most ${NOTE_PATH_MAX_LENGTH} characters.`,
    );
  }

  if (path.includes("\\") || path.includes("\0")) {
    throw new NoteStorageError(400, `${fieldLabel} must use forward-slash path separators only.`);
  }

  const segments = path.split("/");

  if (segments.some((segment) => segment.length === 0)) {
    throw new NoteStorageError(400, `${fieldLabel} must not include empty path segments.`);
  }

  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new NoteStorageError(400, `${fieldLabel} must not include "." or ".." segments.`);
    }

    if (segment.length > NOTE_SEGMENT_MAX_LENGTH) {
      throw new NoteStorageError(
        400,
        `Each ${fieldLabel} segment must be at most ${NOTE_SEGMENT_MAX_LENGTH} characters.`,
      );
    }
  }

  if (segments[0]?.toLowerCase() === NOTES_ATTACHMENTS_DIRECTORY_NAME) {
    throw new NoteStorageError(
      400,
      `${fieldLabel} must not use reserved top-level directory "${NOTES_ATTACHMENTS_DIRECTORY_NAME}".`,
    );
  }

  return {
    path: segments.join("/"),
    name: segments.at(-1) ?? path,
    segments,
    parentSegments: segments.slice(0, -1),
  };
}

function toStoredNoteSummary(
  notePath: string,
  fileStats: { birthtime: Date; birthtimeMs: number; mtime: Date; size: number },
  content: string,
): NoteSummary {
  const createdAt =
    fileStats.birthtimeMs > 0 ? fileStats.birthtime.toISOString() : fileStats.mtime.toISOString();
  const noteName = basename(notePath);

  return {
    path: notePath,
    name: noteName,
    title: extractNoteTitle(noteName, content),
    createdAt,
    updatedAt: fileStats.mtime.toISOString(),
    sizeBytes: fileStats.size,
  };
}

function extractNoteTitle(noteName: string, content: string): string {
  const headingLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^#{1,6}\s+\S/.test(line));

  if (headingLine) {
    return headingLine.replace(/^#{1,6}\s+/, "").trim();
  }

  const baseTitle = noteName.slice(0, -MARKDOWN_EXTENSION.length).replace(/[-_]+/g, " ").trim();
  if (!baseTitle) {
    return "Untitled note";
  }

  return baseTitle.replace(/\b\w/g, (match) => match.toUpperCase());
}

function sortTreeNodes(nodes: NoteTreeNode[]): NoteTreeNode[] {
  return [...nodes].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "folder" ? -1 : 1;
    }

    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT",
  );
}

async function removeIfExists(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

function normalizeAttachmentFileName(rawFilename: string): string {
  const filename = rawFilename.trim();

  if (filename.length === 0) {
    throw new NoteStorageError(400, "filename must be a non-empty string.");
  }

  if (filename.length > NOTE_SEGMENT_MAX_LENGTH) {
    throw new NoteStorageError(
      400,
      `filename must be at most ${NOTE_SEGMENT_MAX_LENGTH} characters.`,
    );
  }

  if (
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("\0") ||
    filename === "." ||
    filename === ".."
  ) {
    throw new NoteStorageError(400, "filename must not include path separators or dot segments.");
  }

  return filename;
}

function buildAttachmentFileName(data: Buffer, extension: string): string {
  const hash = createHash("sha256").update(data).digest("hex").slice(0, 12);
  const uniqueSuffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const safeExtension =
    extension
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "") || NOTE_ATTACHMENT_FALLBACK_EXTENSION;

  return `${Date.now()}-${hash}-${uniqueSuffix}.${safeExtension}`;
}

function resolveAttachmentExtension(options: { fileName?: string; mimeType?: string }): string {
  const normalizedMimeType = options.mimeType?.trim().toLowerCase();
  const fromMimeType = normalizedMimeType ? mime.getExtension(normalizedMimeType) : undefined;
  if (fromMimeType) {
    return fromMimeType;
  }

  const fromFileName = resolveFileNameExtension(options.fileName);
  if (fromFileName) {
    return fromFileName;
  }

  return NOTE_ATTACHMENT_FALLBACK_EXTENSION;
}

function resolveFileNameExtension(fileName: string | undefined): string | undefined {
  if (typeof fileName !== "string") {
    return undefined;
  }

  const extension = extname(fileName.trim()).slice(1).toLowerCase();
  if (!extension) {
    return undefined;
  }

  const sanitizedExtension = extension.replace(/[^a-z0-9]/g, "");
  return sanitizedExtension.length > 0 ? sanitizedExtension : undefined;
}
