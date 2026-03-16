import type { EventEnvelope } from "../types/index.js";

type EventHandler = (event: EventEnvelope) => void;

export class EventBus {
  private handlers = new Set<EventHandler>();

  publish<TPayload>(event: EventEnvelope<TPayload>): EventEnvelope<TPayload> {
    for (const handler of [...this.handlers]) {
      handler(event);
    }

    return event;
  }

  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler);

    return () => {
      this.handlers.delete(handler);
    };
  }

  get subscriberCount(): number {
    return this.handlers.size;
  }
}
