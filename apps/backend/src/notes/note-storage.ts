import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const NOTES_DIRECTORY_NAME = "notes";
const MARKDOWN_EXTENSION = ".md";
const NOTE_FILENAME_MAX_LENGTH = 180;

export interface StoredNoteSummary {
  filename: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  sizeBytes: number;
}

export interface StoredNoteDocument extends StoredNoteSummary {
  content: string;
}

export interface SaveNoteResult {
  created: boolean;
  note: StoredNoteDocument;
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

export async function listNotes(dataDir: string): Promise<StoredNoteSummary[]> {
  const notesDir = await ensureNotesDir(dataDir);
  const entries = await readdir(notesDir, { withFileTypes: true });
  const markdownEntries = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(MARKDOWN_EXTENSION))
    .map((entry) => entry.name);

  const notes = await Promise.all(markdownEntries.map(async (filename) => {
    const filePath = resolve(notesDir, filename);
    const [content, fileStats] = await Promise.all([
      readFile(filePath, "utf8"),
      stat(filePath)
    ]);

    return toStoredNoteSummary(filename, fileStats, content);
  }));

  return notes.sort((left, right) => {
    const updatedDifference = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    if (updatedDifference !== 0) {
      return updatedDifference;
    }

    return left.filename.localeCompare(right.filename);
  });
}

export async function readNote(dataDir: string, rawFilename: string): Promise<StoredNoteDocument> {
  const filename = normalizeNoteFilename(rawFilename);
  const notesDir = await ensureNotesDir(dataDir);
  const filePath = resolve(notesDir, filename);

  try {
    await assertRegularNoteFile(filePath, filename);
    const [content, fileStats] = await Promise.all([
      readFile(filePath, "utf8"),
      stat(filePath)
    ]);

    return {
      ...toStoredNoteSummary(filename, fileStats, content),
      content
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new NoteStorageError(404, `Note "${filename}" was not found.`);
    }

    throw error;
  }
}

export async function saveNote(
  dataDir: string,
  rawFilename: string,
  content: string
): Promise<SaveNoteResult> {
  const filename = normalizeNoteFilename(rawFilename);
  const notesDir = await ensureNotesDir(dataDir);
  const filePath = resolve(notesDir, filename);
  const tempPath = resolve(notesDir, `.${filename}.${randomUUID()}.tmp`);
  let created = false;

  try {
    await assertRegularNoteFile(filePath, filename);
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
    note: await readNote(dataDir, filename)
  };
}

export async function deleteNote(dataDir: string, rawFilename: string): Promise<void> {
  const filename = normalizeNoteFilename(rawFilename);
  const notesDir = await ensureNotesDir(dataDir);
  const filePath = resolve(notesDir, filename);

  try {
    await unlink(filePath);
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new NoteStorageError(404, `Note "${filename}" was not found.`);
    }

    throw error;
  }
}

async function assertRegularNoteFile(filePath: string, filename: string): Promise<void> {
  const fileStats = await lstat(filePath);

  if (fileStats.isSymbolicLink()) {
    throw new NoteStorageError(400, `Note "${filename}" must not be a symbolic link.`);
  }

  if (!fileStats.isFile()) {
    throw new NoteStorageError(400, `Note "${filename}" must be a regular file.`);
  }
}

export function normalizeNoteFilename(rawFilename: string): string {
  const filename = rawFilename.trim();

  if (filename.length === 0) {
    throw new NoteStorageError(400, "filename must be a non-empty string.");
  }

  if (filename.length > NOTE_FILENAME_MAX_LENGTH) {
    throw new NoteStorageError(400, `filename must be at most ${NOTE_FILENAME_MAX_LENGTH} characters.`);
  }

  if (filename.includes("/") || filename.includes("\\") || filename.includes("\0")) {
    throw new NoteStorageError(400, "filename must not include path separators.");
  }

  if (!filename.toLowerCase().endsWith(MARKDOWN_EXTENSION)) {
    throw new NoteStorageError(400, 'filename must end with ".md".');
  }

  return filename;
}

async function ensureNotesDir(dataDir: string): Promise<string> {
  const notesDir = resolveNotesDir(dataDir);
  await mkdir(notesDir, { recursive: true });
  return notesDir;
}

function toStoredNoteSummary(
  filename: string,
  fileStats: { birthtime: Date; birthtimeMs: number; mtime: Date; size: number },
  content: string
): StoredNoteSummary {
  const createdAt =
    fileStats.birthtimeMs > 0 ? fileStats.birthtime.toISOString() : fileStats.mtime.toISOString();

  return {
    filename,
    title: extractNoteTitle(filename, content),
    createdAt,
    updatedAt: fileStats.mtime.toISOString(),
    sizeBytes: fileStats.size
  };
}

function extractNoteTitle(filename: string, content: string): string {
  const headingLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^#{1,6}\s+\S/.test(line));

  if (headingLine) {
    return headingLine.replace(/^#{1,6}\s+/, "").trim();
  }

  const baseTitle = filename.slice(0, -MARKDOWN_EXTENSION.length).replace(/[-_]+/g, " ").trim();
  if (!baseTitle) {
    return "Untitled note";
  }

  return baseTitle.replace(/\b\w/g, (match) => match.toUpperCase());
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
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
