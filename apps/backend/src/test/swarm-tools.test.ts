import { describe, expect, it } from "vitest";
import { buildSwarmTools, type SwarmToolHost } from "../swarm/swarm-tools.js";
import type { AgentDescriptor, SendMessageReceipt, SpawnAgentInput } from "../swarm/types.js";

function makeManagerDescriptor(agentId = "manager"): AgentDescriptor {
  return {
    agentId,
    displayName: agentId,
    role: "manager",
    managerId: agentId,
    archetypeId: "manager",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp/swarm",
    model: {
      provider: "openai-codex",
      modelId: "gpt-5.4",
      thinkingLevel: "xhigh",
    },
  };
}

function makeWorkerDescriptor(agentId: string, managerId = "manager"): AgentDescriptor {
  return {
    agentId,
    displayName: agentId,
    role: "worker",
    managerId,
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp/swarm",
    model: {
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      thinkingLevel: "xhigh",
    },
  };
}

function makeHost(
  spawnImpl: (callerAgentId: string, input: SpawnAgentInput) => Promise<AgentDescriptor>,
): SwarmToolHost {
  return {
    listAgents(): AgentDescriptor[] {
      return [makeManagerDescriptor()];
    },
    spawnAgent: spawnImpl,
    async killAgent(): Promise<void> {},
    async sendMessage(): Promise<SendMessageReceipt> {
      return {
        targetAgentId: "worker",
        deliveryId: "delivery-1",
        acceptedMode: "prompt",
      };
    },
    async publishToUser(): Promise<{ targetContext: { channel: "web" } }> {
      return {
        targetContext: { channel: "web" },
      };
    },
  };
}

describe("buildSwarmTools", () => {
  it("returns stopped agents by default while keeping errored and terminated agents opt-in", async () => {
    const activeManager = makeManagerDescriptor();
    const createdWorker: AgentDescriptor = {
      ...makeWorkerDescriptor("worker-created"),
      status: "created",
    };
    const startingWorker: AgentDescriptor = {
      ...makeWorkerDescriptor("worker-starting"),
      status: "starting",
    };
    const activeWorker = makeWorkerDescriptor("worker-idle");
    const busyWorker: AgentDescriptor = {
      ...makeWorkerDescriptor("worker-busy"),
      status: "busy",
    };
    const interruptingWorker: AgentDescriptor = {
      ...makeWorkerDescriptor("worker-interrupting"),
      status: "interrupting",
    };
    const stoppingWorker: AgentDescriptor = {
      ...makeWorkerDescriptor("worker-stopping"),
      status: "stopping",
    };
    const stoppedWorker: AgentDescriptor = {
      ...makeWorkerDescriptor("worker-stopped"),
      status: "stopped",
    };
    const erroredWorker: AgentDescriptor = {
      ...makeWorkerDescriptor("worker-errored"),
      status: "errored",
    };
    const terminatedWorker: AgentDescriptor = {
      ...makeWorkerDescriptor("worker-terminated"),
      status: "terminated",
    };

    const host: SwarmToolHost = {
      listAgents: () => [
        activeManager,
        createdWorker,
        startingWorker,
        activeWorker,
        busyWorker,
        interruptingWorker,
        stoppingWorker,
        stoppedWorker,
        erroredWorker,
        terminatedWorker,
      ],
      spawnAgent: async () => makeWorkerDescriptor("worker"),
      killAgent: async () => {},
      sendMessage: async () => ({
        targetAgentId: "worker",
        deliveryId: "delivery-1",
        acceptedMode: "prompt",
      }),
      publishToUser: async () => ({
        targetContext: { channel: "web" },
      }),
    };

    const tools = buildSwarmTools(host, makeManagerDescriptor());
    const listAgentsTool = tools.find((tool) => tool.name === "list_agents");
    expect(listAgentsTool).toBeDefined();

    const result = await listAgentsTool!.execute(
      "tool-call",
      {},
      undefined,
      undefined,
      undefined as any,
    );

    expect(result.details).toEqual({
      agents: [
        {
          agentId: "manager",
          role: "manager",
          managerId: "manager",
          status: "idle",
          model: {
            provider: "openai-codex",
            modelId: "gpt-5.4",
            thinkingLevel: "xhigh",
          },
        },
        {
          agentId: "worker-created",
          role: "worker",
          managerId: "manager",
          status: "created",
          model: {
            provider: "anthropic",
            modelId: "claude-opus-4-6",
            thinkingLevel: "xhigh",
          },
        },
        {
          agentId: "worker-starting",
          role: "worker",
          managerId: "manager",
          status: "starting",
          model: {
            provider: "anthropic",
            modelId: "claude-opus-4-6",
            thinkingLevel: "xhigh",
          },
        },
        {
          agentId: "worker-idle",
          role: "worker",
          managerId: "manager",
          status: "idle",
          model: {
            provider: "anthropic",
            modelId: "claude-opus-4-6",
            thinkingLevel: "xhigh",
          },
        },
        {
          agentId: "worker-busy",
          role: "worker",
          managerId: "manager",
          status: "busy",
          model: {
            provider: "anthropic",
            modelId: "claude-opus-4-6",
            thinkingLevel: "xhigh",
          },
        },
        {
          agentId: "worker-interrupting",
          role: "worker",
          managerId: "manager",
          status: "interrupting",
          model: {
            provider: "anthropic",
            modelId: "claude-opus-4-6",
            thinkingLevel: "xhigh",
          },
        },
        {
          agentId: "worker-stopping",
          role: "worker",
          managerId: "manager",
          status: "stopping",
          model: {
            provider: "anthropic",
            modelId: "claude-opus-4-6",
            thinkingLevel: "xhigh",
          },
        },
        {
          agentId: "worker-stopped",
          role: "worker",
          managerId: "manager",
          status: "stopped",
          model: {
            provider: "anthropic",
            modelId: "claude-opus-4-6",
            thinkingLevel: "xhigh",
          },
        },
      ],
    });
    const textContent = result.content.find((block) => block.type === "text");
    expect(textContent?.text).toContain('"agentId": "manager"');
    expect(textContent?.text).toContain('"agentId": "worker-stopped"');
    expect(textContent?.text).toContain('"agentId": "worker-stopping"');
    expect(textContent?.text).not.toContain("worker-errored");
    expect(textContent?.text).not.toContain("worker-terminated");
    expect(textContent?.text).not.toContain("sessionFile");
    expect(textContent?.text).not.toContain("cwd");
    expect(textContent?.text).not.toContain("displayName");

    const resultWithInactive = await listAgentsTool!.execute(
      "tool-call",
      {
        includeTerminated: true,
      },
      undefined,
      undefined,
      undefined as any,
    );

    expect(resultWithInactive.details).toEqual({
      agents: [
        {
          agentId: "manager",
          role: "manager",
          managerId: "manager",
          status: "idle",
          model: {
            provider: "openai-codex",
            modelId: "gpt-5.4",
            thinkingLevel: "xhigh",
          },
        },
        {
          agentId: "worker-created",
          role: "worker",
          managerId: "manager",
          status: "created",
          model: {
            provider: "anthropic",
            modelId: "claude-opus-4-6",
            thinkingLevel: "xhigh",
          },
        },
        {
          agentId: "worker-starting",
          role: "worker",
          managerId: "manager",
          status: "starting",
          model: {
            provider: "anthropic",
            modelId: "claude-opus-4-6",
            thinkingLevel: "xhigh",
          },
        },
        {
          agentId: "worker-idle",
          role: "worker",
          managerId: "manager",
          status: "idle",
          model: {
            provider: "anthropic",
            modelId: "claude-opus-4-6",
            thinkingLevel: "xhigh",
          },
        },
        {
          agentId: "worker-busy",
          role: "worker",
          managerId: "manager",
          status: "busy",
          model: {
            provider: "anthropic",
            modelId: "claude-opus-4-6",
            thinkingLevel: "xhigh",
          },
        },
        {
          agentId: "worker-interrupting",
          role: "worker",
          managerId: "manager",
          status: "interrupting",
          model: {
            provider: "anthropic",
            modelId: "claude-opus-4-6",
            thinkingLevel: "xhigh",
          },
        },
        {
          agentId: "worker-stopping",
          role: "worker",
          managerId: "manager",
          status: "stopping",
          model: {
            provider: "anthropic",
            modelId: "claude-opus-4-6",
            thinkingLevel: "xhigh",
          },
        },
        {
          agentId: "worker-stopped",
          role: "worker",
          managerId: "manager",
          status: "stopped",
          model: {
            provider: "anthropic",
            modelId: "claude-opus-4-6",
            thinkingLevel: "xhigh",
          },
        },
        {
          agentId: "worker-errored",
          role: "worker",
          managerId: "manager",
          status: "errored",
          model: {
            provider: "anthropic",
            modelId: "claude-opus-4-6",
            thinkingLevel: "xhigh",
          },
        },
        {
          agentId: "worker-terminated",
          role: "worker",
          managerId: "manager",
          status: "terminated",
          model: {
            provider: "anthropic",
            modelId: "claude-opus-4-6",
            thinkingLevel: "xhigh",
          },
        },
      ],
    });
    const includeInactiveText = resultWithInactive.content.find((block) => block.type === "text");
    expect(includeInactiveText?.text).toContain("worker-created");
    expect(includeInactiveText?.text).toContain("worker-starting");
    expect(includeInactiveText?.text).toContain("worker-busy");
    expect(includeInactiveText?.text).toContain("worker-interrupting");
    expect(includeInactiveText?.text).toContain("worker-stopping");
    expect(includeInactiveText?.text).toContain("worker-stopped");
    expect(includeInactiveText?.text).toContain("worker-errored");
    expect(includeInactiveText?.text).toContain("worker-terminated");
    expect(includeInactiveText?.text).not.toContain("sessionFile");
    expect(includeInactiveText?.text).not.toContain("cwd");
  });

  it("lets managers opt into external manager discovery without exposing other teams workers", async () => {
    const host: SwarmToolHost = {
      listAgents: () => [
        makeManagerDescriptor(),
        makeManagerDescriptor("manager-two"),
        makeWorkerDescriptor("worker-owned"),
        makeWorkerDescriptor("worker-external", "manager-two"),
      ],
      spawnAgent: async () => makeWorkerDescriptor("worker"),
      killAgent: async () => {},
      sendMessage: async () => ({
        targetAgentId: "worker",
        deliveryId: "delivery-1",
        acceptedMode: "prompt",
      }),
      publishToUser: async () => ({
        targetContext: { channel: "web" },
      }),
    };

    const tools = buildSwarmTools(host, makeManagerDescriptor());
    const listAgentsTool = tools.find((tool) => tool.name === "list_agents");
    expect(listAgentsTool).toBeDefined();

    const result = await listAgentsTool!.execute(
      "tool-call",
      {
        includeManagers: true,
      },
      undefined,
      undefined,
      undefined as any,
    );

    expect(result.details).toEqual({
      agents: [
        {
          agentId: "manager",
          role: "manager",
          managerId: "manager",
          status: "idle",
          model: {
            provider: "openai-codex",
            modelId: "gpt-5.4",
            thinkingLevel: "xhigh",
          },
        },
        {
          agentId: "worker-owned",
          role: "worker",
          managerId: "manager",
          status: "idle",
          model: {
            provider: "anthropic",
            modelId: "claude-opus-4-6",
            thinkingLevel: "xhigh",
          },
        },
        {
          agentId: "manager-two",
          role: "manager",
          managerId: "manager-two",
          status: "idle",
          model: {
            provider: "openai-codex",
            modelId: "gpt-5.4",
            thinkingLevel: "xhigh",
          },
          isExternal: true,
        },
      ],
    });

    const textContent = result.content.find((block) => block.type === "text");
    expect(textContent?.text).toContain('"agentId": "manager-two"');
    expect(textContent?.text).toContain('"isExternal": true');
    expect(textContent?.text).not.toContain("worker-external");
  });

  it("passes includeArchived through to the host and still hides archived agents by default", async () => {
    const archivedWorker: AgentDescriptor = {
      ...makeWorkerDescriptor("worker-archived"),
      status: "terminated",
    };
    const listCalls: Array<{ includeArchived?: boolean } | undefined> = [];

    const host: SwarmToolHost = {
      listAgents: (options) => {
        listCalls.push(options);
        return [
          makeManagerDescriptor(),
          makeWorkerDescriptor("worker-active"),
          ...(options?.includeArchived ? [archivedWorker] : []),
        ];
      },
      spawnAgent: async () => makeWorkerDescriptor("worker"),
      killAgent: async () => {},
      sendMessage: async () => ({
        targetAgentId: "worker",
        deliveryId: "delivery-1",
        acceptedMode: "prompt",
      }),
      publishToUser: async () => ({
        targetContext: { channel: "web" },
      }),
    };

    const tools = buildSwarmTools(host, makeManagerDescriptor());
    const listAgentsTool = tools.find((tool) => tool.name === "list_agents");
    expect(listAgentsTool).toBeDefined();

    const defaultResult = await listAgentsTool!.execute(
      "tool-call",
      {},
      undefined,
      undefined,
      undefined as any,
    );

    expect(listCalls[0]).toEqual({ includeArchived: false });
    expect(defaultResult.details).toEqual({
      agents: [
        {
          agentId: "manager",
          role: "manager",
          managerId: "manager",
          status: "idle",
          model: {
            provider: "openai-codex",
            modelId: "gpt-5.4",
            thinkingLevel: "xhigh",
          },
        },
        {
          agentId: "worker-active",
          role: "worker",
          managerId: "manager",
          status: "idle",
          model: {
            provider: "anthropic",
            modelId: "claude-opus-4-6",
            thinkingLevel: "xhigh",
          },
        },
      ],
    });

    const archivedResult = await listAgentsTool!.execute(
      "tool-call",
      {
        includeArchived: true,
        includeTerminated: true,
      },
      undefined,
      undefined,
      undefined as any,
    );

    expect(listCalls[1]).toEqual({ includeArchived: true });
    expect(archivedResult.details).toEqual({
      agents: [
        {
          agentId: "manager",
          role: "manager",
          managerId: "manager",
          status: "idle",
          model: {
            provider: "openai-codex",
            modelId: "gpt-5.4",
            thinkingLevel: "xhigh",
          },
        },
        {
          agentId: "worker-active",
          role: "worker",
          managerId: "manager",
          status: "idle",
          model: {
            provider: "anthropic",
            modelId: "claude-opus-4-6",
            thinkingLevel: "xhigh",
          },
        },
        {
          agentId: "worker-archived",
          role: "worker",
          managerId: "manager",
          status: "terminated",
          model: {
            provider: "anthropic",
            modelId: "claude-opus-4-6",
            thinkingLevel: "xhigh",
          },
        },
      ],
    });
  });

  it("propagates spawn_agent model preset to host.spawnAgent", async () => {
    let receivedInput: SpawnAgentInput | undefined;

    const host = makeHost(async (_callerAgentId, input) => {
      receivedInput = input;
      return makeWorkerDescriptor("worker-opus");
    });

    const tools = buildSwarmTools(host, makeManagerDescriptor());
    const spawnTool = tools.find((tool) => tool.name === "spawn_agent");
    expect(spawnTool).toBeDefined();

    const result = await spawnTool!.execute(
      "tool-call",
      {
        agentId: "Worker Opus",
        model: "pi-opus",
        thinkingLevel: "low",
      },
      undefined,
      undefined,
      undefined as any,
    );

    expect(receivedInput?.model).toBe("pi-opus");
    expect(receivedInput?.thinkingLevel).toBe("low");
    expect(result.details).toMatchObject({
      agentId: "worker-opus",
      model: {
        provider: "anthropic",
        modelId: "claude-opus-4-6",
        thinkingLevel: "xhigh",
      },
    });
  });

  it("rejects invalid spawn_agent model presets with a clear error", async () => {
    const host = makeHost(async () => makeWorkerDescriptor("worker"));

    const tools = buildSwarmTools(host, makeManagerDescriptor());
    const spawnTool = tools.find((tool) => tool.name === "spawn_agent");
    expect(spawnTool).toBeDefined();

    await expect(
      spawnTool!.execute(
        "tool-call",
        {
          agentId: "Worker Invalid",
          model: "not-allowed-model",
        } as any,
        undefined,
        undefined,
        undefined as any,
      ),
    ).rejects.toThrow("spawn_agent.model must be one of pi-codex|pi-opus|codex-app|claude-code");
  });

  it("rejects invalid spawn_agent thinking levels with a clear error", async () => {
    const host = makeHost(async () => makeWorkerDescriptor("worker"));

    const tools = buildSwarmTools(host, makeManagerDescriptor());
    const spawnTool = tools.find((tool) => tool.name === "spawn_agent");
    expect(spawnTool).toBeDefined();

    await expect(
      spawnTool!.execute(
        "tool-call",
        {
          agentId: "Worker Invalid Thinking",
          thinkingLevel: "max",
        } as any,
        undefined,
        undefined,
        undefined as any,
      ),
    ).rejects.toThrow("spawn_agent.thinkingLevel must be one of off|low|medium|high|xhigh");
  });

  it("does not inject task management tools for managers", () => {
    const tools = buildSwarmTools(
      makeHost(async () => makeWorkerDescriptor("worker")),
      makeManagerDescriptor(),
    );

    expect(tools.some((tool) => tool.name === "assign_task")).toBe(false);
    expect(tools.some((tool) => tool.name === "get_outstanding_tasks")).toBe(false);
  });

  it("includes available archetype ids in the spawn_agent schema description", () => {
    const tools = buildSwarmTools(
      makeHost(async () => makeWorkerDescriptor("worker")),
      makeManagerDescriptor(),
      {
        availableArchetypeIds: ["manager", "merger"],
      },
    );
    const spawnTool = tools.find((tool) => tool.name === "spawn_agent");
    expect(spawnTool).toBeDefined();

    expect(JSON.stringify(spawnTool!.parameters)).toContain(
      "Available archetype ids: manager, merger.",
    );
  });

  it("returns the resolved speak_to_user target context without an explicit target override", async () => {
    let receivedTarget: { channel: "web" } | undefined;

    const host: SwarmToolHost = {
      listAgents: () => [makeManagerDescriptor()],
      spawnAgent: async () => makeWorkerDescriptor("worker"),
      killAgent: async () => {},
      sendMessage: async () => ({
        targetAgentId: "worker",
        deliveryId: "delivery-1",
        acceptedMode: "prompt",
      }),
      publishToUser: async (_agentId, _text, _source, targetContext) => {
        receivedTarget = targetContext;
        return {
          targetContext: {
            channel: targetContext?.channel ?? "web",
          },
        };
      },
    };

    const tools = buildSwarmTools(host, makeManagerDescriptor());
    const speakTool = tools.find((tool) => tool.name === "speak_to_user");
    expect(speakTool).toBeDefined();

    const result = await speakTool!.execute(
      "tool-call",
      {
        text: "Reply on the web",
      },
      undefined,
      undefined,
      undefined as any,
    );

    expect(receivedTarget).toBeUndefined();
    expect(result.details).toMatchObject({
      published: true,
      targetContext: {
        channel: "web",
      },
    });
  });
});
