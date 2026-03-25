import {
  inferManagerModelPresetIconFamilyFromDescriptor,
  inferManagerModelPresetFromDescriptor,
  supportsManualCompactionForDescriptor,
  type AgentDescriptor,
  type ModelPresetIconFamily,
  type ManagerModelPreset,
} from "@middleman/protocol";

export function inferModelPreset(agent: AgentDescriptor): ManagerModelPreset | undefined {
  return inferManagerModelPresetFromDescriptor(agent.model);
}

export function inferModelPresetIconFamily(
  agent: AgentDescriptor,
): ModelPresetIconFamily | undefined {
  return inferManagerModelPresetIconFamilyFromDescriptor(agent.model);
}

export function supportsManualCompaction(agent: AgentDescriptor): boolean {
  return supportsManualCompactionForDescriptor(agent.model);
}
