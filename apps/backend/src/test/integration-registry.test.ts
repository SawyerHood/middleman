import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mockState = vi.hoisted(() => ({
  slackInstances: [] as any[],
  telegramInstances: [] as any[],
}))

vi.mock('../integrations/slack/slack-integration.js', () => ({
  SlackIntegrationService: class MockSlackIntegrationService extends EventEmitter {
    readonly managerId: string
    readonly start = vi.fn(async () => undefined)
    readonly stop = vi.fn(async () => undefined)

    constructor(options: { managerId: string }) {
      super()
      this.managerId = options.managerId
      mockState.slackInstances.push(this)
    }

    getStatus(): Record<string, unknown> {
      return {
        type: 'slack_status',
        managerId: this.managerId,
        integrationProfileId: `slack:${this.managerId}`,
        state: 'disabled',
        enabled: false,
        updatedAt: '2026-01-01T00:00:00.000Z',
        message: 'Slack integration disabled',
      }
    }

    getMaskedConfig(): Record<string, unknown> {
      return {
        profileId: `slack:${this.managerId}`,
        enabled: false,
      }
    }

    async updateConfig(): Promise<{ config: Record<string, unknown>; status: Record<string, unknown> }> {
      return {
        config: this.getMaskedConfig(),
        status: this.getStatus(),
      }
    }

    async disable(): Promise<{ config: Record<string, unknown>; status: Record<string, unknown> }> {
      return {
        config: this.getMaskedConfig(),
        status: this.getStatus(),
      }
    }

    async testConnection(): Promise<{ ok: boolean }> {
      return { ok: true }
    }

    async listChannels(): Promise<Array<{ id: string; name: string }>> {
      return [{ id: 'C123', name: 'alerts' }]
    }
  },
}))

vi.mock('../integrations/telegram/telegram-integration.js', () => ({
  TelegramIntegrationService: class MockTelegramIntegrationService extends EventEmitter {
    readonly managerId: string
    readonly start = vi.fn(async () => undefined)
    readonly stop = vi.fn(async () => undefined)

    constructor(options: { managerId: string }) {
      super()
      this.managerId = options.managerId
      mockState.telegramInstances.push(this)
    }

    getStatus(): Record<string, unknown> {
      return {
        type: 'telegram_status',
        managerId: this.managerId,
        integrationProfileId: `telegram:${this.managerId}`,
        state: 'disabled',
        enabled: false,
        updatedAt: '2026-01-01T00:00:00.000Z',
        message: 'Telegram integration disabled',
      }
    }

    getMaskedConfig(): Record<string, unknown> {
      return {
        profileId: `telegram:${this.managerId}`,
        enabled: false,
      }
    }

    async updateConfig(): Promise<{ config: Record<string, unknown>; status: Record<string, unknown> }> {
      return {
        config: this.getMaskedConfig(),
        status: this.getStatus(),
      }
    }

    async disable(): Promise<{ config: Record<string, unknown>; status: Record<string, unknown> }> {
      return {
        config: this.getMaskedConfig(),
        status: this.getStatus(),
      }
    }

    async testConnection(): Promise<{ ok: boolean }> {
      return { ok: true }
    }
  },
}))

import { IntegrationRegistryService } from '../integrations/registry.js'

interface FakeManagerOptions {
  configuredManagerId?: string
  listedManagerIds?: string[]
  integrationProfileManagerIds?: string[]
}

function createFakeSwarmManager(options: FakeManagerOptions = {}) {
  const listedManagerIds = options.listedManagerIds ?? []
  const integrationProfileManagerIds = options.integrationProfileManagerIds ?? []

  return {
    getConfig: () => ({
      managerId: options.configuredManagerId,
    }),
    listAgents: () =>
      listedManagerIds.map((managerId) => ({
        agentId: managerId,
        role: 'manager' as const,
      })),
    listIntegrationProfiles: () =>
      integrationProfileManagerIds.map((managerId) => ({
        id: `slack:${managerId}`,
        managerId,
        provider: 'slack' as const,
        config: {},
        updatedAt: '2026-01-01T00:00:00.000Z',
      })),
  }
}

afterEach(() => {
  mockState.slackInstances.length = 0
  mockState.telegramInstances.length = 0
})

describe('IntegrationRegistryService', () => {
  it('starts manager-scoped integration profiles for configured managers', async () => {
    const registry = new IntegrationRegistryService({
      swarmManager: createFakeSwarmManager({
        configuredManagerId: 'primary-manager',
        listedManagerIds: ['primary-manager'],
      }) as any,
    })

    await registry.start()

    expect(mockState.slackInstances.map((instance) => instance.managerId)).toEqual(['primary-manager'])
    expect(mockState.telegramInstances.map((instance) => instance.managerId)).toEqual(['primary-manager'])

    await registry.stop()

    expect(mockState.slackInstances[0]?.stop).toHaveBeenCalledTimes(1)
    expect(mockState.telegramInstances[0]?.stop).toHaveBeenCalledTimes(1)
  })

  it('discovers managers from config, live descriptors, and stored integration profiles', async () => {
    const registry = new IntegrationRegistryService({
      swarmManager: createFakeSwarmManager({
        configuredManagerId: 'configured-manager',
        listedManagerIds: ['live-manager'],
        integrationProfileManagerIds: ['stored-manager'],
      }) as any,
    })

    await registry.start()

    const slackManagers = new Set(mockState.slackInstances.map((instance) => instance.managerId))
    const telegramManagers = new Set(mockState.telegramInstances.map((instance) => instance.managerId))

    expect(slackManagers).toEqual(new Set(['configured-manager', 'live-manager', 'stored-manager']))
    expect(telegramManagers).toEqual(new Set(['configured-manager', 'live-manager', 'stored-manager']))
  })

  it('forwards status events from started profiles', async () => {
    const registry = new IntegrationRegistryService({
      swarmManager: createFakeSwarmManager({
        configuredManagerId: 'manager',
      }) as any,
    })

    await registry.start()

    const slackEvents: Array<Record<string, unknown>> = []
    const telegramEvents: Array<Record<string, unknown>> = []

    registry.on('slack_status', (event) => {
      slackEvents.push(event as Record<string, unknown>)
    })
    registry.on('telegram_status', (event) => {
      telegramEvents.push(event as Record<string, unknown>)
    })

    const slack = mockState.slackInstances.find((instance) => instance.managerId === 'manager')
    const telegram = mockState.telegramInstances.find((instance) => instance.managerId === 'manager')

    slack?.emit('slack_status', {
      type: 'slack_status',
      managerId: 'manager',
      state: 'connected',
    })
    telegram?.emit('telegram_status', {
      type: 'telegram_status',
      managerId: 'manager',
      state: 'connected',
    })

    expect(slackEvents).toContainEqual(
      expect.objectContaining({
        type: 'slack_status',
        managerId: 'manager',
        state: 'connected',
      }),
    )
    expect(telegramEvents).toContainEqual(
      expect.objectContaining({
        type: 'telegram_status',
        managerId: 'manager',
        state: 'connected',
      }),
    )
  })

  it('unregisters integrations when a manager disappears from the live manager set', async () => {
    const registry = new IntegrationRegistryService({
      swarmManager: createFakeSwarmManager({
        listedManagerIds: ['manager-a'],
      }) as any,
    })

    await registry.start()
    await registry.syncManagers(new Set(['manager-b']))

    const slackA = mockState.slackInstances.find((instance) => instance.managerId === 'manager-a')
    const telegramA = mockState.telegramInstances.find((instance) => instance.managerId === 'manager-a')

    expect(slackA?.stop).toHaveBeenCalledTimes(1)
    expect(telegramA?.stop).toHaveBeenCalledTimes(1)
    expect(mockState.slackInstances.map((instance) => instance.managerId)).toEqual(['manager-a', 'manager-b'])
    expect(mockState.telegramInstances.map((instance) => instance.managerId)).toEqual(['manager-a', 'manager-b'])
  })
})
