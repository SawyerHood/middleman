import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
  OAuthProviderInterface
} from "@mariozechner/pi-ai";
import * as piAiOAuth from "@mariozechner/pi-ai/oauth";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import {
  applyCorsHeaders,
  readJsonBody,
  sendJson
} from "../http-utils.js";
import type { HttpRoute } from "./http-route.js";

const SETTINGS_ENV_ENDPOINT_PATH = "/api/settings/env";
const SETTINGS_AUTH_ENDPOINT_PATH = "/api/settings/auth";
const SETTINGS_AUTH_LOGIN_ENDPOINT_PATH = "/api/settings/auth/login";
const SETTINGS_AUTH_LOGIN_METHODS = "POST, OPTIONS";
const SETTINGS_AUTH_METHODS = "GET, PUT, DELETE, POST, OPTIONS";

type OAuthLoginProviderId = "anthropic" | "openai-codex";

type SettingsAuthLoginEventName = "auth_url" | "prompt" | "progress" | "complete" | "error";

type SettingsAuthLoginEventPayload = {
  auth_url: { url: string; instructions?: string };
  prompt: { message: string; placeholder?: string };
  progress: { message: string };
  complete: { provider: OAuthLoginProviderId; status: "connected" };
  error: { message: string };
};

interface SettingsAuthLoginFlow {
  providerId: OAuthLoginProviderId;
  pendingPrompt:
    | {
        resolve: (value: string) => void;
        reject: (error: Error) => void;
      }
    | null;
  abortController: AbortController;
  closed: boolean;
}

const anthropicOAuthProvider = (piAiOAuth as { anthropicOAuthProvider: OAuthProviderInterface })
  .anthropicOAuthProvider;
const openaiCodexOAuthProvider = (piAiOAuth as { openaiCodexOAuthProvider: OAuthProviderInterface })
  .openaiCodexOAuthProvider;

const SETTINGS_AUTH_LOGIN_PROVIDERS: Record<OAuthLoginProviderId, OAuthProviderInterface> = {
  anthropic: anthropicOAuthProvider,
  "openai-codex": openaiCodexOAuthProvider
};

export interface SettingsRouteBundle {
  routes: HttpRoute[];
  cancelActiveSettingsAuthLoginFlows: () => void;
}

export function createSettingsRoutes(options: { swarmManager: SwarmManager }): SettingsRouteBundle {
  const { swarmManager } = options;
  const activeSettingsAuthLoginFlows = new Map<OAuthLoginProviderId, SettingsAuthLoginFlow>();

  const routes: HttpRoute[] = [
    {
      methods: "GET, PUT, DELETE, OPTIONS",
      matches: (pathname) => pathname === SETTINGS_ENV_ENDPOINT_PATH || pathname.startsWith(`${SETTINGS_ENV_ENDPOINT_PATH}/`),
      handle: async (request, response, requestUrl) => {
        await handleSettingsEnvHttpRequest(swarmManager, request, response, requestUrl);
      }
    },
    {
      methods: SETTINGS_AUTH_METHODS,
      matches: (pathname) =>
        pathname === SETTINGS_AUTH_ENDPOINT_PATH || pathname.startsWith(`${SETTINGS_AUTH_ENDPOINT_PATH}/`),
      handle: async (request, response, requestUrl) => {
        await handleSettingsAuthHttpRequest(
          swarmManager,
          activeSettingsAuthLoginFlows,
          request,
          response,
          requestUrl
        );
      }
    }
  ];

  return {
    routes,
    cancelActiveSettingsAuthLoginFlows: () => {
      for (const flow of activeSettingsAuthLoginFlows.values()) {
        flow.closed = true;
        flow.abortController.abort();
        if (flow.pendingPrompt) {
          const pendingPrompt = flow.pendingPrompt;
          flow.pendingPrompt = null;
          pendingPrompt.reject(new Error("OAuth login flow cancelled"));
        }
      }
      activeSettingsAuthLoginFlows.clear();
    }
  };
}

async function handleSettingsEnvHttpRequest(
  swarmManager: SwarmManager,
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL
): Promise<void> {
  const methods = "GET, PUT, DELETE, OPTIONS";

  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, methods);
    response.statusCode = 204;
    response.end();
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === SETTINGS_ENV_ENDPOINT_PATH) {
    applyCorsHeaders(request, response, methods);
    const variables = await swarmManager.listSettingsEnv();
    sendJson(response, 200, { variables });
    return;
  }

  if (request.method === "PUT" && requestUrl.pathname === SETTINGS_ENV_ENDPOINT_PATH) {
    applyCorsHeaders(request, response, methods);
    const payload = parseSettingsEnvUpdateBody(await readJsonBody(request));
    await swarmManager.updateSettingsEnv(payload);
    const variables = await swarmManager.listSettingsEnv();
    sendJson(response, 200, { ok: true, variables });
    return;
  }

  if (request.method === "DELETE" && requestUrl.pathname.startsWith(`${SETTINGS_ENV_ENDPOINT_PATH}/`)) {
    applyCorsHeaders(request, response, methods);
    const variableName = decodeURIComponent(requestUrl.pathname.slice(SETTINGS_ENV_ENDPOINT_PATH.length + 1));
    if (!variableName) {
      sendJson(response, 400, { error: "Missing environment variable name" });
      return;
    }

    await swarmManager.deleteSettingsEnv(variableName);
    const variables = await swarmManager.listSettingsEnv();
    sendJson(response, 200, { ok: true, variables });
    return;
  }

  applyCorsHeaders(request, response, methods);
  response.setHeader("Allow", methods);
  sendJson(response, 405, { error: "Method Not Allowed" });
}

async function handleSettingsAuthHttpRequest(
  swarmManager: SwarmManager,
  activeSettingsAuthLoginFlows: Map<OAuthLoginProviderId, SettingsAuthLoginFlow>,
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL
): Promise<void> {
  if (
    requestUrl.pathname === SETTINGS_AUTH_LOGIN_ENDPOINT_PATH ||
    requestUrl.pathname.startsWith(`${SETTINGS_AUTH_LOGIN_ENDPOINT_PATH}/`)
  ) {
    await handleSettingsAuthLoginHttpRequest(swarmManager, activeSettingsAuthLoginFlows, request, response, requestUrl);
    return;
  }

  const methods = SETTINGS_AUTH_METHODS;

  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, methods);
    response.statusCode = 204;
    response.end();
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === SETTINGS_AUTH_ENDPOINT_PATH) {
    applyCorsHeaders(request, response, methods);
    const providers = await swarmManager.listSettingsAuth();
    sendJson(response, 200, { providers });
    return;
  }

  if (request.method === "PUT" && requestUrl.pathname === SETTINGS_AUTH_ENDPOINT_PATH) {
    applyCorsHeaders(request, response, methods);
    const payload = parseSettingsAuthUpdateBody(await readJsonBody(request));
    await swarmManager.updateSettingsAuth(payload);
    const providers = await swarmManager.listSettingsAuth();
    sendJson(response, 200, { ok: true, providers });
    return;
  }

  if (request.method === "DELETE" && requestUrl.pathname.startsWith(`${SETTINGS_AUTH_ENDPOINT_PATH}/`)) {
    applyCorsHeaders(request, response, methods);
    const provider = decodeURIComponent(requestUrl.pathname.slice(SETTINGS_AUTH_ENDPOINT_PATH.length + 1));
    if (!provider) {
      sendJson(response, 400, { error: "Missing auth provider" });
      return;
    }

    await swarmManager.deleteSettingsAuth(provider);
    const providers = await swarmManager.listSettingsAuth();
    sendJson(response, 200, { ok: true, providers });
    return;
  }

  applyCorsHeaders(request, response, methods);
  response.setHeader("Allow", methods);
  sendJson(response, 405, { error: "Method Not Allowed" });
}

async function handleSettingsAuthLoginHttpRequest(
  swarmManager: SwarmManager,
  activeSettingsAuthLoginFlows: Map<OAuthLoginProviderId, SettingsAuthLoginFlow>,
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL
): Promise<void> {
  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, SETTINGS_AUTH_LOGIN_METHODS);
    response.statusCode = 204;
    response.end();
    return;
  }

  const relativePath = requestUrl.pathname.startsWith(`${SETTINGS_AUTH_LOGIN_ENDPOINT_PATH}/`)
    ? requestUrl.pathname.slice(SETTINGS_AUTH_LOGIN_ENDPOINT_PATH.length + 1)
    : "";
  const pathSegments = relativePath.split("/").filter((segment) => segment.length > 0);
  const rawProvider = pathSegments[0] ?? "";
  const providerId = resolveSettingsAuthLoginProviderId(rawProvider);
  const action = pathSegments[1];

  applyCorsHeaders(request, response, SETTINGS_AUTH_LOGIN_METHODS);

  if (!providerId) {
    sendJson(response, 400, { error: "Invalid OAuth provider" });
    return;
  }

  if (action === "respond") {
    if (request.method !== "POST") {
      response.setHeader("Allow", SETTINGS_AUTH_LOGIN_METHODS);
      sendJson(response, 405, { error: "Method Not Allowed" });
      return;
    }

    if (pathSegments.length !== 2) {
      sendJson(response, 400, { error: "Invalid OAuth login respond path" });
      return;
    }

    const payload = parseSettingsAuthLoginRespondBody(await readJsonBody(request));
    const flow = activeSettingsAuthLoginFlows.get(providerId);
    if (!flow) {
      sendJson(response, 409, { error: "No active OAuth login flow for provider" });
      return;
    }

    if (!flow.pendingPrompt) {
      sendJson(response, 409, { error: "OAuth login flow is not waiting for input" });
      return;
    }

    const pendingPrompt = flow.pendingPrompt;
    flow.pendingPrompt = null;
    pendingPrompt.resolve(payload.value);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (action !== undefined || pathSegments.length !== 1) {
    sendJson(response, 400, { error: "Invalid OAuth login path" });
    return;
  }

  if (request.method !== "POST") {
    response.setHeader("Allow", SETTINGS_AUTH_LOGIN_METHODS);
    sendJson(response, 405, { error: "Method Not Allowed" });
    return;
  }

  if (activeSettingsAuthLoginFlows.has(providerId)) {
    sendJson(response, 409, { error: "OAuth login already in progress for provider" });
    return;
  }

  const flow: SettingsAuthLoginFlow = {
    providerId,
    pendingPrompt: null,
    abortController: new AbortController(),
    closed: false
  };
  activeSettingsAuthLoginFlows.set(providerId, flow);

  const provider = SETTINGS_AUTH_LOGIN_PROVIDERS[providerId];
  const authStorage = AuthStorage.create(swarmManager.getConfig().paths.authFile);

  response.statusCode = 200;
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("X-Accel-Buffering", "no");

  if (typeof response.flushHeaders === "function") {
    response.flushHeaders();
  }

  const sendSseEvent = <TEventName extends SettingsAuthLoginEventName>(
    eventName: TEventName,
    data: SettingsAuthLoginEventPayload[TEventName]
  ): void => {
    if (flow.closed || response.writableEnded || response.destroyed) {
      return;
    }

    response.write(`event: ${eventName}\n`);
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const closeFlow = (reason: string): void => {
    if (flow.closed) {
      return;
    }

    flow.closed = true;
    flow.abortController.abort();

    if (flow.pendingPrompt) {
      const pendingPrompt = flow.pendingPrompt;
      flow.pendingPrompt = null;
      pendingPrompt.reject(new Error(reason));
    }

    const activeFlow = activeSettingsAuthLoginFlows.get(providerId);
    if (activeFlow === flow) {
      activeSettingsAuthLoginFlows.delete(providerId);
    }
  };

  const requestPromptInput = (prompt: {
    message: string;
    placeholder?: string;
  }): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      if (flow.closed) {
        reject(new Error("OAuth login flow is closed"));
        return;
      }

      if (flow.pendingPrompt) {
        const previousPrompt = flow.pendingPrompt;
        flow.pendingPrompt = null;
        previousPrompt.reject(new Error("OAuth login prompt replaced by a newer request"));
      }

      const wrappedResolve = (value: string): void => {
        if (flow.pendingPrompt?.resolve === wrappedResolve) {
          flow.pendingPrompt = null;
        }
        resolve(value);
      };

      const wrappedReject = (error: Error): void => {
        if (flow.pendingPrompt?.reject === wrappedReject) {
          flow.pendingPrompt = null;
        }
        reject(error);
      };

      flow.pendingPrompt = {
        resolve: wrappedResolve,
        reject: wrappedReject
      };

      sendSseEvent("prompt", prompt);
    });

  const onClose = (): void => {
    closeFlow("OAuth login stream closed");
  };

  request.on("close", onClose);
  response.on("close", onClose);

  sendSseEvent("progress", { message: `Starting ${provider.name} OAuth login...` });

  try {
    const callbacks: OAuthLoginCallbacks = {
      onAuth: (info) => {
        sendSseEvent("auth_url", {
          url: info.url,
          instructions: info.instructions
        });
      },
      onPrompt: (prompt) =>
        requestPromptInput({
          message: prompt.message,
          placeholder: prompt.placeholder
        }),
      onProgress: (message) => {
        sendSseEvent("progress", { message });
      },
      signal: flow.abortController.signal
    };

    if (provider.usesCallbackServer) {
      callbacks.onManualCodeInput = () =>
        requestPromptInput({
          message: "Paste redirect URL below, or complete login in browser:",
          placeholder: "http://localhost:1455/auth/callback?code=..."
        });
    }

    const credentials = (await provider.login(callbacks)) as OAuthCredentials;
    if (flow.closed) {
      return;
    }

    authStorage.set(providerId, {
      type: "oauth",
      ...credentials
    });

    sendSseEvent("complete", {
      provider: flow.providerId,
      status: "connected"
    });
  } catch (error) {
    if (!flow.closed) {
      const message = error instanceof Error ? error.message : String(error);
      sendSseEvent("error", { message });
    }
  } finally {
    request.off("close", onClose);
    response.off("close", onClose);
    closeFlow("OAuth login flow closed");
    if (!response.writableEnded) {
      response.end();
    }
  }
}

function parseSettingsEnvUpdateBody(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object");
  }

  const maybeValues = "values" in value ? (value as { values?: unknown }).values : value;
  if (!maybeValues || typeof maybeValues !== "object" || Array.isArray(maybeValues)) {
    throw new Error("settings env payload must be an object map");
  }

  const updates: Record<string, string> = {};

  for (const [name, rawValue] of Object.entries(maybeValues)) {
    if (typeof rawValue !== "string") {
      throw new Error(`settings env value for ${name} must be a string`);
    }

    const normalized = rawValue.trim();
    if (!normalized) {
      throw new Error(`settings env value for ${name} must be a non-empty string`);
    }

    updates[name] = normalized;
  }

  return updates;
}

function parseSettingsAuthUpdateBody(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object");
  }

  const updates: Record<string, string> = {};

  for (const [provider, rawValue] of Object.entries(value)) {
    if (typeof rawValue !== "string") {
      throw new Error(`settings auth value for ${provider} must be a string`);
    }

    const normalized = rawValue.trim();
    if (!normalized) {
      throw new Error(`settings auth value for ${provider} must be a non-empty string`);
    }

    updates[provider] = normalized;
  }

  return updates;
}

function parseSettingsAuthLoginRespondBody(value: unknown): { value: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object");
  }

  const rawValue = (value as { value?: unknown }).value;
  if (typeof rawValue !== "string") {
    throw new Error("OAuth response value must be a string");
  }

  const normalized = rawValue.trim();
  if (!normalized) {
    throw new Error("OAuth response value must be a non-empty string");
  }

  return { value: normalized };
}

function resolveSettingsAuthLoginProviderId(rawProvider: string): OAuthLoginProviderId | undefined {
  const normalized = rawProvider.trim().toLowerCase();
  if (normalized === "anthropic" || normalized === "openai-codex") {
    return normalized;
  }

  return undefined;
}
