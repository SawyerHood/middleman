import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { createConfig, type CreateConfigOptions } from "./config.js";
import {
  DAEMONIZED_ENV_VAR,
  getControlPidFilePath,
  RESTART_PARENT_PID_ENV_VAR,
  RESTART_SIGNAL,
  SUPPRESS_OPEN_ON_RESTART_ENV_VAR,
} from "./reboot/control-pid.js";
import { CronSchedulerService } from "./scheduler/cron-scheduler-service.js";
import { SwarmManager } from "./swarm/swarm-manager.js";
import type { AgentDescriptor, SwarmConfig } from "./swarm/types.js";
import { SwarmWebSocketServer } from "./ws/server.js";

export interface StartServerOptions extends CreateConfigOptions {
  loadEnvFiles?: boolean;
  registerSignalHandlers?: boolean;
}

export interface StartedMiddlemanServer {
  config: SwarmConfig;
  stop: () => Promise<void>;
}

export async function startServer(
  options: StartServerOptions = {},
): Promise<StartedMiddlemanServer> {
  await waitForRestartParentToExit();

  const projectRoot = resolveProjectRootOption(options.projectRoot);
  const dataDir = resolveDataDirOption(options.dataDir);

  if (options.loadEnvFiles !== false) {
    loadRuntimeEnvFiles(projectRoot, dataDir);
  }

  const config = createConfig({
    ...options,
    projectRoot,
    dataDir,
  });

  const swarmManager = new SwarmManager(config);
  await swarmManager.boot();

  const schedulersByManagerId = new Map<string, CronSchedulerService>();
  let schedulerLifecycle: Promise<void> = Promise.resolve();

  const syncSchedulers = async (managerIds: Set<string>): Promise<void> => {
    for (const managerId of managerIds) {
      if (schedulersByManagerId.has(managerId)) {
        continue;
      }

      const scheduler = new CronSchedulerService({
        swarmManager,
        managerId,
      });
      await scheduler.start();
      schedulersByManagerId.set(managerId, scheduler);
    }

    for (const [managerId, scheduler] of schedulersByManagerId.entries()) {
      if (managerIds.has(managerId)) {
        continue;
      }

      await scheduler.stop();
      schedulersByManagerId.delete(managerId);
    }
  };

  const queueSchedulerSync = (managerIds: Set<string>): Promise<void> => {
    const next = schedulerLifecycle.then(
      () => syncSchedulers(managerIds),
      () => syncSchedulers(managerIds),
    );
    schedulerLifecycle = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  await queueSchedulerSync(collectManagerIds(swarmManager.listAgents()));

  const handleAgentsSnapshot = (event: unknown): void => {
    if (!event || typeof event !== "object") {
      return;
    }

    const payload = event as { type?: string; agents?: unknown };
    if (payload.type !== "agents_snapshot" || !Array.isArray(payload.agents)) {
      return;
    }

    const managerIds = collectManagerIds(payload.agents);
    void queueSchedulerSync(managerIds).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[scheduler] Failed to sync scheduler instances: ${message}`);
    });
  };

  swarmManager.on("agents_snapshot", handleAgentsSnapshot);
  const handleScheduleChanged = (event: unknown): void => {
    if (!event || typeof event !== "object") {
      return;
    }

    const payload = event as { managerId?: unknown };
    const managerId = typeof payload.managerId === "string" ? payload.managerId.trim() : "";
    if (!managerId) {
      return;
    }

    schedulersByManagerId.get(managerId)?.refresh();
  };
  swarmManager.on("schedule_changed", handleScheduleChanged);

  const wsServer = new SwarmWebSocketServer({
    swarmManager,
    host: config.host,
    port: config.port,
    uiDir: config.paths.uiDir,
  });
  await wsServer.start();

  const shouldManageControlPid =
    options.registerSignalHandlers !== false && process.env[DAEMONIZED_ENV_VAR] !== "1";
  const controlPidFile = getControlPidFilePath(config.paths.runDir);
  let managingControlPid = false;
  if (shouldManageControlPid) {
    try {
      managingControlPid = await tryWriteControlPidFile(controlPidFile);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[reboot] Failed to write control pid file: ${message}`);
    }
  }

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }

    stopped = true;
    swarmManager.off("agents_snapshot", handleAgentsSnapshot);
    swarmManager.off("schedule_changed", handleScheduleChanged);
    await Promise.allSettled([
      queueSchedulerSync(new Set<string>()),
      wsServer.stop(),
      swarmManager.shutdown(),
    ]);

    if (managingControlPid) {
      await removeOwnedControlPidFile(controlPidFile);
      managingControlPid = false;
    }
  };

  if (options.registerSignalHandlers !== false) {
    let restarting = false;

    const shutdown = async (signal: string): Promise<void> => {
      console.log(`Received ${signal}. Shutting down...`);
      await stop();
      process.exit(0);
    };

    const restart = async (): Promise<void> => {
      if (restarting || stopped) {
        return;
      }

      restarting = true;
      console.log(`Received ${RESTART_SIGNAL}. Rebooting...`);

      try {
        await spawnReplacementProcess();
        await stop();
        process.exit(0);
      } catch (error) {
        restarting = false;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[reboot] Failed to restart current process: ${message}`);
      }
    };

    process.on("SIGINT", () => {
      void shutdown("SIGINT");
    });

    process.on("SIGTERM", () => {
      void shutdown("SIGTERM");
    });

    if (process.env[DAEMONIZED_ENV_VAR] !== "1") {
      process.on(RESTART_SIGNAL, () => {
        void restart();
      });
    }
  }

  return {
    config,
    stop,
  };
}

async function main(): Promise<void> {
  const { config } = await startServer();
  console.log(`Middleman listening on http://${config.host}:${config.port}`);
}

function collectManagerIds(agents: unknown[]): Set<string> {
  const managerIds = new Set<string>();

  for (const agent of agents) {
    if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
      continue;
    }

    const descriptor = agent as Partial<AgentDescriptor>;
    if (descriptor.role !== "manager") {
      continue;
    }

    if (typeof descriptor.agentId !== "string" || descriptor.agentId.trim().length === 0) {
      continue;
    }

    managerIds.add(descriptor.agentId.trim());
  }

  return managerIds;
}

function loadRuntimeEnvFiles(projectRoot: string, dataDir: string): void {
  const projectEnvFile = resolve(projectRoot, ".env");
  const userEnvFile = resolve(dataDir, "config.env");

  for (const envFile of [projectEnvFile, userEnvFile]) {
    if (!existsSync(envFile)) {
      continue;
    }

    loadDotenv({ path: envFile, override: false });
  }
}

function resolveProjectRootOption(projectRoot?: string): string {
  const configuredProjectRoot = projectRoot ?? process.env.MIDDLEMAN_PROJECT_ROOT;
  if (typeof configuredProjectRoot === "string" && configuredProjectRoot.trim().length > 0) {
    return resolve(configuredProjectRoot);
  }

  return resolve(process.cwd());
}

function resolveDataDirOption(dataDir?: string): string {
  const configuredDataDir = dataDir ?? process.env.MIDDLEMAN_HOME;
  if (typeof configuredDataDir === "string" && configuredDataDir.trim().length > 0) {
    return resolve(configuredDataDir);
  }

  return resolve(homedir(), ".middleman");
}

async function waitForRestartParentToExit(): Promise<void> {
  const rawParentPid = process.env[RESTART_PARENT_PID_ENV_VAR];
  if (typeof rawParentPid !== "string" || rawParentPid.trim().length === 0) {
    return;
  }

  delete process.env[RESTART_PARENT_PID_ENV_VAR];

  const parentPid = Number.parseInt(rawParentPid.trim(), 10);
  if (!Number.isInteger(parentPid) || parentPid <= 0) {
    return;
  }

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      process.kill(parentPid, 0);
    } catch (error) {
      if (isErrorWithCode(error, "ESRCH")) {
        return;
      }

      throw error;
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
}

async function tryWriteControlPidFile(pidFile: string): Promise<boolean> {
  await mkdir(dirname(pidFile), { recursive: true });

  let existingPid: number | null = null;
  try {
    const raw = await readFile(pidFile, "utf8");
    const parsed = Number.parseInt(raw.trim(), 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      existingPid = parsed;
    }
  } catch (error) {
    if (!isErrorWithCode(error, "ENOENT")) {
      throw error;
    }
  }

  if (existingPid !== null && existingPid !== process.pid) {
    try {
      process.kill(existingPid, 0);
      console.warn(`[reboot] Control pid file is already owned by pid ${existingPid}: ${pidFile}`);
      return false;
    } catch (error) {
      if (!isErrorWithCode(error, "ESRCH")) {
        throw error;
      }
    }
  }

  await writeFile(pidFile, `${process.pid}\n`, "utf8");
  return true;
}

async function removeOwnedControlPidFile(pidFile: string): Promise<void> {
  try {
    const raw = await readFile(pidFile, "utf8");
    const parsed = Number.parseInt(raw.trim(), 10);
    if (parsed !== process.pid) {
      return;
    }
  } catch (error) {
    if (isErrorWithCode(error, "ENOENT")) {
      return;
    }

    throw error;
  }

  await rm(pidFile, { force: true });
}

async function spawnReplacementProcess(): Promise<void> {
  const replacementArgs = [...process.execArgv, ...process.argv.slice(1)];
  const replacementEnv = {
    ...process.env,
    [RESTART_PARENT_PID_ENV_VAR]: `${process.pid}`,
    [SUPPRESS_OPEN_ON_RESTART_ENV_VAR]: "1",
  };

  await new Promise<void>((resolveSpawn, reject) => {
    const child = spawn(process.execPath, replacementArgs, {
      cwd: process.cwd(),
      env: replacementEnv,
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("spawn", () => {
      resolveSpawn();
    });
  });
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file://").href) {
  void main().catch((error) => {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "EADDRINUSE"
    ) {
      const config = createConfig();
      console.error(
        `Failed to start backend: http://${config.host}:${config.port} is already in use. ` +
          `Stop the other process or run with MIDDLEMAN_PORT=<port>.`,
      );
    } else {
      console.error(error);
    }
    process.exit(1);
  });
}
