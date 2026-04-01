import { DEFAULT_DATA_DIR } from "./defaults.js";

export interface SwarmdConfig {
  dataDir: string;
  dbPath: string;
}

export function loadConfig(overrides?: Partial<SwarmdConfig>): SwarmdConfig {
  return {
    dataDir: overrides?.dataDir ?? process.env.SWARMD_DATA_DIR ?? DEFAULT_DATA_DIR,
    dbPath: overrides?.dbPath ?? "",
  };
}
