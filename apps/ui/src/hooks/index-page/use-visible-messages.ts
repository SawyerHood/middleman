import { useMemo } from "react";
import { isManagerInvolvedAgentMessage } from "@/lib/agent-message-utils";
import { compareConversationEntries } from "@/lib/conversation-history";
import type { AgentDescriptor, ConversationEntry } from "@middleman/protocol";

function mergeConversationAndActivityMessages(
  messages: ConversationEntry[],
  activityMessages: ConversationEntry[],
): ConversationEntry[] {
  if (activityMessages.length === 0) {
    return messages;
  }

  if (messages.length === 0) {
    return activityMessages;
  }

  const merged: ConversationEntry[] = [];
  let conversationIndex = 0;
  let activityIndex = 0;

  while (
    conversationIndex < messages.length &&
    activityIndex < activityMessages.length
  ) {
    const conversationMessage = messages[conversationIndex];
    const activityMessage = activityMessages[activityIndex];

    if (compareConversationEntries(conversationMessage, activityMessage) <= 0) {
      merged.push(conversationMessage);
      conversationIndex += 1;
      continue;
    }

    merged.push(activityMessage);
    activityIndex += 1;
  }

  if (conversationIndex < messages.length) {
    merged.push(...messages.slice(conversationIndex));
  }

  if (activityIndex < activityMessages.length) {
    merged.push(...activityMessages.slice(activityIndex));
  }

  return merged;
}

function buildManagerScopedAgentIds(
  agents: AgentDescriptor[],
  managerId: string,
): Set<string> {
  const scopedAgentIds = new Set<string>([managerId]);

  for (const agent of agents) {
    if (agent.agentId === managerId || agent.managerId === managerId) {
      scopedAgentIds.add(agent.agentId);
    }
  }

  return scopedAgentIds;
}

function isUserTranscriptEntry(entry: ConversationEntry): boolean {
  if (entry.type === "conversation_log") {
    return entry.isError === true;
  }

  if (entry.type !== "conversation_message") {
    return false;
  }

  return entry.source === "user_input" || entry.source === "speak_to_user";
}

function isManagerScopedTranscriptEntry(
  entry: ConversationEntry,
  scopedAgentIds: ReadonlySet<string>,
): boolean {
  return isUserTranscriptEntry(entry) && scopedAgentIds.has(entry.agentId);
}

interface UseVisibleMessagesOptions {
  messages: ConversationEntry[];
  activityMessages: ConversationEntry[];
  agents: AgentDescriptor[];
  activeAgent: AgentDescriptor | null;
  showInternalChatter?: boolean;
}

export function deriveVisibleMessages({
  messages,
  activityMessages,
  agents,
  activeAgent,
  showInternalChatter = true,
}: UseVisibleMessagesOptions): {
  allMessages: ConversationEntry[];
  visibleMessages: ConversationEntry[];
} {
  const activeAgentRole = activeAgent?.role;
  const activeAgentId = activeAgent?.agentId;
  const managerScopedAgentIds =
    activeAgentRole === "manager" && activeAgentId
      ? buildManagerScopedAgentIds(agents, activeAgentId)
      : null;
  const managerScopedActivityMessages =
    activeAgentRole === "manager" && activeAgentId && showInternalChatter
      ? activityMessages.filter(
          (
            entry,
          ): entry is Extract<ConversationEntry, { type: "agent_message" }> =>
            entry.type === "agent_message" &&
            isManagerInvolvedAgentMessage(entry, activeAgentId),
        )
      : [];

  const allMessages =
    activeAgentRole === "worker"
      ? mergeConversationAndActivityMessages(messages, activityMessages)
      : messages;

  const visibleMessages =
    activeAgentRole === "manager" && managerScopedAgentIds
      ? mergeConversationAndActivityMessages(
          messages.filter((entry) =>
            isManagerScopedTranscriptEntry(entry, managerScopedAgentIds),
          ),
          managerScopedActivityMessages,
        )
      : activeAgentRole === "worker"
        ? showInternalChatter
          ? allMessages
          : messages
        : messages.filter((entry) => {
            if (entry.type !== "conversation_message") {
              return true;
            }

            return (entry.sourceContext?.channel ?? "web") === "web";
          });

  return {
    allMessages,
    visibleMessages,
  };
}

export function useVisibleMessages({
  messages,
  activityMessages,
  agents,
  activeAgent,
  showInternalChatter = true,
}: UseVisibleMessagesOptions): {
  allMessages: ConversationEntry[];
  visibleMessages: ConversationEntry[];
} {
  return useMemo(
    () =>
      deriveVisibleMessages({
        messages,
        activityMessages,
        agents,
        activeAgent,
        showInternalChatter,
      }),
    [activeAgent, activityMessages, agents, messages, showInternalChatter],
  );
}
