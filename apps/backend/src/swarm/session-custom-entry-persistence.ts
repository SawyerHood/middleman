import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionManager } from "@mariozechner/pi-coding-agent";

export function requiresManualCustomEntryPersistence(sessionManager: SessionManager): boolean {
  return !sessionManager.getEntries().some((entry) => {
    if (entry.type !== "message") {
      return false;
    }

    const role = (entry.message as { role?: unknown }).role;
    return role === "assistant";
  });
}

export function persistSessionEntryForCustomRuntime(
  sessionManager: SessionManager,
  entryId: string
): void {
  const sessionFile = sessionManager.getSessionFile();
  if (!sessionFile) {
    return;
  }

  const entry = sessionManager.getEntry(entryId);
  if (!entry) {
    return;
  }

  mkdirSync(dirname(sessionFile), { recursive: true });

  if (!existsSync(sessionFile) || isEmptyFile(sessionFile)) {
    persistSessionSnapshot(sessionManager, sessionFile);
    return;
  }

  appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
}

function isEmptyFile(path: string): boolean {
  try {
    return statSync(path).size === 0;
  } catch {
    return true;
  }
}

function persistSessionSnapshot(sessionManager: SessionManager, sessionFile: string): void {
  const header = sessionManager.getHeader();
  if (!header) {
    return;
  }

  const lines = [header, ...sessionManager.getEntries()].map((entry) => JSON.stringify(entry));
  writeFileSync(sessionFile, `${lines.join("\n")}\n`, "utf8");
}
