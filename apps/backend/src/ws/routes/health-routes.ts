import { readFile, rm } from "node:fs/promises";
import { RESTART_SIGNAL } from "../../reboot/control-pid.js";
import {
  applyCorsHeaders,
  sendJson
} from "../http-utils.js";
import type { HttpRoute } from "./http-route.js";

const HEALTH_ENDPOINT_PATH = "/api/health";
const REBOOT_ENDPOINT_PATH = "/api/reboot";

export function createHealthRoutes(options: { resolveControlPidFiles: () => string[] }): HttpRoute[] {
  const { resolveControlPidFiles } = options;

  return [
    {
      methods: "GET, OPTIONS",
      matches: (pathname) => pathname === HEALTH_ENDPOINT_PATH,
      handle: async (request, response) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, "GET, OPTIONS");
          response.statusCode = 204;
          response.end();
          return;
        }

        if (request.method !== "GET") {
          applyCorsHeaders(request, response, "GET, OPTIONS");
          response.setHeader("Allow", "GET, OPTIONS");
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        applyCorsHeaders(request, response, "GET, OPTIONS");
        sendJson(response, 200, { ok: true });
      }
    },
    {
      methods: "POST, OPTIONS",
      matches: (pathname) => pathname === REBOOT_ENDPOINT_PATH,
      handle: async (request, response) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, "POST, OPTIONS");
          response.statusCode = 204;
          response.end();
          return;
        }

        if (request.method !== "POST") {
          applyCorsHeaders(request, response, "POST, OPTIONS");
          response.setHeader("Allow", "POST, OPTIONS");
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        applyCorsHeaders(request, response, "POST, OPTIONS");
        sendJson(response, 200, { ok: true });

        const rebootTimer = setTimeout(() => {
          void triggerRebootSignal(resolveControlPidFiles());
        }, 25);
        rebootTimer.unref();
      }
    }
  ];
}

async function triggerRebootSignal(pidFiles: readonly string[]): Promise<void> {
  try {
    const daemonPid = await resolveProdDaemonPid(pidFiles);
    const targetPid = daemonPid ?? process.pid;

    process.kill(targetPid, RESTART_SIGNAL);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[reboot] Failed to send ${RESTART_SIGNAL}: ${message}`);
  }
}

async function resolveProdDaemonPid(pidFiles: readonly string[]): Promise<number | null> {
  for (const pidFile of pidFiles) {
    const pid = await readRunningPidFromFile(pidFile);
    if (pid !== null) {
      return pid;
    }
  }

  return null;
}

async function readRunningPidFromFile(pidFile: string): Promise<number | null> {
  let pidFileContents: string;
  try {
    pidFileContents = await readFile(pidFile, "utf8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return null;
    }

    throw error;
  }

  const pid = Number.parseInt(pidFileContents.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  try {
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ESRCH"
    ) {
      await rm(pidFile, { force: true });
    }

    return null;
  }
}
