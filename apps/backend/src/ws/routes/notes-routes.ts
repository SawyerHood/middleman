import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import {
  normalizeMimeType,
  parseMultipartFormData,
  resolveUploadFileName,
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
  saveNote,
} from "../../notes/note-storage.js";
import { readRequestBody, resolveReadFileContentType } from "../http-utils.js";
import {
  createBodyLimit,
  createCorsMiddleware,
  createMethodGuard,
  readJsonBody,
  type NodeServerEnv,
} from "../hono-utils.js";

const NOTES_COLLECTION_ENDPOINT_PATH = "/api/notes";
const NOTES_UPLOAD_ENDPOINT_PATH = "/api/notes/upload";
const NOTES_ATTACHMENT_ENDPOINT_PATH = "/api/notes/attachments/:filename";
const NOTES_FOLDER_ENDPOINT_PATH = "/api/notes/folder/:folderPath{.+}";
const NOTES_ITEM_ENDPOINT_PATH = "/api/notes/:notePath{.+}";
const NOTES_COLLECTION_METHODS = ["GET"] as const;
const NOTES_UPLOAD_METHODS = ["POST"] as const;
const NOTES_ATTACHMENT_METHODS = ["GET"] as const;
const NOTES_FOLDER_METHODS = ["PUT", "DELETE"] as const;
const NOTES_ITEM_METHODS = ["GET", "PUT", "PATCH", "DELETE"] as const;
const MAX_NOTE_BODY_BYTES = 1_048_576;
const MAX_NOTE_IMAGE_BYTES = 10_000_000;
const MAX_NOTE_IMAGE_BODY_BYTES = MAX_NOTE_IMAGE_BYTES + 512 * 1024;
const ALLOWED_NOTE_IMAGE_MIME_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export function createNotesHttpRoutes(options: {
  swarmManager: SwarmManager;
}): Hono<NodeServerEnv> {
  const { swarmManager } = options;
  const app = new Hono<NodeServerEnv>();

  app.use(NOTES_COLLECTION_ENDPOINT_PATH, createCorsMiddleware(NOTES_COLLECTION_METHODS));
  app.use(NOTES_COLLECTION_ENDPOINT_PATH, createMethodGuard(NOTES_COLLECTION_METHODS));
  app.get(NOTES_COLLECTION_ENDPOINT_PATH, async (c) => {
    try {
      const tree = await listNotesTree(swarmManager.getConfig().paths.dataDir);
      return c.json({ tree });
    } catch (error) {
      return sendNotesError(error);
    }
  });

  app.use(NOTES_UPLOAD_ENDPOINT_PATH, createCorsMiddleware(NOTES_UPLOAD_METHODS));
  app.use(NOTES_UPLOAD_ENDPOINT_PATH, createMethodGuard(NOTES_UPLOAD_METHODS));
  app.post(NOTES_UPLOAD_ENDPOINT_PATH, async (c) => {
    const contentType = c.req.header("content-type");
    if (
      typeof contentType !== "string" ||
      !contentType.toLowerCase().includes("multipart/form-data")
    ) {
      return c.json({ error: "Content-Type must be multipart/form-data" }, 400);
    }

    try {
      const rawBody = await readRequestBody(c.req.raw, MAX_NOTE_IMAGE_BODY_BYTES);
      const formData = await parseMultipartFormData(rawBody, contentType);
      const fileValue = formData.get("file");

      if (!(fileValue instanceof File)) {
        return c.json({ error: "Missing image file upload (field name: file)." }, 400);
      }

      if (fileValue.size === 0) {
        return c.json({ error: "Image file is empty." }, 400);
      }

      if (fileValue.size > MAX_NOTE_IMAGE_BYTES) {
        return c.json({ error: "Image file too large. Max size is 10MB." }, 413);
      }

      const mimeType = normalizeMimeType(fileValue.type);
      if (!isSupportedNoteImageMimeType(mimeType)) {
        return c.json({ error: "Unsupported image format." }, 415);
      }

      const attachment = await saveNoteAttachment(swarmManager.getConfig().paths.dataDir, {
        data: Buffer.from(await fileValue.arrayBuffer()),
        fileName: resolveUploadFileName(fileValue),
        mimeType,
      });

      return c.json({ path: attachment.path }, 201);
    } catch (error) {
      return sendNotesError(error);
    }
  });

  app.use(NOTES_ATTACHMENT_ENDPOINT_PATH, createCorsMiddleware(NOTES_ATTACHMENT_METHODS));
  app.use(NOTES_ATTACHMENT_ENDPOINT_PATH, createMethodGuard(NOTES_ATTACHMENT_METHODS));
  app.get(NOTES_ATTACHMENT_ENDPOINT_PATH, async (c) => {
    const filename = c.req.param("filename");
    if (!filename) {
      return c.json({ error: "Missing attachment filename." }, 400);
    }

    try {
      const attachment = await readNoteAttachment(swarmManager.getConfig().paths.dataDir, filename);
      const fileBuffer = await readFile(attachment.filePath);

      return new Response(fileBuffer, {
        status: 200,
        headers: {
          "Content-Length": String(fileBuffer.byteLength),
          "Content-Type": resolveReadFileContentType(attachment.filePath),
        },
      });
    } catch (error) {
      return sendNotesError(error);
    }
  });

  app.use(NOTES_FOLDER_ENDPOINT_PATH, createCorsMiddleware(NOTES_FOLDER_METHODS));
  app.use(NOTES_FOLDER_ENDPOINT_PATH, createMethodGuard(NOTES_FOLDER_METHODS));
  app.put(NOTES_FOLDER_ENDPOINT_PATH, async (c) => {
    const folderPath = c.req.param("folderPath");
    if (!folderPath) {
      return c.json({ error: "Missing folder path." }, 400);
    }

    try {
      const result = await createFolder(swarmManager.getConfig().paths.dataDir, folderPath);
      return c.json({ folder: result.folder }, result.created ? 201 : 200);
    } catch (error) {
      return sendNotesError(error);
    }
  });
  app.delete(NOTES_FOLDER_ENDPOINT_PATH, async (c) => {
    const folderPath = c.req.param("folderPath");
    if (!folderPath) {
      return c.json({ error: "Missing folder path." }, 400);
    }

    try {
      await deleteFolder(swarmManager.getConfig().paths.dataDir, folderPath);
      return c.body(null, 204);
    } catch (error) {
      return sendNotesError(error);
    }
  });

  app.use(NOTES_ITEM_ENDPOINT_PATH, createCorsMiddleware(NOTES_ITEM_METHODS));
  app.use(NOTES_ITEM_ENDPOINT_PATH, createMethodGuard(NOTES_ITEM_METHODS));
  app.get(NOTES_ITEM_ENDPOINT_PATH, async (c) => {
    const notePath = c.req.param("notePath");
    if (!notePath) {
      return c.json({ error: "Missing note path." }, 400);
    }

    try {
      const note = await readNote(swarmManager.getConfig().paths.dataDir, notePath);
      return c.json({ note });
    } catch (error) {
      return sendNotesError(error);
    }
  });
  app.put(NOTES_ITEM_ENDPOINT_PATH, async (c) => {
    const notePath = c.req.param("notePath");
    if (!notePath) {
      return c.json({ error: "Missing note path." }, 400);
    }

    try {
      const body = await readRequestBody(c.req.raw, MAX_NOTE_BODY_BYTES);
      const content = body.toString("utf8");
      const result = await saveNote(swarmManager.getConfig().paths.dataDir, notePath, content);
      return c.json({ note: result.note }, result.created ? 201 : 200);
    } catch (error) {
      return sendNotesError(error);
    }
  });
  app.patch(
    NOTES_ITEM_ENDPOINT_PATH,
    createBodyLimit(
      MAX_NOTE_BODY_BYTES,
      `Request body too large. Max ${MAX_NOTE_BODY_BYTES} bytes.`,
    ),
    async (c) => {
      const notePath = c.req.param("notePath");
      if (!notePath) {
        return c.json({ error: "Missing note path." }, 400);
      }

      try {
        const payload = await readJsonBody(c, {
          emptyValue: {},
          invalidJsonMessage: "Request body must be valid JSON",
        });
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          return c.json({ error: "Request body must be a JSON object." }, 400);
        }

        const newFilename = (payload as { newFilename?: unknown }).newFilename;
        if (typeof newFilename !== "string" || newFilename.trim().length === 0) {
          return c.json({ error: "newFilename must be a non-empty string." }, 400);
        }

        const note = await renameNote(
          swarmManager.getConfig().paths.dataDir,
          notePath,
          newFilename,
        );
        return c.json({ note });
      } catch (error) {
        return sendNotesError(error);
      }
    },
  );
  app.delete(NOTES_ITEM_ENDPOINT_PATH, async (c) => {
    const notePath = c.req.param("notePath");
    if (!notePath) {
      return c.json({ error: "Missing note path." }, 400);
    }

    try {
      await deleteNote(swarmManager.getConfig().paths.dataDir, notePath);
      return c.body(null, 204);
    } catch (error) {
      return sendNotesError(error);
    }
  });

  return app;
}

function isSupportedNoteImageMimeType(mimeType: string): boolean {
  return ALLOWED_NOTE_IMAGE_MIME_TYPES.has(mimeType);
}

function sendNotesError(error: unknown): Response {
  if (error instanceof NoteStorageError) {
    return Response.json({ error: error.message }, { status: error.statusCode });
  }

  const message = error instanceof Error ? error.message : "Unable to handle note request.";
  const statusCode = message.includes("too large")
    ? 413
    : message.includes("valid JSON") || message.includes("multipart form data")
      ? 400
      : 500;

  return Response.json({ error: message }, { status: statusCode });
}
