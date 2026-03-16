import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { buildAgentLookup } from "@/lib/agent-message-utils";
import type { ArtifactReference } from "@/lib/artifacts";
import { getConversationEntryStableId } from "@/lib/conversation-history";
import { cn } from "@/lib/utils";
import type { AgentDescriptor, ConversationEntry } from "@middleman/protocol";
import { AgentMessageRow } from "./message-list/AgentMessageRow";
import { ConversationMessageRow } from "./message-list/ConversationMessageRow";
import { EmptyState } from "./message-list/EmptyState";
import { ToolLogRow } from "./message-list/ToolLogRow";
import type {
  ConversationLogEntry,
  ToolExecutionDisplayEntry,
  ToolExecutionEvent,
  ToolExecutionLogEntry,
} from "./message-list/types";

interface MessageListProps {
  messages: ConversationEntry[];
  agents: AgentDescriptor[];
  isLoading: boolean;
  canLoadOlderHistory?: boolean;
  isLoadingOlderHistory?: boolean;
  activeAgentId?: string | null;
  isWorkerDetailView?: boolean;
  onLoadOlderHistory?: () => void;
  onSuggestionClick?: (suggestion: string) => void;
  onArtifactClick?: (artifact: ArtifactReference) => void;
  wsUrl?: string;
}

export interface MessageListHandle {
  scrollToBottom: (behavior?: ScrollBehavior) => void;
}

const AUTO_SCROLL_THRESHOLD_PX = 100;
const LOAD_OLDER_HISTORY_THRESHOLD_PX = 48;

type DisplayEntry =
  | {
      type: "conversation_message";
      id: string;
      message: Extract<ConversationEntry, { type: "conversation_message" }>;
    }
  | {
      type: "agent_message";
      id: string;
      message: Extract<ConversationEntry, { type: "agent_message" }>;
    }
  | {
      type: "tool_execution";
      id: string;
      entry: ToolExecutionDisplayEntry;
    }
  | {
      type: "runtime_error_log";
      id: string;
      entry: ConversationLogEntry;
    };

function isNearBottom(
  container: HTMLElement,
  threshold = AUTO_SCROLL_THRESHOLD_PX,
): boolean {
  const distanceFromBottom =
    container.scrollHeight - container.scrollTop - container.clientHeight;
  return distanceFromBottom <= threshold;
}

function isToolExecutionLog(
  entry: ConversationLogEntry,
): entry is ToolExecutionLogEntry {
  return (
    entry.kind === "tool_execution_start" ||
    entry.kind === "tool_execution_update" ||
    entry.kind === "tool_execution_end"
  );
}

function isToolExecutionEvent(
  entry: ConversationEntry,
): entry is ToolExecutionEvent {
  if (entry.type === "agent_tool_call") {
    return true;
  }

  return entry.type === "conversation_log" && isToolExecutionLog(entry);
}

function resolveToolExecutionEventActorAgentId(
  event: ToolExecutionEvent,
): string {
  return event.type === "agent_tool_call" ? event.actorAgentId : event.agentId;
}

function parseSerializedToolPayload(payload: string | undefined): unknown {
  if (!payload) {
    return undefined;
  }

  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function getDurationMs(
  startedAt?: string,
  endedAt?: string,
): number | undefined {
  if (!startedAt || !endedAt) {
    return undefined;
  }

  const startMs = Date.parse(startedAt);
  const endMs = Date.parse(endedAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return undefined;
  }

  return Math.max(0, endMs - startMs);
}

function hydrateToolDisplayEntry(
  displayEntry: ToolExecutionDisplayEntry,
  event: ToolExecutionEvent,
  seenEventKeys: Set<string>,
): void {
  const eventKey = `${event.kind}:${event.timestamp}:${event.text}`;
  const isDuplicateEvent = seenEventKeys.has(eventKey);

  if (!isDuplicateEvent) {
    seenEventKeys.add(eventKey);
    displayEntry.kindSequence.push(event.kind);
  }

  displayEntry.actorAgentId = resolveToolExecutionEventActorAgentId(event);
  displayEntry.toolName = event.toolName ?? displayEntry.toolName;
  displayEntry.toolCallId = event.toolCallId ?? displayEntry.toolCallId;
  displayEntry.timestamp = event.timestamp;
  displayEntry.latestAt = event.timestamp;
  displayEntry.latestKind = event.kind;
  displayEntry.isStreaming = event.kind !== "tool_execution_end";

  if (event.kind === "tool_execution_start") {
    const inputValue = parseSerializedToolPayload(event.text);

    displayEntry.inputPayload = event.text;
    displayEntry.latestPayload = event.text;
    displayEntry.outputPayload = undefined;
    displayEntry.isError = false;
    displayEntry.startedAt ??= event.timestamp;
    displayEntry.inputValue = inputValue;
    displayEntry.latestValue = inputValue;
    displayEntry.outputValue = undefined;
    displayEntry.inputRecord = asRecord(inputValue);
    displayEntry.latestUpdatePayload = undefined;
    displayEntry.latestUpdateValue = undefined;
    displayEntry.latestUpdateRecord = undefined;
    displayEntry.outputRecord = undefined;
    displayEntry.durationMs = getDurationMs(
      displayEntry.startedAt,
      displayEntry.endedAt ?? displayEntry.latestAt,
    );
    return;
  }

  if (event.kind === "tool_execution_update") {
    const latestUpdateValue = parseSerializedToolPayload(event.text);

    displayEntry.latestPayload = event.text;
    displayEntry.latestUpdatePayload = event.text;
    displayEntry.latestValue = latestUpdateValue;
    displayEntry.latestUpdateValue = latestUpdateValue;
    displayEntry.latestUpdateRecord = asRecord(latestUpdateValue);
    if (!isDuplicateEvent) {
      displayEntry.updates.push(event.text);
      displayEntry.updateValues.push(latestUpdateValue);
    }
    displayEntry.durationMs = getDurationMs(
      displayEntry.startedAt,
      displayEntry.endedAt ?? displayEntry.latestAt,
    );
    return;
  }

  const outputValue = parseSerializedToolPayload(event.text);

  displayEntry.outputPayload = event.text;
  displayEntry.latestPayload = event.text;
  displayEntry.latestValue = outputValue;
  displayEntry.outputValue = outputValue;
  displayEntry.outputRecord = asRecord(outputValue);
  displayEntry.endedAt = event.timestamp;
  displayEntry.isError = event.isError;
  displayEntry.durationMs = getDurationMs(
    displayEntry.startedAt,
    displayEntry.endedAt ?? displayEntry.latestAt,
  );
}

function buildDisplayEntries(messages: ConversationEntry[]): DisplayEntry[] {
  const displayEntries: DisplayEntry[] = [];
  const toolEntriesByCallId = new Map<string, ToolExecutionDisplayEntry>();
  const seenToolEventsByCallId = new Map<string, Set<string>>();

  for (const message of messages) {
    if (message.type === "conversation_message") {
      displayEntries.push({
        type: "conversation_message",
        id: getConversationEntryStableId(message),
        message,
      });
      continue;
    }

    if (message.type === "agent_message") {
      displayEntries.push({
        type: "agent_message",
        id: getConversationEntryStableId(message),
        message,
      });
      continue;
    }

    if (isToolExecutionEvent(message)) {
      const actorAgentId = resolveToolExecutionEventActorAgentId(message);
      const callId = message.toolCallId?.trim();

      if (callId) {
        const toolGroupKey = `${actorAgentId}:${callId}`;
        let displayEntry = toolEntriesByCallId.get(toolGroupKey);

        if (!displayEntry) {
          displayEntry = {
            id: `tool-${toolGroupKey}`,
            actorAgentId,
            toolName: message.toolName,
            toolCallId: callId,
            timestamp: message.timestamp,
            latestAt: message.timestamp,
            latestKind: message.kind,
            updates: [],
            kindSequence: [],
            isStreaming: true,
            updateValues: [],
          };

          displayEntries.push({
            type: "tool_execution",
            id: displayEntry.id,
            entry: displayEntry,
          });

          toolEntriesByCallId.set(toolGroupKey, displayEntry);
          seenToolEventsByCallId.set(toolGroupKey, new Set<string>());
        }

        hydrateToolDisplayEntry(
          displayEntry,
          message,
          seenToolEventsByCallId.get(toolGroupKey) ?? new Set<string>(),
        );
        continue;
      }

      const displayEntry: ToolExecutionDisplayEntry = {
        id: `tool-${getConversationEntryStableId(message)}`,
        actorAgentId,
        toolName: message.toolName,
        toolCallId: message.toolCallId,
        timestamp: message.timestamp,
        latestAt: message.timestamp,
        latestKind: message.kind,
        updates: [],
        kindSequence: [],
        isStreaming: true,
        updateValues: [],
      };

      hydrateToolDisplayEntry(displayEntry, message, new Set<string>());

      displayEntries.push({
        type: "tool_execution",
        id: displayEntry.id,
        entry: displayEntry,
      });
      continue;
    }

    if (message.type === "conversation_log" && message.isError) {
      displayEntries.push({
        type: "runtime_error_log",
        id: getConversationEntryStableId(message),
        entry: message,
      });
    }
  }

  return displayEntries;
}

function isExecutionScaffoldEntry(
  entry: DisplayEntry,
): entry is Extract<
  DisplayEntry,
  { type: "agent_message" | "tool_execution" | "runtime_error_log" }
> {
  return (
    entry.type === "agent_message" ||
    entry.type === "tool_execution" ||
    entry.type === "runtime_error_log"
  );
}

function getDisplayEntrySpacingClass(
  entry: DisplayEntry,
  previousEntry: DisplayEntry | undefined,
  isWorkerDetailView: boolean,
): string {
  if (!previousEntry) {
    return "";
  }

  if (!isWorkerDetailView) {
    return "pt-2";
  }

  const previousIsExecution = isExecutionScaffoldEntry(previousEntry);
  const currentIsExecution = isExecutionScaffoldEntry(entry);

  if (
    previousEntry.type === "tool_execution" &&
    entry.type === "tool_execution"
  ) {
    return "pt-1";
  }

  if (previousIsExecution && currentIsExecution) {
    return "pt-1.5";
  }

  if (previousIsExecution !== currentIsExecution) {
    return "pt-[var(--chat-tool-assistant-gap)]";
  }

  return "pt-[var(--chat-block-gap)]";
}

function LoadingIndicator() {
  return (
    <div
      className="mt-3 flex justify-start"
      role="status"
      aria-live="polite"
      aria-label="Assistant is working"
    >
      <div className="flex items-center gap-0.5">
        <div className="size-1.5 animate-bounce rounded-full bg-foreground/40 [animation-duration:900ms]" />
        <div className="size-1.5 animate-bounce rounded-full bg-foreground/40 [animation-delay:150ms] [animation-duration:900ms]" />
        <div className="size-1.5 animate-bounce rounded-full bg-foreground/40 [animation-delay:300ms] [animation-duration:900ms]" />
      </div>
    </div>
  );
}

function OlderHistoryLoadingIndicator() {
  return (
    <div
      className="flex justify-center pb-2 pt-1"
      role="status"
      aria-live="polite"
    >
      <div className="rounded-full border border-border/70 bg-background/90 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground shadow-sm backdrop-blur-sm">
        Loading earlier messages
      </div>
    </div>
  );
}

export const MessageList = forwardRef<MessageListHandle, MessageListProps>(
  function MessageList(
    {
      messages,
      agents,
      isLoading,
      canLoadOlderHistory = false,
      isLoadingOlderHistory = false,
      activeAgentId,
      isWorkerDetailView = false,
      onLoadOlderHistory,
      onSuggestionClick,
      onArtifactClick,
      wsUrl,
    },
    ref,
  ) {
    const scrollContainerRef = useRef<HTMLDivElement | null>(null);
    const bottomRef = useRef<HTMLDivElement | null>(null);
    const previousAgentIdRef = useRef<string | null>(null);
    const previousFirstEntryIdRef = useRef<string | null>(null);
    const previousEntryCountRef = useRef(0);
    const hasScrolledRef = useRef(false);
    const isAtBottomRef = useRef(true);
    const pendingOlderHistoryScrollRef = useRef<{
      previousFirstEntryId: string | null;
      previousEntryCount: number;
      previousScrollHeight: number;
      previousScrollTop: number;
    } | null>(null);
    const didPrependHistoryRef = useRef(false);
    const [showScrollButton, setShowScrollButton] = useState(false);

    const displayEntries = useMemo(
      () => buildDisplayEntries(messages),
      [messages],
    );
    const agentLookup = useMemo(() => buildAgentLookup(agents), [agents]);

    const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
      const container = scrollContainerRef.current;
      if (!container) {
        return;
      }

      if (behavior === "smooth") {
        container.scrollTo({ top: container.scrollHeight, behavior });
      } else {
        container.scrollTop = container.scrollHeight;
      }

      isAtBottomRef.current = true;
      setShowScrollButton(false);
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        scrollToBottom,
      }),
      [scrollToBottom],
    );

    const updateIsAtBottom = () => {
      const container = scrollContainerRef.current;
      if (!container) {
        isAtBottomRef.current = true;
        setShowScrollButton(false);
        return;
      }

      const isAtBottom = isNearBottom(container);
      isAtBottomRef.current = isAtBottom;
      setShowScrollButton(!isAtBottom);
    };

    const handleScroll = () => {
      updateIsAtBottom();

      const container = scrollContainerRef.current;
      if (!container || container.scrollTop > LOAD_OLDER_HISTORY_THRESHOLD_PX) {
        return;
      }

      requestOlderHistory();
    };

    const requestOlderHistory = useCallback(() => {
      if (
        !onLoadOlderHistory ||
        !canLoadOlderHistory ||
        isLoadingOlderHistory ||
        pendingOlderHistoryScrollRef.current
      ) {
        return;
      }

      const container = scrollContainerRef.current;
      if (!container) {
        return;
      }

      pendingOlderHistoryScrollRef.current = {
        previousFirstEntryId: displayEntries[0]?.id ?? null,
        previousEntryCount: displayEntries.length,
        previousScrollHeight: container.scrollHeight,
        previousScrollTop: container.scrollTop,
      };

      onLoadOlderHistory();
    }, [
      canLoadOlderHistory,
      displayEntries,
      isLoadingOlderHistory,
      onLoadOlderHistory,
    ]);

    useLayoutEffect(() => {
      didPrependHistoryRef.current = false;

      const pendingRestore = pendingOlderHistoryScrollRef.current;
      if (!pendingRestore) {
        return;
      }

      const container = scrollContainerRef.current;
      if (!container) {
        pendingOlderHistoryScrollRef.current = null;
        return;
      }

      const currentFirstEntryId = displayEntries[0]?.id ?? null;
      const didPrependHistory =
        currentFirstEntryId !== pendingRestore.previousFirstEntryId &&
        displayEntries.length >= pendingRestore.previousEntryCount;

      if (didPrependHistory) {
        container.scrollTop =
          pendingRestore.previousScrollTop +
          (container.scrollHeight - pendingRestore.previousScrollHeight);
        didPrependHistoryRef.current = true;
        updateIsAtBottom();
      }

      if (didPrependHistory || !isLoadingOlderHistory) {
        pendingOlderHistoryScrollRef.current = null;
      }
    }, [displayEntries, isLoadingOlderHistory]);

    useEffect(() => {
      const nextAgentId = activeAgentId ?? null;
      const nextFirstEntryId = displayEntries[0]?.id ?? null;
      const nextEntryCount = displayEntries.length;
      const didPrependHistory = didPrependHistoryRef.current;

      if (didPrependHistory) {
        didPrependHistoryRef.current = false;
        hasScrolledRef.current = true;
        previousAgentIdRef.current = nextAgentId;
        previousFirstEntryIdRef.current = nextFirstEntryId;
        previousEntryCountRef.current = nextEntryCount;
        return;
      }

      const isInitialScroll = !hasScrolledRef.current;
      const didAgentChange = previousAgentIdRef.current !== nextAgentId;
      if (didAgentChange) {
        pendingOlderHistoryScrollRef.current = null;
      }
      const didConversationReset =
        previousEntryCountRef.current > 0 &&
        (nextEntryCount === 0 ||
          previousFirstEntryIdRef.current !== nextFirstEntryId ||
          nextEntryCount < previousEntryCountRef.current);
      const didInitialConversationLoad =
        previousEntryCountRef.current === 0 && nextEntryCount > 0;

      const shouldForceScroll =
        isInitialScroll ||
        didAgentChange ||
        didConversationReset ||
        didInitialConversationLoad;
      const shouldAutoScroll = shouldForceScroll || isAtBottomRef.current;

      if (shouldAutoScroll) {
        scrollToBottom(shouldForceScroll ? "auto" : "smooth");
      }

      hasScrolledRef.current = true;
      previousAgentIdRef.current = nextAgentId;
      previousFirstEntryIdRef.current = nextFirstEntryId;
      previousEntryCountRef.current = nextEntryCount;
    }, [activeAgentId, displayEntries, isLoading, scrollToBottom]);

    useEffect(() => {
      const container = scrollContainerRef.current;
      if (
        !container ||
        !canLoadOlderHistory ||
        isLoadingOlderHistory ||
        displayEntries.length === 0
      ) {
        return;
      }

      if (container.scrollHeight > container.clientHeight) {
        return;
      }

      requestOlderHistory();
    }, [
      canLoadOlderHistory,
      displayEntries.length,
      isLoadingOlderHistory,
      requestOlderHistory,
    ]);

    const handleScrollToBottom = () => {
      scrollToBottom("smooth");
    };

    return (
      <div className="relative min-h-0 flex flex-1 flex-col overflow-hidden">
        {displayEntries.length === 0 && !isLoading ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <EmptyState
              activeAgentId={activeAgentId}
              onSuggestionClick={onSuggestionClick}
            />
          </div>
        ) : (
          <>
            <div
              ref={scrollContainerRef}
              onScroll={handleScroll}
              className={cn(
                "app-scroll-area min-h-0 flex-1 overflow-y-auto",
                "[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent",
                "[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-transparent",
                "[scrollbar-width:thin] [scrollbar-color:transparent_transparent]",
                "hover:[&::-webkit-scrollbar-thumb]:bg-border hover:[scrollbar-color:var(--color-border)_transparent]",
              )}
            >
              <div className="p-2 md:p-3">
                {isLoadingOlderHistory ? (
                  <OlderHistoryLoadingIndicator />
                ) : null}
                {displayEntries.map((entry, index) => {
                  const previousEntry =
                    index > 0 ? displayEntries[index - 1] : undefined;
                  const rowSpacingClass = getDisplayEntrySpacingClass(
                    entry,
                    previousEntry,
                    isWorkerDetailView,
                  );

                  if (entry.type === "conversation_message") {
                    return (
                      <div key={entry.id} className={rowSpacingClass}>
                        <ConversationMessageRow
                          message={entry.message}
                          onArtifactClick={onArtifactClick}
                          wsUrl={wsUrl}
                        />
                      </div>
                    );
                  }

                  if (entry.type === "agent_message") {
                    return (
                      <div key={entry.id} className={rowSpacingClass}>
                        <AgentMessageRow
                          message={entry.message}
                          agentLookup={agentLookup}
                        />
                      </div>
                    );
                  }

                  return (
                    <div key={entry.id} className={rowSpacingClass}>
                      <ToolLogRow type={entry.type} entry={entry.entry} />
                    </div>
                  );
                })}
                {isLoading ? <LoadingIndicator /> : null}
                <div ref={bottomRef} />
              </div>
            </div>

            <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center px-4">
              <Button
                type="button"
                size="icon"
                tabIndex={showScrollButton ? 0 : -1}
                aria-hidden={!showScrollButton}
                aria-label="Scroll to latest message"
                onClick={handleScrollToBottom}
                className={cn(
                  "size-9 rounded-full bg-background/80 text-foreground shadow-md ring-1 ring-border backdrop-blur-sm",
                  "transition-opacity transition-transform duration-200",
                  showScrollButton
                    ? "pointer-events-auto translate-y-0 opacity-100"
                    : "pointer-events-none translate-y-2 opacity-0",
                )}
              >
                <ChevronDown className="size-4" aria-hidden="true" />
              </Button>
            </div>
          </>
        )}
      </div>
    );
  },
);
