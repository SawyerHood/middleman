import type { ClientCommand, ServerEvent } from "@middleman/protocol";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebSocket } from "ws";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import { applyCorsHeaders, readJsonBody, sendJson } from "../http-utils.js";
import type { HttpRoute } from "./http-route.js";

const TASKS_ENDPOINT_PATH = "/api/tasks";
const TASK_ENDPOINT_PATTERN = /^\/api\/tasks\/([^/]+)$/;

export function createTaskHttpRoutes(options: { swarmManager: SwarmManager }): HttpRoute[] {
  return [
    {
      methods: "GET, POST, OPTIONS",
      matches: (pathname) => pathname === TASKS_ENDPOINT_PATH,
      handle: async (request, response, requestUrl) => {
        await handleTasksCollectionHttpRequest(options.swarmManager, request, response, requestUrl);
      }
    },
    {
      methods: "PATCH, DELETE, OPTIONS",
      matches: (pathname) => TASK_ENDPOINT_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        await handleTaskItemHttpRequest(options.swarmManager, request, response, requestUrl);
      }
    }
  ];
}

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

  if (command.type === "add_task_comment") {
    try {
      const task = await swarmManager.addTaskComment(command.taskId, command.comment);

      send(socket, {
        type: "task_comment_result",
        task,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "ADD_TASK_COMMENT_FAILED",
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

  if (command.type === "update_task") {
    try {
      const task = await swarmManager.updateTask(command.taskId, {
        title: command.title,
        description: command.description
      });

      send(socket, {
        type: "task_update_result",
        task,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "UPDATE_TASK_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  return false;
}

async function handleTasksCollectionHttpRequest(
  swarmManager: SwarmManager,
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL
): Promise<void> {
  const methods = "GET, POST, OPTIONS";

  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, methods);
    response.statusCode = 204;
    response.end();
    return;
  }

  if (request.method === "GET") {
    applyCorsHeaders(request, response, methods);

    try {
      const managerId = parseRequiredManagerId(requestUrl.searchParams.get("managerId"));
      const tasks = await swarmManager.listOutstandingTasksForManager(managerId);
      sendJson(response, 200, { tasks });
    } catch (error) {
      sendTaskHttpError(request, response, methods, error);
    }
    return;
  }

  if (request.method === "POST") {
    applyCorsHeaders(request, response, methods);

    try {
      const payload = parseCreateTaskBody(await readJsonBody(request));
      const task = await swarmManager.createTaskForManager(payload.managerId, {
        title: payload.title,
        description: payload.description
      });
      sendJson(response, 201, { task });
    } catch (error) {
      sendTaskHttpError(request, response, methods, error);
    }
    return;
  }

  applyCorsHeaders(request, response, methods);
  response.setHeader("Allow", methods);
  sendJson(response, 405, { error: "Method Not Allowed" });
}

async function handleTaskItemHttpRequest(
  swarmManager: SwarmManager,
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL
): Promise<void> {
  const methods = "PATCH, DELETE, OPTIONS";
  const matched = requestUrl.pathname.match(TASK_ENDPOINT_PATTERN);
  const rawTaskId = matched?.[1] ?? "";

  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, methods);
    response.statusCode = 204;
    response.end();
    return;
  }

  applyCorsHeaders(request, response, methods);

  const taskId = decodeURIComponent(rawTaskId).trim();
  if (!taskId) {
    sendJson(response, 400, { error: "Missing task id" });
    return;
  }

  try {
    if (request.method === "PATCH") {
      const payload = parsePatchTaskBody(await readJsonBody(request));
      const task =
        payload.status === "completed"
          ? await swarmManager.closeTaskForManager(payload.managerId, taskId, {
              comment: payload.comment
            })
          : await swarmManager.updateTaskForManager(payload.managerId, taskId, {
              title: payload.title,
              description: payload.description
            });

      sendJson(response, 200, { task });
      return;
    }

    if (request.method === "DELETE") {
      const payload = parseDeleteTaskRequest(requestUrl);
      const task = await swarmManager.closeTaskForManager(payload.managerId, taskId, {
        comment: payload.comment
      });
      sendJson(response, 200, { task });
      return;
    }

    response.setHeader("Allow", methods);
    sendJson(response, 405, { error: "Method Not Allowed" });
  } catch (error) {
    sendTaskHttpError(request, response, methods, error);
  }
}

function parseRequiredManagerId(value: string | null | undefined): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("managerId is required");
  }

  return value.trim();
}

function parseCreateTaskBody(value: unknown): {
  managerId: string;
  title: string;
  description?: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object");
  }

  const maybe = value as {
    managerId?: unknown;
    title?: unknown;
    description?: unknown;
  };

  if (typeof maybe.title !== "string" || maybe.title.trim().length === 0) {
    throw new Error("title is required");
  }
  if (maybe.description !== undefined && typeof maybe.description !== "string") {
    throw new Error("description must be a string when provided");
  }

  return {
    managerId: parseRequiredManagerId(typeof maybe.managerId === "string" ? maybe.managerId : undefined),
    title: maybe.title.trim(),
    description: maybe.description
  };
}

function parsePatchTaskBody(value: unknown): {
  managerId: string;
  title?: string;
  description?: string;
  status?: "completed";
  comment?: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object");
  }

  const maybe = value as {
    managerId?: unknown;
    title?: unknown;
    description?: unknown;
    status?: unknown;
    comment?: unknown;
  };

  if (maybe.title !== undefined && typeof maybe.title !== "string") {
    throw new Error("title must be a string when provided");
  }
  if (maybe.description !== undefined && typeof maybe.description !== "string") {
    throw new Error("description must be a string when provided");
  }
  if (maybe.comment !== undefined && typeof maybe.comment !== "string") {
    throw new Error("comment must be a string when provided");
  }
  if (maybe.status !== undefined && maybe.status !== "completed") {
    throw new Error("status must be \"completed\" when provided");
  }

  const managerId = parseRequiredManagerId(typeof maybe.managerId === "string" ? maybe.managerId : undefined);
  const title = typeof maybe.title === "string" ? maybe.title.trim() : undefined;
  if (maybe.title !== undefined && !title) {
    throw new Error("title must be a non-empty string when provided");
  }

  if (maybe.status === "completed") {
    return {
      managerId,
      status: "completed",
      comment: typeof maybe.comment === "string" && maybe.comment.trim().length > 0 ? maybe.comment.trim() : undefined
    };
  }

  if (title === undefined && maybe.description === undefined) {
    throw new Error("title or description is required");
  }

  return {
    managerId,
    title,
    description: maybe.description
  };
}

function parseDeleteTaskRequest(requestUrl: URL): { managerId: string; comment?: string } {
  const managerId = parseRequiredManagerId(requestUrl.searchParams.get("managerId"));
  const comment = requestUrl.searchParams.get("comment")?.trim();

  return {
    managerId,
    comment: comment && comment.length > 0 ? comment : undefined
  };
}

function sendTaskHttpError(
  request: IncomingMessage,
  response: ServerResponse,
  methods: string,
  error: unknown
): void {
  applyCorsHeaders(request, response, methods);
  const message = error instanceof Error ? error.message : String(error);
  const statusCode =
    message.includes("Unknown manager") || message.includes("Unknown task")
      ? 404
      : message.includes("does not belong to manager")
        ? 403
        : message.includes("required") ||
            message.includes("must be") ||
            message.includes("Only manager")
          ? 400
          : 500;

  sendJson(response, statusCode, { error: message });
}
