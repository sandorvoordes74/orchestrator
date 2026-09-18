"use strict";

// Zero-dependency Google API client — uses ONLY Node built-ins (https, crypto, fs).
// This replaces the `googleapis` npm package so the cloud routine never has to run
// `npm install` on externally-fetched code (which the auto-mode classifier blocks in
// unattended runs) and is immune to npm-registry hiccups. It exposes small shims whose
// method surface matches the bits of googleapis the rest of the code already calls, so
// call sites (sheets.js/docs.js/gmail2.js) stay unchanged. Every call resolves to
// { data: <parsed API JSON> }, exactly like googleapis.

const https = require("https");
const crypto = require("crypto");
const fs = require("fs");

function request(method, urlStr, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = body == null ? null : (typeof body === "string" ? body : JSON.stringify(body));
    const h = { ...headers };
    if (data != null) {
      h["Content-Length"] = Buffer.byteLength(data);
      if (!h["Content-Type"]) h["Content-Type"] = "application/json";
    }
    const req = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers: h }, (res) => {
      let c = ""; res.setEncoding("utf8");
      res.on("data", (d) => (c += d));
      res.on("end", () => {
        let parsed = {};
        try { parsed = c ? JSON.parse(c) : {}; } catch { parsed = c; }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
        const msg = (parsed && parsed.error && (parsed.error.message || JSON.stringify(parsed.error))) || String(parsed).slice(0, 300);
        const e = new Error("HTTP " + res.statusCode + ": " + msg);
        e.code = res.statusCode;
        reject(e);
      });
    });
    req.on("error", reject);
    if (data != null) req.write(data);
    req.end();
  });
}

const b64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = encodeURIComponent;

// Service-account key: GOOGLE_SERVICE_ACCOUNT_KEY (raw JSON or base64) or a file path
// in GOOGLE_APPLICATION_CREDENTIALS (handy for local runs).
function loadServiceAccountKey() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (raw && raw.trim()) {
    let t = raw.trim();
    if (!t.startsWith("{")) t = Buffer.from(t, "base64").toString("utf8");
    return JSON.parse(t);
  }
  const p = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (p && p.trim()) return JSON.parse(fs.readFileSync(p.trim(), "utf8"));
  throw new Error("No service-account key: set GOOGLE_SERVICE_ACCOUNT_KEY or GOOGLE_APPLICATION_CREDENTIALS");
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const _saCache = {}; // scope-string -> { token, exp }

// Service-account OAuth token via a self-signed RS256 JWT bearer grant.
async function saAccessToken(scopes) {
  const scope = (scopes || []).join(" ");
  const now = Math.floor(Date.now() / 1000);
  const cached = _saCache[scope];
  if (cached && cached.exp - 60 > now) return cached.token;
  const key = loadServiceAccountKey();
  const input = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })) + "." +
    b64url(JSON.stringify({ iss: key.client_email, scope, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
  const sig = crypto.createSign("RSA-SHA256").update(input).sign(key.private_key);
  const jwt = input + "." + b64url(sig);
  const res = await request("POST", TOKEN_URL, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=" + jwt,
  });
  _saCache[scope] = { token: res.access_token, exp: now + (res.expires_in || 3600) };
  return res.access_token;
}

// Installed-app OAuth token from a stored refresh token (used for the private mailbox).
async function refreshAccessToken(clientId, clientSecret, refresh) {
  const res = await request("POST", TOKEN_URL, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=refresh_token&client_id=" + enc(clientId) + "&client_secret=" + enc(clientSecret) + "&refresh_token=" + enc(refresh),
  });
  return res.access_token;
}

// getToken: async () => access token. Returns a caller giving { data } like googleapis.
function caller(getToken) {
  return async (method, url, body) => {
    const token = await getToken();
    const data = await request(method, url, { headers: { Authorization: "Bearer " + token }, body });
    return { data };
  };
}

const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
function sheetsClient(getToken) {
  const call = caller(getToken);
  return {
    spreadsheets: {
      get: ({ spreadsheetId, fields }) => call("GET", `${SHEETS}/${spreadsheetId}` + (fields ? `?fields=${enc(fields)}` : "")),
      batchUpdate: ({ spreadsheetId, requestBody }) => call("POST", `${SHEETS}/${spreadsheetId}:batchUpdate`, requestBody),
      values: {
        get: ({ spreadsheetId, range }) => call("GET", `${SHEETS}/${spreadsheetId}/values/${enc(range)}`),
        update: ({ spreadsheetId, range, valueInputOption, requestBody }) =>
          call("PUT", `${SHEETS}/${spreadsheetId}/values/${enc(range)}?valueInputOption=${valueInputOption || "RAW"}`, requestBody),
        append: ({ spreadsheetId, range, valueInputOption, insertDataOption, requestBody }) =>
          call("POST", `${SHEETS}/${spreadsheetId}/values/${enc(range)}:append?valueInputOption=${valueInputOption || "RAW"}&insertDataOption=${insertDataOption || "INSERT_ROWS"}`, requestBody),
        batchUpdate: ({ spreadsheetId, requestBody }) => call("POST", `${SHEETS}/${spreadsheetId}/values:batchUpdate`, requestBody),
        clear: ({ spreadsheetId, range }) => call("POST", `${SHEETS}/${spreadsheetId}/values/${enc(range)}:clear`, {}),
      },
    },
  };
}

const DOCS = "https://docs.googleapis.com/v1/documents";
function docsClient(getToken) {
  const call = caller(getToken);
  return {
    documents: {
      get: ({ documentId }) => call("GET", `${DOCS}/${documentId}`),
      batchUpdate: ({ documentId, requestBody }) => call("POST", `${DOCS}/${documentId}:batchUpdate`, requestBody),
    },
  };
}

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
function gmailClient(getToken) {
  const call = caller(getToken);
  return {
    users: {
      getProfile: () => call("GET", `${GMAIL}/profile`),
      labels: {
        list: () => call("GET", `${GMAIL}/labels`),
        create: ({ requestBody }) => call("POST", `${GMAIL}/labels`, requestBody),
      },
      threads: {
        list: ({ q, maxResults }) => call("GET", `${GMAIL}/threads?q=${enc(q || "")}&maxResults=${maxResults || 100}`),
        get: ({ id, format }) => call("GET", `${GMAIL}/threads/${id}?format=${format || "full"}`),
        modify: ({ id, requestBody }) => call("POST", `${GMAIL}/threads/${id}/modify`, requestBody),
      },
    },
  };
}

module.exports = { saAccessToken, refreshAccessToken, sheetsClient, docsClient, gmailClient };
