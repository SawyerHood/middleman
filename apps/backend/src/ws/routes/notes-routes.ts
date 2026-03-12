import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  normalizeMimeType,
  parseMultipartFormData,
  resolveUploadFileName
} from "../attachment-parser.js";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import {
  createFolder,
  deleteFolder,
  deleteNote,
  listNotesTree,
  NoteStorageError,
  readNoteAttachment,
  readNote,
  renameNote,
  saveNoteAttachment,
  saveNote
} from "../../notes/note-storage.js";
import {
  applyCorsHeaders,
  decodePathSegment,
  matchPathPattern,
  readJsonBody,
  readRequestBody,
  resolveReadFileContentType,
  sendJson
} from "../http-utils.js";
import type { HttpRoute } from "./http-route.js";

const NOTES_COLLECTION_ENDPOINT_PATH = "/api/notes";
const NOTES_UPLOAD_ENDPOINT_PATH = "/api/notes/upload";
const NOTES_ATTACHMENT_ENDPOINT_PATTERN = /^\/api\/notes\/attachments\/([^/]+)$/;
const NOTES_FOLDER_ENDPOINT_PATTERN = /^\/api\/notes\/folder\/(.+)$/;
const NOTES_ITEM_ENDPOINT_PATTERN = /^\/api\/notes\/(.+)$/;
const NOTES_COLLECTION_METHODS = "GET, OPTIONS";
const NOTES_UPLOAD_METHODS = "POST, OPTIONS";
const NOTES_ATTACHMENT_METHODS = "GET, OPTIONS";
const NOTES_FOLDER_METHODS = "PUT, DELETE, OPTIONS";
const NOTES_ITEM_METHODS = "GET, PUT, PATCH, DELETE, OPTIONS";
const MAX_NOTE_BODY_BYTES = 1_048_576;
const MAX_NOTE_IMAGE_BYTES = 10_000_000;
const MAX_NOTE_IMAGE_BODY_BYTES = MAX_NOTE_IMAGE_BYTES + 512 * 1024;
const ALLOWED_NOTE_IMAGE_MIME_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp"
]);

export function createNotesHttpRoutes(options: { swarmManager: SwarmManager }): HttpRoute[] {
  const { swarmManager } = options;

  return [
    {
      methods: NOTES_COLLECTION_METHODS,
      matches: (pathname) => pathname === NOTES_COLLECTION_ENDPOINT_PATH,
      handle: async (request, response) => {
        await handleNotesCollectionRequest(swarmManager, request, response);
      }
    },
    {
      methods: NOTES_UPLOAD_METHODS,
      matches: (pathname) => pathname === NOTES_UPLOAD_ENDPOINT_PATH,
      handle: async (request, response) => {
        await handleNotesUploadRequest(swarmManager, request, response);
      }
    },
    {
      methods: NOTES_ATTACHMENT_METHODS,
      matches: (pathname) => NOTES_ATTACHMENT_ENDPOINT_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        await handleNotesAttachmentRequest(swarmManager, request, response, requestUrl);
      }
    },
    {
      methods: NOTES_FOLDER_METHODS,
      matches: (pathname) => NOTES_FOLDER_ENDPOINT_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        await handleNotesFolderRequest(swarmManager, request, response, requestUrl);
      }
    },
    {
      methods: NOTES_ITEM_METHODS,
      matches: (pathname) => NOTES_ITEM_ENDPOINT_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        await handleNoteItemRequest(swarmManager, request, response, requestUrl);
      }
    }
  ];
}

async function handleNotesCollectionRequest(
  swarmManager: SwarmManager,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, NOTES_COLLECTION_METHODS);
    response.statusCode = 204;
    response.end();
    return;
  }

  if (request.method !== "GET") {
    applyCorsHeaders(request, response, NOTES_COLLECTION_METHODS);
    response.setHeader("Allow", NOTES_COLLECTION_METHODS);
    sendJson(response, 405, { error: "Method Not Allowed" });
    return;
  }

  applyCorsHeaders(request, response, NOTES_COLLECTION_METHODS);

  try {
    const tree = await listNotesTree(swarmManager.getConfig().paths.dataDir);
    sendJson(response, 200, { tree });
  } catch (error) {
    sendNotesError(response, error);
  }
}

async function handleNotesUploadRequest(
  swarmManager: SwarmManager,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, NOTES_UPLOAD_METHODS);
    response.statusCode = 204;
    response.end();
    return;
  }

  if (request.method !== "POST") {
    applyCorsHeaders(request, response, NOTES_UPLOAD_METHODS);
    response.setHeader("Allow", NOTES_UPLOAD_METHODS);
    sendJson(response, 405, { error: "Method Not Allowed" });
    return;
  }

  applyCorsHeaders(request, response, NOTES_UPLOAD_METHODS);

  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !contentType.toLowerCase().includes("multipart/form-data")) {
    sendJson(response, 400, { error: "Content-Type must be multipart/form-data" });
    return;
  }

  try {
    const rawBody = await readRequestBody(request, MAX_NOTE_IMAGE_BODY_BYTES);
    const formData = await parseMultipartFormData(rawBody, contentType);
    const fileValue = formData.get("file");

    if (!(fileValue instanceof File)) {
      sendJson(response, 400, { error: "Missing image file upload (field name: file)." });
      return;
    }

    if (fileValue.size === 0) {
      sendJson(response, 400, { error: "Image file is empty." });
      return;
    }

    if (fileValue.size > MAX_NOTE_IMAGE_BYTES) {
      sendJson(response, 413, { error: "Image file too large. Max size is 10MB." });
      return;
    }

    const mimeType = normalizeMimeType(fileValue.type);
    if (!isSupportedNoteImageMimeType(mimeType)) {
      sendJson(response, 415, { error: "Unsupported image format." });
      return;
    }

    const attachment = await saveNoteAttachment(swarmManager.getConfig().paths.dataDir, {
      data: Buffer.from(await fileValue.arrayBuffer()),
      fileName: resolveUploadFileName(fileValue),
      mimeType
    });

    sendJson(response, 201, { path: attachment.path });
  } catch (error) {
    sendNotesError(response, error);
  }
}

async function handleNotesAttachmentRequest(
  swarmManager: SwarmManager,
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL
): Promise<void> {
  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, NOTES_ATTACHMENT_METHODS);
    response.statusCode = 204;
    response.end();
    return;
  }

  if (request.method !== "GET") {
    applyCorsHeaders(request, response, NOTES_ATTACHMENT_METHODS);
    response.setHeader("Allow", NOTES_ATTACHMENT_METHODS);
    sendJson(response, 405, { error: "Method Not Allowed" });
    return;
  }

  applyCorsHeaders(request, response, NOTES_ATTACHMENT_METHODS);

  const filename = decodeItemPath(requestUrl.pathname, NOTES_ATTACHMENT_ENDPOINT_PATTERN);
  if (!filename) {
    sendJson(response, 400, { error: "Missing attachment filename." });
    return;
  }

  try {
    const attachment = await readNoteAttachment(swarmManager.getConfig().paths.dataDir, filename);
    const fileBuffer = await readFile(attachment.filePath);

    response.statusCode = 200;
    response.setHeader("Content-Type", resolveReadFileContentType(attachment.filePath));
    response.setHeader("Content-Length", String(fileBuffer.byteLength));
    response.end(fileBuffer);
  } catch (error) {
    sendNotesError(response, error);
  }
}

async function handleNotesFolderRequest(
  swarmManager: SwarmManager,
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL
): Promise<void> {
  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, NOTES_FOLDER_METHODS);
    response.statusCode = 204;
    response.end();
    return;
  }

  applyCorsHeaders(request, response, NOTES_FOLDER_METHODS);

  const folderPath = decodeItemPath(requestUrl.pathname, NOTES_FOLDER_ENDPOINT_PATTERN);
  if (!folderPath) {
    sendJson(response, 400, { error: "Missing folder path." });
    return;
  }

  const dataDir = swarmManager.getConfig().paths.dataDir;

  try {
    if (request.method === "PUT") {
      const result = await createFolder(dataDir, folderPath);
      sendJson(response, result.created ? 201 : 200, { folder: result.folder });
      return;
    }

    if (request.method === "DELETE") {
      await deleteFolder(dataDir, folderPath);
      response.statusCode = 204;
      response.end();
      return;
    }

    response.setHeader("Allow", NOTES_FOLDER_METHODS);
    sendJson(response, 405, { error: "Method Not Allowed" });
  } catch (error) {
    sendNotesError(response, error);
  }
}

async function handleNoteItemRequest(
  swarmManager: SwarmManager,
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL
): Promise<void> {
  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, NOTES_ITEM_METHODS);
    response.statusCode = 204;
    response.end();
    return;
  }

  applyCorsHeaders(request, response, NOTES_ITEM_METHODS);

  const notePath = decodeItemPath(requestUrl.pathname, NOTES_ITEM_ENDPOINT_PATTERN);
  if (!notePath) {
    sendJson(response, 400, { error: "Missing note path." });
    return;
  }

  const dataDir = swarmManager.getConfig().paths.dataDir;

  try {
    if (request.method === "GET") {
      const note = await readNote(dataDir, notePath);
      sendJson(response, 200, { note });
      return;
    }

    if (request.method === "PUT") {
      const body = await readRequestBody(request, MAX_NOTE_BODY_BYTES);
      const content = body.toString("utf8");
      const result = await saveNote(dataDir, notePath, content);
      sendJson(response, result.created ? 201 : 200, { note: result.note });
      return;
    }

    if (request.method === "PATCH") {
      const payload = await readJsonBody(request, MAX_NOTE_BODY_BYTES);
      if (!payload || typeof payload !== "object") {
        sendJson(response, 400, { error: "Request body must be a JSON object." });
        return;
      }

      const newFilename = (payload as { newFilename?: unknown }).newFilename;
      if (typeof newFilename !== "string" || newFilename.trim().length === 0) {
        sendJson(response, 400, { error: "newFilename must be a non-empty string." });
        return;
      }

      const note = await renameNote(dataDir, notePath, newFilename);
      sendJson(response, 200, { note });
      return;
    }

    if (request.method === "DELETE") {
      await deleteNote(dataDir, notePath);
      response.statusCode = 204;
      response.end();
      return;
    }

    response.setHeader("Allow", NOTES_ITEM_METHODS);
    sendJson(response, 405, { error: "Method Not Allowed" });
  } catch (error) {
    sendNotesError(response, error);
  }
}

function decodeItemPath(pathname: string, pattern: RegExp): string | undefined {
  const matched = matchPathPattern(pathname, pattern);
  return decodePathSegment(matched?.[1]);
}

function isSupportedNoteImageMimeType(mimeType: string): boolean {
  return ALLOWED_NOTE_IMAGE_MIME_TYPES.has(mimeType);
}

function sendNotesError(response: ServerResponse, error: unknown): void {
  if (error instanceof NoteStorageError) {
    sendJson(response, error.statusCode, { error: error.message });
    return;
  }

  const message = error instanceof Error ? error.message : "Unable to handle note request.";
  const statusCode =
    message.includes("too large")
      ? 413
      : message.includes("valid JSON") || message.includes("multipart form data")
        ? 400
        : 500;

  sendJson(response, statusCode, { error: message });
}
