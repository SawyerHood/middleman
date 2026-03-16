# AGENTS.md

Guidance for AI agents working in this repository.

## Stack

- TypeScript
- ESM modules
- Node.js 22+
- Fastify for HTTP transport and realtime registration
- `better-sqlite3` for persistence
- Vitest for tests

## Architecture Guardrails

- `swarmd` is a standalone server that normalizes Codex, Claude, and Pi behind one northbound API.
- Persistence lives in SQLite. Keep database schema, migration SQL, and repository column names in `snake_case`.
- Keep TypeScript types, service APIs, and HTTP payloads in `camelCase`.
- The event bus is in-memory only. Do not design features that depend on a persisted event log or replay store.
- Worker processes communicate with the supervisor using JSONL over stdio. Preserve newline-delimited message framing and typed protocol validation.
- Backend adapters must remain optional. Use dynamic imports for backend SDKs and avoid adding hard dependencies on backend-specific packages.

## Working Rules

- Run `npx tsc --noEmit` and `npx vitest --run` before committing.
- Keep HTTP route behavior aligned with the service layer in `src/core/services`.
- Keep backend-specific logic inside `src/runtime/*` adapters and shared protocol logic inside `src/core/supervisor`.
- If you touch persistence code, preserve the DB convention of `snake_case` columns mapped to `camelCase` TypeScript objects.
- If you touch Claude or Pi integrations, preserve the current dynamic import pattern so consumers can install only the backends they use.
