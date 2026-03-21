import { AGENT_THINKING_LEVELS } from "@middleman/protocol";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { parseSwarmModelPreset, parseSwarmThinkingLevel } from "./model-presets.js";
import {
  type AgentDescriptor,
  type AgentStatus,
  type AgentThinkingLevel,
  type MessageSourceContext,
  type MessageTargetContext,
  type RequestedDeliveryMode,
  type SendMessageReceipt,
  type SwarmModelPreset,
  SWARM_MODEL_PRESETS,
  type SpawnAgentInput,
} from "./types.js";

export interface SwarmToolHost {
  listAgents(options?: { includeArchived?: boolean }): AgentDescriptor[];
  spawnAgent(callerAgentId: string, input: SpawnAgentInput): Promise<AgentDescriptor>;
  killAgent(callerAgentId: string, targetAgentId: string): Promise<void>;
  sendMessage(
    fromAgentId: string,
    targetAgentId: string,
    message: string,
    delivery?: RequestedDeliveryMode,
  ): Promise<SendMessageReceipt>;
  publishToUser(
    agentId: string,
    text: string,
    source?: "speak_to_user" | "system",
    targetContext?: MessageTargetContext,
  ): Promise<{ targetContext: MessageSourceContext }>;
}

interface BuildSwarmToolsOptions {
  availableArchetypeIds?: string[];
}

const deliveryModeSchema = Type.Union([
  Type.Literal("auto"),
  Type.Literal("followUp"),
  Type.Literal("steer"),
]);

const spawnModelPresetSchema = Type.Unsafe<SwarmModelPreset>({
  type: "string",
  enum: [...SWARM_MODEL_PRESETS],
});

const spawnThinkingLevelSchema = Type.Unsafe<AgentThinkingLevel>({
  type: "string",
  enum: [...AGENT_THINKING_LEVELS],
});

type ListAgentsEntry = Pick<
  AgentDescriptor,
  "agentId" | "role" | "managerId" | "status" | "model"
> & {
  isExternal?: boolean;
};

const ACTIVE_AGENT_STATUSES = new Set<AgentStatus>([
  "created",
  "starting",
  "idle",
  "busy",
  "interrupting",
  "stopping",
  "stopped",
]);

function buildVisibleAgentEntries(
  caller: AgentDescriptor,
  agents: AgentDescriptor[],
  options: {
    includeArchived?: boolean;
    includeManagers?: boolean;
    includeTerminated?: boolean;
  },
): ListAgentsEntry[] {
  const teamManagerId = caller.role === "manager" ? caller.agentId : caller.managerId;
  const includeInactive = options.includeTerminated === true;

  const isVisible = (agent: AgentDescriptor): boolean => {
    if (!includeInactive && !ACTIVE_AGENT_STATUSES.has(agent.status)) {
      return false;
    }

    if (agent.role === "manager") {
      if (agent.agentId === teamManagerId) {
        return true;
      }

      return caller.role === "manager" && options.includeManagers === true;
    }

    return agent.managerId === teamManagerId;
  };

  const teamAgents: ListAgentsEntry[] = [];
  const externalManagers: ListAgentsEntry[] = [];

  for (const agent of agents) {
    if (!isVisible(agent)) {
      continue;
    }

    const entry: ListAgentsEntry = {
      agentId: agent.agentId,
      role: agent.role,
      managerId: agent.managerId,
      status: agent.status,
      model: agent.model,
    };

    if (agent.role === "manager" && agent.agentId !== teamManagerId) {
      externalManagers.push({
        ...entry,
        isExternal: true,
      });
      continue;
    }

    teamAgents.push(entry);
  }

  return [...teamAgents, ...externalManagers];
}

export function buildSwarmTools(
  host: SwarmToolHost,
  descriptor: AgentDescriptor,
  options: BuildSwarmToolsOptions = {},
): ToolDefinition[] {
  const availableArchetypeIds = options.availableArchetypeIds ?? [];
  const archetypeIdDescriptionSuffix =
    availableArchetypeIds.length > 0
      ? ` Available archetype ids: ${availableArchetypeIds.join(", ")}.`
      : "";
  const shared: ToolDefinition[] = [
    {
      name: "list_agents",
      label: "List Agents",
      description:
        "List the caller's current team with ids, roles, manager ids, status, and model. Returns non-archived team agents by default, including stopping/stopped sessions; set includeTerminated=true to include errored and terminated agents, and includeArchived=true to include archived sessions. Managers can set includeManagers=true to also include other managers in the system, flagged with isExternal=true.",
      parameters: Type.Object({
        includeTerminated: Type.Optional(
          Type.Boolean({
            description:
              "When true, include all agent statuses, including errored and terminated agents.",
          }),
        ),
        includeArchived: Type.Optional(
          Type.Boolean({
            description:
              "When true, include archived agents in the candidate set. Combine with includeTerminated=true to surface archived errored or terminated agents.",
          }),
        ),
        includeManagers: Type.Optional(
          Type.Boolean({
            description:
              "Manager only. When true, also include other managers outside the caller's own team.",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const parsed = params as {
          includeTerminated?: boolean;
          includeArchived?: boolean;
          includeManagers?: boolean;
        };
        const agents = buildVisibleAgentEntries(
          descriptor,
          host.listAgents({ includeArchived: parsed.includeArchived === true }),
          parsed,
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ agents }, null, 2),
            },
          ],
          details: { agents },
        };
      },
    },
    {
      name: "send_message_to_agent",
      label: "Send Message To Agent",
      description:
        "Send a message to another agent by id. Returns immediately with a delivery receipt. If target is busy, queued delivery is accepted as steer.",
      parameters: Type.Object({
        targetAgentId: Type.String({ description: "Agent id to receive the message." }),
        message: Type.String({ description: "Message text to deliver." }),
        delivery: Type.Optional(deliveryModeSchema),
      }),
      async execute(_toolCallId, params) {
        const parsed = params as {
          targetAgentId: string;
          message: string;
          delivery?: RequestedDeliveryMode;
        };

        const receipt = await host.sendMessage(
          descriptor.agentId,
          parsed.targetAgentId,
          parsed.message,
          parsed.delivery,
        );

        return {
          content: [
            {
              type: "text",
              text: `Queued message for ${receipt.targetAgentId}. deliveryId=${receipt.deliveryId}, mode=${receipt.acceptedMode}`,
            },
          ],
          details: receipt,
        };
      },
    },
  ];

  if (descriptor.role !== "manager") {
    return shared;
  }

  const managerOnly: ToolDefinition[] = [
    {
      name: "spawn_agent",
      label: "Spawn Agent",
      description:
        "Create and start a new worker agent. agentId is required and normalized to lowercase kebab-case; if taken, a numeric suffix (-2, -3, …) is appended. archetypeId, systemPrompt, model, thinkingLevel, cwd, and initialMessage are optional. model accepts pi-codex|pi-opus|codex-app|claude-code. thinkingLevel accepts off|low|medium|high|xhigh.",
      parameters: Type.Object({
        agentId: Type.String({
          description:
            "Required agent identifier. Normalized to lowercase kebab-case; collisions are suffixed numerically.",
        }),
        archetypeId: Type.Optional(
          Type.String({
            description: `Optional archetype id.${archetypeIdDescriptionSuffix}`,
          }),
        ),
        systemPrompt: Type.Optional(
          Type.String({ description: "Optional system prompt override." }),
        ),
        model: Type.Optional(spawnModelPresetSchema),
        thinkingLevel: Type.Optional(spawnThinkingLevelSchema),
        cwd: Type.Optional(Type.String({ description: "Optional working directory override." })),
        initialMessage: Type.Optional(
          Type.String({ description: "Optional first message to send after spawn." }),
        ),
      }),
      async execute(_toolCallId, params) {
        const parsed = params as {
          agentId: string;
          archetypeId?: string;
          systemPrompt?: string;
          model?: unknown;
          thinkingLevel?: unknown;
          cwd?: string;
          initialMessage?: string;
        };

        const spawned = await host.spawnAgent(descriptor.agentId, {
          agentId: parsed.agentId,
          archetypeId: parsed.archetypeId,
          systemPrompt: parsed.systemPrompt,
          model: parseSwarmModelPreset(parsed.model, "spawn_agent.model"),
          thinkingLevel: parseSwarmThinkingLevel(parsed.thinkingLevel, "spawn_agent.thinkingLevel"),
          cwd: parsed.cwd,
          initialMessage: parsed.initialMessage,
        });

        return {
          content: [
            {
              type: "text",
              text: `Spawned agent ${spawned.agentId} (${spawned.displayName})`,
            },
          ],
          details: spawned,
        };
      },
    },
    {
      name: "kill_agent",
      label: "Kill Agent",
      description: "Terminate a running worker agent. Manager cannot be terminated.",
      parameters: Type.Object({
        targetAgentId: Type.String({ description: "Agent id to terminate." }),
      }),
      async execute(_toolCallId, params) {
        const parsed = params as { targetAgentId: string };
        await host.killAgent(descriptor.agentId, parsed.targetAgentId);
        return {
          content: [
            {
              type: "text",
              text: `Terminated agent ${parsed.targetAgentId}`,
            },
          ],
          details: {
            targetAgentId: parsed.targetAgentId,
            terminated: true,
          },
        };
      },
    },
    {
      name: "speak_to_user",
      label: "Speak To User",
      description: "Publish a user-visible manager message into the websocket conversation feed.",
      parameters: Type.Object({
        text: Type.String({ description: "Message content to show to the user." }),
      }),
      async execute(_toolCallId, params) {
        const parsed = params as { text: string };

        const published = await host.publishToUser(
          descriptor.agentId,
          parsed.text,
          "speak_to_user",
        );

        return {
          content: [
            {
              type: "text",
              text: `Published message to user (${published.targetContext.channel}).`,
            },
          ],
          details: {
            published: true,
            text: parsed.text,
            targetContext: published.targetContext,
          },
        };
      },
    },
  ];

  return [...shared, ...managerOnly];
}
