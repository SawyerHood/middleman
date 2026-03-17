/** @vitest-environment jsdom */

import { createElement, createRef, type RefObject } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtuosoMockContext } from "react-virtuoso";
import type { AgentDescriptor, ConversationEntry } from "@middleman/protocol";
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
    modelId: "gpt-5.3-codex",
    thinkingLevel: "high",
  },
};

const originalScrollTo = HTMLElement.prototype.scrollTo;

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

function renderMessageList({
  messages,
  viewportHeight = 240,
  itemHeight = 72,
  handleRef,
  onLoadOlderHistory = vi.fn(),
  canLoadOlderHistory = false,
  isLoading = false,
}: {
  messages: ConversationEntry[];
  viewportHeight?: number;
  itemHeight?: number;
  handleRef?: RefObject<MessageListHandle | null>;
  onLoadOlderHistory?: () => void;
  canLoadOlderHistory?: boolean;
  isLoading?: boolean;
}) {
  return render(
    createElement(
      VirtuosoMockContext.Provider,
      { value: { viewportHeight, itemHeight } },
      createElement(
        "div",
        { style: { display: "flex", height: `${viewportHeight}px` } },
        createElement(MessageList, {
          ref: handleRef,
          messages,
          agents: [manager],
          isLoading,
          activeAgentId: "manager",
          canLoadOlderHistory,
          onLoadOlderHistory,
        }),
      ),
    ),
  );
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    writable: true,
    value: originalScrollTo,
  });
});

describe("MessageList", () => {
  it("virtualizes long transcripts instead of mounting the full DOM list", () => {
    const { container } = renderMessageList({
      messages: buildConversationMessages(100),
      viewportHeight: 180,
      itemHeight: 64,
    });

    expect(screen.getByText("message 0")).toBeTruthy();
    expect(screen.queryByText("message 20")).toBeNull();
    expect(container.querySelectorAll(".user-message-bubble").length).toBeLessThan(
      100,
    );
  });

  it("requests older history when the list does not fill the viewport", async () => {
    const onLoadOlderHistory = vi.fn();

    renderMessageList({
      messages: buildConversationMessages(1),
      viewportHeight: 320,
      itemHeight: 72,
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
      viewportHeight: 200,
      itemHeight: 64,
      handleRef,
    });

    await waitFor(() => {
      expect(handleRef.current).toBeTruthy();
    });

    expect(typeof handleRef.current?.scrollToBottom).toBe("function");
  });

  it("renders the loading indicator inside the padded footer layout", () => {
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
    expect(indicator.parentElement?.className).toContain("px-2");
    expect(indicator.parentElement?.className).toContain("pb-2");
    expect(indicator.parentElement?.className).toContain("md:px-3");
    expect(indicator.parentElement?.className).toContain("md:pb-3");
  });
});
