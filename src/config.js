"use strict";

// All deployment-specific / personal identifiers come from ENVIRONMENT VARIABLES,
// never hardcoded here. This keeps the code generic and free of private data, so the
// repository is safe to be public. Set these on the cloud environment (or your shell
// for local runs):
//
//   GOOGLE_SERVICE_ACCOUNT_KEY  (required) service-account key, raw JSON or base64
//   SPREADSHEET_ID              (required) target Google Sheet id
//   TASKS_TAB / LOG_TAB         (optional) tab name overrides
//   GOOGLE_DOCS                 (optional) docs to scan for TODO lines
//   PA_FACTS_DOC / PA_FACTS_TAB (optional) doc + tab with background facts (default: first GOOGLE_DOCS doc, tab 'PA')
//   DOCS_SKIP_TABS              (optional) comma-separated tab titles the TODO scan skips
//   PA_LISTS_SHEET / PA_LISTS_TABS (optional) personal lists sheet + the ONLY tabs it may read (see lists.js)
//   TOMTOM_API_KEY / PA_HOME    (optional) live road traffic for drives (see traffic.js)
//   GMAIL2_CLIENT_ID / GMAIL2_CLIENT_SECRET / GMAIL2_REFRESH_TOKEN  (optional) private mailbox
//   SKODA_API_KEY / SKODA_VIN   (optional) car via the MyŠkoda public API (see car.js)
//   HOMEY_CLIENT_ID / HOMEY_CLIENT_SECRET / HOMEY_REFRESH_TOKEN / HOMEY_TOKEN_KEY  (optional) smart home (see homey.js)
//   TADO_REFRESH_TOKEN / TADO_TOKEN_KEY  (optional) heating and presence via tado (see tado.js)
//   NS_API_KEY  (optional) train trips and disruptions via the NS API (see ov.js; bus times need no key)
//
// Future sources (additional mailboxes, chats, docs) will likewise be configured via
// env vars (e.g. a SOURCES JSON), so no source links ever live in the code.

module.exports = {
  SPREADSHEET_ID: process.env.SPREADSHEET_ID || "",
  TASKS_TAB: process.env.TASKS_TAB || null, // null => first sheet
  LOG_TAB: process.env.LOG_TAB || "Log", // audit trail of every action taken

  // Google Docs to scan for `TODO:` lines — comma- or newline-separated links/ids.
  GOOGLE_DOCS: (process.env.GOOGLE_DOCS || "").split(/[\n,]+/).map((s) => s.trim()).filter(Boolean),

  SCOPES: [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/documents",
  ],

  // Call at the start of any entrypoint for a clear error if config is missing.
  assertConfig() {
    if (!this.SPREADSHEET_ID) {
      throw new Error("Missing required env var SPREADSHEET_ID (the target Google Sheet id).");
    }
  },
};
