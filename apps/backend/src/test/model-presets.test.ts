import { describe, expect, it } from 'vitest'
import {
  inferSwarmModelPresetFromDescriptor,
  parseSwarmModelPreset,
  resolveModelDescriptorFromPreset,
} from '../swarm/model-presets.js'

describe('model presets', () => {
  it('resolves codex-app to openai-codex-app-server descriptor', () => {
    expect(resolveModelDescriptorFromPreset('codex-app')).toEqual({
      provider: 'openai-codex-app-server',
      modelId: 'gpt-5.4',
      thinkingLevel: 'xhigh',
    })
  })

  it('infers codex-app preset from descriptor', () => {
    expect(
      inferSwarmModelPresetFromDescriptor({
        provider: 'openai-codex-app-server',
        modelId: 'gpt-5.4',
      }),
    ).toBe('codex-app')
  })

  it('resolves claude-code to anthropic-claude-code descriptor', () => {
    expect(resolveModelDescriptorFromPreset('claude-code')).toEqual({
      provider: 'anthropic-claude-code',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'xhigh',
    })
  })

  it('infers claude-code preset from descriptor', () => {
    expect(
      inferSwarmModelPresetFromDescriptor({
        provider: 'anthropic-claude-code',
        modelId: 'claude-opus-4-6',
      }),
    ).toBe('claude-code')
  })

  it('includes claude-code in parse validation errors', () => {
    expect(() => parseSwarmModelPreset('invalid', 'spawn_agent.model')).toThrow(
      'spawn_agent.model must be one of pi-codex|pi-opus|codex-app|claude-code',
    )
  })
})
