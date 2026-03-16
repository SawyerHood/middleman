import type { CreateScheduledTaskInput } from "../../scheduler/schedule-types.js";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import {
  applyCorsHeaders,
  decodePathSegment,
  matchPathPattern,
  readJsonBody,
  sendJson,
} from "../http-utils.js";
import type { HttpRoute } from "./http-route.js";

const MANAGER_SCHEDULES_ENDPOINT_PATTERN = /^\/api\/managers\/([^/]+)\/schedules$/;
const MANAGER_SCHEDULE_ENDPOINT_PATTERN = /^\/api\/managers\/([^/]+)\/schedules\/([^/]+)$/;

export function createSchedulerRoutes(options: { swarmManager: SwarmManager }): HttpRoute[] {
  const { swarmManager } = options;

  return [
    {
      methods: "GET, POST, OPTIONS",
      matches: (pathname) => MANAGER_SCHEDULES_ENDPOINT_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        const methods = "GET, POST, OPTIONS";

        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, methods);
          response.statusCode = 204;
          response.end();
          return;
        }

        applyCorsHeaders(request, response, methods);

        const route = resolveManagerSchedulesRoute(requestUrl.pathname);
        if (!route) {
          response.setHeader("Allow", methods);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        if (!isManagerAgent(swarmManager, route.managerId)) {
          sendJson(response, 404, { error: `Unknown manager: ${route.managerId}` });
          return;
        }

        if (request.method === "GET") {
          sendJson(response, 200, {
            schedules: await swarmManager.listSchedulesForManager(route.managerId),
          });
          return;
        }

        if (request.method === "POST") {
          try {
            const schedule = await swarmManager.createScheduleForManager(
              route.managerId,
              parseCreateScheduleBody(await readJsonBody(request)),
            );
            sendJson(response, 201, {
              ok: true,
              action: "add",
              managerId: route.managerId,
              schedule,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            sendJson(response, 400, { error: message });
          }
          return;
        }

        response.setHeader("Allow", methods);
        sendJson(response, 405, { error: "Method Not Allowed" });
      },
    },
    {
      methods: "DELETE, OPTIONS",
      matches: (pathname) => MANAGER_SCHEDULE_ENDPOINT_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        const methods = "DELETE, OPTIONS";

        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, methods);
          response.statusCode = 204;
          response.end();
          return;
        }

        applyCorsHeaders(request, response, methods);

        const route = resolveManagerScheduleRoute(requestUrl.pathname);
        if (!route) {
          response.setHeader("Allow", methods);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        if (!isManagerAgent(swarmManager, route.managerId)) {
          sendJson(response, 404, { error: `Unknown manager: ${route.managerId}` });
          return;
        }

        if (request.method !== "DELETE") {
          response.setHeader("Allow", methods);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        try {
          const schedule = await swarmManager.removeScheduleForManager(
            route.managerId,
            route.scheduleId,
          );
          sendJson(response, 200, {
            ok: true,
            action: "remove",
            managerId: route.managerId,
            schedule,
            removed: true,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const statusCode = message.startsWith("Unknown schedule:") ? 404 : 400;
          sendJson(response, statusCode, { error: message });
        }
      },
    },
  ];
}

type ManagerSchedulesRoute = {
  managerId: string;
};

type ManagerScheduleRoute = ManagerSchedulesRoute & {
  scheduleId: string;
};

function resolveManagerSchedulesRoute(pathname: string): ManagerSchedulesRoute | null {
  const managerMatch = matchPathPattern(pathname, MANAGER_SCHEDULES_ENDPOINT_PATTERN);
  if (!managerMatch) {
    return null;
  }

  const managerId = decodePathSegment(managerMatch[1]);
  if (!managerId) {
    return null;
  }

  return { managerId };
}

function resolveManagerScheduleRoute(pathname: string): ManagerScheduleRoute | null {
  const scheduleMatch = matchPathPattern(pathname, MANAGER_SCHEDULE_ENDPOINT_PATTERN);
  if (!scheduleMatch) {
    return null;
  }

  const managerId = decodePathSegment(scheduleMatch[1]);
  const scheduleId = decodePathSegment(scheduleMatch[2]);
  if (!managerId || !scheduleId) {
    return null;
  }

  return { managerId, scheduleId };
}

function isManagerAgent(swarmManager: SwarmManager, managerId: string): boolean {
  const descriptor = swarmManager.getAgent(managerId);
  return Boolean(descriptor && descriptor.role === "manager");
}

function parseCreateScheduleBody(body: unknown): CreateScheduledTaskInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Schedule payload must be a JSON object.");
  }

  const payload = body as Record<string, unknown>;
  const cron = parseRequiredString(payload.cron, "cron");
  const message = parseRequiredString(payload.message, "message");

  return {
    cron,
    message,
    name: parseOptionalString(payload.name, "name"),
    description: parseOptionalString(payload.description, "description"),
    timezone: parseOptionalString(payload.timezone, "timezone"),
    oneShot: parseOptionalBoolean(payload.oneShot, "oneShot"),
    enabled: parseOptionalBoolean(payload.enabled, "enabled"),
  };
}

function parseRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Schedule ${fieldName} is required.`);
  }

  return value.trim();
}

function parseOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Schedule ${fieldName} must be a non-empty string.`);
  }

  return value.trim();
}

function parseOptionalBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new Error(`Schedule ${fieldName} must be a boolean.`);
  }

  return value;
}
