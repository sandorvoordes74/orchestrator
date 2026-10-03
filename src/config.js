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
//   GMAIL2_CLIENT_ID / GMAIL2_CLIENT_SECRET / GMAIL2_REFRESH_TOKEN  (optional) private mailbox
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
