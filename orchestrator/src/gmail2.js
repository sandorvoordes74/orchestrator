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

// One private thread with its messages (for task triage: what happened since?).
// Accepts a thread id or a Gmail permalink containing it.
async function getThread(idOrUrl) {
  const g = gmail();
  const id = String(idOrUrl).split(/[#/]/).filter(Boolean).pop().split("?")[0];
  const t = await g.users.threads.get({ userId: "me", id, format: "full" });
  const msgs = (t.data.messages || []).map((m) => {
    const texts = [];
    collectText(m.payload, texts);
    return {
      from: header(m.payload.headers, "From"),
      to: header(m.payload.headers, "To"),
      date: header(m.payload.headers, "Date"),
      subject: header(m.payload.headers, "Subject"),
      labels: m.labelIds || [],
      text: texts.filter((x) => x.mt === "text/plain").map((x) => x.text).join("\n").slice(0, 1500),
    };
  });
  return { threadId: id, messages: msgs.slice(-6), messageCount: msgs.length };
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
  const email = (await g.users.getProfile({ userId: "me" })).data.emailAddress;
  const q = "in:inbox -label:todo -label:listed";
  const list = await g.users.threads.list({ userId: "me", q, maxResults: max });
  const threads = list.data.threads || [];
  const items = [];
  for (const th of threads) {
    const t = await g.users.threads.get({ userId: "me", id: th.id, format: "metadata" });
    const msgs = t.data.messages || [];
    const last = msgs[msgs.length - 1] || { payload: {} };
    items.push({
      threadId: th.id,
      permalink: `https://mail.google.com/mail/u/0/?authuser=${encodeURIComponent(email)}#all/${th.id}`,
      subject: header(last.payload.headers, "Subject") || "(no subject)",
      from: header(last.payload.headers, "From"),
      date: header(last.payload.headers, "Date"),
      snippet: (last.snippet || "").slice(0, 160),
      unread: (last.labelIds || []).includes("UNREAD"),
      messages: msgs.length,
    });
  }
  // Exact inbox totals (all inbox threads, incl. todo/listed) from the INBOX label counters.
  const inbox = (await g.users.labels.get({ userId: "me", id: "INBOX" })).data || {};
  return { query: q, inboxTotal: inbox.threadsTotal, inboxUnread: inbox.threadsUnread, estimate: list.data.resultSizeEstimate || threads.length, shown: items.length, items };
}

// Archive a thread (remove it from the inbox; reversible - it stays in All Mail).
async function archive(threadId) {
  const g = gmail();
  await g.users.threads.modify({ userId: "me", id: threadId, requestBody: { removeLabelIds: ["INBOX"] } });
  return { archived: true, threadId };
}

// Create a REPLY DRAFT in an existing private-mailbox thread (never sends). The owner
// reviews and sends it himself from Gmail. Replies to the sender of the last message.
async function draftReply(threadId, text) {
  const g = gmail();
  const self = (await g.users.getProfile({ userId: "me" })).data.emailAddress;
  const t = await g.users.threads.get({ userId: "me", id: threadId, format: "metadata" });
  const msgs = t.data.messages || [];
  const last = [...msgs].reverse().find((m) => !header(m.payload.headers, "From").includes(self)) || msgs[msgs.length - 1];
  if (!last) throw new Error("draftReply: thread has no messages");
  const hs = last.payload.headers;
  const to = header(hs, "Reply-To") || header(hs, "From");
  const subj = header(hs, "Subject") || "";
  const msgId = header(hs, "Message-ID") || header(hs, "Message-Id");
  const refs = [header(hs, "References"), msgId].filter(Boolean).join(" ");
  const b64w = (x) => Buffer.from(x, "utf8").toString("base64");
  const raw = [
    `From: ${self}`, `To: ${to}`,
    `Subject: =?UTF-8?B?${b64w(/^re:/i.test(subj) ? subj : "Re: " + subj)}?=`,
    ...(msgId ? [`In-Reply-To: ${msgId}`, `References: ${refs}`] : []),
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64",
    "", b64w(text || ""),
  ].join("\r\n");
  const rawB64url = Buffer.from(raw, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const r = await g.users.drafts.create({ userId: "me", requestBody: { message: { raw: rawB64url, threadId } } });
  return { drafted: true, draftId: r.data.id, threadId, to };
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

module.exports = { isConfigured, listTodo, relabel, sendMail, inboxOverview, archive, draftReply, getThread };
