/** @vitest-environment jsdom */

import { createElement } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { AgentDescriptor, ConversationEntry } from "@middleman/protocol";
import { MessageList } from "./MessageList";

const manager: AgentDescriptor = {
  agentId: "manager",
  managerId: "manager",
  displayName: "Manager",
  role: "manager",
  status: "idle",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  cwd: "/tmp/project",
  model: {
    provider: "openai-codex",
    modelId: "gpt-5.4",
    thinkingLevel: "high",
  },
};

const worker: AgentDescriptor = {
  ...manager,
  agentId: "worker-1",
  displayName: "Worker 1",
  role: "worker",
};

const originalRequestAnimationFrame = window.requestAnimationFrame;
const originalCancelAnimationFrame = window.cancelAnimationFrame;
const originalScrollTo = HTMLElement.prototype.scrollTo;
const originalScrollTopDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollTop",
);
const originalScrollHeightDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollHeight",
);
const originalClientHeightDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "clientHeight",
);

const scrollMetrics = {
  scrollHeight: 400,
  clientHeight: 200,
  scrollTop: 0,
};

let nextAnimationFrameId = 0;
const pendingAnimationFrames = new Map<number, FrameRequestCallback>();

function isMessageListScroller(element: unknown): element is HTMLElement {
  return (
    element instanceof HTMLElement &&
    element.getAttribute("data-testid") === "message-list-scroller"
  );
}

function getMaxScrollTop(): number {
  return Math.max(0, scrollMetrics.scrollHeight - scrollMetrics.clientHeight);
}

function clampScrollTop(nextScrollTop: number): number {
  return Math.max(0, Math.min(nextScrollTop, getMaxScrollTop()));
}

function setScrollMetrics(nextMetrics: Partial<typeof scrollMetrics>) {
  if (typeof nextMetrics.scrollHeight === "number") {
    scrollMetrics.scrollHeight = nextMetrics.scrollHeight;
  }

  if (typeof nextMetrics.clientHeight === "number") {
    scrollMetrics.clientHeight = nextMetrics.clientHeight;
  }

  if (typeof nextMetrics.scrollTop === "number") {
    scrollMetrics.scrollTop = clampScrollTop(nextMetrics.scrollTop);
    return;
  }

  scrollMetrics.scrollTop = clampScrollTop(scrollMetrics.scrollTop);
}

function buildConversationMessages(
  agentId: string,
  count: number,
  startIndex = 0,
): ConversationEntry[] {
  return Array.from({ length: count }, (_, index) => {
    const messageIndex = startIndex + index;

    return {
      type: "conversation_message",
      agentId,
      role: "assistant",
      text: `message ${messageIndex}`,
      timestamp: new Date(
        Date.UTC(2026, 0, 1, 0, 0, messageIndex),
      ).toISOString(),
      source: "speak_to_user",
    };
  });
}

function renderMessageList(props: {
  messages: ConversationEntry[];
  agents: AgentDescriptor[];
  activeAgentId: string;
  isLoadingHistory?: boolean;
  canLoadOlderHistory?: boolean;
  onLoadOlderHistory?: () => void;
}) {
  return render(
    createElement(
      "div",
      {
        style: {
          display: "flex",
          height: `${scrollMetrics.clientHeight}px`,
        },
      },
      createElement(MessageList, props),
    ),
  );
}

function flushAnimationFrames(times = 1) {
  for (let index = 0; index < times; index += 1) {
    const callbacks = [...pendingAnimationFrames.values()];
    pendingAnimationFrames.clear();
    callbacks.forEach((callback) => callback(performance.now()));
  }
}

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get() {
      return isMessageListScroller(this) ? scrollMetrics.scrollTop : 0;
    },
    set(value: number) {
      if (!isMessageListScroller(this)) {
        return;
      }

      scrollMetrics.scrollTop = clampScrollTop(Number(value));
    },
  });

  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      return isMessageListScroller(this) ? scrollMetrics.scrollHeight : 0;
    },
  });

  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return isMessageListScroller(this) ? scrollMetrics.clientHeight : 0;
    },
  });
});

beforeEach(() => {
  setScrollMetrics({
    scrollHeight: 400,
    clientHeight: 200,
    scrollTop: 0,
  });

  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    writable: true,
    value: vi.fn(function scrollTo(
      this: HTMLElement,
      topOrOptions?: number | ScrollToOptions,
      maybeTop?: number,
    ) {
      if (!isMessageListScroller(this)) {
        return;
      }

      const nextScrollTop =
        typeof topOrOptions === "object"
          ? (topOrOptions.top ?? 0)
          : (maybeTop ?? topOrOptions ?? 0);

      scrollMetrics.scrollTop = clampScrollTop(Number(nextScrollTop));
    }),
  });

  nextAnimationFrameId = 0;
  pendingAnimationFrames.clear();
  window.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
    nextAnimationFrameId += 1;
    pendingAnimationFrames.set(nextAnimationFrameId, callback);
    return nextAnimationFrameId;
  });
  window.cancelAnimationFrame = vi.fn((frameId: number) => {
    pendingAnimationFrames.delete(frameId);
  });
});

afterEach(() => {
  cleanup();
  pendingAnimationFrames.clear();
});

afterAll(() => {
  window.requestAnimationFrame = originalRequestAnimationFrame;
  window.cancelAnimationFrame = originalCancelAnimationFrame;

  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    writable: true,
    value: originalScrollTo,
  });

  if (originalScrollTopDescriptor) {
    Object.defineProperty(
      HTMLElement.prototype,
      "scrollTop",
      originalScrollTopDescriptor,
    );
  }

  if (originalScrollHeightDescriptor) {
    Object.defineProperty(
      HTMLElement.prototype,
      "scrollHeight",
      originalScrollHeightDescriptor,
    );
  }

  if (originalClientHeightDescriptor) {
    Object.defineProperty(
      HTMLElement.prototype,
      "clientHeight",
      originalClientHeightDescriptor,
    );
  }
});

describe("MessageList scroll behavior", () => {
  it("keeps the transcript hidden until the initial scroll settles", async () => {
    renderMessageList({
      messages: buildConversationMessages("manager", 3),
      agents: [manager],
      activeAgentId: "manager",
    });

    const scroller = screen.getByTestId("message-list-scroller");
    expect((scroller as HTMLElement).style.opacity).toBe("0");

    flushAnimationFrames(2);

    await waitFor(() => {
      expect((scroller as HTMLElement).style.opacity).toBe("1");
    });
  });

  it("scrolls to the bottom when replacement history renders after an agent switch", async () => {
    const managerMessages = buildConversationMessages("manager", 3);

    setScrollMetrics({
      scrollHeight: 400,
      clientHeight: 200,
      scrollTop: 0,
    });

    const { rerender } = renderMessageList({
      messages: managerMessages,
      agents: [manager, worker],
      activeAgentId: "manager",
    });

    const scroller = screen.getByTestId("message-list-scroller");
    expect(scroller.scrollTop).toBe(200);

    flushAnimationFrames(2);

    setScrollMetrics({
      scrollHeight: 400,
      clientHeight: 200,
      scrollTop: scroller.scrollTop,
    });

    rerender(
      createElement(
        "div",
        {
          style: {
            display: "flex",
            height: `${scrollMetrics.clientHeight}px`,
          },
        },
        createElement(MessageList, {
          messages: managerMessages,
          agents: [manager, worker],
          activeAgentId: "worker-1",
          isLoadingHistory: true,
        }),
      ),
    );

    expect(screen.getByText("message 0")).toBeTruthy();
    expect(screen.queryByText("Loading conversation")).toBeNull();
    expect(scroller.style.opacity).toBe("1");
    expect(scroller.scrollTop).toBe(200);

    setScrollMetrics({
      scrollHeight: 600,
      clientHeight: 200,
      scrollTop: scroller.scrollTop,
    });

    rerender(
      createElement(
        "div",
        {
          style: {
            display: "flex",
            height: `${scrollMetrics.clientHeight}px`,
          },
        },
        createElement(MessageList, {
          messages: buildConversationMessages("worker-1", 4, 10),
          agents: [manager, worker],
          activeAgentId: "worker-1",
        }),
      ),
    );

    expect(scroller.scrollTop).toBe(400);
    expect(scroller.style.opacity).toBe("0");

    flushAnimationFrames(2);

    await waitFor(() => {
      expect(scroller.style.opacity).toBe("1");
    });
  });

  it("preserves scroll position when older history is prepended", async () => {
    const onLoadOlderHistory = vi.fn();

    setScrollMetrics({
      scrollHeight: 400,
      clientHeight: 200,
      scrollTop: 0,
    });

    const { rerender } = renderMessageList({
      messages: buildConversationMessages("manager", 2, 10),
      agents: [manager],
      activeAgentId: "manager",
      canLoadOlderHistory: true,
      onLoadOlderHistory,
    });

    flushAnimationFrames(2);

    const scroller = screen.getByTestId("message-list-scroller");
    setScrollMetrics({
      scrollHeight: 400,
      clientHeight: 200,
      scrollTop: 0,
    });

    const scrollToMock = vi.mocked(HTMLElement.prototype.scrollTo);
    scrollToMock.mockClear();

    fireEvent.scroll(scroller);

    await waitFor(() => {
      expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);
    });

    setScrollMetrics({
      scrollHeight: 600,
      clientHeight: 200,
      scrollTop: 0,
    });

    rerender(
      createElement(
        "div",
        {
          style: {
            display: "flex",
            height: `${scrollMetrics.clientHeight}px`,
          },
        },
        createElement(MessageList, {
          messages: buildConversationMessages("manager", 4, 8),
          agents: [manager],
          activeAgentId: "manager",
          canLoadOlderHistory: true,
          onLoadOlderHistory,
        }),
      ),
    );

    expect(scrollToMock).not.toHaveBeenCalled();
    expect(scroller.scrollTop).toBe(200);
  });

  it("sticks to the bottom for live updates only when the user is already at the bottom", async () => {
    setScrollMetrics({
      scrollHeight: 400,
      clientHeight: 200,
      scrollTop: 0,
    });

    const { rerender } = renderMessageList({
      messages: buildConversationMessages("manager", 2, 20),
      agents: [manager],
      activeAgentId: "manager",
    });

    flushAnimationFrames(2);

    const scroller = screen.getByTestId("message-list-scroller");
    const scrollToMock = vi.mocked(HTMLElement.prototype.scrollTo);

    expect(scroller.scrollTop).toBe(200);

    scrollToMock.mockClear();
    setScrollMetrics({
      scrollHeight: 500,
      clientHeight: 200,
      scrollTop: scroller.scrollTop,
    });

    rerender(
      createElement(
        "div",
        {
          style: {
            display: "flex",
            height: `${scrollMetrics.clientHeight}px`,
          },
        },
        createElement(MessageList, {
          messages: buildConversationMessages("manager", 3, 20),
          agents: [manager],
          activeAgentId: "manager",
        }),
      ),
    );

    expect(scrollToMock).toHaveBeenCalledWith({
      top: 500,
      behavior: "smooth",
    });
    expect(scroller.scrollTop).toBe(300);

    scrollToMock.mockClear();
    setScrollMetrics({
      scrollHeight: 500,
      clientHeight: 200,
      scrollTop: 40,
    });
    fireEvent.scroll(scroller);

    setScrollMetrics({
      scrollHeight: 600,
      clientHeight: 200,
      scrollTop: 40,
    });

    rerender(
      createElement(
        "div",
        {
          style: {
            display: "flex",
            height: `${scrollMetrics.clientHeight}px`,
          },
        },
        createElement(MessageList, {
          messages: buildConversationMessages("manager", 4, 20),
          agents: [manager],
          activeAgentId: "manager",
        }),
      ),
    );

    expect(scrollToMock).not.toHaveBeenCalled();
    expect(scroller.scrollTop).toBe(40);
  });
});
