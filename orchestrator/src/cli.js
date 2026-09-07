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

// Find existing tasks a candidate item likely "links up" with, so the agent can
// append instead of creating a near-duplicate. Ranks by shared URLs / domains /
// doc+thread ids AND significant-word overlap of the titles. Input JSON: {task, sourceUrls[]}.
const _STOP = new Set("the a an of to for and or in on at with from by is are be as your you our we it this that these those re fw fwd task todo please pls check make get plan do new update via about into over per".split(" "));
function _words(s) {
  return [...new Set(String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !_STOP.has(w)))];
}
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
  const candWords = _words(d.task);
  const candUrls = (d.sourceUrls || []).map((u) => String(u).trim()).filter(Boolean);
  const candUrlSet = new Set(candUrls);
  const candKeys = new Set(); for (const u of candUrls) for (const k of _urlIdKeys(u)) candKeys.add(k);

  const { tasks } = await getTasks();
  // Per-task id-key sets + document frequency, so a key shared by MANY tasks (e.g. one
  // Google Doc's id across all its TODO lines) is discounted; a rare/unique id counts.
  const taskKeys = tasks.map((t) => { const s = new Set(); for (const u of (t.context || "").split("\n")) for (const k of _urlIdKeys(u.trim())) s.add(k); return s; });
  const df = {}; taskKeys.forEach((s) => s.forEach((k) => { df[k] = (df[k] || 0) + 1; }));

  const scored = tasks.map((t, i) => {
    const tUrls = (t.context || "").split("\n").map((x) => x.trim()).filter(Boolean);
    const sharedUrls = tUrls.filter((u) => candUrlSet.has(u)).length;
    let keyScore = 0; const sharedKeys = [];
    for (const k of candKeys) if (taskKeys[i].has(k)) { keyScore += 1 / df[k]; if (df[k] <= 4) sharedKeys.push(k); }
    const tw = _words(t.task);
    const shared = tw.filter((w) => candWords.includes(w));
    const denom = new Set([...tw, ...candWords]).size || 1;
    const wordJaccard = shared.length / denom;
    // Exact URL match is strongest; rare shared ids next; word overlap catches
    // cross-source relations (same client/person/deliverable in a different channel).
    const score = sharedUrls * 1.2 + keyScore * 1.0 + wordJaccard * 0.9;
    return { id: t.id, task: t.task, label: t.label, taskType: t.taskType, deadline: t.deadline || "", reviewDate: t.reviewDate || "", commitDate: t.commitDate || "", energy: t.energy || "", location: t.location || "", score: +score.toFixed(3), sharedUrls, sharedIdKeys: sharedKeys.length, sharedWords: shared };
  }).filter((c) => c.score > 0.2 || c.sharedUrls > 0)
    .sort((a, b) => b.score - a.score).slice(0, 6);
  process.stdout.write(JSON.stringify({ candidates: scored }, null, 2) + "\n");
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
// energy (LOW|MEDIUM|HIGH), location (ANYWHERE|HOME|OFFICE|OUT|CALLS), deadline, reviewDate,
// commitDate, taskType (WORK|PRIVATE), sourceUrls[], appendToId?, updatedTitle?, fieldUpdates?
//  - On APPEND: updatedTitle rewrites the existing task's title; fieldUpdates {deadline,
//    reviewDate, commitDate, importance, urgency, effort, energy, location, taskType, label}
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
      sourceUrls: urls, taskType: d.taskType, energy: d.energy, location: d.location,
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

// List every `TODO:` line across the configured Google Docs, for the agent to enrich.
async function cmdDocsScan() {
  const { GOOGLE_DOCS } = require("./config");
  const { docIdFromUrl, docUrl, listTodoItems } = require("./docs");
  const out = [];
  for (const entry of GOOGLE_DOCS) {
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

// Flip a processed line's TODO: -> LISTED: in its doc. Input JSON: {docId, text}.
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
  if (cmd === "context") {
    await cmdContext();
  } else if (cmd === "gmail2-scan") {
    await cmdGmail2Scan();
  } else if (cmd === "gmail2-relabel") {
    const id = process.argv[3];
    if (!id) throw new Error("gmail2-relabel: provide a threadId");
    await cmdGmail2Relabel(id);
  } else if (cmd === "docs-scan") {
    await cmdDocsScan();
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
    process.stderr.write("usage: cli.js <context | match '<json>' | upsert '<json>' | log <msg> | docs-scan | docs-mark '<json>' | gmail2-scan | gmail2-relabel <id>>\n");
    process.exit(2);
  }
}

main().catch((e) => {
  process.stderr.write(`cli error: ${e.message}\n`);
  process.exit(1);
});
