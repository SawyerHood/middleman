import { appendFile, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionManager } from "@mariozechner/pi-coding-agent";

const pendingSessionWrites = new Map<string, Promise<void>>();

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
): Promise<void> {
  const sessionFile = sessionManager.getSessionFile();
  if (!sessionFile) {
    return Promise.resolve();
  }

  const entry = sessionManager.getEntry(entryId);
  if (!entry) {
    return Promise.resolve();
  }

  return enqueueSessionWrite(sessionFile, async () => {
    await mkdir(dirname(sessionFile), { recursive: true });

    if (await isMissingOrEmptyFile(sessionFile)) {
      await persistSessionSnapshot(sessionManager, sessionFile);
      return;
    }

    await appendFile(sessionFile, `${JSON.stringify(entry)}\n`, "utf8");
  });
}

async function isMissingOrEmptyFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size === 0;
  } catch {
    return true;
  }
}

function enqueueSessionWrite(
  sessionFile: string,
  operation: () => Promise<void>
): Promise<void> {
  const previous = pendingSessionWrites.get(sessionFile) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);

  pendingSessionWrites.set(sessionFile, next);

  return next.finally(() => {
    if (pendingSessionWrites.get(sessionFile) === next) {
      pendingSessionWrites.delete(sessionFile);
    }
  });
}

async function persistSessionSnapshot(
  sessionManager: SessionManager,
  sessionFile: string
): Promise<void> {
  const header = sessionManager.getHeader();
  if (!header) {
    return;
  }

  const lines = [header, ...sessionManager.getEntries()].map((entry) => JSON.stringify(entry));
  await writeFile(sessionFile, `${lines.join("\n")}\n`, "utf8");
}
