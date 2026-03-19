import { afterEach, describe, expect, it, vi } from "vitest";
import { CronSchedulerService } from "../scheduler/cron-scheduler-service.js";
import type { ScheduledTask } from "../scheduler/schedule-types.js";
import type { SwarmManager } from "../swarm/swarm-manager.js";

function createSchedule(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "schedule-1",
    managerId: "manager",
    name: "Daily summary",
    description: "Daily summary",
    cron: "* * * * *",
    message: "Summarize unresolved issues from the board.",
    enabled: true,
    oneShot: false,
    timezone: "UTC",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nextFireAt: "2025-12-31T23:59:00.000Z",
    ...overrides,
  };
}

function createFakeSwarmManager(
  initialSchedules: ScheduledTask[],
  handleUserMessage = vi.fn(async () => undefined),
) {
  const schedules = new Map(initialSchedules.map((schedule) => [schedule.id, { ...schedule }]));

  const listSchedulesForManager = vi.fn(async (managerId: string) =>
    [...schedules.values()]
      .filter((schedule) => schedule.managerId === managerId)
      .sort((left, right) => left.nextFireAt.localeCompare(right.nextFireAt))
      .map((schedule) => ({ ...schedule })),
  );

  const updateScheduleForManager = vi.fn(async (managerId: string, schedule: ScheduledTask) => {
    if (schedule.managerId !== managerId) {
      throw new Error(`Schedule ${schedule.id} does not belong to manager ${managerId}.`);
    }
    schedules.set(schedule.id, { ...schedule });
    return { ...schedule };
  });

  const removeScheduleForManager = vi.fn(async (managerId: string, scheduleId: string) => {
    const schedule = schedules.get(scheduleId);
    if (!schedule || schedule.managerId !== managerId) {
      throw new Error(`Unknown schedule: ${scheduleId}`);
    }
    schedules.delete(scheduleId);
    return { ...schedule };
  });

  const swarmManager = {
    handleUserMessage,
    listSchedulesForManager,
    removeScheduleForManager,
    updateScheduleForManager,
  } as unknown as SwarmManager;

  return {
    swarmManager,
    handleUserMessage,
    listSchedulesForManager,
    removeScheduleForManager,
    updateScheduleForManager,
    snapshot() {
      return [...schedules.values()]
        .sort((left, right) => left.nextFireAt.localeCompare(right.nextFireAt))
        .map((schedule) => ({ ...schedule }));
    },
    upsert(schedule: ScheduledTask) {
      schedules.set(schedule.id, { ...schedule });
    },
  };
}

describe("CronSchedulerService", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires due one-shot schedules on startup and removes them", async () => {
    const dueAt = new Date("2025-12-31T23:59:00.000Z").toISOString();
    const fakeManager = createFakeSwarmManager([
      createSchedule({
        oneShot: true,
        nextFireAt: dueAt,
      }),
    ]);

    const service = new CronSchedulerService({
      swarmManager: fakeManager.swarmManager,
      managerId: "manager",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      pollIntervalMs: 5_000,
    });

    await service.start();
    await service.stop();

    expect(fakeManager.handleUserMessage).toHaveBeenCalledTimes(1);
    const [message, options] = fakeManager.handleUserMessage.mock.calls[0] as unknown as [
      string,
      { targetAgentId: string; sourceContext: { channel: string } },
    ];
    expect(message).toContain("[Scheduled Task: Daily summary]");
    expect(message).toContain('"scheduleId":"schedule-1"');
    expect(options).toEqual({
      targetAgentId: "manager",
      sourceContext: { channel: "web" },
    });
    expect(fakeManager.snapshot()).toEqual([]);
  });

  it("advances recurring schedules and records lastFiredAt after a successful dispatch", async () => {
    const dueAt = new Date("2025-12-31T23:59:00.000Z").toISOString();
    const fakeManager = createFakeSwarmManager([
      createSchedule({
        nextFireAt: dueAt,
      }),
    ]);

    const service = new CronSchedulerService({
      swarmManager: fakeManager.swarmManager,
      managerId: "manager",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      pollIntervalMs: 5_000,
    });

    await service.start();
    await service.stop();

    const schedules = fakeManager.snapshot();
    expect(fakeManager.handleUserMessage).toHaveBeenCalledTimes(1);
    expect(schedules).toHaveLength(1);
    expect(schedules[0]?.lastFiredAt).toBe(dueAt);
    expect(Date.parse(schedules[0]?.nextFireAt ?? "")).toBeGreaterThan(Date.parse(dueAt));
  });

  it("does not mutate schedule state when dispatch fails", async () => {
    const dueAt = new Date("2025-12-31T23:59:00.000Z").toISOString();
    const original = createSchedule({
      nextFireAt: dueAt,
    });
    const fakeManager = createFakeSwarmManager(
      [original],
      vi.fn(async () => {
        throw new Error("manager unavailable");
      }),
    );

    const service = new CronSchedulerService({
      swarmManager: fakeManager.swarmManager,
      managerId: "manager",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      pollIntervalMs: 5_000,
    });

    await service.start();
    await service.stop();

    expect(fakeManager.handleUserMessage).toHaveBeenCalledTimes(1);
    expect(fakeManager.snapshot()).toEqual([original]);
  });

  it("suppresses duplicate recurring occurrences already marked as fired", async () => {
    const dueAt = new Date("2025-12-31T23:59:00.000Z").toISOString();
    const fakeManager = createFakeSwarmManager([
      createSchedule({
        nextFireAt: dueAt,
        lastFiredAt: dueAt,
      }),
    ]);

    const service = new CronSchedulerService({
      swarmManager: fakeManager.swarmManager,
      managerId: "manager",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      pollIntervalMs: 5_000,
    });

    await service.start();
    await service.stop();

    const schedules = fakeManager.snapshot();
    expect(fakeManager.handleUserMessage).toHaveBeenCalledTimes(0);
    expect(schedules).toHaveLength(1);
    expect(schedules[0]?.lastFiredAt).toBe(dueAt);
    expect(Date.parse(schedules[0]?.nextFireAt ?? "")).toBeGreaterThan(Date.parse(dueAt));
  });

  it("refreshes immediately after a new due schedule is added", async () => {
    const fakeManager = createFakeSwarmManager([]);
    const service = new CronSchedulerService({
      swarmManager: fakeManager.swarmManager,
      managerId: "manager",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      pollIntervalMs: 60_000,
    });

    await service.start();
    fakeManager.upsert(
      createSchedule({
        id: "schedule-2",
        nextFireAt: "2025-12-31T23:59:00.000Z",
        oneShot: true,
      }),
    );

    service.refresh();
    await service.stop();

    expect(fakeManager.handleUserMessage).toHaveBeenCalledTimes(1);
    expect(fakeManager.removeScheduleForManager).toHaveBeenCalledWith("manager", "schedule-2");
    expect(fakeManager.snapshot()).toEqual([]);
  });
});
