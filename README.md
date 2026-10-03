# Orchestrator

Command-line toolkit used by a scheduled Claude cloud routine (a personal assistant) that:

- **collects tasks** from flagged sources (Gmail `todo` label in two mailboxes, a Slack channel, `TODO` lines in Google Docs) into a Google Sheet task list, with AI de-duplication;
- **supports an hourly briefing**: task plan and triage memory, inbox overviews, weather, and a small feed for a home-screen widget.

The routine's agent calls `node src/cli.js <command>`; every command prints JSON or text.

## Design principle: zero private data in this repo

This repository contains only generic code. Every deployment-specific or personal value is supplied at runtime through environment variables, never hardcoded:

| Env var | Purpose |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Service-account key (raw JSON or base64) for Sheets/Docs |
| `SPREADSHEET_ID` | Target Google Sheet id |
| `GOOGLE_DOCS` | Docs to scan for `TODO` lines (optional) |
| `GMAIL2_CLIENT_ID` / `GMAIL2_CLIENT_SECRET` / `GMAIL2_REFRESH_TOKEN` | Second (private) mailbox (optional) |
| `TASKS_TAB` / `LOG_TAB` | Tab-name overrides (optional) |

No dependencies: `src/google.js` is a small REST client on Node built-ins, so the cloud environment only needs to download the files in `src/`.

## Layout

| File | Purpose |
|---|---|
| `src/cli.js` | All commands (run without arguments for the list) |
| `src/sheets.js` | Task sheet read/write, logging, tab helpers |
| `src/docs.js` | Google Docs `TODO` scanning and marking |
| `src/gmail2.js` | Private mailbox: todo scan, inbox overview, threads, archive, drafts (never sends) |
| `src/google.js` | Zero-dependency Google API client |
| `src/config.js` | Environment configuration |

## Commands

- Tasks: `context`, `brief`, `plan`, `show`, `match`, `upsert`, `delete`
- Sources: `docs-scan`, `docs-mark`, `gmail2-scan`, `gmail2-relabel`, `gmail2-inbox`, `gmail2-thread`, `gmail2-archive`, `gmail2-draft`
- Assistant: `state-get`, `state-set`, `state-append`, `state-prune`, `triage-queue`, `triage-set`, `weather`, `widget-set`, `log`
