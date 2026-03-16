import { describe, expect, it, vi } from "vitest";

import type { HostCallRequest } from "swarmd";

import { createConfig } from "../config.js";
import { SwarmManager } from "../swarm/swarm-manager.js";
import type { AgentDescriptor } from "../swarm/types.js";

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

function createManager() {
  return new SwarmManager(
    createConfig({
      installDir: REPO_ROOT,
      projectRoot: REPO_ROOT,
      dataDir: "/tmp/middleman-swarm-host-call",
    }),
  );
}

function toolCall(toolName: string, args: Record<string, unknown> = {}): HostCallRequest {
  return {
    requestId: `${toolName}-request`,
    method: "tool_call",
    payload: {
      toolName,
      args,
    },
  };
}

describe("SwarmManager.handleHostCall", () => {
  it("dispatches shared worker tools through the host bridge", async () => {
    const worker = makeDescriptor({
      agentId: "worker-1",
      managerId: "manager-1",
      role: "worker",
    });
    const manager = createManager();

    (manager as any).lifecycle = {
      requireDescriptor: vi.fn(() => worker),
    };

    const listAgents = vi.fn(() => [
      makeDescriptor({
        agentId: "manager-1",
        managerId: "manager-1",
        role: "manager",
      }),
      worker,
    ]);
    const sendMessage = vi.fn(async () => ({
      targetAgentId: "worker-2",
      deliveryId: "delivery-1",
      acceptedMode: "steer",
    }));

    vi.spyOn(manager, "listAgents").mockImplementation(listAgents);
    vi.spyOn(manager, "sendMessage").mockImplementation(sendMessage as never);

    const listed = await (manager as any).handleHostCall("worker-1", toolCall("list_agents", {}));
    const sent = await (manager as any).handleHostCall(
      "worker-1",
      toolCall("send_message_to_agent", {
        targetAgentId: "worker-2",
        message: "Please review the patch",
        delivery: "steer",
      }),
    );

    expect(listAgents).toHaveBeenCalled();
    expect(listed).toMatchObject({
      details: {
        agents: [
          expect.objectContaining({ agentId: "manager-1" }),
          expect.objectContaining({ agentId: "worker-1" }),
        ],
      },
    });
    expect(sendMessage).toHaveBeenCalledWith(
      "worker-1",
      "worker-2",
      "Please review the patch",
      "steer",
    );
    expect(sent).toMatchObject({
      details: {
        targetAgentId: "worker-2",
        deliveryId: "delivery-1",
        acceptedMode: "steer",
      },
    });
  });

  it("dispatches manager-only host tools through the bridge", async () => {
    const descriptor = makeDescriptor({
      agentId: "manager-1",
      managerId: "manager-1",
      role: "manager",
    });
    const spawned = makeDescriptor({
      agentId: "reviewer",
      managerId: "manager-1",
      role: "worker",
    });
    const manager = createManager();

    (manager as any).lifecycle = {
      requireDescriptor: vi.fn(() => descriptor),
    };

    const spawnAgent = vi.fn(async () => spawned);
    const publishToUser = vi.fn(async () => ({
      targetContext: {
        channel: "web",
      },
    }));
    const killAgent = vi.fn(async () => undefined);

    vi.spyOn(manager, "spawnAgent").mockImplementation(spawnAgent as never);
    vi.spyOn(manager, "publishToUser").mockImplementation(publishToUser as never);
    vi.spyOn(manager, "killAgent").mockImplementation(killAgent as never);

    const spawnResult = await (manager as any).handleHostCall(
      "manager-1",
      toolCall("spawn_agent", {
        agentId: "reviewer",
        model: "pi-opus",
        initialMessage: "Review the migration",
      }),
    );
    const speakResult = await (manager as any).handleHostCall(
      "manager-1",
      toolCall("speak_to_user", {
        text: "Review complete",
      }),
    );
    const killResult = await (manager as any).handleHostCall(
      "manager-1",
      toolCall("kill_agent", {
        targetAgentId: "reviewer",
      }),
    );

    expect(spawnAgent).toHaveBeenCalledWith("manager-1", {
      agentId: "reviewer",
      model: "pi-opus",
      initialMessage: "Review the migration",
      archetypeId: undefined,
      systemPrompt: undefined,
      cwd: undefined,
    });
    expect(spawnResult).toMatchObject({
      details: {
        agentId: "reviewer",
      },
    });
    expect(publishToUser).toHaveBeenCalledWith(
      "manager-1",
      "Review complete",
      "speak_to_user",
      undefined,
    );
    expect(speakResult).toMatchObject({
      details: {
        published: true,
        targetContext: {
          channel: "web",
        },
      },
    });
    expect(killAgent).toHaveBeenCalledWith("manager-1", "reviewer");
    expect(killResult).toMatchObject({
      details: {
        targetAgentId: "reviewer",
        terminated: true,
      },
    });
  });

  it("rejects unsupported host call methods and unknown tools", async () => {
    const descriptor = makeDescriptor({
      agentId: "manager-1",
      managerId: "manager-1",
      role: "manager",
    });
    const manager = createManager();

    (manager as any).lifecycle = {
      requireDescriptor: vi.fn(() => descriptor),
    };

    await expect(
      (manager as any).handleHostCall("manager-1", {
        requestId: "bad-method",
        method: "not_supported",
        payload: {
          toolName: "list_agents",
          args: {},
        },
      }),
    ).rejects.toThrow("Unsupported host call method: not_supported");
    await expect(
      (manager as any).handleHostCall("manager-1", toolCall("does_not_exist", {})),
    ).rejects.toThrow("Unknown tool: does_not_exist");
  });

  it("stops errored sessions before restarting them for new input", async () => {
    const descriptor = makeDescriptor({
      agentId: "worker-1",
      managerId: "manager-1",
      role: "worker",
      status: "errored",
    });
    const manager = createManager();
    const stop = vi.fn(async () => undefined);
    const start = vi.fn(async () => undefined);

    (manager as any).lifecycle = {
      requireDescriptor: vi.fn(() => descriptor),
    };
    (manager as any).core = {
      sessionService: {
        stop,
        start,
      },
    };

    await expect((manager as any).ensureAgentReadyForInput("worker-1")).resolves.toEqual(descriptor);

    expect(stop).toHaveBeenCalledWith("worker-1");
    expect(start).toHaveBeenCalledWith("worker-1");
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[0]);
  });
});
