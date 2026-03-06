interface ParsedCommand {
  commandPath: string[]
  options: Map<string, string>
}

interface TaskResponse<T = unknown> {
  task?: T
  tasks?: T[]
  error?: string
}

const DEFAULT_API_BASE_URL = "http://127.0.0.1:47187"

async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv)

  if (parsed.commandPath.length === 0 || hasHelpFlag(parsed)) {
    printUsage()
    return
  }

  const [namespace, action, maybeTaskId] = parsed.commandPath
  if (namespace !== "task") {
    throw new Error(`Unknown command: ${parsed.commandPath.join(" ")}`)
  }

  switch (action) {
    case "add":
      await handleTaskAdd(parsed)
      return
    case "list":
      await handleTaskList()
      return
    case "update":
      if (!maybeTaskId) {
        throw new Error("task update requires a task id")
      }
      await handleTaskUpdate(maybeTaskId, parsed)
      return
    case "close":
      if (!maybeTaskId) {
        throw new Error("task close requires a task id")
      }
      await handleTaskClose(maybeTaskId, parsed)
      return
    default:
      throw new Error(`Unknown task command: ${action ?? "(missing)"}`)
  }
}

async function handleTaskAdd(parsed: ParsedCommand): Promise<void> {
  const title = requireOption(parsed, "title")
  const description = parsed.options.get("description")

  const response = await requestJson<TaskResponse>("POST", "/api/tasks", {
    managerId: requireManagerId(),
    title,
    ...(description !== undefined ? { description } : {}),
  })

  printJson(response)
}

async function handleTaskList(): Promise<void> {
  const managerId = requireManagerId()
  const url = new URL("/api/tasks", resolveApiBaseUrl())
  url.searchParams.set("managerId", managerId)

  const response = await requestJson<TaskResponse>("GET", url.pathname + url.search, undefined)
  printJson(response)
}

async function handleTaskUpdate(taskId: string, parsed: ParsedCommand): Promise<void> {
  const title = parsed.options.get("title")
  const description = parsed.options.get("description")

  if (title === undefined && description === undefined) {
    throw new Error("task update requires --title or --description")
  }

  const response = await requestJson<TaskResponse>("PATCH", `/api/tasks/${encodeURIComponent(taskId)}`, {
    managerId: requireManagerId(),
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
  })

  printJson(response)
}

async function handleTaskClose(taskId: string, parsed: ParsedCommand): Promise<void> {
  const comment = parsed.options.get("comment")

  const response = await requestJson<TaskResponse>("PATCH", `/api/tasks/${encodeURIComponent(taskId)}`, {
    managerId: requireManagerId(),
    status: "completed",
    ...(comment !== undefined ? { comment } : {}),
  })

  printJson(response)
}

function parseArgs(argv: string[]): ParsedCommand {
  const commandPath: string[] = []
  const options = new Map<string, string>()

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith("--")) {
      commandPath.push(token)
      continue
    }

    const optionName = token.slice(2)
    if (!optionName) {
      throw new Error("Invalid empty option name")
    }

    if (optionName === "help") {
      options.set(optionName, "true")
      continue
    }

    const next = argv[index + 1]
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`Option --${optionName} requires a value`)
    }

    options.set(optionName, next)
    index += 1
  }

  return { commandPath, options }
}

function hasHelpFlag(parsed: ParsedCommand): boolean {
  return parsed.options.has("help") || parsed.commandPath.includes("--help")
}

function requireOption(parsed: ParsedCommand, name: string): string {
  const value = parsed.options.get(name)
  if (value === undefined) {
    throw new Error(`Missing required option --${name}`)
  }

  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new Error(`Option --${name} must be a non-empty string`)
  }

  return trimmed
}

function requireManagerId(): string {
  const managerId = process.env.MIDDLEMAN_AGENT_ID?.trim()
  if (!managerId) {
    throw new Error("MIDDLEMAN_AGENT_ID is required")
  }

  return managerId
}

function resolveApiBaseUrl(): string {
  const explicit = process.env.MIDDLEMAN_API_BASE_URL?.trim()
  if (explicit) {
    return explicit
  }

  const host = process.env.MIDDLEMAN_HOST?.trim() || "127.0.0.1"
  const port = process.env.MIDDLEMAN_PORT?.trim() || "47187"
  return `http://${host}:${port}`
}

async function requestJson<T>(method: string, path: string, body: Record<string, unknown> | undefined): Promise<T> {
  const url = new URL(path, resolveApiBaseUrl())
  const response = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })

  const text = await response.text()
  const payload = text.trim().length > 0 ? (JSON.parse(text) as T & { error?: string }) : ({} as T & { error?: string })

  if (!response.ok) {
    throw new Error(payload.error ?? `Request failed with status ${response.status}`)
  }

  return payload
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function printUsage(): void {
  const usage = [
    "Usage:",
    "  middleman task add --title \"...\" [--description \"...\"]",
    "  middleman task list",
    "  middleman task update <id> --title \"...\" [--description \"...\"]",
    "  middleman task close <id> [--comment \"...\"]",
    "",
    "Environment:",
    "  MIDDLEMAN_AGENT_ID   Manager/agent id used for task requests",
    `  MIDDLEMAN_API_BASE_URL   Backend base URL (default: ${DEFAULT_API_BASE_URL})`,
  ].join("\n")

  process.stdout.write(`${usage}\n`)
}

void main(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exit(1)
})
