import type { SessionRecord, SwarmdCoreHandle } from "swarmd";

import type { AgentModelDescriptor, AgentThinkingLevel } from "./types.js";

const DEFAULT_AGENT_THINKING_LEVEL: AgentThinkingLevel = "xhigh";

export function resolveAgentModelDescriptorFromSession(
  core: Pick<SwarmdCoreHandle, "sessionService">,
  session: SessionRecord,
): AgentModelDescriptor {
  const backendConfig = readSessionBackendConfig(core, session.id);
  const thinkingLevel =
    readThinkingLevel(backendConfig.thinkingLevel) ?? DEFAULT_AGENT_THINKING_LEVEL;

  if (session.backend === "codex") {
    return {
      provider: "openai-codex-app-server",
      modelId: session.model,
      thinkingLevel,
    };
  }

  if (session.backend === "claude") {
    return {
      provider: "anthropic-claude-code",
      modelId: session.model,
      thinkingLevel,
    };
  }

  const parsedModel = /^([^/:]+)[/:](.+)$/.exec(session.model);
  return {
    provider: parsedModel?.[1] ?? "openai-codex",
    modelId: parsedModel?.[2] ?? session.model,
    thinkingLevel,
  };
}

function readSessionBackendConfig(
  core: Pick<SwarmdCoreHandle, "sessionService">,
  sessionId: string,
): Record<string, unknown> {
  const sessionService = core.sessionService as {
    getRuntimeConfig?: (
      requestedSessionId: string,
    ) => { backendConfig?: Record<string, unknown> } | undefined;
  };

  const runtimeConfig = sessionService.getRuntimeConfig?.(sessionId);
  return runtimeConfig?.backendConfig ?? {};
}

function readThinkingLevel(value: unknown): AgentThinkingLevel | undefined {
  switch (value) {
    case "off":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return value;
    default:
      return undefined;
  }
}
