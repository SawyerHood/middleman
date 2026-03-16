import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import type { AgentDescriptor, ServerEvent } from "@middleman/protocol";
import { createConfig } from "../config.js";
import { WsHandler } from "../ws/ws-handler.js";

function createSocket() {
  const events: ServerEvent[] = [];
  return {
    events,
    socket: {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send(payload: string) {
        events.push(JSON.parse(payload) as ServerEvent);
      },
    } as unknown as WebSocket,
  };
}

function createManagerStub(status: AgentDescriptor["status"] = "idle") {
  const manager: AgentDescriptor = {
    agentId: "manager-1",
    managerId: "manager-1",
    displayName: "manager-1",
    role: "manager",
    status,
    createdAt: "2026-03-14T00:00:00.000Z",
    updatedAt: "2026-03-14T00:00:00.000Z",
    cwd: "/tmp/project",
    model: {
      provider: "openai-codex-app-server",
      modelId: "gpt-5.4",
      thinkingLevel: "xhigh",
    },
  };

  return {
    getAgent(agentId: string) {
      return agentId === manager.agentId ? manager : undefined;
    },
    listAgents() {
      return [manager];
    },
    getVisibleTranscript(agentId?: string) {
      return agentId === manager.agentId
        ? [
            {
              type: "conversation_message" as const,
              agentId: manager.agentId,
              role: "assistant" as const,
              text: "hello",
              timestamp: "2026-03-14T00:00:01.000Z",
              source: "speak_to_user" as const,
            },
          ]
        : [];
    },
    getConversationHistory() {
      return [];
    },
    getConfig() {
      return createConfig({
        installDir: process.cwd(),
        projectRoot: process.cwd(),
        dataDir: "/tmp/middleman-test",
      });
    },
  };
}

function createRichManagerStub() {
  const manager: AgentDescriptor = {
    agentId: "manager-1",
    managerId: "manager-1",
    displayName: "manager-1",
    role: "manager",
    status: "idle",
    createdAt: "2026-03-14T00:00:00.000Z",
    updatedAt: "2026-03-14T00:00:00.000Z",
    cwd: "/tmp/project",
    model: {
      provider: "openai-codex-app-server",
      modelId: "gpt-5.4",
      thinkingLevel: "xhigh",
    },
  };
  const worker: AgentDescriptor = {
    agentId: "worker-1",
    managerId: "manager-1",
    displayName: "worker-1",
    role: "worker",
    status: "stopped",
    createdAt: "2026-03-14T00:00:02.000Z",
    updatedAt: "2026-03-14T00:00:02.000Z",
    cwd: "/tmp/project",
    model: {
      provider: "anthropic-claude-code",
      modelId: "claude-opus-4-6",
      thinkingLevel: "xhigh",
    },
  };

  return {
    createManager: vi.fn(async () => ({
      ...manager,
      agentId: "manager-2",
      managerId: "manager-2",
      displayName: "manager-2",
    })),
    deleteManager: vi.fn(async () => ({
      managerId: manager.agentId,
      terminatedWorkerIds: [worker.agentId],
    })),
    getAgent(agentId: string) {
      return [manager, worker].find((agent) => agent.agentId === agentId);
    },
    listAgents() {
      return [manager, worker];
    },
    handleUserMessage: vi.fn(async () => undefined),
    getVisibleTranscript(agentId?: string) {
      return agentId === manager.agentId
        ? [
            {
              type: "conversation_message" as const,
              agentId: manager.agentId,
              role: "assistant" as const,
              text: "hello",
              timestamp: "2026-03-14T00:00:01.000Z",
              source: "speak_to_user" as const,
            },
          ]
        : [];
    },
    getConversationHistory(agentId?: string) {
      return agentId === worker.agentId
        ? [
            {
              type: "conversation_message" as const,
              agentId: worker.agentId,
              role: "user" as const,
              text: "debug the crash",
              timestamp: "2026-03-14T00:00:03.000Z",
              source: "user_input" as const,
            },
            {
              type: "agent_message" as const,
              agentId: manager.agentId,
              fromAgentId: manager.agentId,
              toAgentId: worker.agentId,
              text: "investigate",
              timestamp: "2026-03-14T00:00:04.000Z",
              source: "agent_to_agent" as const,
            },
          ]
        : [];
    },
    getConfig() {
      return createConfig({
        installDir: process.cwd(),
        projectRoot: process.cwd(),
        dataDir: "/tmp/middleman-test",
      });
    },
  };
}

function createEmptyManagerStub() {
  return {
    getAgent() {
      return undefined;
    },
    listAgents() {
      return [];
    },
    getVisibleTranscript() {
      return [];
    },
    getConversationHistory() {
      return [];
    },
    getConfig() {
      return createConfig({
        installDir: process.cwd(),
        projectRoot: process.cwd(),
        dataDir: "/tmp/middleman-test",
      });
    },
  };
}

describe("WsHandler", () => {
  it("sends ready, agents snapshot, and transcript bootstrap on subscribe", async () => {
    const handler = new WsHandler({
      swarmManager: createManagerStub() as never,
      integrationRegistry: null,
      allowNonManagerSubscriptions: true,
    });
    const { events, socket } = createSocket();

    await (handler as any).handleSubscribe(socket, "manager-1");

    expect(events.map((event) => event.type)).toEqual([
      "ready",
      "agents_snapshot",
      "conversation_history",
    ]);
    expect(events[0]).toMatchObject({
      type: "ready",
      subscribedAgentId: "manager-1",
    });
    expect(events[2]).toMatchObject({
      type: "conversation_history",
      agentId: "manager-1",
      messages: [
        expect.objectContaining({
          type: "conversation_message",
          text: "hello",
        }),
      ],
    });
  });

  it("broadcasts conversation events only to matching subscriptions", () => {
    const handler = new WsHandler({
      swarmManager: createManagerStub() as never,
      integrationRegistry: null,
      allowNonManagerSubscriptions: true,
    });
    const primary = createSocket();
    const secondary = createSocket();

    (handler as any).wss = {
      clients: new Set([primary.socket, secondary.socket]),
    };
    (handler as any).subscriptions.set(primary.socket, "manager-1");
    (handler as any).subscriptions.set(secondary.socket, "other-manager");

    handler.broadcastToSubscribed({
      type: "conversation_message",
      agentId: "manager-1",
      role: "assistant",
      text: "scoped",
      timestamp: "2026-03-14T00:00:01.000Z",
      source: "speak_to_user",
    });

    expect(primary.events.at(-1)).toMatchObject({
      type: "conversation_message",
      agentId: "manager-1",
      text: "scoped",
    });
    expect(secondary.events).toEqual([]);
  });

  it("bootstraps subscriptions against persisted stopped managers", async () => {
    const handler = new WsHandler({
      swarmManager: createManagerStub("stopped") as never,
      integrationRegistry: null,
      allowNonManagerSubscriptions: true,
    });
    const { events, socket } = createSocket();

    await (handler as any).handleSubscribe(socket);

    expect(events[0]).toMatchObject({
      type: "ready",
      subscribedAgentId: "manager-1",
    });
    expect(events[1]).toMatchObject({
      type: "agents_snapshot",
      agents: [expect.objectContaining({ agentId: "manager-1", status: "stopped" })],
    });
    expect(events[2]).toMatchObject({
      type: "conversation_history",
      agentId: "manager-1",
    });
  });

  it("bootstraps fresh sessions against the synthetic bootstrap manager", async () => {
    const handler = new WsHandler({
      swarmManager: createEmptyManagerStub() as never,
      integrationRegistry: null,
      allowNonManagerSubscriptions: true,
    });
    const { events, socket } = createSocket();

    await (handler as any).handleSubscribe(socket);

    expect(events).toEqual([
      expect.objectContaining({
        type: "ready",
        subscribedAgentId: "__bootstrap_manager__",
      }),
      {
        type: "agents_snapshot",
        agents: [],
      },
      {
        type: "conversation_history",
        agentId: "__bootstrap_manager__",
        messages: [],
      },
    ]);
  });

  it("loads full agent detail history when subscribing to a worker thread", async () => {
    const swarmManager = createRichManagerStub();
    const handler = new WsHandler({
      swarmManager: swarmManager as never,
      integrationRegistry: null,
      allowNonManagerSubscriptions: true,
    });
    const { events, socket } = createSocket();

    await (handler as any).handleSocketMessage(socket, JSON.stringify({ type: "subscribe", agentId: "manager-1" }));
    await (handler as any).handleSocketMessage(
      socket,
      JSON.stringify({ type: "subscribe_agent_detail", agentId: "worker-1" }),
    );

    expect(events.at(-1)).toMatchObject({
      type: "conversation_history",
      agentId: "worker-1",
      messages: [
        expect.objectContaining({ type: "conversation_message", text: "debug the crash" }),
        expect.objectContaining({ type: "agent_message", text: "investigate" }),
      ],
    });
  });

  it("dispatches user_message through the conversation route after subscribe", async () => {
    const swarmManager = createRichManagerStub();
    const handler = new WsHandler({
      swarmManager: swarmManager as never,
      integrationRegistry: null,
      allowNonManagerSubscriptions: true,
    });
    const { events, socket } = createSocket();

    await (handler as any).handleSocketMessage(socket, JSON.stringify({ type: "subscribe", agentId: "manager-1" }));
    await (handler as any).handleSocketMessage(
      socket,
      JSON.stringify({
        type: "user_message",
        text: "Ship the migration",
        agentId: "manager-1",
        delivery: "followUp",
      }),
    );

    expect(swarmManager.handleUserMessage).toHaveBeenCalledWith("Ship the migration", {
      targetAgentId: "manager-1",
      delivery: "followUp",
      attachments: undefined,
      sourceContext: { channel: "web" },
    });
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  it("routes create_manager and delete_manager commands with request ids", async () => {
    const swarmManager = createRichManagerStub();
    const handler = new WsHandler({
      swarmManager: swarmManager as never,
      integrationRegistry: null,
      allowNonManagerSubscriptions: true,
    });
    const { events, socket } = createSocket();
    (handler as any).wss = {
      clients: new Set([socket]),
    };

    await (handler as any).handleSocketMessage(socket, JSON.stringify({ type: "subscribe", agentId: "manager-1" }));
    await (handler as any).handleSocketMessage(
      socket,
      JSON.stringify({
        type: "create_manager",
        name: "Ops",
        cwd: "/tmp/project",
        requestId: "create-1",
      }),
    );
    await (handler as any).handleSocketMessage(
      socket,
      JSON.stringify({
        type: "delete_manager",
        managerId: "manager-1",
        requestId: "delete-1",
      }),
    );

    expect(swarmManager.createManager).toHaveBeenCalledWith("manager-1", {
      name: "Ops",
      cwd: "/tmp/project",
      model: undefined,
    });
    expect(swarmManager.deleteManager).toHaveBeenCalledWith("manager-1", "manager-1");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "manager_created",
        requestId: "create-1",
        manager: expect.objectContaining({ agentId: "manager-2" }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "manager_deleted",
        requestId: "delete-1",
        managerId: "manager-1",
        terminatedWorkerIds: ["worker-1"],
      }),
    );
  });

  it("returns invalid-command and not-subscribed errors for bad websocket commands", async () => {
    const handler = new WsHandler({
      swarmManager: createRichManagerStub() as never,
      integrationRegistry: null,
      allowNonManagerSubscriptions: true,
    });
    const { events, socket } = createSocket();

    await (handler as any).handleSocketMessage(socket, "{not json");
    await (handler as any).handleSocketMessage(
      socket,
      JSON.stringify({
        type: "user_message",
        text: "hello",
      }),
    );

    expect(events).toEqual([
      {
        type: "error",
        code: "INVALID_COMMAND",
        message: "Command must be valid JSON",
      },
      {
        type: "error",
        code: "NOT_SUBSCRIBED",
        message: "Send subscribe before user_message.",
      },
    ]);
  });
});
