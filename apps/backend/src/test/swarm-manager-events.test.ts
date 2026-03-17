import { describe, expect, it, vi } from "vitest";

import { createConfig } from "../config.js";
import { SwarmManager } from "../swarm/swarm-manager.js";
import type { AgentDescriptor, AgentStatusEvent } from "../swarm/types.js";

const REPO_ROOT = process.cwd();

function makeDescriptor(
  overrides: Partial<AgentDescriptor> & Pick<AgentDescriptor, "agentId" | "managerId" | "role">,
): AgentDescriptor {
  return {
    displayName: overrides.agentId,
    status: "idle",
    createdAt: "2026-03-15T00:00:00.000Z",
    updatedAt: "2026-03-15T00:00:00.000Z",
    cwd: "/tmp/project",
    model: {
      provider: "openai-codex-app-server",
      modelId: "gpt-5.4",
      thinkingLevel: "xhigh",
    },
    ...overrides,
  };
}

function createManagerHarness(descriptor: AgentDescriptor) {
  const manager = new SwarmManager(
    createConfig({
      installDir: REPO_ROOT,
      projectRoot: REPO_ROOT,
      dataDir: "/tmp/middleman-swarm-manager-events",
    }),
  );
  const statuses: AgentStatusEvent[] = [];
  const snapshots: unknown[] = [];
  const conversationLogs: unknown[] = [];
  const toolCalls: unknown[] = [];
  const appendedMessages: Array<{ sessionId: string; metadata: unknown }> = [];

  vi.spyOn(manager, "getAgent").mockImplementation((agentId: string) =>
    agentId === descriptor.agentId ? descriptor : undefined,
  );
  vi.spyOn(manager, "listAgents").mockImplementation(() => [descriptor]);

  Object.assign(manager as object, {
    core: {
      sessionService: {
        getById: vi.fn(() => ({
          id: descriptor.agentId,
          status: "busy",
          contextUsage: null,
        })),
        applyRuntimeStatus: vi.fn(),
      },
      messageService: {
        interrupt: vi.fn(),
      },
      messageStore: {
        append: vi.fn((sessionId: string, input: { metadata: unknown }) => {
          appendedMessages.push({
            sessionId,
            metadata: input.metadata,
          });
        }),
      },
      supervisor: {
        hasWorker: vi.fn(() => true),
      },
    },
  });

  manager.on("agent_status", (event) => statuses.push(event as AgentStatusEvent));
  manager.on("agents_snapshot", (event) => snapshots.push(event));
  manager.on("conversation_log", (event) => conversationLogs.push(event));
  manager.on("agent_tool_call", (event) => toolCalls.push(event));

  return {
    manager,
    statuses,
    snapshots,
    conversationLogs,
    toolCalls,
    appendedMessages,
  };
}

describe("SwarmManager core event projection", () => {
  it("maps session.status.changed into agent_status with context usage", () => {
    const descriptor = makeDescriptor({
      agentId: "worker-1",
      managerId: "manager-1",
      role: "worker",
      contextUsage: {
        tokens: 120_000,
        contextWindow: 200_000,
        percent: 60,
      },
    });
    const harness = createManagerHarness(descriptor);

    (harness.manager as any).handleCoreEvent({
      id: "evt-1",
      sessionId: "worker-1",
      threadId: null,
      source: "worker",
      type: "session.status.changed",
      timestamp: "2026-03-15T00:00:01.000Z",
      payload: {
        status: "busy",
        previousStatus: "idle",
        contextUsage: descriptor.contextUsage,
      },
    });

    expect(harness.statuses).toEqual([
      {
        type: "agent_status",
        agentId: "worker-1",
        status: "busy",
        pendingCount: 0,
        contextUsage: {
          tokens: 120_000,
          contextWindow: 200_000,
          percent: 60,
        },
      },
    ]);
    expect(harness.snapshots).toEqual([]);
  });

  it("projects runtime errors using the real error message", () => {
    const descriptor = makeDescriptor({
      agentId: "manager-1",
      managerId: "manager-1",
      role: "manager",
    });
    const harness = createManagerHarness(descriptor);

    (harness.manager as any).handleCoreEvent({
      id: "evt-2",
      sessionId: "manager-1",
      threadId: null,
      source: "worker",
      type: "session.errored",
      timestamp: "2026-03-15T00:00:02.000Z",
      payload: {
        error: {
          code: "AUTH_MISSING",
          message: "Missing authentication for openai-codex.",
          retryable: false,
        },
      },
    });

    expect(harness.conversationLogs).toEqual([
      {
        type: "conversation_log",
        agentId: "manager-1",
        timestamp: "2026-03-15T00:00:02.000Z",
        source: "runtime_log",
        kind: "message_end",
        text: "Missing authentication for openai-codex.",
        isError: true,
      },
    ]);
  });

  it("projects message and tool events into conversation and tool call entries", () => {
    const descriptor = makeDescriptor({
      agentId: "worker-1",
      managerId: "manager-1",
      role: "worker",
    });
    const harness = createManagerHarness(descriptor);

    (harness.manager as any).handleCoreEvent({
      id: "evt-3",
      sessionId: "worker-1",
      threadId: null,
      source: "worker",
      type: "message.completed",
      timestamp: "2026-03-15T00:00:03.000Z",
      payload: {
        role: "assistant",
        text: "Finished processing the task.",
      },
    });
    (harness.manager as any).handleCoreEvent({
      id: "evt-4",
      sessionId: "worker-1",
      threadId: null,
      source: "worker",
      type: "tool.started",
      timestamp: "2026-03-15T00:00:04.000Z",
      payload: {
        toolName: "spawn_agent",
        toolCallId: "tool-1",
        input: { agentId: "reviewer" },
      },
    });
    (harness.manager as any).handleCoreEvent({
      id: "evt-5",
      sessionId: "worker-1",
      threadId: null,
      source: "worker",
      type: "tool.progress",
      timestamp: "2026-03-15T00:00:05.000Z",
      payload: {
        toolName: "spawn_agent",
        toolCallId: "tool-1",
        progress: { stage: "starting" },
      },
    });
    (harness.manager as any).handleCoreEvent({
      id: "evt-6",
      sessionId: "worker-1",
      threadId: null,
      source: "worker",
      type: "tool.completed",
      timestamp: "2026-03-15T00:00:06.000Z",
      payload: {
        toolName: "spawn_agent",
        toolCallId: "tool-1",
        ok: true,
        result: { agentId: "reviewer" },
      },
    });

    expect(harness.conversationLogs).toEqual([
      {
        type: "conversation_log",
        agentId: "worker-1",
        timestamp: "2026-03-15T00:00:03.000Z",
        source: "runtime_log",
        kind: "message_end",
        role: "assistant",
        text: "Finished processing the task.",
      },
    ]);
    expect(harness.toolCalls).toEqual([
      {
        type: "agent_tool_call",
        agentId: "worker-1",
        actorAgentId: "worker-1",
        timestamp: "2026-03-15T00:00:04.000Z",
        kind: "tool_execution_start",
        toolName: "spawn_agent",
        toolCallId: "tool-1",
        text: "{\"agentId\":\"reviewer\"}",
      },
      {
        type: "agent_tool_call",
        agentId: "worker-1",
        actorAgentId: "worker-1",
        timestamp: "2026-03-15T00:00:05.000Z",
        kind: "tool_execution_update",
        toolName: "spawn_agent",
        toolCallId: "tool-1",
        text: "{\"stage\":\"starting\"}",
      },
      {
        type: "agent_tool_call",
        agentId: "worker-1",
        actorAgentId: "worker-1",
        timestamp: "2026-03-15T00:00:06.000Z",
        kind: "tool_execution_end",
        toolName: "spawn_agent",
        toolCallId: "tool-1",
        text: "{\"agentId\":\"reviewer\"}",
        isError: false,
      },
    ]);
    expect(harness.appendedMessages).toHaveLength(4);
  });
});
