import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";

export type JsonRpcRequestId = string | number;

export interface JsonRpcRequestMessage {
  id: JsonRpcRequestId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotificationMessage {
  method: string;
  params?: unknown;
}

export interface JsonRpcResponseMessage {
  id: JsonRpcRequestId;
  result: unknown;
}

export interface JsonRpcErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcErrorMessage {
  id: JsonRpcRequestId;
  error: JsonRpcErrorPayload;
}

export type JsonRpcMessage =
  | JsonRpcRequestMessage
  | JsonRpcNotificationMessage
  | JsonRpcResponseMessage
  | JsonRpcErrorMessage;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout> | undefined;
}

export interface CodexJsonRpcClientTransport {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr?: NodeJS.ReadableStream | null;
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  off(event: "error", listener: (error: Error) => void): this;
  off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export interface CodexJsonRpcClientOptions {
  command: string;
  args?: string[];
  spawnOptions?: Omit<SpawnOptionsWithoutStdio, "stdio">;
  requestTimeoutMs?: number;
  transport?: CodexJsonRpcClientTransport;
  onNotification?: (notification: JsonRpcNotificationMessage) => void | Promise<void>;
  onRequest?: (request: JsonRpcRequestMessage) => Promise<unknown>;
  onExit?: (error: Error) => void;
  onStderr?: (line: string) => void;
}

export interface CodexInitializeParams {
  clientInfo: {
    name: string;
    title?: string | null;
    version: string;
  };
  capabilities?: {
    experimentalApi?: boolean;
    optOutNotificationMethods?: string[];
  } | null;
}

interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export function encodeJsonRpcMessage(message: JsonRpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function decodeJsonRpcMessage(line: string): JsonRpcMessage {
  const normalizedLine = line.replace(/\r?\n$/, "").replace(/\r$/, "");
  if (normalizedLine.length === 0) {
    throw new Error("Cannot decode an empty JSON-RPC line.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(normalizedLine);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON-RPC payload: ${message}`);
  }

  if (isJsonRpcResponseMessage(parsed)) {
    return parsed;
  }

  if (isJsonRpcErrorMessage(parsed)) {
    return parsed;
  }

  if (isJsonRpcRequestMessage(parsed)) {
    return parsed;
  }

  if (isJsonRpcNotificationMessage(parsed)) {
    return parsed;
  }

  throw new Error("Invalid JSON-RPC message shape.");
}

export class CodexJsonRpcClient {
  readonly #transport: CodexJsonRpcClientTransport;
  readonly #stdoutReader: ReadLineInterface;
  readonly #stderrReader?: ReadLineInterface;
  readonly #options: CodexJsonRpcClientOptions;
  readonly #requestTimeoutMs: number;

  #disposed = false;
  #exited = false;
  #nextRequestId = 0;
  readonly #pendingById = new Map<string, PendingRequest>();
  readonly #exitPromise: Promise<ExitInfo>;
  #resolveExitPromise!: (info: ExitInfo) => void;

  constructor(options: CodexJsonRpcClientOptions) {
    this.#options = options;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#transport =
      options.transport ??
      this.#spawnTransport(options.command, options.args ?? [], options.spawnOptions);

    this.#exitPromise = new Promise<ExitInfo>((resolve) => {
      this.#resolveExitPromise = resolve;
    });

    this.#stdoutReader = createInterface({
      input: this.#transport.stdout,
      crlfDelay: Infinity,
    });

    if (this.#transport.stderr) {
      this.#stderrReader = createInterface({
        input: this.#transport.stderr,
        crlfDelay: Infinity,
      });
    }

    this.#stdoutReader.on("line", (line) => {
      void this.#handleStdoutLine(line);
    });

    this.#stderrReader?.on("line", (line) => {
      this.#options.onStderr?.(line);
    });

    this.#transport.on("error", this.#handleTransportError);
    this.#transport.on("exit", this.#handleTransportExit);
  }

  get pid(): number | undefined {
    return this.#transport.pid;
  }

  async initialize(
    params: CodexInitializeParams,
    timeoutMs = this.#requestTimeoutMs,
  ): Promise<void> {
    await this.sendRequest("initialize", params, timeoutMs);
    this.sendNotification("initialized");
  }

  async sendRequest<T>(
    method: string,
    params?: unknown,
    timeoutMs = this.#requestTimeoutMs,
  ): Promise<T> {
    this.#ensureReady();

    const id = ++this.#nextRequestId;
    const message: JsonRpcRequestMessage = {
      id,
      method,
      params,
    };
    const key = toRequestKey(id);

    return await new Promise<T>((resolve, reject) => {
      const timeout =
        timeoutMs > 0
          ? setTimeout(() => {
              this.#pendingById.delete(key);
              reject(new Error(`JSON-RPC request timed out: ${method}`));
            }, timeoutMs)
          : undefined;

      timeout?.unref?.();

      this.#pendingById.set(key, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });

      try {
        this.#writeMessage(message);
      } catch (error) {
        this.#clearPending(key);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  sendNotification(method: string, params?: unknown): void {
    this.#ensureReady();
    this.#writeMessage({
      method,
      params,
    });
  }

  requestShutdown(): void {
    if (this.#disposed || !this.#transport.stdin.writable) {
      return;
    }

    this.#transport.stdin.end();
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): void {
    if (this.#exited) {
      return;
    }

    this.#transport.kill(signal);
  }

  async waitForExit(timeoutMs?: number): Promise<ExitInfo | null> {
    if (this.#exited) {
      return {
        code: this.#transport.exitCode,
        signal: this.#transport.signalCode,
      };
    }

    if (timeoutMs === undefined || timeoutMs <= 0) {
      return await this.#exitPromise;
    }

    return await Promise.race([
      this.#exitPromise,
      new Promise<null>((resolve) => {
        const timeout = setTimeout(() => resolve(null), timeoutMs);
        timeout.unref?.();
      }),
    ]);
  }

  dispose(signal: NodeJS.Signals | number = "SIGTERM"): void {
    if (this.#disposed) {
      return;
    }

    this.#disposed = true;
    this.#closeReaders();
    this.#rejectAllPending(new Error("JSON-RPC client disposed"));

    if (this.#transport.stdin.writable) {
      this.#transport.stdin.end();
    }

    if (!this.#exited) {
      this.#transport.kill(signal);
    }
  }

  #spawnTransport(
    command: string,
    args: string[],
    spawnOptions: Omit<SpawnOptionsWithoutStdio, "stdio"> | undefined,
  ): ChildProcessWithoutNullStreams {
    return spawn(command, args, {
      ...spawnOptions,
      stdio: "pipe",
    });
  }

  #ensureReady(): void {
    if (this.#disposed) {
      throw new Error("JSON-RPC client is disposed.");
    }

    if (this.#exited) {
      throw new Error("JSON-RPC client process has exited.");
    }

    if (!this.#transport.stdin.writable) {
      throw new Error("JSON-RPC stdin is not writable.");
    }
  }

  #writeMessage(message: JsonRpcMessage): void {
    this.#transport.stdin.write(encodeJsonRpcMessage(message), "utf8");
  }

  async #handleStdoutLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }

    let parsed: JsonRpcMessage;
    try {
      parsed = decodeJsonRpcMessage(trimmed);
    } catch {
      return;
    }

    if (isJsonRpcResponseMessage(parsed)) {
      this.#resolvePending(parsed.id, parsed.result);
      return;
    }

    if (isJsonRpcErrorMessage(parsed)) {
      this.#rejectPendingWithPayload(parsed.id, parsed.error);
      return;
    }

    if (isJsonRpcRequestMessage(parsed)) {
      await this.#handleServerRequest(parsed);
      return;
    }

    await this.#options.onNotification?.(parsed);
  }

  async #handleServerRequest(request: JsonRpcRequestMessage): Promise<void> {
    if (!this.#options.onRequest) {
      this.#writeMessage({
        id: request.id,
        error: {
          code: -32601,
          message: `Unsupported server request: ${request.method}`,
        },
      });
      return;
    }

    try {
      const result = await this.#options.onRequest(request);
      this.#writeMessage({
        id: request.id,
        result: result ?? {},
      });
    } catch (error) {
      this.#writeMessage({
        id: request.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  #resolvePending(id: JsonRpcRequestId, result: unknown): void {
    const pending = this.#clearPending(toRequestKey(id));
    pending?.resolve(result);
  }

  #rejectPendingWithPayload(id: JsonRpcRequestId, payload: JsonRpcErrorPayload): void {
    const pending = this.#clearPending(toRequestKey(id));
    if (!pending) {
      return;
    }

    const error = new Error(payload.message);
    (error as Error & { code?: number; data?: unknown }).code = payload.code;
    (error as Error & { data?: unknown }).data = payload.data;
    pending.reject(error);
  }

  #clearPending(key: string): PendingRequest | undefined {
    const pending = this.#pendingById.get(key);
    if (!pending) {
      return undefined;
    }

    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }

    this.#pendingById.delete(key);
    return pending;
  }

  #rejectAllPending(error: Error): void {
    for (const [key, pending] of this.#pendingById.entries()) {
      if (pending.timeout) {
        clearTimeout(pending.timeout);
      }

      this.#pendingById.delete(key);
      pending.reject(error);
    }
  }

  #closeReaders(): void {
    this.#stdoutReader.close();
    this.#stderrReader?.close();
  }

  #handleTransportError = (error: Error): void => {
    this.#handleProcessExit(error, {
      code: this.#transport.exitCode,
      signal: this.#transport.signalCode,
    });
  };

  #handleTransportExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    this.#handleProcessExit(
      new Error(`Codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`),
      { code, signal },
    );
  };

  #handleProcessExit(error: Error, info: ExitInfo): void {
    if (this.#exited) {
      return;
    }

    this.#exited = true;
    this.#closeReaders();
    this.#rejectAllPending(error);
    this.#resolveExitPromise(info);
    this.#options.onExit?.(error);
  }
}

function toRequestKey(id: JsonRpcRequestId): string {
  return typeof id === "number" ? `n:${id}` : `s:${id}`;
}

function isJsonRpcRequestMessage(value: unknown): value is JsonRpcRequestMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as {
    id?: unknown;
    method?: unknown;
  };

  return (
    (typeof maybe.id === "number" || typeof maybe.id === "string") &&
    typeof maybe.method === "string"
  );
}

function isJsonRpcNotificationMessage(value: unknown): value is JsonRpcNotificationMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as {
    id?: unknown;
    method?: unknown;
  };

  return maybe.id === undefined && typeof maybe.method === "string";
}

function isJsonRpcResponseMessage(value: unknown): value is JsonRpcResponseMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as {
    id?: unknown;
    result?: unknown;
  };

  return (typeof maybe.id === "number" || typeof maybe.id === "string") && "result" in maybe;
}

function isJsonRpcErrorMessage(value: unknown): value is JsonRpcErrorMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as {
    id?: unknown;
    error?: unknown;
  };

  if (typeof maybe.id !== "number" && typeof maybe.id !== "string") {
    return false;
  }

  if (!maybe.error || typeof maybe.error !== "object") {
    return false;
  }

  const payload = maybe.error as {
    code?: unknown;
    message?: unknown;
  };

  return typeof payload.code === "number" && typeof payload.message === "string";
}
