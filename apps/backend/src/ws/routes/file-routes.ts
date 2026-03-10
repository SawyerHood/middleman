import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import {
  isPathWithinRoots,
  normalizeAllowlistRoots,
  resolveDirectoryPath
} from "../../swarm/cwd-policy.js";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import {
  applyCorsHeaders,
  parseJsonBody,
  resolveReadFileContentType,
  sendJson
} from "../http-utils.js";
import type { HttpRoute } from "./http-route.js";

const READ_FILE_ENDPOINT_PATH = "/api/read-file";
const READ_FILE_METHODS = "GET, POST, OPTIONS";
const MAX_READ_FILE_BODY_BYTES = 64 * 1024;
const MAX_READ_FILE_CONTENT_BYTES = 2 * 1024 * 1024;

export function createFileRoutes(options: { swarmManager: SwarmManager }): HttpRoute[] {
  const { swarmManager } = options;

  return [
    {
      methods: READ_FILE_METHODS,
      matches: (pathname) => pathname === READ_FILE_ENDPOINT_PATH,
      handle: async (request, response, requestUrl) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, READ_FILE_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }

        if (request.method !== "POST" && request.method !== "GET") {
          applyCorsHeaders(request, response, READ_FILE_METHODS);
          response.setHeader("Allow", READ_FILE_METHODS);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        applyCorsHeaders(request, response, READ_FILE_METHODS);

        try {
          let requestedPath = "";

          if (request.method === "GET") {
            const pathFromQuery = requestUrl.searchParams.get("path");
            if (typeof pathFromQuery !== "string" || pathFromQuery.trim().length === 0) {
              sendJson(response, 400, { error: "path must be a non-empty string." });
              return;
            }
            requestedPath = pathFromQuery;
          } else {
            const payload = await parseJsonBody(request, MAX_READ_FILE_BODY_BYTES);
            if (!payload || typeof payload !== "object") {
              sendJson(response, 400, { error: "Request body must be a JSON object." });
              return;
            }

            const pathFromBody = (payload as { path?: unknown }).path;
            if (typeof pathFromBody !== "string" || pathFromBody.trim().length === 0) {
              sendJson(response, 400, { error: "path must be a non-empty string." });
              return;
            }

            requestedPath = pathFromBody;
          }

          if (requestedPath.trim().length === 0) {
            sendJson(response, 400, { error: "path must be a non-empty string." });
            return;
          }

          const config = swarmManager.getConfig();
          const resolvedPath = resolveDirectoryPath(requestedPath, config.paths.projectRoot);
          const allowedRoots = normalizeAllowlistRoots([
            ...config.cwdAllowlistRoots,
            config.paths.projectRoot,
            homedir(),
            "/tmp"
          ]);

          if (!(await isPathWithinRoots(resolvedPath, allowedRoots))) {
            sendJson(response, 403, { error: "Path is outside allowed roots." });
            return;
          }

          let fileStats;
          try {
            fileStats = await stat(resolvedPath);
          } catch {
            sendJson(response, 404, { error: "File not found." });
            return;
          }

          if (!fileStats.isFile()) {
            sendJson(response, 400, { error: "Requested path must point to a file." });
            return;
          }

          if (fileStats.size > MAX_READ_FILE_CONTENT_BYTES) {
            sendJson(response, 413, {
              error: `File is too large. Maximum supported size is ${MAX_READ_FILE_CONTENT_BYTES} bytes.`
            });
            return;
          }

          if (request.method === "GET") {
            const content = await readFile(resolvedPath);
            response.statusCode = 200;
            response.setHeader("Content-Type", resolveReadFileContentType(resolvedPath));
            response.setHeader("Content-Length", String(content.byteLength));
            response.setHeader("Cache-Control", "no-store");
            response.end(content);
            return;
          }

          const content = await readFile(resolvedPath, "utf8");
          sendJson(response, 200, {
            path: resolvedPath,
            content
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unable to read file.";

          if (message.includes("Request body exceeds")) {
            sendJson(response, 413, { error: message });
            return;
          }

          if (message.includes("valid JSON")) {
            sendJson(response, 400, { error: message });
            return;
          }

          sendJson(response, 500, { error: message });
        }
      }
    }
  ];
}
