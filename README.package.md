# Middleman

Middleman is a local-first multi-agent orchestration app you can start directly from npm.

## Quick Start

```bash
npx middleman
```

That starts one local server, serves the built dashboard UI from the same origin, and stores runtime state in `~/.middleman` by default.

## Useful Commands

```bash
middleman start --project /path/to/repo --port 48100 --no-open
middleman schedule list
middleman image generate --prompt "..." --output /tmp/output.png
middleman brave-search search "query"
```

## Configuration

- `MIDDLEMAN_HOME` overrides the default data directory (`~/.middleman`)
- `MIDDLEMAN_PROJECT_ROOT` overrides the default project root (current working directory)
- `MIDDLEMAN_HOST` and `MIDDLEMAN_PORT` override the bind address

The app also loads environment variables from:

- `<projectRoot>/.env`
- `~/.middleman/config.env`
