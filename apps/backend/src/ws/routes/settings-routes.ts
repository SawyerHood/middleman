import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
  OAuthProviderInterface,
} from "@mariozechner/pi-ai";
import * as piAiOAuth from "@mariozechner/pi-ai/oauth";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import {
  DEFAULT_MAX_HTTP_BODY_SIZE_BYTES,
  createBodyLimit,
  createCorsMiddleware,
  createMethodGuard,
  readJsonBody,
  type NodeServerEnv,
} from "../hono-utils.js";

const SETTINGS_ENV_ENDPOINT_PATH = "/api/settings/env";
const SETTINGS_ENV_VARIABLE_ENDPOINT_PATH = "/api/settings/env/:variableName";
const SETTINGS_AUTH_ENDPOINT_PATH = "/api/settings/auth";
const SETTINGS_AUTH_PROVIDER_ENDPOINT_PATH = "/api/settings/auth/:provider";
const SETTINGS_AUTH_LOGIN_BASE_PATH = "/api/settings/auth/login";
const SETTINGS_AUTH_LOGIN_ENDPOINT_PATH = "/api/settings/auth/login/:providerId";
const SETTINGS_AUTH_LOGIN_RESPOND_ENDPOINT_PATH = "/api/settings/auth/login/:providerId/respond";
const SETTINGS_AUTH_LOGIN_RESPOND_INVALID_PATH = "/api/settings/auth/login/:providerId/respond/*";
const SETTINGS_AUTH_LOGIN_TREE_PATH = "/api/settings/auth/login/*";
const SETTINGS_ENV_METHODS = ["GET", "PUT"] as const;
const SETTINGS_ENV_VARIABLE_METHODS = ["DELETE"] as const;
const SETTINGS_AUTH_METHODS = ["GET", "PUT"] as const;
const SETTINGS_AUTH_PROVIDER_METHODS = ["DELETE"] as const;
const SETTINGS_AUTH_LOGIN_METHODS = ["POST"] as const;

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
  pendingPrompt: {
    resolve: (value: string) => void;
    reject: (error: Error) => void;
  } | null;
  abortController: AbortController;
  closed: boolean;
}

const anthropicOAuthProvider = (piAiOAuth as { anthropicOAuthProvider: OAuthProviderInterface })
  .anthropicOAuthProvider;
const openaiCodexOAuthProvider = (piAiOAuth as { openaiCodexOAuthProvider: OAuthProviderInterface })
  .openaiCodexOAuthProvider;

const SETTINGS_AUTH_LOGIN_PROVIDERS: Record<OAuthLoginProviderId, OAuthProviderInterface> = {
  anthropic: anthropicOAuthProvider,
  "openai-codex": openaiCodexOAuthProvider,
};

export interface SettingsRouteBundle {
  app: Hono<NodeServerEnv>;
  cancelActiveSettingsAuthLoginFlows: () => void;
}

export function createSettingsRoutes(options: { swarmManager: SwarmManager }): SettingsRouteBundle {
  const { swarmManager } = options;
  const activeSettingsAuthLoginFlows = new Map<OAuthLoginProviderId, SettingsAuthLoginFlow>();
  const app = new Hono<NodeServerEnv>();

  app.use(SETTINGS_ENV_ENDPOINT_PATH, createCorsMiddleware(SETTINGS_ENV_METHODS));
  app.use(SETTINGS_ENV_ENDPOINT_PATH, createMethodGuard(SETTINGS_ENV_METHODS));
  app.get(SETTINGS_ENV_ENDPOINT_PATH, async (c) => {
    const variables = await swarmManager.listSettingsEnv();
    return c.json({ variables });
  });
  app.put(
    SETTINGS_ENV_ENDPOINT_PATH,
    createBodyLimit(
      DEFAULT_MAX_HTTP_BODY_SIZE_BYTES,
      `Request body too large. Max ${DEFAULT_MAX_HTTP_BODY_SIZE_BYTES} bytes.`,
      400,
    ),
    async (c) => {
      const payload = parseSettingsEnvUpdateBody(
        await readJsonBody(c, {
          emptyValue: {},
          invalidJsonMessage: "Request body must be valid JSON",
        }),
      );
      await swarmManager.updateSettingsEnv(payload);
      const variables = await swarmManager.listSettingsEnv();
      return c.json({ ok: true, variables });
    },
  );

  app.use(SETTINGS_ENV_VARIABLE_ENDPOINT_PATH, createCorsMiddleware(SETTINGS_ENV_VARIABLE_METHODS));
  app.use(SETTINGS_ENV_VARIABLE_ENDPOINT_PATH, createMethodGuard(SETTINGS_ENV_VARIABLE_METHODS));
  app.delete(SETTINGS_ENV_VARIABLE_ENDPOINT_PATH, async (c) => {
    const variableName = c.req.param("variableName");
    if (!variableName) {
      return c.json({ error: "Missing environment variable name" }, 400);
    }

    await swarmManager.deleteSettingsEnv(variableName);
    const variables = await swarmManager.listSettingsEnv();
    return c.json({ ok: true, variables });
  });

  app.use(SETTINGS_AUTH_ENDPOINT_PATH, createCorsMiddleware(SETTINGS_AUTH_METHODS));
  app.use(SETTINGS_AUTH_ENDPOINT_PATH, createMethodGuard(SETTINGS_AUTH_METHODS));
  app.get(SETTINGS_AUTH_ENDPOINT_PATH, async (c) => {
    const providers = await swarmManager.listSettingsAuth();
    return c.json({ providers });
  });
  app.put(
    SETTINGS_AUTH_ENDPOINT_PATH,
    createBodyLimit(
      DEFAULT_MAX_HTTP_BODY_SIZE_BYTES,
      `Request body too large. Max ${DEFAULT_MAX_HTTP_BODY_SIZE_BYTES} bytes.`,
      400,
    ),
    async (c) => {
      const payload = parseSettingsAuthUpdateBody(
        await readJsonBody(c, {
          emptyValue: {},
          invalidJsonMessage: "Request body must be valid JSON",
        }),
      );
      await swarmManager.updateSettingsAuth(payload);
      const providers = await swarmManager.listSettingsAuth();
      return c.json({ ok: true, providers });
    },
  );

  app.use(
    SETTINGS_AUTH_PROVIDER_ENDPOINT_PATH,
    createCorsMiddleware(SETTINGS_AUTH_PROVIDER_METHODS),
  );
  app.use(SETTINGS_AUTH_PROVIDER_ENDPOINT_PATH, createMethodGuard(SETTINGS_AUTH_PROVIDER_METHODS));
  app.delete(SETTINGS_AUTH_PROVIDER_ENDPOINT_PATH, async (c) => {
    const provider = c.req.param("provider");
    if (!provider) {
      return c.json({ error: "Missing auth provider" }, 400);
    }

    await swarmManager.deleteSettingsAuth(provider);
    const providers = await swarmManager.listSettingsAuth();
    return c.json({ ok: true, providers });
  });

  app.use(SETTINGS_AUTH_LOGIN_BASE_PATH, createCorsMiddleware(SETTINGS_AUTH_LOGIN_METHODS));
  app.all(SETTINGS_AUTH_LOGIN_BASE_PATH, (c) => {
    return c.json({ error: "Invalid OAuth provider" }, 400);
  });

  app.use(SETTINGS_AUTH_LOGIN_TREE_PATH, createCorsMiddleware(SETTINGS_AUTH_LOGIN_METHODS));
  app.use(SETTINGS_AUTH_LOGIN_TREE_PATH, createMethodGuard(SETTINGS_AUTH_LOGIN_METHODS));
  app.post(SETTINGS_AUTH_LOGIN_RESPOND_INVALID_PATH, (c) => {
    return c.json({ error: "Invalid OAuth login respond path" }, 400);
  });
  app.post(
    SETTINGS_AUTH_LOGIN_RESPOND_ENDPOINT_PATH,
    createBodyLimit(
      DEFAULT_MAX_HTTP_BODY_SIZE_BYTES,
      `Request body too large. Max ${DEFAULT_MAX_HTTP_BODY_SIZE_BYTES} bytes.`,
      400,
    ),
    async (c) => {
      const providerId = resolveSettingsAuthLoginProviderId(c.req.param("providerId"));
      if (!providerId) {
        return c.json({ error: "Invalid OAuth provider" }, 400);
      }

      const payload = parseSettingsAuthLoginRespondBody(
        await readJsonBody(c, {
          emptyValue: {},
          invalidJsonMessage: "Request body must be valid JSON",
        }),
      );
      const flow = activeSettingsAuthLoginFlows.get(providerId);
      if (!flow) {
        return c.json({ error: "No active OAuth login flow for provider" }, 409);
      }

      if (!flow.pendingPrompt) {
        return c.json({ error: "OAuth login flow is not waiting for input" }, 409);
      }

      const pendingPrompt = flow.pendingPrompt;
      flow.pendingPrompt = null;
      pendingPrompt.resolve(payload.value);
      return c.json({ ok: true });
    },
  );
  app.post(SETTINGS_AUTH_LOGIN_ENDPOINT_PATH, async (c) => {
    const providerId = resolveSettingsAuthLoginProviderId(c.req.param("providerId"));
    if (!providerId) {
      return c.json({ error: "Invalid OAuth provider" }, 400);
    }

    if (activeSettingsAuthLoginFlows.has(providerId)) {
      return c.json({ error: "OAuth login already in progress for provider" }, 409);
    }

    const flow: SettingsAuthLoginFlow = {
      providerId,
      pendingPrompt: null,
      abortController: new AbortController(),
      closed: false,
    };
    activeSettingsAuthLoginFlows.set(providerId, flow);

    const provider = SETTINGS_AUTH_LOGIN_PROVIDERS[providerId];
    const response = streamSSE(c, async (stream) => {
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

      const onClose = (): void => {
        closeFlow("OAuth login stream closed");
      };

      c.req.raw.signal.addEventListener("abort", onClose, { once: true });
      stream.onAbort(onClose);

      const sendSseEvent = async <TEventName extends SettingsAuthLoginEventName>(
        eventName: TEventName,
        data: SettingsAuthLoginEventPayload[TEventName],
      ): Promise<void> => {
        if (flow.closed || stream.closed || stream.aborted) {
          return;
        }

        await stream.writeSSE({
          event: eventName,
          data: JSON.stringify(data),
        });
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
            reject: wrappedReject,
          };

          void sendSseEvent("prompt", prompt);
        });

      await sendSseEvent("progress", { message: `Starting ${provider.name} OAuth login...` });
      const authStorage = AuthStorage.create(swarmManager.getConfig().paths.authFile);

      try {
        const callbacks: OAuthLoginCallbacks = {
          onAuth: (info) => {
            void sendSseEvent("auth_url", {
              url: info.url,
              instructions: info.instructions,
            });
          },
          onPrompt: (prompt) =>
            requestPromptInput({
              message: prompt.message,
              placeholder: prompt.placeholder,
            }),
          onProgress: (message) => {
            void sendSseEvent("progress", { message });
          },
          signal: flow.abortController.signal,
        };

        if (provider.usesCallbackServer) {
          callbacks.onManualCodeInput = () =>
            requestPromptInput({
              message: "Paste redirect URL below, or complete login in browser:",
              placeholder: "http://localhost:1455/auth/callback?code=...",
            });
        }

        const credentials = (await provider.login(callbacks)) as OAuthCredentials;
        if (flow.closed) {
          return;
        }

        authStorage.set(providerId, {
          type: "oauth",
          ...credentials,
        });

        await sendSseEvent("complete", {
          provider: flow.providerId,
          status: "connected",
        });
      } catch (error) {
        if (!flow.closed) {
          const message = error instanceof Error ? error.message : String(error);
          await sendSseEvent("error", { message });
        }
      } finally {
        c.req.raw.signal.removeEventListener("abort", onClose);
        closeFlow("OAuth login flow closed");
      }
    });

    response.headers.set("Cache-Control", "no-cache, no-transform");
    response.headers.set("Connection", "keep-alive");
    response.headers.set("Content-Type", "text/event-stream; charset=utf-8");
    response.headers.set("X-Accel-Buffering", "no");
    return response;
  });
  app.post(SETTINGS_AUTH_LOGIN_TREE_PATH, (c) => {
    return c.json({ error: "Invalid OAuth login path" }, 400);
  });

  return {
    app,
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
    },
  };
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
