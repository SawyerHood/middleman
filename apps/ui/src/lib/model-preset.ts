import type { AgentDescriptor, ManagerModelPreset } from '@middleman/protocol'

export function inferModelPreset(agent: AgentDescriptor): ManagerModelPreset | undefined {
  const provider = agent.model.provider.trim().toLowerCase()
  const modelId = agent.model.modelId.trim().toLowerCase()

  if (provider === 'openai-codex' && modelId === 'gpt-5.3-codex') {
    return 'pi-codex'
  }

  if (provider === 'anthropic' && modelId === 'claude-opus-4-6') {
    return 'pi-opus'
  }

  if (provider === 'openai-codex-app-server' && modelId === 'default') {
    return 'codex-app'
  }

  if (provider === 'anthropic-claude-code' && modelId === 'claude-opus-4-6') {
    return 'claude-code'
  }

  return undefined
}
