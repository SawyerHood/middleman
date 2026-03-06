import type { ClientCommand, ServerEvent } from "@middleman/protocol";
import type { WebSocket } from "ws";
import type { SwarmManager } from "../../swarm/swarm-manager.js";

export interface TaskCommandRouteContext {
  command: ClientCommand;
  socket: WebSocket;
  swarmManager: SwarmManager;
  send: (socket: WebSocket, event: ServerEvent) => void;
}

export async function handleTaskCommand(context: TaskCommandRouteContext): Promise<boolean> {
  const { command, socket, swarmManager, send } = context;

  if (command.type === "get_all_tasks") {
    try {
      send(socket, {
        type: "tasks_snapshot",
        tasks: swarmManager.listAllTasks(),
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "GET_ALL_TASKS_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "complete_task") {
    try {
      const task = await swarmManager.completeTask(command.taskId, {
        comment: command.comment,
        sourceContext: { channel: "web" }
      });

      send(socket, {
        type: "task_completion_result",
        task,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "COMPLETE_TASK_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  return false;
}
