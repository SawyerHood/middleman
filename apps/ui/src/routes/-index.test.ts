/** @vitest-environment jsdom */

import {
  fireEvent,
  getAllByRole,
  getByLabelText,
  getByRole,
  queryByText,
  within,
} from "@testing-library/dom";
import {
  Outlet,
  RouterProvider,
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { Provider as JotaiProvider } from "jotai";
import { CREATE_MANAGER_MODEL_PRESETS } from "@middleman/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MESSAGE_DRAFTS_STORAGE_KEY } from "@/lib/message-drafts";
import { IndexPage } from "./index";

const TEST_BUILD_HASH = import.meta.env.VITE_BUILD_HASH || "test-build";
const testRootRoute = createRootRoute({
  component: () => createElement(Outlet),
});
const testIndexRoute = createRoute({
  getParentRoute: () => testRootRoute,
  path: "/",
  component: IndexPage,
});
const testRouteTree = testRootRoute.addChildren([testIndexRoute]);

type ListenerMap = Record<string, Array<(event?: any) => void>>;
const faviconEmojiByCanvas = new WeakMap<HTMLCanvasElement, string>();

class ResizeObserverMock {
  constructor(_callback: ResizeObserverCallback) {}

  observe(): void {}

  unobserve(): void {}

  disconnect(): void {}
}

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly sentPayloads: string[] = [];
  readonly listeners: ListenerMap = {};

  readyState = FakeWebSocket.OPEN;

  constructor(_url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event?: any) => void): void {
    this.listeners[type] ??= [];
    this.listeners[type].push(listener);
  }

  send(payload: string): void {
    this.sentPayloads.push(payload);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close");
  }

  emit(type: string, event?: any): void {
    const handlers = this.listeners[type] ?? [];
    for (const handler of handlers) {
      handler(event);
    }
  }
}

function emitServerEvent(socket: FakeWebSocket, event: unknown): void {
  flushSync(() => {
    socket.emit("message", {
      data: JSON.stringify(event),
    });
  });
}

function click(element: HTMLElement): void {
  flushSync(() => {
    fireEvent.pointerEnter(element, { pointerType: "mouse" });
    fireEvent.mouseEnter(element);
    fireEvent.mouseMove(element);
    fireEvent.pointerDown(element);
    fireEvent.mouseDown(element);
    element.click();
    fireEvent.mouseUp(element);
    fireEvent.pointerUp(element);
  });
}

function changeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  flushSync(() => {
    fireEvent.change(element, {
      target: { value },
    });
  });
}

function buildManager(agentId: string, cwd: string) {
  return {
    agentId,
    managerId: agentId,
    displayName: agentId,
    role: "manager" as const,
    status: "idle" as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cwd,
    model: {
      provider: "openai-codex",
      modelId: "gpt-5.4",
      thinkingLevel: "high",
    },
  };
}

function buildWorker(agentId: string, managerId: string, cwd: string) {
  return {
    agentId,
    managerId,
    displayName: agentId,
    role: "worker" as const,
    status: "idle" as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cwd,
    model: {
      provider: "openai-codex",
      modelId: "gpt-5.4",
      thinkingLevel: "high",
    },
  };
}

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
let windowScrollToMock: ReturnType<typeof vi.fn>;

function createTestRouter() {
  return createRouter({
    routeTree: testRouteTree,
    history: createBrowserHistory(),
  });
}

const originalWebSocket = globalThis.WebSocket;
const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
const originalResizeObserverDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "ResizeObserver",
);
const originalGetAnimations = Element.prototype.getAnimations;
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
const originalScrollTo = HTMLElement.prototype.scrollTo;
const originalWindowScrollTo = window.scrollTo;
const originalCanvasGetContext = HTMLCanvasElement.prototype.getContext;
const originalCanvasToDataURL = HTMLCanvasElement.prototype.toDataURL;
const originalMatchMediaDescriptor = Object.getOwnPropertyDescriptor(window, "matchMedia");
const originalRequestAnimationFrame = window.requestAnimationFrame;
const originalCancelAnimationFrame = window.cancelAnimationFrame;

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.useFakeTimers();
  windowScrollToMock = vi.fn();
  (globalThis as any).WebSocket = FakeWebSocket;
  const localStorageMock = createLocalStorageMock();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: localStorageMock,
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: localStorageMock,
  });
  Object.defineProperty(window, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverMock,
  });
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverMock,
  });
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
  document.head.querySelectorAll('link[rel="icon"]').forEach((node) => node.remove());
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    writable: true,
    value: vi.fn(() => []),
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
  Object.defineProperty(window, "scrollTo", {
    configurable: true,
    writable: true,
    value: windowScrollToMock,
  });
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    writable: true,
    value: (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 0),
  });
  Object.defineProperty(window, "cancelAnimationFrame", {
    configurable: true,
    writable: true,
    value: (handle: number) => window.clearTimeout(handle),
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    writable: true,
    value(this: HTMLCanvasElement) {
      return {
        clearRect: vi.fn(),
        fillText: (text: string) => {
          faviconEmojiByCanvas.set(this, text);
        },
        textAlign: "center",
        textBaseline: "middle",
        font: "",
      } as unknown as CanvasRenderingContext2D;
    },
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "toDataURL", {
    configurable: true,
    writable: true,
    value(this: HTMLCanvasElement) {
      return `data:image/png;base64,${encodeURIComponent(faviconEmojiByCanvas.get(this) ?? "")}`;
    },
  });

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
  window.localStorage.clear();

  vi.useRealTimers();
  (globalThis as any).WebSocket = originalWebSocket;
  if (originalLocalStorageDescriptor) {
    Object.defineProperty(window, "localStorage", originalLocalStorageDescriptor);
    Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor);
  }
  if (originalResizeObserverDescriptor) {
    Object.defineProperty(window, "ResizeObserver", originalResizeObserverDescriptor);
    Object.defineProperty(globalThis, "ResizeObserver", originalResizeObserverDescriptor);
  } else {
    Reflect.deleteProperty(window, "ResizeObserver");
    Reflect.deleteProperty(globalThis, "ResizeObserver");
  }
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: originalScrollIntoView,
  });
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    writable: true,
    value: originalGetAnimations,
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    writable: true,
    value: originalScrollTo,
  });
  Object.defineProperty(window, "scrollTo", {
    configurable: true,
    writable: true,
    value: originalWindowScrollTo,
  });
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    writable: true,
    value: originalRequestAnimationFrame,
  });
  Object.defineProperty(window, "cancelAnimationFrame", {
    configurable: true,
    writable: true,
    value: originalCancelAnimationFrame,
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    writable: true,
    value: originalCanvasGetContext,
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "toDataURL", {
    configurable: true,
    writable: true,
    value: originalCanvasToDataURL,
  });
  if (originalMatchMediaDescriptor) {
    Object.defineProperty(window, "matchMedia", originalMatchMediaDescriptor);
  } else {
    Reflect.deleteProperty(window, "matchMedia");
  }
});

async function renderPage(): Promise<FakeWebSocket> {
  const router = createTestRouter();
  root = createRoot(container);

  flushSync(() => {
    root?.render(
      createElement(
        JotaiProvider,
        null,
        createElement(TooltipProvider, null, createElement(RouterProvider, { router })),
      ),
    );
  });

  await router.load();
  await Promise.resolve();
  vi.advanceTimersByTime(60);

  const socket = FakeWebSocket.instances.at(-1);
  expect(socket).toBeDefined();
  if (!socket) {
    throw new Error("Expected websocket to be created");
  }

  socket.emit("open");
  expect(JSON.parse(socket.sentPayloads.at(0) ?? "{}")).toEqual({ type: "subscribe" });
  emitServerEvent(socket, {
    type: "ready",
    serverTime: new Date().toISOString(),
    buildHash: TEST_BUILD_HASH,
    subscribedAgentId: "manager",
  });

  return socket;
}

function readDraftStorage(): Record<string, string> {
  const stored = window.localStorage.getItem(MESSAGE_DRAFTS_STORAGE_KEY);
  return stored ? (JSON.parse(stored) as Record<string, string>) : {};
}

function getSidebar(): HTMLElement {
  const sidebar = container.querySelector("aside");
  if (!sidebar) {
    throw new Error("Expected sidebar to render");
  }

  return sidebar;
}

function getFaviconHref(): string | null {
  return document.head.querySelector('link[rel="icon"]')?.getAttribute("href") ?? null;
}

async function flushWsUiUpdates(turns = 3): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

function setPointerType(pointerType: "coarse" | "fine"): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches: query === "(pointer: coarse)" ? pointerType === "coarse" : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe("IndexPage create manager model selection", () => {
  it("shows only Pi model presets and defaults to pi-codex", async () => {
    await renderPage();

    click(getAllByRole(container, "button", { name: "Add manager" })[0]!);

    const modelSelect = getByRole(document.body, "combobox", { name: "Model" });
    expect(modelSelect.textContent).toContain("pi-codex");

    click(modelSelect as HTMLElement);

    const optionValues = getAllByRole(document.body, "option").map(
      (option) => option.textContent?.trim() ?? "",
    );
    expect(optionValues).toEqual([...CREATE_MANAGER_MODEL_PRESETS]);
  });

  it("sends selected model in create_manager payload", async () => {
    const socket = await renderPage();

    click(getAllByRole(container, "button", { name: "Add manager" })[0]!);

    changeValue(getByLabelText(document.body, "Name") as HTMLInputElement, "release-manager");
    changeValue(
      getByLabelText(document.body, "Working directory") as HTMLInputElement,
      "/tmp/release",
    );

    const modelSelect = getByRole(document.body, "combobox", { name: "Model" });
    click(modelSelect as HTMLElement);
    await vi.advanceTimersByTimeAsync(250);
    const piOpusOption = getByRole(document.body, "option", { name: "pi-opus" }) as HTMLElement;
    flushSync(() => {
      fireEvent.pointerEnter(piOpusOption, { pointerType: "mouse" });
      fireEvent.mouseEnter(piOpusOption);
      fireEvent.mouseMove(piOpusOption);
    });
    await vi.advanceTimersByTimeAsync(0);
    click(piOpusOption);
    await vi.advanceTimersByTimeAsync(0);

    click(getByRole(document.body, "button", { name: "Create manager" }));

    const validatePayload = JSON.parse(socket.sentPayloads.at(-1) ?? "{}");
    expect(validatePayload.type).toBe("validate_directory");
    expect(validatePayload.path).toBe("/tmp/release");

    emitServerEvent(socket, {
      type: "directory_validated",
      requestId: validatePayload.requestId,
      path: "/tmp/release",
      valid: true,
    });

    await vi.advanceTimersByTimeAsync(0);

    const parsedPayloads = socket.sentPayloads.map((payload) => JSON.parse(payload));
    const createPayload = parsedPayloads.find((payload) => payload.type === "create_manager");

    expect(createPayload).toMatchObject({
      type: "create_manager",
      name: "release-manager",
      cwd: "/tmp/release",
      model: "pi-opus",
    });
    expect(typeof createPayload?.requestId).toBe("string");

    emitServerEvent(socket, {
      type: "manager_created",
      requestId: createPayload?.requestId,
      manager: buildManager("release-manager", "/tmp/release"),
    });

    await vi.advanceTimersByTimeAsync(0);
  });

  it("shows only user input and speak_to_user transcript entries for the selected manager context", async () => {
    const socket = await renderPage();

    emitServerEvent(socket, {
      type: "agents_snapshot",
      agents: [
        buildManager("manager", "/tmp/manager"),
        buildWorker("worker-owned", "manager", "/tmp/manager"),
        buildManager("other-manager", "/tmp/other-manager"),
        buildWorker("worker-foreign", "other-manager", "/tmp/other-manager"),
      ],
    });

    emitServerEvent(socket, {
      type: "conversation_history",
      agentId: "manager",
      messages: [
        {
          type: "conversation_message",
          agentId: "manager",
          role: "assistant",
          text: "manager reply",
          timestamp: new Date().toISOString(),
          source: "speak_to_user",
        },
        {
          type: "conversation_message",
          agentId: "manager",
          role: "user",
          text: "user asks manager",
          timestamp: new Date().toISOString(),
          source: "user_input",
        },
        {
          type: "conversation_message",
          agentId: "worker-owned",
          role: "assistant",
          text: "owned worker reply",
          timestamp: new Date().toISOString(),
          source: "speak_to_user",
        },
        {
          type: "conversation_message",
          agentId: "worker-foreign",
          role: "assistant",
          text: "foreign worker reply",
          timestamp: new Date().toISOString(),
          source: "speak_to_user",
        },
        {
          type: "agent_message",
          agentId: "manager",
          timestamp: new Date().toISOString(),
          source: "agent_to_agent",
          fromAgentId: "worker-owned",
          toAgentId: "worker-owned",
          text: "owned worker chatter",
        },
        {
          type: "agent_tool_call",
          agentId: "manager",
          actorAgentId: "manager",
          timestamp: new Date().toISOString(),
          kind: "tool_execution_start",
          toolName: "speak_to_user",
          toolCallId: "manager-call",
          text: '{"text":"hello"}',
        },
        {
          type: "agent_tool_call",
          agentId: "manager",
          actorAgentId: "worker-owned",
          timestamp: new Date().toISOString(),
          kind: "tool_execution_start",
          toolName: "read",
          toolCallId: "owned-call",
          text: '{"path":"README.md"}',
        },
        {
          type: "agent_message",
          agentId: "manager",
          timestamp: new Date().toISOString(),
          source: "agent_to_agent",
          fromAgentId: "worker-foreign",
          toAgentId: "worker-foreign",
          text: "foreign worker chatter",
        },
        {
          type: "agent_tool_call",
          agentId: "manager",
          actorAgentId: "worker-foreign",
          timestamp: new Date().toISOString(),
          kind: "tool_execution_start",
          toolName: "read",
          toolCallId: "foreign-call",
          text: '{"path":"SECRET.md"}',
        },
      ],
    });

    await flushWsUiUpdates();

    expect(queryByText(container, "manager reply")).not.toBeNull();
    expect(queryByText(container, "user asks manager")).not.toBeNull();
    expect(queryByText(container, "owned worker reply")).not.toBeNull();
    expect(queryByText(container, "owned worker chatter")).toBeNull();
    expect(queryByText(container, /manager-call/)).toBeNull();
    expect(queryByText(container, /owned-call/)).toBeNull();
    expect(queryByText(container, "foreign worker reply")).toBeNull();
    expect(queryByText(container, "foreign worker chatter")).toBeNull();
    expect(queryByText(container, /foreign-call/)).toBeNull();
  });

  it("swaps the favicon when any agent starts or stops work", async () => {
    const socket = await renderPage();

    emitServerEvent(socket, {
      type: "agents_snapshot",
      agents: [
        buildManager("manager", "/tmp/manager"),
        buildWorker("worker-owned", "manager", "/tmp/manager"),
        buildManager("other-manager", "/tmp/other-manager"),
        buildWorker("worker-foreign", "other-manager", "/tmp/other-manager"),
      ],
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(getFaviconHref()).toBe(`data:image/png;base64,${encodeURIComponent("👔")}`);

    emitServerEvent(socket, {
      type: "agent_status",
      agentId: "worker-foreign",
      status: "busy",
      pendingCount: 1,
    });

    await flushWsUiUpdates();

    expect(getFaviconHref()).toBe(`data:image/png;base64,${encodeURIComponent("👨‍💻")}`);

    emitServerEvent(socket, {
      type: "agent_status",
      agentId: "worker-foreign",
      status: "idle",
      pendingCount: 0,
    });

    await flushWsUiUpdates();

    expect(getFaviconHref()).toBe(`data:image/png;base64,${encodeURIComponent("👔")}`);
  });

  it("keeps the root URL free of query params when the active agent is implicit", async () => {
    const socket = await renderPage();

    emitServerEvent(socket, {
      type: "agents_snapshot",
      agents: [buildManager("manager", "/tmp/manager")],
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("");
  });

  it("clears the query param when the explicitly selected agent disappears from the snapshot", async () => {
    window.history.replaceState(null, "", "/?agent=worker-1");

    const socket = await renderPage();

    emitServerEvent(socket, {
      type: "agents_snapshot",
      agents: [
        buildManager("manager", "/tmp/manager"),
        buildWorker("worker-1", "manager", "/tmp/manager"),
      ],
    });

    await flushWsUiUpdates();

    const payloadsAfterSelection = socket.sentPayloads.map((payload) => JSON.parse(payload));
    expect(
      payloadsAfterSelection.some(
        (payload) => payload.type === "subscribe" && payload.agentId === "worker-1",
      ),
    ).toBe(true);

    emitServerEvent(socket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      buildHash: TEST_BUILD_HASH,
      subscribedAgentId: "worker-1",
    });

    emitServerEvent(socket, {
      type: "agents_snapshot",
      agents: [buildManager("manager", "/tmp/manager")],
    });

    await flushWsUiUpdates();

    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("");
  });

  it("shows a loading state while switching agents until replacement history arrives", async () => {
    const socket = await renderPage();

    emitServerEvent(socket, {
      type: "agents_snapshot",
      agents: [
        buildManager("manager", "/tmp/manager"),
        buildWorker("worker-1", "manager", "/tmp/manager"),
      ],
    });

    await flushWsUiUpdates();

    const sidebar = getSidebar();

    click(within(sidebar).getByRole("button", { name: "Expand manager manager" }));
    click(within(sidebar).getByRole("button", { name: "worker-1" }));

    await flushWsUiUpdates();

    expect(queryByText(container, "Loading conversation")).toBeTruthy();
    expect(queryByText(container, "What can I do for you?")).toBeNull();

    emitServerEvent(socket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      buildHash: TEST_BUILD_HASH,
      subscribedAgentId: "worker-1",
    });

    emitServerEvent(socket, {
      type: "conversation_history",
      agentId: "worker-1",
      mode: "replace",
      messages: [],
    });

    await flushWsUiUpdates();

    expect(queryByText(container, "Loading conversation")).toBeNull();
    expect(queryByText(container, "What can I do for you?")).toBeTruthy();
  });

  it("persists drafts per agent across selection changes and refresh, clears sent drafts, and prunes deleted agents", async () => {
    const socket = await renderPage();

    emitServerEvent(socket, {
      type: "agents_snapshot",
      agents: [
        buildManager("manager", "/tmp/manager"),
        buildWorker("worker-1", "manager", "/tmp/manager"),
        buildWorker("worker-2", "manager", "/tmp/manager"),
      ],
    });

    await flushWsUiUpdates();

    const sidebar = getSidebar();

    click(within(sidebar).getByRole("button", { name: "Expand manager manager" }));
    click(within(sidebar).getByRole("button", { name: "worker-1" }));

    await vi.advanceTimersByTimeAsync(0);

    changeValue(getByRole(container, "textbox") as HTMLTextAreaElement, "draft for worker 1");
    expect(readDraftStorage()).toEqual({ "worker-1": "draft for worker 1" });

    click(within(sidebar).getByRole("button", { name: "worker-2" }));
    await vi.advanceTimersByTimeAsync(0);

    expect((getByRole(container, "textbox") as HTMLTextAreaElement).value).toBe("");

    changeValue(getByRole(container, "textbox") as HTMLTextAreaElement, "draft for worker 2");
    expect(readDraftStorage()).toEqual({
      "worker-1": "draft for worker 1",
      "worker-2": "draft for worker 2",
    });

    flushSync(() => {
      root?.unmount();
    });
    root = null;

    const refreshedSocket = await renderPage();

    emitServerEvent(refreshedSocket, {
      type: "agents_snapshot",
      agents: [
        buildManager("manager", "/tmp/manager"),
        buildWorker("worker-1", "manager", "/tmp/manager"),
        buildWorker("worker-2", "manager", "/tmp/manager"),
      ],
    });

    await flushWsUiUpdates();

    const refreshedSidebar = getSidebar();

    click(within(refreshedSidebar).getByRole("button", { name: "Expand manager manager" }));

    expect(window.location.search).toBe("?agent=worker-2");
    expect((getByRole(container, "textbox") as HTMLTextAreaElement).value).toBe(
      "draft for worker 2",
    );

    click(within(refreshedSidebar).getByRole("button", { name: "worker-1" }));
    await vi.advanceTimersByTimeAsync(0);

    expect((getByRole(container, "textbox") as HTMLTextAreaElement).value).toBe(
      "draft for worker 1",
    );

    click(getByRole(container, "button", { name: "Send message" }));

    const sentMessages = refreshedSocket.sentPayloads
      .map((payload) => JSON.parse(payload))
      .filter((payload) => payload.type === "user_message");

    expect(sentMessages.at(-1)).toMatchObject({
      type: "user_message",
      agentId: "worker-1",
      text: "draft for worker 1",
    });
    expect((getByRole(container, "textbox") as HTMLTextAreaElement).value).toBe("");
    expect(readDraftStorage()).toEqual({ "worker-2": "draft for worker 2" });

    emitServerEvent(refreshedSocket, {
      type: "agents_snapshot",
      agents: [
        buildManager("manager", "/tmp/manager"),
        buildWorker("worker-1", "manager", "/tmp/manager"),
      ],
    });

    await flushWsUiUpdates();

    expect(readDraftStorage()).toEqual({});
  });

  it("resets the page viewport after sending from a mobile input", async () => {
    setPointerType("coarse");
    const blurSpy = vi.spyOn(HTMLTextAreaElement.prototype, "blur");

    await renderPage();

    changeValue(getByRole(container, "textbox") as HTMLTextAreaElement, "mobile submit");
    click(getByRole(container, "button", { name: "Send message" }));

    expect(blurSpy).toHaveBeenCalledTimes(1);
    expect(windowScrollToMock).toHaveBeenCalledWith({
      top: 0,
      left: 0,
      behavior: "auto",
    });

    await vi.advanceTimersByTimeAsync(320);

    expect(windowScrollToMock).toHaveBeenCalled();
  });
});
