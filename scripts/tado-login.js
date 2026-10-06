"use strict";

// One-time LOCAL sign-in for tado° (run on your own computer, not in the cloud):
//   node scripts/tado-login.js            -> writes .env.tado
//   node scripts/tado-login.js --store    -> also starts the routine's token chain in the sheet
//                                            (needs SPREADSHEET_ID and Google credentials)
//
// tado's device-code flow: the script shows a link, you approve it with your tado account in
// the browser, and the script receives the tokens. It writes the two env vars for the cloud
// environment to .env.tado (git-ignored, readable only by you); an existing TADO_TOKEN_KEY is
// kept, so the routine can still read the cache. Nothing secret is printed.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFile, execFileSync } = require("child_process");
const tado = require("../src/tado");

const OUT = path.join(__dirname, "..", ".env.tado");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const auth = await tado.deviceAuthorize();
  const link = auth.verification_uri_complete || auth.verification_uri;
  console.log(`\nOpen this link and approve with your tado account (code ${auth.user_code}):\n  ${link}\n`);
  if (process.platform === "darwin") execFile("open", [link], () => {});

  let wait = (Number(auth.interval) || 5) * 1000;
  const deadline = Date.now() + (Number(auth.expires_in) || 300) * 1000;
  let tokens = null;
  while (!tokens && Date.now() < deadline) {
    await sleep(wait);
    try {
      tokens = await tado.tokenRequest({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: auth.device_code });
    } catch (e) {
      if (e.oauthError === "authorization_pending") continue;
      if (e.oauthError === "slow_down") { wait += 5000; continue; }
      throw e;
    }
  }
  if (!tokens) throw new Error("no approval within the time limit - run the script again");
  if (!tokens.refresh_token) throw new Error("tado returned no refresh token (scope offline_access missing?)");

  const key = process.env.TADO_TOKEN_KEY || crypto.randomBytes(32).toString("base64");
  process.env.TADO_TOKEN_KEY = key;
  fs.writeFileSync(OUT, `TADO_REFRESH_TOKEN=${tokens.refresh_token}\nTADO_TOKEN_KEY=${key}\n`, { mode: 0o600 });
  if (process.argv.includes("--store")) {
    // Start a new chain in the routine's cache (encrypted with TADO_TOKEN_KEY); use these tokens nowhere else.
    const cacheKey = process.env.TADO_CACHE_KEY || "tado:cache";
    const cli = path.join(__dirname, "..", "src", "cli.js");
    await tado.saveTokens({ set: async (v) => { execFileSync("node", [cli, "state-set", cacheKey], { input: v, stdio: ["pipe", "ignore", "inherit"] }); } }, tokens);
    console.log(`Signed in. Stored the new sign-in under '${cacheKey}' and wrote ${path.basename(OUT)}.`);
  } else {
    console.log(`Signed in. Wrote ${path.basename(OUT)} - copy both lines into the cloud environment's variables.`);
  }
})().catch((e) => { console.error("tado sign-in failed:", e.message); process.exit(1); });
