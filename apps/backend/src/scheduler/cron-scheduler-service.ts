import { computeNextFireAt } from "./schedule-utils.js";
import type { ScheduledTask } from "./schedule-types.js";
import type { SwarmManager } from "../swarm/swarm-manager.js";

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const MIN_POLL_INTERVAL_MS = 5_000;

interface CronSchedulerServiceOptions {
  swarmManager: SwarmManager;
  managerId: string;
  pollIntervalMs?: number;
  now?: () => Date;
}

export class CronSchedulerService {
  private readonly swarmManager: SwarmManager;
  private readonly managerId: string;
  private readonly pollIntervalMs: number;
  private readonly now: () => Date;

  private running = false;
  private processing = false;
  private pendingProcess = false;
  private pollTimer?: NodeJS.Timeout;
  private activeRunPromise?: Promise<void>;
  private readonly firedOccurrenceKeys = new Set<string>();

  constructor(options: CronSchedulerServiceOptions) {
    this.swarmManager = options.swarmManager;
    this.managerId = options.managerId;
    this.pollIntervalMs = normalizePollIntervalMs(options.pollIntervalMs);
    this.now = options.now ?? (() => new Date());
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    await this.processDueSchedules("startup");
    this.startPolling();
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.running = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    await this.activeRunPromise;
  }

  refresh(): void {
    this.requestProcess("refresh");
  }

  private startPolling(): void {
    this.pollTimer = setInterval(() => {
      this.requestProcess("poll");
    }, this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  private requestProcess(reason: string): void {
    if (!this.running) {
      return;
    }

    if (this.processing) {
      this.pendingProcess = true;
      return;
    }

    this.processing = true;
    const run = this.processDueSchedules(reason)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[scheduler] Processing failed (${reason}): ${message}`);
      })
      .finally(() => {
        this.processing = false;
        if (this.pendingProcess && this.running) {
          this.pendingProcess = false;
          this.requestProcess("pending");
        }
      });

    this.activeRunPromise = run.finally(() => {
      if (this.activeRunPromise === run) {
        this.activeRunPromise = undefined;
      }
    });
  }

  private async processDueSchedules(_reason: string): Promise<void> {
    const snapshot = await this.swarmManager.listSchedulesForManager(this.managerId);
    if (snapshot.length === 0) {
      return;
    }

    const now = this.now();

    for (const schedule of snapshot) {
      if (!schedule.enabled) {
        continue;
      }

      const normalized = this.ensureValidNextFireAt(schedule, now);
      let activeSchedule = normalized.schedule;

      if (normalized.changed) {
        await this.swarmManager.updateScheduleForManager(this.managerId, activeSchedule);
      }

      const scheduledFor = parseIsoDate(activeSchedule.nextFireAt);
      if (!scheduledFor || scheduledFor.getTime() > now.getTime()) {
        continue;
      }

      const scheduledForIso = scheduledFor.toISOString();
      const occurrenceKey = buildOccurrenceKey(activeSchedule.id, scheduledForIso);
      if (
        activeSchedule.lastFiredAt === scheduledForIso ||
        this.firedOccurrenceKeys.has(occurrenceKey)
      ) {
        if (activeSchedule.oneShot) {
          await this.swarmManager.removeScheduleForManager(this.managerId, activeSchedule.id);
        } else {
          await this.swarmManager.updateScheduleForManager(
            this.managerId,
            this.advanceRecurringSchedule(activeSchedule, scheduledFor),
          );
        }
        continue;
      }

      const fired = await this.dispatchSchedule(activeSchedule, scheduledForIso);
      if (!fired) {
        continue;
      }

      this.firedOccurrenceKeys.add(occurrenceKey);
      if (this.firedOccurrenceKeys.size > 10_000) {
        this.firedOccurrenceKeys.clear();
      }

      if (activeSchedule.oneShot) {
        await this.swarmManager.removeScheduleForManager(this.managerId, activeSchedule.id);
        continue;
      }

      activeSchedule = this.advanceRecurringSchedule(activeSchedule, scheduledFor);
      await this.swarmManager.updateScheduleForManager(this.managerId, activeSchedule);
    }
  }

  private async dispatchSchedule(schedule: ScheduledTask, scheduledForIso: string): Promise<boolean> {
    const scheduleContext = {
      scheduleId: schedule.id,
      name: schedule.name,
      cron: schedule.cron,
      timezone: schedule.timezone,
      oneShot: schedule.oneShot,
      scheduledFor: scheduledForIso,
    };

    const message = [
      `[Scheduled Task: ${schedule.name}]`,
      `[scheduleContext] ${JSON.stringify(scheduleContext)}`,
      "",
      schedule.message,
    ].join("\n");

    try {
      await this.swarmManager.handleUserMessage(message, {
        targetAgentId: this.managerId,
        sourceContext: { channel: "web" },
      });

      console.log(
        `[scheduler] Fired schedule ${schedule.id} (${schedule.name}) for ${scheduledForIso}`,
      );
      return true;
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      console.error(
        `[scheduler] Failed to dispatch schedule ${schedule.id} (${schedule.name}): ${messageText}`,
      );
      return false;
    }
  }

  private advanceRecurringSchedule(schedule: ScheduledTask, scheduledFor: Date): ScheduledTask {
    const nextAfter = new Date(scheduledFor.getTime() + 1_000);
    const fallbackAfter = new Date(this.now().getTime() + 60_000);

    let nextFireAt: string;
    try {
      nextFireAt = computeNextFireAt(schedule.cron, schedule.timezone, nextAfter);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[scheduler] Failed to compute next run for ${schedule.id} (${schedule.name}): ${message}`,
      );
      nextFireAt = computeNextFireAt(schedule.cron, schedule.timezone, fallbackAfter);
    }

    return {
      ...schedule,
      nextFireAt,
      lastFiredAt: scheduledFor.toISOString(),
      updatedAt: this.now().toISOString(),
    };
  }

  private ensureValidNextFireAt(
    schedule: ScheduledTask,
    now: Date,
  ): { schedule: ScheduledTask; changed: boolean } {
    if (parseIsoDate(schedule.nextFireAt)) {
      return { schedule, changed: false };
    }

    try {
      return {
        schedule: {
          ...schedule,
          nextFireAt: computeNextFireAt(schedule.cron, schedule.timezone, now),
          updatedAt: this.now().toISOString(),
        },
        changed: true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[scheduler] Invalid schedule ${schedule.id}: ${message}`);
      return { schedule, changed: false };
    }
  }
}

function normalizePollIntervalMs(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined) {
    return DEFAULT_POLL_INTERVAL_MS;
  }

  return Math.max(MIN_POLL_INTERVAL_MS, Math.floor(value));
}

function parseIsoDate(value: string | undefined): Date | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return undefined;
  }

  return new Date(timestamp);
}

function buildOccurrenceKey(scheduleId: string, scheduledForIso: string): string {
  return `${scheduleId}:${scheduledForIso}`;
}
