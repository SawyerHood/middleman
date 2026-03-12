import type { IncomingMessage, ServerResponse } from "node:http";
import { extname } from "node:path";

export const DEFAULT_MAX_HTTP_BODY_SIZE_BYTES = 64 * 1024;

export function resolveRequestUrl(request: IncomingMessage, fallbackHost: string): URL {
  return new URL(request.url ?? "/", `http://${request.headers.host ?? fallbackHost}`);
}

export function matchPathPattern(pathname: string, pattern: RegExp): RegExpMatchArray | null {
  return pathname.match(pattern);
}

export function decodePathSegment(rawSegment: string | undefined): string | undefined {
  if (!rawSegment) {
    return undefined;
  }

  try {
    const decoded = decodeURIComponent(rawSegment).trim();
    return decoded.length > 0 ? decoded : undefined;
  } catch {
    return undefined;
  }
}

export async function readRequestBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const chunkBuffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    totalBytes += chunkBuffer.length;

    if (totalBytes > maxBytes) {
      throw new Error(`Request body too large. Max ${maxBytes} bytes.`);
    }

    chunks.push(chunkBuffer);
  }

  return Buffer.concat(chunks);
}

export async function readJsonBody(
  request: IncomingMessage,
  maxBytes = DEFAULT_MAX_HTTP_BODY_SIZE_BYTES
): Promise<unknown> {
  const body = await readRequestBody(request, maxBytes);

  if (body.length === 0) {
    return {};
  }

  const raw = body.toString("utf8").trim();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

export async function parseJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let byteLength = 0;

  for await (const chunk of request) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    byteLength += buffer.byteLength;

    if (byteLength > maxBytes) {
      throw new Error(`Request body exceeds ${maxBytes} bytes.`);
    }

    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  const rawBody = Buffer.concat(chunks).toString("utf8");

  try {
    return JSON.parse(rawBody);
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

export function applyCorsHeaders(request: IncomingMessage, response: ServerResponse, methods: string): void {
  const origin = typeof request.headers.origin === "string" ? request.headers.origin : "*";

  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Methods", methods);
  response.setHeader("Access-Control-Allow-Headers", "content-type");
}

export function sendJson(response: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

export function resolveReadFileContentType(path: string): string {
  const extension = extname(path).toLowerCase();

  switch (extension) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".avif":
      return "image/avif";
    case ".bmp":
      return "image/bmp";
    case ".svg":
      return "image/svg+xml; charset=utf-8";
    case ".ico":
      return "image/x-icon";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".map":
      return "application/json; charset=utf-8";
    case ".wasm":
      return "application/wasm";
    default:
      return "application/octet-stream";
  }
}
