"use strict";

// Agent-facing CLI. The cloud routine's Claude agent calls these from Bash to
// read context for reasoning and to stage enriched drafts. All sheet I/O goes
// through the service account (key from env). Output is JSON on stdout.
//
//   node src/cli.js context
//   node src/cli.js stage-draft '<json>'      (or pipe the JSON via stdin)
//
// A draft JSON looks like:
//   {
//     "task": "Send Q3 deck to Maria",
//     "label": "SALES",
//     "importance": "H", "urgency": "M", "effort": "L",
//     "taskType": "WORK",              // WORK | PRIVATE (default WORK)
//     "deadline": "2026-07-01", "reviewDate": "",
//     "sourceUrls": ["https://mail.google.com/mail/u/0/#all/<id>"],
//     "confidence": 0.82,
//     "reasoning": "Direct request with a Friday deadline"
//   }

const crypto = require("crypto");
const {
  getTasks, distinctLabels, sourceUrlIndex,
  readTab, appendRow, STAGING_HEADERS,
  appendTask, appendUrlToTaskContext, updateTaskFields, appendLog, readRejected, addRejected, rewriteStagingRows,
} = require("./sheets");
const { STAGING_TAB } = require("./config");

// Staging column indices (must match STAGING_HEADERS order).
const C = {
  APPROVE: 0, TASK: 1, LABEL: 2, IMP: 3, URG: 4, EFF: 5, DEAD: 6,
  REVIEW: 7, CTX: 8, CONF: 9, REASON: 10, STATUS: 11, DRAFT: 12, APPEND: 13,
};
const APPROVE_YES = new Set(["x", "yes", "y", "true", "1", "approve", "approved"]);
const REJECT_NO = new Set(["no", "n", "reject", "rejected"]);
const threadIdFromUrl = (u) => (String(u).match(/#all\/([^/?\s]+)/) || [])[1];

const hml = (v) => (["H", "M", "L"].includes(String(v || "").toUpperCase()) ? String(v).toUpperCase() : "M");
const today = () => new Date().toISOString().slice(0, 10);

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
  });
}

function urlsFromDraft(draft) {
  const raw = []
    .concat(draft.sourceUrls || [])
    .concat(draft.contextUrls || [])
    .concat(typeof draft.context === "string" ? draft.context.split("\n") : []);
  return [...new Set(raw.map((u) => String(u).trim()).filter(Boolean))];
}

// Source URLs already present in Tasks AND Staging — the dedup index.
async function existingUrlSet() {
  const { tasks } = await getTasks();
  const set = sourceUrlIndex(tasks);
  const staging = await readTab(STAGING_TAB);
  for (const row of staging.slice(1)) {
    for (const u of String(row[C.CTX] || "").split("\n")) {
      if (u.trim()) set.add(u.trim());
    }
  }
  for (const u of await readRejected()) set.add(u); // never re-draft a rejected source
  return set;
}

// Day-planning view: every task with its full metadata and dates normalized to
// YYYY-MM-DD (the sheet mixes "29 Jun", "29 Jun 2027", ISO and D/M/Y), plus a few
// derived numbers so the planner doesn't have to parse dates itself. Read-only.
const _MONS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function _isoDate(s, todayY) {
  const t = String(s || "").trim();
  if (!t) return "";
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const pad = (n) => String(n).padStart(2, "0");
  m = t.match(/^(\d{1,2})\s+([a-z]{3})\w*\.?(?:\s+(\d{4}))?$/i);
  if (m && _MONS[m[2].toLowerCase()] != null) return `${m[3] || todayY}-${pad(_MONS[m[2].toLowerCase()] + 1)}-${pad(m[1])}`;
  m = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/); // day-first (NL)
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  return "";
}
async function cmdPlan() {
  const { tasks } = await getTasks();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam" }).format(new Date()); // YYYY-MM-DD
  const y = today.slice(0, 4);
  const days = (iso) => (iso ? Math.round((Date.parse(iso) - Date.parse(today)) / 86400000) : null);
  const out = tasks.map((t) => {
    const deadline = _isoDate(t.deadline, y), reviewDate = _isoDate(t.reviewDate, y), commitDate = _isoDate(t.commitDate, y), created = _isoDate(t.createdDate, y);
    return {
      id: t.id, task: t.task, label: t.label, taskType: t.taskType || "", starred: !!t.prio,
      importance: t.importance, urgency: t.urgency, effort: t.effort, energy: t.energy || "", requirements: t.requirements || "",
      deadline, daysToDeadline: days(deadline), reviewDate, reviewDue: !!reviewDate && days(reviewDate) <= 0,
      commitDate, committedToday: commitDate === today, ageDays: created ? -days(created) : null,
      links: (t.context || "").split("\n").filter((x) => x.trim()).length,
    };
  });
  process.stdout.write(JSON.stringify({ today, taskCount: out.length, tasks: out }, null, 1) + "\n");
}

async function cmdContext() {
  const { sheetName, tasks } = await getTasks();
  const staging = await readTab(STAGING_TAB);
  const out = {
    tasksTab: sheetName,
    labels: distinctLabels(tasks),
    taskCount: tasks.length,
    tasks: tasks.map((t) => ({
      id: t.id,
      task: t.task,
      label: t.label,
      urls: (t.context || "").split("\n").map((u) => u.trim()).filter(Boolean),
    })),
    dedupUrls: [...sourceUrlIndex(tasks)], // tag-driven: dedup only against live Tasks
    stagingPendingCount: Math.max(0, staging.length - 1),
  };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

// Compact one-line-per-task listing of the WHOLE task list, so the agent can judge
// semantically (by meaning, with its own reasoning) whether a new item belongs to an
// existing task. No keyword scoring - matching is the model's job.
async function cmdBrief() {
  const { tasks } = await getTasks();
  const lines = tasks.map((t) => [t.id, t.label || "-", t.taskType || "-", (t.task || "").replace(/\s*\n+\s*/g, " / "),
    t.deadline ? "deadline " + t.deadline : "", t.reviewDate ? "review " + t.reviewDate : ""].filter(Boolean).join(" | "));
  process.stdout.write(`${tasks.length} tasks (id | label | type | title | dates)\n` + lines.join("\n") + "\n");
}

// Hard evidence only: existing tasks that already hold one of the item's links or a rare
// identifying token from them (doc id, mail thread id, Slack ts). Same source = same task.
// Semantic matching is done by the agent over `brief`. Input JSON: {sourceUrls[]}.
function _urlIdKeys(u) {
  // Identifying tokens only (doc id, thread id, message ts) — NOT the host, which is
  // shared by every Gmail/Docs/Slack link and would match unrelated tasks.
  const keys = new Set();
  try { const url = new URL(u);
    for (const tok of (url.pathname + " " + url.search + " " + url.hash).split(/[^a-zA-Z0-9]+/)) if (tok.length >= 8) keys.add(tok);
  } catch { /* not a URL */ }
  return keys;
}
async function cmdMatch(jsonText) {
  let d; try { d = JSON.parse(jsonText); } catch (e) { throw new Error(`match: invalid JSON (${e.message})`); }
  const candUrls = (d.sourceUrls || []).map((u) => String(u).trim()).filter(Boolean);
  const candUrlSet = new Set(candUrls);
  const candKeys = new Set(); for (const u of candUrls) for (const k of _urlIdKeys(u)) candKeys.add(k);

  const { tasks } = await getTasks();
  // A key shared by MANY tasks (e.g. one Google Doc's id across all its TODO lines) is not evidence.
  const taskKeys = tasks.map((t) => { const s = new Set(); for (const u of (t.context || "").split("\n")) for (const k of _urlIdKeys(u.trim())) s.add(k); return s; });
  const df = {}; taskKeys.forEach((s) => s.forEach((k) => { df[k] = (df[k] || 0) + 1; }));

  const hits = tasks.map((t, i) => {
    const tUrls = (t.context || "").split("\n").map((x) => x.trim()).filter(Boolean);
    const sharedUrls = tUrls.filter((u) => candUrlSet.has(u)).length;
    const sharedIdKeys = [...candKeys].filter((k) => taskKeys[i].has(k) && df[k] <= 2).length;
    return { id: t.id, task: t.task, label: t.label, taskType: t.taskType, importance: t.importance || "", urgency: t.urgency || "", effort: t.effort || "", energy: t.energy || "", deadline: t.deadline || "", reviewDate: t.reviewDate || "", commitDate: t.commitDate || "", requirements: t.requirements || "", prio: !!t.prio, sharedUrls, sharedIdKeys };
  }).filter((c) => c.sharedUrls > 0 || c.sharedIdKeys > 0);
  process.stdout.write(JSON.stringify({ sourceMatches: hits }, null, 2) + "\n");
}

// Delete tasks by id (owner-confirmed only). Re-reads the sheet right before deleting and
// verifies each row still holds that id, so concurrent edits in the app can't shift us onto
// the wrong row. Logs each deletion with the title.
async function cmdDelete(ids) {
  const { getSheetsClient, getTasksTabName, readHeaders, buildColumnMap } = require("./sheets");
  const { SPREADSHEET_ID } = require("./config");
  const sh = await getSheetsClient(); const tab = await getTasksTabName();
  const m = buildColumnMap(await readHeaders(tab));
  const rows = (await sh.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${tab}'` })).data.values || [];
  const found = [], missing = [];
  for (const id of ids) { const i = rows.findIndex((r, k) => k > 0 && String(r[m.id] ?? "").trim() === id); (i > 0 ? found : missing).push(i > 0 ? { id, i, title: rows[i][m.task] } : id); }
  if (found.length) {
    const meta = await sh.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID, fields: "sheets.properties" });
    const sheetId = meta.data.sheets.find((x) => x.properties.title === tab).properties.sheetId;
    const again = (await sh.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${tab}'!${String.fromCharCode(65 + m.id)}:${String.fromCharCode(65 + m.id)}` })).data.values || [];
    for (const f of found) if (String((again[f.i] || [])[0] ?? "").trim() !== f.id) throw new Error(`delete: sheet changed under us (row ${f.i + 1} no longer ${f.id}); nothing deleted - retry`);
    await sh.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, requestBody: { requests: found.sort((a, b) => b.i - a.i).map((f) => ({ deleteDimension: { range: { sheetId, dimension: "ROWS", startIndex: f.i, endIndex: f.i + 1 } } })) } });
    for (const f of found) await appendLog({ action: "delete", task: String(f.title || "").slice(0, 60), id: f.id, note: "owner-confirmed delete (done/concluded)" });
  }
  process.stdout.write(JSON.stringify({ deleted: found.map((f) => ({ id: f.id, title: f.title })), notFound: missing }) + "\n");
}

// Small key/value memory for the assistant routines (today's plan, suggestions made,
// declined items, owner notes), stored in an '_assistant' tab of the sheet.
const STATE_TAB = "_assistant";
async function _stateRows() {
  const { ensureTab, readTab } = require("./sheets");
  await ensureTab(STATE_TAB, ["Key", "Value", "Updated"]);
  return readTab(STATE_TAB);
}
async function cmdStateGet(key) {
  const rows = await _stateRows();
  const r = rows.find((x, i) => i > 0 && x[0] === key);
  process.stdout.write((r ? r[1] || "" : "") + "\n");
}
async function cmdStateSet(key, value, append) {
  const { getSheetsClient, appendRow } = require("./sheets");
  const { SPREADSHEET_ID } = require("./config");
  const rows = await _stateRows();
  const i = rows.findIndex((x, k) => k > 0 && x[0] === key);
  let v = append && i > 0 ? ((rows[i][1] || "") + (rows[i][1] ? "\n" : "") + value) : value;
  if (v.length > 45000) v = v.slice(v.length - 45000); // keep the newest part (sheet cell limit)
  const now = new Date().toISOString();
  if (i > 0) {
    const sh = await getSheetsClient();
    await sh.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `'${STATE_TAB}'!A${i + 1}:C${i + 1}`, valueInputOption: "RAW", requestBody: { values: [[key, v, now]] } });
  } else {
    await appendRow(STATE_TAB, [key, v, now]);
  }
  process.stdout.write(JSON.stringify({ key, chars: v.length, updated: now }) + "\n");
}

// Housekeeping for the assistant memory: drop per-day keys ("<name>:YYYY-MM-DD") older
// than <days>, and trim dated lines ("YYYY-MM-DD ...") in rolling keys (declined, handled)
// to the last <lineDays> days. Undated lines (e.g. standing notes) are kept.
async function cmdStatePrune(days, lineDays) {
  const { getSheetsClient } = require("./sheets");
  const { SPREADSHEET_ID } = require("./config");
  const rows = await _stateRows();
  const cut = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
  const dayCut = cut(days), lineCut = cut(lineDays);
  const keep = [rows[0] || ["Key", "Value", "Updated"]]; let dropped = 0, trimmed = 0;
  for (const r of rows.slice(1)) {
    const m = String(r[0] || "").match(/:(\d{4}-\d{2}-\d{2})$/);
    if (m && m[1] < dayCut) { dropped++; continue; }
    if (!m && ["declined", "handled"].includes(r[0])) {
      const lines = String(r[1] || "").split("\n").filter((l) => { const d = l.match(/^(\d{4}-\d{2}-\d{2})/); return !d || d[1] >= lineCut; });
      if (lines.join("\n") !== String(r[1] || "")) { trimmed++; r[1] = lines.join("\n"); }
    }
    keep.push(r);
  }
  const sh = await getSheetsClient();
  await sh.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range: `'${STATE_TAB}'` });
  await sh.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `'${STATE_TAB}'!A1`, valueInputOption: "RAW", requestBody: { values: keep } });
  process.stdout.write(JSON.stringify({ kept: keep.length - 1, droppedDayKeys: dropped, trimmedKeys: trimmed }) + "\n");
}

// Full current fields of one task (for field re-evaluation before an append).
async function cmdShow(id) {
  const { tasks } = await getTasks();
  const t = tasks.find((x) => x.id === id);
  process.stdout.write(JSON.stringify(t || { error: "not found", id }, null, 2) + "\n");
}

async function cmdStageDraft(jsonText) {
  let draft;
  try {
    draft = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`stage-draft: invalid JSON input (${e.message})`);
  }
  if (!draft.task || !String(draft.task).trim()) {
    throw new Error("stage-draft: 'task' (title) is required");
  }

  const urls = urlsFromDraft(draft);

  // Defense-in-depth dedup: never stage a source already represented.
  const existing = await existingUrlSet();
  const dup = urls.find((u) => existing.has(u));
  if (dup) {
    process.stdout.write(JSON.stringify({ status: "skipped", reason: "duplicate-source-url", url: dup }) + "\n");
    return;
  }

  let appendToId = String(draft.appendToId || "").trim();
  let title = String(draft.task).trim();
  let appendNote;
  if (appendToId) {
    const { tasks } = await getTasks();
    if (!tasks.some((t) => t.id === appendToId)) {
      appendNote = `appendToId '${appendToId}' is not an existing task id; staged as a NEW task instead`;
      appendToId = ""; // invalid/hallucinated id -> treat as a normal new draft
    }
  }
  if (!appendToId) title = title.replace(/^\[APPEND\]\s*/i, ""); // strip marker if not an append

  const draftId = crypto.randomUUID().slice(0, 8);
  const row = [
    "",                                   // Approve?  (user sets)
    title,                                // Task
    draft.label || "",                    // Label
    hml(draft.importance),                // Importance
    hml(draft.urgency),                   // Urgency
    hml(draft.effort),                    // Effort
    draft.deadline || "",                 // Deadline
    draft.reviewDate || today(),          // Review Date (default today so it surfaces)
    urls.join("\n"),                      // Context
    draft.confidence != null ? String(draft.confidence) : "", // Confidence
    draft.reasoning || "",                // Reasoning
    appendToId ? "append" : "pending",    // Status
    draftId,                              // Draft ID
    appendToId,                           // Append To (existing task id, for [APPEND] drafts)
  ];
  const range = await appendRow(STAGING_TAB, row);
  process.stdout.write(JSON.stringify({ status: "staged", draftId, range, urls, appendToId: appendToId || undefined, note: appendNote }) + "\n");
}

// Promote approved Staging drafts: new -> append to Tasks; [APPEND] -> add link
// to the existing task; rejected -> remembered (never re-drafted); blank -> kept.
// Returns thread ids of promoted sources so the agent can archive the READ ones.
async function cmdPromote() {
  const staging = await readTab(STAGING_TAB);
  const dataRows = staging.slice(1);
  const promotedNew = [], appended = [], rejectedUrls = [], keep = [], errors = [], skippedDup = [];
  const archiveThreadIds = new Set();

  // Idempotency guard: never create a NEW task whose source URL is already a task.
  const { tasks } = await getTasks();
  const taskUrls = sourceUrlIndex(tasks);

  for (const row of dataRows) {
    const mark = String(row[C.APPROVE] ?? "").trim().toLowerCase();
    const urls = String(row[C.CTX] ?? "").split("\n").map((u) => u.trim()).filter(Boolean);

    if (APPROVE_YES.has(mark)) {
      try {
        const appendTo = String(row[C.APPEND] ?? "").trim();
        const newTitle = String(row[C.TASK] ?? "").replace(/^\[APPEND\]\s*/i, "");
        if (appendTo) {
          const results = [];
          for (const u of urls) results.push(await appendUrlToTaskContext(appendTo, u));
          if (results.length && results.every((r) => r.reason === "task-not-found")) {
            // Append target no longer exists (completed/removed, or a bad id) —
            // fall back to a NEW task so the email is never silently dropped.
            if (urls.some((u) => taskUrls.has(u))) {
              skippedDup.push({ task: newTitle, urls, note: "append-target-missing; url already a task" });
            } else {
              const id = await appendTask({
                task: newTitle, label: row[C.LABEL], importance: row[C.IMP], urgency: row[C.URG],
                effort: row[C.EFF], deadline: row[C.DEAD], reviewDate: row[C.REVIEW], sourceUrls: urls,
              });
              urls.forEach((u) => taskUrls.add(u));
              promotedNew.push({ id, task: newTitle, note: "append target " + appendTo + " missing -> created as new task" });
            }
          } else {
            appended.push({ taskId: appendTo, urls });
          }
        } else if (urls.some((u) => taskUrls.has(u))) {
          skippedDup.push({ task: row[C.TASK], urls }); // already a task — don't duplicate
        } else {
          const id = await appendTask({
            task: row[C.TASK], label: row[C.LABEL], importance: row[C.IMP], urgency: row[C.URG],
            effort: row[C.EFF], deadline: row[C.DEAD], reviewDate: row[C.REVIEW], sourceUrls: urls,
          });
          urls.forEach((u) => taskUrls.add(u)); // guard against intra-run dupes too
          promotedNew.push({ id, task: row[C.TASK] });
        }
        for (const u of urls) { const t = threadIdFromUrl(u); if (t) archiveThreadIds.add(t); }
      } catch (e) {
        errors.push({ task: row[C.TASK], error: e.message });
        keep.push(row); // leave failed ones staged for retry
      }
    } else if (REJECT_NO.has(mark)) {
      rejectedUrls.push(...urls);
    } else {
      keep.push(row); // pending / untouched
    }
  }

  if (rejectedUrls.length) await addRejected(rejectedUrls);
  await rewriteStagingRows(keep);

  process.stdout.write(JSON.stringify({
    promotedNew, appended, rejected: rejectedUrls.length, skippedDup,
    archiveThreadIds: [...archiveThreadIds], errors,
  }, null, 2) + "\n");
}

// Tag-driven mode: one curated item -> straight into Tasks (new or append) + logged.
// No Staging/approval. The agent decides append-vs-new (via context) and passes appendToId
// for matches; guards keep it safe. JSON fields: task, label, importance, urgency, effort,
// energy (LOW|MEDIUM|HIGH), requirements (array/string of context tokens), deadline, reviewDate,
// commitDate, taskType (WORK|PRIVATE), sourceUrls[], appendToId?, updatedTitle?, fieldUpdates?
//  - On APPEND: updatedTitle rewrites the existing task's title; fieldUpdates {deadline,
//    reviewDate, commitDate, importance, urgency, effort, energy, requirements, taskType, label}
//    changes only the listed fields (e.g. a final-notice email adding a deadline).
async function cmdUpsert(jsonText) {
  let d;
  try { d = JSON.parse(jsonText); } catch (e) { throw new Error(`upsert: invalid JSON (${e.message})`); }
  if (!d.task || !String(d.task).trim()) throw new Error("upsert: 'task' (title) is required");

  const urls = urlsFromDraft(d);
  const { tasks } = await getTasks();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const existing = sourceUrlIndex(tasks);

  let appendToId = String(d.appendToId || "").trim();
  let title = String(d.task).trim();
  if (appendToId && !byId.has(appendToId)) appendToId = ""; // Guard: invalid/stale id -> new task
  if (!appendToId) title = title.replace(/^\[APPEND\]\s*/i, "");

  let result;
  if (appendToId) {
    let added = 0;
    for (const u of urls) { const r = await appendUrlToTaskContext(appendToId, u); if (r.updated) added++; }
    // On append the new source may (a) improve the title and/or (b) change scheduling/priority
    // fields — e.g. a final notice that introduces a deadline. Apply both via updateTaskFields.
    const fieldUpdates = (d.fieldUpdates && typeof d.fieldUpdates === "object") ? { ...d.fieldUpdates } : {};
    if (String(d.updatedTitle || "").trim()) fieldUpdates.task = String(d.updatedTitle).trim();
    let changes = [];
    if (Object.keys(fieldUpdates).length) {
      const r = await updateTaskFields(appendToId, fieldUpdates);
      if (r.updated) changes = r.changes;
    }
    const titleChange = changes.find((c) => c.field === "task");
    const fieldChanges = changes.filter((c) => c.field !== "task");
    result = { action: "append", id: appendToId, task: (titleChange ? titleChange.to : byId.get(appendToId).task), linksAdded: added, titleChanged: !!titleChange, fieldChanges };
  } else if (urls[0] && existing.has(urls[0])) {
    // Dedup on the PRIMARY source link only (urls[0]); extra content links must not
    // trigger a false "already a task" just because another task references the same doc.
    result = { action: "skip", reason: "already-a-task", url: urls[0] };
  } else {
    const id = await appendTask({
      task: title, label: d.label, importance: d.importance, urgency: d.urgency,
      effort: d.effort, deadline: d.deadline, reviewDate: d.reviewDate, commitDate: d.commitDate,
      sourceUrls: urls, taskType: d.taskType, energy: d.energy, requirements: d.requirements,
    });
    result = { action: "new", id, task: title };
  }

  const noteParts = [];
  if (result.linksAdded != null) noteParts.push(`+${result.linksAdded} link(s)`);
  if (result.titleChanged) noteParts.push("title improved");
  if (result.fieldChanges && result.fieldChanges.length) noteParts.push(result.fieldChanges.map((c) => `${c.field}=${c.to}`).join(", "));
  await appendLog({ action: result.action, task: result.task || title, id: result.id || "", source: urls[0] || "", note: result.reason || noteParts.join(", ") });
  process.stdout.write(JSON.stringify(result) + "\n");
}

// Scan configured Google Docs for `TODO` / `TODO:` lines (a TODO line ending in ":"
// absorbs the bullet list below it). Docs come from the docs-scan
// arguments (one or more URLs/ids) when given, else the GOOGLE_DOCS env var.
async function cmdDocsScan(argDocs) {
  const { GOOGLE_DOCS } = require("./config");
  const { docIdFromUrl, docUrl, listTodoItems } = require("./docs");
  const docsList = (argDocs && argDocs.length) ? argDocs : GOOGLE_DOCS;
  const out = [];
  for (const entry of docsList) {
    const id = docIdFromUrl(entry);
    try {
      const items = (await listTodoItems(id)).map((it) => ({
        ...it,
        // stable per-line source id: unique (so multiple TODO lines in one doc don't collide
        // on dedup) and idempotent (same line -> same id across runs); opens the doc when clicked.
        sourceUrl: `${docUrl(id)}#task=${crypto.createHash("sha1").update(id + "\n" + it.text).digest("hex").slice(0, 10)}`,
      }));
      out.push({ docId: id, docUrl: docUrl(id), items });
    } catch (e) {
      out.push({ docId: id, docUrl: docUrl(id), error: e.message });
    }
  }
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

// Flip a processed line's leading TODO -> LISTED in its doc. Input JSON: {docId, text}.
async function cmdDocsMark(jsonText) {
  const { markListed } = require("./docs");
  const d = JSON.parse(jsonText);
  const r = await markListed(d.docId, d.text);
  await appendLog({ action: "docs-mark", task: String(d.text || "").slice(0, 60), source: d.docId, note: JSON.stringify(r) });
  process.stdout.write(JSON.stringify(r) + "\n");
}

// Private mailbox (second Gmail via OAuth). Returns {configured:false} if not set up.
async function cmdGmail2Scan() {
  const g2 = require("./gmail2");
  if (!g2.isConfigured()) { process.stdout.write(JSON.stringify({ configured: false }) + "\n"); return; }
  const r = await g2.listTodo();
  process.stdout.write(JSON.stringify({ configured: true, ...r }, null, 2) + "\n");
}
async function cmdGmail2Relabel(threadId) {
  const g2 = require("./gmail2");
  const r = await g2.relabel(threadId);
  await appendLog({ action: "gmail2-relabel", source: threadId, note: JSON.stringify(r) });
  process.stdout.write(JSON.stringify(r) + "\n");
}

async function main() {
  require("./config").assertConfig();
  const cmd = process.argv[2];
  if (cmd === "gmail2-send") {
    // usage: node src/cli.js gmail2-send "<subject>" [to]  < body.txt
    const { isConfigured, sendMail } = require("./gmail2");
    if (!isConfigured()) throw new Error("gmail2-send: private mailbox not configured");
    const text = await readStdin();
    process.stdout.write(JSON.stringify(await sendMail({ subject: process.argv[3], to: process.argv[4], text })) + "\n");
  } else if (cmd === "plan") {
    await cmdPlan();
  } else if (cmd === "context") {
    await cmdContext();
  } else if (cmd === "gmail2-scan") {
    await cmdGmail2Scan();
  } else if (cmd === "gmail2-inbox") {
    const g2 = require("./gmail2");
    if (!g2.isConfigured()) { process.stdout.write(JSON.stringify({ configured: false }) + "\n"); return; }
    process.stdout.write(JSON.stringify({ configured: true, ...(await g2.inboxOverview(Number(process.argv[3]) || 25)) }, null, 2) + "\n");
  } else if (cmd === "gmail2-archive") {
    // owner-confirmed: archive private-mailbox threads (reversible). usage: gmail2-archive <threadId,...>
    const ids = process.argv.slice(3).flatMap((a) => a.split(",")).map((x) => x.trim()).filter(Boolean);
    if (!ids.length) throw new Error("gmail2-archive: provide one or more threadIds");
    const g2 = require("./gmail2"); const out = [];
    for (const id of ids) { out.push(await g2.archive(id)); await appendLog({ action: "gmail2-archive", source: id, note: "owner-confirmed archive" }); }
    process.stdout.write(JSON.stringify(out) + "\n");
  } else if (cmd === "gmail2-draft") {
    // owner-confirmed: create a reply DRAFT (never sends). usage: gmail2-draft <threadId> < body.txt
    const id = process.argv[3]; if (!id) throw new Error("gmail2-draft: provide a threadId (body on stdin)");
    const text = await readStdin(); if (!text.trim()) throw new Error("gmail2-draft: empty body");
    const r = await require("./gmail2").draftReply(id, text);
    await appendLog({ action: "gmail2-draft", source: id, note: "reply draft created (not sent)" });
    process.stdout.write(JSON.stringify(r) + "\n");
  } else if (cmd === "gmail2-relabel") {
    const id = process.argv[3];
    if (!id) throw new Error("gmail2-relabel: provide a threadId");
    await cmdGmail2Relabel(id);
  } else if (cmd === "docs-scan") {
    await cmdDocsScan(process.argv.slice(3));
  } else if (cmd === "docs-mark") {
    const arg = process.argv[3];
    const jsonText = arg && arg.trim() ? arg : await readStdin();
    if (!jsonText || !jsonText.trim()) throw new Error("docs-mark: provide {docId,text} JSON");
    await cmdDocsMark(jsonText);
  } else if (cmd === "upsert") {
    const arg = process.argv[3];
    const jsonText = arg && arg.trim() ? arg : await readStdin();
    if (!jsonText || !jsonText.trim()) throw new Error("upsert: provide item JSON as an argument or on stdin");
    await cmdUpsert(jsonText);
  } else if (cmd === "brief") {
    await cmdBrief();
  } else if (cmd === "delete") {
    const ids = process.argv.slice(3).flatMap((a) => a.split(",")).map((x) => x.trim()).filter(Boolean);
    if (!ids.length) throw new Error("delete: provide one or more task ids");
    await cmdDelete(ids);
  } else if (cmd === "state-get") {
    if (!process.argv[3]) throw new Error("state-get: provide a key");
    await cmdStateGet(process.argv[3]);
  } else if (cmd === "state-set" || cmd === "state-append") {
    // usage: state-set <key> < value   |   state-append <key> < line(s)
    if (!process.argv[3]) throw new Error(cmd + ": provide a key (value on stdin)");
    const val = (await readStdin()).replace(/\s+$/, "");
    await cmdStateSet(process.argv[3], val, cmd === "state-append");
  } else if (cmd === "state-prune") {
    await cmdStatePrune(Number(process.argv[3]) || 7, Number(process.argv[4]) || 14);
  } else if (cmd === "show") {
    await cmdShow(process.argv[3]);
  } else if (cmd === "match") {
    const arg = process.argv[3];
    const jsonText = arg && arg.trim() ? arg : await readStdin();
    if (!jsonText || !jsonText.trim()) throw new Error("match: provide {task,sourceUrls} JSON as an argument or on stdin");
    await cmdMatch(jsonText);
  } else if (cmd === "log") {
    await appendLog({ action: "note", note: process.argv.slice(3).join(" ") });
    process.stdout.write(JSON.stringify({ logged: true }) + "\n");
  } else if (cmd === "stage-draft") {
    const arg = process.argv[3];
    const jsonText = arg && arg.trim() ? arg : await readStdin();
    if (!jsonText || !jsonText.trim()) throw new Error("stage-draft: provide draft JSON as an argument or on stdin");
    await cmdStageDraft(jsonText);
  } else if (cmd === "promote") {
    await cmdPromote();
  } else {
    process.stderr.write("usage: cli.js <context | brief | show <id> | state-get <k> | state-set <k> | state-append <k> | state-prune [days] [lineDays] | delete <id,...> | match '<json>' | upsert '<json>' | log <msg> | docs-scan | docs-mark '<json>' | gmail2-scan | gmail2-inbox [n] | gmail2-archive <id,...> | gmail2-draft <id> | gmail2-relabel <id> | plan>\n");
    process.exit(2);
  }
}

main().catch((e) => {
  process.stderr.write(`cli error: ${e.message}\n`);
  process.exit(1);
});
