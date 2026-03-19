// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationMessageAttachment } from "@middleman/protocol";
import { MessageAttachments } from "./MessageAttachments";

afterEach(() => {
  cleanup();
});

describe("MessageAttachments", () => {
  it("opens chat image attachments in a lightbox", async () => {
    const attachments: ConversationMessageAttachment[] = [
      {
        type: "image",
        mimeType: "image/png",
        fileName: "chat-image.png",
        data: "aGVsbG8=",
      },
    ];

    render(
      createElement(MessageAttachments, {
        attachments,
        isUser: false,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Expand image: chat-image.png" }));

    await waitFor(() => {
      expect(document.querySelector('[data-content-zoom-dialog="true"]')).not.toBeNull();
    });
  });
});
