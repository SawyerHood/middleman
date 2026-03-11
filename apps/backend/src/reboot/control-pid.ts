import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const RESTART_SIGNAL: NodeJS.Signals = "SIGUSR1";
export const DAEMONIZED_ENV_VAR = "MIDDLEMAN_DAEMONIZED";
export const RESTART_PARENT_PID_ENV_VAR = "MIDDLEMAN_WAIT_FOR_PID_TO_EXIT";
export const SUPPRESS_OPEN_ON_RESTART_ENV_VAR = "MIDDLEMAN_SUPPRESS_OPEN_ON_RESTART";

const CONTROL_PID_FILE_NAME = "prod-daemon.pid";

export function getControlPidFilePath(runDir: string): string {
  return resolve(runDir, CONTROL_PID_FILE_NAME);
}

export function getLegacyControlPidFilePath(installDir: string): string {
  const installHash = createHash("sha1").update(installDir).digest("hex").slice(0, 10);
  return join(tmpdir(), `swarm-prod-daemon-${installHash}.pid`);
}

export function getControlPidFileCandidates(options: {
  runDir: string;
  installDir: string;
}): string[] {
  return [getControlPidFilePath(options.runDir), getLegacyControlPidFilePath(options.installDir)];
}
