import os from "node:os";
import path from "node:path";

export function resolveDataDir() {
  const configuredDataDir = process.env.MIDDLEMAN_HOME?.trim();
  if (configuredDataDir) {
    return path.resolve(configuredDataDir);
  }

  return path.resolve(os.homedir(), ".middleman");
}

export function getControlPidFilePath() {
  return path.join(resolveDataDir(), "run", "prod-daemon.pid");
}
