import { describe, expect, it } from "vitest";
import { collectArtifactsFromMessages } from "./collect-artifacts";
import type { ConversationEntry } from "@middleman/protocol";

function assistantMessage(text: string): ConversationEntry {
  return {
    type: "conversation_message",
    agentId: "manager",
    role: "assistant",
    text,
    timestamp: "2026-02-25T00:00:00.000Z",
    source: "speak_to_user",
  };
}

describe("collectArtifactsFromMessages", () => {
  it("collects local markdown links as artifacts and keeps link text as title", () => {
    const artifacts = collectArtifactsFromMessages([
      assistantMessage("[Terminal Support Plan](docs/plans/terminal-support.md)"),
    ]);

    expect(artifacts).toEqual([
      {
        path: "docs/plans/terminal-support.md",
        fileName: "terminal-support.md",
        href: "docs/plans/terminal-support.md",
        title: "Terminal Support Plan",
      },
    ]);
  });

  it("ignores markdown image links when collecting artifacts", () => {
    const artifacts = collectArtifactsFromMessages([
      assistantMessage("![Diagram](docs/images/diagram.png)\n[Build Plan](docs/plans/build.md)"),
    ]);

    expect(artifacts).toEqual([
      {
        path: "docs/plans/build.md",
        fileName: "build.md",
        href: "docs/plans/build.md",
        title: "Build Plan",
      },
    ]);
  });
});
