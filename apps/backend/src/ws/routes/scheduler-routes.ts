import { Hono } from "hono";
import type { CreateScheduledTaskInput } from "../../scheduler/schedule-types.js";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import {
  DEFAULT_MAX_HTTP_BODY_SIZE_BYTES,
  createBodyLimit,
  createCorsMiddleware,
  createMethodGuard,
  readJsonBody,
  type NodeServerEnv,
} from "../hono-utils.js";

const MANAGER_SCHEDULES_ENDPOINT_PATH = "/api/managers/:managerId/schedules";
const MANAGER_SCHEDULE_ENDPOINT_PATH = "/api/managers/:managerId/schedules/:scheduleId";
const MANAGER_SCHEDULES_METHODS = ["GET", "POST"] as const;
const MANAGER_SCHEDULE_METHODS = ["DELETE"] as const;

export function createSchedulerRoutes(options: {
  swarmManager: SwarmManager;
}): Hono<NodeServerEnv> {
  const { swarmManager } = options;
  const app = new Hono<NodeServerEnv>();

  app.use(MANAGER_SCHEDULES_ENDPOINT_PATH, createCorsMiddleware(MANAGER_SCHEDULES_METHODS));
  app.use(MANAGER_SCHEDULES_ENDPOINT_PATH, createMethodGuard(MANAGER_SCHEDULES_METHODS));
  app.get(MANAGER_SCHEDULES_ENDPOINT_PATH, async (c) => {
    const managerId = c.req.param("managerId");

    if (!isManagerAgent(swarmManager, managerId)) {
      return c.json({ error: `Unknown manager: ${managerId}` }, 404);
    }

    return c.json({
      schedules: await swarmManager.listSchedulesForManager(managerId),
    });
  });
  app.post(
    MANAGER_SCHEDULES_ENDPOINT_PATH,
    createBodyLimit(
      DEFAULT_MAX_HTTP_BODY_SIZE_BYTES,
      `Request body too large. Max ${DEFAULT_MAX_HTTP_BODY_SIZE_BYTES} bytes.`,
      400,
    ),
    async (c) => {
      const managerId = c.req.param("managerId");

      if (!isManagerAgent(swarmManager, managerId)) {
        return c.json({ error: `Unknown manager: ${managerId}` }, 404);
      }

      try {
        const schedule = await swarmManager.createScheduleForManager(
          managerId,
          parseCreateScheduleBody(
            await readJsonBody(c, {
              emptyValue: {},
              invalidJsonMessage: "Request body must be valid JSON",
            }),
          ),
        );

        return c.json(
          {
            ok: true,
            action: "add",
            managerId,
            schedule,
          },
          201,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return c.json({ error: message }, 400);
      }
    },
  );

  app.use(MANAGER_SCHEDULE_ENDPOINT_PATH, createCorsMiddleware(MANAGER_SCHEDULE_METHODS));
  app.use(MANAGER_SCHEDULE_ENDPOINT_PATH, createMethodGuard(MANAGER_SCHEDULE_METHODS));
  app.delete(MANAGER_SCHEDULE_ENDPOINT_PATH, async (c) => {
    const managerId = c.req.param("managerId");
    const scheduleId = c.req.param("scheduleId");

    if (!isManagerAgent(swarmManager, managerId)) {
      return c.json({ error: `Unknown manager: ${managerId}` }, 404);
    }

    try {
      const schedule = await swarmManager.removeScheduleForManager(managerId, scheduleId);
      return c.json({
        ok: true,
        action: "remove",
        managerId,
        schedule,
        removed: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = message.startsWith("Unknown schedule:") ? 404 : 400;
      return c.json({ error: message }, statusCode);
    }
  });

  return app;
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
