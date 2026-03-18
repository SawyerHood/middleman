/** @vitest-environment jsdom */

import { createElement, createRef, type RefObject } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
import type {
  AgentDescriptor,
  ConversationEntry,
  ConversationMessageEvent,
} from "@middleman/protocol";
import { MessageList, type MessageListHandle } from "./MessageList";

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
  scrollHeight: 720,
  clientHeight: 240,
  scrollTop: 0,
};

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

function buildConversationMessages(count: number): ConversationEntry[] {
  return Array.from({ length: count }, (_, index) => {
    const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();

    return {
      type: "conversation_message" as const,
      agentId: "manager",
      role: "user" as const,
      text: `message ${index}`,
      timestamp,
      source: "user_input" as const,
    };
  });
}

function buildConversationMessage(
  index: number,
  role: ConversationMessageEvent["role"],
  text: string,
): ConversationEntry {
  return {
    type: "conversation_message",
    agentId: "manager",
    role,
    text,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    source:
      role === "assistant"
        ? "speak_to_user"
        : role === "system"
          ? "system"
          : "user_input",
  };
}

function findRowSpacingWrapper(node: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = node;

  while (current) {
    const className = current.className;
    if (
      typeof className === "string" &&
      (className.includes("pt-2") ||
        className.includes("pt-1") ||
        className.includes("pt-[var(--chat-tool-assistant-gap)]") ||
        className.includes("pt-[var(--chat-block-gap)]"))
    ) {
      return current;
    }

    current = current.parentElement;
  }

  return null;
}

function renderMessageList({
  messages,
  handleRef,
  onLoadOlderHistory = vi.fn(),
  canLoadOlderHistory = false,
  isLoading = false,
  isLoadingHistory = false,
  isWorkerDetailView = false,
}: {
  messages: ConversationEntry[];
  handleRef?: RefObject<MessageListHandle | null>;
  onLoadOlderHistory?: () => void;
  canLoadOlderHistory?: boolean;
  isLoading?: boolean;
  isLoadingHistory?: boolean;
  isWorkerDetailView?: boolean;
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
      createElement(MessageList, {
        ref: handleRef,
        messages,
        agents: [manager],
        isLoading,
        isLoadingHistory,
        activeAgentId: "manager",
        canLoadOlderHistory,
        isWorkerDetailView,
        onLoadOlderHistory,
      }),
    ),
  );
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
    scrollHeight: 720,
    clientHeight: 240,
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
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
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

describe("MessageList", () => {
  it("renders the full transcript directly without virtualization", () => {
    const { container } = renderMessageList({
      messages: buildConversationMessages(100),
    });

    expect(screen.getByText("message 0")).toBeTruthy();
    expect(screen.getByText("message 99")).toBeTruthy();
    expect(container.querySelectorAll(".user-message-bubble").length).toBe(100);
  });

  it("requests older history when the list does not fill the viewport", async () => {
    const onLoadOlderHistory = vi.fn();

    setScrollMetrics({
      scrollHeight: 120,
      clientHeight: 320,
      scrollTop: 0,
    });

    renderMessageList({
      messages: buildConversationMessages(1),
      canLoadOlderHistory: true,
      onLoadOlderHistory,
    });

    await waitFor(() => {
      expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);
    });
  });

  it("exposes an imperative scroll-to-bottom handle", async () => {
    const handleRef = createRef<MessageListHandle>();

    renderMessageList({
      messages: buildConversationMessages(20),
      handleRef,
    });

    await waitFor(() => {
      expect(handleRef.current).toBeTruthy();
    });

    expect(typeof handleRef.current?.scrollToBottom).toBe("function");
  });

  it("renders the loading indicator at the bottom of the scroll container", () => {
    renderMessageList({
      messages: buildConversationMessages(1),
      isLoading: true,
    });

    const indicator = screen.getByRole("status", {
      name: "Assistant is working",
    });

    expect(indicator.className).toContain("mt-3");
    expect(indicator.className).toContain("min-h-5");
    expect(indicator.className).toContain("items-center");
    expect(
      screen.getByTestId("message-list-scroller").contains(indicator),
    ).toBe(true);
  });

  it("shows a loading indicator instead of the empty state while history is loading", () => {
    renderMessageList({
      messages: [],
      isLoadingHistory: true,
    });

    expect(screen.getByText("Loading conversation")).toBeTruthy();
    expect(screen.queryByText("What can I do for you?")).toBeNull();
  });

  it("keeps the empty state when history has finished loading with no messages", () => {
    renderMessageList({
      messages: [],
      isLoadingHistory: false,
    });

    expect(screen.getByText("What can I do for you?")).toBeTruthy();
    expect(screen.queryByText("Loading conversation")).toBeNull();
  });

  it("restores vertical spacing between consecutive chat messages", () => {
    renderMessageList({
      messages: [
        buildConversationMessage(0, "user", "first message"),
        buildConversationMessage(1, "assistant", "second message"),
      ],
    });

    const firstRow = findRowSpacingWrapper(screen.getByText("first message"));
    const secondRow = findRowSpacingWrapper(screen.getByText("second message"));

    expect(firstRow?.className ?? "").not.toContain("pt-2");
    expect(secondRow?.className ?? "").toContain("pt-2");
  });

  it("preserves worker detail spacing between mixed execution and conversation rows", () => {
    renderMessageList({
      isWorkerDetailView: true,
      messages: [
        buildConversationMessage(0, "assistant", "assistant update"),
        buildConversationMessage(1, "assistant", "follow-up reply"),
        {
          type: "agent_message",
          agentId: "manager",
          timestamp: "2026-01-01T00:00:02.000Z",
          source: "agent_to_agent",
          fromAgentId: "manager",
          toAgentId: "worker-1",
          text: "delegated task",
        },
        {
          type: "agent_tool_call",
          agentId: "manager",
          actorAgentId: "worker-1",
          timestamp: "2026-01-01T00:00:03.000Z",
          kind: "tool_execution_start",
          toolName: "read",
          toolCallId: "call-1",
          text: JSON.stringify({ path: "/tmp/file.txt" }),
        },
        {
          type: "conversation_log",
          agentId: "manager",
          timestamp: "2026-01-01T00:00:04.000Z",
          source: "runtime_log",
          kind: "message_end",
          text: "runtime failure",
          isError: true,
        },
      ],
    });

    expect(
      findRowSpacingWrapper(screen.getByText("follow-up reply"))?.className ??
        "",
    ).toContain("pt-[var(--chat-block-gap)]");
    expect(
      findRowSpacingWrapper(
        screen.getByRole("button", { name: /manager → worker-1/i }),
      )?.className ?? "",
    ).toContain("pt-[var(--chat-tool-assistant-gap)]");
    expect(
      findRowSpacingWrapper(
        screen.getByRole("button", { name: /calling read tool/i }),
      )?.className ?? "",
    ).toContain("pt-1.5");
    expect(
      findRowSpacingWrapper(screen.getByText("Runtime error"))?.className ?? "",
    ).toContain("pt-1.5");
  });
});
