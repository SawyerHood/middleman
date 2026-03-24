import {
  workerCommandSchema,
  workerEventSchema,
  type WorkerCommand,
  type WorkerEvent,
} from "../types/index.js";

const workerCommandTypes = new Set<WorkerCommand["type"]>([
  "bootstrap",
  "send_input",
  "interrupt",
  "compact",
  "stop",
  "terminate",
  "host_call_result",
  "ping",
]);

function isWorkerCommand(message: WorkerCommand | WorkerEvent): message is WorkerCommand {
  return workerCommandTypes.has(message.type as WorkerCommand["type"]);
}

function formatValidationError(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return `${path}${issue.message}`;
    })
    .join("; ");
}

function reportProtocolError(prefix: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${prefix}: ${message}\n`);
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function isBrokenPipeError(error: unknown): boolean {
  return getErrorCode(error) === "EPIPE";
}

function isClosedStreamError(error: unknown): boolean {
  const code = getErrorCode(error);
  return code === "ERR_STREAM_DESTROYED" || code === "ERR_STREAM_WRITE_AFTER_END";
}

export function encodeMessage(msg: WorkerCommand | WorkerEvent): string {
  return `${JSON.stringify(msg)}\n`;
}

export function decodeMessage(line: string): WorkerCommand | WorkerEvent {
  const normalizedLine = line.replace(/\r?\n$/, "").replace(/\r$/, "");
  if (normalizedLine.length === 0) {
    throw new Error("Cannot decode an empty worker protocol line.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(normalizedLine);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid worker protocol JSON: ${message}`);
  }

  const commandResult = workerCommandSchema.safeParse(parsed);
  if (commandResult.success) {
    return commandResult.data;
  }

  const eventResult = workerEventSchema.safeParse(parsed);
  if (eventResult.success) {
    return eventResult.data;
  }

  throw new Error(
    `Invalid worker protocol message. Command validation failed: ${formatValidationError(
      commandResult.error,
    )}. Event validation failed: ${formatValidationError(eventResult.error)}.`,
  );
}

export class LineReader {
  readonly #stream: NodeJS.ReadableStream;

  constructor(stream: NodeJS.ReadableStream) {
    this.#stream = stream;
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<string> {
    let buffer = "";

    for await (const chunk of this.#stream as AsyncIterable<string | Uint8Array>) {
      buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        let line = buffer.slice(0, newlineIndex);
        if (line.endsWith("\r")) {
          line = line.slice(0, -1);
        }

        yield line;
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
      }
    }

    if (buffer.length > 0) {
      yield buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
    }
  }
}

export class LineWriter {
  readonly #stream: NodeJS.WritableStream;
  #closed = false;

  constructor(stream: NodeJS.WritableStream) {
    this.#stream = stream;
    stream.on("close", () => {
      this.#closed = true;
    });
    stream.on("finish", () => {
      this.#closed = true;
    });
    stream.on("error", (error) => {
      this.#handleWriteError(error);
    });
  }

  send(msg: WorkerCommand | WorkerEvent): void {
    if (this.#closed || this.#isStreamClosed()) {
      return;
    }

    try {
      this.#stream.write(encodeMessage(msg), (error) => {
        if (error) {
          this.#handleWriteError(error);
        }
      });
    } catch (error) {
      this.#handleWriteError(error);
    }
  }

  #handleWriteError(error: unknown): void {
    this.#closed = true;
    if (isBrokenPipeError(error) || isClosedStreamError(error)) {
      return;
    }

    reportProtocolError("LineWriter", error);
  }

  #isStreamClosed(): boolean {
    const stream = this.#stream as NodeJS.WritableStream & {
      closed?: boolean;
      destroyed?: boolean;
      writableEnded?: boolean;
    };

    return Boolean(stream.closed || stream.destroyed || stream.writableEnded);
  }
}

export class WorkerProtocolHost {
  readonly #stdin: NodeJS.WritableStream;
  readonly #stdout: NodeJS.ReadableStream;
  readonly #reader: LineReader;
  readonly #writer: LineWriter;
  #closed = false;
  #eventHandler?: (event: WorkerEvent) => void;
  readonly #pendingEvents: WorkerEvent[] = [];

  constructor(stdin: NodeJS.WritableStream, stdout: NodeJS.ReadableStream) {
    this.#stdin = stdin;
    this.#stdout = stdout;
    this.#reader = new LineReader(stdout);
    this.#writer = new LineWriter(stdin);
    void this.#run();
  }

  send(cmd: WorkerCommand): void {
    this.#writer.send(cmd);
  }

  onEvent(handler: (event: WorkerEvent) => void): void {
    this.#eventHandler = handler;

    while (this.#pendingEvents.length > 0) {
      const event = this.#pendingEvents.shift();
      if (!event) {
        break;
      }

      this.#dispatchEvent(event);
    }
  }

  close(): void {
    this.#closed = true;
    this.#eventHandler = undefined;
    this.#pendingEvents.length = 0;
    this.#stdin.end();

    const destroyable = this.#stdout as NodeJS.ReadableStream & { destroy?: () => void };
    destroyable.destroy?.();
  }

  async #run(): Promise<void> {
    try {
      for await (const line of this.#reader) {
        if (this.#closed) {
          return;
        }

        const message = decodeMessage(line);
        if (isWorkerCommand(message)) {
          reportProtocolError(
            "WorkerProtocolHost",
            new Error(`Received command on event stream: ${message.type}`),
          );
          continue;
        }

        this.#dispatchEvent(message);
      }
    } catch (error) {
      if (!this.#closed) {
        reportProtocolError("WorkerProtocolHost", error);
      }
    }
  }

  #dispatchEvent(event: WorkerEvent): void {
    if (!this.#eventHandler) {
      this.#pendingEvents.push(event);
      return;
    }

    try {
      this.#eventHandler(event);
    } catch (error) {
      reportProtocolError("WorkerProtocolHost handler", error);
    }
  }
}

export class WorkerProtocolClient {
  readonly #reader: LineReader;
  readonly #writer: LineWriter;
  #commandHandler?: (cmd: WorkerCommand) => void;
  readonly #pendingCommands: WorkerCommand[] = [];

  constructor() {
    this.#reader = new LineReader(process.stdin);
    this.#writer = new LineWriter(process.stdout);
    void this.#run();
  }

  send(event: WorkerEvent): void {
    this.#writer.send(event);
  }

  onCommand(handler: (cmd: WorkerCommand) => void): void {
    this.#commandHandler = handler;

    while (this.#pendingCommands.length > 0) {
      const command = this.#pendingCommands.shift();
      if (!command) {
        break;
      }

      this.#dispatchCommand(command);
    }
  }

  async #run(): Promise<void> {
    try {
      for await (const line of this.#reader) {
        const message = decodeMessage(line);
        if (!isWorkerCommand(message)) {
          reportProtocolError(
            "WorkerProtocolClient",
            new Error(`Received event on command stream: ${message.type}`),
          );
          continue;
        }

        this.#dispatchCommand(message);
      }
    } catch (error) {
      reportProtocolError("WorkerProtocolClient", error);
    }
  }

  #dispatchCommand(command: WorkerCommand): void {
    if (!this.#commandHandler) {
      this.#pendingCommands.push(command);
      return;
    }

    try {
      const maybePromise = this.#commandHandler(command);
      void Promise.resolve(maybePromise).catch((error) => {
        reportProtocolError("WorkerProtocolClient handler", error);
      });
    } catch (error) {
      reportProtocolError("WorkerProtocolClient handler", error);
    }
  }
}
