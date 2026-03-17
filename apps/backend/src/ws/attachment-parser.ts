import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { ConversationAttachment } from "../swarm/types.js";

export async function parseMultipartFormData(rawBody: Buffer, contentType: string): Promise<FormData> {
  const request = new Request("http://127.0.0.1/api/uploads", {
    method: "POST",
    headers: {
      "content-type": contentType
    },
    body: new Uint8Array(rawBody)
  });

  try {
    return await request.formData();
  } catch {
    throw new Error("Request body must be valid multipart form data");
  }
}

export function resolveUploadFileName(file: File): string {
  const trimmed = file.name.trim();
  return trimmed.length > 0 ? trimmed : "upload.bin";
}

export function normalizeMimeType(value: string): string {
  return value.split(";")[0]?.trim().toLowerCase() ?? "";
}

export function parseConversationAttachments(
  value: unknown,
  fieldName: string
):
  | {
      ok: true;
      attachments: ConversationAttachment[];
    }
  | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true, attachments: [] };
  }

  if (!Array.isArray(value)) {
    return { ok: false, error: `${fieldName} must be an array when provided` };
  }

  const attachments: ConversationAttachment[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!item || typeof item !== "object") {
      return { ok: false, error: `${fieldName}[${index}] must be an object` };
    }

    const maybe = item as {
      type?: unknown;
      mimeType?: unknown;
      data?: unknown;
      text?: unknown;
      fileName?: unknown;
    };

    if (maybe.type !== undefined && typeof maybe.type !== "string") {
      return { ok: false, error: `${fieldName}[${index}].type must be a string when provided` };
    }

    if (typeof maybe.mimeType !== "string" || maybe.mimeType.trim().length === 0) {
      return { ok: false, error: `${fieldName}[${index}].mimeType must be a non-empty string` };
    }

    if (maybe.fileName !== undefined && typeof maybe.fileName !== "string") {
      return { ok: false, error: `${fieldName}[${index}].fileName must be a string when provided` };
    }

    const attachmentType = typeof maybe.type === "string" ? maybe.type.trim() : "";
    const mimeType = maybe.mimeType.trim();
    const fileName = typeof maybe.fileName === "string" ? maybe.fileName.trim() : "";

    if (attachmentType === "text") {
      if (typeof maybe.text !== "string" || maybe.text.trim().length === 0) {
        return { ok: false, error: `${fieldName}[${index}].text must be a non-empty string` };
      }

      attachments.push({
        type: "text",
        mimeType,
        text: maybe.text,
        fileName: fileName || undefined
      });
      continue;
    }

    if (attachmentType === "binary") {
      if (typeof maybe.data !== "string" || maybe.data.trim().length === 0) {
        return { ok: false, error: `${fieldName}[${index}].data must be a non-empty base64 string` };
      }

      attachments.push({
        type: "binary",
        mimeType,
        data: maybe.data.trim(),
        fileName: fileName || undefined
      });
      continue;
    }

    if (attachmentType !== "" && attachmentType !== "image") {
      return {
        ok: false,
        error: `${fieldName}[${index}].type must be image|text|binary when provided`
      };
    }

    if (!mimeType.startsWith("image/")) {
      return { ok: false, error: `${fieldName}[${index}].mimeType must start with image/` };
    }

    if (typeof maybe.data !== "string" || maybe.data.trim().length === 0) {
      return { ok: false, error: `${fieldName}[${index}].data must be a non-empty base64 string` };
    }

    attachments.push({
      mimeType,
      data: maybe.data.trim(),
      fileName: fileName || undefined
    });
  }

  return { ok: true, attachments };
}

export async function persistConversationAttachments(
  attachments: ConversationAttachment[],
  uploadsDir: string
): Promise<ConversationAttachment[]> {
  if (attachments.length === 0) {
    return [];
  }

  await mkdir(uploadsDir, { recursive: true });

  const persisted: ConversationAttachment[] = [];
  for (const attachment of attachments) {
    if (attachment.type === "text") {
      const extension = resolveAttachmentExtension({
        mimeType: attachment.mimeType,
        fileName: attachment.fileName,
        fallbackExtension: "txt"
      });
      const filePath = buildUploadFilePath(uploadsDir, extension);
      await writeFile(filePath, attachment.text, "utf8");
      persisted.push({
        ...attachment,
        filePath
      });
      continue;
    }

    const extension = resolveAttachmentExtension({
      mimeType: attachment.mimeType,
      fileName: attachment.fileName,
      fallbackExtension: attachment.type === "binary" ? "bin" : "png"
    });
    const filePath = buildUploadFilePath(uploadsDir, extension);
    await writeFile(filePath, Buffer.from(attachment.data, "base64"));
    persisted.push({
      ...attachment,
      filePath
    });
  }

  return persisted;
}

function buildUploadFilePath(uploadsDir: string, extension: string): string {
  const safeExtension = extension.trim().toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
  return join(uploadsDir, `${Date.now()}-${randomUUID()}.${safeExtension}`);
}

function resolveAttachmentExtension(options: {
  mimeType: string;
  fileName?: string;
  fallbackExtension: string;
}): string {
  const fromMimeType = extensionFromMimeType(options.mimeType);
  if (fromMimeType) {
    return fromMimeType;
  }

  const fromFileName = extensionFromFileName(options.fileName);
  if (fromFileName) {
    return fromFileName;
  }

  return options.fallbackExtension;
}

function extensionFromMimeType(mimeType: string): string | undefined {
  const normalized = mimeType.trim().toLowerCase().split(";", 1)[0]?.trim() ?? "";
  if (!normalized) {
    return undefined;
  }

  const mapped = MIME_TYPE_EXTENSIONS[normalized];
  if (mapped) {
    return mapped;
  }

  const slashIndex = normalized.indexOf("/");
  if (slashIndex < 0 || slashIndex === normalized.length - 1) {
    return undefined;
  }

  const subtype = normalized.slice(slashIndex + 1);
  const plusIndex = subtype.indexOf("+");
  const candidate = (plusIndex >= 0 ? subtype.slice(0, plusIndex) : subtype).replace(/[^a-z0-9]/g, "");
  return candidate.length > 0 ? candidate : undefined;
}

function extensionFromFileName(fileName: string | undefined): string | undefined {
  if (typeof fileName !== "string" || fileName.trim().length === 0) {
    return undefined;
  }

  const extension = extname(fileName).trim().toLowerCase().replace(/^\./, "").replace(/[^a-z0-9]/g, "");
  return extension.length > 0 ? extension : undefined;
}

const MIME_TYPE_EXTENSIONS: Record<string, string> = {
  "image/apng": "apng",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/tiff": "tiff",
  "image/webp": "webp",
  "application/gzip": "gz",
  "application/json": "json",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "text/csv": "csv",
  "text/html": "html",
  "text/markdown": "md",
  "text/plain": "txt",
  "text/xml": "xml"
};
