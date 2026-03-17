import {
  type ComponentPropsWithoutRef,
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { Button } from "@/components/ui/button";
import {
  buildAgentLookup,
  type AgentLookup,
} from "@/lib/agent-message-utils";
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
  isLoadingHistory?: boolean;
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
const MESSAGE_LIST_FIRST_ITEM_INDEX = 1_000_000;
const MESSAGE_LIST_INITIAL_ITEM_RENDER_LIMIT = 12;
const MESSAGE_LIST_OVERSCAN_PX = 240;
const MESSAGE_LIST_VIEWPORT_BUFFER_PX = {
  top: 240,
  bottom: 360,
};

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
      className="mt-3 flex min-h-5 items-center justify-start"
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

function LoadingIndicatorFooter() {
  return (
    <div className="px-2 pb-2 md:px-3 md:pb-3">
      <LoadingIndicator />
    </div>
  );
}

function HistoryLoadingState() {
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"
      role="status"
      aria-live="polite"
    >
      <Loader2
        className="size-5 animate-spin text-muted-foreground"
        aria-hidden="true"
      />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">
          Loading conversation
        </p>
        <p className="text-xs text-muted-foreground">
          Fetching message history...
        </p>
      </div>
    </div>
  );
}

const VirtualizedMessageScroller = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<"div">
>(function VirtualizedMessageScroller({ className, ...props }, ref) {
  return (
    <div
      {...props}
      ref={ref}
      className={cn(
        "app-scroll-area h-full min-h-0 flex-1 overflow-y-auto",
        "[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent",
        "[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-transparent",
        "[scrollbar-width:thin] [scrollbar-color:transparent_transparent]",
        "hover:[&::-webkit-scrollbar-thumb]:bg-border hover:[scrollbar-color:var(--color-border)_transparent]",
        className,
      )}
    />
  );
});

VirtualizedMessageScroller.displayName = "VirtualizedMessageScroller";

const VirtualizedMessageListBody = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<"div">
>(function VirtualizedMessageListBody({ className, ...props }, ref) {
  return <div {...props} ref={ref} className={cn("p-2 md:p-3", className)} />;
});

VirtualizedMessageListBody.displayName = "VirtualizedMessageListBody";

function areToolExecutionDisplayEntriesEqual(
  previousEntry: ToolExecutionDisplayEntry,
  nextEntry: ToolExecutionDisplayEntry,
): boolean {
  return (
    previousEntry.id === nextEntry.id &&
    previousEntry.actorAgentId === nextEntry.actorAgentId &&
    previousEntry.toolName === nextEntry.toolName &&
    previousEntry.toolCallId === nextEntry.toolCallId &&
    previousEntry.inputPayload === nextEntry.inputPayload &&
    previousEntry.latestPayload === nextEntry.latestPayload &&
    previousEntry.latestUpdatePayload === nextEntry.latestUpdatePayload &&
    previousEntry.outputPayload === nextEntry.outputPayload &&
    previousEntry.timestamp === nextEntry.timestamp &&
    previousEntry.startedAt === nextEntry.startedAt &&
    previousEntry.latestAt === nextEntry.latestAt &&
    previousEntry.endedAt === nextEntry.endedAt &&
    previousEntry.durationMs === nextEntry.durationMs &&
    previousEntry.latestKind === nextEntry.latestKind &&
    previousEntry.isStreaming === nextEntry.isStreaming &&
    previousEntry.isError === nextEntry.isError &&
    previousEntry.updates.length === nextEntry.updates.length &&
    previousEntry.kindSequence.length === nextEntry.kindSequence.length
  );
}

interface MessageListRowProps {
  entry: DisplayEntry;
  rowSpacingClass: string;
  agentLookup: AgentLookup;
  onArtifactClick?: (artifact: ArtifactReference) => void;
  wsUrl?: string;
}

const MessageListRow = memo(function MessageListRow({
  entry,
  rowSpacingClass,
  agentLookup,
  onArtifactClick,
  wsUrl,
}: MessageListRowProps) {
  if (entry.type === "conversation_message") {
    return (
      <div className={rowSpacingClass}>
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
      <div className={rowSpacingClass}>
        <AgentMessageRow message={entry.message} agentLookup={agentLookup} />
      </div>
    );
  }

  return (
    <div className={rowSpacingClass}>
      <ToolLogRow type={entry.type} entry={entry.entry} />
    </div>
  );
}, areMessageListRowPropsEqual);

function areMessageListRowPropsEqual(
  previousProps: MessageListRowProps,
  nextProps: MessageListRowProps,
): boolean {
  if (
    previousProps.rowSpacingClass !== nextProps.rowSpacingClass ||
    previousProps.agentLookup !== nextProps.agentLookup ||
    previousProps.onArtifactClick !== nextProps.onArtifactClick ||
    previousProps.wsUrl !== nextProps.wsUrl
  ) {
    return false;
  }

  const previousEntry = previousProps.entry;
  const nextEntry = nextProps.entry;

  if (
    previousEntry === nextEntry ||
    (previousEntry.type === nextEntry.type && previousEntry.id === nextEntry.id)
  ) {
    if (
      previousEntry.type === "conversation_message" &&
      nextEntry.type === "conversation_message"
    ) {
      return previousEntry.message === nextEntry.message;
    }

    if (
      previousEntry.type === "agent_message" &&
      nextEntry.type === "agent_message"
    ) {
      return previousEntry.message === nextEntry.message;
    }

    if (
      previousEntry.type === "tool_execution" &&
      nextEntry.type === "tool_execution"
    ) {
      return areToolExecutionDisplayEntriesEqual(
        previousEntry.entry,
        nextEntry.entry,
      );
    }

    if (
      previousEntry.type === "runtime_error_log" &&
      nextEntry.type === "runtime_error_log"
    ) {
      return previousEntry.entry === nextEntry.entry;
    }
  }

  return false;
}

export const MessageList = forwardRef<MessageListHandle, MessageListProps>(
  function MessageList(
    {
      messages,
      agents,
      isLoading,
      isLoadingHistory = false,
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
    const virtuosoRef = useRef<VirtuosoHandle | null>(null);
    const scrollContainerRef = useRef<HTMLElement | null>(null);
    const previousAgentIdRef = useRef<string | null>(null);
    const previousFirstEntryIdRef = useRef<string | null>(null);
    const previousEntryCountRef = useRef(0);
    const hasScrolledRef = useRef(false);
    const isAtBottomRef = useRef(true);
    const pendingOlderHistoryScrollRef = useRef<{
      previousFirstEntryId: string | null;
      previousEntryCount: number;
    } | null>(null);
    const didPrependHistoryRef = useRef(false);
    const [showScrollButton, setShowScrollButton] = useState(false);
    const [firstItemIndex, setFirstItemIndex] = useState(
      MESSAGE_LIST_FIRST_ITEM_INDEX,
    );

    const displayEntries = useMemo(
      () => buildDisplayEntries(messages),
      [messages],
    );
    const agentLookup = useMemo(() => buildAgentLookup(agents), [agents]);

    const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
      const scrollBehavior = behavior === "smooth" ? "smooth" : "auto";
      const scrollTargetTop =
        scrollContainerRef.current?.scrollHeight ?? Number.MAX_SAFE_INTEGER;

      virtuosoRef.current?.scrollTo({
        top: scrollTargetTop,
        behavior: scrollBehavior,
      });

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

      const currentFirstEntryId = displayEntries[0]?.id ?? null;
      const didPrependHistory =
        currentFirstEntryId !== pendingRestore.previousFirstEntryId &&
        displayEntries.length > pendingRestore.previousEntryCount;

      if (didPrependHistory) {
        const prependedEntryCount =
          displayEntries.length - pendingRestore.previousEntryCount;
        setFirstItemIndex((currentValue) =>
          Math.max(1, currentValue - prependedEntryCount),
        );
        didPrependHistoryRef.current = true;
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

      if (didAgentChange || didConversationReset) {
        setFirstItemIndex(MESSAGE_LIST_FIRST_ITEM_INDEX);
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

    const handleScrollerRef = useCallback(
      (node: HTMLElement | Window | null) => {
        scrollContainerRef.current =
          node instanceof HTMLElement ? node : null;
      },
      [],
    );

    const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
      isAtBottomRef.current = atBottom;
      setShowScrollButton(!atBottom);
    }, []);

    const handleAtTopStateChange = useCallback(
      (atTop: boolean) => {
        if (!atTop) {
          return;
        }

        requestOlderHistory();
      },
      [requestOlderHistory],
    );

    const handleStartReached = useCallback(() => {
      requestOlderHistory();
    }, [requestOlderHistory]);

    const virtuosoComponents = useMemo(
      () => ({
        Footer: isLoading
          ? function VirtuosoFooter() {
              return <LoadingIndicatorFooter />;
            }
          : undefined,
        Header: isLoadingOlderHistory
          ? function VirtuosoHeader() {
              return <OlderHistoryLoadingIndicator />;
            }
          : undefined,
        List: VirtualizedMessageListBody,
        Scroller: VirtualizedMessageScroller,
      }),
      [isLoading, isLoadingOlderHistory],
    );

    const renderMessageRow = useCallback(
      (index: number, entry: DisplayEntry) => {
        const dataIndex = index - firstItemIndex;
        const previousEntry =
          dataIndex > 0 ? displayEntries[dataIndex - 1] : undefined;
        const rowSpacingClass = getDisplayEntrySpacingClass(
          entry,
          previousEntry,
          isWorkerDetailView,
        );

        return (
          <MessageListRow
            entry={entry}
            rowSpacingClass={rowSpacingClass}
            agentLookup={agentLookup}
            onArtifactClick={onArtifactClick}
            wsUrl={wsUrl}
          />
        );
      },
      [
        agentLookup,
        displayEntries,
        firstItemIndex,
        isWorkerDetailView,
        onArtifactClick,
        wsUrl,
      ],
    );

    return (
      <div className="relative min-h-0 flex flex-1 flex-col overflow-hidden">
        {displayEntries.length === 0 && isLoadingHistory ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <HistoryLoadingState />
          </div>
        ) : displayEntries.length === 0 && !isLoading ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <EmptyState
              activeAgentId={activeAgentId}
              onSuggestionClick={onSuggestionClick}
            />
          </div>
        ) : (
          <>
            <Virtuoso
              ref={virtuosoRef}
              data={displayEntries}
              components={virtuosoComponents}
              firstItemIndex={firstItemIndex}
              initialItemCount={
                displayEntries.length <= MESSAGE_LIST_INITIAL_ITEM_RENDER_LIMIT
                  ? displayEntries.length
                  : undefined
              }
              increaseViewportBy={MESSAGE_LIST_VIEWPORT_BUFFER_PX}
              overscan={MESSAGE_LIST_OVERSCAN_PX}
              atBottomThreshold={AUTO_SCROLL_THRESHOLD_PX}
              atBottomStateChange={handleAtBottomStateChange}
              atTopThreshold={LOAD_OLDER_HISTORY_THRESHOLD_PX}
              atTopStateChange={handleAtTopStateChange}
              startReached={handleStartReached}
              scrollerRef={handleScrollerRef}
              computeItemKey={(_index, entry) => entry.id}
              itemContent={renderMessageRow}
              className="min-h-0 flex-1"
              style={{ height: "100%" }}
            />

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
