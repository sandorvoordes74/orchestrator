"use strict";

// Smart home via Athom's official Homey MCP server, called directly from code (no claude.ai
// connector needed). Auth is OAuth with the owner's Homey account: a one-time local sign-in
// (node scripts/homey-login.js) registers a client and yields a refresh token. Everything
// comes from env vars - never from code:
//
//   HOMEY_CLIENT_ID / HOMEY_CLIENT_SECRET  client registered by the sign-in script
//   HOMEY_REFRESH_TOKEN                    refresh token from the sign-in
//   HOMEY_TOKEN_KEY                        32-byte base64 key to encrypt the token cache
//   HOMEY_MCP_URL                          (optional) override of the public MCP server
//
// The cloud environment cannot update its own env vars, so the current access token and
// (if the server rotates them) the newest refresh token are cached ENCRYPTED (AES-256-GCM
// with HOMEY_TOKEN_KEY) through a small store the caller provides - the sheet only ever
// holds ciphertext.

const https = require("https");
const crypto = require("crypto");

const BASE = (process.env.HOMEY_MCP_URL || "https://mcp.athom.com").replace(/\/+$/, "");
const PROTOCOL = "2025-06-18";

// Tools that change the Homey set-up itself (flows, device names, zones) are never called
// from the routine, whatever the prompt says.
const BLOCKED = /(create|update|delete|remove|rename|move)/i;
// Capabilities the routine never sets (locks, home alarm, cameras), even when asked.
const BLOCKED_CAPS = /^(locked|homealarm_state|camera)/i;

function isConfigured() {
  return ["HOMEY_CLIENT_ID", "HOMEY_CLIENT_SECRET", "HOMEY_REFRESH_TOKEN", "HOMEY_TOKEN_KEY"].every((k) => process.env[k]);
}

function _http(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(new URL(url), { method, headers: { ...headers, ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}) }, timeout: 60000 }, (res) => {
      let c = "";
      res.on("data", (d) => (c += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: c }));
    });
    req.on("timeout", () => req.destroy(new Error("homey: timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---- OAuth -----------------------------------------------------------------------------

async function tokenRequest(params, clientId, clientSecret) {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const r = await _http("POST", `${BASE}/oauth2/token`, {
    Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json",
  }, new URLSearchParams(params).toString());
  let j = {};
  try { j = JSON.parse(r.text); } catch (_) { /* not JSON */ }
  if (r.status !== 200 || !j.access_token) {
    const err = new Error(`homey token ${r.status}: ${j.error || ""} ${j.error_description || r.text.slice(0, 200)}`.trim());
    err.oauthError = j.error || null;
    throw err;
  }
  return j;
}

function _key() {
  const k = Buffer.from(process.env.HOMEY_TOKEN_KEY || "", "base64");
  if (k.length !== 32) throw new Error("homey: HOMEY_TOKEN_KEY must be 32 bytes, base64");
  return k;
}
function _encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", _key(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return "v1:" + Buffer.concat([iv, c.getAuthTag(), data]).toString("base64");
}
function _decrypt(text) {
  if (!text || !String(text).startsWith("v1:")) return null;
  try {
    const b = Buffer.from(String(text).slice(3), "base64");
    const d = crypto.createDecipheriv("aes-256-gcm", _key(), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8"));
  } catch (_) {
    return null; // other key or damaged - fall back to the env refresh token
  }
}

// store = { get: async () => string|null, set: async (string) => void }
async function accessToken(store) {
  const id = process.env.HOMEY_CLIENT_ID, secret = process.env.HOMEY_CLIENT_SECRET;
  const cached = store ? _decrypt(await store.get()) : null;
  if (cached && cached.accessToken && cached.expiresAt - Date.now() > 60000) return cached.accessToken;
  const candidates = [...new Set([cached && cached.refreshToken, process.env.HOMEY_REFRESH_TOKEN].filter(Boolean))];
  let lastErr;
  for (const rt of candidates) {
    try {
      const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: rt }, id, secret);
      const next = {
        accessToken: t.access_token,
        expiresAt: Date.now() + (Number(t.expires_in) || 3600) * 1000,
        refreshToken: t.refresh_token || rt, // rotating servers return a new one
      };
      if (store) await store.set(_encrypt(next));
      return next.accessToken;
    } catch (e) {
      lastErr = e;
      if (e.oauthError !== "invalid_grant") break; // only a dead refresh token is worth a second try
    }
  }
  throw new Error(`${lastErr.message} - sign in again with scripts/homey-login.js`);
}

// ---- MCP (streamable HTTP, JSON-RPC) ----------------------------------------------------

function _parse(r, id) {
  const ct = String(r.headers["content-type"] || "");
  let msgs = [];
  if (ct.includes("text/event-stream")) {
    for (const line of r.text.split(/\r?\n/)) {
      if (line.startsWith("data:")) { try { msgs.push(JSON.parse(line.slice(5).trim())); } catch (_) { /* keep-alive */ } }
    }
  } else if (r.text.trim()) {
    const j = JSON.parse(r.text);
    msgs = Array.isArray(j) ? j : [j];
  }
  const m = msgs.find((x) => x && x.id === id) || msgs[0];
  if (!m) throw new Error(`homey MCP: empty response (HTTP ${r.status})`);
  if (m.error) throw new Error(`homey MCP error ${m.error.code}: ${m.error.message}`);
  return m.result;
}

async function connect(token) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  let n = 0;
  const send = async (method, params, notify) => {
    const msg = notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++n, method, params };
    const r = await _http("POST", `${BASE}/`, headers, JSON.stringify(msg));
    if (r.status === 401) throw new Error("homey MCP: unauthorized (token rejected)");
    if (r.status >= 400) throw new Error(`homey MCP HTTP ${r.status}: ${r.text.slice(0, 200)}`);
    if (r.headers["mcp-session-id"]) headers["Mcp-Session-Id"] = r.headers["mcp-session-id"];
    return notify ? null : _parse(r, msg.id);
  };
  const init = await send("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "orchestrator", version: "1.0" } });
  headers["MCP-Protocol-Version"] = init.protocolVersion || PROTOCOL;
  await send("notifications/initialized", {}, true);
  return {
    server: init.serverInfo || null,
    listTools: async () => (await send("tools/list", {})).tools || [],
    callTool: async (name, args) => send("tools/call", { name, arguments: args || {} }),
  };
}

async function listTools(store) {
  const s = await connect(await accessToken(store));
  return (await s.listTools()).map((t) => ({
    name: t.name,
    blocked: BLOCKED.test(t.name),
    description: String(t.description || "").slice(0, 300),
    args: Object.keys((t.inputSchema && t.inputSchema.properties) || {}),
  }));
}

async function callTool(store, name, args) {
  if (!name) throw new Error("homey: give a tool name (see homey-tools)");
  if (BLOCKED.test(name)) throw new Error(`homey: tool '${name}' changes the Homey set-up and is blocked`);
  for (const caps of Object.values((args && args.state) || {})) {
    const bad = Object.keys(caps || {}).find((c) => BLOCKED_CAPS.test(c));
    if (bad) throw new Error(`homey: capability '${bad}' (locks, alarm, cameras) is blocked`);
  }
  const s = await connect(await accessToken(store));
  const r = await s.callTool(name, args);
  // MCP tool results are content blocks; return the text (often JSON) plus the error flag.
  const text = (r.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return { tool: name, isError: Boolean(r.isError), result: _json(text) };
}

// Tool texts are often a sentence followed by JSON - return the JSON part when there is one.
function _json(text) {
  const i = text.search(/[[{]/);
  if (i >= 0) { try { return JSON.parse(text.slice(i)); } catch (_) { /* not JSON */ } }
  return text;
}

// Compact view of the home for the briefing (one list_devices call): what is on, open,
// low on battery, and the thermostats.
async function status(store) {
  const r = await callTool(store, "list_devices", {});
  const list = Array.isArray(r.result) ? r.result : Object.values(r.result || {});
  const devices = list.filter((d) => d && typeof d === "object");
  const tag = (d) => `${d.name}${d.zone ? " (" + d.zone + ")" : ""}`;
  const st = (d) => d.state || {};
  return {
    configured: true,
    devices: devices.length,
    on: devices.filter((d) => st(d).onoff === true).map(tag),
    open: devices.filter((d) => st(d).alarm_contact === true).map(tag),
    lowBattery: devices.filter((d) => st(d).alarm_battery === true || (typeof st(d).measure_battery === "number" && st(d).measure_battery <= 15)).map(tag),
    thermostats: devices.filter((d) => st(d).target_temperature != null).map((d) => ({
      device: tag(d), target: st(d).target_temperature, measured: st(d).measure_temperature ?? null, mode: st(d).thermostat_mode ?? null,
    })),
  };
}

module.exports = { BASE, isConfigured, request: _http, tokenRequest, connect, accessToken, listTools, callTool, status, BLOCKED };
