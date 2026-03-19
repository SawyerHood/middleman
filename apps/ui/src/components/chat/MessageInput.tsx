import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useAtom, useAtomValue } from "jotai";
import { ArrowUp, Paperclip } from "lucide-react";
import { AttachedFiles } from "@/components/chat/AttachedFiles";
import { Button } from "@/components/ui/button";
import { fileToPendingAttachment, type PendingAttachment } from "@/lib/file-attachments";
import { messageDraftsAtom } from "@/lib/message-drafts";
import {
  activeAgentIdAtom,
  activeAgentLabelAtom,
  connectedAtom,
  isLoadingAtom,
} from "@/lib/ws-state";
import { cn } from "@/lib/utils";
import type { ConversationAttachment } from "@middleman/protocol";

const TEXTAREA_MAX_HEIGHT = 186;
const COARSE_POINTER_MEDIA_QUERY = "(pointer: coarse)";
const MOBILE_VIEWPORT_RESET_DELAY_MS = 320;

interface MessageInputProps {
  agentId?: string | null;
  onSend: (message: string, attachments?: ConversationAttachment[]) => void;
  onSubmitted?: () => void;
  isLoading?: boolean;
  disabled?: boolean;
  agentLabel?: string;
  allowWhileLoading?: boolean;
}

export interface MessageInputHandle {
  setInput: (value: string) => void;
  focus: () => void;
  addFiles: (files: File[]) => Promise<void>;
}

function isCoarsePointerDevice(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(COARSE_POINTER_MEDIA_QUERY).matches
  );
}

function scrollLayoutViewportToTop(): void {
  if (typeof window === "undefined") {
    return;
  }

  window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
}

export const MessageInput = forwardRef<MessageInputHandle, MessageInputProps>(function MessageInput(
  { agentId, onSend, onSubmitted, isLoading, disabled, agentLabel, allowWhileLoading = false },
  ref,
) {
  const activeAgentId = useAtomValue(activeAgentIdAtom);
  const activeAgentLabel = useAtomValue(activeAgentLabelAtom);
  const connected = useAtomValue(connectedAtom);
  const isLoadingFromAtom = useAtomValue(isLoadingAtom);
  const [drafts, setDrafts] = useAtom(messageDraftsAtom);
  const [attachedFiles, setAttachedFiles] = useState<PendingAttachment[]>([]);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mobileViewportResetFrameRef = useRef<number | null>(null);
  const mobileViewportResetTimeoutRef = useRef<number | null>(null);
  const mobileViewportResetCleanupRef = useRef<(() => void) | null>(null);

  const resolvedAgentId = agentId ?? activeAgentId;
  const resolvedAgentLabel = agentLabel ?? activeAgentLabel ?? "agent";
  const resolvedIsLoading = isLoading ?? isLoadingFromAtom;
  const resolvedDisabled = disabled ?? (!connected || !resolvedAgentId);

  const input = resolvedAgentId ? (drafts[resolvedAgentId] ?? "") : "";

  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.overflowY = "hidden";
    textarea.style.height = "auto";
    const nextHeight = Math.min(textarea.scrollHeight, TEXTAREA_MAX_HEIGHT);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > TEXTAREA_MAX_HEIGHT ? "auto" : "hidden";
  }, []);

  const updateDraft = useCallback(
    (nextValue: string | ((previousValue: string) => string)) => {
      if (!resolvedAgentId) {
        return;
      }

      setDrafts((previousDrafts) => {
        const previousValue = previousDrafts[resolvedAgentId] ?? "";
        const resolvedValue =
          typeof nextValue === "function" ? nextValue(previousValue) : nextValue;

        if (resolvedValue.length === 0) {
          if (!(resolvedAgentId in previousDrafts)) {
            return previousDrafts;
          }

          const { [resolvedAgentId]: _removedDraft, ...remainingDrafts } = previousDrafts;
          return remainingDrafts;
        }

        if (resolvedValue === previousValue) {
          return previousDrafts;
        }

        return {
          ...previousDrafts,
          [resolvedAgentId]: resolvedValue,
        };
      });
    },
    [resolvedAgentId, setDrafts],
  );

  const blockedByLoading = resolvedIsLoading && !allowWhileLoading;

  const cancelMobileViewportReset = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (mobileViewportResetFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileViewportResetFrameRef.current);
      mobileViewportResetFrameRef.current = null;
    }

    if (mobileViewportResetTimeoutRef.current !== null) {
      window.clearTimeout(mobileViewportResetTimeoutRef.current);
      mobileViewportResetTimeoutRef.current = null;
    }

    mobileViewportResetCleanupRef.current?.();
    mobileViewportResetCleanupRef.current = null;
  }, []);

  useEffect(() => {
    resizeTextarea();
  }, [input, resizeTextarea]);

  useEffect(() => {
    if (resolvedDisabled || blockedByLoading) {
      return;
    }

    if (isCoarsePointerDevice()) {
      return;
    }

    textareaRef.current?.focus();
  }, [blockedByLoading, resolvedDisabled]);

  useEffect(() => cancelMobileViewportReset, [cancelMobileViewportReset]);

  const addFiles = useCallback(
    async (files: File[]) => {
      if (resolvedDisabled || files.length === 0) return;

      const uploaded = await Promise.all(files.map(fileToPendingAttachment));
      const nextAttachments = uploaded.filter(
        (attachment): attachment is PendingAttachment => attachment !== null,
      );

      if (nextAttachments.length === 0) {
        return;
      }

      setAttachedFiles((previous) => [...previous, ...nextAttachments]);
    },
    [resolvedDisabled],
  );

  useImperativeHandle(
    ref,
    () => ({
      setInput: (value: string) => {
        updateDraft(value);
        requestAnimationFrame(() => textareaRef.current?.focus());
      },
      focus: () => {
        textareaRef.current?.focus();
      },
      addFiles,
    }),
    [addFiles, updateDraft],
  );

  const handleFileSelect = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    await addFiles(files);
    event.target.value = "";
  };

  const handlePaste = async (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);

    if (files.length === 0) return;

    event.preventDefault();
    await addFiles(files);
  };

  const removeAttachment = (attachmentId: string) => {
    setAttachedFiles((previous) => previous.filter((attachment) => attachment.id !== attachmentId));
  };

  const restoreMobileViewportAfterSubmit = useCallback(() => {
    if (!isCoarsePointerDevice()) {
      return;
    }

    textareaRef.current?.blur();
    cancelMobileViewportReset();
    scrollLayoutViewportToTop();

    mobileViewportResetFrameRef.current = window.requestAnimationFrame(() => {
      mobileViewportResetFrameRef.current = null;
      scrollLayoutViewportToTop();
    });

    const visualViewport = window.visualViewport;
    if (
      visualViewport &&
      typeof visualViewport.addEventListener === "function" &&
      typeof visualViewport.removeEventListener === "function"
    ) {
      const handleViewportResize = () => {
        scrollLayoutViewportToTop();
        mobileViewportResetCleanupRef.current = null;
      };

      visualViewport.addEventListener("resize", handleViewportResize, { once: true });
      mobileViewportResetCleanupRef.current = () => {
        visualViewport.removeEventListener("resize", handleViewportResize);
      };
    }

    mobileViewportResetTimeoutRef.current = window.setTimeout(() => {
      mobileViewportResetTimeoutRef.current = null;
      scrollLayoutViewportToTop();
      mobileViewportResetCleanupRef.current?.();
      mobileViewportResetCleanupRef.current = null;
    }, MOBILE_VIEWPORT_RESET_DELAY_MS);
  }, [cancelMobileViewportReset]);

  const submitMessage = useCallback(() => {
    const trimmed = input.trim();
    const hasContent = trimmed.length > 0 || attachedFiles.length > 0;
    if (!hasContent || resolvedDisabled || blockedByLoading) {
      return;
    }

    onSend(
      trimmed,
      attachedFiles.length > 0
        ? attachedFiles.map((attachment) => {
            if (attachment.type === "text") {
              return {
                type: "text" as const,
                mimeType: attachment.mimeType,
                text: attachment.text,
                fileName: attachment.fileName,
              };
            }

            if (attachment.type === "binary") {
              return {
                type: "binary" as const,
                mimeType: attachment.mimeType,
                data: attachment.data,
                fileName: attachment.fileName,
              };
            }

            return {
              mimeType: attachment.mimeType,
              data: attachment.data,
              fileName: attachment.fileName,
            };
          })
        : undefined,
    );

    updateDraft("");
    setAttachedFiles([]);
    restoreMobileViewportAfterSubmit();
    requestAnimationFrame(() => {
      onSubmitted?.();
    });
  }, [
    attachedFiles,
    blockedByLoading,
    resolvedDisabled,
    input,
    onSend,
    onSubmitted,
    restoreMobileViewportAfterSubmit,
    updateDraft,
  ]);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      submitMessage();
    },
    [submitMessage],
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitMessage();
    }
  };

  const hasContent = input.trim().length > 0 || attachedFiles.length > 0;
  const canSubmit = hasContent && !resolvedDisabled && !blockedByLoading;
  const placeholder = resolvedDisabled
    ? "Waiting for connection..."
    : allowWhileLoading && resolvedIsLoading
      ? `Send another message to ${resolvedAgentLabel}...`
      : `Message ${resolvedAgentLabel}...`;

  return (
    <form
      data-react-grab-ignore
      onSubmit={handleSubmit}
      className="sticky bottom-0 z-10 shrink-0 bg-background px-2 pt-2 pb-[calc(0.5rem+var(--app-safe-bottom))] md:px-3 md:pt-3 md:pb-[calc(0.75rem+var(--app-safe-bottom))]"
    >
      <div className="overflow-hidden rounded-2xl border border-border">
        <AttachedFiles attachments={attachedFiles} onRemove={removeAttachment} />

        <div className="group flex flex-col">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(event) => updateDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={placeholder}
            disabled={resolvedDisabled}
            rows={1}
            className={cn(
              "w-full resize-none border-0 bg-transparent text-sm leading-normal text-foreground shadow-none focus:outline-none",
              "min-h-[44px]",
              "px-4 pt-3 pb-2",
              "[&::-webkit-scrollbar]:w-1.5",
              "[&::-webkit-scrollbar-track]:bg-transparent",
              "[&::-webkit-scrollbar-thumb]:bg-transparent",
              "[&::-webkit-scrollbar-thumb]:rounded-full",
              "group-hover:[&::-webkit-scrollbar-thumb]:bg-border",
            )}
          />

          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileSelect}
            aria-label="Attach files"
          />

          <div className="flex items-center justify-between px-1.5 pb-1.5 pt-1">
            <div className="flex items-center gap-0.5">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 rounded-full text-muted-foreground/60 hover:text-foreground"
                onClick={() => fileInputRef.current?.click()}
                disabled={resolvedDisabled}
                aria-label="Attach files"
              >
                <Paperclip className="size-3.5" />
              </Button>
            </div>

            <Button
              type="submit"
              disabled={!canSubmit}
              size="icon"
              className={cn(
                "size-7 rounded-full transition-all",
                canSubmit
                  ? "bg-primary text-primary-foreground hover:bg-primary/90 active:scale-95"
                  : "cursor-default bg-muted text-muted-foreground/40",
              )}
              aria-label="Send message"
            >
              <ArrowUp className="size-3.5" strokeWidth={2.5} />
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
});
