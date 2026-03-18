import type { AgentDescriptor, ManagerModelPreset } from '@middleman/protocol'

const GPT_5_4_MODEL_ID = 'gpt-5.4'

export function inferModelPreset(agent: AgentDescriptor): ManagerModelPreset | undefined {
  const provider = agent.model.provider.trim().toLowerCase()
  const modelId = agent.model.modelId.trim().toLowerCase()

  if (provider === 'openai-codex' && modelId === GPT_5_4_MODEL_ID) {
    return 'pi-codex'
  }

  if (provider === 'anthropic' && modelId === 'claude-opus-4-6') {
    return 'pi-opus'
  }

  if (provider === 'openai-codex-app-server' && modelId === GPT_5_4_MODEL_ID) {
    return 'codex-app'
  }

  if (provider === 'anthropic-claude-code' && modelId === 'claude-opus-4-6') {
    return 'claude-code'
  }

  return undefined
}
