import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { toConversationContentParts } from "../swarm/conversation-content-parts.js";
import {
  parseConversationAttachments,
  persistConversationAttachments,
} from "../ws/attachment-parser.js";

describe("toConversationContentParts", () => {
  it("keeps persisted image uploads as image parts", async () => {
    const parsed = parseConversationAttachments(
      [
        {
          mimeType: "image/png",
          data: Buffer.from("fake-image-data").toString("base64"),
          fileName: "source.png",
        },
      ],
      "attachments",
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    const uploadsDir = await mkdtemp(join(tmpdir(), "middleman-upload-image-"));

    try {
      const persisted = await persistConversationAttachments(parsed.attachments, uploadsDir);

      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toMatchObject({
        type: "image",
        mimeType: "image/png",
        fileName: "source.png",
        filePath: expect.any(String),
      });

      expect(toConversationContentParts("edit this", persisted)).toEqual([
        { type: "text", text: "edit this" },
        {
          type: "image",
          mimeType: "image/png",
          data: Buffer.from("fake-image-data").toString("base64"),
        },
      ]);
    } finally {
      await rm(uploadsDir, { recursive: true, force: true });
    }
  });

  it("preserves persisted text uploads as file parts", async () => {
    const parsed = parseConversationAttachments(
      [
        {
          type: "text",
          mimeType: "text/plain",
          text: "hello from upload",
          fileName: "note.txt",
        },
      ],
      "attachments",
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    const uploadsDir = await mkdtemp(join(tmpdir(), "middleman-upload-text-"));

    try {
      const persisted = await persistConversationAttachments(parsed.attachments, uploadsDir);

      expect(toConversationContentParts("review this", persisted)).toEqual([
        { type: "text", text: "review this" },
        {
          type: "file",
          mimeType: "text/plain",
          fileName: "note.txt",
          path: expect.any(String),
        },
      ]);
    } finally {
      await rm(uploadsDir, { recursive: true, force: true });
    }
  });
});
