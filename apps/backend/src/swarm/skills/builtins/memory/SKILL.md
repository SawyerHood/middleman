---
name: memory
description: Update persistent swarm memory in ${SWARM_MEMORY_FILE} when the user explicitly asks to remember, update, or forget durable information.
---

# Persistent Memory Workflow

Use this skill when the user explicitly asks to:

- remember something for later,
- update previously remembered facts/preferences, or
- forget/remove stored memory entries.

Do not write memory for normal one-off requests.

## File location

- Persistent memory files are stored at `${SWARM_DATA_DIR}/memory/<agentId>.md`.
- In this runtime, use `${SWARM_MEMORY_FILE}` (also shown in your loaded context).

## Steps

1. Read the current memory file with `read` before changing it.
2. Apply minimal edits:
   - prefer `edit` for targeted changes,
   - use `write` only for full rewrites.
3. Keep entries concise, factual, and durable.
4. Never store secrets (passwords, API keys, tokens, private keys) or highly sensitive personal data.
5. If the request is ambiguous, ask a clarifying question before writing.
6. After updating memory:
   - manager: confirm the update to the user via `speak_to_user`,
   - worker: report the update back to the manager via `send_message_to_agent`.
