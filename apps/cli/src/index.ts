import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

interface ParsedCommand {
  commandPath: string[]
  options: Map<string, string[]>
}

interface ScheduleResponse<T = unknown> {
  action?: 'add' | 'list' | 'remove'
  count?: number
  error?: string
  managerId?: string
  ok?: boolean
  removed?: boolean
  schedule?: T
  schedules?: T[]
}

interface StartCommandOptions {
  projectRoot?: string
  dataDir?: string
  host?: string
  port?: number
  openBrowser: boolean
  help: boolean
}

interface BackendEntrypoint {
  startServer: (options?: {
    installDir?: string
    projectRoot?: string
    dataDir?: string
    cliBinDir?: string
    host?: string
    port?: number
    loadEnvFiles?: boolean
    registerSignalHandlers?: boolean
  }) => Promise<{ config: { host: string; port: number; paths: { dataDir: string; projectRoot: string } } }>
}

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:47187'
const CLI_MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const SUPPRESS_OPEN_ON_RESTART_ENV_VAR = 'MIDDLEMAN_SUPPRESS_OPEN_ON_RESTART'

export async function runCli(argv: string[]): Promise<void> {
  if (argv.length === 0) {
    await handleStart([])
    return
  }

  const [command, subcommand] = argv
  if (command === '--help' || command === '-h') {
    printGeneralUsage()
    return
  }

  if (command?.startsWith('-')) {
    await handleStart(argv)
    return
  }

  switch (command) {
    case 'start':
      await handleStart(argv.slice(1))
      return
    case 'doctor':
      await handleDoctor()
      return
    case 'task':
      throw new Error('`middleman task` has been removed.')
    case 'schedule':
      await handleSchedule(argv.slice(1))
      return
    case 'image':
      if (subcommand !== 'generate') {
        throw new Error('Usage: middleman image generate --prompt "..." --output "/path/to/file.png"')
      }
      await runHelperScript(resolveSkillScriptPath('image-generation', 'generate.js'), argv.slice(2))
      return
    case 'brave-search':
      if (subcommand === 'search') {
        await runHelperScript(resolveSkillScriptPath('brave-search', 'search.js'), argv.slice(2))
        return
      }
      if (subcommand === 'content') {
        await runHelperScript(resolveSkillScriptPath('brave-search', 'content.js'), argv.slice(2))
        return
      }
      throw new Error('Usage: middleman brave-search <search|content> ...')
    default:
      throw new Error(`Unknown command: ${argv.join(' ')}`)
  }
}

async function handleStart(argv: string[]): Promise<void> {
  const parsed = parseStartArgs(argv)
  if (parsed.help) {
    printStartUsage()
    return
  }

  const installDir = resolveInstallDir()
  const cliBinDir = resolveCliBinDir()
  const backend = await loadBackendEntrypoint()

  process.env.MIDDLEMAN_INSTALL_DIR = installDir
  process.env.MIDDLEMAN_CLI_BIN_DIR = cliBinDir
  if (parsed.projectRoot) {
    process.env.MIDDLEMAN_PROJECT_ROOT = parsed.projectRoot
  }
  if (parsed.dataDir) {
    process.env.MIDDLEMAN_HOME = parsed.dataDir
  }

  const { config } = await backend.startServer({
    installDir,
    cliBinDir,
    projectRoot: parsed.projectRoot,
    dataDir: parsed.dataDir,
    host: parsed.host,
    port: parsed.port,
    loadEnvFiles: true,
    registerSignalHandlers: true,
  })

  const url = `http://${config.host}:${config.port}`
  process.stdout.write(`Middleman listening on ${url}\n`)
  process.stdout.write(`Data dir: ${config.paths.dataDir}\n`)
  process.stdout.write(`Project root: ${config.paths.projectRoot}\n`)

  const suppressOpenOnRestart = process.env[SUPPRESS_OPEN_ON_RESTART_ENV_VAR] === '1'
  delete process.env[SUPPRESS_OPEN_ON_RESTART_ENV_VAR]

  if (parsed.openBrowser && !suppressOpenOnRestart) {
    openBrowser(url)
  }
}

async function handleDoctor(): Promise<void> {
  const installDir = resolveInstallDir()
  const cliBinDir = resolveCliBinDir()
  const projectRoot = resolveProjectRoot()
  const dataDir = resolveDataDir()
  const uiCandidates = resolveUiCandidates(installDir)

  printJson({
    ok: true,
    installDir,
    cliBinDir,
    projectRoot,
    dataDir,
    uiCandidates: uiCandidates.map((candidate) => ({
      path: candidate,
      exists: existsSync(candidate),
    })),
    apiBaseUrl: resolveApiBaseUrl(),
  })
}

async function handleSchedule(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv)

  if (parsed.commandPath.length === 0 || hasHelpFlag(parsed)) {
    printScheduleUsage()
    return
  }

  const managerId = requireScheduleManagerId(parsed)
  const [action, maybeScheduleId] = parsed.commandPath

  switch (action) {
    case 'add':
      await handleScheduleAdd(managerId, parsed)
      return
    case 'list':
      await handleScheduleList(managerId)
      return
    case 'remove':
      if (!maybeScheduleId) {
        throw new Error('schedule remove requires a schedule id')
      }
      await handleScheduleRemove(managerId, maybeScheduleId)
      return
    default:
      throw new Error(`Unknown schedule command: ${action ?? '(missing)'}`)
  }
}

async function handleScheduleAdd(managerId: string, parsed: ParsedCommand): Promise<void> {
  const cron = requireSingleOption(parsed, 'cron')
  const message = requireSingleOption(parsed, 'message')
  const name = getOptionalSingleOption(parsed, 'name')
  const description = getOptionalSingleOption(parsed, 'description')
  const timezone = getOptionalSingleOption(parsed, 'timezone')
  const oneShot = getBooleanOption(parsed, 'one-shot')
  const enabled = !getBooleanOption(parsed, 'disabled')

  const response = await requestJson<ScheduleResponse>(
    'POST',
    `/api/managers/${encodeURIComponent(managerId)}/schedules`,
    {
      cron,
      message,
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(timezone !== undefined ? { timezone } : {}),
      ...(oneShot ? { oneShot: true } : {}),
      ...(enabled ? {} : { enabled: false }),
    },
  )

  printJson(response)
}

async function handleScheduleList(managerId: string): Promise<void> {
  const response = await requestJson<ScheduleResponse>(
    'GET',
    `/api/managers/${encodeURIComponent(managerId)}/schedules`,
    undefined,
  )
  printJson({
    ok: true,
    action: 'list',
    managerId,
    count: Array.isArray(response.schedules) ? response.schedules.length : 0,
    schedules: response.schedules ?? [],
  })
}

async function handleScheduleRemove(managerId: string, scheduleId: string): Promise<void> {
  const response = await requestJson<ScheduleResponse>(
    'DELETE',
    `/api/managers/${encodeURIComponent(managerId)}/schedules/${encodeURIComponent(scheduleId)}`,
    undefined,
  )
  printJson(response)
}

function parseStartArgs(argv: string[]): StartCommandOptions {
  const parsed: StartCommandOptions = {
    openBrowser: false,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    switch (token) {
      case '--help':
      case '-h':
        parsed.help = true
        break
      case '--open':
        parsed.openBrowser = true
        break
      case '--no-open':
        parsed.openBrowser = false
        break
      case '--project':
        parsed.projectRoot = requireOptionValue(argv, index, '--project')
        index += 1
        break
      case '--home':
        parsed.dataDir = requireOptionValue(argv, index, '--home')
        index += 1
        break
      case '--host':
        parsed.host = requireOptionValue(argv, index, '--host')
        index += 1
        break
      case '--port': {
        const rawPort = requireOptionValue(argv, index, '--port')
        const port = Number.parseInt(rawPort, 10)
        if (!Number.isInteger(port) || port <= 0) {
          throw new Error('--port must be a positive integer')
        }
        parsed.port = port
        index += 1
        break
      }
      default:
        throw new Error(`Unknown start option: ${token}`)
    }
  }

  return parsed
}

function requireOptionValue(argv: string[], index: number, optionName: string): string {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${optionName} requires a value`)
  }

  return value
}

function parseArgs(argv: string[]): ParsedCommand {
  const commandPath: string[] = []
  const options = new Map<string, string[]>()
  const booleanOptions = new Set(['help', 'one-shot', 'disabled'])

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      commandPath.push(token)
      continue
    }

    const optionName = token.slice(2)
    if (!optionName) {
      throw new Error('Invalid empty option name')
    }

    if (booleanOptions.has(optionName)) {
      options.set(optionName, ['true'])
      continue
    }

    if (optionName === 'options') {
      const values: string[] = []
      while (argv[index + 1] !== undefined && !argv[index + 1]!.startsWith('--')) {
        values.push(argv[index + 1]!)
        index += 1
      }

      if (values.length === 0) {
        throw new Error('Option --options requires at least one value')
      }

      options.set(optionName, values)
      continue
    }

    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`Option --${optionName} requires a value`)
    }

    options.set(optionName, [next])
    index += 1
  }

  return { commandPath, options }
}

function hasHelpFlag(parsed: ParsedCommand): boolean {
  return parsed.options.has('help') || parsed.commandPath.includes('--help')
}

function requireSingleOption(parsed: ParsedCommand, name: string): string {
  const value = getOptionalSingleOption(parsed, name)
  if (value === undefined) {
    throw new Error(`Missing required option --${name}`)
  }

  return value
}

function getOptionalSingleOption(parsed: ParsedCommand, name: string): string | undefined {
  const values = parsed.options.get(name)
  if (values === undefined) {
    return undefined
  }

  if (values.length !== 1) {
    throw new Error(`Option --${name} accepts exactly one value`)
  }

  const trimmed = values[0]?.trim()
  if (!trimmed) {
    throw new Error(`Option --${name} must be a non-empty string`)
  }

  return trimmed
}

function requireMultiOption(parsed: ParsedCommand, name: string): string[] {
  const values = parsed.options.get(name)
  if (!values || values.length === 0) {
    throw new Error(`Missing required option --${name}`)
  }

  return values.map((value) => {
    const trimmed = value.trim()
    if (!trimmed) {
      throw new Error(`Option --${name} must not contain blank values`)
    }

    return trimmed
  })
}

function requireScheduleManagerId(parsed: ParsedCommand): string {
  const explicitManagerId = getOptionalSingleOption(parsed, 'manager')
  if (explicitManagerId) {
    return explicitManagerId
  }

  const managerId = process.env.MIDDLEMAN_MANAGER_ID?.trim()
  if (managerId) {
    return managerId
  }

  const fallbackAgentId = process.env.MIDDLEMAN_AGENT_ID?.trim()
  if (fallbackAgentId) {
    return fallbackAgentId
  }

  throw new Error('Pass --manager <id> or set MIDDLEMAN_MANAGER_ID/MIDDLEMAN_AGENT_ID')
}

function getBooleanOption(parsed: ParsedCommand, name: string): boolean {
  return parsed.options.get(name)?.[0] === 'true'
}

function resolveApiBaseUrl(): string {
  const explicit = process.env.MIDDLEMAN_API_BASE_URL?.trim()
  if (explicit) {
    return explicit
  }

  const host = process.env.MIDDLEMAN_HOST?.trim() || '127.0.0.1'
  const port = process.env.MIDDLEMAN_PORT?.trim() || '47187'
  return `http://${host}:${port}`
}

async function requestJson<T>(method: string, path: string, body: Record<string, unknown> | undefined): Promise<T> {
  const url = new URL(path, resolveApiBaseUrl())
  const response = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })

  const text = await response.text()
  const payload = text.trim().length > 0 ? (JSON.parse(text) as T & { error?: string }) : ({} as T & { error?: string })

  if (!response.ok) {
    throw new Error(payload.error ?? `Request failed with status ${response.status}`)
  }

  return payload
}

async function loadBackendEntrypoint(): Promise<BackendEntrypoint> {
  const candidates = [
    resolve(CLI_MODULE_DIR, '../backend/index.js'),
    resolve(CLI_MODULE_DIR, '../../backend/dist/index.js'),
    resolve(CLI_MODULE_DIR, '../../backend/src/index.ts'),
  ]

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue
    }

    return (await import(pathToFileURL(candidate).href)) as BackendEntrypoint
  }

  throw new Error('Unable to locate the backend entrypoint.')
}

function resolveInstallDir(): string {
  const configuredInstallDir = process.env.MIDDLEMAN_INSTALL_DIR?.trim()
  if (configuredInstallDir) {
    return resolve(configuredInstallDir)
  }

  let current = resolve(CLI_MODULE_DIR)
  let nearestPackageRoot: string | null = null

  while (true) {
    const packageJsonPath = resolve(current, 'package.json')
    if (existsSync(packageJsonPath)) {
      if (nearestPackageRoot === null) {
        nearestPackageRoot = current
      }

      if (readPackageName(packageJsonPath) === 'middleman') {
        return current
      }
    }

    if (existsSync(resolve(current, 'pnpm-workspace.yaml'))) {
      return current
    }

    const parent = dirname(current)
    if (parent === current) {
      break
    }

    current = parent
  }

  return nearestPackageRoot ?? resolve(process.cwd())
}

function readPackageName(packageJsonPath: string): string | undefined {
  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { name?: unknown }
    return typeof packageJson.name === 'string' ? packageJson.name : undefined
  } catch {
    return undefined
  }
}

function resolveCliBinDir(): string {
  const configuredCliBinDir = process.env.MIDDLEMAN_CLI_BIN_DIR?.trim()
  if (configuredCliBinDir) {
    return resolve(configuredCliBinDir)
  }

  const invokedPath = process.argv[1]
  if (invokedPath) {
    try {
      return dirname(realpathSync(invokedPath))
    } catch {
      return dirname(resolve(invokedPath))
    }
  }

  return dirname(resolveInstallDir())
}

function resolveProjectRoot(): string {
  const configuredProjectRoot = process.env.MIDDLEMAN_PROJECT_ROOT?.trim()
  if (configuredProjectRoot) {
    return resolve(configuredProjectRoot)
  }

  return resolve(process.cwd())
}

function resolveDataDir(): string {
  const configuredDataDir = process.env.MIDDLEMAN_HOME?.trim()
  if (configuredDataDir) {
    return resolve(configuredDataDir)
  }

  return resolve(homedir(), '.middleman')
}

function resolveSkillScriptPath(skillName: string, fileName: string): string {
  const installDir = resolveInstallDir()
  const candidates = [
    resolve(installDir, 'assets', 'skills', skillName, fileName),
    resolve(installDir, 'apps', 'backend', 'dist', 'assets', 'skills', skillName, fileName),
    resolve(installDir, 'apps', 'backend', 'src', 'swarm', 'skills', 'builtins', skillName, fileName),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }

  throw new Error(`Unable to locate ${skillName}/${fileName}.`)
}

function resolveUiCandidates(installDir: string): string[] {
  return [
    resolve(installDir, 'ui'),
    resolve(installDir, 'apps', 'backend', 'dist', 'public'),
    resolve(installDir, 'apps', 'ui', '.output', 'public'),
  ]
}

async function runHelperScript(scriptPath: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: 'inherit',
      env: {
        ...process.env,
        MIDDLEMAN_INSTALL_DIR: resolveInstallDir(),
        MIDDLEMAN_CLI_BIN_DIR: resolveCliBinDir(),
        MIDDLEMAN_PROJECT_ROOT: resolveProjectRoot(),
        MIDDLEMAN_HOME: resolveDataDir(),
      },
    })

    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`Helper command exited via signal ${signal}`))
        return
      }

      if ((code ?? 0) !== 0) {
        reject(new Error(`Helper command exited with status ${code ?? 1}`))
        return
      }

      resolvePromise()
    })
  })
}

function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]

  const child = spawn(command, args, {
    stdio: 'ignore',
    detached: true,
  })
  child.unref()
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function printGeneralUsage(): void {
  const usage = [
    'Usage:',
    '  middleman',
    '  middleman start [--project <path>] [--home <path>] [--host <host>] [--port <port>] [--open]',
    '  middleman schedule <add|remove|list> ...',
    '  middleman image generate ...',
    '  middleman brave-search <search|content> ...',
    '  middleman doctor',
    '',
    'Run `middleman start --help` or `middleman schedule --help` for command-specific help.',
  ].join('\n')

  process.stdout.write(`${usage}\n`)
}

function printStartUsage(): void {
  const usage = [
    'Usage:',
    '  middleman start [--project <path>] [--home <path>] [--host <host>] [--port <port>] [--open]',
    '  middleman [same start options]',
    '',
    'Options:',
    '  --project <path>   Use a different project root instead of the current directory',
    '  --home <path>      Use a different data directory instead of ~/.middleman',
    '  --host <host>      Override the server host',
    '  --port <port>      Override the server port',
    '  --open             Open the app in a browser after startup',
    '  --no-open          Do not open the browser',
  ].join('\n')

  process.stdout.write(`${usage}\n`)
}

function printScheduleUsage(): void {
  const usage = [
    'Usage:',
    '  middleman schedule add --cron "..." --message "..." [--description "..."] [--name "..."] [--timezone "America/Los_Angeles"] [--one-shot] [--manager "<id>"]',
    '  middleman schedule list [--manager "<id>"]',
    '  middleman schedule remove <id> [--manager "<id>"]',
    '',
    'Environment:',
    '  MIDDLEMAN_MANAGER_ID   Preferred manager id when running inside an agent session',
    '  MIDDLEMAN_AGENT_ID     Fallback manager/agent id when no explicit manager is provided',
    `  MIDDLEMAN_API_BASE_URL   Backend base URL (default: ${DEFAULT_API_BASE_URL})`,
  ].join('\n')

  process.stdout.write(`${usage}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void runCli(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    process.exit(1)
  })
}
