import { describe, expect, it } from 'vitest'
import {
  inferSwarmModelPresetFromDescriptor,
  parseSwarmModelPreset,
  resolveModelDescriptorFromPreset,
} from '../swarm/model-presets.js'

describe('model presets', () => {
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
