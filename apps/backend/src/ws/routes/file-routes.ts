import { readFile, stat } from "node:fs/promises";
import { Hono } from "hono";
import { resolveDirectoryPath } from "../../swarm/cwd-policy.js";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import { resolveReadFileContentType } from "../http-utils.js";
import {
  createBodyLimit,
  createCorsMiddleware,
  createMethodGuard,
  readJsonBody,
  type NodeServerEnv,
} from "../hono-utils.js";
import { resolveFileEditorTargets } from "./file-editor-targets.js";

const READ_FILE_ENDPOINT_PATH = "/api/read-file";
const READ_FILE_METHODS = ["GET", "POST"] as const;
const MAX_READ_FILE_BODY_BYTES = 64 * 1024;
const MAX_READ_FILE_CONTENT_BYTES = 2 * 1024 * 1024;

export function createFileRoutes(options: { swarmManager: SwarmManager }): Hono<NodeServerEnv> {
  const { swarmManager } = options;
  const app = new Hono<NodeServerEnv>();

  app.use(READ_FILE_ENDPOINT_PATH, createCorsMiddleware(READ_FILE_METHODS));
  app.use(READ_FILE_ENDPOINT_PATH, createMethodGuard(READ_FILE_METHODS));

  app.get(READ_FILE_ENDPOINT_PATH, async (c) => {
    return handleReadFileRequest(swarmManager, c.req.query("path"), "GET");
  });

  app.post(
    READ_FILE_ENDPOINT_PATH,
    createBodyLimit(
      MAX_READ_FILE_BODY_BYTES,
      `Request body exceeds ${MAX_READ_FILE_BODY_BYTES} bytes.`,
    ),
    async (c) => {
      try {
        const payload = await readJsonBody(c, {
          emptyValue: {},
          invalidJsonMessage: "Request body must be valid JSON.",
        });

        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          return c.json({ error: "Request body must be a JSON object." }, 400);
        }

        const requestedPath = (payload as { path?: unknown }).path;
        if (typeof requestedPath !== "string" || requestedPath.trim().length === 0) {
          return c.json({ error: "path must be a non-empty string." }, 400);
        }

        return handleReadFileRequest(swarmManager, requestedPath, "POST");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to read file.";
        const statusCode = message.includes("valid JSON") ? 400 : 500;
        return c.json({ error: message }, statusCode);
      }
    },
  );

  return app;
}

async function handleReadFileRequest(
  swarmManager: SwarmManager,
  requestedPath: string | null | undefined,
  requestMethod: "GET" | "POST",
): Promise<Response> {
  try {
    if (typeof requestedPath !== "string" || requestedPath.trim().length === 0) {
      return Response.json({ error: "path must be a non-empty string." }, { status: 400 });
    }

    const config = swarmManager.getConfig();
    const resolvedPath = resolveDirectoryPath(requestedPath, config.paths.projectRoot);

    let fileStats;
    try {
      fileStats = await stat(resolvedPath);
    } catch {
      return Response.json({ error: "File not found." }, { status: 404 });
    }

    if (!fileStats.isFile()) {
      return Response.json({ error: "Requested path must point to a file." }, { status: 400 });
    }

    if (fileStats.size > MAX_READ_FILE_CONTENT_BYTES) {
      return Response.json(
        {
          error: `File is too large. Maximum supported size is ${MAX_READ_FILE_CONTENT_BYTES} bytes.`,
        },
        { status: 413 },
      );
    }

    if (requestMethod === "GET") {
      const content = await readFile(resolvedPath);
      return new Response(content, {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
          "Content-Length": String(content.byteLength),
          "Content-Type": resolveReadFileContentType(resolvedPath),
        },
      });
    }

    const [content, editorTargets] = await Promise.all([
      readFile(resolvedPath, "utf8"),
      resolveFileEditorTargets({
        dataDir: config.paths.dataDir,
        filePath: resolvedPath,
      }),
    ]);

    return Response.json(
      {
        path: resolvedPath,
        content,
        editorTargets,
      },
      { status: 200 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to read file.";
    return Response.json({ error: message }, { status: 500 });
  }
}
