// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PendingImageAttachment } from "@/lib/file-attachments";
import { AttachedFiles } from "./AttachedFiles";

afterEach(() => {
  cleanup();
});

describe("AttachedFiles", () => {
  it("opens attached image previews in a lightbox and closes on backdrop click", async () => {
    const attachment: PendingImageAttachment = {
      id: "attachment-1",
      mimeType: "image/png",
      data: "aGVsbG8=",
      dataUrl: "data:image/png;base64,aGVsbG8=",
      fileName: "preview.png",
      sizeBytes: 128,
    };

    render(
      createElement(AttachedFiles, {
        attachments: [attachment],
        onRemove: () => {},
      }),
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Open preview.png in full-screen preview",
      }),
    );

    await waitFor(() => {
      expect(document.querySelector('[data-content-zoom-dialog="true"]')).not.toBeNull();
    });

    fireEvent.click(document.querySelector('[data-content-zoom-dialog="true"]') as HTMLElement);

    await waitFor(() => {
      expect(document.querySelector('[data-content-zoom-dialog="true"]')).toBeNull();
    });
  });
});
