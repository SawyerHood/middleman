# @middleman/ui

`@middleman/ui` is the Middleman web app built with TanStack Start, Vite, and React.

## What it contains

- Dashboard and agent sidebar
- Chat thread UI with streaming updates
- Composer with file attachments
- Settings surfaces (auth, skills, environment variables)

## Scripts

Run from repo root:

```bash
pnpm --filter @middleman/ui dev
pnpm --filter @middleman/ui build
pnpm --filter @middleman/ui preview
pnpm --filter @middleman/ui test
```

## Local runtime

- UI dev server default: `http://127.0.0.1:47188`
- Backend WS target default: `ws://127.0.0.1:47187`

For full-stack local development, use `pnpm dev` from the repo root to run backend and UI together.
