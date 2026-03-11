import { createHash } from "node:crypto";
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

export function getLegacyControlPidFilePath(installDir) {
  const installHash = createHash("sha1").update(installDir).digest("hex").slice(0, 10);
  return path.join(os.tmpdir(), `swarm-prod-daemon-${installHash}.pid`);
}

export function getControlPidFileCandidates(installDir) {
  return [getControlPidFilePath(), getLegacyControlPidFilePath(installDir)];
}
