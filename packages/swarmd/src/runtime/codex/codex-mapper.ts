import type { EventEnvelope, SessionStatus } from "../../core/types/index.js";
import {
  messageCompletedEvent,
  messageDeltaEvent,
  messageStartedEvent,
  sessionStatusEvent,
  toolCompletedEvent,
  toolProgressEvent,
  toolStartedEvent,
  turnCompletedEvent,
  turnStartedEvent,
} from "../common/event-normalizer.js";

export interface CodexNotificationMessage {
  method: string;
  params?: unknown;
}

export interface CodexMapperContext {
  sessionId: string;
  threadId?: string | null;
  previousStatus?: SessionStatus;
  toolNameByItemId?: ReadonlyMap<string, string>;
}

type AdapterEvent = Omit<EventEnvelope, "cursor">;
type ParsedCodexItem = Record<string, unknown> & {
  id: string;
  type: string;
};

export function mapCodexNotificationToEvents(
  notification: CodexNotificationMessage,
  context: CodexMapperContext,
): AdapterEvent[] {
  const threadId = resolveThreadId(notification.params, context.threadId ?? null);

  switch (notification.method) {
    case "turn/started": {
      const turn = readObject(notification.params, "turn");
      const turnId = readString(turn?.id);
      if (!turnId) {
        return [];
      }

      return [
        toAdapterEvent(
          turnStartedEvent({
            sessionId: context.sessionId,
            threadId,
            source: "backend",
            turnId,
            payload: {
              ...(turn?.status === undefined ? {} : { status: turn.status }),
            },
          }),
        ),
      ];
    }

    case "turn/completed": {
      const turn = readObject(notification.params, "turn");
      const turnId = readString(turn?.id);
      if (!turnId) {
        return [];
      }

      return [
        toAdapterEvent(
          turnCompletedEvent({
            sessionId: context.sessionId,
            threadId,
            source: "backend",
            turnId,
            payload: {
              ...(turn?.status === undefined ? {} : { status: turn.status }),
              ...(turn?.error === undefined ? {} : { error: turn.error }),
            },
          }),
        ),
      ];
    }

    case "item/agentMessage/delta": {
      const itemId = readString(readObject(notification.params)?.itemId);
      const delta = readString(readObject(notification.params)?.delta);
      if (!itemId || delta === undefined) {
        return [];
      }

      return [
        toAdapterEvent(
          messageDeltaEvent({
            sessionId: context.sessionId,
            threadId,
            source: "backend",
            messageId: itemId,
            delta,
            payload: withTurnId(notification.params),
          }),
        ),
      ];
    }

    case "item/started":
      return mapItemEvent("started", notification.params, context, threadId);

    case "item/completed":
      return mapItemEvent("completed", notification.params, context, threadId);

    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta":
    case "item/mcpToolCall/progress": {
      const params = readObject(notification.params);
      const itemId = readString(params?.itemId);
      if (!itemId) {
        return [];
      }

      const toolName = context.toolNameByItemId?.get(itemId) ?? notification.method;
      const progress =
        notification.method === "item/mcpToolCall/progress"
          ? { message: readString(params?.message) ?? "", raw: params }
          : { delta: readString(params?.delta) ?? "", raw: params };

      return [
        toAdapterEvent(
          toolProgressEvent({
            sessionId: context.sessionId,
            threadId,
            source: "backend",
            toolName,
            toolCallId: itemId,
            progress,
            payload: withTurnId(notification.params),
          }),
        ),
      ];
    }

    case "thread/status/changed": {
      const params = readObject(notification.params);
      const status = mapCodexThreadStatusToSessionStatus(params?.status);
      if (!status) {
        return [];
      }

      return [
        toAdapterEvent(
          sessionStatusEvent({
            sessionId: context.sessionId,
            threadId,
            source: "backend",
            status,
            previousStatus: context.previousStatus,
            payload: {
              rawStatus: params?.status,
            },
          }),
        ),
      ];
    }

    default:
      return [];
  }
}

export function mapCodexThreadStatusToSessionStatus(status: unknown): SessionStatus | null {
  const kind = readString(readObject(status)?.type);

  switch (kind) {
    case "idle":
      return "idle";
    case "active":
      return "busy";
    case "notLoaded":
      return "stopped";
    case "systemError":
      return "errored";
    default:
      return null;
  }
}

export function isCodexToolLikeItem(item: { type: string }): boolean {
  return (
    item.type === "commandExecution" ||
    item.type === "fileChange" ||
    item.type === "dynamicToolCall" ||
    item.type === "mcpToolCall" ||
    item.type === "collabAgentToolCall" ||
    item.type === "webSearch" ||
    item.type === "imageView"
  );
}

export function codexToolNameForItem(item: ParsedCodexItem): string {
  switch (item.type) {
    case "commandExecution":
      return "command_execution";
    case "fileChange":
      return "file_change";
    case "dynamicToolCall":
      return `dynamic:${readString(item.tool) ?? "unknown"}`;
    case "mcpToolCall":
      return `mcp:${readString(item.server) ?? "unknown"}/${readString(item.tool) ?? "unknown"}`;
    case "collabAgentToolCall":
      return `collab:${readString(item.tool) ?? "unknown"}`;
    case "webSearch":
      return "web_search";
    case "imageView":
      return "image_view";
    default:
      return item.type;
  }
}

export function codexToolItemRepresentsError(item: ParsedCodexItem): boolean {
  const status = readString(item.status) ?? "";

  switch (item.type) {
    case "commandExecution":
    case "fileChange":
      return status === "failed" || status === "declined";
    case "dynamicToolCall":
    case "mcpToolCall":
    case "collabAgentToolCall":
      return status === "failed";
    default:
      return false;
  }
}

function mapItemEvent(
  stage: "started" | "completed",
  params: unknown,
  context: CodexMapperContext,
  threadId: string | null,
): AdapterEvent[] {
  const item = parseItemFromNotification(params);
  if (!item) {
    return [];
  }

  if (item.type === "agentMessage") {
    return [
      stage === "started"
        ? toAdapterEvent(
            messageStartedEvent({
              sessionId: context.sessionId,
              threadId,
              source: "backend",
              messageId: item.id,
              role: "assistant",
              payload: {
                ...withTurnId(params),
                ...(item.phase === undefined ? {} : { phase: item.phase }),
              },
            }),
          )
        : toAdapterEvent(
            messageCompletedEvent({
              sessionId: context.sessionId,
              threadId,
              source: "backend",
              messageId: item.id,
              payload: {
                ...withTurnId(params),
                ...(item.text === undefined ? {} : { text: item.text }),
                ...(item.phase === undefined ? {} : { phase: item.phase }),
              },
            }),
          ),
    ];
  }

  if (item.type === "userMessage") {
    return [
      stage === "started"
        ? toAdapterEvent(
            messageStartedEvent({
              sessionId: context.sessionId,
              threadId,
              source: "backend",
              messageId: item.id,
              role: "user",
              payload: {
                ...withTurnId(params),
                ...(item.content === undefined ? {} : { content: item.content }),
              },
            }),
          )
        : toAdapterEvent(
            messageCompletedEvent({
              sessionId: context.sessionId,
              threadId,
              source: "backend",
              messageId: item.id,
              payload: {
                ...withTurnId(params),
                ...(item.content === undefined ? {} : { content: item.content }),
              },
            }),
          ),
    ];
  }

  if (!isCodexToolLikeItem(item)) {
    return [];
  }

  const toolName = codexToolNameForItem(item);
  return [
    stage === "started"
      ? toAdapterEvent(
          toolStartedEvent({
            sessionId: context.sessionId,
            threadId,
            source: "backend",
            toolName,
            toolCallId: item.id,
            toolInput: summarizeToolInput(item),
            payload: {
              ...withTurnId(params),
              itemType: item.type,
              ...(item.status === undefined ? {} : { status: item.status }),
            },
          }),
        )
      : toAdapterEvent(
          toolCompletedEvent({
            sessionId: context.sessionId,
            threadId,
            source: "backend",
            toolName,
            toolCallId: item.id,
            ok: !codexToolItemRepresentsError(item),
            result: summarizeToolResult(item),
            payload: {
              ...withTurnId(params),
              itemType: item.type,
              ...(item.status === undefined ? {} : { status: item.status }),
            },
          }),
        ),
  ];
}

function summarizeToolInput(item: ParsedCodexItem): unknown {
  switch (item.type) {
    case "commandExecution":
      return {
        command: readString(item.command),
        cwd: readString(item.cwd),
      };
    case "fileChange":
      return {
        changes: item.changes,
      };
    case "dynamicToolCall":
    case "mcpToolCall":
      return {
        arguments: item.arguments,
      };
    case "collabAgentToolCall":
      return {
        prompt: item.prompt,
        receiverThreadIds: item.receiverThreadIds,
      };
    case "webSearch":
      return {
        query: item.query,
      };
    case "imageView":
      return {
        path: item.path,
      };
    default:
      return undefined;
  }
}

function summarizeToolResult(item: ParsedCodexItem): unknown {
  switch (item.type) {
    case "commandExecution":
      return {
        status: item.status,
        aggregatedOutput: item.aggregatedOutput,
        exitCode: item.exitCode,
        durationMs: item.durationMs,
      };
    case "fileChange":
      return {
        status: item.status,
        changes: item.changes,
      };
    case "dynamicToolCall": {
      const structuredResult = readObject(item.result);
      return {
        status: item.status,
        success: item.success,
        contentItems: item.contentItems,
        ...(item.details === undefined
          ? structuredResult?.details === undefined
            ? {}
            : { details: structuredResult.details }
          : { details: item.details }),
        durationMs: item.durationMs,
      };
    }
    case "mcpToolCall":
      return {
        status: item.status,
        result: item.result,
        error: item.error,
        durationMs: item.durationMs,
      };
    case "collabAgentToolCall":
      return {
        status: item.status,
        receiverThreadIds: item.receiverThreadIds,
        agentsStates: item.agentsStates,
      };
    case "webSearch":
      return {
        query: item.query,
        action: item.action,
      };
    case "imageView":
      return {
        path: item.path,
      };
    default:
      return item;
  }
}

function parseItemFromNotification(value: unknown): ParsedCodexItem | undefined {
  const item = readObject(value, "item");
  const id = readString(item?.id);
  const type = readString(item?.type);

  if (!item || !id || !type) {
    return undefined;
  }

  return {
    ...item,
    id,
    type,
  };
}

function resolveThreadId(value: unknown, fallback: string | null): string | null {
  const direct = readString(readObject(value)?.threadId);
  if (direct) {
    return direct;
  }

  const thread = readObject(readObject(value)?.thread);
  const threadId = readString(thread?.id);
  if (threadId) {
    return threadId;
  }

  return fallback;
}

function withTurnId(value: unknown): Record<string, unknown> {
  const turnId = readString(readObject(value)?.turnId);
  return turnId ? { turnId } : {};
}

function toAdapterEvent(event: Omit<EventEnvelope, "cursor">): AdapterEvent {
  return event;
}

function readObject(value: unknown, key?: string): Record<string, unknown> | undefined {
  const maybe = key ? (value as Record<string, unknown> | undefined)?.[key] : value;
  return maybe && typeof maybe === "object" ? (maybe as Record<string, unknown>) : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
