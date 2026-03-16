#!/usr/bin/env node
import { createInterface } from "node:readline";

const threadId = "thr_fake_1";
let turnCounter = 0;

const reader = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ id, result });
}

function sendError(id, code, message) {
  send({
    id,
    error: {
      code,
      message,
    },
  });
}

function notify(method, params) {
  send({
    method,
    ...(params === undefined ? {} : { params }),
  });
}

function extractText(items) {
  if (!Array.isArray(items)) {
    return "";
  }

  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }

    if (item.type === "text" && typeof item.text === "string") {
      return item.text;
    }
  }

  return "";
}

function scheduleTurn(turnId, inputText) {
  const replyText = inputText.toLowerCase().includes("hello")
    ? "hello from fake codex"
    : `echo: ${inputText}`;
  const messageId = `msg-${turnId}`;

  setTimeout(() => {
    notify("thread/status/changed", {
      threadId,
      status: { type: "active", activeFlags: [] },
    });
  }, 5);

  setTimeout(() => {
    notify("turn/started", {
      threadId,
      turn: { id: turnId, status: "inProgress" },
    });
  }, 10);

  setTimeout(() => {
    notify("item/started", {
      threadId,
      turnId,
      item: {
        type: "agentMessage",
        id: messageId,
        text: "",
        phase: null,
      },
    });
  }, 15);

  setTimeout(() => {
    notify("item/agentMessage/delta", {
      threadId,
      turnId,
      itemId: messageId,
      delta: replyText,
    });
  }, 20);

  setTimeout(() => {
    notify("item/completed", {
      threadId,
      turnId,
      item: {
        type: "agentMessage",
        id: messageId,
        text: replyText,
        phase: "completed",
      },
    });
  }, 25);

  setTimeout(() => {
    notify("turn/completed", {
      threadId,
      turn: { id: turnId, status: "completed" },
    });
  }, 30);

  setTimeout(() => {
    notify("thread/status/changed", {
      threadId,
      status: { type: "idle" },
    });
  }, 35);
}

reader.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return;
  }

  const message = JSON.parse(trimmed);
  const { id, method, params } = message;

  switch (method) {
    case "initialize":
      sendResult(id, {});
      return;
    case "initialized":
      return;
    case "thread/start":
    case "thread/create":
    case "thread/resume":
    case "thread/fork":
      sendResult(id, {
        thread: {
          id: threadId,
          status: { type: "idle" },
          turns: [],
        },
      });
      notify("thread/started", {
        thread: {
          id: threadId,
          status: { type: "idle" },
        },
      });
      return;
    case "turn/start": {
      const turnId = `turn-${++turnCounter}`;
      sendResult(id, {
        turn: {
          id: turnId,
        },
      });
      scheduleTurn(turnId, extractText(params?.input));
      return;
    }
    case "turn/steer":
    case "turn/interrupt":
      sendResult(id, {});
      return;
    default:
      sendError(id, -32601, `Method not found: ${method}`);
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});
