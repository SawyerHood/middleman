/** @vitest-environment jsdom */

import {
  createElement,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDescriptor, ConversationEntry } from "@middleman/protocol";

const virtuosoMocks = vi.hoisted(() => ({
  isAtBottom: true,
  scrollTo: vi.fn(),
  scrollToIndex: vi.fn(),
}));

vi.mock("react-virtuoso", async () => {
  const React = await import("react");

  const MockVirtuoso = React.forwardRef(function MockVirtuoso(
    {
      data = [],
      components,
      itemContent,
      computeItemKey,
      firstItemIndex = 0,
      scrollerRef,
      atBottomStateChange,
      followOutput,
    }: {
      data?: unknown[];
      components?: {
        Header?: React.ComponentType;
        Footer?: React.ComponentType;
        List?: React.ComponentType<React.ComponentPropsWithoutRef<"div">>;
        Scroller?: React.ComponentType<React.ComponentPropsWithoutRef<"div">>;
      };
      itemContent: (index: number, item: unknown) => React.ReactNode;
      computeItemKey?: (index: number, item: unknown) => React.Key;
      firstItemIndex?: number;
      scrollerRef?: (node: HTMLElement | null) => void;
      atBottomStateChange?: (atBottom: boolean) => void;
      followOutput?:
        | ((isAtBottom: boolean) => "auto" | "smooth" | boolean)
        | "auto"
        | "smooth"
        | boolean;
    },
    ref: React.ForwardedRef<{
      scrollTo: typeof virtuosoMocks.scrollTo;
      scrollToIndex: typeof virtuosoMocks.scrollToIndex;
    }>,
  ) {
    const Scroller = components?.Scroller ?? "div";
    const List = components?.List ?? "div";
    const Header = components?.Header;
    const Footer = components?.Footer;
    const ScrollerElement = Scroller as unknown as React.ElementType;
    const ListElement = List as unknown as React.ElementType;
    const scrollerElementRef = useRef<HTMLDivElement | null>(null);
    const previousDataLengthRef = useRef<number | null>(null);

    useImperativeHandle(ref, () => ({
      scrollTo: virtuosoMocks.scrollTo,
      scrollToIndex: virtuosoMocks.scrollToIndex,
    }));

    useLayoutEffect(() => {
      scrollerRef?.(scrollerElementRef.current);
      atBottomStateChange?.(virtuosoMocks.isAtBottom);

      return () => {
        scrollerRef?.(null);
      };
    }, [atBottomStateChange, scrollerRef]);

    useLayoutEffect(() => {
      atBottomStateChange?.(virtuosoMocks.isAtBottom);

      const previousDataLength = previousDataLengthRef.current;
      previousDataLengthRef.current = data.length;

      if (
        previousDataLength === null ||
        previousDataLength === data.length ||
        typeof followOutput === "undefined"
      ) {
        return;
      }

      const followDecision =
        typeof followOutput === "function"
          ? followOutput(virtuosoMocks.isAtBottom)
          : followOutput;

      if (followDecision === false) {
        return;
      }

      virtuosoMocks.scrollToIndex({
        index: "LAST",
        align: "end",
        behavior: followDecision === true ? "auto" : followDecision,
      });
    }, [atBottomStateChange, data.length, followOutput]);

    return createElement(
      ScrollerElement,
      { ref: scrollerElementRef } as Record<string, unknown>,
      Header ? createElement(Header) : null,
      createElement(
        ListElement,
        null,
        ...data.map((entry, index) =>
          createElement(
            "div",
            { key: computeItemKey?.(index, entry) ?? index },
            itemContent(index + firstItemIndex, entry),
          ),
        ),
      ),
      Footer ? createElement(Footer) : null,
    );
  });

  MockVirtuoso.displayName = "MockVirtuoso";

  return {
    Virtuoso: MockVirtuoso,
    VirtuosoMockContext: React.createContext(undefined),
  };
});

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
    modelId: "gpt-5.3-codex",
    thinkingLevel: "high",
  },
};

const worker: AgentDescriptor = {
  ...manager,
  agentId: "worker-1",
  displayName: "Worker 1",
  role: "worker",
};

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
  return render(createElement(MessageList, props));
}

beforeEach(() => {
  virtuosoMocks.isAtBottom = true;
  virtuosoMocks.scrollTo.mockReset();
  virtuosoMocks.scrollToIndex.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("MessageList scroll behavior", () => {
  it("scrolls to the last item when replacement history renders after an agent switch", async () => {
    const managerMessages = buildConversationMessages("manager", 3);

    const { rerender } = renderMessageList({
      messages: managerMessages,
      agents: [manager, worker],
      activeAgentId: "manager",
    });

    await waitFor(() => {
      expect(virtuosoMocks.scrollToIndex).toHaveBeenCalledWith({
        index: "LAST",
        align: "end",
        behavior: "auto",
      });
    });

    virtuosoMocks.scrollToIndex.mockClear();

    rerender(
      createElement(MessageList, {
        messages: managerMessages,
        agents: [manager, worker],
        activeAgentId: "worker-1",
        isLoadingHistory: true,
      }),
    );

    expect(screen.getByText("message 0")).toBeTruthy();
    expect(screen.queryByText("Loading conversation")).toBeNull();
    expect(virtuosoMocks.scrollToIndex).not.toHaveBeenCalled();

    rerender(
      createElement(MessageList, {
        messages: buildConversationMessages("worker-1", 4, 10),
        agents: [manager, worker],
        activeAgentId: "worker-1",
      }),
    );

    await waitFor(() => {
      expect(virtuosoMocks.scrollToIndex).toHaveBeenCalledWith({
        index: "LAST",
        align: "end",
        behavior: "auto",
      });
    });
  });

  it("does not scroll to the bottom when older history is prepended", async () => {
    const onLoadOlderHistory = vi.fn();

    const { rerender } = renderMessageList({
      messages: buildConversationMessages("manager", 2, 10),
      agents: [manager],
      activeAgentId: "manager",
      canLoadOlderHistory: true,
      onLoadOlderHistory,
    });

    await waitFor(() => {
      expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);
    });

    virtuosoMocks.scrollToIndex.mockClear();

    rerender(
      createElement(MessageList, {
        messages: buildConversationMessages("manager", 4, 8),
        agents: [manager],
        activeAgentId: "manager",
        canLoadOlderHistory: true,
        onLoadOlderHistory,
      }),
    );

    expect(virtuosoMocks.scrollToIndex).not.toHaveBeenCalled();
  });

  it("sticks to the bottom for live updates only when the user is already at the bottom", async () => {
    const { rerender } = renderMessageList({
      messages: buildConversationMessages("manager", 2, 20),
      agents: [manager],
      activeAgentId: "manager",
    });

    await waitFor(() => {
      expect(virtuosoMocks.scrollToIndex).toHaveBeenCalledWith({
        index: "LAST",
        align: "end",
        behavior: "auto",
      });
    });

    virtuosoMocks.scrollToIndex.mockClear();

    rerender(
      createElement(MessageList, {
        messages: buildConversationMessages("manager", 3, 20),
        agents: [manager],
        activeAgentId: "manager",
      }),
    );

    expect(virtuosoMocks.scrollToIndex).toHaveBeenCalledWith({
      index: "LAST",
      align: "end",
      behavior: "smooth",
    });

    virtuosoMocks.scrollToIndex.mockClear();
    virtuosoMocks.isAtBottom = false;

    rerender(
      createElement(MessageList, {
        messages: buildConversationMessages("manager", 4, 20),
        agents: [manager],
        activeAgentId: "manager",
      }),
    );

    expect(virtuosoMocks.scrollToIndex).not.toHaveBeenCalled();
  });
});
