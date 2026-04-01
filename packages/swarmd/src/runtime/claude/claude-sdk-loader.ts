import type { ClaudeSdkModule } from "./claude-query-session.js";

export interface ClaudeSdkMcpHelpers {
  createSdkMcpServer: (config: { name: string; version: string; tools: unknown[] }) => unknown;
  tool: (
    name: string,
    description: string,
    shape: unknown,
    handler: (args: unknown) => Promise<unknown>,
  ) => unknown;
}

export async function loadClaudeSdkModule(): Promise<ClaudeSdkModule> {
  const module = await importClaudeSdk(
    'Claude backend requires "@anthropic-ai/claude-agent-sdk" to be installed by the runtime consumer.',
  );

  if (typeof module.query !== "function") {
    throw new Error('Claude Agent SDK module is missing the required "query" entry point.');
  }

  return {
    query: module.query as ClaudeSdkModule["query"],
  };
}

export async function loadClaudeSdkMcpHelpers(): Promise<ClaudeSdkMcpHelpers> {
  const module = await importClaudeSdk("Claude host tools require @anthropic-ai/claude-agent-sdk.");

  if (typeof module.createSdkMcpServer !== "function" || typeof module.tool !== "function") {
    throw new Error("Claude Agent SDK MCP helpers are unavailable.");
  }

  return {
    createSdkMcpServer: module.createSdkMcpServer as ClaudeSdkMcpHelpers["createSdkMcpServer"],
    tool: module.tool as ClaudeSdkMcpHelpers["tool"],
  };
}

async function importClaudeSdk(missingModuleMessage: string): Promise<Record<string, unknown>> {
  try {
    const dynamicImport = new Function("specifier", "return import(specifier);") as (
      specifier: string,
    ) => Promise<unknown>;
    const imported = await dynamicImport("@anthropic-ai/claude-agent-sdk");

    if (!imported || typeof imported !== "object" || Array.isArray(imported)) {
      throw new Error("Claude Agent SDK module export is unavailable.");
    }

    return imported as Record<string, unknown>;
  } catch (error) {
    if (isMissingClaudeSdk(error)) {
      throw new Error(missingModuleMessage);
    }

    throw error;
  }
}

function isMissingClaudeSdk(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
    return true;
  }

  return error.message.includes("@anthropic-ai/claude-agent-sdk");
}
