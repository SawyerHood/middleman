import { chooseFallbackAgentId } from "./agent-hierarchy";
import {
  compareConversationEntries,
  getConversationEntryCursor,
  getConversationEntryStableId,
} from "./conversation-history";
import {
  normalizeManagerOrder,
  reorderAgentsByManagerOrder,
} from "./manager-order";
import { WsRequestTracker } from "./ws-request-tracker";
import {
  createInitialManagerWsState,
  type AgentActivityEntry,
  type ConversationHistoryEntry,
  type ManagerWsState,
} from "./ws-state";
import {
  MANAGER_MODEL_PRESETS,
  type AgentContextUsage,
  type AgentDescriptor,
  type ClientCommand,
  type ConversationAttachment,
  type ConversationEntry,
  type ConversationMessageEvent,
  type DeliveryMode,
  type ManagerModelPreset,
  type ServerEvent,
} from "@middleman/protocol";

export type { ManagerWsState } from "./ws-state";

const INITIAL_CONNECT_DELAY_MS = 50;
const RECONNECT_MS = 1200;
const REQUEST_TIMEOUT_MS = 300_000;
const FRONTEND_BUILD_HASH =
  typeof import.meta.env.VITE_BUILD_HASH === "string" &&
  import.meta.env.VITE_BUILD_HASH.trim().length > 0
    ? import.meta.env.VITE_BUILD_HASH.trim()
    : "dev";

export const WS_CLIENT_BUILD_HASH = FRONTEND_BUILD_HASH;

export interface DirectoriesListedResult {
  path: string;
  directories: string[];
}

export interface DirectoryValidationResult {
  path: string;
  valid: boolean;
  message: string | null;
}

type Listener = (state: ManagerWsState) => void;

type WsRequestResultMap = {
  create_manager: AgentDescriptor;
  delete_manager: { managerId: string };
  reorder_managers: string[];
  stop_all_agents: {
    managerId: string;
    stoppedWorkerIds: string[];
    managerStopped: boolean;
  };
  list_directories: DirectoriesListedResult;
  validate_directory: DirectoryValidationResult;
  pick_directory: string | null;
};

type WsRequestType = Extract<keyof WsRequestResultMap, string>;
const WS_REQUEST_TYPES: WsRequestType[] = [
  "create_manager",
  "delete_manager",
  "reorder_managers",
  "stop_all_agents",
  "list_directories",
  "validate_directory",
  "pick_directory",
];

const WS_REQUEST_ERROR_HINTS: Array<{
  requestType: WsRequestType;
  codeFragment: string;
}> = [
  { requestType: "create_manager", codeFragment: "create_manager" },
  { requestType: "delete_manager", codeFragment: "delete_manager" },
  { requestType: "reorder_managers", codeFragment: "reorder_managers" },
  { requestType: "stop_all_agents", codeFragment: "stop_all_agents" },
  { requestType: "list_directories", codeFragment: "list_directories" },
  { requestType: "validate_directory", codeFragment: "validate_directory" },
  { requestType: "pick_directory", codeFragment: "pick_directory" },
];

export class ManagerWsClient {
  private readonly url: string;
  private desiredAgentId: string | null;
  private desiredDetailAgentId: string | null = null;

  private socket: WebSocket | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private destroyed = false;
  private hasConnectedOnce = false;
  private shouldReloadOnReconnect = false;

  private state: ManagerWsState;
  private readonly listeners = new Set<Listener>();
  private pendingServerEvents: ServerEvent[] = [];
  private pendingServerEventFlushFrame: number | null = null;
  private stateNotificationBatchDepth = 0;
  private hasPendingStateNotification = false;

  private requestCounter = 0;
  private readonly requestTracker = new WsRequestTracker<WsRequestResultMap>(
    WS_REQUEST_TYPES,
    REQUEST_TIMEOUT_MS,
  );

  constructor(url: string, initialAgentId?: string | null) {
    const normalizedInitialAgentId = normalizeAgentId(initialAgentId);
    this.url = url;
    this.desiredAgentId = normalizedInitialAgentId;
    this.state = createInitialManagerWsState(normalizedInitialAgentId);
  }

  getState(): ManagerWsState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);

    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): void {
    if (this.started || this.destroyed || typeof window === "undefined") {
      return;
    }

    this.started = true;
    this.scheduleConnect(INITIAL_CONNECT_DELAY_MS);
  }

  destroy(): void {
    this.destroyed = true;
    this.started = false;
    this.clearBufferedServerEvents();

    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
    }

    this.rejectAllPendingRequests("Client destroyed before request completed.");

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  subscribeToAgent(agentId: string): void {
    const trimmed = agentId.trim();
    if (!trimmed) return;

    this.flushBufferedServerEvents();
    this.desiredAgentId = trimmed;
    this.updateState({
      targetAgentId: trimmed,
      messages: [],
      activityMessages: [],
      oldestHistoryCursor: null,
      hasOlderHistory: false,
      isLoadingOlderHistory: false,
      isLoadingHistory: true,
      lastError: null,
    });

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.send({
      type: "subscribe",
      agentId: trimmed,
    });
  }

  subscribeToAgentDetail(agentId: string): void {
    const trimmed = agentId.trim();
    if (!trimmed) {
      return;
    }

    if (this.desiredDetailAgentId === trimmed) {
      return;
    }

    const previousDetailAgentId = this.desiredDetailAgentId;
    this.desiredDetailAgentId = trimmed;

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    if (previousDetailAgentId && previousDetailAgentId !== trimmed) {
      this.send({
        type: "unsubscribe_agent_detail",
        agentId: previousDetailAgentId,
      });
    }

    this.send({
      type: "subscribe_agent_detail",
      agentId: trimmed,
    });
  }

  unsubscribeFromAgentDetail(agentId?: string): void {
    const normalizedAgentId =
      normalizeAgentId(agentId) ?? this.desiredDetailAgentId;
    if (!normalizedAgentId) {
      return;
    }

    if (this.desiredDetailAgentId === normalizedAgentId) {
      this.desiredDetailAgentId = null;
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.send({
      type: "unsubscribe_agent_detail",
      agentId: normalizedAgentId,
    });
  }

  loadOlderHistory(agentId?: string): void {
    const targetAgentId =
      normalizeAgentId(agentId) ??
      this.state.targetAgentId ??
      this.state.subscribedAgentId ??
      this.desiredAgentId;

    if (
      !targetAgentId ||
      !this.state.hasOlderHistory ||
      this.state.isLoadingOlderHistory
    ) {
      return;
    }

    const before = this.state.oldestHistoryCursor;
    if (!before) {
      return;
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.updateState({
        lastError: "WebSocket is disconnected. Reconnecting...",
      });
      return;
    }

    const sent = this.send({
      type: "load_older_history",
      agentId: targetAgentId,
      before,
    });

    if (!sent) {
      this.updateState({
        lastError: "WebSocket is disconnected. Reconnecting...",
      });
      return;
    }

    this.updateState({
      isLoadingOlderHistory: true,
    });
  }

  sendUserMessage(
    text: string,
    options?: {
      agentId?: string;
      delivery?: DeliveryMode;
      attachments?: ConversationAttachment[];
    },
  ): void {
    const trimmed = text.trim();
    const attachments = normalizeConversationAttachments(options?.attachments);
    if (!trimmed && attachments.length === 0) return;

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.updateState({
        lastError: "WebSocket is disconnected. Reconnecting...",
      });
      return;
    }

    const agentId =
      options?.agentId ??
      this.state.targetAgentId ??
      this.state.subscribedAgentId ??
      this.desiredAgentId;

    if (!agentId) {
      this.updateState({
        lastError:
          "No active agent selected. Create a manager or select an active thread.",
      });
      return;
    }

    if (
      !options?.agentId &&
      !this.state.targetAgentId &&
      !this.state.subscribedAgentId &&
      this.state.agents.length === 0
    ) {
      this.updateState({
        lastError:
          "No active agent selected. Create a manager or select an active thread.",
      });
      return;
    }

    if (
      this.state.agents.length > 0 &&
      !this.state.agents.some((agent) => agent.agentId === agentId)
    ) {
      this.updateState({
        lastError:
          "No active agent selected. Create a manager or select an active thread.",
      });
      return;
    }

    this.send({
      type: "user_message",
      text: trimmed,
      attachments: attachments.length > 0 ? attachments : undefined,
      agentId,
      delivery: options?.delivery,
    });
  }

  deleteAgent(agentId: string): void {
    const trimmed = agentId.trim();
    if (!trimmed) return;

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.updateState({
        lastError: "WebSocket is disconnected. Reconnecting...",
      });
      return;
    }

    this.send({
      type: "kill_agent",
      agentId: trimmed,
    });
  }

  async stopAllAgents(
    managerId: string,
  ): Promise<{
    managerId: string;
    stoppedWorkerIds: string[];
    managerStopped: boolean;
  }> {
    const trimmed = managerId.trim();
    if (!trimmed) {
      throw new Error("Manager id is required.");
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is disconnected. Reconnecting...");
    }

    return this.enqueueRequest("stop_all_agents", (requestId) => ({
      type: "stop_all_agents",
      managerId: trimmed,
      requestId,
    }));
  }

  async createManager(input: {
    name: string;
    cwd: string;
    model: ManagerModelPreset;
  }): Promise<AgentDescriptor> {
    const name = input.name.trim();
    const cwd = input.cwd.trim();
    const model = input.model;

    if (!name) {
      throw new Error("Manager name is required.");
    }

    if (!cwd) {
      throw new Error("Manager working directory is required.");
    }

    if (!MANAGER_MODEL_PRESETS.includes(model)) {
      throw new Error("Manager model is required.");
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is disconnected. Reconnecting...");
    }

    return this.enqueueRequest("create_manager", (requestId) => ({
      type: "create_manager",
      name,
      cwd,
      model,
      requestId,
    }));
  }

  async deleteManager(managerId: string): Promise<{ managerId: string }> {
    const trimmed = managerId.trim();
    if (!trimmed) {
      throw new Error("Manager id is required.");
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is disconnected. Reconnecting...");
    }

    return this.enqueueRequest("delete_manager", (requestId) => ({
      type: "delete_manager",
      managerId: trimmed,
      requestId,
    }));
  }

  async reorderManagers(managerIds: string[]): Promise<string[]> {
    const normalizedManagerIds = managerIds
      .map((managerId) => managerId.trim())
      .filter((managerId) => managerId.length > 0);

    if (normalizedManagerIds.length === 0) {
      throw new Error("Manager order is required.");
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is disconnected. Reconnecting...");
    }

    const previousAgents = this.state.agents;
    const previousManagerOrder = this.state.managerOrder;
    this.applyManagerOrderUpdate(normalizedManagerIds);

    try {
      const nextManagerOrder = await this.enqueueRequest(
        "reorder_managers",
        (requestId) => ({
          type: "reorder_managers",
          managerIds: normalizedManagerIds,
          requestId,
        }),
      );

      this.applyManagerOrderUpdate(nextManagerOrder);
      return nextManagerOrder;
    } catch (error) {
      this.updateState({
        agents: previousAgents,
        managerOrder: previousManagerOrder,
      });
      throw error;
    }
  }

  async listDirectories(path?: string): Promise<DirectoriesListedResult> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is disconnected. Reconnecting...");
    }

    return this.enqueueRequest("list_directories", (requestId) => ({
      type: "list_directories",
      path: path?.trim() || undefined,
      requestId,
    }));
  }

  async validateDirectory(path: string): Promise<DirectoryValidationResult> {
    const trimmed = path.trim();
    if (!trimmed) {
      throw new Error("Directory path is required.");
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is disconnected. Reconnecting...");
    }

    return this.enqueueRequest("validate_directory", (requestId) => ({
      type: "validate_directory",
      path: trimmed,
      requestId,
    }));
  }

  async pickDirectory(defaultPath?: string): Promise<string | null> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is disconnected. Reconnecting...");
    }

    return this.enqueueRequest("pick_directory", (requestId) => ({
      type: "pick_directory",
      defaultPath: defaultPath?.trim() || undefined,
      requestId,
    }));
  }

  private connect(): void {
    if (this.destroyed) return;

    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.hasConnectedOnce = true;

      this.updateState({
        connected: true,
        lastError: null,
      });

      this.send({
        type: "subscribe",
        agentId: this.desiredAgentId ?? undefined,
      });

      if (this.desiredDetailAgentId) {
        this.send({
          type: "subscribe_agent_detail",
          agentId: this.desiredDetailAgentId,
        });
      }
    });

    socket.addEventListener("message", (event) => {
      this.handleSocketMessage(event.data);
    });

    socket.addEventListener("close", () => {
      this.flushBufferedServerEvents();

      if (!this.destroyed && this.hasConnectedOnce) {
        this.shouldReloadOnReconnect = true;
      }

      this.updateState({
        connected: false,
        subscribedAgentId: null,
        isLoadingOlderHistory: false,
      });

      this.rejectAllPendingRequests(
        "WebSocket disconnected before request completed.",
      );
      this.scheduleConnect(RECONNECT_MS);
    });

    socket.addEventListener("error", () => {
      this.flushBufferedServerEvents();
      this.updateState({
        connected: false,
        lastError: "WebSocket connection error",
        isLoadingOlderHistory: false,
      });
    });
  }

  private scheduleConnect(delayMs: number): void {
    if (this.destroyed || !this.started || this.connectTimer) {
      return;
    }

    this.connectTimer = setTimeout(() => {
      this.connectTimer = undefined;
      if (!this.destroyed && this.started) {
        this.connect();
      }
    }, delayMs);
  }

  private handleSocketMessage(raw: unknown): void {
    let event: ServerEvent;
    try {
      event = JSON.parse(String(raw)) as ServerEvent;
    } catch {
      this.pushSystemMessage("Received invalid JSON event from backend.");
      return;
    }

    if (event.type === "ready" || event.type === "conversation_history") {
      this.flushBufferedServerEvents();
      this.handleServerEvent(event);
      return;
    }

    this.pendingServerEvents.push(event);
    this.scheduleBufferedServerEventFlush();
  }

  private scheduleBufferedServerEventFlush(): void {
    if (this.pendingServerEventFlushFrame !== null) {
      return;
    }

    const requestAnimationFrame =
      typeof window !== "undefined" &&
      typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame.bind(window)
        : typeof globalThis.requestAnimationFrame === "function"
          ? globalThis.requestAnimationFrame.bind(globalThis)
          : null;

    if (!requestAnimationFrame) {
      this.flushBufferedServerEvents();
      return;
    }

    this.pendingServerEventFlushFrame = requestAnimationFrame(() => {
      this.pendingServerEventFlushFrame = null;
      this.flushBufferedServerEvents();
    });
  }

  private flushBufferedServerEvents(): void {
    this.cancelBufferedServerEventFlush();

    if (this.pendingServerEvents.length === 0) {
      return;
    }

    const events = this.pendingServerEvents;
    this.pendingServerEvents = [];

    this.withBatchedStateNotifications(() => {
      for (const event of events) {
        this.handleServerEvent(event);
      }
    });
  }

  private clearBufferedServerEvents(): void {
    this.cancelBufferedServerEventFlush();
    this.pendingServerEvents = [];
  }

  private cancelBufferedServerEventFlush(): void {
    if (this.pendingServerEventFlushFrame === null) {
      return;
    }

    const cancelAnimationFrame =
      typeof window !== "undefined" &&
      typeof window.cancelAnimationFrame === "function"
        ? window.cancelAnimationFrame.bind(window)
        : typeof globalThis.cancelAnimationFrame === "function"
          ? globalThis.cancelAnimationFrame.bind(globalThis)
          : null;

    cancelAnimationFrame?.(this.pendingServerEventFlushFrame);
    this.pendingServerEventFlushFrame = null;
  }

  private handleServerEvent(event: ServerEvent): void {
    switch (event.type) {
      case "ready": {
        const shouldReload =
          this.shouldReloadOnReconnect &&
          event.buildHash !== FRONTEND_BUILD_HASH &&
          typeof window !== "undefined" &&
          typeof window.location?.reload === "function";

        this.shouldReloadOnReconnect = false;

        if (shouldReload) {
          window.location.reload();
          break;
        }

        this.updateState({
          connected: true,
          targetAgentId: event.subscribedAgentId,
          subscribedAgentId: event.subscribedAgentId,
          lastError: null,
        });
        break;
      }

      case "conversation_message":
      case "conversation_log": {
        if (event.agentId !== this.state.targetAgentId) {
          break;
        }

        const messages = [...this.state.messages, event];
        this.updateState({
          messages,
          oldestHistoryCursor:
            this.state.oldestHistoryCursor ??
            resolveOldestHistoryCursor(messages, this.state.activityMessages),
          ...(event.type === "conversation_log" && event.isError
            ? { lastError: event.text }
            : shouldClearLastErrorFromTranscriptEntry(event)
              ? { lastError: null }
              : {}),
        });
        break;
      }

      case "agent_message":
      case "agent_tool_call": {
        if (event.agentId !== this.state.targetAgentId) {
          break;
        }

        const activityMessages = [...this.state.activityMessages, event];
        this.updateState({
          activityMessages,
          oldestHistoryCursor:
            this.state.oldestHistoryCursor ??
            resolveOldestHistoryCursor(this.state.messages, activityMessages),
        });
        break;
      }

      case "conversation_history":
        if (event.agentId !== this.state.targetAgentId) {
          break;
        }

        {
          const {
            messages: incomingMessages,
            activityMessages: incomingActivityMessages,
          } = splitConversationHistory(event.messages);
          const isPrepend = event.mode === "prepend";
          const messages = isPrepend
            ? prependConversationEntries(this.state.messages, incomingMessages)
            : incomingMessages;
          const activityMessages = isPrepend
            ? prependConversationEntries(
                this.state.activityMessages,
                incomingActivityMessages,
              )
            : incomingActivityMessages;
          this.updateState({
            messages,
            activityMessages,
            oldestHistoryCursor: resolveOldestHistoryCursor(
              messages,
              activityMessages,
            ),
            hasOlderHistory: event.hasMore ?? false,
            isLoadingOlderHistory: false,
            isLoadingHistory: isPrepend ? this.state.isLoadingHistory : false,
            lastError: resolveLastErrorFromHistory(messages),
          });
        }
        break;

      case "conversation_reset":
        if (event.agentId !== this.state.targetAgentId) {
          break;
        }

        this.updateState({
          messages: [],
          activityMessages: [],
          oldestHistoryCursor: null,
          hasOlderHistory: false,
          isLoadingOlderHistory: false,
          isLoadingHistory: false,
          lastError: null,
        });
        break;

      case "agent_status": {
        this.applyAgentStatus(event);
        break;
      }

      case "agents_snapshot":
        this.applyAgentsSnapshot(event.agents);
        break;

      case "manager_created": {
        this.applyManagerCreated(event.manager);
        this.requestTracker.resolve(
          "create_manager",
          event.requestId,
          event.manager,
        );
        break;
      }

      case "manager_deleted": {
        this.applyManagerDeleted(event.managerId);
        this.requestTracker.resolve("delete_manager", event.requestId, {
          managerId: event.managerId,
        });
        break;
      }

      case "manager_order_updated": {
        this.applyManagerOrderUpdate(event.managerIds);
        this.requestTracker.resolve(
          "reorder_managers",
          event.requestId,
          event.managerIds,
        );
        break;
      }

      case "stop_all_agents_result": {
        this.requestTracker.resolve("stop_all_agents", event.requestId, {
          managerId: event.managerId,
          stoppedWorkerIds: event.stoppedWorkerIds,
          managerStopped: event.managerStopped,
        });
        break;
      }

      case "directories_listed": {
        this.requestTracker.resolve("list_directories", event.requestId, {
          path: event.path,
          directories: event.directories,
        });
        break;
      }

      case "directory_validated": {
        this.requestTracker.resolve("validate_directory", event.requestId, {
          path: event.path,
          valid: event.valid,
          message: event.message ?? null,
        });
        break;
      }

      case "directory_picked": {
        this.requestTracker.resolve(
          "pick_directory",
          event.requestId,
          event.path ?? null,
        );
        break;
      }

      case "error":
        this.updateState({
          lastError: event.message,
          ...(this.state.isLoadingOlderHistory
            ? { isLoadingOlderHistory: false }
            : {}),
        });
        this.pushSystemMessage(`${event.code}: ${event.message}`);
        this.rejectPendingFromError(event.code, event.message, event.requestId);
        break;
    }
  }

  private applyAgentsSnapshot(agents: AgentDescriptor[]): void {
    const nextManagerOrder = normalizeManagerOrder(
      extractManagerOrder(agents),
      agents,
    );
    const orderedAgents = reorderAgentsByManagerOrder(agents, nextManagerOrder);
    const liveAgentIds = new Set(orderedAgents.map((agent) => agent.agentId));
    if (
      this.desiredDetailAgentId &&
      !liveAgentIds.has(this.desiredDetailAgentId)
    ) {
      this.desiredDetailAgentId = null;
    }

    const statuses = Object.fromEntries(
      orderedAgents.map((agent) => {
        const status = agent.status;
        return [
          agent.agentId,
          {
            status,
            pendingCount:
              this.state.statuses[agent.agentId] &&
              this.state.statuses[agent.agentId]?.status === status
                ? (this.state.statuses[agent.agentId]?.pendingCount ?? 0)
                : 0,
            contextUsage: agent.contextUsage ?? undefined,
          },
        ];
      }),
    );

    const preferredTarget =
      this.state.targetAgentId ??
      this.state.subscribedAgentId ??
      this.desiredAgentId ??
      undefined;
    const fallbackTarget =
      preferredTarget && liveAgentIds.has(preferredTarget)
        ? preferredTarget
        : chooseFallbackAgentId(
            orderedAgents,
            nextManagerOrder,
            preferredTarget,
          );
    const targetChanged = fallbackTarget !== this.state.targetAgentId;
    const nextSubscribedAgentId =
      this.state.subscribedAgentId &&
      liveAgentIds.has(this.state.subscribedAgentId)
        ? this.state.subscribedAgentId
        : (fallbackTarget ?? null);

    const patch: Partial<ManagerWsState> = {
      agents: orderedAgents,
      managerOrder: nextManagerOrder,
      statuses,
      hasReceivedAgentsSnapshot: true,
    };

    if (targetChanged) {
      patch.targetAgentId = fallbackTarget;
      patch.messages = [];
      patch.activityMessages = [];
      patch.oldestHistoryCursor = null;
      patch.hasOlderHistory = false;
      patch.isLoadingOlderHistory = false;
      patch.isLoadingHistory = fallbackTarget !== null;
    }

    if (nextSubscribedAgentId !== this.state.subscribedAgentId) {
      patch.subscribedAgentId = nextSubscribedAgentId;
    }

    this.desiredAgentId = fallbackTarget ?? null;

    this.updateState(patch);

    if (
      targetChanged &&
      fallbackTarget &&
      this.socket?.readyState === WebSocket.OPEN
    ) {
      this.send({
        type: "subscribe",
        agentId: fallbackTarget,
      });
    }
  }

  private applyManagerCreated(manager: AgentDescriptor): void {
    const nextAgents = [
      ...this.state.agents.filter((agent) => agent.agentId !== manager.agentId),
      manager,
    ];
    const nextManagerOrder = normalizeManagerOrder(
      [...this.state.managerOrder, manager.agentId],
      nextAgents,
    );
    this.applyAgentsSnapshot(
      reorderAgentsByManagerOrder(nextAgents, nextManagerOrder),
    );
  }

  private applyManagerDeleted(managerId: string): void {
    const nextAgents = this.state.agents.filter(
      (agent) => agent.agentId !== managerId && agent.managerId !== managerId,
    );
    const nextManagerOrder = this.state.managerOrder.filter(
      (orderedManagerId) => orderedManagerId !== managerId,
    );
    this.applyAgentsSnapshot(
      reorderAgentsByManagerOrder(nextAgents, nextManagerOrder),
    );
  }

  private applyManagerOrderUpdate(managerIds: string[]): void {
    const nextManagerOrder = normalizeManagerOrder(
      managerIds,
      this.state.agents,
    );
    this.updateState({
      managerOrder: nextManagerOrder,
      agents: reorderAgentsByManagerOrder(this.state.agents, nextManagerOrder),
    });
  }

  private pushSystemMessage(text: string): void {
    const message: ConversationMessageEvent = {
      type: "conversation_message",
      agentId:
        (this.state.targetAgentId ??
          this.state.subscribedAgentId ??
          this.desiredAgentId) ||
        "system",
      role: "system",
      text,
      timestamp: new Date().toISOString(),
      source: "system",
    };

    const messages = [...this.state.messages, message];
    this.updateState({ messages });
  }

  private send(command: ClientCommand): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(command));
    return true;
  }

  private applyAgentStatus(
    event: Extract<ServerEvent, { type: "agent_status" }>,
  ): void {
    const patch: Partial<ManagerWsState> = {};
    const hasContextUsage = Object.prototype.hasOwnProperty.call(
      event,
      "contextUsage",
    );

    const previousStatus = this.state.statuses[event.agentId];
    const nextStatusContextUsage = hasContextUsage
      ? (event.contextUsage ?? undefined)
      : previousStatus?.contextUsage;
    const nextStatusEntry = {
      status: event.status,
      pendingCount: event.pendingCount,
      contextUsage: nextStatusContextUsage,
    };

    if (
      !previousStatus ||
      previousStatus.status !== nextStatusEntry.status ||
      previousStatus.pendingCount !== nextStatusEntry.pendingCount ||
      !areAgentContextUsagesEqual(
        previousStatus.contextUsage,
        nextStatusEntry.contextUsage,
      )
    ) {
      patch.statuses = {
        ...this.state.statuses,
        [event.agentId]: nextStatusEntry,
      };
    }

    const agentIndex = this.state.agents.findIndex(
      (agent) => agent.agentId === event.agentId,
    );
    if (agentIndex >= 0) {
      const previousAgent = this.state.agents[agentIndex];
      const nextAgentContextUsage = hasContextUsage
        ? (event.contextUsage ?? undefined)
        : previousAgent.contextUsage;

      if (
        previousAgent.status !== event.status ||
        !areAgentContextUsagesEqual(
          previousAgent.contextUsage,
          nextAgentContextUsage,
        )
      ) {
        const nextAgents = [...this.state.agents];
        nextAgents[agentIndex] = {
          ...previousAgent,
          status: event.status,
          contextUsage: nextAgentContextUsage,
        };
        patch.agents = nextAgents;
      }
    }

    if (
      event.agentId === this.state.targetAgentId &&
      (event.status === "busy" || event.status === "idle") &&
      this.state.lastError !== null
    ) {
      patch.lastError = null;
    }

    this.updateState(patch);
  }

  private updateState(patch: Partial<ManagerWsState>): void {
    const entries = Object.entries(patch) as Array<
      [keyof ManagerWsState, ManagerWsState[keyof ManagerWsState]]
    >;
    if (
      entries.length === 0 ||
      entries.every(([key, value]) => Object.is(this.state[key], value))
    ) {
      return;
    }

    this.state = { ...this.state, ...patch };
    if (this.stateNotificationBatchDepth > 0) {
      this.hasPendingStateNotification = true;
      return;
    }

    this.notifyListeners();
  }

  private withBatchedStateNotifications(callback: () => void): void {
    this.stateNotificationBatchDepth += 1;
    try {
      callback();
    } finally {
      this.stateNotificationBatchDepth -= 1;
      if (
        this.stateNotificationBatchDepth === 0 &&
        this.hasPendingStateNotification
      ) {
        this.hasPendingStateNotification = false;
        this.notifyListeners();
      }
    }
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }

  private nextRequestId(prefix: string): string {
    this.requestCounter += 1;
    return `${prefix}-${Date.now()}-${this.requestCounter}`;
  }

  private enqueueRequest<RequestType extends WsRequestType>(
    requestType: RequestType,
    buildCommand: (requestId: string) => ClientCommand,
  ): Promise<WsRequestResultMap[RequestType]> {
    const requestId = this.nextRequestId(requestType);

    return new Promise<WsRequestResultMap[RequestType]>((resolve, reject) => {
      this.requestTracker.track(requestType, requestId, resolve, reject);

      const sent = this.send(buildCommand(requestId));
      if (!sent) {
        this.requestTracker.reject(
          requestType,
          requestId,
          new Error("WebSocket is disconnected. Reconnecting..."),
        );
      }
    });
  }

  private rejectPendingFromError(
    code: string,
    message: string,
    requestId?: string,
  ): void {
    const fullError = new Error(`${code}: ${message}`);

    if (
      requestId &&
      this.requestTracker.rejectByRequestId(requestId, fullError)
    ) {
      return;
    }

    const loweredCode = code.toLowerCase();

    for (const hint of WS_REQUEST_ERROR_HINTS) {
      if (!loweredCode.includes(hint.codeFragment)) {
        continue;
      }

      if (this.requestTracker.rejectOldest(hint.requestType, fullError)) {
        return;
      }
    }

    this.requestTracker.rejectOnlyPending(fullError);
  }

  private rejectAllPendingRequests(reason: string): void {
    this.requestTracker.rejectAll(new Error(reason));
  }
}

function normalizeConversationAttachments(
  attachments: ConversationAttachment[] | undefined,
): ConversationAttachment[] {
  if (!attachments || attachments.length === 0) {
    return [];
  }

  const normalized: ConversationAttachment[] = [];

  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== "object") {
      continue;
    }

    const maybe = attachment as {
      type?: unknown;
      mimeType?: unknown;
      data?: unknown;
      text?: unknown;
      fileName?: unknown;
    };

    const attachmentType =
      typeof maybe.type === "string" ? maybe.type.trim() : "";
    const mimeType =
      typeof maybe.mimeType === "string" ? maybe.mimeType.trim() : "";
    const fileName =
      typeof maybe.fileName === "string" ? maybe.fileName.trim() : "";

    if (attachmentType === "text") {
      const text = typeof maybe.text === "string" ? maybe.text : "";
      if (!mimeType || text.trim().length === 0) {
        continue;
      }

      normalized.push({
        type: "text",
        mimeType,
        text,
        fileName: fileName || undefined,
      });
      continue;
    }

    if (attachmentType === "binary") {
      const data = typeof maybe.data === "string" ? maybe.data.trim() : "";
      if (!mimeType || data.length === 0) {
        continue;
      }

      normalized.push({
        type: "binary",
        mimeType,
        data,
        fileName: fileName || undefined,
      });
      continue;
    }

    const data = typeof maybe.data === "string" ? maybe.data.trim() : "";
    if (!mimeType || !mimeType.startsWith("image/") || !data) {
      continue;
    }

    normalized.push({
      mimeType,
      data,
      fileName: fileName || undefined,
    });
  }

  return normalized;
}

function splitConversationHistory(messages: ConversationEntry[]): {
  messages: ConversationHistoryEntry[];
  activityMessages: AgentActivityEntry[];
} {
  const conversationMessages: ConversationHistoryEntry[] = [];
  const activityMessages: AgentActivityEntry[] = [];

  for (const entry of messages) {
    if (entry.type === "agent_message" || entry.type === "agent_tool_call") {
      activityMessages.push(entry);
      continue;
    }

    conversationMessages.push(entry);
  }

  return {
    messages: conversationMessages,
    activityMessages,
  };
}

function prependConversationEntries<Entry extends ConversationEntry>(
  existingEntries: Entry[],
  incomingEntries: Entry[],
): Entry[] {
  if (incomingEntries.length === 0) {
    return existingEntries;
  }

  const existingEntryIds = new Set(
    existingEntries.map((entry) => getConversationEntryStableId(entry)),
  );
  const prependedEntries = incomingEntries.filter(
    (entry) => !existingEntryIds.has(getConversationEntryStableId(entry)),
  );

  return prependedEntries.length > 0
    ? [...prependedEntries, ...existingEntries]
    : existingEntries;
}

function resolveOldestHistoryCursor(
  messages: ConversationEntry[],
  activityMessages: ConversationEntry[],
): string | null {
  const oldestConversationEntry = messages[0];
  const oldestActivityEntry = activityMessages[0];

  if (!oldestConversationEntry && !oldestActivityEntry) {
    return null;
  }

  if (!oldestConversationEntry) {
    return getConversationEntryCursor(oldestActivityEntry!);
  }

  if (!oldestActivityEntry) {
    return getConversationEntryCursor(oldestConversationEntry);
  }

  return compareConversationEntries(
    oldestConversationEntry,
    oldestActivityEntry,
  ) <= 0
    ? getConversationEntryCursor(oldestConversationEntry)
    : getConversationEntryCursor(oldestActivityEntry);
}

function extractManagerOrder(agents: AgentDescriptor[]): string[] {
  return agents
    .filter((agent) => agent.role === "manager")
    .map((agent) => agent.agentId);
}

function resolveLastErrorFromHistory(
  messages: ConversationHistoryEntry[],
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    if (entry.type === "conversation_log") {
      return entry.isError ? entry.text : null;
    }

    if (shouldClearLastErrorFromTranscriptEntry(entry)) {
      return null;
    }
  }

  return null;
}

function shouldClearLastErrorFromTranscriptEntry(
  entry: ConversationHistoryEntry,
): boolean {
  if (entry.type === "conversation_log") {
    return entry.isError !== true;
  }

  if (entry.type !== "conversation_message") {
    return false;
  }

  return (
    entry.role === "assistant" ||
    entry.role === "system" ||
    entry.source === "speak_to_user"
  );
}

function normalizeAgentId(agentId: string | null | undefined): string | null {
  const trimmed = agentId?.trim();
  return trimmed ? trimmed : null;
}

function areAgentContextUsagesEqual(
  left?: AgentContextUsage,
  right?: AgentContextUsage,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.tokens === right.tokens &&
    left.contextWindow === right.contextWindow &&
    left.percent === right.percent
  );
}
