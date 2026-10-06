"use strict";

// Read-only access to the owner's personal lists sheet (packing lists, shopping list,
// addresses, ...). Only the tabs named in PA_LISTS_TABS can be read - everything else in
// that sheet (e.g. finances) stays out of reach. Env vars, never code:
//
//   PA_LISTS_SHEET  spreadsheet id or link (shared with the service account, Viewer)
//   PA_LISTS_TABS   comma-separated tab titles the assistant may read

const { getSheetsClient } = require("./sheets");

function _config() {
  const raw = process.env.PA_LISTS_SHEET || "";
  const m = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  const id = m ? m[1] : raw.trim();
  const tabs = (process.env.PA_LISTS_TABS || "").split(",").map((t) => t.trim()).filter(Boolean);
  return { id, tabs };
}

function isConfigured() {
  const { id, tabs } = _config();
  return Boolean(id && tabs.length);
}

function _allowed(tab) {
  const want = String(tab || "").trim().toLowerCase();
  return _config().tabs.find((t) => t.toLowerCase() === want) || null;
}

// The readable tabs and how many filled rows each has.
async function overview() {
  const { id, tabs } = _config();
  const sh = await getSheetsClient();
  const out = [];
  for (const tab of tabs) {
    try {
      const rows = await _rows(sh, id, tab);
      out.push({ tab, rows: rows.length, header: (rows[0] || []).slice(0, 10) });
    } catch (e) {
      out.push({ tab, error: e.message });
    }
  }
  return out;
}

async function _rows(sh, id, tab) {
  const res = await sh.spreadsheets.values.get({ spreadsheetId: id, range: `'${tab.replace(/'/g, "''")}'!A1:Z1000` });
  return ((res.data || res).values || []).filter((r) => r.some((c) => String(c).trim()));
}

// One allowed tab as plain text: one line per filled row, cells joined with " | ".
async function read(tab) {
  const name = _allowed(tab);
  if (!name) throw new Error(`list '${tab}' is not readable (allowed: ${_config().tabs.join(", ") || "none"})`);
  const sh = await getSheetsClient();
  const rows = await _rows(sh, _config().id, name);
  return { tab: name, rows: rows.length, text: rows.map((r) => r.map((c) => String(c).trim()).join(" | ").replace(/( \| )+$/, "")).join("\n") };
}

module.exports = { isConfigured, overview, read };
