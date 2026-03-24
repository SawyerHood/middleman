import {
  inferManagerModelPresetFromDescriptor,
  type AgentDescriptor,
  type ManagerModelPreset,
} from "@middleman/protocol";

export function inferModelPreset(agent: AgentDescriptor): ManagerModelPreset | undefined {
  return inferManagerModelPresetFromDescriptor(agent.model);
}
