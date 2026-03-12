import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getScheduleFilePath } from '../scheduler/schedule-storage.js'
import type { AgentDescriptor, SwarmConfig } from '../swarm/types.js'

const oauthMockState = vi.hoisted(() => ({
  anthropicLogin: vi.fn(),
  openaiLogin: vi.fn(),
}))

vi.mock('@mariozechner/pi-ai/oauth', () => ({
  anthropicOAuthProvider: {
    name: 'Anthropic',
    usesCallbackServer: false,
    login: (callbacks: unknown) => oauthMockState.anthropicLogin(callbacks),
  },
  openaiCodexOAuthProvider: {
    name: 'OpenAI Codex',
    usesCallbackServer: false,
    login: (callbacks: unknown) => oauthMockState.openaiLogin(callbacks),
  },
}))

import { SwarmWebSocketServer } from '../ws/server.js'

interface SseEvent {
  event: string
  data: unknown
}

class FakeSwarmManager extends EventEmitter {
  private readonly config: SwarmConfig
  private readonly agents: AgentDescriptor[]

  constructor(config: SwarmConfig, agents: AgentDescriptor[]) {
    super()
    this.config = config
    this.agents = agents
  }

  getConfig(): SwarmConfig {
    return this.config
  }

  listAgents(): AgentDescriptor[] {
    return [...this.agents]
  }

  getAgent(agentId: string): AgentDescriptor | undefined {
    return this.agents.find((agent) => agent.agentId === agentId)
  }
}

function createManagerDescriptor(rootDir: string, managerId = 'manager'): AgentDescriptor {
  return {
    agentId: managerId,
    displayName: 'Manager',
    role: 'manager',
    managerId,
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: rootDir,
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'medium',
    },
    sessionFile: join(rootDir, 'sessions', `${managerId}.jsonl`),
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
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

async function makeTempConfig(options?: { port?: number; managerId?: string }): Promise<SwarmConfig> {
  const port = options?.port ?? (await getAvailablePort())
  const rootDir = await mkdtemp(join(tmpdir(), 'swarm-ws-p0-test-'))
  const installDir = resolve(process.cwd(), '../..')
  const dataDir = join(rootDir, 'data')
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
  const projectSwarmDir = join(rootDir, '.swarm')
  const projectArchetypesDir = join(projectSwarmDir, 'archetypes')
  const projectSkillsDir = join(projectSwarmDir, 'skills')
  const memoryDir = join(dataDir, 'memory')
  const memoryFile = join(memoryDir, 'manager.md')
  const projectMemorySkillFile = join(projectSkillsDir, 'memory', 'SKILL.md')
  const uiDir = join(rootDir, 'public')

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
    allowNonManagerSubscriptions: false,
    managerId: options?.managerId,
    managerDisplayName: 'Manager',
    defaultModel: {
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'medium',
    },
    defaultCwd: rootDir,
    cwdAllowlistRoots: [rootDir, join(rootDir, 'worktrees')],
    paths: {
      installDir,
      installAssetsDir: resolve(process.cwd(), 'src', 'swarm'),
      installArchetypesDir: resolve(process.cwd(), 'src', 'swarm', 'archetypes', 'builtins'),
      installSkillsDir: resolve(process.cwd(), 'src', 'swarm', 'skills', 'builtins'),
      cliBinDir: resolve(process.cwd(), '..', 'cli', 'bin'),
      uiDir,
      projectRoot: rootDir,
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
      schedulesFile: getScheduleFilePath(dataDir, options?.managerId ?? 'manager'),
    },
  }
}

function createIntegrationRegistryMock() {
  return Object.assign(new EventEmitter(), {
    getSlackSnapshot: vi.fn(async () => ({ config: { enabled: false }, status: { state: 'disabled' } })),
    updateSlackConfig: vi.fn(async () => ({ config: { enabled: true }, status: { state: 'connected' } })),
    disableSlack: vi.fn(async () => ({ config: { enabled: false }, status: { state: 'disabled' } })),
    testSlackConnection: vi.fn(async () => ({ ok: true })),
    listSlackChannels: vi.fn(async () => [{ id: 'C123', name: 'alerts' }]),
    getTelegramSnapshot: vi.fn(async () => ({ config: { enabled: false }, status: { state: 'disabled' } })),
    updateTelegramConfig: vi.fn(async () => ({ config: { enabled: true }, status: { state: 'connected' } })),
    disableTelegram: vi.fn(async () => ({ config: { enabled: false }, status: { state: 'disabled' } })),
    testTelegramConnection: vi.fn(async () => ({ ok: true })),
  })
}

async function parseJsonResponse(response: Response): Promise<{ status: number; json: Record<string, unknown> }> {
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  }
}

async function postTranscribe(url: string, options?: { size?: number; type?: string }): Promise<Response> {
  const byteLength = options?.size ?? 32
  const bytes = new Uint8Array(byteLength)
  bytes.fill(7)

  const form = new FormData()
  const file = new File([bytes], 'audio.wav', { type: options?.type ?? 'audio/wav' })
  form.set('file', file)

  return fetch(url, {
    method: 'POST',
    body: form,
  })
}

function parseSseChunk(chunk: string): SseEvent | undefined {
  const lines = chunk
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  let event = 'message'
  let dataText = ''

  for (const line of lines) {
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim()
      continue
    }

    if (line.startsWith('data:')) {
      dataText += line.slice('data:'.length).trim()
    }
  }

  if (!dataText) {
    return undefined
  }

  return {
    event,
    data: JSON.parse(dataText) as unknown,
  }
}

async function readSseEvents(
  response: Response,
  onEvent?: (event: SseEvent) => Promise<void> | void,
): Promise<SseEvent[]> {
  if (!response.body) {
    throw new Error('Expected SSE response body')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const events: SseEvent[] = []

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }

    buffer += decoder.decode(value, { stream: true })

    let boundaryIndex = buffer.indexOf('\n\n')
    while (boundaryIndex >= 0) {
      const chunk = buffer.slice(0, boundaryIndex)
      buffer = buffer.slice(boundaryIndex + 2)

      const parsed = parseSseChunk(chunk)
      if (parsed) {
        events.push(parsed)
        if (onEvent) {
          await onEvent(parsed)
        }
      }

      boundaryIndex = buffer.indexOf('\n\n')
    }
  }

  return events
}

async function writeAuthKey(authFile: string, apiKey: string): Promise<void> {
  await mkdir(dirname(authFile), { recursive: true })
  await writeFile(
    authFile,
    JSON.stringify(
      {
        'openai-codex': {
          type: 'api_key',
          key: apiKey,
        },
      },
      null,
      2,
    ),
    'utf8',
  )
}

afterEach(() => {
  oauthMockState.anthropicLogin.mockReset()
  oauthMockState.openaiLogin.mockReset()
  vi.restoreAllMocks()
})

describe('SwarmWebSocketServer P0 endpoints', () => {
  it('validates /api/transcribe content type, file size, and missing API key', async () => {
    const config = await makeTempConfig({ managerId: 'manager' })
    const manager = new FakeSwarmManager(config, [createManagerDescriptor(config.paths.projectRoot, 'manager')])
    const server = new SwarmWebSocketServer({
      swarmManager: manager as unknown as never,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: false,
    })

    await server.start()

    try {
      const invalidTypeResponse = await fetch(`http://${config.host}:${config.port}/api/transcribe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      const invalidType = await parseJsonResponse(invalidTypeResponse)
      expect(invalidType.status).toBe(400)
      expect(invalidType.json.error).toBe('Content-Type must be multipart/form-data')

      const tooLargeResponse = await postTranscribe(`http://${config.host}:${config.port}/api/transcribe`, {
        size: 4_000_001,
      })
      const tooLarge = await parseJsonResponse(tooLargeResponse)
      expect(tooLarge.status).toBe(413)
      expect(tooLarge.json.error).toBe('Audio file too large. Max size is 4MB.')

      const missingKeyResponse = await postTranscribe(`http://${config.host}:${config.port}/api/transcribe`)
      const missingKey = await parseJsonResponse(missingKeyResponse)
      expect(missingKey.status).toBe(400)
      expect(missingKey.json.error).toBe('OpenAI API key required — add it in Settings.')
    } finally {
      await server.stop()
    }
  })

  it('maps /api/transcribe upstream auth errors, upstream failures, and aborts', async () => {
    const config = await makeTempConfig({ managerId: 'manager' })
    await writeAuthKey(config.paths.authFile, 'sk-test-123')

    const manager = new FakeSwarmManager(config, [createManagerDescriptor(config.paths.projectRoot, 'manager')])
    const server = new SwarmWebSocketServer({
      swarmManager: manager as unknown as never,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: false,
    })

    await server.start()

    const localOrigin = `http://${config.host}:${config.port}`
    const originalFetch = globalThis.fetch

    try {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

        if (url.startsWith(localOrigin)) {
          return originalFetch(input as any, init as any)
        }

        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
      })

      const unauthorizedResponse = await postTranscribe(`${localOrigin}/api/transcribe`)
      const unauthorized = await parseJsonResponse(unauthorizedResponse)
      expect(unauthorized.status).toBe(401)
      expect(unauthorized.json.error).toBe('OpenAI API key rejected — update it in Settings.')

      fetchSpy.mockImplementation(async (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

        if (url.startsWith(localOrigin)) {
          return originalFetch(input as any, init as any)
        }

        return new Response(JSON.stringify({ error: 'upstream failure' }), { status: 503 })
      })

      const upstreamFailureResponse = await postTranscribe(`${localOrigin}/api/transcribe`)
      const upstreamFailure = await parseJsonResponse(upstreamFailureResponse)
      expect(upstreamFailure.status).toBe(502)
      expect(upstreamFailure.json.error).toBe('Transcription failed. Please try again.')

      fetchSpy.mockImplementation(async (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

        if (url.startsWith(localOrigin)) {
          return originalFetch(input as any, init as any)
        }

        const error = new Error('aborted')
        Object.assign(error, { name: 'AbortError' })
        throw error
      })

      const timeoutResponse = await postTranscribe(`${localOrigin}/api/transcribe`)
      const timeout = await parseJsonResponse(timeoutResponse)
      expect(timeout.status).toBe(504)
      expect(timeout.json.error).toBe('Transcription timed out.')
    } finally {
      await server.stop()
    }
  })

  it('streams OAuth login SSE events and accepts prompt responses', async () => {
    oauthMockState.anthropicLogin.mockImplementation(async (callbacks: any) => {
      callbacks.onProgress?.('Preparing OAuth login')
      callbacks.onAuth?.({
        url: 'https://auth.example.test',
        instructions: 'Open the URL in your browser.',
      })

      const code = await callbacks.onPrompt?.({
        message: 'Paste the one-time code',
        placeholder: 'code-123',
      })

      callbacks.onProgress?.(`Received code: ${code}`)

      return {
        accessToken: 'oauth-access-token',
        refreshToken: 'oauth-refresh-token',
      }
    })

    const config = await makeTempConfig({ managerId: 'manager' })
    const manager = new FakeSwarmManager(config, [createManagerDescriptor(config.paths.projectRoot, 'manager')])
    const server = new SwarmWebSocketServer({
      swarmManager: manager as unknown as never,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: false,
    })

    await server.start()

    try {
      const streamResponse = await fetch(`http://${config.host}:${config.port}/api/settings/auth/login/anthropic`, {
        method: 'POST',
      })

      expect(streamResponse.status).toBe(200)
      expect(streamResponse.headers.get('content-type')).toContain('text/event-stream')

      let responded = false
      const events = await readSseEvents(streamResponse, async (event) => {
        if (event.event !== 'prompt' || responded) {
          return
        }

        responded = true
        const respondResponse = await fetch(
          `http://${config.host}:${config.port}/api/settings/auth/login/anthropic/respond`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ value: 'code-from-user' }),
          },
        )

        const payload = await parseJsonResponse(respondResponse)
        expect(payload.status).toBe(200)
        expect(payload.json.ok).toBe(true)
      })

      const eventNames = events.map((event) => event.event)
      expect(eventNames).toEqual(expect.arrayContaining(['progress', 'auth_url', 'prompt', 'complete']))
      expect(oauthMockState.anthropicLogin).toHaveBeenCalledTimes(1)

      const storedAuth = JSON.parse(await readFile(config.paths.authFile, 'utf8')) as Record<string, unknown>
      expect(storedAuth.anthropic).toMatchObject({
        type: 'oauth',
      })
    } finally {
      await server.stop()
    }
  })

  it('validates OAuth login provider and path segments', async () => {
    const config = await makeTempConfig({ managerId: 'manager' })
    const manager = new FakeSwarmManager(config, [createManagerDescriptor(config.paths.projectRoot, 'manager')])
    const server = new SwarmWebSocketServer({
      swarmManager: manager as unknown as never,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: false,
    })

    await server.start()

    try {
      const invalidProviderResponse = await fetch(
        `http://${config.host}:${config.port}/api/settings/auth/login/not-a-provider`,
        {
          method: 'POST',
        },
      )
      const invalidProvider = await parseJsonResponse(invalidProviderResponse)
      expect(invalidProvider.status).toBe(400)
      expect(invalidProvider.json.error).toBe('Invalid OAuth provider')

      const invalidPathResponse = await fetch(
        `http://${config.host}:${config.port}/api/settings/auth/login/anthropic/extra`,
        {
          method: 'POST',
        },
      )
      const invalidPath = await parseJsonResponse(invalidPathResponse)
      expect(invalidPath.status).toBe(400)
      expect(invalidPath.json.error).toBe('Invalid OAuth login path')
    } finally {
      await server.stop()
    }
  })

  it('supports nested note CRUD, renames, folders, and tree listing via /api/notes', async () => {
    const config = await makeTempConfig({ managerId: 'manager' })
    const manager = new FakeSwarmManager(config, [createManagerDescriptor(config.paths.projectRoot, 'manager')])
    const server = new SwarmWebSocketServer({
      swarmManager: manager as unknown as never,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: false,
    })

    await server.start()

    try {
      const emptyListResponse = await fetch(`http://${config.host}:${config.port}/api/notes`)
      const emptyList = await parseJsonResponse(emptyListResponse)
      expect(emptyList.status).toBe(200)
      expect(emptyList.json.tree).toEqual([])

      const notesDirStats = await stat(join(config.paths.dataDir, 'notes'))
      expect(notesDirStats.isDirectory()).toBe(true)

      const createFolderResponse = await fetch(
        `http://${config.host}:${config.port}/api/notes/folder/${encodeURIComponent('projects')}`,
        {
          method: 'PUT',
        },
      )
      const createdFolder = await parseJsonResponse(createFolderResponse)
      expect(createdFolder.status).toBe(201)
      expect(createdFolder.json.folder).toEqual({
        kind: 'folder',
        path: 'projects',
        name: 'projects',
        children: [],
      })

      const createDailyNoteResponse = await fetch(
        `http://${config.host}:${config.port}/api/notes/${encodeURIComponent('daily/2026-03-11.md')}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'text/markdown; charset=utf-8' },
          body: '# Daily Log\n\n- Ship notes\n- Verify autosave\n',
        },
      )
      const createdDailyNote = await parseJsonResponse(createDailyNoteResponse)
      expect(createdDailyNote.status).toBe(201)
      expect(createdDailyNote.json.note).toMatchObject({
        path: 'daily/2026-03-11.md',
        name: '2026-03-11.md',
        title: 'Daily Log',
      })

      const createProjectNoteResponse = await fetch(
        `http://${config.host}:${config.port}/api/notes/${encodeURIComponent('projects/middleman.md')}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'text/markdown; charset=utf-8' },
          body: '# Middleman\n\n- Build notes tree\n',
        },
      )
      const createdProjectNote = await parseJsonResponse(createProjectNoteResponse)
      expect(createdProjectNote.status).toBe(201)
      expect(createdProjectNote.json.note).toMatchObject({
        path: 'projects/middleman.md',
        name: 'middleman.md',
        title: 'Middleman',
      })

      expect(await readFile(join(config.paths.dataDir, 'notes', 'daily', '2026-03-11.md'), 'utf8')).toBe(
        '# Daily Log\n\n- Ship notes\n- Verify autosave\n',
      )
      expect(await readFile(join(config.paths.dataDir, 'notes', 'projects', 'middleman.md'), 'utf8')).toBe(
        '# Middleman\n\n- Build notes tree\n',
      )

      const renameResponse = await fetch(
        `http://${config.host}:${config.port}/api/notes/${encodeURIComponent('daily/2026-03-11.md')}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ newFilename: 'archive/2026-03-11.md' }),
        },
      )
      const renamed = await parseJsonResponse(renameResponse)
      expect(renamed.status).toBe(200)
      expect(renamed.json.note).toMatchObject({
        path: 'archive/2026-03-11.md',
        name: '2026-03-11.md',
        title: 'Daily Log',
        content: '# Daily Log\n\n- Ship notes\n- Verify autosave\n',
      })

      const noteResponse = await fetch(
        `http://${config.host}:${config.port}/api/notes/${encodeURIComponent('archive/2026-03-11.md')}`,
      )
      const note = await parseJsonResponse(noteResponse)
      expect(note.status).toBe(200)
      expect(note.json.note).toMatchObject({
        path: 'archive/2026-03-11.md',
        name: '2026-03-11.md',
        title: 'Daily Log',
        content: '# Daily Log\n\n- Ship notes\n- Verify autosave\n',
      })

      const listResponse = await fetch(`http://${config.host}:${config.port}/api/notes`)
      const list = await parseJsonResponse(listResponse)
      expect(list.status).toBe(200)
      expect(list.json.tree).toEqual([
        expect.objectContaining({
          kind: 'folder',
          path: 'archive',
          name: 'archive',
          children: [
            expect.objectContaining({
              kind: 'file',
              path: 'archive/2026-03-11.md',
              name: '2026-03-11.md',
              title: 'Daily Log',
            }),
          ],
        }),
        expect.objectContaining({
          kind: 'folder',
          path: 'daily',
          name: 'daily',
          children: [],
        }),
        expect.objectContaining({
          kind: 'folder',
          path: 'projects',
          name: 'projects',
          children: [
            expect.objectContaining({
              kind: 'file',
              path: 'projects/middleman.md',
              name: 'middleman.md',
              title: 'Middleman',
            }),
          ],
        }),
      ])

      const deleteFolderResponse = await fetch(
        `http://${config.host}:${config.port}/api/notes/folder/${encodeURIComponent('projects')}`,
        {
          method: 'DELETE',
        },
      )
      expect(deleteFolderResponse.status).toBe(204)

      const missingProjectResponse = await fetch(
        `http://${config.host}:${config.port}/api/notes/${encodeURIComponent('projects/middleman.md')}`,
      )
      const missingProject = await parseJsonResponse(missingProjectResponse)
      expect(missingProject.status).toBe(404)
      expect(missingProject.json.error).toBe('Note "projects/middleman.md" was not found.')

      const deleteArchiveResponse = await fetch(
        `http://${config.host}:${config.port}/api/notes/${encodeURIComponent('archive/2026-03-11.md')}`,
        {
          method: 'DELETE',
        },
      )
      expect(deleteArchiveResponse.status).toBe(204)
    } finally {
      await server.stop()
    }
  })

  it('uploads note images, serves them back, and keeps attachments out of the notes tree', async () => {
    const config = await makeTempConfig({ managerId: 'manager' })
    const manager = new FakeSwarmManager(config, [createManagerDescriptor(config.paths.projectRoot, 'manager')])
    const server = new SwarmWebSocketServer({
      swarmManager: manager as unknown as never,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: false,
    })

    await server.start()

    try {
      const imageBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])
      const formData = new FormData()
      formData.set('file', new File([imageBytes], 'clipboard.png', { type: 'image/png' }))

      const uploadResponse = await fetch(`http://${config.host}:${config.port}/api/notes/upload`, {
        method: 'POST',
        body: formData,
      })
      const upload = await parseJsonResponse(uploadResponse)
      expect(upload.status).toBe(201)
      expect(upload.json.path).toMatch(/^attachments\/\d{13}-[a-f0-9]{12}-[a-f0-9]{12}\.png$/)

      const attachmentPath = upload.json.path as string
      const attachmentFileName = attachmentPath.slice('attachments/'.length)

      expect(
        await readFile(join(config.paths.dataDir, 'notes', 'attachments', attachmentFileName)),
      ).toEqual(Buffer.from(imageBytes))

      const treeResponse = await fetch(`http://${config.host}:${config.port}/api/notes`)
      const tree = await parseJsonResponse(treeResponse)
      expect(tree.status).toBe(200)
      expect(tree.json.tree).toEqual([])

      const attachmentResponse = await fetch(
        `http://${config.host}:${config.port}/api/notes/attachments/${encodeURIComponent(attachmentFileName)}`,
      )
      expect(attachmentResponse.status).toBe(200)
      expect(attachmentResponse.headers.get('content-type')).toBe('image/png')
      expect(Buffer.from(await attachmentResponse.arrayBuffer())).toEqual(Buffer.from(imageBytes))
    } finally {
      await server.stop()
    }
  })

  it('rejects path traversal and symbolic links for nested note reads and writes', async () => {
    const config = await makeTempConfig({ managerId: 'manager' })
    const manager = new FakeSwarmManager(config, [createManagerDescriptor(config.paths.projectRoot, 'manager')])
    const server = new SwarmWebSocketServer({
      swarmManager: manager as unknown as never,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: false,
    })

    await server.start()

    try {
      const traversalResponse = await fetch(
        `http://${config.host}:${config.port}/api/notes/${encodeURIComponent('../escape.md')}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'text/markdown; charset=utf-8' },
          body: '# nope\n',
        },
      )
      const traversal = await parseJsonResponse(traversalResponse)
      expect(traversal.status).toBe(400)
      expect(traversal.json.error).toBe('path must not include "." or ".." segments.')

      const notesDir = join(config.paths.dataDir, 'notes')
      const externalPath = join(config.paths.dataDir, 'outside.md')
      const externalDirectory = join(config.paths.dataDir, 'outside-dir')
      await mkdir(notesDir, { recursive: true })
      await mkdir(externalDirectory, { recursive: true })
      await writeFile(externalPath, '# outside\n', 'utf8')
      await writeFile(join(externalDirectory, 'note.md'), '# nested outside\n', 'utf8')
      await symlink(externalPath, join(notesDir, 'linked.md'))
      await symlink(externalDirectory, join(notesDir, 'daily'))

      const readLinkedResponse = await fetch(
        `http://${config.host}:${config.port}/api/notes/${encodeURIComponent('linked.md')}`,
      )
      const readLinked = await parseJsonResponse(readLinkedResponse)
      expect(readLinked.status).toBe(400)
      expect(readLinked.json.error).toBe('Note "linked.md" must not be a symbolic link.')

      const writeLinkedResponse = await fetch(
        `http://${config.host}:${config.port}/api/notes/${encodeURIComponent('linked.md')}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'text/markdown; charset=utf-8' },
          body: '# replaced\n',
        },
      )
      const writeLinked = await parseJsonResponse(writeLinkedResponse)
      expect(writeLinked.status).toBe(400)
      expect(writeLinked.json.error).toBe('Note "linked.md" must not be a symbolic link.')
      expect(await readFile(externalPath, 'utf8')).toBe('# outside\n')

      const readNestedLinkedResponse = await fetch(
        `http://${config.host}:${config.port}/api/notes/${encodeURIComponent('daily/note.md')}`,
      )
      const readNestedLinked = await parseJsonResponse(readNestedLinkedResponse)
      expect(readNestedLinked.status).toBe(400)
      expect(readNestedLinked.json.error).toBe('Folder "daily" must not be a symbolic link.')

      const writeNestedLinkedResponse = await fetch(
        `http://${config.host}:${config.port}/api/notes/${encodeURIComponent('daily/note.md')}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'text/markdown; charset=utf-8' },
          body: '# replaced nested\n',
        },
      )
      const writeNestedLinked = await parseJsonResponse(writeNestedLinkedResponse)
      expect(writeNestedLinked.status).toBe(400)
      expect(writeNestedLinked.json.error).toBe('Folder "daily" must not be a symbolic link.')
    } finally {
      await server.stop()
    }
  })

  it('rejects note attachment traversal and symbolic links', async () => {
    const config = await makeTempConfig({ managerId: 'manager' })
    const manager = new FakeSwarmManager(config, [createManagerDescriptor(config.paths.projectRoot, 'manager')])
    const server = new SwarmWebSocketServer({
      swarmManager: manager as unknown as never,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: false,
    })

    await server.start()

    try {
      const traversalResponse = await fetch(
        `http://${config.host}:${config.port}/api/notes/attachments/${encodeURIComponent('../escape.png')}`,
      )
      const traversal = await parseJsonResponse(traversalResponse)
      expect(traversal.status).toBe(400)
      expect(traversal.json.error).toBe('filename must not include path separators or dot segments.')

      const notesDir = join(config.paths.dataDir, 'notes')
      const externalAttachmentDir = join(config.paths.dataDir, 'outside-attachments')
      await mkdir(notesDir, { recursive: true })
      await mkdir(externalAttachmentDir, { recursive: true })
      await writeFile(join(externalAttachmentDir, 'linked.png'), Buffer.from([1, 2, 3]))
      await symlink(externalAttachmentDir, join(notesDir, 'attachments'))

      const formData = new FormData()
      formData.set('file', new File([Uint8Array.from([1, 2, 3])], 'linked.png', { type: 'image/png' }))

      const uploadResponse = await fetch(`http://${config.host}:${config.port}/api/notes/upload`, {
        method: 'POST',
        body: formData,
      })
      const upload = await parseJsonResponse(uploadResponse)
      expect(upload.status).toBe(400)
      expect(upload.json.error).toBe('Folder "attachments" must not be a symbolic link.')

      const attachmentResponse = await fetch(
        `http://${config.host}:${config.port}/api/notes/attachments/${encodeURIComponent('linked.png')}`,
      )
      const attachment = await parseJsonResponse(attachmentResponse)
      expect(attachment.status).toBe(400)
      expect(attachment.json.error).toBe('Folder "attachments" must not be a symbolic link.')
    } finally {
      await server.stop()
    }
  })

  it('handles manager-scoped Slack/Telegram routes and validates methods/payloads', async () => {
    const config = await makeTempConfig({ managerId: 'manager' })
    const manager = new FakeSwarmManager(config, [createManagerDescriptor(config.paths.projectRoot, 'manager')])
    const integrationRegistry = createIntegrationRegistryMock()

    const server = new SwarmWebSocketServer({
      swarmManager: manager as unknown as never,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: false,
      integrationRegistry: integrationRegistry as unknown as never,
    })

    await server.start()

    try {
      const unknownManagerResponse = await fetch(
        `http://${config.host}:${config.port}/api/managers/ghost/integrations/slack`,
      )
      const unknownManager = await parseJsonResponse(unknownManagerResponse)
      expect(unknownManager.status).toBe(404)
      expect(unknownManager.json.error).toBe('Unknown manager: ghost')

      const slackTestResponse = await fetch(
        `http://${config.host}:${config.port}/api/managers/manager/integrations/slack/test`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ dryRun: true }),
        },
      )
      const slackTest = await parseJsonResponse(slackTestResponse)
      expect(slackTest.status).toBe(200)
      expect(integrationRegistry.testSlackConnection).toHaveBeenCalledWith('manager', { dryRun: true })

      const telegramWrongMethodResponse = await fetch(
        `http://${config.host}:${config.port}/api/managers/manager/integrations/telegram`,
        {
          method: 'PATCH',
        },
      )
      const telegramWrongMethod = await parseJsonResponse(telegramWrongMethodResponse)
      expect(telegramWrongMethod.status).toBe(405)
      expect(telegramWrongMethod.json.error).toBe('Method Not Allowed')
    } finally {
      await server.stop()
    }
  })

  it('does not expose legacy Slack integration routes', async () => {
    const config = await makeTempConfig({ managerId: undefined })
    const manager = new FakeSwarmManager(config, [])
    const integrationRegistry = createIntegrationRegistryMock()

    const server = new SwarmWebSocketServer({
      swarmManager: manager as unknown as never,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: false,
      integrationRegistry: integrationRegistry as unknown as never,
    })

    await server.start()

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/integrations/slack`)
      expect(response.status).toBe(404)
    } finally {
      await server.stop()
    }
  })
})
