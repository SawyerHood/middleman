import { DEFAULT_DATA_DIR } from "./defaults.js";

export interface SwarmdConfig {
  dataDir: string;
  dbPath: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

export function loadConfig(overrides?: Partial<SwarmdConfig>): SwarmdConfig {
  return {
    dataDir: overrides?.dataDir ?? process.env.SWARMD_DATA_DIR ?? DEFAULT_DATA_DIR,
    dbPath: overrides?.dbPath ?? "",
    logLevel: (overrides?.logLevel ??
      process.env.SWARMD_LOG_LEVEL ??
      "info") as SwarmdConfig["logLevel"],
  };
}
