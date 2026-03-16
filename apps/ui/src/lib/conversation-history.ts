import type { ConversationEntry } from "@middleman/protocol";

export function getConversationEntryCursor(entry: ConversationEntry): string {
  return entry.historyCursor ?? entry.timestamp;
}

export function compareConversationEntries(
  left: ConversationEntry,
  right: ConversationEntry,
): number {
  return getConversationEntryCursor(left).localeCompare(
    getConversationEntryCursor(right),
  );
}

export function getConversationEntryStableId(entry: ConversationEntry): string {
  if (entry.historyCursor) {
    return `${entry.type}:${entry.historyCursor}`;
  }

  switch (entry.type) {
    case "conversation_message":
      return `${entry.type}:${entry.agentId}:${entry.role}:${entry.timestamp}:${entry.source}:${entry.text}`;

    case "conversation_log":
      return `${entry.type}:${entry.agentId}:${entry.kind}:${entry.timestamp}:${entry.toolCallId ?? ""}:${entry.text}`;

    case "agent_message":
      return `${entry.type}:${entry.agentId}:${entry.timestamp}:${entry.fromAgentId ?? ""}:${entry.toAgentId}:${entry.text}`;

    case "agent_tool_call":
      return `${entry.type}:${entry.agentId}:${entry.actorAgentId}:${entry.kind}:${entry.timestamp}:${entry.toolCallId ?? ""}:${entry.text}`;
  }
}
