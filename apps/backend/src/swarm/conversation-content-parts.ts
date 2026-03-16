import type { ContentPart } from "swarmd";
import type { ConversationAttachment } from "./types.js";

export function toConversationContentParts(
  text: string,
  attachments: ConversationAttachment[],
): ContentPart[] {
  const parts: ContentPart[] = [{ type: "text", text }];

  for (const attachment of attachments) {
    if (attachment.type === "text") {
      parts.push(
        attachment.filePath
          ? {
              type: "file",
              mimeType: attachment.mimeType,
              fileName: attachment.fileName,
              path: attachment.filePath,
            }
          : {
              type: "file",
              mimeType: attachment.mimeType,
              fileName: attachment.fileName,
              data: Buffer.from(attachment.text, "utf8").toString("base64"),
            },
      );
      continue;
    }

    if (attachment.type === "binary") {
      parts.push(
        attachment.filePath
          ? {
              type: "file",
              mimeType: attachment.mimeType,
              fileName: attachment.fileName,
              path: attachment.filePath,
            }
          : {
              type: "file",
              mimeType: attachment.mimeType,
              fileName: attachment.fileName,
              data: attachment.data,
            },
      );
      continue;
    }

    if (attachment.data.length > 0) {
      parts.push({
        type: "image",
        mimeType: attachment.mimeType,
        data: attachment.data,
      });
      continue;
    }

    if (attachment.filePath) {
      parts.push({
        type: "file",
        mimeType: attachment.mimeType,
        fileName: attachment.fileName,
        path: attachment.filePath,
      });
    }
  }

  return parts;
}
