import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionManager } from '@mariozechner/pi-coding-agent'
import { getScheduleFilePath } from '../scheduler/schedule-storage.js'
import { SwarmManager } from '../swarm/swarm-manager.js'
import type {
  AgentContextUsage,
  AgentDescriptor,
  RequestedDeliveryMode,
  SendMessageReceipt,
  SwarmConfig,
} from '../swarm/types.js'
import type { RuntimeUserMessage, SwarmAgentRuntime } from '../swarm/runtime-types.js'

class FakeRuntime {
  readonly descriptor: AgentDescriptor
  private readonly sessionManager: SessionManager
  terminateCalls: Array<{ abort?: boolean } | undefined> = []
  stopInFlightCalls: Array<{ abort?: boolean } | undefined> = []
  sendCalls: Array<{ message: string | RuntimeUserMessage; delivery: RequestedDeliveryMode }> = []
  compactCalls: Array<string | undefined> = []
  nextDeliveryId = 0
  busy = false

  constructor(descriptor: AgentDescriptor) {
    this.descriptor = descriptor
    this.sessionManager = SessionManager.open(descriptor.sessionFile)
  }

  getStatus(): AgentDescriptor['status'] {
    return this.descriptor.status
  }

  getPendingCount(): number {
    return this.busy ? 1 : 0
  }

  getContextUsage(): AgentContextUsage | undefined {
    return undefined
  }

  async sendMessage(message: string | RuntimeUserMessage, delivery: RequestedDeliveryMode = 'auto'): Promise<SendMessageReceipt> {
    this.sendCalls.push({ message, delivery })
    this.nextDeliveryId += 1
    this.sessionManager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'ack' }],
    } as any)

    return {
      targetAgentId: this.descriptor.agentId,
      deliveryId: `delivery-${this.nextDeliveryId}`,
      acceptedMode: this.busy ? 'steer' : 'prompt',
    }
  }

  async terminate(options?: { abort?: boolean }): Promise<void> {
    this.terminateCalls.push(options)
  }

  async stopInFlight(options?: { abort?: boolean }): Promise<void> {
    this.stopInFlightCalls.push(options)
    this.busy = false
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
  readonly runtimeByAgentId = new Map<string, FakeRuntime>()
  readonly createdRuntimeIds: string[] = []
  readonly systemPromptByAgentId = new Map<string, string>()

  async getMemoryRuntimeResourcesForTest(agentId = 'manager'): Promise<{
    memoryContextFile: { path: string; content: string }
    additionalSkillPaths: string[]
  }> {
    const descriptor = this.getAgent(agentId)
    if (!descriptor) {
      throw new Error(`Unknown test agent: ${agentId}`)
    }

    return this.getMemoryRuntimeResources(descriptor)
  }

  async getSwarmContextFilesForTest(cwd: string): Promise<Array<{ path: string; content: string }>> {
    return this.getSwarmContextFiles(cwd)
  }

  getLoadedConversationAgentIdsForTest(): string[] {
    const state = this as unknown as {
      conversationEntriesByAgentId: Map<string, unknown>
    }

    return Array.from(state.conversationEntriesByAgentId.keys()).sort((left, right) => left.localeCompare(right))
  }

  protected override async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
  ): Promise<SwarmAgentRuntime> {
    const runtime = new FakeRuntime(descriptor)
    this.createdRuntimeIds.push(descriptor.agentId)
    this.runtimeByAgentId.set(descriptor.agentId, runtime)
    this.systemPromptByAgentId.set(descriptor.agentId, systemPrompt)
    return runtime as unknown as SwarmAgentRuntime
  }
}

function appendSessionConversationMessage(sessionFile: string, agentId: string, text: string): void {
  const sessionManager = SessionManager.open(sessionFile)
  sessionManager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: 'seed' }],
  } as any)
  sessionManager.appendCustomEntry('swarm_conversation_entry', {
    type: 'conversation_message',
    agentId,
    role: 'assistant',
    text,
    timestamp: '2026-01-01T00:00:00.000Z',
    source: 'speak_to_user',
  })
}

function seedManagerDescriptorForRuntimeEventTests(manager: TestSwarmManager, config: SwarmConfig): void {
  const createdAt = '2026-01-01T00:00:00.000Z'
  const state = manager as unknown as {
    descriptors: Map<string, AgentDescriptor>
    conversationEntriesByAgentId: Map<string, unknown[]>
  }

  state.descriptors.set('manager', {
    agentId: 'manager',
    displayName: 'Manager',
    role: 'manager',
    managerId: 'manager',
    status: 'idle',
    createdAt,
    updatedAt: createdAt,
    cwd: config.defaultCwd,
    model: config.defaultModel,
    sessionFile: join(config.paths.sessionsDir, 'manager.jsonl'),
  })
  state.conversationEntriesByAgentId.set('manager', [])
}

async function makeTempConfig(port = 8790): Promise<SwarmConfig> {
  const root = await mkdtemp(join(tmpdir(), 'swarm-manager-test-'))
  const dataDir = join(root, 'data')
  const swarmDir = join(dataDir, 'swarm')
  const sessionsDir = join(dataDir, 'sessions')
  const uploadsDir = join(dataDir, 'uploads')
  const authDir = join(dataDir, 'auth')
  const agentDir = join(dataDir, 'agent')
  const managerAgentDir = join(agentDir, 'manager')
  const repoArchetypesDir = join(root, '.swarm', 'archetypes')
  const memoryDir = join(dataDir, 'memory')
  const memoryFile = join(memoryDir, 'manager.md')
  const repoMemorySkillFile = join(root, '.swarm', 'skills', 'memory', 'SKILL.md')

  await mkdir(swarmDir, { recursive: true })
  await mkdir(sessionsDir, { recursive: true })
  await mkdir(uploadsDir, { recursive: true })
  await mkdir(authDir, { recursive: true })
  await mkdir(memoryDir, { recursive: true })
  await mkdir(agentDir, { recursive: true })
  await mkdir(managerAgentDir, { recursive: true })
  await mkdir(repoArchetypesDir, { recursive: true })

  return {
    host: '127.0.0.1',
    port,
    debug: false,
    allowNonManagerSubscriptions: false,
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
      rootDir: root,
      dataDir,
      swarmDir,
      sessionsDir,
      uploadsDir,
      authDir,
      authFile: join(authDir, 'auth.json'),
      agentDir,
      managerAgentDir,
      repoArchetypesDir,
      memoryDir,
      memoryFile,
      repoMemorySkillFile,
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

  const createdManager = await manager.createManager(managerId, {
    name: managerName,
    cwd: config.defaultCwd,
  })

  // `createManager` sends an internal bootstrap message; clear fake runtime calls for deterministic assertions.
  const createdRuntime = manager.runtimeByAgentId.get(createdManager.agentId)
  if (createdRuntime) {
    createdRuntime.sendCalls = []
    createdRuntime.nextDeliveryId = 0
  }

  return createdManager
}

describe('SwarmManager', () => {
  it('does not auto-create a manager on boot when the store is empty', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await manager.boot()

    const agents = manager.listAgents()
    expect(agents).toEqual([])
    expect(manager.createdRuntimeIds).toEqual([])
    expect(manager.runtimeByAgentId.size).toBe(0)
  })

  it('does not materialize manager SYSTEM.md into the data dir on boot', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await manager.boot()

    await expect(readFile(join(config.paths.managerAgentDir, 'SYSTEM.md'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('bootstraps manager memory file in dataDir/memory when missing', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await manager.boot()

    const memory = await readFile(config.paths.memoryFile!, 'utf8')
    expect(memory).toContain('# Swarm Memory')
    expect(memory).toContain('## User Preferences')
  })

  it('preserves existing manager memory content across restart', async () => {
    const config = await makeTempConfig()

    const firstBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(firstBoot, config)

    const persistedMemory = '# Swarm Memory\n\n## Project Facts\n- remember me\n'
    await writeFile(config.paths.memoryFile!, persistedMemory, 'utf8')

    const secondBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(secondBoot, config)

    const memory = await readFile(config.paths.memoryFile!, 'utf8')
    expect(memory).toBe(persistedMemory)

    const resources = await secondBoot.getMemoryRuntimeResourcesForTest()
    expect(resources.memoryContextFile.content).toBe(persistedMemory)
  })

  it('does not migrate legacy global MEMORY.md into manager memory on boot', async () => {
    const config = await makeTempConfig()
    const legacyMemoryFile = join(config.paths.dataDir, 'MEMORY.md')
    const legacyContent = '# Swarm Memory\n\n## Project Facts\n- migrated legacy memory\n'

    await writeFile(legacyMemoryFile, legacyContent, 'utf8')

    const manager = new TestSwarmManager(config)
    await manager.boot()

    const managerMemory = await readFile(config.paths.memoryFile!, 'utf8')
    expect(managerMemory).toContain('# Swarm Memory')
    expect(managerMemory).not.toBe(legacyContent)

    await expect(readFile(join(config.paths.memoryDir, '.migrated'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('workers load their owning manager memory file', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Memory Worker' })
    const workerMemoryFile = join(config.paths.memoryDir, `${worker.agentId}.md`)

    await writeFile(config.paths.memoryFile!, '# Swarm Memory\n\n## Decisions\n- manager memory\n', 'utf8')
    await writeFile(workerMemoryFile, '# Swarm Memory\n\n## Decisions\n- worker memory\n', 'utf8')

    const resources = await manager.getMemoryRuntimeResourcesForTest(worker.agentId)
    expect(resources.memoryContextFile.path).toBe(config.paths.memoryFile!)
    expect(resources.memoryContextFile.content).toContain('manager memory')
    expect(resources.memoryContextFile.content).not.toContain('worker memory')
  })

  it('loads SWARM.md context files from the cwd ancestor chain', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    const rootSwarmPath = join(config.paths.rootDir, 'SWARM.md')
    const nestedDir = join(config.paths.rootDir, 'nested', 'deeper')
    const nestedSwarmPath = join(config.paths.rootDir, 'nested', 'SWARM.md')

    await mkdir(nestedDir, { recursive: true })
    await writeFile(rootSwarmPath, '# root swarm policy\n', 'utf8')
    await writeFile(nestedSwarmPath, '# nested swarm policy\n', 'utf8')

    const files = await manager.getSwarmContextFilesForTest(nestedDir)

    expect(files).toEqual([
      {
        path: rootSwarmPath,
        content: '# root swarm policy\n',
      },
      {
        path: nestedSwarmPath,
        content: '# nested swarm policy\n',
      },
    ])
  })

  it('returns no SWARM.md context files when none are present', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    const files = await manager.getSwarmContextFilesForTest(config.paths.rootDir)

    expect(files).toEqual([])
  })

  it('uses manager and default worker prompts with explicit visibility guidance', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const managerPrompt = manager.systemPromptByAgentId.get('manager')
    expect(managerPrompt).toContain('You are the manager agent in a multi-agent swarm.')
    expect(managerPrompt).toContain('End users only see two things')
    expect(managerPrompt).toContain('prefixed with "SYSTEM:"')
    expect(managerPrompt).toContain('Your manager memory file is `${SWARM_MEMORY_FILE}`')

    const worker = await manager.spawnAgent('manager', { agentId: 'Prompt Worker' })
    const workerPrompt = manager.systemPromptByAgentId.get(worker.agentId)

    expect(workerPrompt).toBeDefined()
    expect(workerPrompt).toContain('End users only see messages they send and manager speak_to_user outputs.')
    expect(workerPrompt).toContain('Incoming messages prefixed with "SYSTEM:"')
    expect(workerPrompt).toContain('Persistent memory for this runtime is at ${SWARM_MEMORY_FILE}')
    expect(workerPrompt).toContain('Workers read their owning manager\'s memory file.')
    expect(workerPrompt).toContain('Follow the memory skill workflow before editing the memory file')
  })

  it('auto-loads per-runtime memory context and wires built-in memory + brave-search + cron-scheduling + agent-browser + image-generation skills', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const persistedMemory = '# Swarm Memory\n\n## Project Facts\n- release train: friday\n'
    await writeFile(config.paths.memoryFile!, persistedMemory, 'utf8')

    const resources = await manager.getMemoryRuntimeResourcesForTest()
    expect(resources.memoryContextFile.path).toBe(config.paths.memoryFile!)
    expect(resources.memoryContextFile.content).toBe(persistedMemory)
    expect(resources.additionalSkillPaths).toHaveLength(5)

    const memorySkill = await readFile(resources.additionalSkillPaths[0], 'utf8')
    expect(memorySkill).toContain('name: memory')
    expect(memorySkill).toContain('In this runtime, use `${SWARM_MEMORY_FILE}`')

    const braveSkill = await readFile(resources.additionalSkillPaths[1], 'utf8')
    expect(braveSkill).toContain('name: brave-search')
    expect(braveSkill).toContain('BRAVE_API_KEY')

    const cronSkill = await readFile(resources.additionalSkillPaths[2], 'utf8')
    expect(cronSkill).toContain('name: cron-scheduling')
    expect(cronSkill).toContain('schedule.js add')

    const agentBrowserSkill = await readFile(resources.additionalSkillPaths[3], 'utf8')
    expect(agentBrowserSkill).toContain('name: agent-browser')
    expect(agentBrowserSkill).toContain('agent-browser snapshot -i --json')

    const imageGenerationSkill = await readFile(resources.additionalSkillPaths[4], 'utf8')
    expect(imageGenerationSkill).toContain('name: image-generation')
    expect(imageGenerationSkill).toContain('GEMINI_API_KEY')

  })

  it('loads skill env requirements and persists secrets to the settings store', async () => {
    const previousBraveApiKey = process.env.BRAVE_API_KEY
    const previousGeminiApiKey = process.env.GEMINI_API_KEY
    delete process.env.BRAVE_API_KEY
    delete process.env.GEMINI_API_KEY

    try {
      const config = await makeTempConfig()
      const manager = new TestSwarmManager(config)
      await manager.boot()

      const initial = await manager.listSettingsEnv()
      const braveRequirement = initial.find(
        (requirement) => requirement.name === 'BRAVE_API_KEY' && requirement.skillName === 'brave-search',
      )
      const geminiRequirement = initial.find(
        (requirement) => requirement.name === 'GEMINI_API_KEY' && requirement.skillName === 'image-generation',
      )

      expect(braveRequirement).toMatchObject({
        description: 'Brave Search API key',
        required: true,
        helpUrl: 'https://api-dashboard.search.brave.com/register',
        isSet: false,
      })
      expect(geminiRequirement).toMatchObject({
        description: 'Google AI Studio / Gemini API key',
        required: true,
        isSet: false,
      })

      await manager.updateSettingsEnv({ BRAVE_API_KEY: 'bsal-test-value' })

      const secretsRaw = await readFile(config.paths.secretsFile, 'utf8')
      expect(JSON.parse(secretsRaw)).toEqual({ BRAVE_API_KEY: 'bsal-test-value' })
      expect(process.env.BRAVE_API_KEY).toBe('bsal-test-value')

      const afterUpdate = await manager.listSettingsEnv()
      expect(
        afterUpdate.find(
          (requirement) => requirement.name === 'BRAVE_API_KEY' && requirement.skillName === 'brave-search',
        ),
      ).toMatchObject({
        isSet: true,
        maskedValue: '********',
      })

      await manager.deleteSettingsEnv('BRAVE_API_KEY')

      const afterDelete = await manager.listSettingsEnv()
      expect(
        afterDelete.find(
          (requirement) => requirement.name === 'BRAVE_API_KEY' && requirement.skillName === 'brave-search',
        ),
      ).toMatchObject({
        isSet: false,
      })
      expect(process.env.BRAVE_API_KEY).toBeUndefined()
    } finally {
      if (previousBraveApiKey === undefined) {
        delete process.env.BRAVE_API_KEY
      } else {
        process.env.BRAVE_API_KEY = previousBraveApiKey
      }

      if (previousGeminiApiKey === undefined) {
        delete process.env.GEMINI_API_KEY
      } else {
        process.env.GEMINI_API_KEY = previousGeminiApiKey
      }
    }
  })

  it('restores existing process env values when deleting a secret override', async () => {
    const previousBraveApiKey = process.env.BRAVE_API_KEY
    process.env.BRAVE_API_KEY = 'fallback-value'

    try {
      const config = await makeTempConfig()
      await writeFile(config.paths.secretsFile, JSON.stringify({ BRAVE_API_KEY: 'override-value' }, null, 2), 'utf8')

      const manager = new TestSwarmManager(config)
      await manager.boot()

      expect(process.env.BRAVE_API_KEY).toBe('override-value')

      await manager.deleteSettingsEnv('BRAVE_API_KEY')
      expect(process.env.BRAVE_API_KEY).toBe('fallback-value')
    } finally {
      if (previousBraveApiKey === undefined) {
        delete process.env.BRAVE_API_KEY
      } else {
        process.env.BRAVE_API_KEY = previousBraveApiKey
      }
    }
  })

  it('prefers repo memory skill override when present', async () => {
    const config = await makeTempConfig()
    await mkdir(join(config.paths.rootDir, '.swarm', 'skills', 'memory'), { recursive: true })
    await writeFile(
      config.paths.repoMemorySkillFile,
      ['---', 'name: memory', 'description: Repo override memory workflow.', '---', '', '# Repo memory override', ''].join('\n'),
      'utf8',
    )

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const resources = await manager.getMemoryRuntimeResourcesForTest()
    expect(resources.additionalSkillPaths).toHaveLength(5)
    expect(resources.additionalSkillPaths[0]).toBe(config.paths.repoMemorySkillFile)
    expect(resources.additionalSkillPaths[1].endsWith(join('brave-search', 'SKILL.md'))).toBe(true)
    expect(resources.additionalSkillPaths[2].endsWith(join('cron-scheduling', 'SKILL.md'))).toBe(true)
    expect(resources.additionalSkillPaths[3].endsWith(join('agent-browser', 'SKILL.md'))).toBe(true)
    expect(resources.additionalSkillPaths[4].endsWith(join('image-generation', 'SKILL.md'))).toBe(true)
  })

  it('prefers repo brave-search skill override when present', async () => {
    const config = await makeTempConfig()
    const repoBraveSkillFile = join(config.paths.rootDir, '.swarm', 'skills', 'brave-search', 'SKILL.md')

    await mkdir(join(config.paths.rootDir, '.swarm', 'skills', 'brave-search'), { recursive: true })
    await writeFile(
      repoBraveSkillFile,
      [
        '---',
        'name: brave-search',
        'description: Repo override brave-search workflow.',
        '---',
        '',
        '# Repo brave-search override',
        '',
      ].join('\n'),
      'utf8',
    )

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const resources = await manager.getMemoryRuntimeResourcesForTest()
    expect(resources.additionalSkillPaths).toHaveLength(5)
    expect(resources.additionalSkillPaths[0].endsWith(join('memory', 'SKILL.md'))).toBe(true)
    expect(resources.additionalSkillPaths[1]).toBe(repoBraveSkillFile)
    expect(resources.additionalSkillPaths[2].endsWith(join('cron-scheduling', 'SKILL.md'))).toBe(true)
    expect(resources.additionalSkillPaths[3].endsWith(join('agent-browser', 'SKILL.md'))).toBe(true)
    expect(resources.additionalSkillPaths[4].endsWith(join('image-generation', 'SKILL.md'))).toBe(true)
  })

  it('uses repo manager archetype overrides on boot', async () => {
    const config = await makeTempConfig()
    const managerOverride = 'You are the repo manager override.'
    await writeFile(join(config.paths.repoArchetypesDir, 'manager.md'), `${managerOverride}\n`, 'utf8')

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    expect(manager.systemPromptByAgentId.get('manager')).toBe(managerOverride)
  })

  it('uses merger archetype prompt for merger workers', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const merger = await manager.spawnAgent('manager', {
      agentId: 'Release Merger',
      archetypeId: 'merger',
    })

    const mergerPrompt = manager.systemPromptByAgentId.get(merger.agentId)
    expect(mergerPrompt).toContain('You are the merger agent in a multi-agent swarm.')
    expect(mergerPrompt).toContain('Own branch integration and merge execution tasks.')
    expect(mergerPrompt).toContain('This runtime memory file is `${SWARM_MEMORY_FILE}`')
  })

  it('applies deterministic merger archetype mapping for merger-* worker ids', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const merger = await manager.spawnAgent('manager', { agentId: 'Merger Agent' })

    const mergerPrompt = manager.systemPromptByAgentId.get(merger.agentId)
    expect(merger.agentId).toBe('merger-agent')
    expect(mergerPrompt).toContain('You are the merger agent in a multi-agent swarm.')
  })

  it('restores merger archetype workers with merger prompts on restart', async () => {
    const config = await makeTempConfig()

    const firstBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(firstBoot, config)

    const merger = await firstBoot.spawnAgent('manager', {
      agentId: 'Merger',
      archetypeId: 'merger',
    })

    const secondBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(secondBoot, config)

    expect(secondBoot.systemPromptByAgentId.get(merger.agentId)).toBeUndefined()
    await secondBoot.sendMessage('manager', merger.agentId, 'resume merge')

    expect(secondBoot.systemPromptByAgentId.get(merger.agentId)).toContain(
      'You are the merger agent in a multi-agent swarm.',
    )
  })

  it('spawns unique normalized agent ids on collisions', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const first = await manager.spawnAgent('manager', { agentId: 'Code Scout' })
    const second = await manager.spawnAgent('manager', { agentId: 'Code Scout' })

    expect(first.agentId).toBe('code-scout')
    expect(first.displayName).toBe('code-scout')
    expect(second.agentId).toBe('code-scout-2')
    expect(second.displayName).toBe('code-scout-2')
  })

  it('does not force a worker suffix for normalized ids', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const spawned = await manager.spawnAgent('manager', { agentId: 'Task Owner' })

    expect(spawned.agentId).toBe('task-owner')
    expect(spawned.displayName).toBe('task-owner')
  })

  it('rejects explicit agent ids that would use the reserved manager id', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(manager.spawnAgent('manager', { agentId: 'manager' })).rejects.toThrow(
      'spawn_agent agentId "manager" is reserved',
    )
  })

  it('SYSTEM-prefixes worker initial messages (internal manager->worker input)', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Kickoff Worker',
      initialMessage: 'start implementation',
    })

    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime).toBeDefined()
    expect(workerRuntime?.sendCalls[0]?.message).toBe('SYSTEM: start implementation')
  })

  it('enforces manager-only spawn and kill permissions', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Worker' })

    await expect(manager.spawnAgent(worker.agentId, { agentId: 'Nope' })).rejects.toThrow('Only manager can spawn agents')
    await expect(manager.killAgent(worker.agentId, worker.agentId)).rejects.toThrow('Only manager can kill agents')
  })

  it('returns fire-and-forget receipt and prefixes internal inter-agent deliveries', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Messenger' })

    const receipt = await manager.sendMessage('manager', worker.agentId, 'hi worker', 'auto')

    expect(receipt.targetAgentId).toBe(worker.agentId)
    expect(receipt.deliveryId).toBe('delivery-1')
    expect(receipt.acceptedMode).toBe('prompt')

    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime?.sendCalls.at(-1)?.message).toBe('SYSTEM: hi worker')
  })

  it('sends manager user input as steer delivery, without SYSTEM prefixing, and with source metadata annotation', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('interrupt current plan')

    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()
    expect(managerRuntime?.sendCalls.at(-1)?.delivery).toBe('steer')
    expect(managerRuntime?.sendCalls.at(-1)?.message).toBe('[sourceContext] {"channel":"web"}\n\ninterrupt current plan')
  })

  it('surfaces manager assistant overflow turns as system conversation messages', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    seedManagerDescriptorForRuntimeEventTests(manager, config)

    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage:
          '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 180186 tokens > 180000 maximum"},"request_id":"req_test"}',
      },
    })

    const history = manager.getConversationHistory('manager')
    const systemEvent = [...history]
      .reverse()
      .find(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.role === 'system' &&
          entry.source === 'system' &&
          entry.text.includes('Manager reply failed'),
      )

    expect(systemEvent).toBeDefined()
    if (systemEvent?.type === 'conversation_message') {
      expect(systemEvent.text).toContain('prompt is too long: 180186 tokens > 180000 maximum')
      expect(systemEvent.text).toContain('Try compacting the conversation to free up context space.')
    }
  })

  it('surfaces non-overflow manager runtime errors without overflow wording', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    seedManagerDescriptorForRuntimeEventTests(manager, config)

    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'Rate limit exceeded for requests per minute',
      },
    })

    const history = manager.getConversationHistory('manager')
    const systemEvent = [...history]
      .reverse()
      .find(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.role === 'system' &&
          entry.source === 'system' &&
          entry.text.includes('Manager reply failed'),
      )

    expect(systemEvent).toBeDefined()
    if (systemEvent?.type === 'conversation_message') {
      expect(systemEvent.text).toContain('Rate limit exceeded for requests per minute')
      expect(systemEvent.text).not.toContain('prompt exceeded the model context window')
      expect(systemEvent.text).not.toContain('Try compacting the conversation to free up context space.')
    }
  })

  it('handles undefined/null/empty/malformed errorMessage payloads without crashing', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    seedManagerDescriptorForRuntimeEventTests(manager, config)

    const malformedErrorMessages: unknown[] = [undefined, null, '', { code: 'invalid_request_error' }]

    for (const errorMessage of malformedErrorMessages) {
      await expect(
        (manager as any).handleRuntimeSessionEvent('manager', {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage,
          },
        }),
      ).resolves.toBeUndefined()
    }

    const history = manager.getConversationHistory('manager')
    const systemErrorEvents = history.filter(
      (entry) =>
        entry.type === 'conversation_message' &&
        entry.role === 'system' &&
        entry.source === 'system' &&
        entry.text.includes('Manager reply failed'),
    )
    expect(systemErrorEvents).toHaveLength(malformedErrorMessages.length)
  })

  it('does not surface normal manager assistant turns as conversation messages', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    seedManagerDescriptorForRuntimeEventTests(manager, config)

    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'normal hidden manager assistant turn' }],
        stopReason: 'stop',
      },
    })

    const history = manager.getConversationHistory('manager')
    expect(history).toHaveLength(0)
  })

  it('does not surface non-error manager turns that mention token limits', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    seedManagerDescriptorForRuntimeEventTests(manager, config)

    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'We should keep the summary short to avoid token limit issues.' }],
        stopReason: 'stop',
      },
    })

    const history = manager.getConversationHistory('manager')
    expect(history).toHaveLength(0)
  })

  it('handles /compact as a manager slash command without forwarding it as a user prompt', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('/compact')

    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()
    expect(managerRuntime?.compactCalls).toEqual([undefined])
    expect(managerRuntime?.sendCalls).toEqual([])

    const history = manager.getConversationHistory('manager')
    expect(
      history.some(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.role === 'system' &&
          entry.text === 'Compacting manager context...',
      ),
    ).toBe(true)
    expect(
      history.some(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.role === 'system' &&
          entry.text === 'Compaction complete.',
      ),
    ).toBe(true)
    expect(
      history.some(
        (entry) =>
          entry.type === 'conversation_message' && entry.role === 'user' && entry.text === '/compact',
      ),
    ).toBe(false)
  })

  it('passes optional custom instructions for /compact slash commands', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('/compact focus the summary on open implementation tasks')

    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime?.compactCalls).toEqual(['focus the summary on open implementation tasks'])
  })

  it('tags web user messages with default source metadata', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('interrupt current plan')

    const history = manager.getConversationHistory('manager')
    const userEvent = history.find(
      (entry) => entry.type === 'conversation_message' && entry.role === 'user' && entry.text === 'interrupt current plan',
    )

    expect(userEvent).toBeDefined()
    if (userEvent?.type === 'conversation_message') {
      expect(userEvent.sourceContext).toEqual({ channel: 'web' })
    }
  })

  it('includes full sourceContext annotation when forwarding slack user messages to manager runtime', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('reply in slack thread', {
      sourceContext: {
        channel: 'slack',
        channelId: 'C123',
        userId: 'U456',
        threadTs: '173.456',
        channelType: 'channel',
        teamId: 'T789',
      },
    })

    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime?.sendCalls.at(-1)?.message).toBe(
      '[sourceContext] {"channel":"slack","channelId":"C123","userId":"U456","threadTs":"173.456","channelType":"channel","teamId":"T789"}\n\nreply in slack thread',
    )
  })

  it('defaults speak_to_user routing to web when target is omitted, even after slack input', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('reply in slack thread', {
      sourceContext: {
        channel: 'slack',
        channelId: 'C123',
        userId: 'U456',
        threadTs: '173.456',
      },
    })

    await manager.publishToUser('manager', 'ack from manager', 'speak_to_user')

    const history = manager.getConversationHistory('manager')
    const assistantEvent = [...history]
      .reverse()
      .find((entry) => entry.type === 'conversation_message' && entry.source === 'speak_to_user')

    expect(assistantEvent).toBeDefined()
    if (assistantEvent?.type === 'conversation_message') {
      expect(assistantEvent.sourceContext).toEqual({ channel: 'web' })
    }
  })

  it('uses explicit speak_to_user targets without inferred fallback behavior', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('reply in slack thread', {
      sourceContext: {
        channel: 'slack',
        channelId: 'C123',
        userId: 'U456',
        threadTs: '173.456',
      },
    })

    await manager.publishToUser('manager', 'ack from manager', 'speak_to_user', {
      channel: 'slack',
      channelId: 'C999',
      userId: 'U000',
      threadTs: '999.000',
    })

    const history = manager.getConversationHistory('manager')
    const assistantEvent = [...history]
      .reverse()
      .find((entry) => entry.type === 'conversation_message' && entry.source === 'speak_to_user')

    expect(assistantEvent).toBeDefined()
    if (assistantEvent?.type === 'conversation_message') {
      expect(assistantEvent.sourceContext).toEqual({
        channel: 'slack',
        channelId: 'C999',
        userId: 'U000',
        threadTs: '999.000',
      })
    }
  })

  it('requires channelId for explicit slack speak_to_user targets', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(
      manager.publishToUser('manager', 'ack from manager', 'speak_to_user', {
        channel: 'slack',
      }),
    ).rejects.toThrow(
      'speak_to_user target.channelId is required when target.channel is "slack" or "telegram"',
    )
  })

  it('falls back to web routing when no explicit target context exists', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.publishToUser('manager', 'ack from manager', 'speak_to_user')

    const history = manager.getConversationHistory('manager')
    const assistantEvent = [...history]
      .reverse()
      .find((entry) => entry.type === 'conversation_message' && entry.source === 'speak_to_user')

    expect(assistantEvent).toBeDefined()
    if (assistantEvent?.type === 'conversation_message') {
      expect(assistantEvent.sourceContext).toEqual({ channel: 'web' })
    }
  })

  it('does not SYSTEM-prefix direct user messages routed to a worker', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'User Routed Worker' })

    await manager.handleUserMessage('hello worker', { targetAgentId: worker.agentId })

    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime).toBeDefined()
    expect(workerRuntime?.sendCalls.at(-1)?.message).toBe('hello worker')
  })

  it('routes user image attachments to worker runtimes and conversation events', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Image Worker' })

    await manager.handleUserMessage('', {
      targetAgentId: worker.agentId,
      attachments: [
        {
          mimeType: 'image/png',
          data: 'aGVsbG8=',
          fileName: 'diagram.png',
        },
      ],
    })

    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime).toBeDefined()

    const sentMessage = workerRuntime?.sendCalls.at(-1)?.message
    expect(typeof sentMessage).toBe('object')
    if (sentMessage && typeof sentMessage !== 'string') {
      expect(sentMessage.text).toBe('')
      expect(sentMessage.images).toEqual([
        {
          mimeType: 'image/png',
          data: 'aGVsbG8=',
        },
      ])
    }

    const history = manager.getConversationHistory(worker.agentId)
    const userEvent = history.find(
      (entry) => entry.type === 'conversation_message' && entry.role === 'user' && entry.source === 'user_input',
    )

    expect(userEvent).toBeDefined()
    if (userEvent && userEvent.type === 'conversation_message') {
      expect(userEvent.text).toBe('')
      expect(userEvent.attachments).toEqual([
        {
          mimeType: 'image/png',
          data: 'aGVsbG8=',
          fileName: 'diagram.png',
        },
      ])
    }
  })

  it('injects text attachments into the runtime prompt', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Text Attachment Worker' })

    await manager.handleUserMessage('Please review this file.', {
      targetAgentId: worker.agentId,
      attachments: [
        {
          type: 'text',
          mimeType: 'text/markdown',
          fileName: 'notes.md',
          text: '# Notes\n\n- item',
        },
      ],
    })

    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime).toBeDefined()

    const sentMessage = workerRuntime?.sendCalls.at(-1)?.message
    expect(typeof sentMessage).toBe('string')
    if (typeof sentMessage === 'string') {
      expect(sentMessage).toContain('Please review this file.')
      expect(sentMessage).toContain('Name: notes.md')
      expect(sentMessage).toContain('# Notes')
    }
  })

  it('appends persisted attachment paths to runtime text while preserving image payloads', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Persisted Path Worker' })
    const imagePath = join(config.paths.uploadsDir, 'diagram.png')
    const textPath = join(config.paths.uploadsDir, 'notes.txt')

    await writeFile(imagePath, Buffer.from('hello'))
    await writeFile(textPath, 'hello from text attachment', 'utf8')

    await manager.handleUserMessage('Review these files', {
      targetAgentId: worker.agentId,
      attachments: [
        {
          mimeType: 'image/png',
          data: 'aGVsbG8=',
          fileName: 'diagram.png',
          filePath: imagePath,
        },
        {
          type: 'text',
          mimeType: 'text/plain',
          fileName: 'notes.txt',
          filePath: textPath,
          text: 'hello from text attachment',
        },
      ],
    })

    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime).toBeDefined()

    const sentMessage = workerRuntime?.sendCalls.at(-1)?.message
    expect(typeof sentMessage).toBe('object')

    if (sentMessage && typeof sentMessage !== 'string') {
      expect(sentMessage.images).toEqual([
        {
          mimeType: 'image/png',
          data: 'aGVsbG8=',
        },
      ])
      expect(sentMessage.text).toContain('Review these files')
      expect(sentMessage.text).toContain(`[Attached file saved to: ${imagePath}]`)
      expect(sentMessage.text).toContain(`[Attached file saved to: ${textPath}]`)
    }
  })

  it('writes binary attachments to disk and passes their path to the runtime', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Binary Attachment Worker' })

    await manager.handleUserMessage('', {
      targetAgentId: worker.agentId,
      attachments: [
        {
          type: 'binary',
          mimeType: 'application/pdf',
          fileName: 'spec.pdf',
          data: 'aGVsbG8=',
        },
      ],
    })

    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime).toBeDefined()

    const sentMessage = workerRuntime?.sendCalls.at(-1)?.message
    expect(typeof sentMessage).toBe('string')

    if (typeof sentMessage === 'string') {
      const savedPathMatch = sentMessage.match(/Saved to: (.+)/)
      expect(savedPathMatch).toBeTruthy()

      const savedPath = savedPathMatch?.[1]?.trim()
      expect(savedPath).toBeTruthy()

      if (savedPath) {
        const binaryContents = await readFile(savedPath)
        expect(binaryContents.toString('utf8')).toBe('hello')
      }
    }
  })

  it('does not double-prefix internal messages that already start with SYSTEM:', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Already Tagged Worker' })

    await manager.sendMessage('manager', worker.agentId, 'SYSTEM: pre-tagged', 'auto')

    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime).toBeDefined()
    expect(workerRuntime?.sendCalls.at(-1)?.message).toBe('SYSTEM: pre-tagged')
  })

  it('accepts busy-runtime messages as steer regardless of requested delivery', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Busy Worker' })
    const runtime = manager.runtimeByAgentId.get(worker.agentId)
    expect(runtime).toBeDefined()
    runtime!.busy = true

    const autoReceipt = await manager.sendMessage('manager', worker.agentId, 'queued auto', 'auto')
    const followUpReceipt = await manager.sendMessage('manager', worker.agentId, 'queued followup', 'followUp')
    const steerReceipt = await manager.sendMessage('manager', worker.agentId, 'queued steer', 'steer')

    expect(autoReceipt.acceptedMode).toBe('steer')
    expect(followUpReceipt.acceptedMode).toBe('steer')
    expect(steerReceipt.acceptedMode).toBe('steer')
  })

  it('kills a busy runtime with abort then marks descriptor terminated', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Killable Worker' })
    const runtime = manager.runtimeByAgentId.get(worker.agentId)
    expect(runtime).toBeDefined()

    await manager.killAgent('manager', worker.agentId)

    expect(runtime!.terminateCalls).toEqual([{ abort: true }])
    const descriptor = manager.listAgents().find((agent) => agent.agentId === worker.agentId)
    expect(descriptor?.status).toBe('terminated')
  })

  it('stops all agents by cancelling in-flight work without terminating runtimes', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Stop-All Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(managerRuntime).toBeDefined()
    expect(workerRuntime).toBeDefined()

    const state = manager as unknown as { descriptors: Map<string, AgentDescriptor> }
    const managerDescriptor = state.descriptors.get('manager')
    const workerDescriptor = state.descriptors.get(worker.agentId)
    expect(managerDescriptor).toBeDefined()
    expect(workerDescriptor).toBeDefined()

    managerDescriptor!.status = 'streaming'
    workerDescriptor!.status = 'streaming'
    managerRuntime!.busy = true
    workerRuntime!.busy = true

    const stopped = await manager.stopAllAgents('manager', 'manager')

    expect(stopped).toEqual({
      managerId: 'manager',
      stoppedWorkerIds: [worker.agentId],
      managerStopped: true,
      terminatedWorkerIds: [worker.agentId],
      managerTerminated: true,
    })
    expect(managerRuntime!.stopInFlightCalls).toEqual([{ abort: true }])
    expect(workerRuntime!.stopInFlightCalls).toEqual([{ abort: true }])
    expect(managerRuntime!.terminateCalls).toEqual([])
    expect(workerRuntime!.terminateCalls).toEqual([])

    const managerAfter = manager.listAgents().find((agent) => agent.agentId === 'manager')
    const workerAfter = manager.listAgents().find((agent) => agent.agentId === worker.agentId)
    expect(managerAfter?.status).toBe('idle')
    expect(workerAfter?.status).toBe('idle')
    expect(manager.runtimeByAgentId.has('manager')).toBe(true)
    expect(manager.runtimeByAgentId.has(worker.agentId)).toBe(true)
  })

  it('normalizes persisted streaming workers to idle on restart without recreating runtimes', async () => {
    const config = await makeTempConfig()

    const seedAgents = {
      agents: [
        {
          agentId: 'manager',
          displayName: 'Manager',
          role: 'manager',
          managerId: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'manager.jsonl'),
        },
        {
          agentId: 'worker-a',
          displayName: 'Worker A',
          role: 'worker',
          managerId: 'manager',
          status: 'streaming',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'worker-a.jsonl'),
        },
      ],
    }

    await writeFile(config.paths.agentsStoreFile, JSON.stringify(seedAgents, null, 2), 'utf8')

    const manager = new TestSwarmManager(config)
    await manager.boot()

    const agents = manager.listAgents()
    const worker = agents.find((agent) => agent.agentId === 'worker-a')
    const persistedStore = JSON.parse(await readFile(config.paths.agentsStoreFile, 'utf8')) as {
      agents: Array<{ agentId: string; status: AgentDescriptor['status'] }>
    }
    const persistedWorker = persistedStore.agents.find((agent) => agent.agentId === 'worker-a')

    expect(worker?.status).toBe('idle')
    expect(persistedWorker?.status).toBe('idle')
    expect(manager.createdRuntimeIds).toEqual([])
    expect(manager.runtimeByAgentId.get('manager')).toBeUndefined()
    expect(manager.runtimeByAgentId.get('worker-a')).toBeUndefined()
  })

  it('migrates persisted stopped_on_restart statuses to stopped at boot', async () => {
    const config = await makeTempConfig()

    const seedAgents = {
      agents: [
        {
          agentId: 'manager',
          displayName: 'Manager',
          role: 'manager',
          managerId: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'manager.jsonl'),
        },
        {
          agentId: 'worker-stopped',
          displayName: 'Worker Stopped',
          role: 'worker',
          managerId: 'manager',
          status: 'stopped_on_restart',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'worker-stopped.jsonl'),
        },
      ],
    }

    await writeFile(config.paths.agentsStoreFile, JSON.stringify(seedAgents, null, 2), 'utf8')

    const manager = new TestSwarmManager(config)
    await manager.boot()

    const migrated = manager.listAgents().find((agent) => agent.agentId === 'worker-stopped')
    const persistedStore = JSON.parse(await readFile(config.paths.agentsStoreFile, 'utf8')) as {
      agents: Array<{ agentId: string; status: AgentDescriptor['status'] }>
    }
    const persistedWorker = persistedStore.agents.find((agent) => agent.agentId === 'worker-stopped')

    expect(migrated?.status).toBe('stopped')
    expect(persistedWorker?.status).toBe('stopped')
  })

  it('lazily creates idle runtimes when a restored agent receives work', async () => {
    const config = await makeTempConfig()

    const seedAgents = {
      agents: [
        {
          agentId: 'manager',
          displayName: 'Manager',
          role: 'manager',
          managerId: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'manager.jsonl'),
        },
        {
          agentId: 'worker-idle',
          displayName: 'Worker Idle',
          role: 'worker',
          managerId: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'worker-idle.jsonl'),
        },
      ],
    }

    await writeFile(config.paths.agentsStoreFile, JSON.stringify(seedAgents, null, 2), 'utf8')

    const manager = new TestSwarmManager(config)
    await manager.boot()

    expect(manager.createdRuntimeIds).toEqual([])
    expect(manager.runtimeByAgentId.get('worker-idle')).toBeUndefined()

    await manager.sendMessage('manager', 'worker-idle', 'start now')

    const runtime = manager.runtimeByAgentId.get('worker-idle')
    expect(runtime).toBeDefined()
    expect(runtime?.sendCalls.at(-1)?.message).toBe('SYSTEM: start now')
    expect(manager.createdRuntimeIds).toEqual(['worker-idle'])
  })

  it('skips terminated histories at boot and lazy-loads them on demand', async () => {
    const config = await makeTempConfig()

    appendSessionConversationMessage(join(config.paths.sessionsDir, 'manager.jsonl'), 'manager', 'manager-history')
    appendSessionConversationMessage(
      join(config.paths.sessionsDir, 'worker-active.jsonl'),
      'worker-active',
      'active-worker-history',
    )
    appendSessionConversationMessage(
      join(config.paths.sessionsDir, 'worker-terminated.jsonl'),
      'worker-terminated',
      'terminated-worker-history',
    )

    const seedAgents = {
      agents: [
        {
          agentId: 'manager',
          displayName: 'Manager',
          role: 'manager',
          managerId: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'manager.jsonl'),
        },
        {
          agentId: 'worker-active',
          displayName: 'Worker Active',
          role: 'worker',
          managerId: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'worker-active.jsonl'),
        },
        {
          agentId: 'worker-terminated',
          displayName: 'Worker Terminated',
          role: 'worker',
          managerId: 'manager',
          status: 'terminated',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'worker-terminated.jsonl'),
        },
      ],
    }

    await writeFile(config.paths.agentsStoreFile, JSON.stringify(seedAgents, null, 2), 'utf8')

    const manager = new TestSwarmManager(config)
    await manager.boot()

    expect(manager.createdRuntimeIds).toEqual([])
    expect(manager.getLoadedConversationAgentIdsForTest()).toEqual(['manager', 'worker-active'])

    const terminatedHistory = manager.getConversationHistory('worker-terminated')
    expect(terminatedHistory.some((entry) => entry.text === 'terminated-worker-history')).toBe(true)
    expect(manager.getLoadedConversationAgentIdsForTest()).toEqual(['manager', 'worker-active', 'worker-terminated'])
  })

  it('does not implicitly recreate the configured manager when other agents already exist', async () => {
    const config = await makeTempConfig()

    const seedAgents = {
      agents: [
        {
          agentId: 'ops-manager',
          displayName: 'Ops Manager',
          role: 'manager',
          managerId: 'ops-manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'ops-manager.jsonl'),
        },
        {
          agentId: 'ops-worker',
          displayName: 'Ops Worker',
          role: 'worker',
          managerId: 'ops-manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'ops-worker.jsonl'),
        },
      ],
    }

    await writeFile(config.paths.agentsStoreFile, JSON.stringify(seedAgents, null, 2), 'utf8')

    const manager = new TestSwarmManager(config)
    await manager.boot()

    const agents = manager.listAgents()
    const restoredWorker = agents.find((agent) => agent.agentId === 'ops-worker')

    expect(agents.some((agent) => agent.agentId === 'manager')).toBe(false)
    expect(restoredWorker?.managerId).toBe('ops-manager')
    expect(manager.createdRuntimeIds).toEqual([])
  })

  it('keeps killed workers terminated across restart', async () => {
    const config = await makeTempConfig()
    const firstBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(firstBoot, config)

    const worker = await firstBoot.spawnAgent('manager', { agentId: 'Killed Worker' })
    await firstBoot.killAgent('manager', worker.agentId)

    const secondBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(secondBoot, config)

    const restored = secondBoot.listAgents().find((agent) => agent.agentId === worker.agentId)
    expect(restored?.status).toBe('terminated')
    expect(secondBoot.createdRuntimeIds).toEqual([])

    await expect(secondBoot.sendMessage('manager', worker.agentId, 'still there?')).rejects.toThrow(
      `Target agent is not running: ${worker.agentId}`,
    )
  })

  it('does not duplicate workers across repeated restarts', async () => {
    const config = await makeTempConfig()
    const firstBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(firstBoot, config)

    const worker = await firstBoot.spawnAgent('manager', { agentId: 'Repeat Worker' })

    const secondBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(secondBoot, config)
    expect(secondBoot.listAgents().filter((agent) => agent.agentId === worker.agentId)).toHaveLength(1)
    expect(secondBoot.createdRuntimeIds).toEqual([])

    const thirdBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(thirdBoot, config)
    expect(thirdBoot.listAgents().filter((agent) => agent.agentId === worker.agentId)).toHaveLength(1)
    expect(thirdBoot.createdRuntimeIds).toEqual([])
  })

  it('persists manager conversation history to disk and reloads it on restart', async () => {
    const config = await makeTempConfig()
    const firstBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(firstBoot, config)

    await firstBoot.handleUserMessage('persist this')
    await firstBoot.publishToUser('manager', 'saved reply', 'speak_to_user')

    const secondBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(secondBoot, config)

    const history = secondBoot.getConversationHistory('manager')
    expect(
      history.some(
        (message) =>
          message.type === 'conversation_message' &&
          message.text === 'persist this' &&
          message.source === 'user_input',
      ),
    ).toBe(true)
    expect(
      history.some(
        (message) =>
          message.type === 'conversation_message' &&
          message.text === 'saved reply' &&
          message.source === 'speak_to_user',
      ),
    ).toBe(true)
  })

  it('preserves web user and speak_to_user history when internal activity overflows history limits', async () => {
    const config = await makeTempConfig()
    const createdAt = '2026-01-01T00:00:00.000Z'
    await writeFile(
      config.paths.agentsStoreFile,
      JSON.stringify(
        {
          agents: [
            {
              agentId: 'manager',
              displayName: 'Manager',
              role: 'manager',
              managerId: 'manager',
              status: 'idle',
              createdAt,
              updatedAt: createdAt,
              cwd: config.defaultCwd,
              model: config.defaultModel,
              sessionFile: join(config.paths.sessionsDir, 'manager.jsonl'),
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    )

    const sessionManager = SessionManager.open(join(config.paths.sessionsDir, 'manager.jsonl'))
    sessionManager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'seed' }],
    } as any)
    sessionManager.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_message',
      agentId: 'manager',
      role: 'user',
      text: 'web message that must persist',
      timestamp: new Date(1).toISOString(),
      source: 'user_input',
      sourceContext: {
        channel: 'web',
      },
    })
    sessionManager.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_message',
      agentId: 'manager',
      role: 'assistant',
      text: 'web reply that must persist',
      timestamp: new Date(2).toISOString(),
      source: 'speak_to_user',
      sourceContext: {
        channel: 'web',
      },
    })
    for (let index = 0; index < 2_200; index += 1) {
      sessionManager.appendCustomEntry('swarm_conversation_entry', {
        type: 'agent_message',
        agentId: 'manager',
        timestamp: new Date(3 + index).toISOString(),
        source: 'agent_to_agent',
        fromAgentId: 'manager',
        toAgentId: 'worker',
        text: `internal-message-${index}`,
      })
    }

    const firstBoot = new TestSwarmManager(config)
    await firstBoot.boot()

    const inMemoryHistory = firstBoot.getConversationHistory('manager')
    expect(
      inMemoryHistory.some(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.source === 'user_input' &&
          entry.text === 'web message that must persist',
      ),
    ).toBe(true)
    expect(
      inMemoryHistory.some(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.source === 'speak_to_user' &&
          entry.text === 'web reply that must persist',
      ),
    ).toBe(true)
    expect(
      inMemoryHistory.some((entry) => entry.type === 'agent_message' && entry.text === 'internal-message-0'),
    ).toBe(false)
    expect(
      inMemoryHistory.some((entry) => entry.type === 'agent_message' && entry.text === 'internal-message-2199'),
    ).toBe(true)

    const secondBoot = new TestSwarmManager(config)
    await secondBoot.boot()

    const restoredHistory = secondBoot.getConversationHistory('manager')
    expect(
      restoredHistory.some(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.source === 'user_input' &&
          entry.text === 'web message that must persist',
      ),
    ).toBe(true)
    expect(
      restoredHistory.some(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.source === 'speak_to_user' &&
          entry.text === 'web reply that must persist',
      ),
    ).toBe(true)
    expect(
      restoredHistory.some((entry) => entry.type === 'agent_message' && entry.text === 'internal-message-0'),
    ).toBe(false)
    expect(
      restoredHistory.some((entry) => entry.type === 'agent_message' && entry.text === 'internal-message-2199'),
    ).toBe(true)
  })

  it('resetManagerSession recreates manager runtime and clears manager history', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('before reset')
    expect(manager.getConversationHistory('manager').some((message) => message.text === 'before reset')).toBe(true)

    const firstRuntime = manager.runtimeByAgentId.get('manager')
    expect(firstRuntime).toBeDefined()

    await manager.resetManagerSession('api_reset')

    expect(firstRuntime!.terminateCalls).toEqual([{ abort: true }])
    expect(manager.createdRuntimeIds.filter((id) => id === 'manager')).toHaveLength(2)
    expect(manager.getConversationHistory('manager')).toHaveLength(0)

    const rebooted = new TestSwarmManager(config)
    await bootWithDefaultManager(rebooted, config)
    expect(rebooted.getConversationHistory('manager')).toHaveLength(0)
  })

  it('skips invalid persisted descriptors instead of failing boot', async () => {
    const config = await makeTempConfig()

    const seedAgents = {
      agents: [
        {
          agentId: 'manager',
          displayName: 'Manager',
          role: 'manager',
          managerId: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'manager.jsonl'),
        },
        {
          agentId: 'broken-worker',
          displayName: 'Broken Worker',
          role: 'worker',
          managerId: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          sessionFile: join(config.paths.sessionsDir, 'broken-worker.jsonl'),
        },
      ],
    }

    await writeFile(config.paths.agentsStoreFile, JSON.stringify(seedAgents, null, 2), 'utf8')

    const originalWarn = console.warn
    const warnings: string[] = []
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((entry) => String(entry)).join(' '))
    }

    try {
      const manager = new TestSwarmManager(config)
      await bootWithDefaultManager(manager, config)

      const agentIds = manager.listAgents().map((agent) => agent.agentId)
      expect(agentIds).toEqual(['manager'])
      expect(warnings.some((entry) => entry.includes('Skipping invalid descriptor'))).toBe(true)
    } finally {
      console.warn = originalWarn
    }
  })

  it('creates secondary managers and deletes them with owned worker cascade', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const secondary = await manager.createManager('manager', {
      name: 'Ops Manager',
      cwd: config.defaultCwd,
    })

    expect(secondary.role).toBe('manager')
    expect(secondary.managerId).toBe(secondary.agentId)

    const ownedWorker = await manager.spawnAgent(secondary.agentId, { agentId: 'Owned Worker' })
    expect(ownedWorker.managerId).toBe(secondary.agentId)

    const deleted = await manager.deleteManager('manager', secondary.agentId)

    expect(deleted.managerId).toBe(secondary.agentId)
    expect(deleted.terminatedWorkerIds).toContain(ownedWorker.agentId)
    expect(manager.listAgents().some((agent) => agent.agentId === secondary.agentId)).toBe(false)
    expect(manager.listAgents().some((agent) => agent.agentId === ownedWorker.agentId)).toBe(false)
  })

  it('deletes the manager schedule file when deleting a manager', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const secondary = await manager.createManager('manager', {
      name: 'Schedule Owner',
      cwd: config.defaultCwd,
    })

    const secondaryScheduleFile = getScheduleFilePath(config.paths.dataDir, secondary.agentId)
    await mkdir(dirname(secondaryScheduleFile), { recursive: true })
    await writeFile(
      secondaryScheduleFile,
      JSON.stringify(
        {
          schedules: [
            {
              id: 'schedule-1',
              name: 'daily',
              cron: '0 9 * * *',
              message: 'status update',
              oneShot: false,
              timezone: 'UTC',
              createdAt: '2026-01-01T00:00:00.000Z',
              nextFireAt: '2026-01-01T09:00:00.000Z',
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    )

    await manager.deleteManager('manager', secondary.agentId)

    await expect(readFile(secondaryScheduleFile, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('maps create_manager model presets to canonical runtime models with highest reasoning', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const codexManager = await manager.createManager('manager', {
      name: 'Codex Manager',
      cwd: config.defaultCwd,
      model: 'pi-codex',
    })

    const opusManager = await manager.createManager('manager', {
      name: 'Opus Manager',
      cwd: config.defaultCwd,
      model: 'pi-opus',
    })

    const codexAppManager = await manager.createManager('manager', {
      name: 'Codex App Manager',
      cwd: config.defaultCwd,
      model: 'codex-app',
    })

    const claudeCodeManager = await manager.createManager('manager', {
      name: 'Claude Code Manager',
      cwd: config.defaultCwd,
      model: 'claude-code',
    })

    expect(codexManager.model).toEqual({
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'xhigh',
    })
    expect(opusManager.model).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'xhigh',
    })
    expect(codexAppManager.model).toEqual({
      provider: 'openai-codex-app-server',
      modelId: 'default',
      thinkingLevel: 'xhigh',
    })
    expect(claudeCodeManager.model).toEqual({
      provider: 'anthropic-claude-code',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'xhigh',
    })
  })

  it('defaults create_manager to pi-codex mapping when model is omitted', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const created = await manager.createManager('manager', {
      name: 'Default Model Manager',
      cwd: config.defaultCwd,
    })

    expect(created.model).toEqual({
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'xhigh',
    })
  })

  it('rejects invalid create_manager model presets with a clear error', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(
      manager.createManager('manager', {
        name: 'Invalid Manager',
        cwd: config.defaultCwd,
        model: 'invalid-model' as any,
      }),
    ).rejects.toThrow('create_manager.model must be one of pi-codex|pi-opus|codex-app|claude-code')
  })

  it('maps spawn_agent model presets to canonical runtime models with highest reasoning', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const codexWorker = await manager.spawnAgent('manager', {
      agentId: 'Codex Worker',
      model: 'pi-codex',
    })

    const opusWorker = await manager.spawnAgent('manager', {
      agentId: 'Opus Worker',
      model: 'pi-opus',
    })

    const codexAppWorker = await manager.spawnAgent('manager', {
      agentId: 'Codex App Worker',
      model: 'codex-app',
    })

    const claudeCodeWorker = await manager.spawnAgent('manager', {
      agentId: 'Claude Code Worker',
      model: 'claude-code',
    })

    expect(codexWorker.model).toEqual({
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'xhigh',
    })
    expect(opusWorker.model).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'xhigh',
    })
    expect(codexAppWorker.model).toEqual({
      provider: 'openai-codex-app-server',
      modelId: 'default',
      thinkingLevel: 'xhigh',
    })
    expect(claudeCodeWorker.model).toEqual({
      provider: 'anthropic-claude-code',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'xhigh',
    })
  })

  it('rejects invalid spawn_agent model presets with a clear error', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(
      manager.spawnAgent('manager', {
        agentId: 'Invalid Worker',
        model: 'invalid-model' as any,
      }),
    ).rejects.toThrow('spawn_agent.model must be one of pi-codex|pi-opus|codex-app|claude-code')
  })

  it('allows deleting the default manager when requested', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const deleted = await manager.deleteManager('manager', 'manager')

    expect(deleted.managerId).toBe('manager')
    expect(deleted.terminatedWorkerIds).toEqual([])
    expect(manager.listAgents()).toHaveLength(0)
  })

  it('allows bootstrapping a new manager after deleting the last running manager', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.deleteManager('manager', 'manager')

    const recreated = await manager.createManager('manager', {
      name: 'Recreated Manager',
      cwd: config.defaultCwd,
    })

    expect(recreated.role).toBe('manager')
    expect(manager.listAgents().some((agent) => agent.agentId === recreated.agentId)).toBe(true)
  })

  it('enforces strict manager ownership for worker control operations', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const secondary = await manager.createManager('manager', {
      name: 'Delivery Manager',
      cwd: config.defaultCwd,
    })
    const worker = await manager.spawnAgent(secondary.agentId, { agentId: 'Delivery Worker' })

    await expect(manager.killAgent('manager', worker.agentId)).rejects.toThrow(
      `Only owning manager can kill agent ${worker.agentId}`,
    )
    await expect(manager.sendMessage('manager', worker.agentId, 'cross-manager control')).rejects.toThrow(
      `Manager manager does not own worker ${worker.agentId}`,
    )

    await manager.killAgent(secondary.agentId, worker.agentId)
    const descriptor = manager.listAgents().find((agent) => agent.agentId === worker.agentId)
    expect(descriptor?.status).toBe('terminated')
  })

  it('routes user-to-worker delivery through the owning manager context', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const secondary = await manager.createManager('manager', {
      name: 'Routing Manager',
      cwd: config.defaultCwd,
    })
    const worker = await manager.spawnAgent(secondary.agentId, { agentId: 'Routing Worker' })

    await manager.handleUserMessage('hello owned worker', { targetAgentId: worker.agentId })

    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime?.sendCalls.at(-1)?.message).toBe('hello owned worker')
  })

  it('accepts any existing directory for manager and worker creation', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const outsideDir = await mkdtemp(join(tmpdir(), 'outside-allowlist-'))

    const externalManager = await manager.createManager('manager', {
      name: 'External Manager',
      cwd: outsideDir,
    })

    const externalWorker = await manager.spawnAgent(externalManager.agentId, {
      agentId: 'External Worker',
      cwd: outsideDir,
    })

    const validation = await manager.validateDirectory(outsideDir)
    const listed = await manager.listDirectories(outsideDir)

    expect(externalManager.cwd).toBe(validation.resolvedPath)
    expect(externalWorker.cwd).toBe(validation.resolvedPath)
    expect(validation.valid).toBe(true)
    expect(validation.message).toBeUndefined()
    expect(listed.resolvedPath).toBe(validation.resolvedPath)
    expect(listed.roots).toEqual([])
  })
})
