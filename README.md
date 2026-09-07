# Task Orchestrator

An AI-driven, autonomous orchestrator that turns items from connected sources
(Gmail first; Slack / Calendar / Docs later) into well-formed tasks in a Google
Sheet — running nightly as a cloud routine, in parallel to a separate task UI.

## Design principle: zero private data in this repo

This repository contains **only generic code**. Every deployment-specific or personal
identifier is supplied at runtime via **environment variables** — never hardcoded:

| Env var | Purpose |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Service-account key (raw JSON or base64) for Sheets read/write |
| `SPREADSHEET_ID` | Target Google Sheet id |
| `SLACK_DM_CHANNEL` | Slack channel/user id for the run-report DM |
| `TASKS_TAB` / `STAGING_TAB` / `STATE_TAB` | Optional tab-name overrides |

Future sources (additional mailboxes, chats, docs) will be configured the same way,
so **no mailbox addresses, channel ids, or document links ever live in the code.**

## How it runs

A cloud routine fires on a schedule with the user's MCP connectors attached
(no laptop, no standing server):

```
  ├─ READ inbox             Gmail MCP (search_threads / get_thread)
  ├─ ENRICH                 the routine's own model (title, importance/urgency/effort, label)
  ├─ READ + WRITE the Sheet Google Sheets API via a service account
  ├─ ARCHIVE handled mail   Gmail MCP (unlabel INBOX) — only once a live task exists
  └─ RUN-REPORT             Slack DM (Gmail MCP cannot send email)
```

AI-drafted tasks land in a `Staging` tab for review; only approved rows are promoted
to the live `Tasks` tab (and the source archived).

## Layout

- `orchestrator/src/sheets.js` — service-account Sheets client (read/write, tab management)
- `orchestrator/src/cli.js` — agent-facing CLI: `context` (read state) and `stage-draft`
- `orchestrator/src/read.js` / `write.js` — local smoke tests
- `orchestrator/ROUTINE_PROMPT.md` — the routine's orchestration instructions

## Security

- No credentials and no personal data in the repo. Config is injected via environment variables.
- The service account is scoped to a single Google Sheet and is revocable at any time.
