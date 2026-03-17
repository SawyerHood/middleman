import { atom } from "jotai";
import type { Store } from "jotai/vanilla/store";
import { atomFamily } from "jotai/utils";
import { buildManagerTreeRows, chooseFallbackAgentId } from "./agent-hierarchy";
import { isActiveAgentStatus, isWorkingAgentStatus } from "./agent-status";
import { collectArtifactsFromMessages } from "./collect-artifacts";
import { deriveContextWindowUsage } from "./context-window";
import { deriveVisibleMessages } from "./visible-messages";
import { showInternalChatterAtom } from "./chat-view-preferences";
import type { ArtifactReference } from "./artifacts";
import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentStatus,
  ConversationEntry,
} from "@middleman/protocol";

export type ConversationHistoryEntry = Extract<
  ConversationEntry,
  { type: "conversation_message" | "conversation_log" }
>;
export type AgentActivityEntry = Extract<
  ConversationEntry,
  { type: "agent_message" | "agent_tool_call" }
>;

export interface AgentStatusEntry {
  status: AgentStatus;
  pendingCount: number;
  contextUsage?: AgentContextUsage;
}

export interface PendingResponseStart {
  agentId: string;
  messageCount: number;
}

export interface ManagerWsState {
  connected: boolean;
  hasReceivedAgentsSnapshot: boolean;
  targetAgentId: string | null;
  subscribedAgentId: string | null;
  messages: ConversationHistoryEntry[];
  activityMessages: AgentActivityEntry[];
  oldestHistoryCursor: string | null;
  hasOlderHistory: boolean;
  isLoadingOlderHistory: boolean;
  isLoadingHistory: boolean;
  agents: AgentDescriptor[];
  managerOrder: string[];
  statuses: Record<string, AgentStatusEntry>;
  lastError: string | null;
}

export function createInitialManagerWsState(
  targetAgentId: string | null,
): ManagerWsState {
  return {
    connected: false,
    hasReceivedAgentsSnapshot: false,
    targetAgentId,
    subscribedAgentId: null,
    messages: [],
    activityMessages: [],
    oldestHistoryCursor: null,
    hasOlderHistory: false,
    isLoadingOlderHistory: false,
    isLoadingHistory: false,
    agents: [],
    managerOrder: [],
    statuses: {},
    lastError: null,
  };
}

export const connectedAtom = atom(false);
export const hasReceivedAgentsSnapshotAtom = atom(false);
export const targetAgentIdAtom = atom<string | null>(null);
export const subscribedAgentIdAtom = atom<string | null>(null);
export const messagesAtom = atom<ConversationHistoryEntry[]>([]);
export const activityMessagesAtom = atom<AgentActivityEntry[]>([]);
export const oldestHistoryCursorAtom = atom<string | null>(null);
export const hasOlderHistoryAtom = atom(false);
export const isLoadingOlderHistoryAtom = atom(false);
export const isLoadingHistoryAtom = atom(false);
export const agentsAtom = atom<AgentDescriptor[]>([]);
export const managerOrderAtom = atom<string[]>([]);
export const statusesAtom = atom<Record<string, AgentStatusEntry>>({});
export const lastErrorAtom = atom<string | null>(null);
export const pendingResponseStartAtom = atom<PendingResponseStart | null>(null);

export const managerWsStateSnapshotAtom = atom<ManagerWsState>((get) => ({
  connected: get(connectedAtom),
  hasReceivedAgentsSnapshot: get(hasReceivedAgentsSnapshotAtom),
  targetAgentId: get(targetAgentIdAtom),
  subscribedAgentId: get(subscribedAgentIdAtom),
  messages: get(messagesAtom),
  activityMessages: get(activityMessagesAtom),
  oldestHistoryCursor: get(oldestHistoryCursorAtom),
  hasOlderHistory: get(hasOlderHistoryAtom),
  isLoadingOlderHistory: get(isLoadingOlderHistoryAtom),
  isLoadingHistory: get(isLoadingHistoryAtom),
  agents: get(agentsAtom),
  managerOrder: get(managerOrderAtom),
  statuses: get(statusesAtom),
  lastError: get(lastErrorAtom),
}));

type ManagerWsStateKey = keyof ManagerWsState;

function applyManagerWsStatePatch(
  get: Store["get"],
  set: Store["set"],
  patch: Partial<ManagerWsState>,
): void {
  if (
    "connected" in patch &&
    !Object.is(get(connectedAtom), patch.connected)
  ) {
    set(connectedAtom, patch.connected as boolean);
  }

  if (
    "hasReceivedAgentsSnapshot" in patch &&
    !Object.is(
      get(hasReceivedAgentsSnapshotAtom),
      patch.hasReceivedAgentsSnapshot,
    )
  ) {
    set(
      hasReceivedAgentsSnapshotAtom,
      patch.hasReceivedAgentsSnapshot as boolean,
    );
  }

  if (
    "targetAgentId" in patch &&
    !Object.is(get(targetAgentIdAtom), patch.targetAgentId)
  ) {
    set(targetAgentIdAtom, patch.targetAgentId as string | null);
  }

  if (
    "subscribedAgentId" in patch &&
    !Object.is(get(subscribedAgentIdAtom), patch.subscribedAgentId)
  ) {
    set(subscribedAgentIdAtom, patch.subscribedAgentId as string | null);
  }

  if ("messages" in patch && !Object.is(get(messagesAtom), patch.messages)) {
    set(messagesAtom, patch.messages as ConversationHistoryEntry[]);
  }

  if (
    "activityMessages" in patch &&
    !Object.is(get(activityMessagesAtom), patch.activityMessages)
  ) {
    set(activityMessagesAtom, patch.activityMessages as AgentActivityEntry[]);
  }

  if (
    "oldestHistoryCursor" in patch &&
    !Object.is(get(oldestHistoryCursorAtom), patch.oldestHistoryCursor)
  ) {
    set(oldestHistoryCursorAtom, patch.oldestHistoryCursor as string | null);
  }

  if (
    "hasOlderHistory" in patch &&
    !Object.is(get(hasOlderHistoryAtom), patch.hasOlderHistory)
  ) {
    set(hasOlderHistoryAtom, patch.hasOlderHistory as boolean);
  }

  if (
    "isLoadingOlderHistory" in patch &&
    !Object.is(get(isLoadingOlderHistoryAtom), patch.isLoadingOlderHistory)
  ) {
    set(isLoadingOlderHistoryAtom, patch.isLoadingOlderHistory as boolean);
  }

  if (
    "isLoadingHistory" in patch &&
    !Object.is(get(isLoadingHistoryAtom), patch.isLoadingHistory)
  ) {
    set(isLoadingHistoryAtom, patch.isLoadingHistory as boolean);
  }

  if ("agents" in patch && !Object.is(get(agentsAtom), patch.agents)) {
    set(agentsAtom, patch.agents as AgentDescriptor[]);
  }

  if (
    "managerOrder" in patch &&
    !Object.is(get(managerOrderAtom), patch.managerOrder)
  ) {
    set(managerOrderAtom, patch.managerOrder as string[]);
  }

  if ("statuses" in patch && !Object.is(get(statusesAtom), patch.statuses)) {
    set(statusesAtom, patch.statuses as Record<string, AgentStatusEntry>);
  }

  if ("lastError" in patch && !Object.is(get(lastErrorAtom), patch.lastError)) {
    set(lastErrorAtom, patch.lastError as string | null);
  }
}

export const applyManagerWsStatePatchAtom = atom(
  null,
  (get, set, patch: Partial<ManagerWsState>) => {
    applyManagerWsStatePatch(get, set, patch);
  },
);

export const replaceManagerWsStateAtom = atom(
  null,
  (get, set, nextState: ManagerWsState) => {
    applyManagerWsStatePatch(get, set, nextState);
  },
);

export function getManagerWsState(store: Store): ManagerWsState {
  return store.get(managerWsStateSnapshotAtom);
}

export function applyManagerWsStatePatchToStore(
  store: Store,
  patch: Partial<ManagerWsState>,
): void {
  store.set(applyManagerWsStatePatchAtom, patch);
}

export function replaceManagerWsStateInStore(
  store: Store,
  nextState: ManagerWsState,
): void {
  store.set(replaceManagerWsStateAtom, nextState);
}

export const activeAgentIdAtom = atom((get) => {
  return (
    get(targetAgentIdAtom) ??
    get(subscribedAgentIdAtom) ??
    chooseFallbackAgentId(get(agentsAtom), get(managerOrderAtom))
  );
});

export const agentByIdAtomFamily = atomFamily((agentId: string) =>
  atom((get) => get(agentsAtom).find((agent) => agent.agentId === agentId) ?? null),
);

export const statusEntryAtomFamily = atomFamily((agentId: string) =>
  atom((get) => get(statusesAtom)[agentId] ?? null),
);

export const activeAgentAtom = atom((get) => {
  const activeAgentId = get(activeAgentIdAtom);
  if (!activeAgentId) {
    return null;
  }

  return get(agentByIdAtomFamily(activeAgentId));
});

export const activeAgentRoleAtom = atom((get) => get(activeAgentAtom)?.role ?? null);

export const activeAgentLabelAtom = atom(
  (get) =>
    get(activeAgentAtom)?.displayName ??
    get(activeAgentIdAtom) ??
    "No active agent",
);

export const activeAgentArchetypeIdAtom = atom(
  (get) => get(activeAgentAtom)?.archetypeId ?? null,
);

export const activeAgentStatusAtom = atom((get) => {
  const activeAgentId = get(activeAgentIdAtom);
  if (!activeAgentId) {
    return null;
  }

  return (
    get(statusEntryAtomFamily(activeAgentId))?.status ??
    get(activeAgentAtom)?.status ??
    null
  );
});

export const activeManagerIdAtom = atom((get) => {
  const activeAgent = get(activeAgentAtom);
  if (activeAgent?.role === "manager") {
    return activeAgent.agentId;
  }

  if (activeAgent?.managerId) {
    return activeAgent.managerId;
  }

  return (
    get(agentsAtom).find((agent) => agent.role === "manager")?.agentId ?? null
  );
});

export const isActiveManagerAtom = atom(
  (get) => get(activeAgentRoleAtom) === "manager",
);

export const isWorkerDetailViewAtom = atom(
  (get) => get(activeAgentRoleAtom) === "worker",
);

const visibleMessageStateAtom = atom((get) =>
  deriveVisibleMessages({
    messages: get(messagesAtom),
    activityMessages: get(activityMessagesAtom),
    agents: get(agentsAtom),
    activeAgent: get(activeAgentAtom),
    showInternalChatter: get(showInternalChatterAtom),
  }),
);

export const allMessagesAtom = atom((get) => get(visibleMessageStateAtom).allMessages);
export const visibleMessagesAtom = atom(
  (get) => get(visibleMessageStateAtom).visibleMessages,
);

export const contextUsageByAgentIdAtomFamily = atomFamily((agentId: string) =>
  atom((get) => {
    return (
      get(statusEntryAtomFamily(agentId))?.contextUsage ??
      get(agentByIdAtomFamily(agentId))?.contextUsage ??
      null
    );
  }),
);

export const contextWindowAtom = atom((get) =>
  deriveContextWindowUsage({
    activeAgent: get(activeAgentAtom),
    activeAgentId: get(activeAgentIdAtom),
    messages: get(messagesAtom),
    statuses: get(statusesAtom),
  }),
);

function isAssistantResponseSignal(entry: ConversationEntry): boolean {
  if (entry.type === "conversation_message") {
    return entry.role === "assistant" || entry.role === "system";
  }

  if (entry.type === "conversation_log") {
    return (
      entry.role === "assistant" &&
      (entry.kind === "message_start" || entry.kind === "message_end")
    );
  }

  return false;
}

export const pendingResponseAtom = atom((get) => {
  const pendingResponseStart = get(pendingResponseStartAtom);
  if (!pendingResponseStart) {
    return null;
  }

  const activeAgentId = get(activeAgentIdAtom);
  if (!activeAgentId || pendingResponseStart.agentId !== activeAgentId) {
    return null;
  }

  const activeAgentStatus = get(activeAgentStatusAtom);
  if (activeAgentStatus && isWorkingAgentStatus(activeAgentStatus)) {
    return null;
  }

  const messages = get(messagesAtom);
  if (messages.length < pendingResponseStart.messageCount) {
    return null;
  }

  const hasAssistantResponse = messages
    .slice(pendingResponseStart.messageCount)
    .some(isAssistantResponseSignal);

  return hasAssistantResponse ? null : pendingResponseStart;
});

export const isAwaitingResponseStartAtom = atom(
  (get) => get(pendingResponseAtom) !== null,
);

export const markPendingResponseAtom = atom(
  null,
  (get, set, agentId?: string) => {
    const nextAgentId = agentId ?? get(activeAgentIdAtom);
    if (!nextAgentId) {
      return;
    }

    set(pendingResponseStartAtom, {
      agentId: nextAgentId,
      messageCount: get(messagesAtom).length,
    });
  },
);

export const clearPendingResponseForAgentAtom = atom(
  null,
  (get, set, agentId: string) => {
    const pendingResponse = get(pendingResponseStartAtom);
    if (pendingResponse?.agentId !== agentId) {
      return;
    }

    set(pendingResponseStartAtom, null);
  },
);

export const resetPendingResponseAtom = atom(null, (_get, set) => {
  set(pendingResponseStartAtom, null);
});

export const isLoadingAtom = atom((get) => {
  const activeAgentStatus = get(activeAgentStatusAtom);
  return (
    (activeAgentStatus ? isWorkingAgentStatus(activeAgentStatus) : false) ||
    get(isAwaitingResponseStartAtom)
  );
});

export const canStopAllAgentsAtom = atom((get) => {
  const activeAgentStatus = get(activeAgentStatusAtom);
  return (
    get(isActiveManagerAtom) &&
    (activeAgentStatus ? isActiveAgentStatus(activeAgentStatus) : false)
  );
});

export const managerTreeAtom = atom((get) =>
  buildManagerTreeRows(get(agentsAtom), get(managerOrderAtom)),
);

export const managerRowsAtom = atom((get) => get(managerTreeAtom).managerRows);
export const orphanWorkersAtom = atom((get) => get(managerTreeAtom).orphanWorkers);

export const activeWorkerCountByManagerAtomFamily = atomFamily(
  (managerId: string) =>
    atom((get) => {
      let count = 0;
      for (const agent of get(agentsAtom)) {
        if (agent.role !== "worker" || agent.managerId !== managerId) {
          continue;
        }

        const status =
          get(statusEntryAtomFamily(agent.agentId))?.status ?? agent.status;
        if (isWorkingAgentStatus(status)) {
          count += 1;
        }
      }

      return count;
    }),
);

export const artifactsAtom = atom<ArtifactReference[]>((get) =>
  collectArtifactsFromMessages(get(allMessagesAtom)),
);

export const statusBannerTextAtom = atom((get) => get(lastErrorAtom));

export const managerWsStateAtomKeys = [
  "connected",
  "hasReceivedAgentsSnapshot",
  "targetAgentId",
  "subscribedAgentId",
  "messages",
  "activityMessages",
  "oldestHistoryCursor",
  "hasOlderHistory",
  "isLoadingOlderHistory",
  "isLoadingHistory",
  "agents",
  "managerOrder",
  "statuses",
  "lastError",
] as const satisfies ReadonlyArray<ManagerWsStateKey>;
