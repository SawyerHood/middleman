import type { HttpBindings } from "@hono/node-server";
import { bodyLimit } from "hono/body-limit";
import type { Context, MiddlewareHandler } from "hono";
import { cors } from "hono/cors";

export const DEFAULT_MAX_HTTP_BODY_SIZE_BYTES = 64 * 1024;

export type NodeServerEnv = {
  Bindings: HttpBindings;
};

export function createCorsMiddleware(
  allowMethods: readonly string[],
): MiddlewareHandler<NodeServerEnv> {
  return cors({
    origin: (origin) => origin || "*",
    allowMethods: [...allowMethods, "OPTIONS"],
    allowHeaders: ["content-type"],
  });
}

export function createMethodGuard(
  allowMethods: readonly string[],
): MiddlewareHandler<NodeServerEnv> {
  const allowHeader = [...allowMethods, "OPTIONS"].join(", ");
  const allowedMethods = new Set([...allowMethods, "OPTIONS"]);

  return async (c, next) => {
    if (allowedMethods.has(c.req.method)) {
      await next();
      return;
    }

    c.header("Allow", allowHeader);
    return c.json({ error: "Method Not Allowed" }, 405);
  };
}

export function createBodyLimit(
  maxSize: number,
  errorMessage: string,
  statusCode: 400 | 413 = 413,
): MiddlewareHandler<NodeServerEnv> {
  return bodyLimit({
    maxSize,
    onError: (c) => c.json({ error: errorMessage }, statusCode),
  });
}

export async function readJsonBody(
  c: Context<NodeServerEnv>,
  options: {
    emptyValue?: unknown;
    invalidJsonMessage?: string;
  } = {},
): Promise<unknown> {
  const { emptyValue = {}, invalidJsonMessage = "Request body must be valid JSON" } = options;

  try {
    return await c.req.json();
  } catch {
    const rawBody = await c.req.text();
    if (rawBody.trim().length === 0) {
      return emptyValue;
    }

    throw new Error(invalidJsonMessage);
  }
}
