import { resolveApiEndpoint } from "@/lib/api-endpoint";
import type {
  NoteDocument,
  NoteFolder,
  NoteSummary,
  NoteTreeFile,
  NoteTreeNode,
} from "@middleman/protocol";

const NOTE_ATTACHMENT_PATH_REGEXP = /^attachments\/[^/]+$/i;

function isNoteSummary(value: unknown): value is NoteSummary {
  if (!value || typeof value !== "object") {
    return false;
  }

  const note = value as Partial<NoteSummary>;
  return (
    typeof note.path === "string" &&
    typeof note.name === "string" &&
    typeof note.title === "string" &&
    typeof note.createdAt === "string" &&
    typeof note.updatedAt === "string" &&
    typeof note.sizeBytes === "number"
  );
}

function isNoteDocument(value: unknown): value is NoteDocument {
  if (!isNoteSummary(value)) {
    return false;
  }

  return typeof (value as Partial<NoteDocument>).content === "string";
}

function isNoteTreeFile(value: unknown): value is NoteTreeFile {
  return isNoteSummary(value) && (value as Partial<NoteTreeFile>).kind === "file";
}

function isNoteFolder(value: unknown): value is NoteFolder {
  if (!value || typeof value !== "object") {
    return false;
  }

  const folder = value as Partial<NoteFolder>;
  return (
    folder.kind === "folder" &&
    typeof folder.path === "string" &&
    typeof folder.name === "string" &&
    Array.isArray(folder.children) &&
    folder.children.every(isNoteTreeNode)
  );
}

function isNoteTreeNode(value: unknown): value is NoteTreeNode {
  return isNoteTreeFile(value) || isNoteFolder(value);
}

async function readApiError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: unknown; message?: unknown };
    if (typeof payload.error === "string" && payload.error.trim()) return payload.error;
    if (typeof payload.message === "string" && payload.message.trim()) return payload.message;
  } catch {}

  try {
    const text = await response.text();
    if (text.trim().length > 0) return text;
  } catch {}

  return `Request failed (${response.status})`;
}

export function resolveNoteImageUrl(wsUrl: string, src: string): string {
  const trimmedSrc = src.trim();
  if (!trimmedSrc) {
    return trimmedSrc;
  }

  if (
    /^https?:\/\//i.test(trimmedSrc) ||
    trimmedSrc.startsWith("data:") ||
    trimmedSrc.startsWith("blob:") ||
    trimmedSrc.startsWith("/")
  ) {
    return trimmedSrc;
  }

  if (!NOTE_ATTACHMENT_PATH_REGEXP.test(trimmedSrc)) {
    return trimmedSrc;
  }

  const filename = trimmedSrc.slice("attachments/".length);
  return resolveApiEndpoint(wsUrl, `/api/notes/attachments/${encodeURIComponent(filename)}`);
}

export async function fetchNoteTree(wsUrl: string, signal?: AbortSignal): Promise<NoteTreeNode[]> {
  const response = await fetch(resolveApiEndpoint(wsUrl, "/api/notes"), { signal });
  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  const payload = (await response.json()) as { tree?: unknown };
  if (!payload || !Array.isArray(payload.tree)) {
    return [];
  }

  return payload.tree.filter(isNoteTreeNode);
}

export async function fetchNote(
  wsUrl: string,
  path: string,
  signal?: AbortSignal,
): Promise<NoteDocument> {
  const response = await fetch(
    resolveApiEndpoint(wsUrl, `/api/notes/${encodeURIComponent(path)}`),
    { signal },
  );
  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  const payload = (await response.json()) as { note?: unknown };
  if (!isNoteDocument(payload.note)) {
    throw new Error("Invalid note payload.");
  }

  return payload.note;
}

export async function saveNote(
  wsUrl: string,
  path: string,
  content: string,
  signal?: AbortSignal,
): Promise<NoteDocument> {
  const response = await fetch(
    resolveApiEndpoint(wsUrl, `/api/notes/${encodeURIComponent(path)}`),
    {
      method: "PUT",
      headers: {
        "content-type": "text/markdown; charset=utf-8",
      },
      body: content,
      signal,
    },
  );

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  const payload = (await response.json()) as { note?: unknown };
  if (!isNoteDocument(payload.note)) {
    throw new Error("Invalid note payload.");
  }

  return payload.note;
}

export async function uploadNoteAttachment(
  wsUrl: string,
  file: File,
  signal?: AbortSignal,
): Promise<string> {
  const formData = new FormData();
  formData.set("file", file, file.name || "image.png");

  const response = await fetch(resolveApiEndpoint(wsUrl, "/api/notes/upload"), {
    method: "POST",
    body: formData,
    signal,
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  const payload = (await response.json()) as { path?: unknown };
  if (typeof payload.path !== "string" || !NOTE_ATTACHMENT_PATH_REGEXP.test(payload.path)) {
    throw new Error("Invalid upload payload.");
  }

  return payload.path;
}

export async function renameNote(
  wsUrl: string,
  path: string,
  newFilename: string,
  signal?: AbortSignal,
): Promise<NoteDocument> {
  const response = await fetch(
    resolveApiEndpoint(wsUrl, `/api/notes/${encodeURIComponent(path)}`),
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ newFilename }),
      signal,
    },
  );

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  const payload = (await response.json()) as { note?: unknown };
  if (!isNoteDocument(payload.note)) {
    throw new Error("Invalid note payload.");
  }

  return payload.note;
}

export async function createFolder(
  wsUrl: string,
  path: string,
  signal?: AbortSignal,
): Promise<NoteFolder> {
  const response = await fetch(
    resolveApiEndpoint(wsUrl, `/api/notes/folder/${encodeURIComponent(path)}`),
    {
      method: "PUT",
      signal,
    },
  );

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  const payload = (await response.json()) as { folder?: unknown };
  if (!isNoteFolder(payload.folder)) {
    throw new Error("Invalid folder payload.");
  }

  return payload.folder;
}

export async function deleteNote(wsUrl: string, path: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(
    resolveApiEndpoint(wsUrl, `/api/notes/${encodeURIComponent(path)}`),
    {
      method: "DELETE",
      signal,
    },
  );

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }
}

export async function deleteFolder(
  wsUrl: string,
  path: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(
    resolveApiEndpoint(wsUrl, `/api/notes/folder/${encodeURIComponent(path)}`),
    {
      method: "DELETE",
      signal,
    },
  );

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }
}
