"use strict";

// Google Docs source: read `TODO:` lines from configured docs and flip them to
// `LISTED:` after processing. Uses the same service account as the sheet (each
// doc must be shared with the SA, and the Docs API enabled in the project).

const { google } = require("googleapis");
const { getAuth } = require("./sheets");

function getDocsClient() {
  return google.docs({ version: "v1", auth: getAuth() });
}

// Accept a full Docs URL or a bare document id.
function docIdFromUrl(s) {
  const m = String(s).match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : String(s).trim();
}
function docUrl(id) {
  return `https://docs.google.com/document/d/${id}/edit`;
}

function paragraphText(el) {
  if (!el.paragraph) return null;
  return (el.paragraph.elements || []).map((e) => (e.textRun && e.textRun.content) || "").join("");
}

// Every paragraph whose text starts with "TODO:" (after optional whitespace).
// Each item includes any links in the line (both real hyperlinks and bare URLs).
async function listTodoItems(docId) {
  const docs = getDocsClient();
  const res = await docs.documents.get({ documentId: docId });
  const items = [];
  for (const el of res.data.body?.content || []) {
    if (!el.paragraph) continue;
    const els = el.paragraph.elements || [];
    const text = els.map((e) => (e.textRun && e.textRun.content) || "").join("").replace(/\n+$/, "");
    if (!/^\s*TODO:/.test(text)) continue;
    const links = [];
    for (const e of els) {
      const u = e.textRun && e.textRun.textStyle && e.textRun.textStyle.link && e.textRun.textStyle.link.url;
      if (u) links.push(u);
    }
    for (const m of text.matchAll(/https?:\/\/[^\s)>\]]+/g)) links.push(m[0]);
    items.push({ text, taskText: text.replace(/^\s*TODO:\s*/, "").trim(), links: [...new Set(links)] });
  }
  return items;
}

// Flip a specific line's "TODO:" to "LISTED:" so it isn't reprocessed.
async function markListed(docId, text) {
  const replaceText = text.replace("TODO:", "LISTED:");
  if (replaceText === text) return { updated: false, reason: "no-TODO-prefix" };
  const docs = getDocsClient();
  const res = await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: { requests: [{ replaceAllText: { containsText: { text, matchCase: true }, replaceText } }] },
  });
  const n = res.data.replies?.[0]?.replaceAllText?.occurrencesChanged || 0;
  return { updated: n > 0, occurrences: n };
}

module.exports = { getDocsClient, docIdFromUrl, docUrl, listTodoItems, markListed };
