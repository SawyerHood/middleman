import { describe, expect, it, vi } from "vitest";

import type { EventEnvelope, SessionRuntimeConfig, UserInput } from "../src/core/types/index.js";
import {
  ScriptedBackendAdapter,
  type ScriptedRuntimeFixture,
} from "../src/runtime/common/scripted-backend-adapter.js";

function createRuntimeConfig(
  sessionId: string,
  fixture: ScriptedRuntimeFixture,
): SessionRuntimeConfig {
  return {
    backend: "codex",
    cwd: process.cwd(),
    model: "gpt-5",
    backendConfig: {
      swarmdSessionId: sessionId,
      mockRuntime: {
        fixture,
      },
    },
  };
}

function createInput(text: string, role: UserInput["role"] = "user"): UserInput {
  return {
    id: `${role}-input`,
    role,
    parts: [{ type: "text", text }],
  };
}

function waitForEvent(
  events: EventEnvelope[],
  predicate: (event: EventEnvelope) => boolean,
  timeoutMs = 3_000,
): Promise<EventEnvelope> {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const poll = () => {
      const event = events.find(predicate);
      if (event) {
        resolve(event);
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for scripted adapter event.`));
        return;
      }

      setTimeout(poll, 10);
    };

    poll();
  });
}

describe("ScriptedBackendAdapter", () => {
  it("streams scripted assistant messages and status changes", async () => {
    const events: EventEnvelope[] = [];
    const statuses: string[] = [];

    const adapter = new ScriptedBackendAdapter("codex", {
      emitEvent: (event) => {
        events.push(event as EventEnvelope);
      },
      emitStatusChange: (status) => {
        statuses.push(status);
      },
      emitCheckpoint: () => undefined,
      log: () => undefined,
    });

    await adapter.bootstrap(
      createRuntimeConfig("manager-1", {
        sessions: {
          "manager-1": {
            turns: [
              {
                match: {
                  index: 1,
                  textIncludes: "hello",
                },
                steps: [
                  { type: "status", status: "busy" },
                  {
                    type: "message_stream",
                    role: "assistant",
                    chunks: ["hello ", "from mock runtime"],
                    chunkDelayMs: 1,
                  },
                  { type: "status", status: "idle" },
                ],
              },
            ],
          },
        },
      }),
    );

    await expect(adapter.sendInput(createInput("hello there"), "auto")).resolves.toEqual({
      acceptedDelivery: "auto",
      queued: false,
    });

    await expect(
      waitForEvent(events, (event) => event.type === "message.completed"),
    ).resolves.toMatchObject({
      type: "message.completed",
      payload: {
        role: "assistant",
        text: "hello from mock runtime",
      },
    });

    expect(statuses).toEqual(["busy", "idle"]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "message.delta",
        payload: expect.objectContaining({
          delta: "hello ",
        }),
      }),
    );
  });

  it("executes real host tool calls and emits tool events", async () => {
    const events: EventEnvelope[] = [];
    const hostRpc = {
      callTool: vi.fn(async () => ({
        details: {
          targetAgentId: "reviewer",
          deliveryId: "delivery-1",
          acceptedMode: "steer",
        },
      })),
    };

    const adapter = new ScriptedBackendAdapter(
      "pi",
      {
        emitEvent: (event) => {
          events.push(event as EventEnvelope);
        },
        emitStatusChange: () => undefined,
        emitCheckpoint: () => undefined,
        log: () => undefined,
      },
      { hostRpc },
    );

    await adapter.bootstrap({
      backend: "pi",
      cwd: process.cwd(),
      model: "openai/gpt-5",
      backendConfig: {
        swarmdSessionId: "worker-1",
        mockRuntime: {
          fixture: {
            sessions: {
              "worker-1": {
                turns: [
                  {
                    match: { index: 1 },
                    steps: [
                      {
                        type: "host_call",
                        tool: "send_message_to_agent",
                        args: {
                          targetAgentId: "reviewer",
                          message: "Please review the crash log.",
                          delivery: "steer",
                        },
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    });

    await adapter.sendInput(createInput("delegate this", "system"), "auto");

    await expect(
      waitForEvent(events, (event) => event.type === "tool.completed"),
    ).resolves.toMatchObject({
      type: "tool.completed",
      payload: {
        toolName: "send_message_to_agent",
        ok: true,
        result: {
          details: {
            targetAgentId: "reviewer",
          },
        },
      },
    });

    expect(hostRpc.callTool).toHaveBeenCalledWith("send_message_to_agent", {
      targetAgentId: "reviewer",
      message: "Please review the crash log.",
      delivery: "steer",
    });
  });

  it("emits runtime error events for scripted failures", async () => {
    const events: EventEnvelope[] = [];
    const statuses: string[] = [];

    const adapter = new ScriptedBackendAdapter("claude", {
      emitEvent: (event) => {
        events.push(event as EventEnvelope);
      },
      emitStatusChange: (status) => {
        statuses.push(status);
      },
      emitCheckpoint: () => undefined,
      log: () => undefined,
    });

    await adapter.bootstrap({
      backend: "claude",
      cwd: process.cwd(),
      model: "claude-sonnet",
      backendConfig: {
        swarmdSessionId: "manager-2",
        mockRuntime: {
          fixture: {
            sessions: {
              "manager-2": {
                turns: [
                  {
                    match: { index: 1 },
                    steps: [
                      { type: "status", status: "busy" },
                      {
                        type: "error",
                        message: "Mock runtime exploded.",
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    });

    await adapter.sendInput(createInput("trigger failure"), "auto");

    await expect(
      waitForEvent(events, (event) => event.type === "session.errored"),
    ).resolves.toMatchObject({
      type: "session.errored",
      payload: {
        error: {
          message: "Mock runtime exploded.",
        },
      },
    });

    expect(statuses).toContain("errored");
  });
});
