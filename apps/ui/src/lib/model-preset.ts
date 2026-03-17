import type { AgentDescriptor, ModelPreset } from '@middleman/protocol'

const CODEX_APP_MODEL_ID = 'gpt-5.4'
const LEGACY_CODEX_APP_MODEL_ID = 'default'
const PI_CODEX_MODEL_ID = 'gpt-5.4'
const LEGACY_PI_CODEX_MODEL_ID = 'gpt-5.3-codex'

export function inferModelPreset(agent: AgentDescriptor): ModelPreset | undefined {
  const provider = agent.model.provider.trim().toLowerCase()
  const modelId = agent.model.modelId.trim().toLowerCase()

  if (provider === 'openai-codex' && (modelId === PI_CODEX_MODEL_ID || modelId === LEGACY_PI_CODEX_MODEL_ID)) {
    return 'pi-codex'
  }

  if (provider === 'anthropic' && modelId === 'claude-opus-4-6') {
    return 'pi-opus'
  }

  if (
    provider === 'openai-codex-app-server' &&
    (modelId === CODEX_APP_MODEL_ID || modelId === LEGACY_CODEX_APP_MODEL_ID)
  ) {
    return 'codex-app'
  }

  if (provider === 'anthropic-claude-code' && modelId === 'claude-opus-4-6') {
    return 'claude-code'
  }

  return undefined
}
