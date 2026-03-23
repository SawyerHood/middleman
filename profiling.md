# Backend Profiling

This project is easiest to profile by running the built backend directly with Node's profiler enabled. That gives you:

- `.cpuprofile` CPU traces you can inspect in Chrome DevTools
- `.heapprofile` allocation profiles
- `.heapsnapshot` captures on demand
- optional live inspection through the Node inspector

Do not profile `pnpm dev` for backend performance work. The `tsx watch` wrapper and combined frontend/backend process tree will add noise to the samples.

## Build First

From the repo root:

```bash
cd /Users/sawyerhood/middleman
pnpm build
mkdir -p .profiles/backend
```

## Safe Profiling Run

Use an isolated profile data directory when you want clean captures without touching your normal app state:

```bash
MIDDLEMAN_INSTALL_DIR=/Users/sawyerhood/middleman \
MIDDLEMAN_PROJECT_ROOT=/Users/sawyerhood/middleman \
MIDDLEMAN_HOME=/Users/sawyerhood/middleman/.profiles/backend/data \
MIDDLEMAN_PORT=48387 \
node --enable-source-maps \
  --inspect=127.0.0.1:9230 \
  --cpu-prof \
  --cpu-prof-dir=/Users/sawyerhood/middleman/.profiles/backend \
  --heap-prof \
  --heap-prof-dir=/Users/sawyerhood/middleman/.profiles/backend \
  --heapsnapshot-signal=SIGUSR2 \
  apps/backend/dist/index.js
```

If you want to keep it in the background:

```bash
MIDDLEMAN_INSTALL_DIR=/Users/sawyerhood/middleman \
MIDDLEMAN_PROJECT_ROOT=/Users/sawyerhood/middleman \
MIDDLEMAN_HOME=/Users/sawyerhood/middleman/.profiles/backend/data \
MIDDLEMAN_PORT=48387 \
node --enable-source-maps \
  --inspect=127.0.0.1:9230 \
  --cpu-prof \
  --cpu-prof-dir=/Users/sawyerhood/middleman/.profiles/backend \
  --heap-prof \
  --heap-prof-dir=/Users/sawyerhood/middleman/.profiles/backend \
  --heapsnapshot-signal=SIGUSR2 \
  apps/backend/dist/index.js &

echo $! > .profiles/backend/backend.pid
```

## Profile Against the Live Database

If the slowdown only reproduces with your real data, point `MIDDLEMAN_HOME` at your real app home:

```bash
MIDDLEMAN_INSTALL_DIR=/Users/sawyerhood/middleman \
MIDDLEMAN_PROJECT_ROOT=/Users/sawyerhood/middleman \
MIDDLEMAN_HOME=/Users/sawyerhood/.middleman \
MIDDLEMAN_PORT=48387 \
node --enable-source-maps \
  --inspect=127.0.0.1:9230 \
  --cpu-prof \
  --cpu-prof-dir=/Users/sawyerhood/middleman/.profiles/backend \
  --heap-prof \
  --heap-prof-dir=/Users/sawyerhood/middleman/.profiles/backend \
  --heapsnapshot-signal=SIGUSR2 \
  apps/backend/dist/index.js
```

Notes:

- Make sure the normal app is not already using the same DB files.
- The first startup after schema or storage changes may be slower because migrations can run against the live DB.
- Large live datasets can produce large profile artifacts.

## Connect Chrome DevTools

With `--inspect=127.0.0.1:9230` enabled:

1. Open `chrome://inspect`
2. Click `Configure...` and confirm `127.0.0.1:9230` is listed
3. Click `Open dedicated DevTools for Node`

Use:

- `Performance` or `Profiler` to record CPU while reproducing the slowdown
- `Memory` to take heap snapshots

Keep the `--cpu-prof` and `--heap-prof` flags enabled even when using DevTools so you also get files on disk to inspect later.

## Capture Workflow

1. Start the built backend with the profiling flags above.
2. Reproduce the slowdown exactly as you normally hit it.
3. While it is slow, trigger a heap snapshot:

```bash
kill -USR2 "$(cat /Users/sawyerhood/middleman/.profiles/backend/backend.pid)"
```

4. Optional on macOS, capture a sampled stack trace:

```bash
sample "$(cat /Users/sawyerhood/middleman/.profiles/backend/backend.pid)" 10 -file /Users/sawyerhood/middleman/.profiles/backend/backend.sample.txt
```

5. Stop the backend cleanly so Node flushes the profile files:

```bash
kill "$(cat /Users/sawyerhood/middleman/.profiles/backend/backend.pid)"
```

## Artifacts To Save

Collect the files under `/Users/sawyerhood/middleman/.profiles/backend/`, especially:

- `*.cpuprofile`
- `*.heapprofile`
- `*.heapsnapshot`
- `backend.sample.txt`

When sharing a capture for analysis, also include:

- exact repro steps
- how many tabs or clients were connected
- how many managers and workers were active
- whether the run used isolated profile data or the live `~/.middleman` database

## Notes From This Investigation

The capture that led to the backend fixes in this repo used:

- a built backend, not `pnpm dev`
- Node CPU and heap profiling flags
- optional Chrome DevTools attach through the Node inspector
- a macOS `sample` trace for a quick stack snapshot
- direct inspection of the live SQLite database at `/Users/sawyerhood/.middleman/swarmd.db`

That combination was enough to show heavy JSON parsing, allocation pressure, and oversized persisted `agent_tool_call` rows dominating transcript and history work.
