import { describe, expect, it, vi } from "vitest";
import { createSchedulerRoutes } from "../ws/routes/scheduler-routes.js";

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
    const app = createSchedulerRoutes({ swarmManager: swarmManager as never });
    const response = await app.request("http://127.0.0.1:47187/api/managers/manager-1/schedules", {
      method: "GET",
      headers: {
        origin: "http://127.0.0.1:47188",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      schedules: [expect.objectContaining({ id: "schedule-1" })],
    });
    expect(swarmManager.listSchedulesForManager).toHaveBeenCalledWith("manager-1");
  });

  it("creates a schedule over HTTP", async () => {
    const swarmManager = createManagerStub();
    const app = createSchedulerRoutes({ swarmManager: swarmManager as never });
    const response = await app.request("http://127.0.0.1:47187/api/managers/manager-1/schedules", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:47188",
      },
      body: JSON.stringify({
        cron: "30 14 * * *",
        message: "Check deployment status",
        description: "Deployment check",
        oneShot: true,
        timezone: "UTC",
      }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
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
    const app = createSchedulerRoutes({ swarmManager: swarmManager as never });
    const response = await app.request(
      "http://127.0.0.1:47187/api/managers/manager-1/schedules/schedule-2",
      {
        method: "DELETE",
        headers: {
          origin: "http://127.0.0.1:47188",
        },
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
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
    const app = createSchedulerRoutes({ swarmManager: swarmManager as never });
    const response = await app.request("http://127.0.0.1:47187/api/managers/manager-1/schedules", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:47188",
      },
      body: JSON.stringify({
        cron: "30 14 * * *",
        message: "Check deployment status",
        oneShot: "yes",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Schedule oneShot must be a boolean.",
    });
    expect(swarmManager.createScheduleForManager).not.toHaveBeenCalled();
  });
});
