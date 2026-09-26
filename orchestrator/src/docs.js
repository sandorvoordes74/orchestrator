"use strict";

// Google Docs source: read `TODO` / `TODO:` lines from configured docs and flip them to
// `LISTED` after processing. Uses the same service account as the sheet (each
// doc must be shared with the SA, and the Docs API enabled in the project).

const G = require("./google");
const { saToken } = require("./sheets");
const { SCOPES } = require("./config");

function getDocsClient() {
  return G.docsClient(saToken || (() => G.saAccessToken(SCOPES)));
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

// A TODO line: starts with "TODO" followed by ":" or whitespace (case-insensitive),
// e.g. "TODO: pay invoice" or "TODO Pay invoice". A TODO line ending in ":" owns the
// bullet list directly below it (its children are folded into the item's text).
const TODO_RE = /^\s*TODO(?::|\s)\s*/i;

function paraLinks(els, text) {
  const links = [];
  for (const e of els) {
    const u = e.textRun && e.textRun.textStyle && e.textRun.textStyle.link && e.textRun.textStyle.link.url;
    if (u) links.push(u);
  }
  for (const m of text.matchAll(/https?:\/\/[^\s)>\]]+/g)) links.push(m[0]);
  return links;
}

// Each item includes any links in the line(s) (both real hyperlinks and bare URLs).
async function listTodoItems(docId) {
  const docs = getDocsClient();
  const res = await docs.documents.get({ documentId: docId });
  const paras = [];
  for (const el of res.data.body?.content || []) {
    if (!el.paragraph) continue;
    const els = el.paragraph.elements || [];
    const text = els.map((e) => (e.textRun && e.textRun.content) || "").join("").replace(/\n+$/, "");
    const b = el.paragraph.bullet;
    paras.push({ els, text, level: b ? (b.nestingLevel || 0) : -1 });
  }
  const items = [];
  for (let i = 0; i < paras.length; i++) {
    const { els, text, level } = paras[i];
    if (!TODO_RE.test(text)) continue;
    const links = paraLinks(els, text);
    const children = [];
    if (/:\s*$/.test(text)) {
      for (let j = i + 1; j < paras.length; j++) {
        const c = paras[j];
        if (c.level <= level || TODO_RE.test(c.text) || !c.text.trim()) break;
        children.push(c.text.trim());
        links.push(...paraLinks(c.els, c.text));
      }
    }
    let taskText = text.replace(TODO_RE, "").trim();
    if (children.length) taskText = taskText.replace(/:\s*$/, "") + ": " + children.join(", ");
    items.push({ text, taskText, children, links: [...new Set(links)] });
  }
  return items;
}

// Flip a specific line's leading "TODO" to "LISTED" so it isn't reprocessed
// ("TODO: x" -> "LISTED: x", "TODO x" -> "LISTED x").
async function markListed(docId, text) {
  const replaceText = text.replace(/^(\s*)TODO(?=:|\s)/i, "$1LISTED");
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
