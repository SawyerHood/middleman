import { describe, expect, it } from "vitest";

import { EventBus, type EventEnvelope } from "../src/index.js";

function createEvent(id: string, type = "message.started"): EventEnvelope {
  return {
    id,
    cursor: null,
    sessionId: "session-1",
    threadId: "thread-1",
    timestamp: "2026-03-13T00:02:00.000Z",
    type,
    source: "server",
    payload: { messageId: id },
  };
}

describe("EventBus", () => {
  it("publishes the same in-memory event to subscribers", () => {
    const eventBus = new EventBus();
    const event = createEvent("event-1");
    let receivedEvent: EventEnvelope | null = null;

    eventBus.subscribe((publishedEvent) => {
      receivedEvent = publishedEvent;
    });

    const publishedEvent = eventBus.publish(event);

    expect(publishedEvent).toBe(event);
    expect(receivedEvent).toBe(event);
  });

  it("broadcasts published events to all subscribers", () => {
    const eventBus = new EventBus();
    const received: string[] = [];

    eventBus.subscribe((event) => {
      received.push(`first:${event.id}`);
    });
    eventBus.subscribe((event) => {
      received.push(`second:${event.id}`);
    });

    eventBus.publish(createEvent("event-2", "tool.completed"));

    expect(received).toEqual(["first:event-2", "second:event-2"]);
  });

  it("supports unsubscribe", () => {
    const eventBus = new EventBus();
    const receivedEvents: EventEnvelope[] = [];

    const unsubscribe = eventBus.subscribe((event) => {
      receivedEvents.push(event);
    });

    expect(eventBus.subscriberCount).toBe(1);
    unsubscribe();
    expect(eventBus.subscriberCount).toBe(0);

    eventBus.publish(createEvent("event-3", "message.completed"));

    expect(receivedEvents).toEqual([]);
  });
});
