import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Code2,
  ExternalLink,
  FileCode2,
  FileImage,
  FileText,
  FlaskConical,
  Gem,
  Loader2,
  MousePointer2,
  NotebookPen,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogOverlay,
  DialogPopup,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  toCursorHref,
  type ArtifactEditorTargets,
  type ArtifactReference,
  toObsidianHref,
  toVscodeHref,
  toVscodeInsidersHref,
} from "@/lib/artifacts";
import { resolveReadFileEndpoint, resolveReadFileUrl } from "@/lib/read-file-url";
import { cn } from "@/lib/utils";
import { MarkdownMessage } from "./MarkdownMessage";

export type ArtifactPanelSelection = {
  type: "artifact";
  artifact: ArtifactReference;
};

interface ArtifactPanelProps {
  selection: ArtifactPanelSelection | null;
  wsUrl: string;
  onClose: () => void;
  onArtifactClick?: (artifact: ArtifactReference) => void;
  onOpenInNotes?: (notePath: string) => void;
}

interface ReadFileResult {
  path: string;
  content: string;
  editorTargets: ArtifactEditorTargets | null;
}

const MARKDOWN_FILE_PATTERN = /\.(md|markdown|mdx)$/i;
const IMAGE_FILE_PATTERN = /\.(png|jpg|jpeg|gif|webp|svg)$/i;
const ARTIFACT_OPEN_EDITOR_STORAGE_KEY = "middleman:artifact-panel:open-editor";
const ARTIFACT_OPEN_EDITOR_IDS = [
  "vscode",
  "vscode-insiders",
  "cursor",
  "obsidian",
  "notes",
] as const;

type ArtifactOpenEditorId = (typeof ARTIFACT_OPEN_EDITOR_IDS)[number];

type ArtifactOpenAction =
  | {
      kind: "href";
      href: string;
    }
  | {
      kind: "notes";
      notePath: string;
    };

interface ArtifactOpenOption {
  id: ArtifactOpenEditorId;
  label: string;
  shortLabel: string;
  icon: typeof Check;
  action: ArtifactOpenAction | null;
}

export function ArtifactPanel({
  selection,
  wsUrl,
  onClose,
  onArtifactClick,
  onOpenInNotes,
}: ArtifactPanelProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [resolvedPath, setResolvedPath] = useState<string | null>(null);
  const [editorTargets, setEditorTargets] = useState<ArtifactEditorTargets | null>(null);
  const [preferredEditorId, setPreferredEditorId] = useState<ArtifactOpenEditorId>(
    readStoredArtifactOpenEditor,
  );
  const closingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedArtifact = selection?.type === "artifact" ? selection.artifact : null;
  const artifactPath = selectedArtifact?.path ?? null;
  const selectionKey = selection?.artifact.path ?? null;

  useEffect(() => {
    if (!selectionKey) {
      setIsVisible(false);
      setIsClosing(false);
      return;
    }

    setIsClosing(false);
    setIsVisible(false);
    const frame = window.requestAnimationFrame(() => {
      setIsVisible(true);
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [selectionKey]);

  useEffect(() => {
    if (!artifactPath) {
      setContent("");
      setResolvedPath(null);
      setEditorTargets(null);
      setError(null);
      setIsLoading(false);
      return;
    }

    const isImageArtifact =
      IMAGE_FILE_PATTERN.test(selectedArtifact?.fileName ?? "") ||
      IMAGE_FILE_PATTERN.test(artifactPath);
    if (isImageArtifact) {
      setContent("");
      setResolvedPath(artifactPath);
      setEditorTargets(null);
      setError(null);
      setIsLoading(false);
      return;
    }

    const abortController = new AbortController();

    setIsLoading(true);
    setError(null);
    setContent("");
    setResolvedPath(null);
    setEditorTargets(null);

    void (async () => {
      try {
        const file = await readArtifactFile({
          wsUrl,
          path: artifactPath,
          signal: abortController.signal,
        });

        if (abortController.signal.aborted) {
          return;
        }

        setContent(file.content);
        setResolvedPath(file.path);
        setEditorTargets(file.editorTargets);
        setError(null);
      } catch (readError) {
        if (abortController.signal.aborted) {
          return;
        }

        setEditorTargets(null);
        setError(readError instanceof Error ? readError.message : "Failed to read file.");
      } finally {
        if (!abortController.signal.aborted) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      abortController.abort();
    };
  }, [artifactPath, selectedArtifact?.fileName, wsUrl]);

  useEffect(() => {
    return () => {
      if (closingTimerRef.current) {
        clearTimeout(closingTimerRef.current);
      }
    };
  }, []);

  const handleAnimatedClose = () => {
    setIsClosing(true);
    setIsVisible(false);
    if (closingTimerRef.current) {
      clearTimeout(closingTimerRef.current);
    }
    closingTimerRef.current = setTimeout(() => {
      setIsClosing(false);
      onClose();
    }, 260);
  };

  const displayPath = resolvedPath ?? artifactPath ?? "";
  const isImage = useMemo(
    () =>
      IMAGE_FILE_PATTERN.test(selectedArtifact?.fileName ?? "") ||
      IMAGE_FILE_PATTERN.test(displayPath),
    [displayPath, selectedArtifact?.fileName],
  );
  const isMarkdown = useMemo(() => MARKDOWN_FILE_PATTERN.test(displayPath), [displayPath]);
  const imageFileUrl = useMemo(() => {
    if (!isImage || !displayPath) {
      return null;
    }

    return resolveReadFileUrl(wsUrl, displayPath);
  }, [displayPath, isImage, wsUrl]);
  const openOptions = useMemo(() => {
    const baseOptions = buildArtifactOpenOptions(
      displayPath || selectedArtifact?.path || "",
      editorTargets,
    );
    if (onOpenInNotes) {
      return baseOptions;
    }

    return baseOptions.map((option) =>
      option.id === "notes" ? { ...option, action: null } : option,
    );
  }, [displayPath, editorTargets, onOpenInNotes, selectedArtifact?.path]);
  const activeOpenOption = useMemo(
    () =>
      openOptions.find((option) => option.id === preferredEditorId && option.action !== null) ??
      openOptions.find((option) => option.action !== null) ??
      null,
    [openOptions, preferredEditorId],
  );

  const handleOpenWithEditor = useCallback(
    (editorId: ArtifactOpenEditorId) => {
      const option = openOptions.find((entry) => entry.id === editorId);
      if (!option?.action) {
        return;
      }

      setPreferredEditorId(editorId);
      writeStoredArtifactOpenEditor(editorId);

      if (option.action.kind === "href") {
        window.open(option.action.href, "_blank", "noopener,noreferrer");
        return;
      }

      onOpenInNotes?.(option.action.notePath);
    },
    [onOpenInNotes, openOptions],
  );

  if (!selection && !isClosing) {
    return null;
  }

  const panelTitle = selectedArtifact ? selectedArtifact.fileName : "Details";
  const panelSubtitle = selectedArtifact ? displayPath : "Selection unavailable";
  const PanelIcon = selectedArtifact
    ? isImage
      ? FileImage
      : isMarkdown
        ? FileText
        : FileCode2
    : FileText;
  const isOpen = Boolean(selectionKey) || isClosing;

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          handleAnimatedClose();
        }
      }}
    >
      <DialogPortal>
        <DialogOverlay
          className={cn(
            "fixed inset-0 z-50",
            "transition-[backdrop-filter,background-color] duration-300 ease-out",
            isVisible
              ? "bg-background/72 backdrop-blur-[2px] md:bg-background/60"
              : "pointer-events-none bg-transparent backdrop-blur-0",
            isClosing && !isVisible && "pointer-events-none",
          )}
        />
        <DialogPopup
          className={cn(
            "app-shell-height fixed inset-y-0 right-0 z-50 flex w-full flex-col",
            "max-md:inset-x-0 max-md:w-dvw max-md:max-w-none md:max-w-[min(880px,90vw)]",
            "border-l border-border/80 bg-background text-foreground",
            "max-md:border-l-0 max-md:shadow-none",
            "shadow-[-8px_0_32px_-4px_rgba(0,0,0,0.12)] outline-none",
            "transition-all duration-[260ms] ease-[cubic-bezier(0.32,0.72,0,1)]",
            isVisible ? "translate-x-0 opacity-100" : "translate-x-[40%] opacity-0",
          )}
        >
          <DialogTitle className="sr-only">{panelTitle}</DialogTitle>
          <header className="app-top-bar flex shrink-0 items-center justify-between gap-3 border-b border-border/80 bg-card px-4 md:px-5">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <PanelIcon className="size-3.5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h2 className="truncate text-sm font-bold text-foreground">{panelTitle}</h2>
                <p
                  className={cn(
                    "truncate text-[11px] text-muted-foreground",
                    selectedArtifact ? "font-mono" : "",
                  )}
                >
                  {panelSubtitle}
                </p>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1.5">
              {selectedArtifact ? (
                <>
                  <div className="inline-flex items-center overflow-hidden rounded-lg border border-border/70 bg-background/80 shadow-xs">
                    <Button
                      type="button"
                      variant="ghost"
                      size="default"
                      className={cn(
                        "rounded-none border-0 px-2.5 text-xs font-medium",
                        "text-muted-foreground transition-colors",
                        "hover:bg-muted hover:text-foreground",
                      )}
                      onClick={() => activeOpenOption && handleOpenWithEditor(activeOpenOption.id)}
                      disabled={activeOpenOption === null}
                      aria-label={
                        activeOpenOption ? `Open in ${activeOpenOption.label}` : "Open with editor"
                      }
                    >
                      <ExternalLink className="size-3.5" aria-hidden="true" />
                      <span className="hidden sm:inline">
                        {activeOpenOption ? activeOpenOption.label : "Open"}
                      </span>
                      <span className="sm:hidden">{activeOpenOption?.shortLabel ?? "Open"}</span>
                    </Button>

                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className={cn(
                              "rounded-none border-0 border-l border-border/50",
                              "text-muted-foreground transition-colors",
                              "hover:bg-muted hover:text-foreground",
                            )}
                            aria-label="Choose editor"
                          />
                        }
                      >
                        <ChevronDown className="size-3.5" aria-hidden="true" />
                      </DropdownMenuTrigger>

                      <DropdownMenuContent align="end" sideOffset={6} className="min-w-[200px]">
                        <DropdownMenuGroup>
                          <DropdownMenuLabel>Open with</DropdownMenuLabel>
                        </DropdownMenuGroup>
                        <DropdownMenuSeparator />
                        {openOptions.map((option) => {
                          const EditorIcon = option.icon;
                          return (
                            <DropdownMenuItem
                              key={option.id}
                              onClick={() => handleOpenWithEditor(option.id)}
                              disabled={option.action === null}
                            >
                              <EditorIcon
                                className="size-4 text-muted-foreground"
                                aria-hidden="true"
                              />
                              <span className="flex-1">{option.label}</span>
                              {preferredEditorId === option.id && option.action !== null ? (
                                <Check className="size-3.5 text-primary" aria-hidden="true" />
                              ) : null}
                              {option.action === null ? (
                                <DropdownMenuShortcut className="text-[10px] opacity-60">
                                  N/A
                                </DropdownMenuShortcut>
                              ) : null}
                            </DropdownMenuItem>
                          );
                        })}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>

                  <div className="mx-0.5 h-4 w-px bg-border/50" aria-hidden="true" />
                </>
              ) : null}

              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(
                  "size-8 rounded-md",
                  "text-muted-foreground transition-colors",
                  "hover:bg-muted hover:text-foreground",
                )}
                onClick={handleAnimatedClose}
                aria-label="Close artifact panel"
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </div>
          </header>

          <ScrollArea
            className={cn(
              "app-scroll-area min-h-0 flex-1",
              "[&>[data-slot=scroll-area-scrollbar]]:w-2",
              "[&>[data-slot=scroll-area-scrollbar]>[data-slot=scroll-area-thumb]]:bg-transparent",
              "hover:[&>[data-slot=scroll-area-scrollbar]>[data-slot=scroll-area-thumb]]:bg-border",
            )}
          >
            <div className="px-4 py-4 pb-[calc(1rem+var(--app-safe-bottom))] md:px-6 md:py-6">
              {isLoading ? (
                <div className="flex items-center gap-2.5 py-12 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  <span>Loading file...</span>
                </div>
              ) : error ? (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                  {error}
                </div>
              ) : selectedArtifact && isImage ? (
                imageFileUrl ? (
                  <div className="mx-auto flex max-w-[820px] justify-center">
                    <img
                      src={imageFileUrl}
                      alt={selectedArtifact.fileName || "Artifact image"}
                      className="max-h-[calc(var(--app-viewport-height)-11rem)] max-w-full rounded-lg border border-border/60 bg-muted/20 object-contain"
                    />
                  </div>
                ) : (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                    Unable to load image preview.
                  </div>
                )
              ) : selectedArtifact && isMarkdown ? (
                <article className="mx-auto max-w-[680px]">
                  <MarkdownMessage
                    content={content}
                    variant="document"
                    enableMermaid
                    onArtifactClick={onArtifactClick}
                    wsUrl={wsUrl}
                  />
                </article>
              ) : selectedArtifact ? (
                <ScrollArea className="w-full rounded-lg border border-border/60 bg-muted/25">
                  <pre className="p-4">
                    <code className="whitespace-pre font-mono text-[13px] leading-relaxed text-foreground/90">
                      {content}
                    </code>
                  </pre>
                </ScrollArea>
              ) : (
                <div className="rounded-lg border border-border/60 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
                  This selection is no longer available.
                </div>
              )}
            </div>
          </ScrollArea>
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}

async function readArtifactFile({
  wsUrl,
  path,
  signal,
}: {
  wsUrl: string;
  path: string;
  signal: AbortSignal;
}): Promise<ReadFileResult> {
  const endpoint = resolveReadFileEndpoint(wsUrl);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ path }),
    signal,
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && typeof payload.error === "string"
        ? payload.error
        : `File read failed (${response.status})`;

    throw new Error(message);
  }

  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid file read response.");
  }

  const resolvedPath = typeof payload.path === "string" ? payload.path : path;
  const content = typeof payload.content === "string" ? payload.content : "";

  return {
    path: resolvedPath,
    content,
    editorTargets: parseArtifactEditorTargets(
      (payload as { editorTargets?: unknown }).editorTargets,
    ),
  };
}

function buildArtifactOpenOptions(
  path: string,
  editorTargets: ArtifactEditorTargets | null,
): ArtifactOpenOption[] {
  return [
    {
      id: "vscode",
      label: "VS Code",
      shortLabel: "VS Code",
      icon: Code2,
      action: path ? { kind: "href", href: toVscodeHref(path) } : null,
    },
    {
      id: "vscode-insiders",
      label: "VS Code Insiders",
      shortLabel: "Insiders",
      icon: FlaskConical,
      action: path ? { kind: "href", href: toVscodeInsidersHref(path) } : null,
    },
    {
      id: "cursor",
      label: "Cursor",
      shortLabel: "Cursor",
      icon: MousePointer2,
      action: path ? { kind: "href", href: toCursorHref(path) } : null,
    },
    {
      id: "obsidian",
      label: "Obsidian",
      shortLabel: "Obsidian",
      icon: Gem,
      action: editorTargets?.obsidian
        ? { kind: "href", href: toObsidianHref(editorTargets.obsidian) }
        : null,
    },
    {
      id: "notes",
      label: "Built-in Notes",
      shortLabel: "Notes",
      icon: NotebookPen,
      action: editorTargets?.notesPath
        ? { kind: "notes", notePath: editorTargets.notesPath }
        : null,
    },
  ];
}

function parseArtifactEditorTargets(value: unknown): ArtifactEditorTargets | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const rawTargets = value as {
    notesPath?: unknown;
    obsidian?: {
      vault?: unknown;
      file?: unknown;
    } | null;
  };

  const notesPath =
    typeof rawTargets.notesPath === "string" && rawTargets.notesPath.trim().length > 0
      ? rawTargets.notesPath.trim()
      : undefined;
  const obsidian =
    rawTargets.obsidian &&
    typeof rawTargets.obsidian === "object" &&
    typeof rawTargets.obsidian.vault === "string" &&
    rawTargets.obsidian.vault.trim().length > 0 &&
    typeof rawTargets.obsidian.file === "string" &&
    rawTargets.obsidian.file.trim().length > 0
      ? {
          vault: rawTargets.obsidian.vault.trim(),
          file: rawTargets.obsidian.file.trim(),
        }
      : undefined;

  if (!notesPath && !obsidian) {
    return null;
  }

  return {
    ...(notesPath ? { notesPath } : {}),
    ...(obsidian ? { obsidian } : {}),
  };
}

function readStoredArtifactOpenEditor(): ArtifactOpenEditorId {
  if (typeof window === "undefined") {
    return "vscode";
  }

  try {
    const storedEditor = window.localStorage.getItem(ARTIFACT_OPEN_EDITOR_STORAGE_KEY);
    return isArtifactOpenEditorId(storedEditor) ? storedEditor : "vscode";
  } catch {
    return "vscode";
  }
}

function writeStoredArtifactOpenEditor(editorId: ArtifactOpenEditorId): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(ARTIFACT_OPEN_EDITOR_STORAGE_KEY, editorId);
  } catch {
    // Ignore localStorage write failures in restricted environments.
  }
}

function isArtifactOpenEditorId(value: string | null): value is ArtifactOpenEditorId {
  return value !== null && (ARTIFACT_OPEN_EDITOR_IDS as readonly string[]).includes(value);
}
