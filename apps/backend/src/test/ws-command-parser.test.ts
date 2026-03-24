import { CREATE_MANAGER_MODEL_PRESETS } from "@middleman/protocol";
import { describe, expect, it } from "vitest";

import { parseClientCommand } from "../ws/ws-command-parser.js";

describe("parseClientCommand create_manager", () => {
  it("defaults the manager model to pi-codex when omitted", () => {
    expect(
      parseClientCommand(
        Buffer.from(
          JSON.stringify({
            type: "create_manager",
            name: "Ops",
            cwd: "/tmp/project",
          }),
        ),
      ),
    ).toEqual({
      ok: true,
      command: {
        type: "create_manager",
        name: "Ops",
        cwd: "/tmp/project",
        model: "pi-codex",
        requestId: undefined,
      },
    });
  });

  it.each(["pi-codex-mini", "pi-sonnet", "pi-haiku"] as const)(
    "accepts %s for manager creation",
    (model) => {
      expect(
        parseClientCommand(
          Buffer.from(
            JSON.stringify({
              type: "create_manager",
              name: "Ops",
              cwd: "/tmp/project",
              model,
            }),
          ),
        ),
      ).toEqual({
        ok: true,
        command: {
          type: "create_manager",
          name: "Ops",
          cwd: "/tmp/project",
          model,
          requestId: undefined,
        },
      });
    },
  );

  it.each([
    "codex-app",
    "codex-app-mini",
    "claude-code",
    "claude-code-sonnet",
    "claude-code-haiku",
  ] as const)("rejects %s for manager creation", (model) => {
    expect(
      parseClientCommand(
        Buffer.from(
          JSON.stringify({
            type: "create_manager",
            name: "Ops",
            cwd: "/tmp/project",
            model,
          }),
        ),
      ),
    ).toEqual({
      ok: false,
      error: `create_manager.model must be one of ${CREATE_MANAGER_MODEL_PRESETS.join("|")}`,
    });
  });
});

describe("parseClientCommand interrupt_agent", () => {
  it("parses a valid interrupt_agent command", () => {
    expect(
      parseClientCommand(
        Buffer.from(
          JSON.stringify({
            type: "interrupt_agent",
            agentId: "worker-1",
            requestId: "req-1",
          }),
        ),
      ),
    ).toEqual({
      ok: true,
      command: {
        type: "interrupt_agent",
        agentId: "worker-1",
        requestId: "req-1",
      },
    });
  });

  it("rejects interrupt_agent without a non-empty agent id", () => {
    expect(
      parseClientCommand(
        Buffer.from(
          JSON.stringify({
            type: "interrupt_agent",
            agentId: "   ",
          }),
        ),
      ),
    ).toEqual({
      ok: false,
      error: "interrupt_agent.agentId must be a non-empty string",
    });
  });
});

describe("parseClientCommand compact_agent", () => {
  it("parses a valid compact_agent command", () => {
    expect(
      parseClientCommand(
        Buffer.from(
          JSON.stringify({
            type: "compact_agent",
            agentId: "worker-1",
            customInstructions: "Keep recent findings only",
            requestId: "req-compact-1",
          }),
        ),
      ),
    ).toEqual({
      ok: true,
      command: {
        type: "compact_agent",
        agentId: "worker-1",
        customInstructions: "Keep recent findings only",
        requestId: "req-compact-1",
      },
    });
  });

  it("rejects compact_agent without a non-empty agent id", () => {
    expect(
      parseClientCommand(
        Buffer.from(
          JSON.stringify({
            type: "compact_agent",
            agentId: "   ",
          }),
        ),
      ),
    ).toEqual({
      ok: false,
      error: "compact_agent.agentId must be a non-empty string",
    });
  });

  it("rejects compact_agent when customInstructions is not a string", () => {
    expect(
      parseClientCommand(
        Buffer.from(
          JSON.stringify({
            type: "compact_agent",
            agentId: "worker-1",
            customInstructions: 42,
          }),
        ),
      ),
    ).toEqual({
      ok: false,
      error: "compact_agent.customInstructions must be a string when provided",
    });
  });
});
