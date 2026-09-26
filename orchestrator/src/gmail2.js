"use strict";

// Second mailbox (private Gmail) via the Gmail API + an OAuth refresh token —
// because the claude.ai Gmail connector only covers the work account. All creds
// come from env vars on the routine:
//   GMAIL2_CLIENT_ID, GMAIL2_CLIENT_SECRET, GMAIL2_REFRESH_TOKEN
// Same tag-driven flow: read label:todo, then relabel todo->listed.

const G = require("./google");

function isConfigured() {
  return !!(process.env.GMAIL2_CLIENT_ID && process.env.GMAIL2_CLIENT_SECRET && process.env.GMAIL2_REFRESH_TOKEN);
}

function gmail() {
  return G.gmailClient(() => G.refreshAccessToken(
    process.env.GMAIL2_CLIENT_ID, process.env.GMAIL2_CLIENT_SECRET, process.env.GMAIL2_REFRESH_TOKEN));
}

const header = (hs, n) => ((hs || []).find((h) => h.name.toLowerCase() === n.toLowerCase()) || {}).value || "";
const b64 = (s) => Buffer.from(String(s || "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

function collectText(payload, acc) {
  if (!payload) return;
  if (payload.body && payload.body.data && (payload.mimeType || "").startsWith("text/")) {
    acc.push({ mt: payload.mimeType, text: b64(payload.body.data) });
  }
  for (const p of payload.parts || []) collectText(p, acc);
}

function extractLinks(texts) {
  const links = [];
  for (const { mt, text } of texts) {
    if (mt === "text/html") for (const m of text.matchAll(/href=["']([^"']+)["']/gi)) links.push(m[1]);
    for (const m of text.matchAll(/https?:\/\/[^\s"'<>)]+/g)) links.push(m[0]);
  }
  return [...new Set(links.filter((u) => /^https?:\/\//.test(u)))];
}

async function ensureLabels(g) {
  const r = await g.users.labels.list({ userId: "me" });
  const labels = r.data.labels || [];
  const todo = labels.find((l) => l.name.toLowerCase() === "todo");
  let listed = labels.find((l) => l.name.toLowerCase() === "listed");
  if (!listed) {
    const c = await g.users.labels.create({
      userId: "me",
      requestBody: { name: "listed", labelListVisibility: "labelShow", messageListVisibility: "show" },
    });
    listed = c.data;
  }
  return { todoId: todo && todo.id, listedId: listed.id };
}

async function listTodo() {
  const g = gmail();
  const email = (await g.users.getProfile({ userId: "me" })).data.emailAddress;
  const { todoId, listedId } = await ensureLabels(g);
  if (!todoId) return { email, todoId: null, listedId, items: [] };
  const list = await g.users.threads.list({ userId: "me", q: "label:todo", maxResults: 50 });
  const items = [];
  for (const th of list.data.threads || []) {
    const t = await g.users.threads.get({ userId: "me", id: th.id, format: "full" });
    const msgs = t.data.messages || [];
    const last = msgs[msgs.length - 1] || { payload: {} };
    const texts = [];
    for (const m of msgs) collectText(m.payload, texts);
    items.push({
      threadId: th.id,
      subject: header(last.payload.headers, "Subject") || "(no subject)",
      from: header(last.payload.headers, "From"),
      bodyText: texts.filter((x) => x.mt === "text/plain").map((x) => x.text).join("\n").slice(0, 4000),
      permalink: `https://mail.google.com/mail/u/0/?authuser=${encodeURIComponent(email)}#all/${th.id}`,
      links: extractLinks(texts),
    });
  }
  return { email, todoId, listedId, items };
}

async function relabel(threadId) {
  const g = gmail();
  const { todoId, listedId } = await ensureLabels(g);
  await g.users.threads.modify({
    userId: "me",
    id: threadId,
    requestBody: { addLabelIds: [listedId], removeLabelIds: todoId ? [todoId] : [] },
  });
  return { updated: true };
}

// Read-only overview of the private inbox backlog: threads still in the inbox that are
// neither tagged todo nor already listed. Used by the day program to size an
// inbox-processing block. Headers only (no bodies).
async function inboxOverview(max = 25) {
  const g = gmail();
  const q = "in:inbox -label:todo -label:listed";
  const list = await g.users.threads.list({ userId: "me", q, maxResults: max });
  const threads = list.data.threads || [];
  const items = [];
  for (const th of threads) {
    const t = await g.users.threads.get({ userId: "me", id: th.id, format: "metadata" });
    const msgs = t.data.messages || [];
    const last = msgs[msgs.length - 1] || { payload: {} };
    items.push({
      subject: header(last.payload.headers, "Subject") || "(no subject)",
      from: header(last.payload.headers, "From"),
      date: header(last.payload.headers, "Date"),
      unread: (last.labelIds || []).includes("UNREAD"),
      messages: msgs.length,
    });
  }
  return { query: q, estimate: list.data.resultSizeEstimate || threads.length, shown: items.length, items };
}

// Send a plain-text email from the private mailbox (gmail.modify allows sending).
// `to` defaults to the mailbox's own address.
async function sendMail({ to, subject, text }) {
  const g = gmail();
  const self = (await g.users.getProfile({ userId: "me" })).data.emailAddress;
  const rcpt = to || self;
  const b64w = (s) => Buffer.from(s, "utf8").toString("base64");
  const raw = [
    `From: ${self}`, `To: ${rcpt}`,
    `Subject: =?UTF-8?B?${b64w(subject || "(no subject)")}?=`,
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64",
    "", b64w(text || ""),
  ].join("\r\n");
  const rawB64url = Buffer.from(raw, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const r = await g.users.messages.send({ requestBody: { raw: rawB64url } });
  return { sent: true, to: rcpt, id: r.data.id };
}

module.exports = { isConfigured, listTodo, relabel, sendMail, inboxOverview };
