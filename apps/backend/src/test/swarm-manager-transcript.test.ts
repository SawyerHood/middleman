import { describe, expect, it } from "vitest";

import type { SessionRecord, SwarmdMessage, SwarmdCoreHandle } from "swarmd";

import {
  SwarmTranscriptService,
  projectStoredMessage,
} from "../swarm/swarm-manager-transcript.js";
import type { AgentDescriptor } from "../swarm/types.js";

function makeDescriptor(
  overrides: Partial<AgentDescriptor> & Pick<AgentDescriptor, "agentId" | "managerId" | "role">,
): AgentDescriptor {
  return {
    displayName: overrides.agentId,
    status: "idle",
    createdAt: "2026-03-15T00:00:00.000Z",
    updatedAt: "2026-03-15T00:00:00.000Z",
    cwd: "/tmp/project",
    model: {
      provider: "openai-codex-app-server",
      modelId: "gpt-5.4",
      thinkingLevel: "xhigh",
    },
    ...overrides,
  };
}

function makeSession(
  overrides: Partial<SessionRecord> & Pick<SessionRecord, "id" | "backend" | "status">,
): SessionRecord {
  return {
    displayName: overrides.id,
    cwd: "/tmp/project",
    model: "gpt-5.4",
    metadata: {},
    backendCheckpoint: null,
    createdAt: "2026-03-15T00:00:00.000Z",
    updatedAt: "2026-03-15T00:00:00.000Z",
    lastError: null,
    contextUsage: null,
    ...overrides,
  };
}

function makeMessage(
  overrides: Partial<SwarmdMessage> &
    Pick<SwarmdMessage, "id" | "sessionId" | "source" | "kind" | "role" | "content" | "createdAt">,
): SwarmdMessage {
  return {
    sourceMessageId: null,
    orderKey: `${overrides.createdAt}:${overrides.id}`,
    metadata: {},
    ...overrides,
  };
}

describe("projectStoredMessage", () => {
  it("projects user, system, assistant, speak_to_user, and internal agent messages", () => {
    const userMessage = projectStoredMessage(
      makeMessage({
        id: "user-1",
        sessionId: "manager-1",
        source: "user",
        kind: "text",
        role: "user",
        createdAt: "2026-03-15T00:00:01.000Z",
        content: {
          parts: [{ type: "text", text: "hello manager" }],
        },
        metadata: {
          middleman: {
            renderAs: "conversation_message",
            agentId: "manager-1",
            source: "user_input",
            attachments: [{ type: "text", mimeType: "text/plain", fileName: "note.txt" }],
          },
        },
      }),
    );
    const systemMessage = projectStoredMessage(
      makeMessage({
        id: "system-1",
        sessionId: "manager-1",
        source: "system",
        kind: "text",
        role: "system",
        createdAt: "2026-03-15T00:00:02.000Z",
        content: {
          text: "system notice",
        },
        metadata: {
          middleman: {
            renderAs: "conversation_message",
            agentId: "manager-1",
            source: "system",
          },
        },
      }),
    );
    const assistantMessage = projectStoredMessage(
      makeMessage({
        id: "assistant-1",
        sessionId: "manager-1",
        source: "assistant",
        kind: "text",
        role: "assistant",
        createdAt: "2026-03-15T00:00:03.000Z",
        content: {
          text: "I can help with that.",
        },
        metadata: {
          middleman: {
            agentId: "manager-1",
            sourceContext: { channel: "web" },
          },
        },
      }),
    );
    const speakToUserMessage = projectStoredMessage(
      makeMessage({
        id: "tool-1",
        sessionId: "manager-1",
        source: "tool",
        kind: "tool_result",
        role: "tool",
        createdAt: "2026-03-15T00:00:04.000Z",
        content: {
          toolName: "speak_to_user",
          result: {
            contentItems: [{ type: "inputText", text: "hello from content items" }],
            details: {
              text: "hello from details",
              targetContext: { channel: "slack", channelId: "C123" },
            },
          },
        },
      }),
    );
    const agentMessage = projectStoredMessage(
      makeMessage({
        id: "agent-1",
        sessionId: "worker-1",
        source: "system",
        kind: "text",
        role: "system",
        createdAt: "2026-03-15T00:00:05.000Z",
        content: {
          text: "Investigate the failing test",
        },
        metadata: {
          middleman: {
            visibility: "internal",
            renderAs: "hidden",
            managerId: "manager-1",
            agentId: "worker-1",
            routing: {
              origin: "agent",
              fromAgentId: "manager-1",
              toAgentId: "worker-1",
              requestedDelivery: "steer",
            },
          },
        },
      }),
    );

    expect(userMessage).toEqual({
      type: "conversation_message",
      agentId: "manager-1",
      role: "user",
      text: "hello manager",
      attachments: [{ type: "text", mimeType: "text/plain", fileName: "note.txt" }],
      timestamp: "2026-03-15T00:00:01.000Z",
      source: "user_input",
      sourceContext: undefined,
    });
    expect(systemMessage).toEqual({
      type: "conversation_message",
      agentId: "manager-1",
      role: "system",
      text: "system notice",
      attachments: undefined,
      timestamp: "2026-03-15T00:00:02.000Z",
      source: "system",
      sourceContext: undefined,
    });
    expect(assistantMessage).toEqual({
      type: "conversation_message",
      agentId: "manager-1",
      role: "assistant",
      text: "I can help with that.",
      timestamp: "2026-03-15T00:00:03.000Z",
      source: "system",
      sourceContext: { channel: "web" },
    });
    expect(speakToUserMessage).toEqual({
      type: "conversation_message",
      agentId: "manager-1",
      role: "assistant",
      text: "hello from details",
      timestamp: "2026-03-15T00:00:04.000Z",
      source: "speak_to_user",
      sourceContext: { channel: "slack", channelId: "C123" },
    });
    expect(agentMessage).toEqual({
      type: "agent_message",
      agentId: "manager-1",
      timestamp: "2026-03-15T00:00:05.000Z",
      source: "agent_to_agent",
      fromAgentId: "manager-1",
      toAgentId: "worker-1",
      text: "Investigate the failing test",
      requestedDelivery: "steer",
    });
  });

  it("projects replayable runtime logs, tool calls, and assistant attachments", () => {
    const runtimeLog = projectStoredMessage(
      makeMessage({
        id: "log-1",
        sessionId: "worker-1",
        source: "system",
        kind: "middleman_event",
        role: "system",
        createdAt: "2026-03-15T00:00:06.000Z",
        content: { text: "tool started" },
        metadata: {
          middleman: {
            renderAs: "conversation_log",
            event: {
              agentId: "worker-1",
              timestamp: "2026-03-15T00:00:06.000Z",
              kind: "message_start",
              text: "tool started",
            },
          },
        },
      }),
    );
    const toolCall = projectStoredMessage(
      makeMessage({
        id: "tool-call-1",
        sessionId: "worker-1",
        source: "system",
        kind: "middleman_event",
        role: "system",
        createdAt: "2026-03-15T00:00:07.000Z",
        content: { text: "{\"ok\":true}" },
        metadata: {
          middleman: {
            renderAs: "agent_tool_call",
            event: {
              agentId: "worker-1",
              actorAgentId: "worker-1",
              timestamp: "2026-03-15T00:00:07.000Z",
              kind: "tool_execution_end",
              toolName: "spawn_agent",
              toolCallId: "call-1",
              text: "{\"ok\":true}",
            },
          },
        },
      }),
    );
    const assistantWithAttachment = projectStoredMessage(
      makeMessage({
        id: "assistant-attachment-1",
        sessionId: "worker-1",
        source: "assistant",
        kind: "text",
        role: "assistant",
        createdAt: "2026-03-15T00:00:08.000Z",
        content: {
          parts: [
            { type: "text", text: "Here is the diagram." },
            { type: "image", mimeType: "image/png", data: "ZmFrZQ==" },
          ],
        },
      }),
    );

    expect(runtimeLog).toEqual({
      type: "conversation_log",
      agentId: "worker-1",
      timestamp: "2026-03-15T00:00:06.000Z",
      source: "runtime_log",
      kind: "message_start",
      role: undefined,
      toolName: undefined,
      toolCallId: undefined,
      text: "tool started",
      isError: undefined,
    });
    expect(toolCall).toEqual({
      type: "agent_tool_call",
      agentId: "worker-1",
      actorAgentId: "worker-1",
      timestamp: "2026-03-15T00:00:07.000Z",
      kind: "tool_execution_end",
      toolName: "spawn_agent",
      toolCallId: "call-1",
      text: "{\"ok\":true}",
      isError: undefined,
    });
    expect(assistantWithAttachment).toEqual({
      type: "conversation_message",
      agentId: "worker-1",
      role: "assistant",
      text: "Here is the diagram.",
      attachments: [{ type: "image", mimeType: "image/png", fileName: undefined, filePath: undefined }],
      timestamp: "2026-03-15T00:00:08.000Z",
      source: "system",
      sourceContext: undefined,
    });
  });

  it("falls back to contentItems for speak_to_user and ignores unsupported rows", () => {
    const projected = projectStoredMessage(
      makeMessage({
        id: "tool-2",
        sessionId: "manager-1",
        source: "tool",
        kind: "tool_result",
        role: "tool",
        createdAt: "2026-03-15T00:00:06.000Z",
        content: {
          toolName: "speak_to_user",
          result: {
            contentItems: [{ type: "inputText", text: "fallback text" }],
          },
        },
      }),
    );

    expect(projected).toEqual({
      type: "conversation_message",
      agentId: "manager-1",
      role: "assistant",
      text: "fallback text",
      timestamp: "2026-03-15T00:00:06.000Z",
      source: "speak_to_user",
      sourceContext: undefined,
    });
    expect(
      projectStoredMessage(
        makeMessage({
          id: "tool-3",
          sessionId: "manager-1",
          source: "tool",
          kind: "tool_result",
          role: "tool",
          createdAt: "2026-03-15T00:00:07.000Z",
          content: { toolName: "spawn_agent", result: { ok: true } },
        }),
      ),
    ).toBeNull();
    expect(
      projectStoredMessage(
        makeMessage({
          id: "assistant-2",
          sessionId: "manager-1",
          source: "assistant",
          kind: "text",
          role: "assistant",
          createdAt: "2026-03-15T00:00:08.000Z",
          content: {},
        }),
      ),
    ).toBeNull();
    expect(
      projectStoredMessage(
        makeMessage({
          id: "suppressed-log",
          sessionId: "worker-1",
          source: "system",
          kind: "middleman_event",
          role: "system",
          createdAt: "2026-03-15T00:00:09.000Z",
          content: { text: "ignored" },
          metadata: {
            middleman: {
              suppressed: true,
              renderAs: "conversation_log",
              event: {
                agentId: "worker-1",
                timestamp: "2026-03-15T00:00:09.000Z",
                kind: "message_end",
                text: "ignored",
                isError: true,
              },
            },
          },
        }),
      ),
    ).toBeNull();
  });
});

describe("SwarmTranscriptService", () => {
  it("projects full history while visible transcript hides internal deliveries", () => {
    const manager = makeDescriptor({
      agentId: "manager-1",
      managerId: "manager-1",
      role: "manager",
      status: "errored",
    });
    const session = makeSession({
      id: "manager-1",
      backend: "codex",
      status: "errored",
      updatedAt: "2026-03-15T00:00:06.000Z",
      lastError: {
        code: "RUNTIME_FAILED",
        message: "runtime exploded",
        retryable: false,
      },
    });
    const messages = [
      makeMessage({
        id: "message-1",
        sessionId: "manager-1",
        source: "user",
        kind: "text",
        role: "user",
        createdAt: "2026-03-15T00:00:01.000Z",
        content: { text: "hello" },
        metadata: {
          middleman: {
            renderAs: "conversation_message",
            agentId: "manager-1",
            source: "user_input",
          },
        },
      }),
      makeMessage({
        id: "message-2",
        sessionId: "manager-1",
        source: "assistant",
        kind: "text",
        role: "assistant",
        createdAt: "2026-03-15T00:00:02.000Z",
        content: { text: "working on it" },
      }),
      makeMessage({
        id: "message-3",
        sessionId: "manager-1",
        source: "system",
        kind: "text",
        role: "system",
        createdAt: "2026-03-15T00:00:03.000Z",
        content: { text: "delegate to worker" },
        metadata: {
          middleman: {
            visibility: "internal",
            renderAs: "hidden",
            managerId: "manager-1",
            agentId: "worker-1",
            routing: {
              origin: "agent",
              fromAgentId: "manager-1",
              toAgentId: "worker-1",
              requestedDelivery: "auto",
            },
          },
        },
      }),
    ];
    const transcript = new SwarmTranscriptService({
      getCore: () =>
        ({
          sessionService: {
            getById: () => session,
            list: () => [session],
          },
          messageStore: {
            list: () => messages,
          },
        }) as unknown as SwarmdCoreHandle,
      getAgent: (agentId) => (agentId === "manager-1" ? manager : undefined),
      resolvePreferredManagerId: () => "manager-1",
      resolveRuntimeErrorMessage: () => "runtime exploded",
    });

    expect(transcript.projectConversationEntries("manager-1")).toEqual([
      expect.objectContaining({
        type: "conversation_message",
        text: "hello",
      }),
      expect.objectContaining({
        type: "conversation_message",
        text: "working on it",
      }),
      expect.objectContaining({
        type: "agent_message",
        text: "delegate to worker",
      }),
      expect.objectContaining({
        type: "conversation_log",
        text: "runtime exploded",
        isError: true,
      }),
    ]);

    expect(transcript.getVisibleTranscript("manager-1")).toEqual([
      expect.objectContaining({
        type: "conversation_message",
        text: "hello",
      }),
      expect.objectContaining({
        type: "conversation_message",
        text: "working on it",
      }),
      expect.objectContaining({
        type: "agent_message",
        text: "delegate to worker",
      }),
      expect.objectContaining({
        type: "conversation_log",
        text: "runtime exploded",
        isError: true,
      }),
    ]);
  });

  it("replays manager internal chatter from related sessions into manager history", () => {
    const manager = makeDescriptor({
      agentId: "manager-1",
      managerId: "manager-1",
      role: "manager",
    });
    const otherManager = makeDescriptor({
      agentId: "manager-2",
      managerId: "manager-2",
      role: "manager",
    });
    const worker = makeDescriptor({
      agentId: "worker-1",
      managerId: "manager-1",
      role: "worker",
    });
    const managerSession = makeSession({
      id: "manager-1",
      backend: "codex",
      status: "idle",
    });
    const otherManagerSession = makeSession({
      id: "manager-2",
      backend: "codex",
      status: "idle",
    });
    const workerSession = makeSession({
      id: "worker-1",
      backend: "codex",
      status: "idle",
    });
    const messagesBySession = new Map<string, SwarmdMessage[]>([
      [
        managerSession.id,
        [
          makeMessage({
            id: "manager-user",
            sessionId: "manager-1",
            source: "user",
            kind: "text",
            role: "user",
            createdAt: "2026-03-15T00:00:01.000Z",
            content: { text: "hello" },
            metadata: {
              middleman: {
                renderAs: "conversation_message",
                agentId: "manager-1",
                source: "user_input",
              },
            },
          }),
        ],
      ],
      [
        workerSession.id,
        [
          makeMessage({
            id: "manager-to-worker",
            sessionId: "worker-1",
            source: "system",
            kind: "text",
            role: "system",
            createdAt: "2026-03-15T00:00:02.000Z",
            content: { text: "Investigate the test failure" },
            metadata: {
              middleman: {
                visibility: "internal",
                renderAs: "hidden",
                managerId: "manager-1",
                agentId: "worker-1",
                routing: {
                  origin: "agent",
                  fromAgentId: "manager-1",
                  toAgentId: "worker-1",
                  requestedDelivery: "auto",
                },
              },
            },
          }),
        ],
      ],
      [
        otherManagerSession.id,
        [
          makeMessage({
            id: "manager-to-manager",
            sessionId: "manager-2",
            source: "system",
            kind: "text",
            role: "system",
            createdAt: "2026-03-15T00:00:03.000Z",
            content: { text: "Can you take over the deploy?" },
            metadata: {
              middleman: {
                visibility: "internal",
                renderAs: "hidden",
                managerId: "manager-2",
                agentId: "manager-2",
                routing: {
                  origin: "agent",
                  fromAgentId: "manager-1",
                  toAgentId: "manager-2",
                  requestedDelivery: "steer",
                },
              },
            },
          }),
        ],
      ],
    ]);

    const transcript = new SwarmTranscriptService({
      getCore: () =>
        ({
          sessionService: {
            getById: (sessionId: string) =>
              [managerSession, otherManagerSession, workerSession].find((session) => session.id === sessionId) ?? null,
            list: () => [managerSession, otherManagerSession, workerSession],
          },
          messageStore: {
            list: (sessionId: string) => messagesBySession.get(sessionId) ?? [],
          },
        }) as unknown as SwarmdCoreHandle,
      getAgent: (agentId) =>
        [manager, otherManager, worker].find((descriptor) => descriptor.agentId === agentId),
      resolvePreferredManagerId: () => "manager-1",
      resolveRuntimeErrorMessage: () => "ignored",
    });

    const projectedEntries = transcript.projectConversationEntries("manager-1");
    const managerAgentMessages = projectedEntries.filter((entry) => entry.type === "agent_message");

    expect(managerAgentMessages).toEqual([
      expect.objectContaining({
        agentId: "manager-1",
        fromAgentId: "manager-1",
        toAgentId: "worker-1",
        text: "Investigate the test failure",
      }),
      expect.objectContaining({
        agentId: "manager-1",
        fromAgentId: "manager-1",
        toAgentId: "manager-2",
        text: "Can you take over the deploy?",
      }),
    ]);

    expect(transcript.getVisibleTranscript("manager-1")).toEqual([
      expect.objectContaining({
        type: "conversation_message",
        text: "hello",
      }),
      expect.objectContaining({
        type: "agent_message",
        text: "Investigate the test failure",
      }),
      expect.objectContaining({
        type: "agent_message",
        text: "Can you take over the deploy?",
      }),
    ]);
  });

  it("limits transcript results to the most recent entries and handles missing sessions", () => {
    const worker = makeDescriptor({
      agentId: "worker-1",
      managerId: "manager-1",
      role: "worker",
    });
    const session = makeSession({
      id: "worker-1",
      backend: "codex",
      status: "idle",
    });
    const messages = [
      makeMessage({
        id: "entry-1",
        sessionId: "worker-1",
        source: "user",
        kind: "text",
        role: "user",
        createdAt: "2026-03-15T00:00:01.000Z",
        content: { text: "first" },
        metadata: { middleman: { renderAs: "conversation_message" } },
      }),
      makeMessage({
        id: "entry-2",
        sessionId: "worker-1",
        source: "assistant",
        kind: "text",
        role: "assistant",
        createdAt: "2026-03-15T00:00:02.000Z",
        content: { text: "second" },
      }),
      makeMessage({
        id: "entry-3",
        sessionId: "worker-1",
        source: "assistant",
        kind: "text",
        role: "assistant",
        createdAt: "2026-03-15T00:00:03.000Z",
        content: { text: "third" },
      }),
    ];

    const transcript = new SwarmTranscriptService({
      getCore: () =>
        ({
          sessionService: {
            getById: (sessionId: string) => (sessionId === "worker-1" ? session : null),
            list: () => [session],
          },
          messageStore: {
            list: () => messages,
          },
        }) as unknown as SwarmdCoreHandle,
      getAgent: (agentId) => (agentId === "worker-1" ? worker : undefined),
      resolvePreferredManagerId: () => undefined,
      resolveRuntimeErrorMessage: () => "ignored",
    });

    expect(
      transcript.projectConversationEntries("worker-1", 2).map((entry) =>
        entry.type === "conversation_message" ? entry.text : "",
      ),
    ).toEqual(["second", "third"]);
    expect(transcript.projectConversationEntries("missing")).toEqual([]);
    expect(transcript.getVisibleTranscript("missing")).toEqual([]);
  });
});
