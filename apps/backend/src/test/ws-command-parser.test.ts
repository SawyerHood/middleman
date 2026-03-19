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

  it.each(["codex-app", "claude-code"] as const)("rejects %s for manager creation", (model) => {
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
      error: "create_manager.model must be one of pi-codex|pi-opus",
    });
  });
});
