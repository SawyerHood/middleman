import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createSchedulerRoutes } from "../ws/routes/scheduler-routes.js";

function createRequest(
  method: string,
  url: string,
  body?: Record<string, unknown>,
): IncomingMessage {
  const request = Readable.from(
    body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")],
  ) as IncomingMessage;
  Object.assign(request, {
    method,
    url,
    headers: {
      host: "127.0.0.1:47187",
      origin: "http://127.0.0.1:47188",
    },
  });
  return request;
}

function createResponse(): ServerResponse & {
  bodyText: string;
  headers: Map<string, string>;
} {
  let bodyText = "";
  const headers = new Map<string, string>();
  const response = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) {
        bodyText += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      }
      return this;
    },
  } as ServerResponse & {
    bodyText: string;
    headers: Map<string, string>;
  };

  Object.defineProperty(response, "bodyText", {
    get() {
      return bodyText;
    },
  });
  Object.defineProperty(response, "headers", {
    get() {
      return headers;
    },
  });

  return response;
}

function parseJson(response: { bodyText: string }): Record<string, unknown> {
  return JSON.parse(response.bodyText) as Record<string, unknown>;
}

function createManagerStub() {
  return {
    getAgent: vi.fn((agentId: string) =>
      agentId === "manager-1"
        ? {
            agentId: "manager-1",
            role: "manager",
          }
        : undefined,
    ),
    listSchedulesForManager: vi.fn(async () => [
      {
        id: "schedule-1",
        managerId: "manager-1",
        name: "Daily summary",
        description: "Daily summary",
        cron: "0 9 * * 1-5",
        message: "Send the summary.",
        enabled: true,
        oneShot: false,
        timezone: "UTC",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        nextFireAt: "2026-01-02T09:00:00.000Z",
      },
    ]),
    createScheduleForManager: vi.fn(async (managerId: string, input: Record<string, unknown>) => ({
      id: "schedule-2",
      managerId,
      name: "Deployment check",
      description: "Deployment check",
      cron: input.cron,
      message: input.message,
      enabled: true,
      oneShot: true,
      timezone: "UTC",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nextFireAt: "2026-01-02T09:00:00.000Z",
    })),
    removeScheduleForManager: vi.fn(async (managerId: string, scheduleId: string) => ({
      id: scheduleId,
      managerId,
      name: "Deployment check",
      description: "Deployment check",
      cron: "30 14 * * *",
      message: "Check deployment status",
      enabled: true,
      oneShot: true,
      timezone: "UTC",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nextFireAt: "2026-01-02T14:30:00.000Z",
    })),
  };
}

describe("createSchedulerRoutes", () => {
  it("lists manager schedules", async () => {
    const swarmManager = createManagerStub();
    const route = createSchedulerRoutes({ swarmManager: swarmManager as never })[0]!;
    const request = createRequest("GET", "/api/managers/manager-1/schedules");
    const response = createResponse();

    await route.handle(
      request,
      response,
      new URL("http://127.0.0.1:47187/api/managers/manager-1/schedules"),
    );

    expect(response.statusCode).toBe(200);
    expect(parseJson(response)).toEqual({
      schedules: [expect.objectContaining({ id: "schedule-1" })],
    });
    expect(swarmManager.listSchedulesForManager).toHaveBeenCalledWith("manager-1");
  });

  it("creates a schedule over HTTP", async () => {
    const swarmManager = createManagerStub();
    const route = createSchedulerRoutes({ swarmManager: swarmManager as never })[0]!;
    const request = createRequest("POST", "/api/managers/manager-1/schedules", {
      cron: "30 14 * * *",
      message: "Check deployment status",
      description: "Deployment check",
      oneShot: true,
      timezone: "UTC",
    });
    const response = createResponse();

    await route.handle(
      request,
      response,
      new URL("http://127.0.0.1:47187/api/managers/manager-1/schedules"),
    );

    expect(response.statusCode).toBe(201);
    expect(parseJson(response)).toEqual({
      ok: true,
      action: "add",
      managerId: "manager-1",
      schedule: expect.objectContaining({ id: "schedule-2" }),
    });
    expect(swarmManager.createScheduleForManager).toHaveBeenCalledWith("manager-1", {
      cron: "30 14 * * *",
      message: "Check deployment status",
      description: "Deployment check",
      oneShot: true,
      timezone: "UTC",
      enabled: undefined,
      name: undefined,
    });
  });

  it("removes a schedule over HTTP", async () => {
    const swarmManager = createManagerStub();
    const route = createSchedulerRoutes({ swarmManager: swarmManager as never })[1]!;
    const request = createRequest("DELETE", "/api/managers/manager-1/schedules/schedule-2");
    const response = createResponse();

    await route.handle(
      request,
      response,
      new URL("http://127.0.0.1:47187/api/managers/manager-1/schedules/schedule-2"),
    );

    expect(response.statusCode).toBe(200);
    expect(parseJson(response)).toEqual({
      ok: true,
      action: "remove",
      managerId: "manager-1",
      schedule: expect.objectContaining({ id: "schedule-2" }),
      removed: true,
    });
    expect(swarmManager.removeScheduleForManager).toHaveBeenCalledWith("manager-1", "schedule-2");
  });

  it("rejects invalid schedule payloads", async () => {
    const swarmManager = createManagerStub();
    const route = createSchedulerRoutes({ swarmManager: swarmManager as never })[0]!;
    const request = createRequest("POST", "/api/managers/manager-1/schedules", {
      cron: "30 14 * * *",
      message: "Check deployment status",
      oneShot: "yes",
    } as never);
    const response = createResponse();

    await route.handle(
      request,
      response,
      new URL("http://127.0.0.1:47187/api/managers/manager-1/schedules"),
    );

    expect(response.statusCode).toBe(400);
    expect(parseJson(response)).toEqual({
      error: "Schedule oneShot must be a boolean.",
    });
    expect(swarmManager.createScheduleForManager).not.toHaveBeenCalled();
  });
});
