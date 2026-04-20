/** @vitest-environment jsdom */

import { fireEvent, getByText, queryByText, waitFor, within } from "@testing-library/dom";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSidebar } from "./AgentSidebar";
import type { AgentDescriptor, AgentStatus } from "@middleman/protocol";

const dndState = vi.hoisted(() => ({
  onDragEnd: undefined as
    | ((event: { active: { id: string }; over: { id: string } | null }) => void)
    | undefined,
}));

vi.mock("@dnd-kit/core", async () => {
  const React = await import("react");

  return {
    DndContext: ({
      children,
      onDragEnd,
    }: {
      children: unknown;
      onDragEnd?: (event: { active: { id: string }; over: { id: string } | null }) => void;
    }) => {
      dndState.onDragEnd = onDragEnd;
      return React.createElement("div", { "data-testid": "dnd-context" }, children as any);
    },
    closestCenter: vi.fn(),
    KeyboardSensor: class KeyboardSensor {},
    PointerSensor: class PointerSensor {},
    useSensor: vi.fn((_sensor: unknown, options?: unknown) => ({ options })),
    useSensors: vi.fn((...sensors: unknown[]) => sensors),
  };
});

vi.mock("@dnd-kit/sortable", async () => {
  const React = await import("react");

  return {
    SortableContext: ({ children }: { children: unknown }) =>
      React.createElement(React.Fragment, null, children as any),
    sortableKeyboardCoordinates: vi.fn(),
    useSortable: vi.fn(({ id, disabled }: { id: string; disabled?: boolean }) => ({
      attributes: { "data-sortable-id": id },
      listeners: disabled ? undefined : { onPointerDown: () => undefined },
      setActivatorNodeRef: () => undefined,
      setNodeRef: () => undefined,
      transform: null,
      transition: undefined,
      isDragging: false,
    })),
    verticalListSortingStrategy: vi.fn(),
  };
});

function manager(
  agentId: string,
  modelOverrides: Partial<AgentDescriptor["model"]> = {},
): AgentDescriptor {
  return {
    agentId,
    managerId: agentId,
    displayName: agentId,
    role: "manager",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp",
    model: {
      provider: "openai-codex",
      modelId: "gpt-5.4",
      thinkingLevel: "high",
      ...modelOverrides,
    },
  };
}

function worker(
  agentId: string,
  managerId: string,
  modelOverrides: Partial<AgentDescriptor["model"]> = {},
): AgentDescriptor {
  return {
    ...manager(agentId, modelOverrides),
    managerId,
    role: "worker",
  };
}

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  dndState.onDragEnd = undefined;
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
});

function click(element: HTMLElement): void {
  flushSync(() => {
    element.click();
  });
}

function getPrimarySidebar(): HTMLElement {
  const sidebar = container.querySelector("aside");
  if (!sidebar) {
    throw new Error("Expected sidebar to render");
  }

  return sidebar;
}

function renderSidebar({
  agents,
  managerOrder = agents.filter((agent) => agent.role === "manager").map((agent) => agent.agentId),
  selectedAgentId = null,
  onSelectAgent = vi.fn(),
  onDeleteAgent = vi.fn(),
  onDeleteManager = vi.fn(),
  onReorderManagers = vi.fn(),
  onOpenNotes = vi.fn(),
  onOpenSettings = vi.fn(),
  isNotesActive = false,
  isSettingsActive = false,
  statuses = {},
}: {
  agents: AgentDescriptor[];
  managerOrder?: string[];
  selectedAgentId?: string | null;
  onSelectAgent?: (agentId: string) => void;
  onDeleteAgent?: (agentId: string) => void;
  onDeleteManager?: (managerId: string) => void;
  onReorderManagers?: (managerIds: string[]) => void;
  onOpenNotes?: () => void;
  onOpenSettings?: () => void;
  isNotesActive?: boolean;
  isSettingsActive?: boolean;
  statuses?: Record<string, { status: AgentStatus; pendingCount: number }>;
}) {
  root = createRoot(container);

  flushSync(() => {
    root?.render(
      createElement(AgentSidebar, {
        connected: true,
        agents,
        managerOrder,
        statuses,
        selectedAgentId,
        onAddManager: vi.fn(),
        onSelectAgent,
        onDeleteAgent,
        onDeleteManager,
        onReorderManagers,
        onOpenNotes,
        onOpenSettings,
        isNotesActive,
        isSettingsActive,
      }),
    );
  });
}

describe("AgentSidebar", () => {
  it("shows workers collapsed by default and toggles expand/collapse per manager", () => {
    renderSidebar({ agents: [manager("manager-alpha"), worker("worker-alpha", "manager-alpha")] });
    const sidebar = getPrimarySidebar();

    expect(queryByText(sidebar, "worker-alpha")).toBeNull();

    click(within(sidebar).getByRole("button", { name: "Expand manager manager-alpha" }));
    expect(queryByText(sidebar, "worker-alpha")).toBeTruthy();

    click(within(sidebar).getByRole("button", { name: "Collapse manager manager-alpha" }));
    expect(queryByText(sidebar, "worker-alpha")).toBeNull();
  });

  it("shows runtime icons from model presets", () => {
    renderSidebar({
      agents: [
        manager("manager-pi", { provider: "openai-codex", modelId: "gpt-5.4" }),
        worker("worker-opus", "manager-pi", { provider: "anthropic", modelId: "claude-opus-4-7" }),
        worker("worker-codex", "manager-pi", {
          provider: "openai-codex-app-server",
          modelId: "gpt-5.4",
        }),
        worker("worker-claude-code", "manager-pi", {
          provider: "anthropic-claude-code",
          modelId: "claude-opus-4-7",
        }),
      ],
    });
    const sidebar = getPrimarySidebar();

    click(within(sidebar).getByRole("button", { name: "Expand manager manager-pi" }));

    expect(container.querySelectorAll('img[src="/pi-logo.svg"]').length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector('img[src="/agents/codex-logo.svg"]')).toBeTruthy();

    const claudeCodeRow = getByText(sidebar, "worker-claude-code").closest(
      "button",
    ) as HTMLButtonElement;
    expect(claudeCodeRow).toBeTruthy();
    expect(claudeCodeRow.querySelectorAll('img[src="/agents/claude-logo.svg"]').length).toBe(2);
  });

  it("keeps manager selection behavior working while collapse state changes", () => {
    const onSelectAgent = vi.fn();

    renderSidebar({
      agents: [manager("manager-alpha"), worker("worker-alpha", "manager-alpha")],
      onSelectAgent,
    });
    const sidebar = getPrimarySidebar();

    const getManagerRowButton = () =>
      getByText(sidebar, "manager-alpha").closest("button") as HTMLButtonElement;
    expect(getManagerRowButton()).toBeTruthy();

    click(getManagerRowButton());
    expect(onSelectAgent).toHaveBeenCalledTimes(1);
    expect(onSelectAgent).toHaveBeenLastCalledWith("manager-alpha");

    click(within(sidebar).getByRole("button", { name: "Expand manager manager-alpha" }));
    expect(onSelectAgent).toHaveBeenCalledTimes(1);

    click(getManagerRowButton());
    expect(onSelectAgent).toHaveBeenCalledTimes(2);
    expect(onSelectAgent).toHaveBeenLastCalledWith("manager-alpha");
  });

  it("keeps manager and worker selection separate from delete callbacks", () => {
    const onDeleteAgent = vi.fn();
    const onDeleteManager = vi.fn();
    const onSelectAgent = vi.fn();

    renderSidebar({
      agents: [manager("manager-alpha"), worker("worker-alpha", "manager-alpha")],
      onDeleteAgent,
      onDeleteManager,
      onSelectAgent,
    });
    const sidebar = getPrimarySidebar();

    const managerRowButton = within(sidebar).getByRole("button", { name: "manager-alpha" });
    click(managerRowButton);
    expect(onSelectAgent).toHaveBeenCalledWith("manager-alpha");
    expect(onDeleteManager).not.toHaveBeenCalled();

    click(within(sidebar).getByRole("button", { name: "Expand manager manager-alpha" }));
    const workerRowButton = within(sidebar).getByRole("button", { name: "worker-alpha" });
    click(workerRowButton);
    expect(onSelectAgent).toHaveBeenCalledWith("worker-alpha");
    expect(onDeleteAgent).not.toHaveBeenCalled();
  });

  it("makes manager rows sortable and keeps workers non-sortable", () => {
    renderSidebar({ agents: [manager("manager-alpha"), worker("worker-alpha", "manager-alpha")] });
    const sidebar = getPrimarySidebar();

    const managerRowButton = within(sidebar).getByRole("button", { name: "manager-alpha" });
    expect(managerRowButton.closest('[data-sortable-id="manager-alpha"]')).toBeTruthy();
    expect(queryByText(sidebar, "worker-alpha")).toBeNull();

    click(within(sidebar).getByRole("button", { name: "Expand manager manager-alpha" }));

    const workerRowButton = within(sidebar).getByRole("button", { name: "worker-alpha" });
    expect(workerRowButton).toBeTruthy();
    expect(workerRowButton.closest("[data-sortable-id]")).toBeNull();
  });

  it("calls onReorderManagers with the reordered manager ids after a drag completes", () => {
    const onReorderManagers = vi.fn();

    renderSidebar({
      agents: [manager("manager-alpha"), manager("manager-beta")],
      onReorderManagers,
    });

    flushSync(() => {
      dndState.onDragEnd?.({
        active: { id: "manager-beta" },
        over: { id: "manager-alpha" },
      });
    });

    expect(onReorderManagers).toHaveBeenCalledTimes(1);
    expect(onReorderManagers).toHaveBeenCalledWith(["manager-beta", "manager-alpha"]);
  });

  it("calls onOpenSettings when the settings button is clicked", () => {
    const onOpenSettings = vi.fn();

    renderSidebar({
      agents: [manager("manager-alpha")],
      onOpenSettings,
    });
    const sidebar = getPrimarySidebar();

    click(within(sidebar).getByRole("button", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("calls onOpenNotes when the notes button is clicked", () => {
    const onOpenNotes = vi.fn();

    renderSidebar({
      agents: [manager("manager-alpha")],
      onOpenNotes,
    });
    const sidebar = getPrimarySidebar();

    click(within(sidebar).getByRole("button", { name: "Notes" }));
    expect(onOpenNotes).toHaveBeenCalledTimes(1);
  });

  it("shows thinking level in the model badge tooltip", async () => {
    renderSidebar({ agents: [manager("manager-alpha")] });
    const sidebar = getPrimarySidebar();
    const managerRowButton = within(sidebar).getByRole("button", { name: "manager-alpha" });
    const modelTrigger = managerRowButton.querySelector('[data-slot="tooltip-trigger"]');

    expect(modelTrigger).toBeTruthy();

    fireEvent.mouseEnter(modelTrigger as Element);
    fireEvent.mouseMove(modelTrigger as Element);

    await waitFor(() => {
      expect(getByText(document.body, "pi-codex - thinking: high")).toBeTruthy();
    });
    expect(getByText(document.body, "openai-codex/gpt-5.4")).toBeTruthy();
  });
});
