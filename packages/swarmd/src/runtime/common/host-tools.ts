import { z } from "zod";

import type { HostRpcClient } from "./adapter.js";

export type MiddlemanRole = "manager" | "worker";

export interface HostToolDefinition {
  name: string;
  label: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface CodexHostToolBridge {
  dynamicTools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
  handleToolCall(call: {
    tool: string;
    callId: string;
    arguments: unknown;
  }): Promise<{
    contentItems: Array<{
      type: "inputText";
      text: string;
    }>;
    success: boolean;
    details?: unknown;
  }>;
}

export interface ClaudeHostToolServer {
  serverName: string;
  server: unknown;
  allowedTools: string[];
}

export interface PiHostToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details?: unknown;
    isError?: boolean;
  }>;
}

const MESSAGE_CHANNEL_VALUES = ["web", "slack", "telegram"] as const;
const DELIVERY_MODE_VALUES = ["auto", "followUp", "steer"] as const;
const SPAWN_MODEL_PRESET_VALUES = ["pi-codex", "pi-opus", "codex-app", "claude-code"] as const;
const CLAUDE_SERVER_NAME = "middleman-swarm";

function toolSchemaForName(name: string): Record<string, unknown> {
  switch (name) {
    case "list_agents":
      return objectSchema({
        includeTerminated: { type: "boolean" },
        includeArchived: { type: "boolean" },
        includeManagers: { type: "boolean" },
      });
    case "send_message_to_agent":
      return objectSchema({
        targetAgentId: { type: "string" },
        message: { type: "string" },
        delivery: { enum: [...DELIVERY_MODE_VALUES] },
      }, ["targetAgentId", "message"]);
    case "spawn_agent":
      return objectSchema({
        agentId: { type: "string" },
        archetypeId: { type: "string" },
        systemPrompt: { type: "string" },
        model: { enum: [...SPAWN_MODEL_PRESET_VALUES] },
        cwd: { type: "string" },
        initialMessage: { type: "string" },
      }, ["agentId"]);
    case "kill_agent":
      return objectSchema({
        targetAgentId: { type: "string" },
      }, ["targetAgentId"]);
    case "speak_to_user":
      return objectSchema({
        text: { type: "string" },
        target: objectSchema({
          channel: { enum: [...MESSAGE_CHANNEL_VALUES] },
          channelId: { type: "string" },
          userId: { type: "string" },
          threadTs: { type: "string" },
          integrationProfileId: { type: "string" },
        }, ["channel"]),
      }, ["text"]);
    default:
      return objectSchema({});
  }
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function zodShapeForToolName(name: string): z.ZodRawShape {
  switch (name) {
    case "list_agents":
      return {
        includeTerminated: z.boolean().optional(),
        includeArchived: z.boolean().optional(),
        includeManagers: z.boolean().optional(),
      };
    case "send_message_to_agent":
      return {
        targetAgentId: z.string(),
        message: z.string(),
        delivery: z.enum(DELIVERY_MODE_VALUES).optional(),
      };
    case "spawn_agent":
      return {
        agentId: z.string(),
        archetypeId: z.string().optional(),
        systemPrompt: z.string().optional(),
        model: z.enum(SPAWN_MODEL_PRESET_VALUES).optional(),
        cwd: z.string().optional(),
        initialMessage: z.string().optional(),
      };
    case "kill_agent":
      return {
        targetAgentId: z.string(),
      };
    case "speak_to_user":
      return {
        text: z.string(),
        target: z
          .object({
            channel: z.enum(MESSAGE_CHANNEL_VALUES),
            channelId: z.string().optional(),
            userId: z.string().optional(),
            threadTs: z.string().optional(),
            integrationProfileId: z.string().optional(),
          })
          .optional(),
      };
    default:
      return {};
  }
}

function normalizeToolArguments(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function extractToolResultText(result: unknown, toolName: string): string {
  const fromContent = extractTextFromContentItems(result);
  if (fromContent) {
    return fromContent;
  }

  if (result !== undefined) {
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }

  return `Tool ${toolName} completed.`;
}

function extractTextFromContentItems(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }

  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return undefined;
  }

  const chunks: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const maybeText = item as { type?: unknown; text?: unknown };
    if (maybeText.type === "text" && typeof maybeText.text === "string") {
      chunks.push(maybeText.text);
    }
  }

  const text = chunks.join("\n").trim();
  return text.length > 0 ? text : undefined;
}

async function callHostTool(
  hostRpc: HostRpcClient,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
  isError?: boolean;
}> {
  const result = await hostRpc.callTool(toolName, args);

  if (result && typeof result === "object" && Array.isArray((result as { content?: unknown }).content)) {
    return result as {
      content: Array<{ type: "text"; text: string }>;
      details?: unknown;
      isError?: boolean;
    };
  }

  return {
    content: [
      {
        type: "text",
        text: extractToolResultText(result, toolName),
      },
    ],
    details: result,
  };
}

export function buildHostToolDefinitions(role: MiddlemanRole): HostToolDefinition[] {
  const shared: HostToolDefinition[] = [
    {
      name: "list_agents",
      label: "List Agents",
      description:
        "List the caller's current team with ids, roles, manager ids, status, and model. Excludes archived agents by default. Managers can optionally include other managers.",
      inputSchema: toolSchemaForName("list_agents"),
    },
    {
      name: "send_message_to_agent",
      label: "Send Message To Agent",
      description: "Send a message to another agent by id.",
      inputSchema: toolSchemaForName("send_message_to_agent"),
    },
  ];

  if (role !== "manager") {
    return shared;
  }

  return [
    ...shared,
    {
      name: "spawn_agent",
      label: "Spawn Agent",
      description: "Create and start a new worker agent.",
      inputSchema: toolSchemaForName("spawn_agent"),
    },
    {
      name: "kill_agent",
      label: "Kill Agent",
      description: "Terminate a running worker agent.",
      inputSchema: toolSchemaForName("kill_agent"),
    },
    {
      name: "speak_to_user",
      label: "Speak To User",
      description: "Publish a user-visible manager message.",
      inputSchema: toolSchemaForName("speak_to_user"),
    },
  ];
}

export function createCodexHostToolBridge(
  hostRpc: HostRpcClient,
  definitions: HostToolDefinition[],
): CodexHostToolBridge {
  return {
    dynamicTools: definitions.map((definition) => ({
      name: definition.name,
      description: definition.description ?? definition.label ?? `Run ${definition.name}`,
      inputSchema: JSON.parse(JSON.stringify(definition.inputSchema)),
    })),
    async handleToolCall(call) {
      try {
        const result = await callHostTool(hostRpc, call.tool, normalizeToolArguments(call.arguments));
        return {
          success: result.isError !== true,
          contentItems: [
            {
              type: "inputText",
              text: extractToolResultText(result, call.tool),
            },
          ],
          ...(result.details === undefined ? {} : { details: result.details }),
        };
      } catch (error) {
        return {
          success: false,
          contentItems: [
            {
              type: "inputText",
              text: `Tool ${call.tool} failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  };
}

export async function createClaudeHostToolServer(
  hostRpc: HostRpcClient,
  definitions: HostToolDefinition[],
): Promise<ClaudeHostToolServer> {
  const sdk = await loadClaudeSdkMcpHelpers();
  const serverName = CLAUDE_SERVER_NAME;

  const tools = definitions.map((definition) =>
    sdk.tool(
      definition.name,
      definition.description ?? definition.label ?? `Run ${definition.name}`,
      zodShapeForToolName(definition.name),
      async (args: unknown) => await callHostTool(hostRpc, definition.name, normalizeToolArguments(args)),
    ),
  );

  return {
    serverName,
    server: sdk.createSdkMcpServer({
      name: serverName,
      version: "1.0.0",
      tools,
    }),
    allowedTools: definitions.map((definition) => `mcp__${serverName}__${definition.name}`),
  };
}

export function createPiHostTools(
  hostRpc: HostRpcClient,
  definitions: HostToolDefinition[],
): PiHostToolDefinition[] {
  return definitions.map((definition) => ({
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.inputSchema,
    async execute(_toolCallId, params) {
      try {
        return await callHostTool(hostRpc, definition.name, normalizeToolArguments(params));
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Tool ${definition.name} failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  }));
}

async function loadClaudeSdkMcpHelpers(): Promise<{
  createSdkMcpServer: (config: { name: string; version: string; tools: unknown[] }) => unknown;
  tool: (
    name: string,
    description: string,
    shape: z.ZodRawShape,
    handler: (args: unknown) => Promise<unknown>,
  ) => unknown;
}> {
  try {
    const dynamicImport = new Function("specifier", "return import(specifier);") as (
      specifier: string,
    ) => Promise<unknown>;
    const imported = await dynamicImport("@anthropic-ai/claude-agent-sdk");
    const maybeModule =
      imported && typeof imported === "object" && !Array.isArray(imported)
        ? (imported as Record<string, unknown>)
        : null;

    if (
      !maybeModule ||
      typeof maybeModule.createSdkMcpServer !== "function" ||
      typeof maybeModule.tool !== "function"
    ) {
      throw new Error("Claude Agent SDK MCP helpers are unavailable.");
    }

    return {
      createSdkMcpServer: maybeModule.createSdkMcpServer as (
        config: { name: string; version: string; tools: unknown[] },
      ) => unknown,
      tool: maybeModule.tool as (
        name: string,
        description: string,
        shape: z.ZodRawShape,
        handler: (args: unknown) => Promise<unknown>,
      ) => unknown,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Claude host tools require @anthropic-ai/claude-agent-sdk. ${message}`);
  }
}
