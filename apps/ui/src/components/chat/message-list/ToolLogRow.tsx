import { memo, useId, useState } from "react";
import { AlertCircle, Check, ChevronRight, Copy, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { formatTimestamp } from "./message-row-utils";
import type { ConversationLogEntry, ToolDisplayStatus, ToolExecutionDisplayEntry } from "./types";

const SHELL_LIKE_TOOLS = new Set(["bash", "sh", "zsh", "fish", "command_execution"]);

const TOOL_DETAIL_KEYS: Record<string, string[]> = {
  bash: ["command", "description"],
  sh: ["command", "description"],
  zsh: ["command", "description"],
  fish: ["command", "description"],
  command_execution: ["command", "description"],
  read: ["path"],
  write: ["path"],
  edit: ["path"],
  send_message_to_agent: ["targetAgentId"],
  request_user_input: ["description"],
  web_search: ["query"],
  image_view: ["path", "url"],
};

type SummaryParts = {
  verb: string;
  detail: string;
};

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) {
    return str;
  }

  return `${str.slice(0, maxLen)}…`;
}

function truncateInline(str: string, maxLen: number): string {
  return truncate(str.replace(/\s+/g, " ").trim(), maxLen);
}

function pickString(record: Record<string, unknown> | undefined, keys: string[]): string | null {
  if (!record) {
    return null;
  }

  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}

function humanizeFieldName(fieldName: string): string {
  return fieldName
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .trim();
}

function mapToolStatus(entry: ToolExecutionDisplayEntry): ToolDisplayStatus {
  if (entry.latestKind !== "tool_execution_end") {
    return "pending";
  }

  if (!entry.isError) {
    return "completed";
  }

  const lowered = `${entry.outputPayload ?? entry.latestPayload ?? ""}`.toLowerCase();
  if (lowered.includes("[aborted]") || lowered.includes("cancel")) {
    return "cancelled";
  }

  return "error";
}

function isShellLikeTool(toolName: string | undefined): boolean {
  return !!toolName && SHELL_LIKE_TOOLS.has(toolName);
}

function formatToolLabel(toolName: string | undefined): string {
  const normalizedToolName = toolName?.trim();
  if (!normalizedToolName) {
    return "tool";
  }

  if (normalizedToolName.startsWith("mcp:")) {
    const [server, tool] = normalizedToolName.slice(4).split("/");
    if (server && tool) {
      return `${server}.${tool} tool`;
    }
  }

  if (normalizedToolName.startsWith("collab:")) {
    return `${normalizedToolName.slice(7)} tool`;
  }

  if (normalizedToolName.startsWith("task:")) {
    return "task";
  }

  return `${normalizedToolName} tool`;
}

function formatDuration(durationMs: number | undefined): string | null {
  if (durationMs === undefined || durationMs < 0) {
    return null;
  }

  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }

  if (durationMs < 60_000) {
    const seconds = durationMs / 1_000;
    return `${seconds >= 10 ? seconds.toFixed(0) : seconds.toFixed(1)}s`;
  }

  const totalSeconds = Math.floor(durationMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function formatInlineValue(value: unknown): string {
  if (typeof value === "string") {
    return truncateInline(value, 96);
  }

  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }

    return truncateInline(JSON.stringify(value), 96);
  }

  if (value && typeof value === "object") {
    return truncateInline(JSON.stringify(value), 96);
  }

  return "Unknown";
}

function formatPrettyValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === undefined) {
    return "";
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function getCommandPreview(entry: ToolExecutionDisplayEntry): string | null {
  const explicitCommand = pickString(entry.inputRecord, ["command", "cmd"]);
  if (explicitCommand) {
    return explicitCommand;
  }

  const description = pickString(entry.inputRecord, ["description"]);
  if (description) {
    return description;
  }

  if (typeof entry.inputValue === "string" && entry.inputValue.trim().length > 0) {
    return entry.inputValue.trim();
  }

  return null;
}

function getToolDetailPreview(entry: ToolExecutionDisplayEntry): string | null {
  const normalizedToolName = entry.toolName?.trim();
  const explicitDetail = normalizedToolName
    ? pickString(entry.inputRecord, TOOL_DETAIL_KEYS[normalizedToolName] ?? [])
    : null;

  if (explicitDetail) {
    return explicitDetail;
  }

  const fallback = pickString(entry.inputRecord, [
    "description",
    "path",
    "url",
    "query",
    "targetAgentId",
    "preview",
    "summary",
  ]);
  if (fallback) {
    return fallback;
  }

  if (typeof entry.inputValue === "string" && entry.inputValue.trim().length > 0) {
    return entry.inputValue.trim();
  }

  return null;
}

function extractShellOutputFragment(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return (
    pickString(value as Record<string, unknown>, [
      "stdout",
      "stderr",
      "output",
      "message",
      "preview",
      "summary",
    ]) ?? null
  );
}

function getShellOutputText(entry: ToolExecutionDisplayEntry): string | null {
  const streamedOutput = entry.updateValues
    .map((value) => extractShellOutputFragment(value))
    .filter((fragment): fragment is string => Boolean(fragment))
    .join("");

  if (streamedOutput.trim().length > 0) {
    return streamedOutput;
  }

  return extractShellOutputFragment(entry.outputValue);
}

function getSummaryParts(
  entry: ToolExecutionDisplayEntry,
  status: ToolDisplayStatus,
): SummaryParts {
  if (isShellLikeTool(entry.toolName)) {
    const commandPreview = truncateInline(getCommandPreview(entry) ?? "command", 96);

    if (status === "completed") {
      return {
        verb: "Ran",
        detail: commandPreview,
      };
    }

    if (status === "cancelled") {
      return {
        verb: "Stopped",
        detail: "command",
      };
    }

    if (status === "error") {
      return {
        verb: "Failed",
        detail: commandPreview,
      };
    }

    return {
      verb: "Running",
      detail: "command",
    };
  }

  const toolLabel = formatToolLabel(entry.toolName);
  const toolDetailPreview = getToolDetailPreview(entry);
  const detail = toolDetailPreview
    ? `${toolLabel} · ${truncateInline(toolDetailPreview, 72)}`
    : toolLabel;

  if (status === "completed") {
    return { verb: "Called", detail };
  }

  if (status === "cancelled") {
    return { verb: "Stopped", detail };
  }

  if (status === "error") {
    return { verb: "Failed", detail };
  }

  return { verb: "Calling", detail };
}

function copyToClipboard(value: string): void {
  const clipboard = globalThis.navigator?.clipboard;
  if (!clipboard || value.length === 0) {
    return;
  }

  void clipboard.writeText(value).catch(() => undefined);
}

function ExecutionCopyButton({
  ariaLabel,
  value,
  className,
}: {
  ariaLabel: string;
  value: string | null;
  className?: string;
}) {
  if (!value) {
    return null;
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn(
        "h-6 rounded-sm px-1.5 text-[10px] text-[var(--chat-exec-muted)] hover:bg-transparent hover:text-[var(--chat-exec-muted-strong)]",
        className,
      )}
      onClick={() => copyToClipboard(value)}
      aria-label={ariaLabel}
    >
      <Copy className="size-3" aria-hidden="true" />
    </Button>
  );
}

function ExecutionStatusIcon({ status }: { status: ToolDisplayStatus }) {
  if (status === "completed") {
    return <Check className="size-3.5 text-[var(--chat-exec-muted-strong)]" aria-hidden="true" />;
  }

  if (status === "cancelled") {
    return <X className="size-3.5 text-[var(--chat-exec-muted)]" aria-hidden="true" />;
  }

  if (status === "error") {
    return <AlertCircle className="size-3.5 text-[var(--chat-error-fg)]" aria-hidden="true" />;
  }

  return (
    <Loader2 className="size-3.5 animate-spin text-[var(--chat-exec-muted)]" aria-hidden="true" />
  );
}

function ToolExecutionSummaryText({
  summary,
  status,
}: {
  summary: SummaryParts;
  status: ToolDisplayStatus;
}) {
  if (status === "pending") {
    return (
      <span className="block min-w-0 truncate text-size-chat execution-shimmer-text">
        {summary.verb} {summary.detail}
      </span>
    );
  }

  return (
    <span className="block min-w-0 truncate text-size-chat">
      <span className="execution-summary-text font-medium">{summary.verb}</span>
      <span className="execution-summary-text--active ml-1">{summary.detail}</span>
    </span>
  );
}

function ExecutionMetaRow({ entry }: { entry: ToolExecutionDisplayEntry }) {
  const timestampLabel = formatTimestamp(entry.endedAt ?? entry.latestAt);
  const durationLabel = formatDuration(entry.durationMs);
  const actorLabel = entry.actorAgentId?.trim();

  const metaParts = [
    timestampLabel,
    durationLabel,
    actorLabel,
    entry.toolCallId ? truncate(entry.toolCallId, 24) : null,
  ].filter((value): value is string => Boolean(value));

  if (metaParts.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-size-chat-sm text-[var(--chat-exec-muted)]">
      {metaParts.map((part, index) => (
        <span key={`${part}-${index}`}>{part}</span>
      ))}
    </div>
  );
}

function ExecutionTextPane({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string | null;
  tone?: "neutral" | "error";
}) {
  return (
    <div className="group/pane flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--chat-exec-muted)]">
          {label}
        </span>
        <ExecutionCopyButton
          ariaLabel={`Copy ${label.toLowerCase()}`}
          value={value}
          className="execution-hover-actions group-hover/pane:opacity-100 group-focus-within/pane:opacity-100"
        />
      </div>

      <ScrollArea
        className={cn(
          "execution-terminal-pane execution-scroll-fade-mask rounded-md",
          tone === "error" && "border-[var(--chat-error-border)] bg-[var(--chat-error-bg)]",
        )}
      >
        <pre
          className={cn(
            "font-editor text-size-code-sm min-h-full whitespace-pre-wrap break-words p-2",
            tone === "error"
              ? "text-[var(--chat-error-fg)]"
              : "text-[var(--chat-exec-muted-strong)]",
          )}
        >
          {value && value.trim().length > 0 ? value : "No output"}
        </pre>
      </ScrollArea>
    </div>
  );
}

function ExecutionStructuredFields({
  label,
  record,
  tone = "neutral",
}: {
  label: string;
  record: Record<string, unknown>;
  tone?: "neutral" | "error";
}) {
  const entries = Object.entries(record);
  if (entries.length === 0) {
    return null;
  }

  const visibleEntries = entries.slice(0, 6);
  const hiddenCount = entries.length - visibleEntries.length;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--chat-exec-muted)]">
          {label}
        </span>
        {hiddenCount > 0 ? (
          <span className="text-[10px] text-[var(--chat-exec-muted)]">+{hiddenCount} more</span>
        ) : null}
      </div>

      <div
        className={cn(
          "flex flex-col gap-1 rounded-md px-2 py-1.5",
          tone === "error" && "bg-[var(--chat-error-bg)]",
        )}
      >
        {visibleEntries.map(([key, value]) => (
          <div
            key={key}
            className="flex flex-wrap items-start gap-x-2 gap-y-1 text-size-chat-sm leading-5"
          >
            <span className="font-medium text-[var(--chat-exec-muted)]">
              {humanizeFieldName(key)}
            </span>
            <span
              className={cn(
                "min-w-0 flex-1 break-words",
                tone === "error"
                  ? "text-[var(--chat-error-fg)]"
                  : "text-[var(--chat-exec-muted-strong)]",
              )}
            >
              {formatInlineValue(value)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RawPayloadDialog({ entry }: { entry: ToolExecutionDisplayEntry }) {
  const latestDetailPayload =
    entry.outputPayload ?? entry.latestUpdatePayload ?? entry.latestPayload ?? null;
  const title = entry.toolName
    ? `Raw ${formatToolLabel(entry.toolName)} output`
    : "Raw tool payload";

  if (!entry.inputPayload && !latestDetailPayload) {
    return null;
  }

  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="execution-hover-actions h-6 rounded-sm px-2 text-[10px] text-[var(--chat-exec-muted)] hover:bg-transparent hover:text-[var(--chat-exec-muted-strong)] group-hover/execution-body:opacity-100 group-focus-within/execution-body:opacity-100"
          />
        }
      >
        Raw
      </DialogTrigger>

      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Serialized event payloads for this execution row.</DialogDescription>
        </DialogHeader>

        <div className="mt-3 space-y-3">
          {entry.inputPayload ? (
            <ExecutionTextPane label="Input payload" value={entry.inputPayload} />
          ) : null}

          {latestDetailPayload ? (
            <ExecutionTextPane
              label="Result payload"
              value={latestDetailPayload}
              tone={mapToolStatus(entry) === "error" ? "error" : "neutral"}
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ShellExecutionBlock({
  entry,
  status,
}: {
  entry: ToolExecutionDisplayEntry;
  status: ToolDisplayStatus;
}) {
  const commandPreview = getCommandPreview(entry);
  const outputText = getShellOutputText(entry);

  return (
    <div className="group/execution-body flex flex-col gap-2">
      <div className="group/command flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--chat-exec-muted)]">
            Command
          </span>
          <ExecutionCopyButton
            ariaLabel="Copy command"
            value={commandPreview}
            className="execution-hover-actions group-hover/command:opacity-100 group-focus-within/command:opacity-100"
          />
        </div>

        <div className="rounded-md border border-[var(--chat-exec-border)] bg-[var(--chat-terminal-bg)]/60 px-2 py-1.5">
          <p className="font-editor text-size-chat-sm whitespace-pre-wrap break-words text-[var(--chat-exec-muted-strong)]">
            {commandPreview ?? "No command preview"}
          </p>
        </div>
      </div>

      <ExecutionTextPane
        label={
          status === "pending" ? "Live output" : status === "error" ? "Error output" : "Output"
        }
        value={outputText}
        tone={status === "error" ? "error" : "neutral"}
      />

      <ExecutionMetaRow entry={entry} />
    </div>
  );
}

function JsonExecutionBlock({
  entry,
  status,
}: {
  entry: ToolExecutionDisplayEntry;
  status: ToolDisplayStatus;
}) {
  const latestRecord = entry.outputRecord ?? entry.latestUpdateRecord;
  const latestValue = latestRecord ? undefined : (entry.outputValue ?? entry.latestUpdateValue);
  const latestText =
    latestValue !== undefined && latestValue !== null ? formatPrettyValue(latestValue) : null;

  return (
    <div className="group/execution-body flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {entry.inputRecord ? (
            <ExecutionStructuredFields label="Input" record={entry.inputRecord} />
          ) : entry.inputValue !== undefined ? (
            <ExecutionTextPane label="Input" value={formatPrettyValue(entry.inputValue)} />
          ) : null}
        </div>

        <RawPayloadDialog entry={entry} />
      </div>

      {latestRecord ? (
        <ExecutionStructuredFields
          label={status === "pending" ? "Update" : status === "error" ? "Error" : "Result"}
          record={latestRecord}
          tone={status === "error" ? "error" : "neutral"}
        />
      ) : latestText ? (
        <ExecutionTextPane
          label={status === "pending" ? "Update" : status === "error" ? "Error" : "Result"}
          value={latestText}
          tone={status === "error" ? "error" : "neutral"}
        />
      ) : (
        <p className="text-size-chat-sm text-[var(--chat-exec-muted)]">No result details.</p>
      )}

      <ExecutionMetaRow entry={entry} />
    </div>
  );
}

function ToolExecutionBody({
  entry,
  status,
}: {
  entry: ToolExecutionDisplayEntry;
  status: ToolDisplayStatus;
}) {
  if (isShellLikeTool(entry.toolName)) {
    return <ShellExecutionBlock entry={entry} status={status} />;
  }

  return <JsonExecutionBlock entry={entry} status={status} />;
}

function ToolExecutionLogRow({ entry }: { entry: ToolExecutionDisplayEntry }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const contentId = useId();

  const displayStatus = mapToolStatus(entry);
  const summary = getSummaryParts(entry, displayStatus);
  const durationLabel = formatDuration(entry.durationMs);

  return (
    <div className="rounded-md">
      <Button
        type="button"
        variant="ghost"
        className={cn(
          "group/summary h-auto w-full items-start justify-start gap-2 rounded-md px-1 py-1.5 text-left font-normal",
          "text-[var(--chat-exec-muted)] hover:bg-transparent hover:text-[var(--chat-exec-muted-strong)]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
        )}
        aria-expanded={isExpanded}
        aria-controls={contentId}
        onClick={() => setIsExpanded((previous) => !previous)}
      >
        <span className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center">
          <ExecutionStatusIcon status={displayStatus} />
        </span>

        <div className="min-w-0 flex-1">
          <ToolExecutionSummaryText summary={summary} status={displayStatus} />
        </div>

        {durationLabel ? (
          <span className="hidden shrink-0 text-size-chat-sm text-[var(--chat-exec-muted)] sm:inline">
            {durationLabel}
          </span>
        ) : null}

        <ChevronRight
          className={cn(
            "execution-hover-actions mt-0.5 size-3.5 shrink-0 text-[var(--chat-exec-muted)] transition-transform duration-200 group-hover/summary:opacity-100 group-focus-visible/summary:opacity-100",
            isExpanded && "rotate-90 opacity-100",
          )}
          aria-hidden="true"
        />
      </Button>

      <div
        id={contentId}
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
          isExpanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="overflow-hidden">
          <div className="pl-6 pt-1.5">
            <ToolExecutionBody entry={entry} status={displayStatus} />
          </div>
        </div>
      </div>
    </div>
  );
}

function RuntimeErrorLog({ entry }: { entry: ConversationLogEntry }) {
  const text = formatPrettyValue((entry as ConversationLogEntry & { text: unknown }).text);

  return (
    <div className="rounded-md border border-[var(--chat-error-border)] bg-[var(--chat-error-bg)] px-3 py-2">
      <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-[var(--chat-error-fg)]">
        <AlertCircle className="size-3" aria-hidden="true" />
        <span>Runtime error</span>
      </div>
      <p className="text-size-chat whitespace-pre-wrap break-words text-[var(--chat-error-fg)]">
        {text}
      </p>
    </div>
  );
}

function ToolLogRowBase({
  type,
  entry,
}: {
  type: "tool_execution" | "runtime_error_log";
  entry: ToolExecutionDisplayEntry | ConversationLogEntry;
}) {
  if (type === "runtime_error_log") {
    return <RuntimeErrorLog entry={entry as ConversationLogEntry} />;
  }

  return <ToolExecutionLogRow entry={entry as ToolExecutionDisplayEntry} />;
}

function areToolExecutionEntriesEqual(
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

function areRuntimeErrorEntriesEqual(
  previousEntry: ConversationLogEntry,
  nextEntry: ConversationLogEntry,
): boolean {
  return (
    previousEntry === nextEntry ||
    (previousEntry.agentId === nextEntry.agentId &&
      previousEntry.timestamp === nextEntry.timestamp &&
      previousEntry.kind === nextEntry.kind &&
      previousEntry.isError === nextEntry.isError &&
      previousEntry.text === nextEntry.text)
  );
}

export const ToolLogRow = memo(ToolLogRowBase, (previousProps, nextProps) => {
  if (previousProps.type !== nextProps.type) {
    return false;
  }

  if (previousProps.entry === nextProps.entry) {
    return true;
  }

  if (previousProps.type === "runtime_error_log") {
    return areRuntimeErrorEntriesEqual(
      previousProps.entry as ConversationLogEntry,
      nextProps.entry as ConversationLogEntry,
    );
  }

  return areToolExecutionEntriesEqual(
    previousProps.entry as ToolExecutionDisplayEntry,
    nextProps.entry as ToolExecutionDisplayEntry,
  );
});
