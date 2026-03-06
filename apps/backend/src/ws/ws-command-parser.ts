import type { ClientCommand } from "@middleman/protocol";
import { type RawData } from "ws";
import { parseConversationAttachments } from "./attachment-parser.js";
import { describeSwarmModelPresets, isSwarmModelPreset } from "../swarm/model-presets.js";

export type ParsedClientCommand =
  | { ok: true; command: ClientCommand }
  | { ok: false; error: string };

export function parseClientCommand(raw: RawData): ParsedClientCommand {
  const text = typeof raw === "string" ? raw : raw.toString("utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "Command must be valid JSON" };
  }

  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "Command must be a JSON object" };
  }

  const maybe = parsed as Partial<ClientCommand> & { type?: unknown };

  if (maybe.type === "ping") {
    return { ok: true, command: { type: "ping" } };
  }

  if (maybe.type === "subscribe") {
    if (maybe.agentId !== undefined && typeof maybe.agentId !== "string") {
      return { ok: false, error: "subscribe.agentId must be a string when provided" };
    }
    return { ok: true, command: { type: "subscribe", agentId: maybe.agentId } };
  }

  if (maybe.type === "subscribe_agent_detail") {
    if (typeof maybe.agentId !== "string" || maybe.agentId.trim().length === 0) {
      return { ok: false, error: "subscribe_agent_detail.agentId must be a non-empty string" };
    }

    return {
      ok: true,
      command: {
        type: "subscribe_agent_detail",
        agentId: maybe.agentId.trim()
      }
    };
  }

  if (maybe.type === "unsubscribe_agent_detail") {
    if (typeof maybe.agentId !== "string" || maybe.agentId.trim().length === 0) {
      return { ok: false, error: "unsubscribe_agent_detail.agentId must be a non-empty string" };
    }

    return {
      ok: true,
      command: {
        type: "unsubscribe_agent_detail",
        agentId: maybe.agentId.trim()
      }
    };
  }

  if (maybe.type === "get_all_tasks") {
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (requestId !== undefined && typeof requestId !== "string") {
      return { ok: false, error: "get_all_tasks.requestId must be a string when provided" };
    }

    return {
      ok: true,
      command: {
        type: "get_all_tasks",
        requestId
      }
    };
  }

  if (maybe.type === "add_task_comment") {
    const taskId = (maybe as { taskId?: unknown }).taskId;
    const comment = (maybe as { comment?: unknown }).comment;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof taskId !== "string" || taskId.trim().length === 0) {
      return { ok: false, error: "add_task_comment.taskId must be a non-empty string" };
    }
    if (typeof comment !== "string" || comment.trim().length === 0) {
      return { ok: false, error: "add_task_comment.comment must be a non-empty string" };
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return { ok: false, error: "add_task_comment.requestId must be a string when provided" };
    }

    return {
      ok: true,
      command: {
        type: "add_task_comment",
        taskId: taskId.trim(),
        comment: comment.trim(),
        requestId
      }
    };
  }

  if (maybe.type === "complete_task") {
    const taskId = (maybe as { taskId?: unknown }).taskId;
    const comment = (maybe as { comment?: unknown }).comment;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof taskId !== "string" || taskId.trim().length === 0) {
      return { ok: false, error: "complete_task.taskId must be a non-empty string" };
    }
    if (comment !== undefined && typeof comment !== "string") {
      return { ok: false, error: "complete_task.comment must be a string when provided" };
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return { ok: false, error: "complete_task.requestId must be a string when provided" };
    }

    return {
      ok: true,
      command: {
        type: "complete_task",
        taskId: taskId.trim(),
        comment: comment?.trim() ? comment.trim() : undefined,
        requestId
      }
    };
  }

  if (maybe.type === "update_task") {
    const taskId = (maybe as { taskId?: unknown }).taskId;
    const title = (maybe as { title?: unknown }).title;
    const description = (maybe as { description?: unknown }).description;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof taskId !== "string" || taskId.trim().length === 0) {
      return { ok: false, error: "update_task.taskId must be a non-empty string" };
    }
    if (title !== undefined && typeof title !== "string") {
      return { ok: false, error: "update_task.title must be a string when provided" };
    }
    if (description !== undefined && typeof description !== "string") {
      return { ok: false, error: "update_task.description must be a string when provided" };
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return { ok: false, error: "update_task.requestId must be a string when provided" };
    }
    if (title === undefined && description === undefined) {
      return { ok: false, error: "update_task must include title or description" };
    }

    const trimmedTitle = typeof title === "string" ? title.trim() : undefined;
    if (title !== undefined && !trimmedTitle) {
      return { ok: false, error: "update_task.title must be a non-empty string when provided" };
    }

    return {
      ok: true,
      command: {
        type: "update_task",
        taskId: taskId.trim(),
        title: trimmedTitle,
        description: description !== undefined ? description.trim() : undefined,
        requestId
      }
    };
  }

  if (maybe.type === "kill_agent") {
    if (typeof maybe.agentId !== "string" || maybe.agentId.trim().length === 0) {
      return { ok: false, error: "kill_agent.agentId must be a non-empty string" };
    }

    return {
      ok: true,
      command: {
        type: "kill_agent",
        agentId: maybe.agentId.trim()
      }
    };
  }

  if (maybe.type === "stop_all_agents") {
    const managerId = (maybe as { managerId?: unknown }).managerId;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof managerId !== "string" || managerId.trim().length === 0) {
      return { ok: false, error: "stop_all_agents.managerId must be a non-empty string" };
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return { ok: false, error: "stop_all_agents.requestId must be a string when provided" };
    }

    return {
      ok: true,
      command: {
        type: "stop_all_agents",
        managerId: managerId.trim(),
        requestId
      }
    };
  }

  if (maybe.type === "create_manager") {
    const name = (maybe as { name?: unknown }).name;
    const cwd = (maybe as { cwd?: unknown }).cwd;
    const model = (maybe as { model?: unknown }).model;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof name !== "string" || name.trim().length === 0) {
      return { ok: false, error: "create_manager.name must be a non-empty string" };
    }
    if (typeof cwd !== "string" || cwd.trim().length === 0) {
      return { ok: false, error: "create_manager.cwd must be a non-empty string" };
    }
    if (model !== undefined && !isSwarmModelPreset(model)) {
      return {
        ok: false,
        error: `create_manager.model must be one of ${describeSwarmModelPresets()}`
      };
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return { ok: false, error: "create_manager.requestId must be a string when provided" };
    }

    return {
      ok: true,
      command: {
        type: "create_manager",
        name: name.trim(),
        cwd,
        model,
        requestId
      }
    };
  }

  if (maybe.type === "delete_manager") {
    const managerId = (maybe as { managerId?: unknown }).managerId;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof managerId !== "string" || managerId.trim().length === 0) {
      return { ok: false, error: "delete_manager.managerId must be a non-empty string" };
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return { ok: false, error: "delete_manager.requestId must be a string when provided" };
    }

    return {
      ok: true,
      command: {
        type: "delete_manager",
        managerId: managerId.trim(),
        requestId
      }
    };
  }

  if (maybe.type === "list_directories") {
    const path = (maybe as { path?: unknown }).path;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (path !== undefined && typeof path !== "string") {
      return { ok: false, error: "list_directories.path must be a string when provided" };
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return { ok: false, error: "list_directories.requestId must be a string when provided" };
    }

    return {
      ok: true,
      command: {
        type: "list_directories",
        path,
        requestId
      }
    };
  }

  if (maybe.type === "validate_directory") {
    const path = (maybe as { path?: unknown }).path;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (typeof path !== "string" || path.trim().length === 0) {
      return { ok: false, error: "validate_directory.path must be a non-empty string" };
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return { ok: false, error: "validate_directory.requestId must be a string when provided" };
    }

    return {
      ok: true,
      command: {
        type: "validate_directory",
        path,
        requestId
      }
    };
  }

  if (maybe.type === "pick_directory") {
    const defaultPath = (maybe as { defaultPath?: unknown }).defaultPath;
    const requestId = (maybe as { requestId?: unknown }).requestId;

    if (defaultPath !== undefined && typeof defaultPath !== "string") {
      return { ok: false, error: "pick_directory.defaultPath must be a string when provided" };
    }
    if (requestId !== undefined && typeof requestId !== "string") {
      return { ok: false, error: "pick_directory.requestId must be a string when provided" };
    }

    return {
      ok: true,
      command: {
        type: "pick_directory",
        defaultPath: defaultPath?.trim() ? defaultPath : undefined,
        requestId
      }
    };
  }

  if (maybe.type === "user_message") {
    if (typeof maybe.text !== "string") {
      return { ok: false, error: "user_message.text must be a string" };
    }

    const normalizedText = maybe.text.trim();
    const parsedAttachments = parseConversationAttachments(
      (maybe as { attachments?: unknown }).attachments,
      "user_message.attachments"
    );
    if (!parsedAttachments.ok) {
      return { ok: false, error: parsedAttachments.error };
    }

    if (!normalizedText && parsedAttachments.attachments.length === 0) {
      return {
        ok: false,
        error: "user_message must include non-empty text or at least one attachment"
      };
    }

    if (maybe.agentId !== undefined && typeof maybe.agentId !== "string") {
      return { ok: false, error: "user_message.agentId must be a string when provided" };
    }

    if (
      maybe.delivery !== undefined &&
      maybe.delivery !== "auto" &&
      maybe.delivery !== "followUp" &&
      maybe.delivery !== "steer"
    ) {
      return { ok: false, error: "user_message.delivery must be one of auto|followUp|steer" };
    }

    return {
      ok: true,
      command: {
        type: "user_message",
        text: normalizedText,
        attachments: parsedAttachments.attachments.length > 0 ? parsedAttachments.attachments : undefined,
        agentId: maybe.agentId,
        delivery: maybe.delivery
      }
    };
  }

  return { ok: false, error: "Unknown command type" };
}

export function extractRequestId(command: ClientCommand): string | undefined {
  switch (command.type) {
    case "create_manager":
    case "delete_manager":
    case "stop_all_agents":
    case "list_directories":
    case "validate_directory":
    case "pick_directory":
    case "get_all_tasks":
    case "add_task_comment":
    case "complete_task":
    case "update_task":
      return command.requestId;

    case "subscribe":
    case "subscribe_agent_detail":
    case "unsubscribe_agent_detail":
    case "user_message":
    case "kill_agent":
    case "ping":
      return undefined;
  }
}
