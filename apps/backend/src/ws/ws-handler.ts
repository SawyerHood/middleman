import type { ClientCommand, ServerEvent } from "@middleman/protocol";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import { WebSocketServer, type RawData, WebSocket } from "ws";
import { BUILD_HASH } from "../build-hash.js";
import { extractRequestId, parseClientCommand } from "./ws-command-parser.js";
import { handleAgentCommand } from "./routes/agent-routes.js";
import { handleConversationCommand } from "./routes/conversation-routes.js";
import { handleManagerCommand } from "./routes/manager-routes.js";

const BOOTSTRAP_SUBSCRIPTION_AGENT_ID = "__bootstrap_manager__";
const BOOTSTRAP_HISTORY_LIMIT = 200;
const BOOTSTRAP_HISTORY_TRUNCATED_CODE = "HISTORY_TRUNCATED";
const AGENT_DETAIL_HISTORY_TRUNCATED_CODE = "AGENT_DETAIL_HISTORY_TRUNCATED";
const MAX_WS_EVENT_BYTES = 5 * 1024 * 1024;
const MAX_WS_BUFFERED_AMOUNT_BYTES = 5 * 1024 * 1024;

interface PreparedServerEvent {
  event: ServerEvent;
  serialized: string;
  eventBytes: number;
}

function isPreferredManagerSubscriptionCandidate(
  agent: ReturnType<SwarmManager["listAgents"]>[number],
): boolean {
  return agent.role === "manager" && agent.status !== "terminated";
}

function isAgentScopedEvent(event: ServerEvent): event is Extract<
  ServerEvent,
  {
    type:
      | "conversation_message"
      | "conversation_log"
      | "agent_message"
      | "agent_tool_call"
      | "conversation_reset";
  }
> {
  return (
    event.type === "conversation_message" ||
    event.type === "conversation_log" ||
    event.type === "agent_message" ||
    event.type === "agent_tool_call" ||
    event.type === "conversation_reset"
  );
}

export class WsHandler {
  private readonly swarmManager: SwarmManager;

  private wss: WebSocketServer | null = null;
  private readonly subscriptions = new Map<WebSocket, string>();
  private readonly subscribersByAgentId = new Map<string, Set<WebSocket>>();
  private readonly agentDetailSubscriptions = new Map<WebSocket, string>();
  private readonly agentDetailSubscribersByAgentId = new Map<string, Set<WebSocket>>();

  constructor(options: { swarmManager: SwarmManager }) {
    this.swarmManager = options.swarmManager;
  }

  attach(server: WebSocketServer): void {
    this.wss = server;

    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        void this.handleSocketMessage(socket, raw);
      });

      socket.on("close", () => {
        this.clearSocketSubscriptions(socket);
      });

      socket.on("error", () => {
        this.clearSocketSubscriptions(socket);
      });
    });
  }

  reset(): void {
    this.wss = null;
    this.subscriptions.clear();
    this.subscribersByAgentId.clear();
    this.agentDetailSubscriptions.clear();
    this.agentDetailSubscribersByAgentId.clear();
  }

  broadcastToSubscribed(event: ServerEvent): void {
    if (!this.wss) {
      return;
    }

    const recipients = this.resolveBroadcastRecipients(event);
    if (recipients.size === 0) {
      return;
    }

    const prepared = this.serializeEvent(event);
    if (!prepared) {
      return;
    }

    if (!this.isPreparedEventWithinSizeLimit(prepared)) {
      this.logOversizedEvent(prepared);
      return;
    }

    for (const client of recipients) {
      this.sendPrepared(client, prepared);
    }
  }

  private async handleSocketMessage(socket: WebSocket, raw: RawData): Promise<void> {
    const parsed = parseClientCommand(raw);
    if (!parsed.ok) {
      this.logDebug("command:invalid", {
        message: parsed.error,
      });
      this.send(socket, {
        type: "error",
        code: "INVALID_COMMAND",
        message: parsed.error,
      });
      return;
    }

    const command = parsed.command;
    this.logDebug("command:received", {
      type: command.type,
      requestId: extractRequestId(command),
    });

    if (command.type === "subscribe") {
      await this.handleSubscribe(socket, command.agentId);
      return;
    }

    if (command.type === "subscribe_agent_detail") {
      this.handleSubscribeAgentDetail(socket, command.agentId);
      return;
    }

    if (command.type === "unsubscribe_agent_detail") {
      this.handleUnsubscribeAgentDetail(socket, command.agentId);
      return;
    }

    const subscribedAgentId = this.resolveSubscribedAgentId(socket);
    if (!subscribedAgentId) {
      this.logDebug("command:rejected:not_subscribed", {
        type: command.type,
      });
      this.send(socket, {
        type: "error",
        code: "NOT_SUBSCRIBED",
        message: `Send subscribe before ${command.type}.`,
        requestId: extractRequestId(command),
      });
      return;
    }

    if (command.type === "load_older_history") {
      this.handleLoadOlderHistory(socket, command, subscribedAgentId);
      return;
    }

    const managerHandled = await handleManagerCommand({
      command,
      socket,
      subscribedAgentId,
      swarmManager: this.swarmManager,
      resolveManagerContextAgentId: (agentId) => this.resolveManagerContextAgentId(agentId),
      send: (targetSocket, event) => this.send(targetSocket, event),
      broadcastToSubscribed: (event) => this.broadcastToSubscribed(event),
      handleDeletedAgentSubscriptions: (deletedAgentIds) =>
        this.handleDeletedAgentSubscriptions(deletedAgentIds),
    });
    if (managerHandled) {
      return;
    }

    const agentHandled = await handleAgentCommand({
      command,
      socket,
      subscribedAgentId,
      swarmManager: this.swarmManager,
      resolveManagerContextAgentId: (agentId) => this.resolveManagerContextAgentId(agentId),
      send: (targetSocket, event) => this.send(targetSocket, event),
    });
    if (agentHandled) {
      return;
    }

    const conversationHandled = await handleConversationCommand({
      command,
      socket,
      subscribedAgentId,
      swarmManager: this.swarmManager,
      send: (targetSocket, event) => this.send(targetSocket, event),
      logDebug: (message, details) => this.logDebug(message, details),
    });
    if (conversationHandled) {
      return;
    }

    this.send(socket, {
      type: "error",
      code: "UNKNOWN_COMMAND",
      message: `Unsupported command type ${(command as ClientCommand).type}`,
    });
  }

  private async handleSubscribe(socket: WebSocket, requestedAgentId?: string): Promise<void> {
    const targetAgentId =
      requestedAgentId ??
      this.resolvePreferredManagerSubscriptionId() ??
      this.resolveDefaultSubscriptionAgentId();

    const targetDescriptor = this.swarmManager.getAgent(targetAgentId);
    const canBootstrapSubscription =
      !targetDescriptor && !this.hasKnownManagers() && requestedAgentId === undefined;

    if (!targetDescriptor && requestedAgentId && !canBootstrapSubscription) {
      this.send(socket, {
        type: "error",
        code: "UNKNOWN_AGENT",
        message: `Agent ${targetAgentId} does not exist.`,
      });
      return;
    }

    this.setSubscription(socket, targetAgentId);
    this.sendSubscriptionBootstrap(socket, targetAgentId);
  }

  private resolveSubscribedAgentId(socket: WebSocket): string | undefined {
    const subscribedAgentId = this.subscriptions.get(socket);
    if (!subscribedAgentId) {
      return undefined;
    }

    if (this.swarmManager.getAgent(subscribedAgentId)) {
      return subscribedAgentId;
    }

    const fallbackAgentId = this.resolvePreferredManagerSubscriptionId();
    if (!fallbackAgentId) {
      return subscribedAgentId;
    }

    this.setSubscription(socket, fallbackAgentId);
    this.sendSubscriptionBootstrap(socket, fallbackAgentId);

    return fallbackAgentId;
  }

  private handleSubscribeAgentDetail(socket: WebSocket, targetAgentId: string): void {
    const targetDescriptor = this.swarmManager.getAgent(targetAgentId);
    if (!targetDescriptor) {
      this.send(socket, {
        type: "error",
        code: "UNKNOWN_AGENT",
        message: `Agent ${targetAgentId} does not exist.`,
      });
      return;
    }

    this.setAgentDetailSubscription(socket, targetAgentId);
    const transcriptPage = this.swarmManager.getVisibleTranscriptPage(targetAgentId, {
      limit: BOOTSTRAP_HISTORY_LIMIT,
    });
    this.sendConversationHistoryWithProgressiveFallback(
      socket,
      targetAgentId,
      transcriptPage.entries,
      {
        mode: "replace",
        hasMore: transcriptPage.hasMore,
      },
      AGENT_DETAIL_HISTORY_TRUNCATED_CODE,
      "transcript messages",
    );
  }

  private handleUnsubscribeAgentDetail(socket: WebSocket, targetAgentId: string): void {
    if (this.agentDetailSubscriptions.get(socket) !== targetAgentId) {
      return;
    }

    this.setAgentDetailSubscription(socket, undefined);
  }

  private resolveManagerContextAgentId(subscribedAgentId: string): string | undefined {
    const descriptor = this.swarmManager.getAgent(subscribedAgentId);
    if (!descriptor) {
      if (!this.hasKnownManagers()) {
        return subscribedAgentId;
      }
      return undefined;
    }

    return descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId;
  }

  private handleDeletedAgentSubscriptions(deletedAgentIds: Set<string>): void {
    for (const [socket, subscribedAgentId] of this.subscriptions.entries()) {
      if (!deletedAgentIds.has(subscribedAgentId)) {
        continue;
      }

      const fallbackAgentId = this.resolvePreferredManagerSubscriptionId();
      if (!fallbackAgentId) {
        this.setSubscription(socket, this.resolveDefaultSubscriptionAgentId());
        continue;
      }

      this.setSubscription(socket, fallbackAgentId);
      this.sendSubscriptionBootstrap(socket, fallbackAgentId);
    }

    for (const [socket, detailSubscribedAgentId] of this.agentDetailSubscriptions.entries()) {
      if (!deletedAgentIds.has(detailSubscribedAgentId)) {
        continue;
      }

      this.setAgentDetailSubscription(socket, undefined);
    }
  }

  private sendSubscriptionBootstrap(socket: WebSocket, targetAgentId: string): void {
    this.send(socket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      subscribedAgentId: targetAgentId,
      buildHash: BUILD_HASH,
    });
    this.send(socket, {
      type: "agents_snapshot",
      agents: this.swarmManager.listAgents(),
    });
    this.sendBootstrapConversationHistory(socket, targetAgentId);
  }

  private sendBootstrapConversationHistory(socket: WebSocket, targetAgentId: string): void {
    const transcriptPage = this.swarmManager.getVisibleTranscriptPage(targetAgentId, {
      limit: BOOTSTRAP_HISTORY_LIMIT,
    });
    this.sendConversationHistoryWithProgressiveFallback(
      socket,
      targetAgentId,
      transcriptPage.entries,
      {
        mode: "replace",
        hasMore: transcriptPage.hasMore,
      },
      BOOTSTRAP_HISTORY_TRUNCATED_CODE,
      "transcript messages",
    );
  }

  private sendConversationHistoryWithProgressiveFallback(
    socket: WebSocket,
    targetAgentId: string,
    historyMessages: Extract<ServerEvent, { type: "conversation_history" }>["messages"],
    options: {
      mode: "replace" | "prepend";
      hasMore: boolean;
    },
    truncationCode: string,
    historyLabel: string,
  ): void {
    if (historyMessages.length === 0) {
      this.send(socket, {
        type: "conversation_history",
        agentId: targetAgentId,
        messages: [],
        mode: options.mode,
        hasMore: options.hasMore,
      });
      return;
    }

    const totalCount = historyMessages.length;
    let sendCount = totalCount;

    while (sendCount > 0) {
      const messages = historyMessages.slice(totalCount - sendCount);
      const event: ServerEvent = {
        type: "conversation_history",
        agentId: targetAgentId,
        messages,
        mode: options.mode,
        hasMore: options.hasMore || sendCount < totalCount,
      };

      const prepared = this.serializeEvent(event, {
        logSerializeFailures: false,
      });
      if (prepared && this.isPreparedEventWithinSizeLimit(prepared)) {
        this.sendPrepared(socket, prepared);

        if (sendCount < totalCount) {
          this.sendConversationHistoryTruncatedNotice(
            socket,
            targetAgentId,
            totalCount,
            sendCount,
            truncationCode,
            historyLabel,
          );
        }
        return;
      }

      const halvedCount = Math.floor(sendCount / 2);
      sendCount = halvedCount < sendCount ? halvedCount : sendCount - 1;
    }

    this.send(socket, {
      type: "conversation_history",
      agentId: targetAgentId,
      messages: [],
      mode: options.mode,
      hasMore: true,
    });
    this.sendConversationHistoryTruncatedNotice(
      socket,
      targetAgentId,
      totalCount,
      0,
      truncationCode,
      historyLabel,
    );
  }

  private sendConversationHistoryTruncatedNotice(
    socket: WebSocket,
    targetAgentId: string,
    originalCount: number,
    deliveredCount: number,
    truncationCode: string,
    historyLabel: string,
  ): void {
    this.send(socket, {
      type: "error",
      code: truncationCode,
      message: `Conversation history was truncated for ${targetAgentId}: loaded ${deliveredCount} of ${originalCount} ${historyLabel} due payload limits.`,
    });
  }

  private handleLoadOlderHistory(
    socket: WebSocket,
    command: Extract<ClientCommand, { type: "load_older_history" }>,
    subscribedAgentId: string,
  ): void {
    const detailSubscribedAgentId = this.agentDetailSubscriptions.get(socket);
    const targetAgentId = command.agentId;

    if (detailSubscribedAgentId !== targetAgentId && subscribedAgentId !== targetAgentId) {
      this.send(socket, {
        type: "error",
        code: "HISTORY_PAGE_NOT_SUBSCRIBED",
        message: `Cannot load history for ${targetAgentId} without an active subscription.`,
      });
      return;
    }

    const isDetailHistoryRequest = detailSubscribedAgentId === targetAgentId;
    const historyPage = this.swarmManager.getVisibleTranscriptPage(targetAgentId, {
      before: command.before,
      limit: BOOTSTRAP_HISTORY_LIMIT,
    });

    this.sendConversationHistoryWithProgressiveFallback(
      socket,
      targetAgentId,
      historyPage.entries,
      {
        mode: "prepend",
        hasMore: historyPage.hasMore,
      },
      isDetailHistoryRequest
        ? AGENT_DETAIL_HISTORY_TRUNCATED_CODE
        : BOOTSTRAP_HISTORY_TRUNCATED_CODE,
      "transcript messages",
    );
  }

  private resolveDefaultSubscriptionAgentId(): string {
    return this.resolvePreferredManagerSubscriptionId() ?? BOOTSTRAP_SUBSCRIPTION_AGENT_ID;
  }

  private resolvePreferredManagerSubscriptionId(): string | undefined {
    const agents = this.swarmManager.listAgents();
    const preferredManager = agents.find(isPreferredManagerSubscriptionCandidate);
    if (preferredManager) {
      return preferredManager.agentId;
    }

    const firstManager = agents.find((agent) => agent.role === "manager");

    return firstManager?.agentId;
  }

  private hasKnownManagers(): boolean {
    return this.swarmManager.listAgents().some((agent) => agent.role === "manager");
  }

  private logDebug(message: string, details?: unknown): void {
    const prefix = `[swarm][${new Date().toISOString()}] ws:${message}`;
    if (details === undefined) {
      console.log(prefix);
      return;
    }

    console.log(prefix, details);
  }

  private send(socket: WebSocket, event: ServerEvent): void {
    const prepared = this.serializeEvent(event);
    if (!prepared) {
      return;
    }

    if (!this.isPreparedEventWithinSizeLimit(prepared)) {
      this.logOversizedEvent(prepared);
      return;
    }

    this.sendPrepared(socket, prepared);
  }

  private sendPrepared(socket: WebSocket, prepared: PreparedServerEvent): void {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    if (socket.bufferedAmount > MAX_WS_BUFFERED_AMOUNT_BYTES) {
      console.warn("[swarm] ws:drop_event:backpressure", {
        eventType: prepared.event.type,
        bufferedAmount: socket.bufferedAmount,
        maxBufferedAmountBytes: MAX_WS_BUFFERED_AMOUNT_BYTES,
      });
      return;
    }

    socket.send(prepared.serialized);
  }

  private serializeEvent(
    event: ServerEvent,
    options?: {
      logSerializeFailures?: boolean;
    },
  ): PreparedServerEvent | null {
    try {
      const serialized = JSON.stringify(event);
      return {
        event,
        serialized,
        eventBytes: Buffer.byteLength(serialized, "utf8"),
      };
    } catch (error) {
      if (options?.logSerializeFailures !== false) {
        console.warn("[swarm] ws:drop_event:serialize_failed", {
          eventType: event.type,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return null;
    }
  }

  private isPreparedEventWithinSizeLimit(prepared: PreparedServerEvent): boolean {
    return prepared.eventBytes <= MAX_WS_EVENT_BYTES;
  }

  private logOversizedEvent(prepared: PreparedServerEvent): void {
    console.warn("[swarm] ws:drop_event:oversized", {
      eventType: prepared.event.type,
      eventBytes: prepared.eventBytes,
      maxEventBytes: MAX_WS_EVENT_BYTES,
    });
  }

  private clearSocketSubscriptions(socket: WebSocket): void {
    this.setSubscription(socket, undefined);
    this.setAgentDetailSubscription(socket, undefined);
  }

  private setSubscription(socket: WebSocket, agentId: string | undefined): void {
    this.updateSubscriptionIndex(socket, this.subscriptions, this.subscribersByAgentId, agentId);
  }

  private setAgentDetailSubscription(socket: WebSocket, agentId: string | undefined): void {
    this.updateSubscriptionIndex(
      socket,
      this.agentDetailSubscriptions,
      this.agentDetailSubscribersByAgentId,
      agentId,
    );
  }

  private updateSubscriptionIndex(
    socket: WebSocket,
    subscriptionMap: Map<WebSocket, string>,
    reverseIndex: Map<string, Set<WebSocket>>,
    nextAgentId: string | undefined,
  ): void {
    const currentAgentId = subscriptionMap.get(socket);
    if (currentAgentId) {
      const sockets = reverseIndex.get(currentAgentId);
      sockets?.delete(socket);
      if (sockets && sockets.size === 0) {
        reverseIndex.delete(currentAgentId);
      }
    }

    if (!nextAgentId) {
      subscriptionMap.delete(socket);
      return;
    }

    subscriptionMap.set(socket, nextAgentId);
    let sockets = reverseIndex.get(nextAgentId);
    if (!sockets) {
      sockets = new Set<WebSocket>();
      reverseIndex.set(nextAgentId, sockets);
    }
    sockets.add(socket);
  }

  private resolveBroadcastRecipients(event: ServerEvent): Set<WebSocket> {
    if (!isAgentScopedEvent(event)) {
      return new Set(this.subscriptions.keys());
    }

    const recipients = new Set<WebSocket>();
    this.addRecipients(recipients, this.subscribersByAgentId.get(event.agentId));
    this.addRecipients(recipients, this.agentDetailSubscribersByAgentId.get(event.agentId));
    return recipients;
  }

  private addRecipients(target: Set<WebSocket>, sockets?: Set<WebSocket>): void {
    if (!sockets) {
      return;
    }

    for (const socket of sockets) {
      target.add(socket);
    }
  }
}
