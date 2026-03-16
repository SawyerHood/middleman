# swarmd

`swarmd` is the embedded runtime core used by middleman.

It exposes a JavaScript API only:

- `createCore(...)`
- session, message, and operation services
- the event bus
- runtime adapter/types for Codex, Claude, and PI backends

It does not ship HTTP, WebSocket, or SSE transport.

## Example

```ts
import { createCore } from "swarmd";

const core = await createCore({
  dataDir: "/tmp/swarmd",
  dbPath: "/tmp/swarmd/swarmd.db",
});

const session = core.sessionService.create({
  backend: "codex",
  cwd: process.cwd(),
  displayName: "manager",
});

await core.sessionService.start(session.id);
await core.shutdown();
```
