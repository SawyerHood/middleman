import { resolve } from "node:path";

export const RESTART_SIGNAL: NodeJS.Signals = "SIGUSR1";
export const DAEMONIZED_ENV_VAR = "MIDDLEMAN_DAEMONIZED";
export const RESTART_PARENT_PID_ENV_VAR = "MIDDLEMAN_WAIT_FOR_PID_TO_EXIT";
export const SUPPRESS_OPEN_ON_RESTART_ENV_VAR = "MIDDLEMAN_SUPPRESS_OPEN_ON_RESTART";

const CONTROL_PID_FILE_NAME = "prod-daemon.pid";

export function getControlPidFilePath(runDir: string): string {
  return resolve(runDir, CONTROL_PID_FILE_NAME);
}
