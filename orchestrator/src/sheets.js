"use strict";

const { google } = require("googleapis");
const { SPREADSHEET_ID, TASKS_TAB, SCOPES } = require("./config");

// --- Auth -------------------------------------------------------------------
// Accepts the service-account key as:
//   GOOGLE_SERVICE_ACCOUNT_KEY  = raw JSON  OR base64-encoded JSON  (used by the
//                                 cloud routine, where the key is base64 in the
//                                 routine Instructions and exported to this var)
//   GOOGLE_APPLICATION_CREDENTIALS = path to a key file (handy for local testing)
function loadInlineCredentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw || !raw.trim()) return null;
  let text = raw.trim();
  if (!text.startsWith("{")) {
    // assume base64
    text = Buffer.from(text, "base64").toString("utf8");
  }
  return JSON.parse(text);
}

function getAuth() {
  const credentials = loadInlineCredentials();
  if (credentials) {
    return new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
  }
  // Falls back to GOOGLE_APPLICATION_CREDENTIALS file path / ADC.
  return new google.auth.GoogleAuth({ scopes: SCOPES });
}

let _sheets = null;
async function getSheetsClient() {
  if (_sheets) return _sheets;
  const auth = getAuth();
  _sheets = google.sheets({ version: "v4", auth });
  return _sheets;
}

// --- Tab helpers ------------------------------------------------------------
async function listTabs() {
  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: "properties.title,sheets.properties.title",
  });
  return {
    spreadsheetTitle: meta.data.properties?.title || "",
    tabs: (meta.data.sheets || []).map((s) => s.properties.title),
  };
}

async function getTasksTabName() {
  if (TASKS_TAB) return TASKS_TAB;
  const { tabs } = await listTabs();
  return tabs[0]; // first sheet, matching the Replit app
}

async function readHeaders(sheetName) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${sheetName}'!1:1`,
  });
  return res.data.values?.[0] || [];
}

// Column mapping ported from replit-code/server/googleSheets.ts so we read the
// sheet exactly the way the Replit app does (header-alias based, order-tolerant).
function buildColumnMap(headerRow) {
  const lower = headerRow.map((h) => String(h).toLowerCase().trim());
  const find = (names) => lower.findIndex((h) => names.includes(h));

  const idCol = find(["id", "unique id", "task id"]);
  return {
    id: idCol,
    reviewDate: find(["review date", "date", "review_date", "reviewdate", "due date"]),
    label: find(["label", "category", "type"]),
    task: find(["task", "title", "description", "name"]),
    context: find(["context", "links", "sources", "references"]),
    prio: find(["prio", "priority", "pri"]),
    deadline: find(["deadline", "hard deadline", "due"]),
    importance: find(["importance", "imp"]),
    createdDate: find(["created", "created date", "createddate", "created_date"]),
    effort: find(["effort", "size"]),
    urgency: find(["urgency", "urg"]),
    urgencySetDate: find(["urgencysetdate", "urgency set date", "urgency_set_date"]),
    taskType: find(["tasktype", "task type", "task_type", "scope"]),
    commitDate: find(["commitmentdate", "commitment date", "commit date", "commitdate", "commit"]),
    energy: find(["energy"]),
    location: find(["location", "where"]),
    hasIdColumn: idCol >= 0,
    _headers: headerRow,
  };
}

const cell = (row, idx) => (idx >= 0 ? String(row[idx] ?? "").trim() : "");
const hml = (v) => (["H", "M", "L"].includes(v.toUpperCase()) ? v.toUpperCase() : "M");

// Read all task rows from the Tasks tab.
async function getTasks() {
  const sheets = await getSheetsClient();
  const sheetName = await getTasksTabName();
  const headers = await readHeaders(sheetName);
  const map = buildColumnMap(headers);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${sheetName}'`,
  });
  const rows = res.data.values || [];
  if (rows.length <= 1) return { sheetName, headers, map, tasks: [] };

  const tasks = [];
  for (const row of rows.slice(1)) {
    const task = cell(row, map.task);
    const label = cell(row, map.label);
    const reviewDate = cell(row, map.reviewDate);
    if (!task && !label && !reviewDate) continue; // skip blank rows
    const prioRaw = cell(row, map.prio).toLowerCase();
    tasks.push({
      id: cell(row, map.id),
      reviewDate,
      label,
      task,
      context: cell(row, map.context),
      prio: ["true", "yes", "1", "x"].includes(prioRaw),
      deadline: cell(row, map.deadline),
      importance: hml(cell(row, map.importance)),
      createdDate: cell(row, map.createdDate),
      effort: hml(cell(row, map.effort)),
      urgency: hml(cell(row, map.urgency)),
      urgencySetDate: cell(row, map.urgencySetDate),
      taskType: cell(row, map.taskType),
      commitDate: cell(row, map.commitDate),
      energy: cell(row, map.energy),
      location: cell(row, map.location),
    });
  }
  return { sheetName, headers, map, tasks };
}

// Distinct, non-empty labels currently in use (for label reuse during enrichment).
function distinctLabels(tasks) {
  return [...new Set(tasks.map((t) => t.label).filter((l) => l && l.trim()))].sort();
}

// All source URLs already present in any task's Context (for dedup).
function sourceUrlIndex(tasks) {
  const urls = new Set();
  for (const t of tasks) {
    for (const line of (t.context || "").split("\n")) {
      const u = line.trim();
      if (u) urls.add(u);
    }
  }
  return urls;
}

// --- Write helpers ----------------------------------------------------------

// Staging tab: reviewer-facing. `Approve?` is the cell the user sets; provenance
// (Source URL / Confidence / Reasoning) supports the review decision.
const STAGING_HEADERS = [
  "Approve?", "Task", "Label", "Importance", "Urgency", "Effort",
  "Deadline", "Review Date", "Context", "Confidence", "Reasoning",
  "Status", "Draft ID", "Append To",
];

const STATE_HEADERS = ["Key", "Value"];

const LOG_HEADERS = ["When", "Action", "Task", "Task ID", "Source", "Note"];

// Append one audit-log row (tag-driven mode logs every new/append/skip).
async function appendLog(entry) {
  const { LOG_TAB } = require("./config");
  await ensureTab(LOG_TAB, LOG_HEADERS);
  await appendRow(LOG_TAB, [
    new Date().toISOString(),
    entry.action || "",
    entry.task || "",
    entry.id || "",
    entry.source || "",
    entry.note || "",
  ]);
}
const REJECTED_TAB = "_rejected";

const _hml = (v) => (["H", "M", "L"].includes(String(v || "").toUpperCase()) ? String(v).toUpperCase() : "M");
// WORK | PRIVATE — every new task must be one or the other; default WORK (most sources are work).
const _taskType = (v) => (String(v || "").trim().toUpperCase() === "PRIVATE" ? "PRIVATE" : "WORK");
// Mental energy needed (CAPS). Default MEDIUM.
const _energy = (v) => (["LOW", "MEDIUM", "HIGH"].includes(String(v || "").trim().toUpperCase()) ? String(v).trim().toUpperCase() : "MEDIUM");
// Where the task can be picked up (CAPS). Default ANYWHERE.
const _location = (v) => (["ANYWHERE", "HOME", "OFFICE", "OUT", "CALLS"].includes(String(v || "").trim().toUpperCase()) ? String(v).trim().toUpperCase() : "ANYWHERE");
const _today = () => new Date().toISOString().slice(0, 10);
const _colLetter = (i) => String.fromCharCode(65 + i); // fine for our <26-col sheet

// Format a date as the sheet's human style ("30 Jun", or "30 Jun 2027" if not
// this year). Stored as TEXT (with RAW writes) so Sheets never converts it to a
// serial number, matching the existing tasks and the app's flexible parser.
const _MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function toSheetDate(v) {
  if (!v) return "";
  const str = String(v).trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(str) ? new Date(str + "T00:00:00") : new Date(str);
  if (isNaN(d.getTime())) return str; // leave anything unparseable as-is
  const y = d.getFullYear();
  return `${d.getDate()} ${_MON[d.getMonth()]}${y !== new Date().getFullYear() ? " " + y : ""}`;
}

// Create a tab with a header row if it doesn't already exist.
async function ensureTab(title, headers) {
  const sheets = await getSheetsClient();
  const { tabs } = await listTabs();
  if (tabs.includes(title)) return { created: false };

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title } } }] },
  });
  if (headers && headers.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${title}'!1:1`,
      valueInputOption: "RAW",
      requestBody: { values: [headers] },
    });
  }
  return { created: true };
}

// Append one row; returns the A1 range that was written (e.g. 'Staging'!A5:M5).
async function appendRow(title, values) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${title}'!A:A`,
    valueInputOption: "RAW", // literal text — a log note like "+1 link(s)" must not become a formula
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [values] },
  });
  return res.data.updates?.updatedRange || null;
}

async function readTab(title) {
  const sheets = await getSheetsClient();
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${title}'`,
    });
    return res.data.values || [];
  } catch (e) {
    // A deleted/absent tab is not an error here — treat as empty.
    if (/Unable to parse range|not found/i.test(String(e.message || ""))) return [];
    throw e;
  }
}

async function clearRange(range) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range });
}

// --- Promotion helpers ------------------------------------------------------

// Append a brand-new task to the live Tasks tab, honoring the existing column
// contract (same mapping the Replit app uses). Writes only matrix INPUTS; the
// urgency score stays derived. Returns the generated id.
async function appendTask(task) {
  const crypto = require("crypto");
  const sheets = await getSheetsClient();
  const sheetName = await getTasksTabName();
  const headers = await readHeaders(sheetName);
  const m = buildColumnMap(headers);

  const present = [m.id, m.reviewDate, m.label, m.task, m.context, m.prio, m.deadline, m.importance, m.createdDate, m.effort, m.urgency, m.urgencySetDate, m.taskType, m.commitDate, m.energy, m.location].filter((i) => i >= 0);
  const row = new Array(Math.max(...present) + 1).fill("");
  const set = (i, v) => { if (i >= 0) row[i] = v; };
  const id = crypto.randomUUID().slice(0, 8);

  set(m.id, id);
  set(m.reviewDate, toSheetDate(task.reviewDate)); // blank unless a date was derived from content
  set(m.label, task.label || "");
  set(m.task, task.task || "");
  set(m.context, (task.sourceUrls || []).join("\n"));
  set(m.prio, task.prio ? "TRUE" : "");
  set(m.deadline, toSheetDate(task.deadline));
  set(m.importance, _hml(task.importance));
  set(m.createdDate, _today());
  set(m.effort, _hml(task.effort));
  set(m.urgency, _hml(task.urgency));
  set(m.urgencySetDate, _today());
  set(m.taskType, _taskType(task.taskType)); // WORK | PRIVATE — drives day/time-of-week prioritization
  set(m.commitDate, toSheetDate(task.commitDate)); // intended date to work on it; blank unless stated
  set(m.energy, _energy(task.energy)); // LOW | MEDIUM | HIGH — mental energy needed
  set(m.location, _location(task.location)); // ANYWHERE | HOME | OFFICE | OUT | CALLS — where it can be done

  // RAW so date strings stay literal text (USER_ENTERED would coerce ISO to a serial).
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${sheetName}'!A:A`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
  return id;
}

// Append a source URL to an existing task's Context (newline-separated, no dup).
async function appendUrlToTaskContext(taskId, url) {
  const sheets = await getSheetsClient();
  const sheetName = await getTasksTabName();
  const headers = await readHeaders(sheetName);
  const m = buildColumnMap(headers);
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${sheetName}'` });
  const rows = res.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][m.id] ?? "").trim() === taskId) {
      const urls = String(rows[i][m.context] ?? "").split("\n").map((u) => u.trim()).filter(Boolean);
      if (urls.includes(url)) return { updated: false, reason: "already-present" };
      urls.unshift(url); // newest source link at the BEGINNING
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${sheetName}'!${_colLetter(m.context)}${i + 1}`,
        valueInputOption: "RAW",
        requestBody: { values: [[urls.join("\n")]] },
      });
      return { updated: true };
    }
  }
  return { updated: false, reason: "task-not-found" };
}

// Update specific fields on an existing task (by id). Used on APPEND when a new
// source changes the task's title and/or its scheduling/priority fields — e.g. a
// final-notice email that adds a deadline to a task that had none. Only the fields
// passed in `fields` are touched; everything else is left as-is. Dates are stored as
// the sheet's human text; H/M/L and CAPS enums are normalized. Returns the changes made.
async function updateTaskFields(taskId, fields) {
  const f = fields || {};
  const sheets = await getSheetsClient();
  const sheetName = await getTasksTabName();
  const headers = await readHeaders(sheetName);
  const m = buildColumnMap(headers);
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${sheetName}'` });
  const rows = res.data.values || [];
  // col index -> normalized new value, only for keys actually provided (not undefined/null).
  const has = (k) => f[k] !== undefined && f[k] !== null && String(f[k]).trim() !== "";
  const plan = [];
  const push = (col, key, val) => { if (col >= 0) plan.push([col, key, val]); };
  if (has("task")) push(m.task, "task", String(f.task).trim());
  if (has("label")) push(m.label, "label", String(f.label).trim());
  if (has("reviewDate")) push(m.reviewDate, "reviewDate", toSheetDate(f.reviewDate));
  if (has("deadline")) push(m.deadline, "deadline", toSheetDate(f.deadline));
  if (has("commitDate")) push(m.commitDate, "commitDate", toSheetDate(f.commitDate));
  if (has("importance")) push(m.importance, "importance", _hml(f.importance));
  if (has("effort")) push(m.effort, "effort", _hml(f.effort));
  if (has("energy")) push(m.energy, "energy", _energy(f.energy));
  if (has("location")) push(m.location, "location", _location(f.location));
  if (has("taskType")) push(m.taskType, "taskType", _taskType(f.taskType));
  // Urgency is a matrix input; re-asserting it resets the urgency clock (urgencySetDate=today).
  let bumpUrgency = false;
  if (has("urgency")) { push(m.urgency, "urgency", _hml(f.urgency)); bumpUrgency = true; }
  if (!plan.length) return { updated: false, reason: "no-fields" };

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][m.id] ?? "").trim() === taskId) {
      const data = []; const changes = [];
      for (const [col, key, val] of plan) {
        const old = String(rows[i][col] ?? "").trim();
        if (old === String(val)) continue; // no-op
        data.push({ range: `'${sheetName}'!${_colLetter(col)}${i + 1}`, values: [[val]] });
        changes.push({ field: key, from: old, to: val });
      }
      if (bumpUrgency && m.urgencySetDate >= 0 && changes.some((c) => c.field === "urgency")) {
        data.push({ range: `'${sheetName}'!${_colLetter(m.urgencySetDate)}${i + 1}`, values: [[_today()]] });
      }
      if (!data.length) return { updated: false, reason: "unchanged" };
      await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: SPREADSHEET_ID, requestBody: { valueInputOption: "RAW", data } });
      return { updated: true, changes };
    }
  }
  return { updated: false, reason: "task-not-found" };
}

// Rejected source URLs — remembered so they are never re-drafted.
async function readRejected() {
  const { tabs } = await listTabs();
  if (!tabs.includes(REJECTED_TAB)) return [];
  const rows = await readTab(REJECTED_TAB);
  return rows.slice(1).map((r) => String(r[0] ?? "").trim()).filter(Boolean);
}

async function addRejected(urls) {
  if (!urls || !urls.length) return;
  await ensureTab(REJECTED_TAB, ["Source URL"]);
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${REJECTED_TAB}'!A:A`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: urls.map((u) => [u]) },
  });
}

// Replace all Staging data rows (keep header) — used after promotion.
async function rewriteStagingRows(rows) {
  await clearRange(`'${STAGING_TAB}'!A2:Z100000`);
  if (rows && rows.length) {
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${STAGING_TAB}'!A2`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: rows },
    });
  }
}

module.exports = {
  getAuth,
  getSheetsClient,
  listTabs,
  getTasksTabName,
  readHeaders,
  buildColumnMap,
  getTasks,
  distinctLabels,
  sourceUrlIndex,
  STAGING_HEADERS,
  STATE_HEADERS,
  ensureTab,
  appendRow,
  readTab,
  clearRange,
  appendTask,
  appendUrlToTaskContext,
  updateTaskFields,
  appendLog,
  readRejected,
  addRejected,
  rewriteStagingRows,
};
