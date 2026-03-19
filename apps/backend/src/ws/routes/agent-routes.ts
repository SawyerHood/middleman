import type { ClientCommand, ServerEvent } from "@middleman/protocol";
import type { WebSocket } from "ws";
import type { SwarmManager } from "../../swarm/swarm-manager.js";

export interface AgentCommandRouteContext {
  command: ClientCommand;
  socket: WebSocket;
  subscribedAgentId: string;
  swarmManager: SwarmManager;
  resolveManagerContextAgentId: (subscribedAgentId: string) => string | undefined;
  send: (socket: WebSocket, event: ServerEvent) => void;
}

export async function handleAgentCommand(context: AgentCommandRouteContext): Promise<boolean> {
  const { command, socket, subscribedAgentId, swarmManager, resolveManagerContextAgentId, send } =
    context;

  if (command.type === "kill_agent") {
    const managerContextId = resolveManagerContextAgentId(subscribedAgentId);
    if (!managerContextId) {
      send(socket, {
        type: "error",
        code: "UNKNOWN_AGENT",
        message: `Agent ${subscribedAgentId} does not exist.`,
      });
      return true;
    }

    try {
      await swarmManager.killAgent(managerContextId, command.agentId);
    } catch (error) {
      send(socket, {
        type: "error",
        code: "KILL_AGENT_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }

    return true;
  }

  if (command.type === "stop_all_agents") {
    const managerContextId = resolveManagerContextAgentId(subscribedAgentId);
    if (!managerContextId) {
      send(socket, {
        type: "error",
        code: "UNKNOWN_AGENT",
        message: `Agent ${subscribedAgentId} does not exist.`,
        requestId: command.requestId,
      });
      return true;
    }

    try {
      const stopped = await swarmManager.stopAllAgents(managerContextId, command.managerId);
      send(socket, {
        type: "stop_all_agents_result",
        managerId: stopped.managerId,
        stoppedWorkerIds: stopped.stoppedWorkerIds,
        managerStopped: stopped.managerStopped,
        requestId: command.requestId,
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "STOP_ALL_AGENTS_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId,
      });
    }

    return true;
  }

  if (command.type === "list_directories") {
    try {
      const listed = await swarmManager.listDirectories(command.path);
      send(socket, {
        type: "directories_listed",
        path: listed.resolvedPath,
        directories: listed.directories.map((entry) => entry.path),
        requestId: command.requestId,
        requestedPath: listed.requestedPath,
        resolvedPath: listed.resolvedPath,
        roots: listed.roots,
        entries: listed.directories,
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "LIST_DIRECTORIES_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId,
      });
    }

    return true;
  }

  if (command.type === "validate_directory") {
    try {
      const validation = await swarmManager.validateDirectory(command.path);
      send(socket, {
        type: "directory_validated",
        path: validation.requestedPath,
        valid: validation.valid,
        message: validation.message,
        requestId: command.requestId,
        requestedPath: validation.requestedPath,
        roots: validation.roots,
        resolvedPath: validation.resolvedPath,
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "VALIDATE_DIRECTORY_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId,
      });
    }

    return true;
  }

  if (command.type === "pick_directory") {
    try {
      const pickedPath = await swarmManager.pickDirectory(command.defaultPath);
      send(socket, {
        type: "directory_picked",
        path: pickedPath,
        requestId: command.requestId,
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "PICK_DIRECTORY_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId,
      });
    }

    return true;
  }

  return false;
}
