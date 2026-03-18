#!/usr/bin/env node

import fs from "node:fs";
import { getControlPidFilePath } from "./prod-daemon-paths.mjs";

const pidFiles = [getControlPidFilePath()];

const resolved = resolveRunningPidFile(pidFiles);
if (!resolved) {
  console.error(`[prod-daemon] No daemon pid file found. Checked: ${pidFiles.join(", ")}`);
  process.exit(1);
}

const { pidFile, pid } = resolved;
try {
  process.kill(pid, "SIGUSR1");
  console.log(`[prod-daemon] Sent SIGUSR1 to daemon pid ${pid}.`);
} catch (error) {
  if (error.code === "ESRCH") {
    fs.rmSync(pidFile, { force: true });
    console.error(`[prod-daemon] Daemon pid ${pid} is not running. Removed stale pid file.`);
    process.exit(1);
  }

  console.error(`[prod-daemon] Failed to signal daemon pid ${pid}: ${error.message}`);
  process.exit(1);
}

function resolveRunningPidFile(candidates) {
  for (const pidFile of candidates) {
    if (!fs.existsSync(pidFile)) {
      continue;
    }

    const pid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      continue;
    }

    try {
      process.kill(pid, 0);
      return { pidFile, pid };
    } catch (error) {
      if (error.code === "ESRCH") {
        fs.rmSync(pidFile, { force: true });
        continue;
      }

      throw error;
    }
  }

  return null;
}
