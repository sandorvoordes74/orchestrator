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
| `GOOGLE_DOCS` | Docs to scan for `TODO` lines, all tabs (optional) |
| `PA_LISTS_SHEET` / `PA_LISTS_TABS` | Personal lists sheet and the only tabs the assistant may read (optional) |
| `TOMTOM_API_KEY` / `PA_HOME` | Live road traffic for planned drives (free TomTom developer key; home address for the alias `home`) (optional) |
| `DOCS_SKIP_TABS` | Comma-separated tab titles the TODO scan skips (optional; the facts tab and tabs that look like passwords/keys are always skipped) |
| `PA_FACTS_DOC` / `PA_FACTS_TAB` | Doc and tab with background facts for the assistant (optional; default: first `GOOGLE_DOCS` doc, tab `PA`) |
| `GMAIL2_CLIENT_ID` / `GMAIL2_CLIENT_SECRET` / `GMAIL2_REFRESH_TOKEN` | Second (private) mailbox (optional) |
| `SKODA_API_KEY` / `SKODA_VIN` | Car via the official MyŠkoda public API: key created in the MyŠkoda app (optional) |
| `HOMEY_CLIENT_ID` / `HOMEY_CLIENT_SECRET` / `HOMEY_REFRESH_TOKEN` / `HOMEY_TOKEN_KEY` | Smart home via the Homey MCP server, created by `scripts/homey-login.js` (optional) |
| `TADO_REFRESH_TOKEN` / `TADO_TOKEN_KEY` | Heating and presence via tado, created by `scripts/tado-login.js` (optional) |
| `NS_API_KEY` | Train trips and disruptions via the NS API (free 'Ns-App' product on apiportal.ns.nl; optional) |
| `TASKS_TAB` / `LOG_TAB` | Tab-name overrides (optional) |

No dependencies: `src/google.js` is a small REST client on Node built-ins, so the cloud environment only needs to download the files in `src/`.

## Layout

| File | Purpose |
|---|---|
| `src/cli.js` | All commands (run without arguments for the list) |
| `src/sheets.js` | Task sheet read/write, logging, tab helpers |
| `src/docs.js` | Google Docs `TODO` scanning and marking |
| `src/gmail2.js` | Private mailbox: todo scan, inbox overview, threads, archive, drafts (never sends) |
| `src/car.js` | Car status and remote commands via the MyŠkoda public API |
| `src/traffic.js` | Live road traffic via the TomTom Routing API |
| `src/lists.js` | Read-only personal lists sheet, limited to an allow-list of tabs |
| `src/homey.js` | Smart home via Athom's Homey MCP server (OAuth refresh, encrypted token cache, minimal MCP client) |
| `src/tado.js` | Heating, home/away and who is home via tado's REST API (independent of Homey) |
| `src/ov.js` | Public transport: NS train trips and disruptions, live bus/tram departures (OVapi) |
| `scripts/homey-login.js` | One-time local Homey sign-in; writes the env vars to the git-ignored `.env.homey` |
| `src/google.js` | Zero-dependency Google API client |
| `src/config.js` | Environment configuration |

## Commands

- Tasks: `context`, `brief`, `plan`, `show`, `match`, `upsert`, `delete`
- Sources: `docs-scan`, `docs-mark`, `gmail2-scan`, `gmail2-relabel`, `gmail2-inbox`, `gmail2-thread`, `gmail2-archive`, `gmail2-draft`
- Assistant: `traffic '<from|home>' '<to>' [now|HH:MM|tomorrow HH:MM|YYYY-MM-DD HH:MM]` (live travel time, delay and jams; local time), `lists [tab]` (read-only personal lists, allowed tabs only), `facts` (background facts from the doc tab), `facts-add '{"section":...,"fact":...[,"replaces":"<part of the old fact>"]}'`, `facts-remove '<part of one fact>'`, `state-get`, `state-set`, `state-append`, `state-prune`, `triage-queue`, `triage-set`, `weather`, `widget-set`, `log`
- Car: `car-status [parts]` (read-only; the API allows ~20 requests per hour per car) and `car <command>` - `charge-start`, `charge-stop`, `charge-limit <50-100>`, `charge-mode <MODE>`, `ac-start [°C] [--battery]`, `ac-stop`, `vent-start`, `vent-stop`. Commands act on the car, so the routine only runs them after the owner approved them.

- Home: `homey-status` (compact read: devices on, contacts open, low batteries, thermostats), `homey-tools` (lists the Homey MCP tools) and `homey <tool> '<json args>' [--action]`. Tools that change the Homey set-up (create/update/delete/rename/move) are blocked in code, as are lock, home-alarm and camera capabilities; device, flow and mood actions only run after the owner approved them.
- Public transport: `ns-trips '<from>' '<to>' [now|HH:MM|tomorrow HH:MM]` (next trains with delays, platform, transfers, status, crowding), `ns-disruptions [station ...]` (active disruptions and maintenance) and `bus <stop code[,code]> [line]` (live departures from OVapi, no key; plain http only).
- Heating: `tado-status` (home/away, who is home, and per zone the target, measured temperature, humidity, schedule or override, open window), `tado-devices` (per device: room, online since, battery, firmware), `tado-history <room> [today|yesterday|YYYY-MM-DD]` (when its thermostat was connected, hourly temperature, heating demand) and `tado set <zone> <°C> [minutes] | off <zone> [minutes] | resume <zone|all> | presence <home|away|auto>`. Overrides always end at the next schedule block or after the timer; schedules and settings are never edited. Actions only run after the owner approved them.

The Homey MCP server is called directly from code, so no claude.ai connector is needed. Run `node scripts/homey-login.js` once on your own computer: it registers an OAuth client, opens the Homey login, and writes the four `HOMEY_*` variables to `.env.homey` (git-ignored) for the cloud environment. The cloud cannot update its own variables, so the current access token (and a rotated refresh token, if the server issues one) is cached in the assistant memory tab, encrypted with `HOMEY_TOKEN_KEY`.

tado is called directly too, so heating keeps working when Homey is down. Run `node scripts/tado-login.js` once on your own computer: it shows a tado link to approve and writes `TADO_REFRESH_TOKEN` and `TADO_TOKEN_KEY` to `.env.tado` (git-ignored); with `--store` it also starts the routine's token chain in the memory tab. tado rotates its refresh token on every use and cancels the whole chain when a replaced token is reused, so the newest one is kept in the assistant memory tab (encrypted with `TADO_TOKEN_KEY`) and only one user may refresh it: local tests use their own sign-in under `TADO_CACHE_KEY`. tado allows about 100 requests a day on a normal account; a status read costs 3. Overrides always end at the next schedule block (or a timer), so the tado schedules stay in charge.
