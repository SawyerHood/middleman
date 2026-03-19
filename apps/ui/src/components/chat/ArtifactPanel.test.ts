/** @vitest-environment jsdom */

import { fireEvent, getByRole, waitFor } from "@testing-library/dom";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactPanel } from "./ArtifactPanel";

const ARTIFACT_OPEN_EDITOR_STORAGE_KEY = "middleman:artifact-panel:open-editor";

function createLocalStorageMock(): Storage {
  const store = new Map<string, string>();

  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  };
}

let container!: HTMLDivElement;
let root: Root | null = null;

const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
const originalFetch = globalThis.fetch;
const originalWindowOpen = window.open;
const originalRequestAnimationFrame = window.requestAnimationFrame;
const originalCancelAnimationFrame = window.cancelAnimationFrame;

beforeEach(() => {
  const localStorageMock = createLocalStorageMock();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: localStorageMock,
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: localStorageMock,
  });

  globalThis.fetch = vi.fn();
  window.open = vi.fn();
  window.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  window.cancelAnimationFrame = vi.fn();

  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  if (root) {
    flushSync(() => {
      root?.unmount();
    });
  }

  root = null;
  container.remove();
  vi.clearAllMocks();

  if (originalLocalStorageDescriptor) {
    Object.defineProperty(window, "localStorage", originalLocalStorageDescriptor);
    Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor);
  }

  globalThis.fetch = originalFetch;
  window.open = originalWindowOpen;
  window.requestAnimationFrame = originalRequestAnimationFrame;
  window.cancelAnimationFrame = originalCancelAnimationFrame;
});

function mockReadFileResponse(payload: Record<string, unknown>) {
  vi.mocked(globalThis.fetch).mockResolvedValue({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response);
}

function renderPanel(options?: { onOpenInNotes?: (notePath: string) => void }) {
  root = createRoot(container);

  flushSync(() => {
    root?.render(
      createElement(ArtifactPanel, {
        selection: {
          type: "artifact",
          artifact: {
            path: "/Users/example/worktrees/middleman/notes/projects/roadmap.md",
            fileName: "roadmap.md",
            href: "swarm-file:///Users/example/worktrees/middleman/notes/projects/roadmap.md",
          },
        },
        wsUrl: "ws://127.0.0.1:47187",
        onClose: vi.fn(),
        onOpenInNotes: options?.onOpenInNotes,
      }),
    );
  });
}

describe("ArtifactPanel", () => {
  it("uses the last selected editor for the main action", async () => {
    window.localStorage.setItem(ARTIFACT_OPEN_EDITOR_STORAGE_KEY, "cursor");
    mockReadFileResponse({
      path: "/Users/example/worktrees/middleman/notes/projects/roadmap.md",
      content: "# Roadmap\n",
    });

    renderPanel();

    const openButton = getByRole(document.body, "button", { name: "Open in Cursor" });
    fireEvent.click(openButton);

    expect(window.open).toHaveBeenCalledWith(
      "cursor://file/Users/example/worktrees/middleman/notes/projects/roadmap.md",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("lets the user switch to built-in notes from the dropdown and persists the choice", async () => {
    const onOpenInNotes = vi.fn();

    mockReadFileResponse({
      path: "/Users/example/worktrees/middleman/notes/projects/roadmap.md",
      content: "# Roadmap\n",
      editorTargets: {
        notesPath: "projects/roadmap.md",
        obsidian: {
          vault: "Middleman Notes",
          file: "projects/roadmap.md",
        },
      },
    });

    renderPanel({ onOpenInNotes });

    await waitFor(() => {
      expect(vi.mocked(globalThis.fetch)).toHaveBeenCalled();
    });

    fireEvent.click(getByRole(document.body, "button", { name: "Choose editor" }));

    const builtInNotesItem = await waitFor(() => {
      const menuItem = getByRole(document.body, "menuitem", { name: /Built-in Notes/i });
      expect(menuItem.getAttribute("aria-disabled")).not.toBe("true");
      return menuItem;
    });

    fireEvent.click(builtInNotesItem);

    expect(onOpenInNotes).toHaveBeenCalledWith("projects/roadmap.md");
    expect(window.localStorage.getItem(ARTIFACT_OPEN_EDITOR_STORAGE_KEY)).toBe("notes");
  });
});
