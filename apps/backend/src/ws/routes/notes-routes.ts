import type { IncomingMessage, ServerResponse } from "node:http";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import {
  deleteNote,
  listNotes,
  normalizeNoteFilename,
  NoteStorageError,
  readNote,
  saveNote
} from "../../notes/note-storage.js";
import {
  applyCorsHeaders,
  decodePathSegment,
  matchPathPattern,
  readRequestBody,
  sendJson
} from "../http-utils.js";
import type { HttpRoute } from "./http-route.js";

const NOTES_COLLECTION_ENDPOINT_PATH = "/api/notes";
const NOTES_ITEM_ENDPOINT_PATTERN = /^\/api\/notes\/(.+)$/;
const NOTES_COLLECTION_METHODS = "GET, OPTIONS";
const NOTES_ITEM_METHODS = "GET, PUT, DELETE, OPTIONS";
const MAX_NOTE_BODY_BYTES = 1_048_576;

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
    const notes = await listNotes(swarmManager.getConfig().paths.dataDir);
    sendJson(response, 200, { notes });
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

  const matched = matchPathPattern(requestUrl.pathname, NOTES_ITEM_ENDPOINT_PATTERN);
  const decodedFilename = decodePathSegment(matched?.[1]);

  if (!decodedFilename) {
    sendJson(response, 400, { error: "Missing filename." });
    return;
  }

  try {
    const filename = normalizeNoteFilename(decodedFilename);
    const dataDir = swarmManager.getConfig().paths.dataDir;

    if (request.method === "GET") {
      const note = await readNote(dataDir, filename);
      sendJson(response, 200, { note });
      return;
    }

    if (request.method === "PUT") {
      const body = await readRequestBody(request, MAX_NOTE_BODY_BYTES);
      const content = body.toString("utf8");
      const result = await saveNote(dataDir, filename, content);
      sendJson(response, result.created ? 201 : 200, { note: result.note });
      return;
    }

    if (request.method === "DELETE") {
      await deleteNote(dataDir, filename);
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

function sendNotesError(response: ServerResponse, error: unknown): void {
  if (error instanceof NoteStorageError) {
    sendJson(response, error.statusCode, { error: error.message });
    return;
  }

  const message = error instanceof Error ? error.message : "Unable to handle note request.";
  const statusCode =
    message.includes("too large")
      ? 413
      : 500;

  sendJson(response, statusCode, { error: message });
}
