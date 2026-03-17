# Middleman - Agent Notes

## What This Project Is

`middleman` is a local-first multi-agent orchestration platform. It runs:

1. A Node.js backend for manager/worker orchestration and persistence.
2. A TanStack Start + Vite SPA for dashboard, chat, settings, and artifacts.
3. Realtime updates over WebSocket.

## Scope Expectations

This is a **greenfield project** — do not worry about backwards compatibility. Breaking changes to APIs, storage formats, protocols, and UI are fine. Move fast and keep the codebase clean.

For dashboard/chat/settings work, preserve existing behavior and interaction patterns unless the task explicitly requests a redesign.

## Architecture (Current)

### Frontend

- SPA with TanStack Start + Vite in `apps/ui`.
- Real-time client state and transport in `apps/ui/src/lib/ws-client.ts`.
- Core UI surfaces in `apps/ui/src/components/chat/*` and `apps/ui/src/components/settings/*`.

### Backend

- HTTP + WebSocket server in `apps/backend/src/ws/server.ts`.
- Agent orchestration and runtime logic in `apps/backend/src/swarm/*`.
- Scheduler in `apps/backend/src/scheduler/*`.

### Contracts

Canonical wire contracts are defined in:

- `packages/protocol/`

## Run and Test

### Development

```bash
pnpm dev
```

Starts backend + UI in one command (two local ports):

- Backend HTTP + WS: `http://127.0.0.1:47187` / `ws://127.0.0.1:47187`
- UI: `http://127.0.0.1:47188`

### Production

```bash
pnpm prod
```

Default production ports:

- Backend HTTP + WS: `http://127.0.0.1:47287` / `ws://127.0.0.1:47287`
- UI preview: `http://127.0.0.1:47289`

### Useful checks

```bash
pnpm build
pnpm test
pnpm exec tsc --noEmit
```

## Shadcn UI

Use [shadcn/ui](https://ui.shadcn.com/) for shared UI primitives and new component additions. **Always prefer shadcn components over hand-rolled HTML elements.**

Add components from the `apps/ui` directory using the shadcn CLI:

```bash
cd apps/ui
pnpm dlx shadcn@latest add <component-name>
```

For example:

```bash
cd apps/ui
pnpm dlx shadcn@latest add button label switch select tabs separator scroll-area checkbox tooltip textarea
```

**Important:** The `shadcn` CLI must be run from `apps/ui/` (where `components.json` lives), not from the repo root.

Generated components go to `apps/ui/src/components/ui/`. Check available components and usage at https://ui.shadcn.com/docs.

Currently installed: badge, button, card, checkbox, context-menu, dialog, input, label, scroll-area, select, separator, switch, tabs, textarea, tooltip.

## Working Rules for Future Changes

1. Preserve behavior and interaction parity for existing dashboard/chat/settings flows unless a task calls for change.
2. Keep event handling deterministic across live stream and replayed history.
3. Prefer working within existing backend/frontend boundaries instead of introducing broad architectural churn.
4. Validate changes with UI smoke checks (manager creation, chat send/stop, settings updates).
5. Before finishing any task, run the **full CI validation suite** from the repo root and fix any errors:
   ```bash
   pnpm build && pnpm exec tsc --noEmit && pnpm test
   ```
   All three must pass. Do not commit or report completion if any of these fail. CI runs the same checks — if it fails locally, it will fail in CI.
6. Prefer shadcn/ui components over hand-rolled HTML for UI controls and surfaces.
7. Keep panel and view headers consistent by using the shared `ViewHeader` in `apps/ui/src/components/ViewHeader.tsx` for chat/settings/notes-style views. Header shells should stay `h-[62px] mb-2`, place back buttons on the left, and put counts or actions in the trailing slot instead of hand-rolling new variants.
