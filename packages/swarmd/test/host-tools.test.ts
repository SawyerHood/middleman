import { describe, expect, it, vi } from "vitest";

import type { HostRpcClient } from "../src/index.js";
import {
  buildHostToolDefinitions,
  createCodexHostToolBridge,
  createPiHostTools,
} from "../src/index.js";

describe("host tool bridge", () => {
  it("exposes manager-only tools only for managers", () => {
    expect(buildHostToolDefinitions("worker").map((tool) => tool.name)).toEqual([
      "list_agents",
      "send_message_to_agent",
    ]);
    expect(buildHostToolDefinitions("manager").map((tool) => tool.name)).toEqual([
      "list_agents",
      "send_message_to_agent",
      "spawn_agent",
      "kill_agent",
      "speak_to_user",
    ]);
  });

  it("includes thinkingLevel in the spawn_agent tool schema", () => {
    const spawnTool = buildHostToolDefinitions("manager").find(
      (tool) => tool.name === "spawn_agent",
    );

    expect(spawnTool?.inputSchema).toMatchObject({
      properties: {
        thinkingLevel: {
          enum: ["off", "low", "medium", "high", "xhigh"],
        },
      },
    });
  });

  it("includes all supported model presets in the spawn_agent tool schema", () => {
    const spawnTool = buildHostToolDefinitions("manager").find(
      (tool) => tool.name === "spawn_agent",
    );

    expect(spawnTool?.inputSchema).toMatchObject({
      properties: {
        model: {
          enum: [
            "pi-codex",
            "pi-codex-mini",
            "pi-opus",
            "pi-sonnet",
            "pi-haiku",
            "codex-app",
            "codex-app-mini",
            "claude-code",
            "claude-code-sonnet",
            "claude-code-haiku",
          ],
        },
      },
    });
  });

  it("formats codex host tool responses for replayable tool results", async () => {
    const hostRpc: HostRpcClient = {
      callTool: vi.fn(async () => ({
        content: [{ type: "text", text: "Published message to user (web)." }],
        details: {
          published: true,
          targetContext: {
            channel: "web",
          },
        },
      })),
    };
    const bridge = createCodexHostToolBridge(hostRpc, buildHostToolDefinitions("manager"));

    const result = await bridge.handleToolCall({
      tool: "speak_to_user",
      callId: "call-1",
      arguments: {
        text: "All clear.",
      },
    });

    expect(hostRpc.callTool).toHaveBeenCalledWith("speak_to_user", {
      text: "All clear.",
    });
    expect(result).toEqual({
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: "Published message to user (web).",
        },
      ],
      details: {
        published: true,
        targetContext: {
          channel: "web",
        },
      },
    });
  });

  it("surfaces host tool failures without throwing through the codex bridge", async () => {
    const hostRpc: HostRpcClient = {
      callTool: vi.fn(async () => {
        throw new Error("Unknown tool: does_not_exist");
      }),
    };
    const bridge = createCodexHostToolBridge(hostRpc, buildHostToolDefinitions("manager"));

    const result = await bridge.handleToolCall({
      tool: "does_not_exist",
      callId: "call-2",
      arguments: {},
    });

    expect(result).toEqual({
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: "Tool does_not_exist failed: Unknown tool: does_not_exist",
        },
      ],
    });
  });

  it("wraps pi host tool execution and preserves structured details", async () => {
    const hostRpc: HostRpcClient = {
      callTool: vi.fn(async () => ({
        content: [
          {
            type: "text",
            text: "Queued message for worker-1. deliveryId=delivery-1, mode=steer",
          },
        ],
        details: {
          targetAgentId: "worker-1",
          deliveryId: "delivery-1",
          acceptedMode: "steer",
        },
      })),
    };
    const piTools = createPiHostTools(hostRpc, buildHostToolDefinitions("worker"));
    const sendMessageTool = piTools.find((tool) => tool.name === "send_message_to_agent");

    expect(sendMessageTool).toBeDefined();

    const result = await sendMessageTool!.execute("call-3", {
      targetAgentId: "worker-1",
      message: "Run the test suite",
      delivery: "steer",
    });

    expect(hostRpc.callTool).toHaveBeenCalledWith("send_message_to_agent", {
      targetAgentId: "worker-1",
      message: "Run the test suite",
      delivery: "steer",
    });
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "Queued message for worker-1. deliveryId=delivery-1, mode=steer",
        },
      ],
      details: {
        targetAgentId: "worker-1",
        deliveryId: "delivery-1",
        acceptedMode: "steer",
      },
    });
  });
});
