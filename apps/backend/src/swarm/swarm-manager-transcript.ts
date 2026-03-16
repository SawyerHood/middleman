import type { SessionRecord, SwarmdCoreHandle, SwarmdMessage } from "swarmd";

import type {
  AgentDescriptor,
  AgentModelDescriptor,
  AgentStatus,
  AgentToolCallEvent,
  ConversationAttachment,
  ConversationAttachmentMetadata,
  ConversationEntryEvent,
  ConversationLogEvent,
  ConversationMessageEvent,
  MessageSourceContext,
  MessageTargetContext,
  RequestedDeliveryMode,
  SendMessageReceipt,
} from "./types.js";

interface SwarmTranscriptServiceOptions {
  getCore: () => SwarmdCoreHandle;
  getAgent: (agentId: string) => AgentDescriptor | undefined;
  resolvePreferredManagerId: () => string | undefined;
  resolveRuntimeErrorMessage: (descriptor: AgentDescriptor, payload: unknown) => string;
}

export class SwarmTranscriptService {
  constructor(private readonly options: SwarmTranscriptServiceOptions) {}

  projectConversationEntries(agentId?: string, limit?: number): ConversationEntryEvent[] {
    const resolvedAgentId = agentId?.trim() || this.options.resolvePreferredManagerId();
    if (!resolvedAgentId) {
      return [];
    }

    const entries: ConversationEntryEvent[] = [];
    const core = this.options.getCore();
    const session = core.sessionService.getById(resolvedAgentId);

    if (session) {
      let hasPersistedRuntimeError = false;
      for (const message of core.messageStore.list(resolvedAgentId)) {
        const projected = projectStoredMessage(message);
        if (projected) {
          entries.push(projected);
          if (projected.type === "conversation_log" && projected.isError === true) {
            hasPersistedRuntimeError = true;
          }
        }
      }

      if (session.status === "errored" && !hasPersistedRuntimeError) {
        entries.push({
          type: "conversation_log",
          agentId: resolvedAgentId,
          timestamp: session.updatedAt,
          source: "runtime_log",
          kind: "message_end",
          text: this.options.resolveRuntimeErrorMessage(
            this.options.getAgent(resolvedAgentId) ?? fallbackDescriptorForErroredSession(resolvedAgentId, session),
            { error: session.lastError ?? null },
          ),
          isError: true,
        });
      }
    }

    entries.sort((left, right) => left.timestamp.localeCompare(right.timestamp));

    if (!limit || entries.length <= limit) {
      return entries;
    }

    return entries.slice(entries.length - limit);
  }

  getVisibleTranscript(
    agentId?: string,
    options?: { limit?: number },
  ): Array<ConversationMessageEvent | ConversationLogEvent> {
    return this.projectConversationEntries(agentId, options?.limit).filter(
      (entry): entry is ConversationMessageEvent | ConversationLogEvent =>
        entry.type === "conversation_message" ||
        (entry.type === "conversation_log" && entry.isError === true),
    );
  }
}

function fallbackDescriptorForErroredSession(sessionId: string, session: SessionRecord): AgentDescriptor {
  return {
    agentId: sessionId,
    displayName: session.displayName,
    role: "manager",
    managerId: sessionId,
    status: "errored",
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    cwd: session.cwd,
    model: fromSwarmdModel(session),
    contextUsage: session.contextUsage ?? undefined,
  };
}

function fromSwarmdModel(session: SessionRecord): AgentModelDescriptor {
  if (session.backend === "codex") {
    return {
      provider: "openai-codex-app-server",
      modelId: session.model,
      thinkingLevel: "xhigh",
    };
  }

  if (session.backend === "claude") {
    return {
      provider: "anthropic-claude-code",
      modelId: session.model,
      thinkingLevel: "xhigh",
    };
  }

  const parsedModel = /^([^/:]+)[/:](.+)$/.exec(session.model);
  return {
    provider: parsedModel?.[1] ?? "openai-codex",
    modelId: parsedModel?.[2] ?? session.model,
    thinkingLevel: "xhigh",
  };
}

export function projectStoredMessage(message: SwarmdMessage): ConversationEntryEvent | null {
  const middleman = readObject(readObject(message.metadata)?.middleman);
  const routing = readObject(middleman?.routing);
  const renderAs = readString(middleman?.renderAs);

  if (readBoolean(middleman?.suppressed) === true) {
    return null;
  }

  if (renderAs === "conversation_log") {
    const event = readObject(middleman?.event);
    const kind = readConversationLogKind(event?.kind);
    const text = readString(event?.text);
    if (!kind || text === undefined) {
      return null;
    }

    return {
      type: "conversation_log",
      agentId: readString(event?.agentId) ?? message.sessionId,
      timestamp: readString(event?.timestamp) ?? message.createdAt,
      source: "runtime_log",
      kind,
      role: readRole(event?.role),
      toolName: readString(event?.toolName),
      toolCallId: readString(event?.toolCallId),
      text,
      isError: readBoolean(event?.isError),
    };
  }

  if (renderAs === "agent_tool_call") {
    const event = readObject(middleman?.event);
    const kind = readAgentToolCallKind(event?.kind);
    const text = readString(event?.text);
    if (!kind || text === undefined) {
      return null;
    }

    return {
      type: "agent_tool_call",
      agentId: readString(event?.agentId) ?? message.sessionId,
      actorAgentId: readString(event?.actorAgentId) ?? message.sessionId,
      timestamp: readString(event?.timestamp) ?? message.createdAt,
      kind,
      toolName: readString(event?.toolName),
      toolCallId: readString(event?.toolCallId),
      text,
      isError: readBoolean(event?.isError),
    };
  }

  if (
    (message.role === "user" || message.role === "system") &&
    renderAs === "conversation_message"
  ) {
    return {
      type: "conversation_message",
      agentId: readString(middleman?.agentId) ?? message.sessionId,
      role: message.role,
      text: extractStoredMessageText(message.content),
      attachments: readAttachments(middleman?.attachments),
      timestamp: message.createdAt,
      source: readConversationSource(middleman?.source, message.role),
      sourceContext: readObject(middleman?.sourceContext) as MessageSourceContext | undefined,
    };
  }

  if (
    message.role === "system" &&
    readString(middleman?.visibility) === "internal" &&
    renderAs === "hidden" &&
    routing
  ) {
    return {
      type: "agent_message",
      agentId: readString(middleman?.managerId) ?? readString(middleman?.agentId) ?? message.sessionId,
      timestamp: message.createdAt,
      source: readString(routing.origin) === "agent" ? "agent_to_agent" : "user_to_agent",
      fromAgentId: readString(routing.fromAgentId),
      toAgentId: readString(routing.toAgentId) ?? message.sessionId,
      text: extractStoredMessageText(message.content),
      requestedDelivery: readRequestedDeliveryMode(routing.requestedDelivery),
    };
  }

  if (message.role === "assistant" || message.role === "system") {
    const text = extractStoredMessageText(message.content);
    const attachments = mergeAttachments(
      readAttachments(middleman?.attachments),
      extractStoredMessageAttachments(message.content),
    );
    if (!text && attachments.length === 0) {
      return null;
    }

    return {
      type: "conversation_message",
      agentId: readString(middleman?.agentId) ?? message.sessionId,
      role: message.role,
      text,
      attachments: attachments.length > 0 ? attachments : undefined,
      timestamp: message.createdAt,
      source: "system",
      sourceContext: readObject(middleman?.sourceContext) as MessageSourceContext | undefined,
    };
  }

  if (message.role === "tool") {
    const content = readObject(message.content);
    if (readString(content?.toolName) !== "speak_to_user") {
      return null;
    }

    const result = readObject(content?.result);
    const details = readObject(result?.details);
    const text = readString(details?.text) ?? extractToolResultContentText(result?.contentItems);
    if (!text) {
      return null;
    }

    return {
      type: "conversation_message",
      agentId: message.sessionId,
      role: "assistant",
      text,
      timestamp: message.createdAt,
      source: "speak_to_user",
      sourceContext: readObject(details?.targetContext) as MessageSourceContext | undefined,
    };
  }

  return null;
}

export function buildAttachmentMetadata(
  attachments: ConversationAttachment[],
): ConversationAttachmentMetadata[] | undefined {
  if (attachments.length === 0) {
    return undefined;
  }

  return attachments.map((attachment) => ({
    type: attachment.type ?? (attachment.mimeType.startsWith("image/") ? "image" : undefined),
    mimeType: attachment.mimeType,
    fileName: attachment.fileName,
    filePath: "filePath" in attachment ? attachment.filePath : undefined,
  }));
}

export function toTargetContext(sourceContext: MessageSourceContext): MessageTargetContext {
  return {
    channel: sourceContext.channel,
    channelId: sourceContext.channelId,
    userId: sourceContext.userId,
    threadTs: sourceContext.threadTs,
    integrationProfileId: sourceContext.integrationProfileId,
  };
}

export function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function readRole(value: unknown): "user" | "assistant" | "system" | undefined {
  return value === "user" || value === "assistant" || value === "system" ? value : undefined;
}

export function readConversationSource(
  value: unknown,
  role: "user" | "assistant" | "system",
): "user_input" | "system" {
  return value === "system" || role === "system" ? "system" : "user_input";
}

export function readRequestedDeliveryMode(value: unknown): RequestedDeliveryMode | undefined {
  return value === "auto" || value === "followUp" || value === "steer"
    ? value
    : undefined;
}

export function readConversationLogKind(value: unknown): ConversationLogEvent["kind"] | undefined {
  return value === "message_start" ||
      value === "message_end" ||
      value === "tool_execution_start" ||
      value === "tool_execution_update" ||
      value === "tool_execution_end"
    ? value
    : undefined;
}

export function readAgentToolCallKind(value: unknown): AgentToolCallEvent["kind"] | undefined {
  return value === "tool_execution_start" ||
      value === "tool_execution_update" ||
      value === "tool_execution_end"
    ? value
    : undefined;
}

export function readAttachments(value: unknown): ConversationAttachmentMetadata[] | undefined {
  return Array.isArray(value) ? (value as ConversationAttachmentMetadata[]) : undefined;
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return String(value);
  }
}

export function extractEventText(payload: unknown): string | undefined {
  const object = readObject(payload);
  return readString(object?.text);
}

export function extractStoredMessageText(content: unknown): string {
  const object = readObject(content);
  const directText = readString(object?.text);
  if (directText) {
    return directText;
  }

  const parts = Array.isArray(object?.parts) ? object.parts : [];
  const partText = parts
    .map((part) => {
      const partObject = readObject(part);
      return readString(partObject?.text) ?? "";
    })
    .filter(Boolean)
    .join("\n");
  if (partText) {
    return partText;
  }

  const contentBlocks = Array.isArray(object?.content) ? object.content : [];
  const blockText = contentBlocks
    .map((block) => {
      const blockObject = readObject(block);
      return readString(blockObject?.text) ?? "";
    })
    .filter(Boolean)
    .join("\n");
  if (blockText) {
    return blockText;
  }

  return extractToolResultContentText(object?.contentItems) ?? "";
}

export function extractToolResultContentText(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const text = value
    .map((item) => readString(readObject(item)?.text) ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
  return text.length > 0 ? text : undefined;
}

export function extractStoredMessageAttachments(content: unknown): ConversationAttachmentMetadata[] {
  const object = readObject(content);
  if (!object) {
    return [];
  }

  return mergeAttachments(
    extractAttachmentsFromArray(Array.isArray(object.parts) ? object.parts : []),
    extractAttachmentsFromArray(Array.isArray(object.content) ? object.content : []),
    extractAttachmentsFromArray(Array.isArray(object.contentItems) ? object.contentItems : []),
    Array.isArray(object.attachments) ? readAttachments(object.attachments) : undefined,
  );
}

function extractAttachmentsFromArray(
  value: unknown[],
): ConversationAttachmentMetadata[] {
  const attachments: ConversationAttachmentMetadata[] = [];

  for (const item of value) {
    const object = readObject(item);
    if (!object) {
      continue;
    }

    const type = readString(object.type);
    if (type === "image") {
      const mimeType =
        readString(object.mimeType) ??
        readString(readObject(object.source)?.media_type);
      if (!mimeType) {
        continue;
      }
      attachments.push({
        type: "image",
        mimeType,
        fileName: readString(object.fileName),
        filePath: readString(object.path) ?? readString(object.filePath),
      });
      continue;
    }

    if (type === "file") {
      const mimeType = readString(object.mimeType);
      if (!mimeType) {
        continue;
      }
      attachments.push({
        type: mimeType.startsWith("text/") ? "text" : "binary",
        mimeType,
        fileName: readString(object.fileName),
        filePath: readString(object.path) ?? readString(object.filePath),
      });
      continue;
    }
  }

  return attachments;
}

function mergeAttachments(
  ...groups: Array<ConversationAttachmentMetadata[] | undefined>
): ConversationAttachmentMetadata[] {
  const merged: ConversationAttachmentMetadata[] = [];
  const seen = new Set<string>();

  for (const group of groups) {
    if (!group) {
      continue;
    }

    for (const attachment of group) {
      const key = [
        attachment.type ?? "",
        attachment.mimeType,
        attachment.fileName ?? "",
        attachment.filePath ?? "",
      ].join("|");
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(attachment);
    }
  }

  return merged;
}

export function isAgentStatus(value: unknown): value is AgentStatus {
  return (
    value === "created" ||
    value === "starting" ||
    value === "idle" ||
    value === "busy" ||
    value === "interrupting" ||
    value === "stopping" ||
    value === "stopped" ||
    value === "errored" ||
    value === "terminated"
  );
}

export function cloneDescriptor(descriptor: AgentDescriptor): AgentDescriptor {
  return {
    ...descriptor,
    model: { ...descriptor.model },
    ...(descriptor.contextUsage
      ? {
          contextUsage: { ...descriptor.contextUsage },
        }
      : {}),
  };
}

export function fromSwarmdDeliveryMode(
  delivery: "auto" | "interrupt" | "queue",
  requested: RequestedDeliveryMode,
): SendMessageReceipt["acceptedMode"] {
  if (delivery === "queue") {
    return requested === "followUp" ? "followUp" : "steer";
  }

  return "prompt";
}
