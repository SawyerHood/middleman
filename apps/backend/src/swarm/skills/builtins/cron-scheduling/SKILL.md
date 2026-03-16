---
name: cron-scheduling
description: Create, list, and remove persistent scheduled tasks using cron expressions.
---

# Cron Scheduling

Use this skill when the user asks to schedule, reschedule, or cancel reminders/tasks for later.

Before creating a schedule, confirm:
- exact schedule timing (cron expression),
- timezone (IANA, for example `America/Los_Angeles`),
- task message content.

If the request is ambiguous, ask a follow-up question before adding a schedule.

## Commands

Use the embedded CLI. It talks to the backend schedule service and stores schedules in SQLite.

```bash
middleman schedule add \
  --cron "0 9 * * 1-5" \
  --message "Remind me about the daily standup" \
  --description "Daily standup reminder" \
  --timezone "America/Los_Angeles"
```

One-shot schedule (fires once at the next matching cron time):

```bash
middleman schedule add \
  --cron "30 14 * * *" \
  --message "Check deployment status" \
  --description "One-time deployment check" \
  --timezone "America/Los_Angeles" \
  --one-shot
```

Remove a schedule:

```bash
middleman schedule remove \
  "<schedule-id>"
```

List schedules:

```bash
middleman schedule list
```

Override manager context manually when needed:

```bash
middleman schedule list --manager "manager"
```

## Output

All commands return JSON:
- Success: `{ "ok": true, ... }`
- Failure: `{ "ok": false, "error": "..." }`
