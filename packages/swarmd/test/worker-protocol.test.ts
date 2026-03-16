import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  LineReader,
  LineWriter,
  decodeMessage,
  encodeMessage,
} from "../src/core/supervisor/worker-protocol.js";
import type { WorkerCommand, WorkerEvent } from "../src/core/types/index.js";

describe("worker protocol", () => {
  it("round-trips commands and events through the JSONL codec", () => {
    const command: WorkerCommand = { type: "ping" };
    const event: WorkerEvent = {
      type: "session_status",
      status: "errored",
      error: {
        code: "RUNTIME_FAILED",
        message: "Worker exited before ready.",
        retryable: true,
      },
      contextUsage: {
        tokens: 512,
        contextWindow: 1_048_576,
        percent: 0.0488,
      },
    };

    expect(decodeMessage(encodeMessage(command))).toEqual(command);
    expect(decodeMessage(encodeMessage(event))).toEqual(event);
  });

  it("round-trips explicit context-usage clears", () => {
    const event: WorkerEvent = {
      type: "session_status",
      status: "idle",
      contextUsage: null,
    };

    expect(decodeMessage(encodeMessage(event))).toEqual(event);
  });

  it("reads complete lines from a chunked readable stream", async () => {
    const stream = new PassThrough();
    const reader = new LineReader(stream);

    const linesPromise = (async () => {
      const lines: string[] = [];
      for await (const line of reader) {
        lines.push(line);
      }
      return lines;
    })();

    stream.write('{"type":"ping"}\n{"type":"pong');
    stream.end('"}\r\n{"type":"ping"}');

    await expect(linesPromise).resolves.toEqual([
      '{"type":"ping"}',
      '{"type":"pong"}',
      '{"type":"ping"}',
    ]);
  });

  it("writes JSONL messages to a writable stream", () => {
    const stream = new PassThrough();
    const chunks: string[] = [];
    stream.on("data", (chunk) => {
      chunks.push(chunk.toString());
    });

    const writer = new LineWriter(stream);
    writer.send({ type: "ping" });
    writer.send({ type: "pong" });

    expect(chunks.join("")).toBe('{"type":"ping"}\n{"type":"pong"}\n');
  });
});
