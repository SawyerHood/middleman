import { inferModelPreset } from "./model-preset";
import type { AgentStatusEntry } from "./ws-state";
import type {
  AgentContextUsage,
  AgentDescriptor,
  ConversationEntry,
  ConversationMessageAttachment,
  ConversationTextAttachment,
} from "@middleman/protocol";

const CHARS_PER_TOKEN_ESTIMATE = 4;
const CONTEXT_WINDOW_BY_PRESET = {
  "pi-opus": 200_000,
  "pi-codex": 1_048_576,
  "codex-app": 1_048_576,
  "claude-code": 200_000,
} as const;

const TELEMETRY_BACKED_PRESETS = new Set<keyof typeof CONTEXT_WINDOW_BY_PRESET>(
  ["pi-opus", "pi-codex", "codex-app", "claude-code"],
);

function contextWindowForAgent(agent: AgentDescriptor | null): number | null {
  if (!agent) {
    return null;
  }

  const modelPreset = inferModelPreset(agent);
  return modelPreset ? CONTEXT_WINDOW_BY_PRESET[modelPreset] : null;
}

function shouldUseHeuristicFallback(agent: AgentDescriptor | null): boolean {
  if (!agent) {
    return false;
  }

  const modelPreset = inferModelPreset(agent);
  return modelPreset ? !TELEMETRY_BACKED_PRESETS.has(modelPreset) : true;
}

function isTextAttachmentWithContent(
  attachment: ConversationMessageAttachment,
): attachment is ConversationTextAttachment {
  return (
    attachment.type === "text" &&
    "text" in attachment &&
    typeof attachment.text === "string"
  );
}

function estimateUsedTokens(messages: ConversationEntry[]): number {
  let totalChars = 0;

  for (const entry of messages) {
    if (entry.type !== "conversation_message") {
      continue;
    }

    totalChars += entry.text.length;

    for (const attachment of entry.attachments ?? []) {
      if (isTextAttachmentWithContent(attachment)) {
        totalChars += attachment.text.length;
      }
    }
  }

  return Math.ceil(totalChars / CHARS_PER_TOKEN_ESTIMATE);
}

export interface ContextWindowInput {
  activeAgent: AgentDescriptor | null;
  activeAgentId: string | null;
  messages: ConversationEntry[];
  statuses: Record<string, AgentStatusEntry>;
}

export function deriveContextWindowUsage({
  activeAgent,
  activeAgentId,
  messages,
  statuses,
}: ContextWindowInput): {
  usedTokens: number;
  contextWindow: number;
} | null {
  const realContextUsage: AgentContextUsage | null = activeAgentId
    ? (statuses[activeAgentId]?.contextUsage ?? activeAgent?.contextUsage ?? null)
    : (activeAgent?.contextUsage ?? null);

  if (realContextUsage) {
    return realContextUsage.contextWindow > 0
      ? {
          usedTokens: realContextUsage.tokens,
          contextWindow: realContextUsage.contextWindow,
        }
      : null;
  }

  const fallbackContextWindow = contextWindowForAgent(activeAgent);
  const allowHeuristicFallback = shouldUseHeuristicFallback(activeAgent);

  if (!allowHeuristicFallback || !fallbackContextWindow) {
    return null;
  }

  return {
    usedTokens: estimateUsedTokens(messages),
    contextWindow: fallbackContextWindow,
  };
}
