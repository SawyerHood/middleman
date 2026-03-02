import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { z } from "zod/v4";

export const CLAUDE_CODE_MCP_SERVER_NAME = "middleman-swarm";

const DELIVERY_MODE_SCHEMA = z.union([
  z.literal("auto"),
  z.literal("followUp"),
  z.literal("steer")
]);

const SPAWN_MODEL_PRESET_SCHEMA = z.union([
  z.literal("pi-codex"),
  z.literal("pi-opus"),
  z.literal("codex-app"),
  z.literal("claude-code")
]);

const MESSAGE_CHANNEL_SCHEMA = z.union([
  z.literal("web"),
  z.literal("slack"),
  z.literal("telegram")
]);

const SPEAK_TO_USER_TARGET_SCHEMA = z.object({
  channel: MESSAGE_CHANNEL_SCHEMA,
  channelId: z.string().optional(),
  userId: z.string().optional(),
  threadTs: z.string().optional(),
  integrationProfileId: z.string().optional()
});

export function buildClaudeCodeMcpServer(
  tools: ToolDefinition[],
  options?: {
    serverName?: string;
  }
): McpSdkServerConfigWithInstance {
  const serverName = options?.serverName?.trim() || CLAUDE_CODE_MCP_SERVER_NAME;

  const mcpTools = tools.map((definition) => {
    return tool(
      definition.name,
      definition.description ?? definition.label ?? `Run ${definition.name}`,
      schemaForToolName(definition.name),
      async (args) => {
        return executeSwarmTool(definition, args);
      }
    );
  });

  return createSdkMcpServer({
    name: serverName,
    version: "1.0.0",
    tools: mcpTools
  });
}

export function getClaudeCodeAllowedToolNames(
  tools: Pick<ToolDefinition, "name">[],
  options?: {
    serverName?: string;
  }
): string[] {
  const serverName = options?.serverName?.trim() || CLAUDE_CODE_MCP_SERVER_NAME;
  return tools.map((definition) => `mcp__${serverName}__${definition.name}`);
}

async function executeSwarmTool(
  definition: ToolDefinition,
  args: unknown
): Promise<{
  content: Array<{
    type: "text";
    text: string;
  }>;
  isError?: boolean;
}> {
  const normalizedArgs = normalizeToolArguments(args);

  try {
    const result = await definition.execute(
      "sdk-call",
      normalizedArgs,
      undefined,
      undefined,
      undefined as never
    );

    return {
      content: [
        {
          type: "text",
          text: extractToolResultText(result, definition.name)
        }
      ]
    };
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Tool ${definition.name} failed: ${error instanceof Error ? error.message : String(error)}`
        }
      ]
    };
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

function schemaForToolName(name: string): z.ZodRawShape {
  switch (name) {
    case "list_agents":
      return {};

    case "send_message_to_agent":
      return {
        targetAgentId: z.string(),
        message: z.string(),
        delivery: DELIVERY_MODE_SCHEMA.optional()
      };

    case "spawn_agent":
      return {
        agentId: z.string(),
        archetypeId: z.string().optional(),
        systemPrompt: z.string().optional(),
        model: SPAWN_MODEL_PRESET_SCHEMA.optional(),
        cwd: z.string().optional(),
        initialMessage: z.string().optional()
      };

    case "kill_agent":
      return {
        targetAgentId: z.string()
      };

    case "speak_to_user":
      return {
        text: z.string(),
        target: SPEAK_TO_USER_TARGET_SCHEMA.optional()
      };

    default:
      return {};
  }
}
