import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { UserTask, UserTaskComment } from "../swarm/types.js";

const TASKS_FILE_NAME = "tasks.json";

interface TasksFile {
  tasks: UserTask[];
}

function cloneTask(task: UserTask): UserTask {
  return {
    ...task,
    comments: task.comments?.map((comment) => ({
      ...comment
    }))
  };
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function compareTasks(left: UserTask, right: UserTask): number {
  if (left.createdAt !== right.createdAt) {
    return right.createdAt.localeCompare(left.createdAt);
  }

  return right.id.localeCompare(left.id);
}

function validateComment(candidate: unknown): UserTaskComment | undefined {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return undefined;
  }

  const comment = candidate as Partial<UserTaskComment>;
  if (
    typeof comment.id !== "string" ||
    comment.id.trim().length === 0 ||
    typeof comment.body !== "string" ||
    comment.body.trim().length === 0 ||
    typeof comment.createdAt !== "string" ||
    comment.createdAt.trim().length === 0 ||
    comment.type !== "completion"
  ) {
    return undefined;
  }

  return {
    id: comment.id.trim(),
    body: comment.body.trim(),
    createdAt: comment.createdAt.trim(),
    type: "completion"
  };
}

function validateTask(candidate: unknown): UserTask | undefined {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return undefined;
  }

  const task = candidate as Partial<UserTask>;
  if (
    typeof task.id !== "string" ||
    task.id.trim().length === 0 ||
    typeof task.managerId !== "string" ||
    task.managerId.trim().length === 0 ||
    typeof task.title !== "string" ||
    task.title.trim().length === 0 ||
    (task.description !== undefined && typeof task.description !== "string") ||
    (task.status !== "pending" && task.status !== "completed") ||
    typeof task.createdAt !== "string" ||
    task.createdAt.trim().length === 0 ||
    (task.completedAt !== undefined && typeof task.completedAt !== "string") ||
    (task.completionComment !== undefined && typeof task.completionComment !== "string") ||
    (task.comments !== undefined && !Array.isArray(task.comments))
  ) {
    return undefined;
  }

  const comments = Array.isArray(task.comments)
    ? task.comments.map((comment) => validateComment(comment)).filter((comment): comment is UserTaskComment => Boolean(comment))
    : undefined;

  return {
    id: task.id.trim(),
    managerId: task.managerId.trim(),
    title: task.title.trim(),
    description: normalizeOptionalText(task.description),
    status: task.status,
    createdAt: task.createdAt,
    completedAt: normalizeOptionalText(task.completedAt),
    completionComment: normalizeOptionalText(task.completionComment),
    comments: comments && comments.length > 0 ? comments : undefined
  };
}

export function getTasksFilePath(dataDir: string): string {
  return resolve(dataDir, TASKS_FILE_NAME);
}

export class TaskStorage {
  private readonly filePath: string;
  private readonly tasks = new Map<string, UserTask>();

  constructor(
    private readonly options: {
      dataDir: string;
      now: () => string;
      generateId?: () => string;
    }
  ) {
    this.filePath = getTasksFilePath(options.dataDir);
  }

  async load(): Promise<void> {
    this.tasks.clear();

    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<TasksFile>;
      const storedTasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];

      for (const candidate of storedTasks) {
        const task = validateTask(candidate);
        if (!task) {
          continue;
        }

        this.tasks.set(task.id, task);
      }
    } catch {
      // Missing or invalid task files should not block boot.
    }
  }

  listAll(): UserTask[] {
    return Array.from(this.tasks.values()).map(cloneTask).sort(compareTasks);
  }

  get(taskId: string): UserTask | undefined {
    const task = this.tasks.get(taskId);
    return task ? cloneTask(task) : undefined;
  }

  listOutstanding(managerId: string): UserTask[] {
    return this.listAll().filter((task) => task.managerId === managerId && task.status === "pending");
  }

  async create(input: { managerId: string; title: string; description?: string }): Promise<UserTask> {
    const task: UserTask = {
      id: this.options.generateId?.() ?? randomUUID(),
      managerId: input.managerId,
      title: input.title,
      description: normalizeOptionalText(input.description),
      status: "pending",
      createdAt: this.options.now()
    };

    this.tasks.set(task.id, task);
    await this.save();
    return cloneTask(task);
  }

  async complete(taskId: string, options?: { comment?: string }): Promise<UserTask> {
    const existing = this.tasks.get(taskId);
    if (!existing) {
      throw new Error(`Unknown task: ${taskId}`);
    }

    if (existing.status === "completed") {
      return cloneTask(existing);
    }

    const completedAt = this.options.now();
    const completionComment = normalizeOptionalText(options?.comment);
    const completedTask: UserTask = {
      ...existing,
      status: "completed",
      completedAt,
      completionComment,
      comments: [
        ...(existing.comments ?? []),
        {
          id: this.options.generateId?.() ?? randomUUID(),
          body: completionComment ?? "Task completed.",
          createdAt: completedAt,
          type: "completion"
        }
      ]
    };

    this.tasks.set(taskId, completedTask);
    await this.save();
    return cloneTask(completedTask);
  }

  async update(
    taskId: string,
    input: {
      title?: string;
      description?: string;
    }
  ): Promise<UserTask> {
    const existing = this.tasks.get(taskId);
    if (!existing) {
      throw new Error(`Unknown task: ${taskId}`);
    }

    const nextTitle =
      input.title !== undefined
        ? (() => {
            const trimmed = input.title.trim();
            if (trimmed.length === 0) {
              throw new Error("update_task title must be a non-empty string");
            }
            return trimmed;
          })()
        : existing.title;

    const nextDescription =
      input.description !== undefined
        ? normalizeOptionalText(input.description)
        : existing.description;

    const updatedTask: UserTask = {
      ...existing,
      title: nextTitle,
      description: nextDescription
    };

    this.tasks.set(taskId, updatedTask);
    await this.save();
    return cloneTask(updatedTask);
  }

  async deleteForManager(managerId: string): Promise<string[]> {
    const deletedTaskIds: string[] = [];

    for (const [taskId, task] of this.tasks.entries()) {
      if (task.managerId !== managerId) {
        continue;
      }

      this.tasks.delete(taskId);
      deletedTaskIds.push(taskId);
    }

    if (deletedTaskIds.length > 0) {
      await this.save();
    }

    return deletedTaskIds.sort((left, right) => left.localeCompare(right));
  }

  private async save(): Promise<void> {
    const payload: TasksFile = {
      tasks: this.listAll().sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    };

    const tmpPath = `${this.filePath}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(tmpPath, this.filePath);
  }
}
