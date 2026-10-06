"use strict";

// One-time LOCAL sign-in for the Homey MCP server (run on your own computer, not in the
// cloud):  node scripts/homey-login.js
//
// It registers an OAuth client with the server (dynamic client registration), opens the
// browser for the Homey account login, exchanges the code for tokens, checks that the MCP
// server answers, and writes the four env vars for the cloud environment to .env.homey
// (git-ignored, readable only by you). Nothing secret is printed.

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const homey = require("../src/homey");

const PORT = Number(process.env.PORT || 53682);
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const OUT = path.join(__dirname, "..", ".env.homey");
const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function waitForCode(state) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { server.close(); reject(new Error("no login within 5 minutes")); }, 300000);
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const u = new URL(req.url, REDIRECT);
        if (u.pathname !== "/callback") { res.writeHead(404).end(); return; }
        // response_mode=form_post sends the code as a form POST; accept a query string too.
        const p = new URLSearchParams(req.method === "POST" ? body : u.search);
        const ok = p.get("code") && p.get("state") === state;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
          .end(ok ? "<p>Homey sign-in done - you can close this tab.</p>" : `<p>Sign-in failed: ${p.get("error") || "state mismatch"}</p>`);
        clearTimeout(timer);
        server.close();
        ok ? resolve(p.get("code")) : reject(new Error(`login failed: ${p.get("error_description") || p.get("error") || "state mismatch"}`));
      });
    }).listen(PORT, "127.0.0.1");
  });
}

async function main() {
  // 1. Register a client for this routine.
  const reg = await homey.request("POST", `${homey.BASE}/oauth2/client`, { "Content-Type": "application/json", Accept: "application/json" }, JSON.stringify({
    client_name: "Personal assistant routine",
    redirect_uris: [REDIRECT],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_basic",
  }));
  const client = JSON.parse(reg.text || "{}");
  if (!client.client_id || !client.client_secret) throw new Error(`client registration failed (HTTP ${reg.status}): ${reg.text.slice(0, 300)}`);

  // 2. Browser login (authorization code + PKCE).
  const state = b64url(crypto.randomBytes(16));
  const verifier = b64url(crypto.randomBytes(32));
  const auth = new URL(`${homey.BASE}/oauth2/authorise`);
  auth.search = new URLSearchParams({
    response_type: "code", response_mode: "form_post", client_id: client.client_id, redirect_uri: REDIRECT, state,
    code_challenge: b64url(crypto.createHash("sha256").update(verifier).digest()), code_challenge_method: "S256",
    resource: homey.BASE,
  }).toString();
  const codePromise = waitForCode(state);
  console.log("Opening the Homey login in your browser. If nothing opens, visit:\n" + auth.toString() + "\n");
  execFile(process.platform === "darwin" ? "open" : "xdg-open", [auth.toString()], () => {});
  const code = await codePromise;

  // 3. Code -> tokens.
  const t = await homey.tokenRequest({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier, resource: homey.BASE },
    client.client_id, client.client_secret);
  if (!t.refresh_token) throw new Error("the server returned no refresh token - unattended access is not possible");

  // 4. Check the MCP server with the new access token.
  const s = await homey.connect(t.access_token);
  const tools = await s.listTools();
  console.log(`Connected to ${(s.server && s.server.name) || "Homey MCP"} - ${tools.length} tools:`);
  for (const x of tools) console.log(`  ${homey.BLOCKED.test(x.name) ? "(blocked) " : ""}${x.name}`);

  // 5. Credentials for the cloud environment -> local git-ignored file.
  const lines = [
    `HOMEY_CLIENT_ID=${client.client_id}`,
    `HOMEY_CLIENT_SECRET=${client.client_secret}`,
    `HOMEY_REFRESH_TOKEN=${t.refresh_token}`,
    `HOMEY_TOKEN_KEY=${crypto.randomBytes(32).toString("base64")}`,
  ];
  fs.writeFileSync(OUT, lines.join("\n") + "\n", { mode: 0o600 });
  console.log(`\nSaved the 4 env vars to ${OUT} - add them to the cloud environment, then delete the file.`);
}

main().catch((e) => { console.error("homey-login: " + e.message); process.exit(1); });
