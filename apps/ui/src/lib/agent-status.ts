import type { AgentStatus } from "@middleman/protocol";

export const ACTIVE_AGENT_STATUSES = new Set<AgentStatus>([
  "created",
  "starting",
  "idle",
  "busy",
  "interrupting",
]);

export function isActiveAgentStatus(status: AgentStatus): boolean {
  return ACTIVE_AGENT_STATUSES.has(status);
}

export function isWorkingAgentStatus(status: AgentStatus): boolean {
  return status === "starting" || status === "busy" || status === "interrupting";
}
