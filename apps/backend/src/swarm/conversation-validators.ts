import type {
  AgentMessageEvent,
  AgentToolCallEvent,
  ConversationAttachment,
  ConversationAttachmentMetadata,
  ConversationBinaryAttachment,
  ConversationImageAttachment,
  ConversationLogEvent,
  ConversationMessageAttachment,
  ConversationMessageEvent,
  ConversationTextAttachment,
  MessageSourceContext,
} from "./types.js";

export function isConversationMessageEvent(value: unknown): value is ConversationMessageEvent {
  if (!value || typeof value !== "object") return false;

  const maybe = value as Partial<ConversationMessageEvent>;
  if (maybe.type !== "conversation_message") return false;
  if (typeof maybe.agentId !== "string" || maybe.agentId.length === 0) return false;
  if (maybe.role !== "user" && maybe.role !== "assistant" && maybe.role !== "system") return false;
  if (typeof maybe.text !== "string") return false;
  if (typeof maybe.timestamp !== "string") return false;
  if (maybe.source !== "user_input" && maybe.source !== "speak_to_user" && maybe.source !== "system") return false;

  if (maybe.attachments !== undefined) {
    if (!Array.isArray(maybe.attachments)) {
      return false;
    }

    for (const attachment of maybe.attachments) {
      if (!isConversationMessageAttachment(attachment)) {
        return false;
      }
    }
  }

  if (maybe.sourceContext !== undefined && !isMessageSourceContext(maybe.sourceContext)) {
    return false;
  }

  return true;
}

export function isMessageSourceContext(value: unknown): value is MessageSourceContext {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as Partial<MessageSourceContext>;

  if (maybe.channel !== "web") {
    return false;
  }

  return true;
}

export function isConversationAttachment(value: unknown): value is ConversationAttachment {
  return (
    isConversationImageAttachment(value) ||
    isConversationTextAttachment(value) ||
    isConversationBinaryAttachment(value)
  );
}

export function isConversationMessageAttachment(value: unknown): value is ConversationMessageAttachment {
  return isConversationAttachment(value) || isConversationAttachmentMetadata(value);
}

export function isConversationAttachmentMetadata(value: unknown): value is ConversationAttachmentMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as Partial<ConversationAttachmentMetadata>;

  if (
    maybe.type !== undefined &&
    maybe.type !== "image" &&
    maybe.type !== "text" &&
    maybe.type !== "binary"
  ) {
    return false;
  }

  if (typeof maybe.mimeType !== "string" || maybe.mimeType.trim().length === 0) {
    return false;
  }

  if (maybe.fileName !== undefined && typeof maybe.fileName !== "string") {
    return false;
  }

  if (maybe.filePath !== undefined && typeof maybe.filePath !== "string") {
    return false;
  }

  if (
    maybe.sizeBytes !== undefined &&
    (typeof maybe.sizeBytes !== "number" || !Number.isFinite(maybe.sizeBytes) || maybe.sizeBytes < 0)
  ) {
    return false;
  }

  return true;
}

export function isConversationImageAttachment(value: unknown): value is ConversationImageAttachment {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as Partial<ConversationImageAttachment> & { type?: unknown };
  if (maybe.type !== undefined && maybe.type !== "image") {
    return false;
  }

  if (typeof maybe.mimeType !== "string" || !maybe.mimeType.startsWith("image/")) {
    return false;
  }

  if (typeof maybe.data !== "string" || maybe.data.length === 0) {
    return false;
  }

  if (maybe.fileName !== undefined && typeof maybe.fileName !== "string") {
    return false;
  }

  if (maybe.filePath !== undefined && typeof maybe.filePath !== "string") {
    return false;
  }

  return true;
}

export function isConversationTextAttachment(value: unknown): value is ConversationTextAttachment {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as Partial<ConversationTextAttachment>;
  if (maybe.type !== "text") {
    return false;
  }

  if (typeof maybe.mimeType !== "string" || maybe.mimeType.trim().length === 0) {
    return false;
  }

  if (typeof maybe.text !== "string" || maybe.text.trim().length === 0) {
    return false;
  }

  if (maybe.fileName !== undefined && typeof maybe.fileName !== "string") {
    return false;
  }

  if (maybe.filePath !== undefined && typeof maybe.filePath !== "string") {
    return false;
  }

  return true;
}

export function isConversationBinaryAttachment(value: unknown): value is ConversationBinaryAttachment {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as Partial<ConversationBinaryAttachment>;
  if (maybe.type !== "binary") {
    return false;
  }

  if (typeof maybe.mimeType !== "string" || maybe.mimeType.trim().length === 0) {
    return false;
  }

  if (typeof maybe.data !== "string" || maybe.data.trim().length === 0) {
    return false;
  }

  if (maybe.fileName !== undefined && typeof maybe.fileName !== "string") {
    return false;
  }

  if (maybe.filePath !== undefined && typeof maybe.filePath !== "string") {
    return false;
  }

  return true;
}

export function isConversationLogEvent(value: unknown): value is ConversationLogEvent {
  if (!value || typeof value !== "object") return false;

  const maybe = value as Partial<ConversationLogEvent>;
  if (maybe.type !== "conversation_log") return false;
  if (typeof maybe.agentId !== "string" || maybe.agentId.length === 0) return false;
  if (typeof maybe.timestamp !== "string") return false;
  if (maybe.source !== "runtime_log") return false;

  if (
    maybe.kind !== "message_start" &&
    maybe.kind !== "message_end" &&
    maybe.kind !== "tool_execution_start" &&
    maybe.kind !== "tool_execution_update" &&
    maybe.kind !== "tool_execution_end"
  ) {
    return false;
  }

  if (maybe.role !== undefined && maybe.role !== "user" && maybe.role !== "assistant" && maybe.role !== "system") {
    return false;
  }

  if (maybe.toolName !== undefined && typeof maybe.toolName !== "string") return false;
  if (maybe.toolCallId !== undefined && typeof maybe.toolCallId !== "string") return false;
  if (typeof maybe.text !== "string") return false;
  if (maybe.isError !== undefined && typeof maybe.isError !== "boolean") return false;

  return true;
}

export function isAgentMessageEvent(value: unknown): value is AgentMessageEvent {
  if (!value || typeof value !== "object") return false;

  const maybe = value as Partial<AgentMessageEvent>;
  if (maybe.type !== "agent_message") return false;
  if (typeof maybe.agentId !== "string" || maybe.agentId.length === 0) return false;
  if (typeof maybe.timestamp !== "string") return false;
  if (maybe.source !== "user_to_agent" && maybe.source !== "agent_to_agent") return false;
  if (maybe.fromAgentId !== undefined && typeof maybe.fromAgentId !== "string") return false;
  if (typeof maybe.toAgentId !== "string" || maybe.toAgentId.length === 0) return false;
  if (typeof maybe.text !== "string") return false;
  if (maybe.sourceContext !== undefined && !isMessageSourceContext(maybe.sourceContext)) return false;
  if (
    maybe.requestedDelivery !== undefined &&
    maybe.requestedDelivery !== "auto" &&
    maybe.requestedDelivery !== "followUp" &&
    maybe.requestedDelivery !== "steer"
  ) {
    return false;
  }
  if (
    maybe.acceptedMode !== undefined &&
    maybe.acceptedMode !== "prompt" &&
    maybe.acceptedMode !== "followUp" &&
    maybe.acceptedMode !== "steer"
  ) {
    return false;
  }
  if (
    maybe.attachmentCount !== undefined &&
    (typeof maybe.attachmentCount !== "number" ||
      !Number.isFinite(maybe.attachmentCount) ||
      maybe.attachmentCount < 0)
  ) {
    return false;
  }

  return true;
}

export function isAgentToolCallEvent(value: unknown): value is AgentToolCallEvent {
  if (!value || typeof value !== "object") return false;

  const maybe = value as Partial<AgentToolCallEvent>;
  if (maybe.type !== "agent_tool_call") return false;
  if (typeof maybe.agentId !== "string" || maybe.agentId.length === 0) return false;
  if (typeof maybe.actorAgentId !== "string" || maybe.actorAgentId.length === 0) return false;
  if (typeof maybe.timestamp !== "string") return false;
  if (
    maybe.kind !== "tool_execution_start" &&
    maybe.kind !== "tool_execution_update" &&
    maybe.kind !== "tool_execution_end"
  ) {
    return false;
  }
  if (maybe.toolName !== undefined && typeof maybe.toolName !== "string") return false;
  if (maybe.toolCallId !== undefined && typeof maybe.toolCallId !== "string") return false;
  if (typeof maybe.text !== "string") return false;
  if (maybe.isError !== undefined && typeof maybe.isError !== "boolean") return false;

  return true;
}
