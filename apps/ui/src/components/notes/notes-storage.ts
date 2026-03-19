export const NOTES_LAST_OPEN_STORAGE_KEY = "middleman:notes:last-open";

export function readStoredLastOpenNotePath(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const storedPath = window.localStorage.getItem(NOTES_LAST_OPEN_STORAGE_KEY)?.trim();
    return storedPath ? storedPath : null;
  } catch {
    return null;
  }
}

export function writeStoredLastOpenNotePath(path: string | null): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    if (path) {
      window.localStorage.setItem(NOTES_LAST_OPEN_STORAGE_KEY, path);
      return;
    }

    window.localStorage.removeItem(NOTES_LAST_OPEN_STORAGE_KEY);
  } catch {
    // Ignore localStorage write failures in restricted environments.
  }
}
