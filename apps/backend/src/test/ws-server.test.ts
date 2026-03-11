import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import WebSocket from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { SessionManager } from '@mariozechner/pi-coding-agent'
import { SwarmManager } from '../swarm/swarm-manager.js'
import type {
  AgentContextUsage,
  AgentDescriptor,
  RequestedDeliveryMode,
  SendMessageReceipt,
  SwarmConfig,
} from '../swarm/types.js'
import type { SwarmAgentRuntime } from '../swarm/runtime-types.js'
import { getControlPidFilePath, getLegacyControlPidFilePath } from '../reboot/control-pid.js'
import { getScheduleFilePath } from '../scheduler/schedule-storage.js'
import { SwarmWebSocketServer } from '../ws/server.js'
import type { ServerEvent } from '@middleman/protocol'

class FakeRuntime {
  readonly descriptor: AgentDescriptor
  private readonly sessionManager: SessionManager
  compactCalls: Array<string | undefined> = []
  terminateCalls = 0
  stopInFlightCalls: Array<{ abort?: boolean } | undefined> = []

  constructor(descriptor: AgentDescriptor) {
    this.descriptor = descriptor
    this.sessionManager = SessionManager.open(descriptor.sessionFile)
  }

  getStatus(): AgentDescriptor['status'] {
    return this.descriptor.status
  }

  getPendingCount(): number {
    return 0
  }

  getContextUsage(): AgentContextUsage | undefined {
    return undefined
  }

  async sendMessage(_message: string, _delivery: RequestedDeliveryMode = 'auto'): Promise<SendMessageReceipt> {
    this.sessionManager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'ack' }],
    } as any)

    return {
      targetAgentId: this.descriptor.agentId,
      deliveryId: 'fake-delivery',
      acceptedMode: 'prompt',
    }
  }

  async terminate(): Promise<void> {
    this.terminateCalls += 1
  }

  async stopInFlight(options?: { abort?: boolean }): Promise<void> {
    this.stopInFlightCalls.push(options)
    this.descriptor.status = 'idle'
  }

  async compact(customInstructions?: string): Promise<unknown> {
    this.compactCalls.push(customInstructions)
    return {
      status: 'ok',
      customInstructions: customInstructions ?? null,
    }
  }

  getCustomEntries(customType: string): unknown[] {
    const entries = this.sessionManager.getEntries()
    return entries
      .filter((entry) => entry.type === 'custom' && entry.customType === customType)
      .map((entry) => (entry.type === 'custom' ? entry.data : undefined))
      .filter((entry) => entry !== undefined)
  }

  appendCustomEntry(customType: string, data?: unknown): void {
    this.sessionManager.appendCustomEntry(customType, data)
  }
}

class TestSwarmManager extends SwarmManager {
  pickedDirectoryPath: string | null = null
  lastPickedDirectoryDefaultPath: string | undefined
  readonly runtimeByAgentId = new Map<string, FakeRuntime>()

  protected override async createRuntimeForDescriptor(descriptor: AgentDescriptor): Promise<SwarmAgentRuntime> {
    const runtime = new FakeRuntime(descriptor)
    this.runtimeByAgentId.set(descriptor.agentId, runtime)
    return runtime as unknown as SwarmAgentRuntime
  }

  override async pickDirectory(defaultPath?: string): Promise<string | null> {
    this.lastPickedDirectoryDefaultPath = defaultPath
    return this.pickedDirectoryPath
  }
}

async function getAvailablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Unable to allocate port')
  }

  const port = address.port
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
  })

  return port
}

async function makeTempConfig(port: number, allowNonManagerSubscriptions = false): Promise<SwarmConfig> {
  const root = await mkdtemp(join(tmpdir(), 'swarm-ws-test-'))
  const installDir = resolve(process.cwd(), '../..')
  const dataDir = join(root, 'data')
  const runDir = join(dataDir, 'run')
  const logsDir = join(dataDir, 'logs')
  const schedulesDir = join(dataDir, 'schedules')
  const integrationsDir = join(dataDir, 'integrations')
  const swarmDir = join(dataDir, 'swarm')
  const sessionsDir = join(dataDir, 'sessions')
  const uploadsDir = join(dataDir, 'uploads')
  const authDir = join(dataDir, 'auth')
  const agentDir = join(dataDir, 'agent')
  const managerAgentDir = join(agentDir, 'manager')
  const projectSwarmDir = join(root, '.swarm')
  const projectArchetypesDir = join(projectSwarmDir, 'archetypes')
  const projectSkillsDir = join(projectSwarmDir, 'skills')
  const memoryDir = join(dataDir, 'memory')
  const memoryFile = join(memoryDir, 'manager.md')
  const projectMemorySkillFile = join(projectSkillsDir, 'memory', 'SKILL.md')
  const uiDir = join(root, 'public')

  await mkdir(swarmDir, { recursive: true })
  await mkdir(sessionsDir, { recursive: true })
  await mkdir(uploadsDir, { recursive: true })
  await mkdir(authDir, { recursive: true })
  await mkdir(memoryDir, { recursive: true })
  await mkdir(agentDir, { recursive: true })
  await mkdir(managerAgentDir, { recursive: true })
  await mkdir(projectArchetypesDir, { recursive: true })
  await mkdir(uiDir, { recursive: true })

  return {
    host: '127.0.0.1',
    port,
    debug: false,
    allowNonManagerSubscriptions,
    managerId: 'manager',
    managerDisplayName: 'Manager',
    defaultModel: {
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'medium',
    },
    defaultCwd: root,
    cwdAllowlistRoots: [root, join(root, 'worktrees')],
    paths: {
      installDir,
      installAssetsDir: resolve(process.cwd(), 'src', 'swarm'),
      installArchetypesDir: resolve(process.cwd(), 'src', 'swarm', 'archetypes', 'builtins'),
      installSkillsDir: resolve(process.cwd(), 'src', 'swarm', 'skills', 'builtins'),
      cliBinDir: resolve(process.cwd(), '..', 'cli', 'bin'),
      uiDir,
      projectRoot: root,
      projectSwarmDir,
      projectArchetypesDir,
      projectSkillsDir,
      projectMemorySkillFile,
      dataDir,
      configFile: join(dataDir, 'config.json'),
      configEnvFile: join(dataDir, 'config.env'),
      runDir,
      logsDir,
      schedulesDir,
      integrationsDir,
      swarmDir,
      sessionsDir,
      uploadsDir,
      authDir,
      authFile: join(authDir, 'auth.json'),
      agentDir,
      managerAgentDir,
      memoryDir,
      memoryFile,
      agentsStoreFile: join(swarmDir, 'agents.json'),
      secretsFile: join(dataDir, 'secrets.json'),
      schedulesFile: getScheduleFilePath(dataDir, 'manager'),
    },
  }
}

async function bootWithDefaultManager(manager: TestSwarmManager, config: SwarmConfig): Promise<AgentDescriptor> {
  await manager.boot()
  const managerId = config.managerId ?? 'manager'
  const managerName = config.managerDisplayName ?? managerId

  const existingManager = manager.listAgents().find(
    (descriptor) => descriptor.agentId === managerId && descriptor.role === 'manager',
  )
  if (existingManager) {
    return existingManager
  }

  return manager.createManager(managerId, {
    name: managerName,
    cwd: config.defaultCwd,
  })
}

async function waitForEvent(
  events: ServerEvent[],
  predicate: (event: ServerEvent) => boolean,
  timeoutMs = 2000,
): Promise<ServerEvent> {
  const started = Date.now()

  while (Date.now() - started < timeoutMs) {
    const found = events.find(predicate)
    if (found) return found

    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  throw new Error('Timed out waiting for websocket event')
}

describe('SwarmWebSocketServer', () => {
  it('connect + subscribe + user_message yields manager feed events', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')

    client.send(JSON.stringify({ type: 'subscribe' }))

    await waitForEvent(events, (event) => event.type === 'ready')
    await waitForEvent(events, (event) => event.type === 'agents_snapshot')
    await waitForEvent(events, (event) => event.type === 'conversation_history')

    client.send(JSON.stringify({ type: 'user_message', text: 'hello manager' }))

    const userEvent = await waitForEvent(
      events,
      (event) =>
        event.type === 'conversation_message' &&
        event.source === 'user_input' &&
        event.text === 'hello manager',
    )

    expect(userEvent.type).toBe('conversation_message')
    if (userEvent.type === 'conversation_message') {
      expect(userEvent.sourceContext).toEqual({ channel: 'web' })
    }

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('accepts POST /api/reboot and signals the daemon pid asynchronously', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const daemonPid = 54321
    const pidFile = getControlPidFilePath(config.paths.runDir)
    await writeFile(pidFile, `${daemonPid}\n`, 'utf8')

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/reboot`, {
        method: 'POST',
      })

      expect(response.status).toBe(200)
      await new Promise((resolve) => setTimeout(resolve, 60))

      expect(killSpy).toHaveBeenCalledWith(daemonPid, 0)
      expect(killSpy).toHaveBeenCalledWith(daemonPid, 'SIGUSR1')
    } finally {
      killSpy.mockRestore()
      await rm(pidFile, { force: true })
      await server.stop()
    }
  })

  it('accepts POST /api/reboot and falls back to the legacy installDir pid file', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const daemonPid = 65432
    const pidFile = getLegacyControlPidFilePath(config.paths.installDir)
    await writeFile(pidFile, `${daemonPid}\n`, 'utf8')

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/reboot`, {
        method: 'POST',
      })

      expect(response.status).toBe(200)
      await new Promise((resolve) => setTimeout(resolve, 60))

      expect(killSpy).toHaveBeenCalledWith(daemonPid, 0)
      expect(killSpy).toHaveBeenCalledWith(daemonPid, 'SIGUSR1')
    } finally {
      killSpy.mockRestore()
      await rm(pidFile, { force: true })
      await server.stop()
    }
  })

  it('compacts manager context through POST /api/agents/:agentId/compact', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/agents/manager/compact`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          customInstructions: 'Preserve unresolved TODOs in the summary.',
        }),
      })

      expect(response.status).toBe(200)
      const payload = (await response.json()) as {
        ok: boolean
        agentId: string
        result: { status: string; customInstructions: string | null }
      }

      expect(payload.ok).toBe(true)
      expect(payload.agentId).toBe('manager')
      expect(payload.result).toEqual({
        status: 'ok',
        customInstructions: 'Preserve unresolved TODOs in the summary.',
      })

      const runtime = manager.runtimeByAgentId.get('manager')
      expect(runtime?.compactCalls).toEqual(['Preserve unresolved TODOs in the summary.'])

      const history = manager.getConversationHistory('manager')
      expect(
        history.some(
          (event) =>
            event.type === 'conversation_message' &&
            event.source === 'system' &&
            event.text === 'Compacting manager context...',
        ),
      ).toBe(true)
      expect(
        history.some(
          (event) =>
            event.type === 'conversation_message' &&
            event.source === 'system' &&
            event.text === 'Compaction complete.',
        ),
      ).toBe(true)
    } finally {
      await server.stop()
    }
  })

  it('reads allowed files through POST /api/read-file', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const artifactPath = join(config.paths.projectRoot, 'artifact.md')
    const artifactContent = '# Artifact\n\nHello from Swarm.\n'
    await writeFile(artifactPath, artifactContent, 'utf8')

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/read-file`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          path: artifactPath,
        }),
      })

      expect(response.status).toBe(200)
      const payload = (await response.json()) as { path: string; content: string }

      expect(payload.path).toBe(artifactPath)
      expect(payload.content).toBe(artifactContent)
    } finally {
      await server.stop()
    }
  })

  it('rejects disallowed files through POST /api/read-file', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const outsideFile =
      process.platform === 'win32' ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/hosts'

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/read-file`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          path: outsideFile,
        }),
      })

      expect(response.status).toBe(403)

      const payload = (await response.json()) as { error: string }
      expect(payload.error).toContain('outside allowed roots')
    } finally {
      await server.stop()
    }
  })

  it('returns schedules through GET /api/managers/:managerId/schedules', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()
    await mkdir(dirname(config.paths.schedulesFile!), { recursive: true })

    await writeFile(
      config.paths.schedulesFile!,
      JSON.stringify(
        {
          schedules: [
            {
              id: 'daily-standup',
              name: 'Daily standup',
              cron: '0 9 * * *',
              message: 'Post standup summary to the team.',
              oneShot: false,
              timezone: 'America/Los_Angeles',
              createdAt: '2026-02-20T08:00:00.000Z',
              nextFireAt: '2026-02-21T17:00:00.000Z',
            },
            {
              id: '',
              name: 'invalid',
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    )

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/managers/manager/schedules`)
      expect(response.status).toBe(200)

      const payload = (await response.json()) as {
        schedules: Array<{
          id: string
          name: string
          cron: string
          message: string
          oneShot: boolean
          timezone: string
          createdAt: string
          nextFireAt: string
        }>
      }

      expect(payload.schedules).toEqual([
        {
          id: 'daily-standup',
          name: 'Daily standup',
          cron: '0 9 * * *',
          message: 'Post standup summary to the team.',
          oneShot: false,
          timezone: 'America/Los_Angeles',
          createdAt: '2026-02-20T08:00:00.000Z',
          nextFireAt: '2026-02-21T17:00:00.000Z',
        },
      ])
    } finally {
      await server.stop()
    }
  })

  it('returns manager-scoped schedules through GET /api/managers/:managerId/schedules', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const secondaryManager = await manager.createManager('manager', {
      name: 'release-manager',
      cwd: config.paths.projectRoot,
    })

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()
    const secondaryManagerScheduleFile = getScheduleFilePath(config.paths.dataDir, secondaryManager.agentId)
    await mkdir(dirname(secondaryManagerScheduleFile), { recursive: true })

    await writeFile(
      secondaryManagerScheduleFile,
      JSON.stringify(
        {
          schedules: [
            {
              id: 'weekly-check',
              name: 'Weekly release check',
              cron: '0 10 * * 1',
              message: 'Review release readiness.',
              oneShot: false,
              timezone: 'America/Los_Angeles',
              createdAt: '2026-02-20T08:00:00.000Z',
              nextFireAt: '2026-02-23T18:00:00.000Z',
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    )

    try {
      const response = await fetch(
        `http://${config.host}:${config.port}/api/managers/${encodeURIComponent(secondaryManager.agentId)}/schedules`,
      )
      expect(response.status).toBe(200)

      const payload = (await response.json()) as {
        schedules: Array<{
          id: string
          name: string
          cron: string
          message: string
          oneShot: boolean
          timezone: string
          createdAt: string
          nextFireAt: string
        }>
      }

      expect(payload.schedules).toEqual([
        {
          id: 'weekly-check',
          name: 'Weekly release check',
          cron: '0 10 * * 1',
          message: 'Review release readiness.',
          oneShot: false,
          timezone: 'America/Los_Angeles',
          createdAt: '2026-02-20T08:00:00.000Z',
          nextFireAt: '2026-02-23T18:00:00.000Z',
        },
      ])
    } finally {
      await server.stop()
    }
  })

  it('returns 404 for unknown manager schedule routes', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    try {
      const response = await fetch(
        `http://${config.host}:${config.port}/api/managers/unknown-manager/schedules`,
      )
      expect(response.status).toBe(404)
    } finally {
      await server.stop()
    }
  })

  it('returns an empty schedule list when the manager schedule file is missing', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/managers/manager/schedules`)
      expect(response.status).toBe(200)

      const payload = (await response.json()) as { schedules: unknown[] }
      expect(payload.schedules).toEqual([])
    } finally {
      await server.stop()
    }
  })

  it('manages skill env settings through REST endpoints', async () => {
    const previousBraveApiKey = process.env.BRAVE_API_KEY
    delete process.env.BRAVE_API_KEY

    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    try {
      const initialResponse = await fetch(`http://${config.host}:${config.port}/api/settings/env`)
      expect(initialResponse.status).toBe(200)
      const initialPayload = (await initialResponse.json()) as {
        variables: Array<{ name: string; skillName: string; isSet: boolean }>
      }

      expect(
        initialPayload.variables.find(
          (entry) => entry.name === 'BRAVE_API_KEY' && entry.skillName === 'brave-search',
        ),
      ).toMatchObject({
        isSet: false,
      })

      const updateResponse = await fetch(`http://${config.host}:${config.port}/api/settings/env`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          values: {
            BRAVE_API_KEY: 'bsal-rest-value',
          },
        }),
      })

      expect(updateResponse.status).toBe(200)
      const updatedPayload = (await updateResponse.json()) as {
        variables: Array<{ name: string; skillName: string; isSet: boolean; maskedValue?: string }>
      }

      expect(
        updatedPayload.variables.find(
          (entry) => entry.name === 'BRAVE_API_KEY' && entry.skillName === 'brave-search',
        ),
      ).toMatchObject({
        isSet: true,
        maskedValue: '********',
      })

      expect(process.env.BRAVE_API_KEY).toBe('bsal-rest-value')

      const storedSecrets = JSON.parse(await readFile(config.paths.secretsFile, 'utf8')) as Record<string, string>
      expect(storedSecrets.BRAVE_API_KEY).toBe('bsal-rest-value')

      const deleteResponse = await fetch(`http://${config.host}:${config.port}/api/settings/env/BRAVE_API_KEY`, {
        method: 'DELETE',
      })

      expect(deleteResponse.status).toBe(200)
      expect(process.env.BRAVE_API_KEY).toBeUndefined()

      const afterDeleteResponse = await fetch(`http://${config.host}:${config.port}/api/settings/env`)
      const afterDeletePayload = (await afterDeleteResponse.json()) as {
        variables: Array<{ name: string; skillName: string; isSet: boolean }>
      }

      expect(
        afterDeletePayload.variables.find(
          (entry) => entry.name === 'BRAVE_API_KEY' && entry.skillName === 'brave-search',
        ),
      ).toMatchObject({
        isSet: false,
      })
    } finally {
      if (previousBraveApiKey === undefined) {
        delete process.env.BRAVE_API_KEY
      } else {
        process.env.BRAVE_API_KEY = previousBraveApiKey
      }

      await server.stop()
    }
  })

  it('manages auth settings through REST endpoints', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    try {
      const initialResponse = await fetch(`http://${config.host}:${config.port}/api/settings/auth`)
      expect(initialResponse.status).toBe(200)
      const initialPayload = (await initialResponse.json()) as {
        providers: Array<{ provider: string; configured: boolean }>
      }

      expect(initialPayload.providers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ provider: 'anthropic', configured: false }),
          expect.objectContaining({ provider: 'openai-codex', configured: false }),
        ]),
      )

      const updateResponse = await fetch(`http://${config.host}:${config.port}/api/settings/auth`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          anthropic: 'sk-ant-test-1234',
          'openai-codex': 'sk-openai-test-5678',
        }),
      })

      expect(updateResponse.status).toBe(200)
      const updatedPayload = (await updateResponse.json()) as {
        providers: Array<{ provider: string; configured: boolean; maskedValue?: string }>
      }

      const anthropic = updatedPayload.providers.find((entry) => entry.provider === 'anthropic')
      const openai = updatedPayload.providers.find((entry) => entry.provider === 'openai-codex')

      expect(anthropic?.configured).toBe(true)
      expect(anthropic?.maskedValue).toBe('********1234')
      expect(openai?.configured).toBe(true)
      expect(openai?.maskedValue).toBe('********5678')

      const storedAuth = JSON.parse(await readFile(config.paths.authFile, 'utf8')) as Record<
        string,
        { type: string; key?: string; access?: string }
      >

      expect(storedAuth.anthropic).toMatchObject({
        type: 'api_key',
      })
      expect(storedAuth.anthropic.key ?? storedAuth.anthropic.access).toBe('sk-ant-test-1234')
      expect(storedAuth['openai-codex']).toMatchObject({
        type: 'api_key',
      })
      expect(storedAuth['openai-codex'].key ?? storedAuth['openai-codex'].access).toBe('sk-openai-test-5678')

      const deleteResponse = await fetch(`http://${config.host}:${config.port}/api/settings/auth/openai-codex`, {
        method: 'DELETE',
      })
      expect(deleteResponse.status).toBe(200)

      const afterDeletePayload = (await deleteResponse.json()) as {
        providers: Array<{ provider: string; configured: boolean }>
      }
      expect(afterDeletePayload.providers.find((entry) => entry.provider === 'openai-codex')?.configured).toBe(false)

      const afterDeleteAuth = JSON.parse(await readFile(config.paths.authFile, 'utf8')) as Record<string, unknown>
      expect(afterDeleteAuth['openai-codex']).toBeUndefined()
    } finally {
      await server.stop()
    }
  })

  it('accepts attachment-only user messages and broadcasts attachments', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')

    client.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(events, (event) => event.type === 'ready')

    client.send(
      JSON.stringify({
        type: 'user_message',
        text: '',
        attachments: [
          {
            mimeType: 'image/png',
            data: 'aGVsbG8=',
            fileName: 'diagram.png',
          },
        ],
      }),
    )

    const userEvent = await waitForEvent(
      events,
      (event) => event.type === 'conversation_message' && event.source === 'user_input',
    )

    expect(userEvent.type).toBe('conversation_message')
    if (userEvent.type === 'conversation_message') {
      expect(userEvent.text).toBe('')
      expect(userEvent.attachments).toHaveLength(1)
      const persistedAttachment = userEvent.attachments?.[0]
      expect(persistedAttachment).toMatchObject({
        type: 'image',
        mimeType: 'image/png',
        fileName: 'diagram.png',
        sizeBytes: 5,
      })
      expect(typeof persistedAttachment?.filePath).toBe('string')

      if (persistedAttachment?.filePath) {
        expect(persistedAttachment.filePath.startsWith(config.paths.uploadsDir)).toBe(true)
        const content = await readFile(persistedAttachment.filePath)
        expect(content.toString('utf8')).toBe('hello')
      }
    }

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('accepts text and binary attachments in websocket user messages', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')

    client.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(events, (event) => event.type === 'ready')

    client.send(
      JSON.stringify({
        type: 'user_message',
        text: '',
        attachments: [
          {
            type: 'text',
            mimeType: 'text/markdown',
            text: '# Notes',
            fileName: 'notes.md',
          },
          {
            type: 'binary',
            mimeType: 'application/pdf',
            data: 'aGVsbG8=',
            fileName: 'design.pdf',
          },
        ],
      }),
    )

    const userEvent = await waitForEvent(
      events,
      (event) =>
        event.type === 'conversation_message' &&
        event.source === 'user_input' &&
        Array.isArray(event.attachments) &&
        event.attachments.length === 2,
    )

    expect(userEvent.type).toBe('conversation_message')
    if (userEvent.type === 'conversation_message') {
      expect(userEvent.attachments).toHaveLength(2)

      const textAttachment = userEvent.attachments?.[0]
      expect(textAttachment).toMatchObject({
        type: 'text',
        mimeType: 'text/markdown',
        fileName: 'notes.md',
        sizeBytes: 7,
      })
      expect(typeof textAttachment?.filePath).toBe('string')

      const binaryAttachment = userEvent.attachments?.[1]
      expect(binaryAttachment).toMatchObject({
        type: 'binary',
        mimeType: 'application/pdf',
        fileName: 'design.pdf',
        sizeBytes: 5,
      })
      expect(typeof binaryAttachment?.filePath).toBe('string')

      if (textAttachment?.filePath) {
        expect(textAttachment.filePath.startsWith(config.paths.uploadsDir)).toBe(true)
        const textContent = await readFile(textAttachment.filePath, 'utf8')
        expect(textContent).toBe('# Notes')
      }

      if (binaryAttachment?.filePath) {
        expect(binaryAttachment.filePath.startsWith(config.paths.uploadsDir)).toBe(true)
        const binaryContent = await readFile(binaryAttachment.filePath)
        expect(binaryContent.toString('utf8')).toBe('hello')
      }
    }

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('replays manager conversation history on reconnect', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const clientA = new WebSocket(`ws://${config.host}:${config.port}`)
    const eventsA: ServerEvent[] = []
    clientA.on('message', (raw) => {
      eventsA.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(clientA, 'open')
    clientA.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(eventsA, (event) => event.type === 'conversation_history')

    clientA.send(JSON.stringify({ type: 'user_message', text: 'remember this' }))
    await waitForEvent(
      eventsA,
      (event) =>
        event.type === 'conversation_message' &&
        event.source === 'user_input' &&
        event.text === 'remember this',
    )

    clientA.close()
    await once(clientA, 'close')

    const clientB = new WebSocket(`ws://${config.host}:${config.port}`)
    const eventsB: ServerEvent[] = []
    clientB.on('message', (raw) => {
      eventsB.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(clientB, 'open')
    clientB.send(JSON.stringify({ type: 'subscribe' }))

    const historyEvent = await waitForEvent(eventsB, (event) => event.type === 'conversation_history')
    expect(historyEvent.type).toBe('conversation_history')
    if (historyEvent.type === 'conversation_history') {
      expect(
        historyEvent.messages.some(
          (message) => message.type === 'conversation_message' && message.text === 'remember this',
        ),
      ).toBe(true)
    }

    clientB.close()
    await once(clientB, 'close')
    await server.stop()
  })

  it('applies bootstrap history limits using transcript-only bootstrap payloads', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    for (let index = 0; index < 205; index += 1) {
      await manager.publishToUser('manager', `visible-reply-${index}`, 'speak_to_user')
      ;(manager as any).conversationProjector.emitConversationLog({
        type: 'conversation_log',
        agentId: 'manager',
        timestamp: new Date(index).toISOString(),
        source: 'runtime_log',
        kind: 'tool_execution_start',
        toolName: 'bash',
        toolCallId: `tool-${index}`,
        text: `tool-log-${index}`,
      })
    }

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe' }))

    const historyEvent = await waitForEvent(events, (event) => event.type === 'conversation_history')
    expect(historyEvent.type).toBe('conversation_history')
    if (historyEvent.type === 'conversation_history') {
      expect(historyEvent.messages).toHaveLength(200)
      expect(historyEvent.messages.every((entry) => entry.type === 'conversation_message')).toBe(true)

      const transcriptMessages = historyEvent.messages.filter((entry) => entry.type === 'conversation_message')
      expect(transcriptMessages[0]?.text).toBe('visible-reply-5')
      expect(transcriptMessages.at(-1)?.text).toBe('visible-reply-204')
      expect(
        transcriptMessages.every(
          (entry) => entry.source === 'user_input' || entry.source === 'speak_to_user',
        ),
      ).toBe(true)
    }

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('truncates oversized bootstrap history payloads and emits a truncation error event', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const largeChunk = 'x'.repeat(400_000)
    for (let index = 0; index < 20; index += 1) {
      await manager.publishToUser('manager', `${index}:${largeChunk}`, 'speak_to_user')
    }

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe' }))

    const historyEvent = await waitForEvent(events, (event) => event.type === 'conversation_history')
    expect(historyEvent.type).toBe('conversation_history')
    if (historyEvent.type === 'conversation_history') {
      expect(historyEvent.messages.length).toBeGreaterThan(0)
      expect(historyEvent.messages.length).toBeLessThan(20)
      expect(historyEvent.messages.every((entry) => entry.type === 'conversation_message')).toBe(true)
    }

    const truncationEvent = await waitForEvent(
      events,
      (event) => event.type === 'error' && event.code === 'HISTORY_TRUNCATED',
    )
    expect(truncationEvent.type).toBe('error')
    if (truncationEvent.type === 'error') {
      expect(truncationEvent.message).toContain('loaded')
      expect(truncationEvent.message).toContain('payload limits')
    }

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('handles /new via websocket by resetting manager session and clearing history', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const clientA = new WebSocket(`ws://${config.host}:${config.port}`)
    const eventsA: ServerEvent[] = []
    clientA.on('message', (raw) => {
      eventsA.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(clientA, 'open')
    clientA.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(eventsA, (event) => event.type === 'conversation_history')

    clientA.send(JSON.stringify({ type: 'user_message', text: 'keep this' }))
    await waitForEvent(
      eventsA,
      (event) =>
        event.type === 'conversation_message' &&
        event.source === 'user_input' &&
        event.text === 'keep this',
    )

    clientA.send(JSON.stringify({ type: 'user_message', text: '/new' }))
    const resetEvent = await waitForEvent(eventsA, (event) => event.type === 'conversation_reset')
    expect(resetEvent.type).toBe('conversation_reset')
    if (resetEvent.type === 'conversation_reset') {
      expect(resetEvent.reason).toBe('user_new_command')
      expect(resetEvent.agentId).toBe('manager')
    }

    expect(
      eventsA.some(
        (event) => event.type === 'conversation_message' && event.source === 'user_input' && event.text === '/new',
      ),
    ).toBe(false)

    clientA.close()
    await once(clientA, 'close')

    const clientB = new WebSocket(`ws://${config.host}:${config.port}`)
    const eventsB: ServerEvent[] = []
    clientB.on('message', (raw) => {
      eventsB.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(clientB, 'open')
    clientB.send(JSON.stringify({ type: 'subscribe' }))
    const historyEvent = await waitForEvent(eventsB, (event) => event.type === 'conversation_history')

    expect(historyEvent.type).toBe('conversation_history')
    if (historyEvent.type === 'conversation_history') {
      expect(historyEvent.messages).toHaveLength(0)
    }

    clientB.close()
    await once(clientB, 'close')
    await server.stop()
  })

  it('handles /compact via websocket by compacting manager context', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(events, (event) => event.type === 'conversation_history')

    client.send(
      JSON.stringify({
        type: 'user_message',
        text: '/compact Keep unresolved work items in the summary.',
      }),
    )

    await waitForEvent(
      events,
      (event) =>
        event.type === 'conversation_message' &&
        event.source === 'system' &&
        event.text === 'Compacting manager context...',
    )
    await waitForEvent(
      events,
      (event) =>
        event.type === 'conversation_message' && event.source === 'system' && event.text === 'Compaction complete.',
    )

    expect(
      events.some(
        (event) =>
          event.type === 'conversation_message' &&
          event.source === 'user_input' &&
          event.text.trim().toLowerCase().startsWith('/compact'),
      ),
    ).toBe(false)

    const runtime = manager.runtimeByAgentId.get('manager')
    expect(runtime?.compactCalls).toEqual(['Keep unresolved work items in the summary.'])

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('supports worker subscriptions and direct user messaging to the selected worker', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Worker Thread' })

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: worker.agentId }))

    await waitForEvent(
      events,
      (event) => event.type === 'ready' && event.subscribedAgentId === worker.agentId,
    )
    await waitForEvent(
      events,
      (event) => event.type === 'conversation_history' && event.agentId === worker.agentId,
    )

    client.send(JSON.stringify({ type: 'user_message', text: 'hello worker' }))

    const workerEvent = await waitForEvent(
      events,
      (event) =>
        event.type === 'conversation_message' &&
        event.agentId === worker.agentId &&
        event.source === 'user_input' &&
        event.text === 'hello worker',
    )

    expect(workerEvent.type).toBe('conversation_message')

    ;(manager as any).conversationProjector.emitConversationLog({
      type: 'conversation_log',
      agentId: worker.agentId,
      timestamp: new Date().toISOString(),
      source: 'runtime_log',
      kind: 'tool_execution_start',
      toolName: 'bash',
      toolCallId: 'call-1',
      text: '{"command":"ls"}',
    })

    const logEvent = await waitForEvent(
      events,
      (event) =>
        event.type === 'conversation_log' &&
        event.agentId === worker.agentId &&
        event.kind === 'tool_execution_start' &&
        event.toolName === 'bash',
    )

    expect(logEvent.type).toBe('conversation_log')

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('streams worker detail history and live updates on demand without changing the primary subscription', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const worker = await manager.spawnAgent('manager', { agentId: 'Detail Worker' })

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: 'manager' }))

    await waitForEvent(
      events,
      (event) => event.type === 'ready' && event.subscribedAgentId === 'manager',
    )
    await waitForEvent(
      events,
      (event) => event.type === 'conversation_history' && event.agentId === 'manager',
    )

    await manager.publishToUser(worker.agentId, 'worker system note', 'system')
    ;(manager as any).conversationProjector.emitConversationLog({
      type: 'conversation_log',
      agentId: worker.agentId,
      timestamp: new Date().toISOString(),
      source: 'runtime_log',
      kind: 'tool_execution_start',
      toolName: 'read',
      toolCallId: 'detail-log-call',
      text: '{"path":"README.md"}',
    })
    ;(manager as any).conversationProjector.emitAgentMessage({
      type: 'agent_message',
      agentId: worker.agentId,
      timestamp: new Date().toISOString(),
      source: 'agent_to_agent',
      fromAgentId: 'manager',
      toAgentId: worker.agentId,
      text: 'detail ping',
    })
    ;(manager as any).conversationProjector.emitAgentToolCall({
      type: 'agent_tool_call',
      agentId: worker.agentId,
      actorAgentId: worker.agentId,
      timestamp: new Date().toISOString(),
      kind: 'tool_execution_start',
      toolName: 'bash',
      toolCallId: 'detail-tool-call',
      text: '{"command":"pwd"}',
    })

    client.send(JSON.stringify({ type: 'subscribe_agent_detail', agentId: worker.agentId }))

    const detailHistoryEvent = await waitForEvent(
      events,
      (event) => event.type === 'conversation_history' && event.agentId === worker.agentId,
    )

    expect(detailHistoryEvent.type).toBe('conversation_history')
    if (detailHistoryEvent.type === 'conversation_history') {
      const historyTypes = new Set(detailHistoryEvent.messages.map((entry) => entry.type))
      expect(historyTypes.has('conversation_message')).toBe(true)
      expect(historyTypes.has('conversation_log')).toBe(true)
      expect(historyTypes.has('agent_message')).toBe(true)
      expect(historyTypes.has('agent_tool_call')).toBe(true)
    }

    ;(manager as any).conversationProjector.emitConversationLog({
      type: 'conversation_log',
      agentId: worker.agentId,
      timestamp: new Date().toISOString(),
      source: 'runtime_log',
      kind: 'tool_execution_end',
      toolName: 'read',
      toolCallId: 'detail-live-call',
      text: '{"ok":true}',
    })

    const liveWorkerLog = await waitForEvent(
      events,
      (event) =>
        event.type === 'conversation_log' &&
        event.agentId === worker.agentId &&
        event.toolCallId === 'detail-live-call',
    )
    expect(liveWorkerLog.type).toBe('conversation_log')

    client.send(JSON.stringify({ type: 'unsubscribe_agent_detail', agentId: worker.agentId }))
    await new Promise((resolve) => setTimeout(resolve, 25))

    const workerPostUnsubscribeCallId = 'detail-post-unsubscribe'
    const workerEventsBefore = events.filter(
      (event) =>
        event.type === 'conversation_log' &&
        event.agentId === worker.agentId &&
        event.toolCallId === workerPostUnsubscribeCallId,
    ).length

    ;(manager as any).conversationProjector.emitConversationLog({
      type: 'conversation_log',
      agentId: worker.agentId,
      timestamp: new Date().toISOString(),
      source: 'runtime_log',
      kind: 'tool_execution_end',
      toolName: 'read',
      toolCallId: workerPostUnsubscribeCallId,
      text: '{"ok":true}',
    })

    await new Promise((resolve) => setTimeout(resolve, 75))

    const workerEventsAfter = events.filter(
      (event) =>
        event.type === 'conversation_log' &&
        event.agentId === worker.agentId &&
        event.toolCallId === workerPostUnsubscribeCallId,
    ).length

    expect(workerEventsAfter).toBe(workerEventsBefore)

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('truncates oversized worker detail history payloads and reports truncation', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const worker = await manager.spawnAgent('manager', { agentId: 'Large Detail Worker' })

    const largeChunk = 'x'.repeat(400_000)
    for (let index = 0; index < 20; index += 1) {
      ;(manager as any).conversationProjector.emitConversationLog({
        type: 'conversation_log',
        agentId: worker.agentId,
        timestamp: new Date(index).toISOString(),
        source: 'runtime_log',
        kind: 'tool_execution_start',
        toolName: 'bash',
        toolCallId: `detail-large-${index}`,
        text: `${index}:${largeChunk}`,
      })
    }

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: 'manager' }))
    await waitForEvent(
      events,
      (event) => event.type === 'conversation_history' && event.agentId === 'manager',
    )

    client.send(JSON.stringify({ type: 'subscribe_agent_detail', agentId: worker.agentId }))

    const detailHistoryEvent = await waitForEvent(
      events,
      (event) => event.type === 'conversation_history' && event.agentId === worker.agentId,
    )
    expect(detailHistoryEvent.type).toBe('conversation_history')
    if (detailHistoryEvent.type === 'conversation_history') {
      expect(detailHistoryEvent.messages.length).toBeGreaterThan(0)
      expect(detailHistoryEvent.messages.length).toBeLessThan(20)
      expect(detailHistoryEvent.messages.every((entry) => entry.type === 'conversation_log')).toBe(true)
    }

    const truncationEvent = await waitForEvent(
      events,
      (event) => event.type === 'error' && event.code === 'AGENT_DETAIL_HISTORY_TRUNCATED',
    )
    expect(truncationEvent.type).toBe('error')
    if (truncationEvent.type === 'error') {
      expect(truncationEvent.message).toContain('loaded')
      expect(truncationEvent.message).toContain('payload limits')
    }

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('kills a worker via kill_agent command and emits updated status + snapshot events', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Disposable Worker' })

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe' }))

    await waitForEvent(events, (event) => event.type === 'ready')
    await waitForEvent(events, (event) => event.type === 'agents_snapshot')

    client.send(JSON.stringify({ type: 'kill_agent', agentId: worker.agentId }))

    const statusEvent = await waitForEvent(
      events,
      (event) => event.type === 'agent_status' && event.agentId === worker.agentId && event.status === 'terminated',
    )
    expect(statusEvent.type).toBe('agent_status')

    const snapshotEvent = await waitForEvent(
      events,
      (event) =>
        event.type === 'agents_snapshot' &&
        event.agents.some((agent) => agent.agentId === worker.agentId && agent.status === 'terminated'),
    )
    expect(snapshotEvent.type).toBe('agents_snapshot')

    const descriptor = manager.listAgents().find((agent) => agent.agentId === worker.agentId)
    expect(descriptor?.status).toBe('terminated')

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('stops all agents over websocket by cancelling work and keeping agents alive', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Stop-All Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(managerRuntime).toBeDefined()
    expect(workerRuntime).toBeDefined()

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: 'manager' }))
    await waitForEvent(events, (event) => event.type === 'ready' && event.subscribedAgentId === 'manager')

    client.send(JSON.stringify({ type: 'stop_all_agents', managerId: 'manager' }))

    const resultEvent = await waitForEvent(
      events,
      (event) => event.type === 'stop_all_agents_result' && event.managerId === 'manager',
    )
    expect(resultEvent.type).toBe('stop_all_agents_result')
    if (resultEvent.type === 'stop_all_agents_result') {
      expect(resultEvent.stoppedWorkerIds).toEqual([worker.agentId])
      expect(resultEvent.managerStopped).toBe(true)
      expect(resultEvent.terminatedWorkerIds).toEqual([worker.agentId])
      expect(resultEvent.managerTerminated).toBe(true)
    }

    const snapshotEvent = await waitForEvent(
      events,
      (event) =>
        event.type === 'agents_snapshot' &&
        event.agents.some((agent) => agent.agentId === 'manager' && agent.status === 'idle') &&
        event.agents.some((agent) => agent.agentId === worker.agentId && agent.status === 'idle'),
    )
    expect(snapshotEvent.type).toBe('agents_snapshot')

    expect(managerRuntime?.stopInFlightCalls).toEqual([{ abort: true }])
    expect(workerRuntime?.stopInFlightCalls).toEqual([{ abort: true }])
    expect(managerRuntime?.terminateCalls).toBe(0)
    expect(workerRuntime?.terminateCalls).toBe(0)

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('creates managers over websocket with model presets and broadcasts manager_created', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(events, (event) => event.type === 'ready')

    client.send(
      JSON.stringify({
        type: 'create_manager',
        name: 'Review Manager',
        cwd: config.defaultCwd,
        model: 'pi-opus',
      }),
    )

    const createdEvent = await waitForEvent(events, (event) => event.type === 'manager_created')
    expect(createdEvent.type).toBe('manager_created')
    if (createdEvent.type === 'manager_created') {
      expect(createdEvent.manager.role).toBe('manager')
      expect(createdEvent.manager.managerId).toBe(createdEvent.manager.agentId)
      expect(createdEvent.manager.model).toEqual({
        provider: 'anthropic',
        modelId: 'claude-opus-4-6',
        thinkingLevel: 'xhigh',
      })
    }

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('creates codex-app managers over websocket', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(events, (event) => event.type === 'ready')

    client.send(
      JSON.stringify({
        type: 'create_manager',
        name: 'Codex App Manager',
        cwd: config.defaultCwd,
        model: 'codex-app',
      }),
    )

    const createdEvent = await waitForEvent(events, (event) => event.type === 'manager_created')
    expect(createdEvent.type).toBe('manager_created')
    if (createdEvent.type === 'manager_created') {
      expect(createdEvent.manager.model).toEqual({
        provider: 'openai-codex-app-server',
        modelId: 'gpt-5.4',
        thinkingLevel: 'xhigh',
      })
    }

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('rejects invalid create_manager model presets at websocket protocol validation time', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(events, (event) => event.type === 'ready')

    client.send(
      JSON.stringify({
        type: 'create_manager',
        name: 'Invalid Manager',
        cwd: config.defaultCwd,
        model: 'gpt-4o',
      }),
    )

    const errorEvent = await waitForEvent(
      events,
      (event) =>
        event.type === 'error' &&
        event.code === 'INVALID_COMMAND' &&
        event.message.includes('create_manager.model must be one of pi-codex|pi-opus|codex-app|claude-code'),
    )

    expect(errorEvent.type).toBe('error')

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('deletes managers over websocket and emits manager_deleted', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const secondary = await manager.createManager('manager', {
      name: 'Delete Me Manager',
      cwd: config.defaultCwd,
    })
    const ownedWorker = await manager.spawnAgent(secondary.agentId, { agentId: 'Delete Me Worker' })

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(events, (event) => event.type === 'ready')

    client.send(JSON.stringify({ type: 'delete_manager', managerId: secondary.agentId }))

    const deletedEvent = await waitForEvent(
      events,
      (event) => event.type === 'manager_deleted' && event.managerId === secondary.agentId,
    )
    expect(deletedEvent.type).toBe('manager_deleted')
    if (deletedEvent.type === 'manager_deleted') {
      expect(deletedEvent.terminatedWorkerIds).toContain(ownedWorker.agentId)
    }

    expect(manager.listAgents().some((agent) => agent.agentId === secondary.agentId)).toBe(false)
    expect(manager.listAgents().some((agent) => agent.agentId === ownedWorker.agentId)).toBe(false)

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('reorders managers over websocket and broadcasts manager_order_updated', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const opsManager = await manager.createManager('manager', {
      name: 'Ops Manager',
      cwd: config.defaultCwd,
    })
    const qaManager = await manager.createManager('manager', {
      name: 'QA Manager',
      cwd: config.defaultCwd,
    })

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const clientA = new WebSocket(`ws://${config.host}:${config.port}`)
    const clientB = new WebSocket(`ws://${config.host}:${config.port}`)
    const clientAEvents: ServerEvent[] = []
    const clientBEvents: ServerEvent[] = []

    clientA.on('message', (raw) => {
      clientAEvents.push(JSON.parse(raw.toString()) as ServerEvent)
    })
    clientB.on('message', (raw) => {
      clientBEvents.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await Promise.all([once(clientA, 'open'), once(clientB, 'open')])
    clientA.send(JSON.stringify({ type: 'subscribe' }))
    clientB.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(clientAEvents, (event) => event.type === 'ready')
    await waitForEvent(clientBEvents, (event) => event.type === 'ready')

    const reorderedManagerIds = [qaManager.agentId, 'manager', opsManager.agentId]
    clientA.send(JSON.stringify({ type: 'reorder_managers', managerIds: reorderedManagerIds }))

    const reorderedEventA = await waitForEvent(
      clientAEvents,
      (event) =>
        event.type === 'manager_order_updated' &&
        JSON.stringify(event.managerIds) === JSON.stringify(reorderedManagerIds),
    )
    const reorderedEventB = await waitForEvent(
      clientBEvents,
      (event) =>
        event.type === 'manager_order_updated' &&
        JSON.stringify(event.managerIds) === JSON.stringify(reorderedManagerIds),
    )

    expect(reorderedEventA.type).toBe('manager_order_updated')
    expect(reorderedEventB.type).toBe('manager_order_updated')
    expect(
      manager
        .listAgents()
        .filter((agent) => agent.role === 'manager')
        .map((agent) => agent.agentId),
    ).toEqual(reorderedManagerIds)

    clientA.close()
    clientB.close()
    await Promise.all([once(clientA, 'close'), once(clientB, 'close')])
    await server.stop()
  })

  it('supports deleting the selected last manager and creating a replacement manager', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: 'manager' }))
    await waitForEvent(events, (event) => event.type === 'ready' && event.subscribedAgentId === 'manager')

    client.send(JSON.stringify({ type: 'delete_manager', managerId: 'manager' }))

    const deletedEvent = await waitForEvent(
      events,
      (event) => event.type === 'manager_deleted' && event.managerId === 'manager',
    )
    expect(deletedEvent.type).toBe('manager_deleted')

    const emptySnapshot = await waitForEvent(
      events,
      (event) => event.type === 'agents_snapshot' && event.agents.length === 0,
    )
    expect(emptySnapshot.type).toBe('agents_snapshot')

    client.send(
      JSON.stringify({
        type: 'create_manager',
        name: 'Recovered Manager',
        cwd: config.defaultCwd,
      }),
    )

    const recreatedEvent = await waitForEvent(
      events,
      (event) => event.type === 'manager_created' && event.manager.agentId === 'recovered-manager',
    )
    expect(recreatedEvent.type).toBe('manager_created')

    expect(manager.listAgents().some((agent) => agent.agentId === 'recovered-manager')).toBe(true)

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('enforces strict ownership for kill_agent based on selected manager context', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const secondary = await manager.createManager('manager', {
      name: 'Owner Manager',
      cwd: config.defaultCwd,
    })
    const ownedWorker = await manager.spawnAgent(secondary.agentId, { agentId: 'Owned Worker' })

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: 'manager' }))
    await waitForEvent(events, (event) => event.type === 'ready')

    client.send(JSON.stringify({ type: 'kill_agent', agentId: ownedWorker.agentId }))

    const denied = await waitForEvent(
      events,
      (event) => event.type === 'error' && event.code === 'KILL_AGENT_FAILED',
    )
    expect(denied.type).toBe('error')

    client.send(JSON.stringify({ type: 'subscribe', agentId: secondary.agentId }))
    await waitForEvent(
      events,
      (event) => event.type === 'ready' && event.subscribedAgentId === secondary.agentId,
    )

    client.send(JSON.stringify({ type: 'kill_agent', agentId: ownedWorker.agentId }))

    const statusEvent = await waitForEvent(
      events,
      (event) => event.type === 'agent_status' && event.agentId === ownedWorker.agentId && event.status === 'terminated',
    )
    expect(statusEvent.type).toBe('agent_status')

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('/new resets the currently selected manager session only', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const secondary = await manager.createManager('manager', {
      name: 'Resettable Manager',
      cwd: config.defaultCwd,
    })

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: secondary.agentId }))
    await waitForEvent(
      events,
      (event) => event.type === 'ready' && event.subscribedAgentId === secondary.agentId,
    )

    client.send(JSON.stringify({ type: 'user_message', text: '/new' }))

    const resetEvent = await waitForEvent(
      events,
      (event) => event.type === 'conversation_reset' && event.agentId === secondary.agentId,
    )
    expect(resetEvent.type).toBe('conversation_reset')

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('supports directory picker protocol commands', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const outsideDir = await mkdtemp(join(tmpdir(), 'ws-outside-allowlist-'))
    const rootValidation = await manager.validateDirectory(config.paths.projectRoot)
    const expectedRoot = rootValidation.resolvedPath ?? config.paths.projectRoot

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(events, (event) => event.type === 'ready')

    client.send(JSON.stringify({ type: 'list_directories', path: config.paths.projectRoot }))

    const listed = await waitForEvent(events, (event) => event.type === 'directories_listed')
    expect(listed.type).toBe('directories_listed')
    if (listed.type === 'directories_listed') {
      expect(listed.roots).toEqual([])
      expect(listed.resolvedPath).toBe(expectedRoot)
    }

    client.send(JSON.stringify({ type: 'validate_directory', path: outsideDir }))

    const validated = await waitForEvent(
      events,
      (event) => event.type === 'directory_validated' && event.requestedPath === outsideDir,
    )
    expect(validated.type).toBe('directory_validated')
    if (validated.type === 'directory_validated') {
      expect(validated.valid).toBe(true)
      expect(validated.message).toBeUndefined()
      expect(validated.roots).toEqual([])
    }

    manager.pickedDirectoryPath = outsideDir
    client.send(JSON.stringify({ type: 'pick_directory', defaultPath: expectedRoot, requestId: 'pick-1' }))

    const picked = await waitForEvent(
      events,
      (event) => event.type === 'directory_picked' && event.requestId === 'pick-1',
    )
    expect(picked.type).toBe('directory_picked')
    if (picked.type === 'directory_picked') {
      expect(picked.path).toBe(outsideDir)
    }
    expect(manager.lastPickedDirectoryDefaultPath).toBe(expectedRoot)

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('lists and resolves escalations over websocket, broadcasting escalation updates and manager notifications', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: 'manager' }))
    await waitForEvent(events, (event) => event.type === 'ready' && event.subscribedAgentId === 'manager')

    const escalation = await manager.createEscalationForManager('manager', {
      title: 'Verify release smoke tests',
      description: 'Run the quick post-deploy checks and report back.',
      options: ['Approve the release', 'Hold the release'],
    })

    const createdEvent = await waitForEvent(
      events,
      (event) => event.type === 'escalation_created' && event.escalation.id === escalation.id,
    )
    expect(createdEvent.type).toBe('escalation_created')

    const conversationEscalationEvent = await waitForEvent(
      events,
      (event) => event.type === 'conversation_escalation' && event.escalation.id === escalation.id,
    )
    expect(conversationEscalationEvent.type).toBe('conversation_escalation')

    client.send(JSON.stringify({ type: 'get_all_escalations', requestId: 'escalations-1' }))

    const snapshotEvent = await waitForEvent(
      events,
      (event) => event.type === 'escalations_snapshot' && event.requestId === 'escalations-1',
    )
    expect(snapshotEvent.type).toBe('escalations_snapshot')
    if (snapshotEvent.type === 'escalations_snapshot') {
      expect(snapshotEvent.escalations).toHaveLength(1)
      expect(snapshotEvent.escalations[0]?.title).toBe('Verify release smoke tests')
      expect(snapshotEvent.escalations[0]?.options).toEqual([
        'Approve the release',
        'Hold the release',
      ])
    }

    client.send(
      JSON.stringify({
        type: 'resolve_escalation',
        escalationId: escalation.id,
        choice: 'Approve the release',
        isCustom: false,
        requestId: 'resolve-1',
      }),
    )

    const updatedEvent = await waitForEvent(
      events,
      (event) =>
        event.type === 'escalation_updated' &&
        event.escalation.id === escalation.id &&
        event.escalation.status === 'resolved',
    )
    expect(updatedEvent.type).toBe('escalation_updated')
    if (updatedEvent.type === 'escalation_updated') {
      expect(updatedEvent.escalation.status).toBe('resolved')
      expect(updatedEvent.escalation.response).toEqual({
        choice: 'Approve the release',
        isCustom: false,
      })
    }

    const resultEvent = await waitForEvent(
      events,
      (event) => event.type === 'escalation_resolution_result' && event.requestId === 'resolve-1',
    )
    expect(resultEvent.type).toBe('escalation_resolution_result')
    if (resultEvent.type === 'escalation_resolution_result') {
      expect(resultEvent.escalation.status).toBe('resolved')
      expect(resultEvent.escalation.response?.choice).toBe('Approve the release')
    }

    const managerMessageEvent = await waitForEvent(
      events,
      (event) =>
        event.type === 'conversation_message' &&
        event.agentId === 'manager' &&
        event.source === 'user_input' &&
        event.text.includes(`Escalation resolved: [${escalation.id}]`),
    )
    expect(managerMessageEvent.type).toBe('conversation_message')
    if (managerMessageEvent.type === 'conversation_message') {
      expect(managerMessageEvent.text).toContain('Question: "Verify release smoke tests"')
      expect(managerMessageEvent.text).toContain('Response: "Approve the release"')
    }

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('creates, lists, gets, and closes manager escalations over HTTP', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    try {
      const createResponse = await fetch(`http://${config.host}:${config.port}/api/escalations`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          managerId: 'manager',
          title: 'Prepare the launch checklist',
          description: 'Confirm rollout docs and rollback links.',
          options: ['Ship it', 'Hold it'],
        }),
      })

      expect(createResponse.status).toBe(201)
      const createdPayload = (await createResponse.json()) as {
        escalation: { id: string; title: string; description: string; options: string[] }
      }
      expect(createdPayload.escalation.title).toBe('Prepare the launch checklist')
      expect(createdPayload.escalation.options).toEqual(['Ship it', 'Hold it'])

      const listResponse = await fetch(
        `http://${config.host}:${config.port}/api/escalations?managerId=${encodeURIComponent('manager')}`,
      )
      expect(listResponse.status).toBe(200)
      const listPayload = (await listResponse.json()) as {
        escalations: Array<{ id: string; title: string }>
      }
      expect(listPayload.escalations).toHaveLength(1)
      expect(listPayload.escalations[0]?.id).toBe(createdPayload.escalation.id)

      const getResponse = await fetch(
        `http://${config.host}:${config.port}/api/escalations/${encodeURIComponent(createdPayload.escalation.id)}?managerId=${encodeURIComponent('manager')}`,
      )
      expect(getResponse.status).toBe(200)
      const getPayload = (await getResponse.json()) as {
        escalation: { title: string; description: string; status: string }
      }
      expect(getPayload.escalation).toMatchObject({
        title: 'Prepare the launch checklist',
        description: 'Confirm rollout docs and rollback links.',
        status: 'open',
      })

      const closeResponse = await fetch(
        `http://${config.host}:${config.port}/api/escalations/${encodeURIComponent(createdPayload.escalation.id)}`,
        {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            managerId: 'manager',
            status: 'resolved',
            comment: 'Closed after the user confirmed the checklist was complete.',
          }),
        },
      )
      expect(closeResponse.status).toBe(200)
      const closePayload = (await closeResponse.json()) as {
        escalation: { status: string; response?: { choice: string; isCustom: boolean } }
      }
      expect(closePayload.escalation).toMatchObject({
        status: 'resolved',
        response: {
          choice: 'Closed after the user confirmed the checklist was complete.',
          isCustom: true,
        },
      })
    } finally {
      await server.stop()
    }
  })

  it('rejects non-manager subscription with explicit error', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: 'worker-1' }))

    const errorEvent = await waitForEvent(events, (event) => event.type === 'error')
    expect(errorEvent.type).toBe('error')
    if (errorEvent.type === 'error') {
      expect(errorEvent.code).toBe('SUBSCRIPTION_NOT_SUPPORTED')
    }

    client.close()
    await once(client, 'close')
    await server.stop()
  })
})
