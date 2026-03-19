import { atomWithStorage } from "jotai/utils";

export const CHAT_INTERNAL_CHATTER_STORAGE_KEY = "middleman:chat:show-internal-chatter";

export function readStoredShowInternalChatter(): boolean {
  if (typeof window === "undefined") {
    return true;
  }

  try {
    const storedValue = window.localStorage.getItem(CHAT_INTERNAL_CHATTER_STORAGE_KEY);
    if (storedValue === "false") {
      return false;
    }

    return true;
  } catch {
    return true;
  }
}

export function writeStoredShowInternalChatter(value: boolean): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    if (value) {
      window.localStorage.removeItem(CHAT_INTERNAL_CHATTER_STORAGE_KEY);
      return;
    }

    window.localStorage.setItem(CHAT_INTERNAL_CHATTER_STORAGE_KEY, "false");
  } catch {
    // Ignore localStorage write failures in restricted environments.
  }
}

const showInternalChatterStorage = {
  getItem(key: string, initialValue: boolean): boolean {
    if (typeof window === "undefined") {
      return initialValue;
    }

    try {
      const storedValue = window.localStorage.getItem(key);
      return storedValue === "false" ? false : true;
    } catch {
      return initialValue;
    }
  },
  setItem(_key: string, value: boolean): void {
    writeStoredShowInternalChatter(value);
  },
  removeItem(_key: string): void {
    if (typeof window === "undefined") {
      return;
    }

    try {
      window.localStorage.removeItem(_key);
    } catch {
      // Ignore localStorage removal failures in restricted environments.
    }
  },
};

export const showInternalChatterAtom = atomWithStorage(
  CHAT_INTERNAL_CHATTER_STORAGE_KEY,
  true,
  showInternalChatterStorage,
  { getOnInit: true },
);
