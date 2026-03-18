#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getControlPidFilePath,
} from "./prod-daemon-paths.mjs";

const RESTART_SIGNAL = "SIGUSR1";
const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
const FORCE_KILL_AFTER_MS = 15_000;
const DEFAULT_COMMAND = "pnpm prod";
const DEFAULT_INSTALL_COMMAND = "pnpm i";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pidFile = getControlPidFilePath();
const lockFilePath = path.join(repoRoot, "pnpm-lock.yaml");
const lockHashFile = `${pidFile}.lock.sha1`;
const command = process.env.SWARM_PROD_DAEMON_COMMAND?.trim() || DEFAULT_COMMAND;
const installCommand = process.env.SWARM_PROD_DAEMON_INSTALL_COMMAND?.trim() || DEFAULT_INSTALL_COMMAND;

let child = null;
let restarting = false;
let shuttingDown = false;
let forceKillTimer = null;

function log(message) {
  console.log(`[prod-daemon] ${message}`);
}

function readFileHash(filePath) {
  try {
    const fileContents = fs.readFileSync(filePath);
    return createHash("sha1").update(fileContents).digest("hex");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function readLockHashFile() {
  try {
    const raw = fs.readFileSync(lockHashFile, "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function writeLockHashFile(lockHash) {
  fs.mkdirSync(path.dirname(lockHashFile), { recursive: true });
  fs.writeFileSync(lockHashFile, `${lockHash}\n`, "utf8");
}

function shouldRunInstall() {
  const currentLockHash = readFileHash(lockFilePath);
  if (!currentLockHash) {
    return { runInstall: false, currentLockHash: null };
  }

  const previousLockHash = readLockHashFile();
  if (previousLockHash === currentLockHash) {
    return { runInstall: false, currentLockHash };
  }

  return { runInstall: true, currentLockHash };
}

function ensureDependenciesInstalled() {
  const installDecision = shouldRunInstall();
  if (!installDecision.currentLockHash) {
    log("No pnpm-lock.yaml found; skipping dependency install check.");
    return true;
  }

  if (!installDecision.runInstall) {
    log("pnpm-lock.yaml unchanged; skipping dependency install.");
    return true;
  }

  if (!installCommand) {
    log("Dependency install command is empty; skipping dependency install.");
    return true;
  }

  log(`pnpm-lock.yaml changed; running dependency install: ${installCommand}`);

  const installResult = spawnSync(installCommand, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
    shell: true,
  });

  if (installResult.error) {
    log(`Dependency install failed to start: ${installResult.error.message}`);
    return false;
  }

  if (installResult.status !== 0) {
    const reason = installResult.signal ? `signal ${installResult.signal}` : `code ${installResult.status ?? 0}`;
    log(`Dependency install exited with ${reason}.`);
    return false;
  }

  writeLockHashFile(installDecision.currentLockHash);
  return true;
}

function isChildRunning() {
  return Boolean(child && child.exitCode === null && child.signalCode === null);
}

function writePidFile() {
  if (fs.existsSync(pidFile)) {
    const existingPid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);

    if (Number.isInteger(existingPid) && existingPid > 0 && existingPid !== process.pid) {
      try {
        process.kill(existingPid, 0);
        throw new Error(`Daemon already running (pid ${existingPid}).`);
      } catch (error) {
        if (error.code !== "ESRCH") {
          throw error;
        }
      }
    }
  }

  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

function removePidFile() {
  if (!fs.existsSync(pidFile)) {
    return;
  }

  const filePid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
  if (filePid === process.pid) {
    fs.rmSync(pidFile, { force: true });
  }
}

function signalChildGroup(signal) {
  if (!child?.pid) {
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") {
      try {
        process.kill(child.pid, signal);
      } catch {
        // ignore
      }
    }
  }
}

function scheduleForceKill() {
  clearTimeout(forceKillTimer);
  forceKillTimer = setTimeout(() => {
    if (!isChildRunning()) {
      return;
    }

    log(`Child did not exit in time; sending SIGKILL to process group ${child.pid}.`);
    signalChildGroup("SIGKILL");
  }, FORCE_KILL_AFTER_MS);

  forceKillTimer.unref();
}

function stopChild(reason) {
  if (!isChildRunning()) {
    return;
  }

  log(`${reason} Sending SIGTERM to process group ${child.pid}.`);
  signalChildGroup("SIGTERM");
  scheduleForceKill();
}

function handleChildExit(code, signal) {
  clearTimeout(forceKillTimer);

  const shouldRestart = restarting;
  restarting = false;

  log(`Child exited (${signal ? `signal ${signal}` : `code ${code ?? 0}`}).`);
  child = null;

  if (shuttingDown) {
    removePidFile();
    process.exit(code ?? 0);
  }

  if (shouldRestart) {
    startChild();
    return;
  }

  log(`Child is stopped. Send ${RESTART_SIGNAL} (or run \`pnpm prod:restart\`) to start it again.`);
}

function startChild() {
  if (isChildRunning()) {
    return;
  }

  if (!ensureDependenciesInstalled()) {
    log("Skipping child start because dependency install failed.");
    return;
  }

  log(`Starting child command: ${command}`);

  child = spawn(command, {
    cwd: repoRoot,
    env: {
      ...process.env,
      MIDDLEMAN_DAEMONIZED: "1",
    },
    stdio: "inherit",
    shell: true,
    detached: true,
  });

  child.once("error", (error) => {
    log(`Child process error: ${error.message}`);
    child = null;
  });

  child.once("exit", handleChildExit);
}

function requestRestart(source) {
  if (shuttingDown) {
    return;
  }

  log(`Restart requested via ${source}.`);

  if (!isChildRunning()) {
    startChild();
    return;
  }

  if (restarting) {
    log("Restart already in progress; ignoring duplicate restart request.");
    return;
  }

  restarting = true;
  stopChild("Restart requested.");
}

function beginShutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  log(`Received ${signal}; shutting down daemon.`);

  if (isChildRunning()) {
    stopChild("Shutdown requested.");
    return;
  }

  removePidFile();
  process.exit(0);
}

try {
  writePidFile();
} catch (error) {
  console.error(`[prod-daemon] Failed to write pid file: ${error.message}`);
  process.exit(1);
}

process.on(RESTART_SIGNAL, () => requestRestart(RESTART_SIGNAL));
for (const signal of STOP_SIGNALS) {
  process.on(signal, () => beginShutdown(signal));
}

process.on("exit", removePidFile);

log(`Daemon pid ${process.pid}. pid file: ${pidFile}`);
startChild();
