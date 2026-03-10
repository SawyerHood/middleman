import type { ClientCommand, ServerEvent } from "@middleman/protocol";
import type { WebSocket } from "ws";
import type { SwarmManager } from "../../swarm/swarm-manager.js";

export interface ManagerCommandRouteContext {
  command: ClientCommand;
  socket: WebSocket;
  subscribedAgentId: string;
  swarmManager: SwarmManager;
  resolveManagerContextAgentId: (subscribedAgentId: string) => string | undefined;
  send: (socket: WebSocket, event: ServerEvent) => void;
  broadcastToSubscribed: (event: ServerEvent) => void;
  handleDeletedAgentSubscriptions: (deletedAgentIds: Set<string>) => void;
}

export async function handleManagerCommand(context: ManagerCommandRouteContext): Promise<boolean> {
  const {
    command,
    socket,
    subscribedAgentId,
    swarmManager,
    resolveManagerContextAgentId,
    send,
    broadcastToSubscribed,
    handleDeletedAgentSubscriptions
  } = context;

  if (command.type === "create_manager") {
    const managerContextId = resolveManagerContextAgentId(subscribedAgentId);
    if (!managerContextId) {
      send(socket, {
        type: "error",
        code: "UNKNOWN_AGENT",
        message: `Agent ${subscribedAgentId} does not exist.`,
        requestId: command.requestId
      });
      return true;
    }

    try {
      const manager = await swarmManager.createManager(managerContextId, {
        name: command.name,
        cwd: command.cwd,
        model: command.model
      });

      broadcastToSubscribed({
        type: "manager_created",
        manager,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "CREATE_MANAGER_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "reorder_managers") {
    const managerContextId = resolveManagerContextAgentId(subscribedAgentId);
    if (!managerContextId) {
      send(socket, {
        type: "error",
        code: "UNKNOWN_AGENT",
        message: `Agent ${subscribedAgentId} does not exist.`,
        requestId: command.requestId
      });
      return true;
    }

    try {
      const managerIds = await swarmManager.reorderManagers(managerContextId, command.managerIds);

      broadcastToSubscribed({
        type: "manager_order_updated",
        managerIds,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "REORDER_MANAGERS_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "delete_manager") {
    const managerContextId = resolveManagerContextAgentId(subscribedAgentId);
    if (!managerContextId) {
      send(socket, {
        type: "error",
        code: "UNKNOWN_AGENT",
        message: `Agent ${subscribedAgentId} does not exist.`,
        requestId: command.requestId
      });
      return true;
    }

    try {
      const deleted = await swarmManager.deleteManager(managerContextId, command.managerId);
      handleDeletedAgentSubscriptions(new Set([deleted.managerId, ...deleted.terminatedWorkerIds]));

      broadcastToSubscribed({
        type: "manager_deleted",
        managerId: deleted.managerId,
        terminatedWorkerIds: deleted.terminatedWorkerIds,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "DELETE_MANAGER_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  return false;
}
