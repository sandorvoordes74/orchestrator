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
// Tabs the TODO scan never reads: the facts tab, anything that looks like it holds secrets,
// and the comma-separated titles in DOCS_SKIP_TABS.
function _skipTab(title) {
  const t = String(title || "").trim().toLowerCase();
  const extra = (process.env.DOCS_SKIP_TABS || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  return t === (process.env.PA_FACTS_TAB || "PA").toLowerCase()
    || extra.includes(t)
    || /\b(keys?|passwords?|wachtwoorden|wachtwoord|secrets?|credentials?)\b/i.test(t);
}

function _allTabs(tabs, out = []) {
  for (const t of tabs || []) {
    out.push(t);
    _allTabs(t.childTabs, out);
  }
  return out;
}

// TODO lines from every tab of the doc (minus the skipped ones). Items carry the tab title
// and id; items from the first tab look exactly as before.
async function listTodoItems(docId) {
  const docs = getDocsClient();
  const res = await docs.documents.get({ documentId: docId, includeTabsContent: true });
  const data = res.data || res;
  const tabs = data.tabs ? _allTabs(data.tabs) : [{ tabProperties: { tabId: "t.0", title: "" }, documentTab: { body: data.body } }];
  const items = [];
  tabs.forEach((tab, ti) => {
    const title = (tab.tabProperties || {}).title || "";
    if (_skipTab(title)) return;
    const paras = [];
    for (const el of ((tab.documentTab || {}).body || {}).content || []) {
      if (!el.paragraph) continue;
      const els = el.paragraph.elements || [];
      const text = els.map((e) => (e.textRun && e.textRun.content) || "").join("").replace(/\n+$/, "");
      const b = el.paragraph.bullet;
      paras.push({ els, text, level: b ? (b.nestingLevel || 0) : -1 });
    }
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
      items.push({ text, taskText, children, links: [...new Set(links)], tab: title, tabId: tab.tabProperties.tabId, firstTab: ti === 0 });
    }
  });
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

// ---- PA facts --------------------------------------------------------------------------
// Background facts about the family, work, school, hobbies and people live in one tab of a
// Google Doc (default: the tab "PA" of the first doc in GOOGLE_DOCS; override with
// PA_FACTS_DOC / PA_FACTS_TAB). The assistant reads it every run and appends new facts the
// owner tells it, as "- fact" lines under a section heading.

// The same doc can hold a second tab with the rules the owner taught the assistant
// (PA_RULES_TAB, default "PA rules"); every function below takes an optional tab title.
const rulesTabTitle = () => process.env.PA_RULES_TAB || "PA rules";

function _factsLocation(tab) {
  const { GOOGLE_DOCS } = require("./config");
  const docId = docIdFromUrl(process.env.PA_FACTS_DOC || GOOGLE_DOCS[0] || "");
  if (!docId) throw new Error("facts: set PA_FACTS_DOC or GOOGLE_DOCS");
  return { docId, tabTitle: tab || process.env.PA_FACTS_TAB || "PA" };
}

async function _factsTab(title) {
  const { docId, tabTitle } = _factsLocation(title);
  const res = await getDocsClient().documents.get({ documentId: docId, includeTabsContent: true });
  const find = (tabs) => {
    for (const t of tabs || []) {
      if ((t.tabProperties || {}).title === tabTitle) return t;
      const c = find(t.childTabs);
      if (c) return c;
    }
    return null;
  };
  const tab = find((res.data || res).tabs);
  if (!tab) throw new Error(`facts: no tab named '${tabTitle}' in the doc`);
  const paras = ((tab.documentTab && tab.documentTab.body.content) || [])
    .filter((el) => el.paragraph)
    .map((el) => ({
      text: paragraphText(el).replace(/\n$/, ""),
      heading: /^(HEADING|TITLE)/.test((el.paragraph.paragraphStyle || {}).namedStyleType || ""),
      start: el.startIndex,
      end: el.endIndex,
    }));
  return { docId, tabId: tab.tabProperties.tabId, tabTitle, paras };
}

async function readFacts(tab) {
  const { tabTitle, paras } = await _factsTab(tab);
  return { tab: tabTitle, text: paras.map((p) => (p.heading && p.text ? `## ${p.text}` : p.text)).join("\n").trim() };
}

// The one fact line ("- ...") containing <part>; intro text and headings never match, and
// the part must be specific enough (>= 8 characters) to point at a single fact.
function _factLine(paras, part, cmd) {
  const want = String(part || "").trim().toLowerCase();
  if (want.length < 8) throw new Error(`${cmd}: give a longer part of the fact (at least 8 characters)`);
  const hits = paras.filter((p) => !p.heading && /^\s*-\s/.test(p.text) && p.text.toLowerCase().includes(want));
  if (hits.length !== 1) throw new Error(`${cmd}: matches ${hits.length} fact lines - give a part of exactly one fact`);
  return hits[0];
}

// Append "- <fact>" at the end of <section> (created at the end of the tab when missing).
// With `replaces` (a distinctive part of one existing fact line) that line is rewritten in
// place instead, for a fact that changed (a new school year, a new club).
async function addFact(section, fact, replaces, tab) {
  const clean = String(fact || "").replace(/^\s*[-*\u2022]\s*/, "").trim();
  const sec = String(section || "").trim();
  if (!clean || (!sec && !replaces)) throw new Error("facts-add: give a section and a fact");
  const { docId, tabId, paras } = await _factsTab(tab);
  const line = `- ${clean}`; // never starts with "TODO", so the TODO scan ignores it
  if (replaces) {
    const p = _factLine(paras, replaces, "facts-add 'replaces'");
    if (paras.some((q) => q !== p && q.text.toLowerCase().includes(clean.toLowerCase()))) return { added: false, reason: "already known" };
    const requests = [
      { deleteContentRange: { range: { startIndex: p.start, endIndex: p.end - 1, tabId } } },
      { insertText: { location: { index: p.start, tabId }, text: line } },
    ];
    await getDocsClient().documents.batchUpdate({ documentId: docId, requestBody: { requests } });
    return { added: true, replaced: p.text, fact: clean };
  }
  if (paras.some((p) => p.text.toLowerCase().includes(clean.toLowerCase()))) return { added: false, reason: "already known" };
  const h = paras.findIndex((p) => p.heading && p.text.trim().toLowerCase() === sec.toLowerCase());
  const requests = [];
  if (h >= 0) {
    let last = h;
    while (last + 1 < paras.length && !paras[last + 1].heading) last++;
    const at = paras[last].end - 1;
    requests.push({ insertText: { location: { index: at, tabId }, text: `\n${line}` } });
    requests.push({ updateParagraphStyle: { range: { startIndex: at + 1, endIndex: at + 1 + line.length + 1, tabId }, paragraphStyle: { namedStyleType: "NORMAL_TEXT" }, fields: "namedStyleType" } });
  } else {
    const at = paras[paras.length - 1].end - 1;
    requests.push({ insertText: { location: { index: at, tabId }, text: `\n${sec}\n${line}` } });
    requests.push({ updateParagraphStyle: { range: { startIndex: at + 1, endIndex: at + 1 + sec.length + 1, tabId }, paragraphStyle: { namedStyleType: "HEADING_3" }, fields: "namedStyleType" } });
    const ls = at + 1 + sec.length + 1;
    requests.push({ updateParagraphStyle: { range: { startIndex: ls, endIndex: ls + line.length + 1, tabId }, paragraphStyle: { namedStyleType: "NORMAL_TEXT" }, fields: "namedStyleType" } });
  }
  await getDocsClient().documents.batchUpdate({ documentId: docId, requestBody: { requests } });
  return { added: true, section: sec, fact: clean, newSection: h < 0 };
}

// Remove the one fact line containing <part> (an answered 'Still unknown' question, a fact
// that is no longer true).
async function removeFact(part, tab) {
  const { docId, tabId, paras } = await _factsTab(tab);
  const p = _factLine(paras, part, "facts-remove");
  // Take the newline before the line with it, so no empty paragraph is left behind.
  const range = { startIndex: p.start - 1, endIndex: p.end - 1, tabId };
  await getDocsClient().documents.batchUpdate({ documentId: docId, requestBody: { requests: [{ deleteContentRange: { range } }] } });
  return { removed: p.text };
}

// Create a tab (title + intro paragraph) in the facts doc when it does not exist yet.
async function ensureTab(title, intro) {
  const { docId } = _factsLocation(title);
  try { await _factsTab(title); return { created: false, tab: title }; } catch (e) { if (!/no tab named/.test(e.message)) throw e; }
  const docs = getDocsClient();
  const r = await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests: [{ addDocumentTab: { tabProperties: { title } } }] } });
  const tabId = ((r.data || r).replies || [])[0].addDocumentTab.tabProperties.tabId;
  if (intro) await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests: [{ insertText: { location: { index: 1, tabId }, text: intro } }] } });
  return { created: true, tab: title };
}

module.exports = { getDocsClient, docIdFromUrl, docUrl, listTodoItems, markListed, readFacts, addFact, removeFact, ensureTab, rulesTabTitle };
