export interface ScheduledTask {
  id: string;
  managerId: string;
  name: string;
  description?: string;
  cron: string;
  message: string;
  enabled: boolean;
  oneShot: boolean;
  timezone: string;
  createdAt: string;
  updatedAt: string;
  nextFireAt: string;
  lastFiredAt?: string;
}

export interface CreateScheduledTaskInput {
  name?: string;
  description?: string;
  cron: string;
  message: string;
  enabled?: boolean;
  oneShot?: boolean;
  timezone?: string;
}
