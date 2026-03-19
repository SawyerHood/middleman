import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConversationMessageEvent } from "@middleman/protocol";
import { ConversationMessageRow } from "./ConversationMessageRow";

describe("ConversationMessageRow", () => {
  it("renders user text alongside metadata-only image attachments", () => {
    const message: ConversationMessageEvent = {
      type: "conversation_message",
      agentId: "manager",
      role: "user",
      text: "Please inspect this image.",
      timestamp: "2026-03-04T16:00:00.000Z",
      source: "user_input",
      attachments: [
        {
          type: "image",
          mimeType: "image/png",
          fileName: "image.png",
          filePath: "/tmp/image.png",
        },
      ],
    };

    const html = renderToStaticMarkup(
      createElement(ConversationMessageRow, {
        message,
        wsUrl: "ws://127.0.0.1:47187",
      }),
    );

    expect(html).toContain("Please inspect this image.");
    expect(html).toContain("<img");
    expect(html).toContain('src="http://127.0.0.1:47187/api/read-file?path=%2Ftmp%2Fimage.png"');
  });
});
