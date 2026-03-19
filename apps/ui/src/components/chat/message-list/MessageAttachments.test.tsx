import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConversationMessageAttachment } from "@middleman/protocol";
import { MessageAttachments } from "./MessageAttachments";

describe("MessageAttachments", () => {
  it("renders metadata-only image attachments via the read-file endpoint", () => {
    const attachments: ConversationMessageAttachment[] = [
      {
        type: "image",
        mimeType: "image/png",
        fileName: "image.png",
        filePath: "/tmp/image.png",
      },
    ];

    const html = renderToStaticMarkup(
      createElement(MessageAttachments, {
        attachments,
        isUser: true,
        wsUrl: "ws://127.0.0.1:47187",
      }),
    );

    expect(html).toContain("<img");
    expect(html).toContain('src="http://127.0.0.1:47187/api/read-file?path=%2Ftmp%2Fimage.png"');
    expect(html).not.toContain("Image file");
  });

  it("falls back to a file card when an image attachment has no source payload", () => {
    const attachments: ConversationMessageAttachment[] = [
      {
        type: "image",
        mimeType: "image/png",
        fileName: "image.png",
      },
    ];

    const html = renderToStaticMarkup(
      createElement(MessageAttachments, {
        attachments,
        isUser: false,
      }),
    );

    expect(html).not.toContain("<img");
    expect(html).toContain("Image file");
    expect(html).toContain("image/png");
  });
});
