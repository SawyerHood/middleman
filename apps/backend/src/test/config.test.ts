import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createConfig } from '../config.js'

const MANAGED_ENV_KEYS = [
  'NODE_ENV',
  'SWARM_ROOT_DIR',
  'SWARM_DATA_DIR',
  'SWARM_AUTH_FILE',
  'SWARM_HOST',
  'SWARM_PORT',
  'MIDDLEMAN_HOST',
  'MIDDLEMAN_PORT',
  'MIDDLEMAN_HOME',
  'MIDDLEMAN_PROJECT_ROOT',
  'MIDDLEMAN_INSTALL_DIR',
  'SWARM_DEFAULT_CWD',
  'SWARM_MODEL_PROVIDER',
  'SWARM_MODEL_ID',
  'SWARM_THINKING_LEVEL',
  'SWARM_CWD_ALLOWLIST_ROOTS',
] as const

async function withEnv(overrides: Partial<Record<(typeof MANAGED_ENV_KEYS)[number], string>>, run: () => Promise<void> | void) {
  const previous = new Map<string, string | undefined>()

  for (const key of MANAGED_ENV_KEYS) {
    previous.set(key, process.env[key])
    delete process.env[key]
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }

  try {
    await run()
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

describe('createConfig', () => {
  it('uses fixed defaults for non-host/port config', async () => {
    await withEnv({}, () => {
      const config = createConfig()

      expect(config.host).toBe('0.0.0.0')
      expect(config.port).toBe(47187)
      expect(config.defaultModel).toEqual({
        provider: 'openai-codex-app-server',
        modelId: 'gpt-5.4',
        thinkingLevel: 'xhigh',
      })

      expect(config.paths.installDir).toBe(resolve(process.cwd(), '../..'))
      expect(config.paths.projectRoot).toBe(resolve(process.cwd()))
      expect(config.paths.dataDir).toBe(resolve(homedir(), '.middleman'))
      expect(config.paths.projectSwarmDir).toBe(resolve(config.paths.projectRoot, '.swarm'))
      expect(config.paths.swarmdDbFile).toBe(resolve(homedir(), '.middleman', 'swarmd.db'))
      expect(config.paths.runtimeScratchDir).toBe(resolve(homedir(), '.middleman', 'runtime'))
      expect(config.paths.uploadsDir).toBe(resolve(homedir(), '.middleman', 'uploads'))
      expect(config.paths.authDir).toBe(resolve(homedir(), '.middleman', 'auth'))
      expect(config.paths.authFile).toBe(resolve(homedir(), '.middleman', 'auth', 'auth.json'))
      expect(config.paths.projectArchetypesDir).toBe(resolve(config.paths.projectRoot, '.swarm', 'archetypes'))
      expect(config.paths.memoryDir).toBe(resolve(homedir(), '.middleman', 'memory'))
      expect(config.paths.projectMemorySkillFile).toBe(
        resolve(config.paths.projectRoot, '.swarm', 'skills', 'memory', 'SKILL.md'),
      )

      expect(config.defaultCwd).toBe(config.paths.projectRoot)
      expect(config.cwdAllowlistRoots).toContain(config.paths.projectRoot)
      expect(config.cwdAllowlistRoots).toContain(resolve(homedir(), 'worktrees'))
    })
  })

  it('respects MIDDLEMAN_HOST and MIDDLEMAN_PORT', async () => {
    await withEnv({ MIDDLEMAN_HOST: '0.0.0.0', MIDDLEMAN_PORT: '9999' }, () => {
      const config = createConfig()
      expect(config.host).toBe('0.0.0.0')
      expect(config.port).toBe(9999)
    })
  })

  it('ignores removed SWARM_* env vars', async () => {
    await withEnv(
      {
        NODE_ENV: 'development',
        SWARM_ROOT_DIR: '/tmp/swarm-root',
        SWARM_DATA_DIR: '/tmp/swarm-data',
        SWARM_AUTH_FILE: '/tmp/swarm-auth/auth.json',
        SWARM_DEFAULT_CWD: '/tmp/swarm-cwd',
        SWARM_MODEL_PROVIDER: 'anthropic',
        SWARM_MODEL_ID: 'claude-opus-4-6',
        SWARM_THINKING_LEVEL: 'low',
        SWARM_CWD_ALLOWLIST_ROOTS: '/tmp/swarm-allowlist',
      },
      () => {
        const config = createConfig()

        expect(config.paths.dataDir).toBe(resolve(homedir(), '.middleman'))
        expect(config.paths.authFile).toBe(resolve(homedir(), '.middleman', 'auth', 'auth.json'))
        expect(config.defaultCwd).toBe(config.paths.projectRoot)
        expect(config.defaultModel).toEqual({
          provider: 'openai-codex-app-server',
          modelId: 'gpt-5.4',
          thinkingLevel: 'xhigh',
        })
        expect(config.cwdAllowlistRoots).not.toContain('/tmp/swarm-allowlist')
      }
    )
  })
})
