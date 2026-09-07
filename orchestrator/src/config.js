"use strict";

// All deployment-specific / personal identifiers come from ENVIRONMENT VARIABLES,
// never hardcoded here. This keeps the code generic and free of private data, so the
// repository is safe to be public. Set these on the cloud environment (or your shell
// for local runs):
//
//   GOOGLE_SERVICE_ACCOUNT_KEY  (required) service-account key, raw JSON or base64
//   SPREADSHEET_ID              (required) target Google Sheet id
//   SLACK_DM_CHANNEL            (optional) Slack channel/user id for the run-report DM
//   TASKS_TAB / STAGING_TAB / STATE_TAB  (optional) tab name overrides
//
// Future sources (additional mailboxes, chats, docs) will likewise be configured via
// env vars (e.g. a SOURCES JSON), so no source links ever live in the code.

module.exports = {
  SPREADSHEET_ID: process.env.SPREADSHEET_ID || "",
  TASKS_TAB: process.env.TASKS_TAB || null, // null => first sheet
  STAGING_TAB: process.env.STAGING_TAB || "Staging", // legacy (unused in tag-driven mode)
  STATE_TAB: process.env.STATE_TAB || "_state",
  LOG_TAB: process.env.LOG_TAB || "Log", // audit trail of every action taken
  SLACK_DM_CHANNEL: process.env.SLACK_DM_CHANNEL || "",

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
