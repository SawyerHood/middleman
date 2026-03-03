import type { ClientCommand, ServerEvent } from "@middleman/protocol";
import type { IntegrationRegistryService } from "../integrations/registry.js";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import { WebSocketServer, type RawData, WebSocket } from "ws";
import { extractRequestId, parseClientCommand } from "./ws-command-parser.js";
import { handleAgentCommand } from "./routes/agent-routes.js";
import { handleConversationCommand } from "./routes/conversation-routes.js";
import { handleManagerCommand } from "./routes/manager-routes.js";

const BOOTSTRAP_SUBSCRIPTION_AGENT_ID = "__bootstrap_manager__";
const BOOTSTRAP_HISTORY_LIMIT = 200;
const MAX_WS_EVENT_BYTES = 5 * 1024 * 1024;
const MAX_WS_BUFFERED_AMOUNT_BYTES = 5 * 1024 * 1024;

export class WsHandler {
  private readonly swarmManager: SwarmManager;
  private readonly integrationRegistry: IntegrationRegistryService | null;
  private readonly allowNonManagerSubscriptions: boolean;

  private wss: WebSocketServer | null = null;
  private readonly subscriptions = new Map<WebSocket, string>();

  constructor(options: {
    swarmManager: SwarmManager;
    integrationRegistry: IntegrationRegistryService | null;
    allowNonManagerSubscriptions: boolean;
  }) {
    this.swarmManager = options.swarmManager;
    this.integrationRegistry = options.integrationRegistry;
    this.allowNonManagerSubscriptions = options.allowNonManagerSubscriptions;
  }

  attach(server: WebSocketServer): void {
    this.wss = server;

    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        void this.handleSocketMessage(socket, raw);
      });

      socket.on("close", () => {
        this.subscriptions.delete(socket);
      });

      socket.on("error", () => {
        this.subscriptions.delete(socket);
      });
    });
  }

  reset(): void {
    this.wss = null;
    this.subscriptions.clear();
  }

  broadcastToSubscribed(event: ServerEvent): void {
    if (!this.wss) {
      return;
    }

    for (const client of this.wss.clients) {
      if (client.readyState !== WebSocket.OPEN) {
        continue;
      }

      const subscribedAgent = this.subscriptions.get(client);
      if (!subscribedAgent) {
        continue;
      }

      if (
        event.type === "conversation_message" ||
        event.type === "conversation_log" ||
        event.type === "agent_message" ||
        event.type === "agent_tool_call" ||
        event.type === "conversation_reset"
      ) {
        if (subscribedAgent !== event.agentId) {
          continue;
        }
      }

      if (event.type === "slack_status" || event.type === "telegram_status") {
        if (event.managerId) {
          const subscribedManagerId = this.resolveManagerContextAgentId(subscribedAgent);
          if (subscribedManagerId !== event.managerId) {
            continue;
          }
        }
      }

      this.send(client, event);
    }
  }

  private async handleSocketMessage(socket: WebSocket, raw: RawData): Promise<void> {
    const parsed = parseClientCommand(raw);
    if (!parsed.ok) {
      this.logDebug("command:invalid", {
        message: parsed.error
      });
      this.send(socket, {
        type: "error",
        code: "INVALID_COMMAND",
        message: parsed.error
      });
      return;
    }

    const command = parsed.command;
    this.logDebug("command:received", {
      type: command.type,
      requestId: extractRequestId(command)
    });

    if (command.type === "ping") {
      this.send(socket, {
        type: "ready",
        serverTime: new Date().toISOString(),
        subscribedAgentId: this.subscriptions.get(socket) ?? this.resolveDefaultSubscriptionAgentId()
      });
      return;
    }

    if (command.type === "subscribe") {
      await this.handleSubscribe(socket, command.agentId);
      return;
    }

    const subscribedAgentId = this.resolveSubscribedAgentId(socket);
    if (!subscribedAgentId) {
      this.logDebug("command:rejected:not_subscribed", {
        type: command.type
      });
      this.send(socket, {
        type: "error",
        code: "NOT_SUBSCRIBED",
        message: `Send subscribe before ${command.type}.`,
        requestId: extractRequestId(command)
      });
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
      handleDeletedAgentSubscriptions: (deletedAgentIds) => this.handleDeletedAgentSubscriptions(deletedAgentIds)
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
      send: (targetSocket, event) => this.send(targetSocket, event)
    });
    if (agentHandled) {
      return;
    }

    const conversationHandled = await handleConversationCommand({
      command,
      socket,
      subscribedAgentId,
      swarmManager: this.swarmManager,
      allowNonManagerSubscriptions: this.allowNonManagerSubscriptions,
      send: (targetSocket, event) => this.send(targetSocket, event),
      logDebug: (message, details) => this.logDebug(message, details),
      resolveConfiguredManagerId: () => this.resolveConfiguredManagerId()
    });
    if (conversationHandled) {
      return;
    }

    this.send(socket, {
      type: "error",
      code: "UNKNOWN_COMMAND",
      message: `Unsupported command type ${(command as ClientCommand).type}`
    });
  }

  private async handleSubscribe(socket: WebSocket, requestedAgentId?: string): Promise<void> {
    const managerId = this.resolveConfiguredManagerId();
    const targetAgentId =
      requestedAgentId ?? this.resolvePreferredManagerSubscriptionId() ?? this.resolveDefaultSubscriptionAgentId();

    if (!this.allowNonManagerSubscriptions && managerId && targetAgentId !== managerId) {
      this.send(socket, {
        type: "error",
        code: "SUBSCRIPTION_NOT_SUPPORTED",
        message: `Subscriptions are currently limited to ${managerId}.`
      });
      return;
    }

    const targetDescriptor = this.swarmManager.getAgent(targetAgentId);
    const canBootstrapSubscription =
      !targetDescriptor &&
      !this.hasRunningManagers() &&
      (managerId ? requestedAgentId === managerId : requestedAgentId === undefined);

    if (!targetDescriptor && requestedAgentId && !canBootstrapSubscription) {
      this.send(socket, {
        type: "error",
        code: "UNKNOWN_AGENT",
        message: `Agent ${targetAgentId} does not exist.`
      });
      return;
    }

    this.subscriptions.set(socket, targetAgentId);
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

    this.subscriptions.set(socket, fallbackAgentId);
    this.sendSubscriptionBootstrap(socket, fallbackAgentId);

    return fallbackAgentId;
  }

  private resolveManagerContextAgentId(subscribedAgentId: string): string | undefined {
    const descriptor = this.swarmManager.getAgent(subscribedAgentId);
    if (!descriptor) {
      if (!this.hasRunningManagers()) {
        return this.resolveConfiguredManagerId() ?? subscribedAgentId;
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
        this.subscriptions.set(socket, this.resolveDefaultSubscriptionAgentId());
        continue;
      }

      this.subscriptions.set(socket, fallbackAgentId);
      this.sendSubscriptionBootstrap(socket, fallbackAgentId);
    }
  }

  private sendSubscriptionBootstrap(socket: WebSocket, targetAgentId: string): void {
    this.send(socket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      subscribedAgentId: targetAgentId
    });
    this.send(socket, {
      type: "agents_snapshot",
      agents: this.swarmManager.listAgents()
    });
    this.send(socket, {
      type: "conversation_history",
      agentId: targetAgentId,
      messages: this.swarmManager.getConversationHistory(targetAgentId, {
        limit: BOOTSTRAP_HISTORY_LIMIT
      })
    });

    const managerContextId = this.resolveManagerContextAgentId(targetAgentId);
    if (this.integrationRegistry && managerContextId) {
      this.send(socket, this.integrationRegistry.getStatus(managerContextId, "slack"));
      this.send(socket, this.integrationRegistry.getStatus(managerContextId, "telegram"));
    }
  }

  private resolveDefaultSubscriptionAgentId(): string {
    return (
      this.resolvePreferredManagerSubscriptionId() ??
      this.resolveConfiguredManagerId() ??
      BOOTSTRAP_SUBSCRIPTION_AGENT_ID
    );
  }

  private resolvePreferredManagerSubscriptionId(): string | undefined {
    const managerId = this.resolveConfiguredManagerId();
    if (managerId) {
      const configuredManager = this.swarmManager.getAgent(managerId);
      if (configuredManager && this.isSubscribable(configuredManager.status)) {
        return managerId;
      }
    }

    const firstManager = this.swarmManager
      .listAgents()
      .find((agent) => agent.role === "manager" && this.isSubscribable(agent.status));

    return firstManager?.agentId;
  }

  private resolveConfiguredManagerId(): string | undefined {
    const managerId = this.swarmManager.getConfig().managerId;
    if (typeof managerId !== "string") {
      return undefined;
    }

    const normalized = managerId.trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  private hasRunningManagers(): boolean {
    return this.swarmManager
      .listAgents()
      .some((agent) => agent.role === "manager" && this.isSubscribable(agent.status));
  }

  private isSubscribable(status: string): boolean {
    return status === "idle" || status === "streaming";
  }

  private logDebug(message: string, details?: unknown): void {
    if (!this.swarmManager.getConfig().debug) {
      return;
    }

    const prefix = `[swarm][${new Date().toISOString()}] ws:${message}`;
    if (details === undefined) {
      console.log(prefix);
      return;
    }

    console.log(prefix, details);
  }

  private send(socket: WebSocket, event: ServerEvent): void {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    if (socket.bufferedAmount > MAX_WS_BUFFERED_AMOUNT_BYTES) {
      console.warn("[swarm] ws:drop_event:backpressure", {
        eventType: event.type,
        bufferedAmount: socket.bufferedAmount,
        maxBufferedAmountBytes: MAX_WS_BUFFERED_AMOUNT_BYTES
      });
      return;
    }

    let serialized: string;
    try {
      serialized = JSON.stringify(event);
    } catch (error) {
      console.warn("[swarm] ws:drop_event:serialize_failed", {
        eventType: event.type,
        message: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    const eventBytes = Buffer.byteLength(serialized, "utf8");
    if (eventBytes > MAX_WS_EVENT_BYTES) {
      console.warn("[swarm] ws:drop_event:oversized", {
        eventType: event.type,
        eventBytes,
        maxEventBytes: MAX_WS_EVENT_BYTES
      });
      return;
    }

    socket.send(serialized);
  }
}
