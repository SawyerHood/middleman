import { useState } from "react";
import { File, FileText, ZoomIn } from "lucide-react";
import { ContentZoomDialog } from "@/components/chat/ContentZoomDialog";
import { Button } from "@/components/ui/button";
import { resolveReadFileUrl } from "@/lib/read-file-url";
import { cn } from "@/lib/utils";
import type { ConversationMessageAttachment } from "@middleman/protocol";

interface ImageAttachmentPreview {
  attachment: ConversationMessageAttachment;
  src: string;
}

function isMessageImageAttachment(attachment: ConversationMessageAttachment): boolean {
  const maybeType = attachment.type;
  if (maybeType === "text" || maybeType === "binary") {
    return false;
  }

  return attachment.mimeType.trim().toLowerCase().startsWith("image/");
}

function resolveImageAttachmentSrc(
  attachment: ConversationMessageAttachment,
  wsUrl?: string,
): string | null {
  if ("data" in attachment && typeof attachment.data === "string" && attachment.data.length > 0) {
    return `data:${attachment.mimeType};base64,${attachment.data}`;
  }

  const filePath = typeof attachment.filePath === "string" ? attachment.filePath.trim() : "";
  if (!filePath) {
    return null;
  }

  return resolveReadFileUrl(wsUrl, filePath);
}

function attachmentKey(attachment: ConversationMessageAttachment, index: number): string {
  const fileName = attachment.fileName?.trim() ?? "";
  const filePath = attachment.filePath?.trim() ?? "";
  const dataPrefix =
    "data" in attachment && typeof attachment.data === "string" ? attachment.data.slice(0, 32) : "";

  return `${attachment.type ?? "image"}-${attachment.mimeType}-${fileName}-${filePath}-${dataPrefix}-${index}`;
}

function fileAttachmentSubtitle(attachment: ConversationMessageAttachment): string {
  if (attachment.type === "text") {
    return "Text file";
  }

  if (attachment.type === "binary") {
    return "Binary file";
  }

  return "Image file";
}

function MessageImageAttachments({
  attachments,
  isUser,
}: {
  attachments: ImageAttachmentPreview[];
  isUser: boolean;
}) {
  const [zoomTarget, setZoomTarget] = useState<ImageAttachmentPreview | null>(null);

  if (attachments.length === 0) {
    return null;
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {attachments.map(({ attachment, src }, index) => {
          const imageAlt = attachment.fileName || `Attached image ${index + 1}`;

          return (
            <Button
              key={attachmentKey(attachment, index)}
              type="button"
              variant="ghost"
              onClick={() => setZoomTarget({ attachment, src })}
              className={cn(
                "group/image relative h-auto overflow-hidden rounded-lg p-0",
                isUser ? "user-message-bubble-border border" : "border border-border",
              )}
              aria-label={`Expand image: ${imageAlt}`}
            >
              <img
                src={src}
                alt={imageAlt}
                className="max-h-56 w-full object-cover"
                loading="lazy"
              />
              <span
                className={cn(
                  "pointer-events-none absolute right-2 top-2 inline-flex size-7 items-center justify-center rounded-md",
                  "bg-black/55 text-white/85 shadow-sm backdrop-blur-sm",
                  "opacity-0 transition-opacity duration-150",
                  "group-hover/image:opacity-100 group-focus-visible/image:opacity-100",
                )}
                aria-hidden="true"
              >
                <ZoomIn className="size-3.5" />
              </span>
            </Button>
          );
        })}
      </div>

      {zoomTarget ? (
        <ContentZoomDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setZoomTarget(null);
            }
          }}
          title={`Expanded preview for ${zoomTarget.attachment.fileName || "attached image"}`}
        >
          <img
            src={zoomTarget.src}
            alt={zoomTarget.attachment.fileName || "Attached image"}
            className="h-auto max-h-full w-auto max-w-full rounded-lg shadow-2xl"
          />
        </ContentZoomDialog>
      ) : null}
    </>
  );
}

function MessageFileAttachments({
  attachments,
  isUser,
}: {
  attachments: ConversationMessageAttachment[];
  isUser: boolean;
}) {
  if (attachments.length === 0) {
    return null;
  }

  return (
    <div className="space-y-1.5">
      {attachments.map((attachment, index) => {
        const isTextFile = attachment.type === "text";
        const fileName = attachment.fileName || `Attachment ${index + 1}`;
        const subtitle = fileAttachmentSubtitle(attachment);

        return (
          <div
            key={`${attachment.mimeType}-${fileName}-${index}`}
            className={cn(
              "flex items-center gap-2 rounded-md border px-2 py-1.5",
              isUser ? "user-message-bubble-surface" : "border-border bg-muted/35 text-foreground",
            )}
          >
            <span
              className={cn(
                "inline-flex size-6 items-center justify-center rounded",
                isUser ? "user-message-bubble-icon" : "bg-muted text-muted-foreground",
              )}
            >
              {isTextFile ? <FileText className="size-3.5" /> : <File className="size-3.5" />}
            </span>
            <span className="min-w-0">
              <p className="truncate text-xs font-medium">{fileName}</p>
              <p
                className={cn(
                  "truncate text-[11px]",
                  isUser ? "user-message-bubble-meta" : "text-muted-foreground",
                )}
              >
                {subtitle} • {attachment.mimeType}
              </p>
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function MessageAttachments({
  attachments,
  isUser,
  wsUrl,
}: {
  attachments: ConversationMessageAttachment[];
  isUser: boolean;
  wsUrl?: string;
}) {
  const imageAttachments: ImageAttachmentPreview[] = [];
  const fileAttachments: ConversationMessageAttachment[] = [];

  for (const attachment of attachments) {
    if (!isMessageImageAttachment(attachment)) {
      fileAttachments.push(attachment);
      continue;
    }

    const src = resolveImageAttachmentSrc(attachment, wsUrl);
    if (!src) {
      fileAttachments.push(attachment);
      continue;
    }

    imageAttachments.push({ attachment, src });
  }

  if (imageAttachments.length === 0 && fileAttachments.length === 0) {
    return null;
  }

  return (
    <>
      <MessageImageAttachments attachments={imageAttachments} isUser={isUser} />
      <MessageFileAttachments attachments={fileAttachments} isUser={isUser} />
    </>
  );
}
