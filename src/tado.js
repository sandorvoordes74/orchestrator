"use strict";

// Heating via tado°'s own REST API (the one the tado app uses; not officially supported for
// third parties). Independent of Homey, so it keeps working when Homey is down. Auth is
// tado's OAuth device-code sign-in, done once locally (node scripts/tado-login.js). Env vars,
// never code:
//
//   TADO_REFRESH_TOKEN  refresh token from the sign-in (only used to start the chain)
//   TADO_TOKEN_KEY      32-byte base64 key to encrypt the token cache
//
// tado rotates refresh tokens on every use (the old one is revoked at once, and reusing a
// replaced one kills the whole chain) and access tokens live 10 minutes, so the newest tokens -
// plus the home id and zone names - are cached ENCRYPTED (AES-256-GCM) through a small store
// the caller provides; the sheet only ever holds ciphertext. One chain per user of it: local
// testing uses its own sign-in under another cache key (TADO_CACHE_KEY).
//
// Since 2026 tado allows ~100 API requests per day on a normal account. A status read costs
// 3 requests (4 when the zone list is refreshed, once a day); the remaining quota is returned.
//
// Actions are deliberately narrow: a temperature or 'off' that ends at the NEXT SCHEDULE
// BLOCK (or after a timer), resuming the schedule, and the home/away presence. The owner's
// tado schedules stay in charge: no permanent overrides, no schedule or settings edits.

const https = require("https");
const crypto = require("crypto");

const API = "https://my.tado.com/api/v2";
const LOGIN = "https://login.tado.com/oauth2";
const CLIENT_ID = "1bb50063-6b0c-4d11-bd99-387f4a91cc46"; // tado's public client for the device flow
const ZONES_MAX_AGE = 24 * 3600 * 1000;
const TZ = "Europe/Amsterdam";

function isConfigured() {
  return Boolean(process.env.TADO_REFRESH_TOKEN && process.env.TADO_TOKEN_KEY);
}

function _http(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(new URL(url), { method, headers: { ...headers, ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}) }, timeout: 30000 }, (res) => {
      let c = "";
      res.on("data", (d) => (c += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: c }));
    });
    req.on("timeout", () => req.destroy(new Error("tado: timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---- OAuth (device code + rotating refresh tokens) ------------------------------------------

async function tokenRequest(params) {
  const r = await _http("POST", `${LOGIN}/token`, { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    new URLSearchParams({ client_id: CLIENT_ID, ...params }).toString());
  let j = {};
  try { j = JSON.parse(r.text); } catch (_) { /* not JSON */ }
  if (r.status !== 200 || !j.access_token) {
    const err = new Error(`tado token ${r.status}: ${j.error || ""} ${j.error_description || r.text.slice(0, 160)}`.trim());
    err.oauthError = j.error || null;
    throw err;
  }
  return j;
}

// Start of the one-time sign-in: returns { device_code, user_code, verification_uri_complete, interval, expires_in }.
async function deviceAuthorize() {
  const r = await _http("POST", `${LOGIN}/device_authorize`, { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    new URLSearchParams({ client_id: CLIENT_ID, scope: "offline_access" }).toString());
  if (r.status !== 200) throw new Error(`tado device_authorize ${r.status}: ${r.text.slice(0, 160)}`);
  return JSON.parse(r.text);
}

function _key() {
  const k = Buffer.from(process.env.TADO_TOKEN_KEY || "", "base64");
  if (k.length !== 32) throw new Error("tado: TADO_TOKEN_KEY must be 32 bytes, base64");
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
    return null;
  }
}

// store = { get: async () => string|null, set: async (string) => void }
async function _save(store, cache) {
  for (let i = 0; i < 3; i++) {
    try { await store.set(_encrypt(cache)); return; } catch (e) { if (i === 2) throw new Error(`tado: could not save the new token (${e.message}) - the sign-in may need to be redone`); }
  }
}

async function _session(store) {
  let cache = (await store.get().then(_decrypt).catch(() => null)) || {};
  if (cache.accessToken && cache.expiresAt - Date.now() > 60000) return cache;
  // Only the newest refresh token: tado revokes the whole chain when a replaced one is reused,
  // so the env token is only used to START a chain (empty cache), never as a fallback.
  let rt = cache.refreshToken || process.env.TADO_REFRESH_TOKEN;
  for (let attempt = 0; attempt < 2 && rt; attempt++) {
    try {
      const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: rt });
      cache = { ...cache, accessToken: t.access_token, expiresAt: Date.now() + (Number(t.expires_in) || 600) * 1000, refreshToken: t.refresh_token || rt };
      await _save(store, cache);
      return cache;
    } catch (e) {
      if (e.oauthError !== "invalid_grant") throw e;
      // Another run may have rotated the token a moment ago: take what it stored.
      await new Promise((r) => setTimeout(r, 2000));
      const fresh = await store.get().then(_decrypt).catch(() => null);
      if (fresh && fresh.accessToken && fresh.expiresAt - Date.now() > 60000) return fresh;
      rt = fresh && fresh.refreshToken !== rt ? fresh.refreshToken : null;
      if (fresh) cache = fresh;
    }
  }
  throw new Error("tado: the sign-in has expired - run node scripts/tado-login.js --store again");
}

// Store a fresh sign-in (from the device flow) as the start of a new token chain.
async function saveTokens(store, t) {
  await _save(store, { accessToken: t.access_token, expiresAt: Date.now() + (Number(t.expires_in) || 600) * 1000, refreshToken: t.refresh_token });
}

// ---- API ----------------------------------------------------------------------------------

let _quota = null; // requests left today, from tado's 'ratelimit' header

async function _api(session, method, path, body) {
  const r = await _http(method, `${API}${path}`, {
    Authorization: `Bearer ${session.accessToken}`, Accept: "application/json",
    ...(body ? { "Content-Type": "application/json" } : {}),
  }, body ? JSON.stringify(body) : undefined);
  const rl = String(r.headers.ratelimit || "").match(/r=(\d+)/);
  if (rl) _quota = Number(rl[1]);
  if (r.status === 429) {
    const t = String(r.headers.ratelimit || "").match(/t=(\d+)/);
    throw new Error(`tado: daily request quota used up${t ? ` (refills in ${Math.round(t[1] / 60)} min)` : ""}`);
  }
  if (r.status < 200 || r.status >= 300) throw new Error(`tado ${method} ${path.replace(/\/homes\/\d+/, "/homes/…")}: HTTP ${r.status} ${r.text.slice(0, 160)}`);
  return r.text ? JSON.parse(r.text) : null;
}

// Home id, generation and zone names, refreshed once a day (kept in the encrypted cache).
async function _home(store, session) {
  const fresh = session.zones && Object.values(session.zones).every((z) => Array.isArray(z.devices));
  if (session.homeId && fresh && Date.now() - (session.zonesAt || 0) < ZONES_MAX_AGE) return session;
  if (!session.homeId) {
    const me = await _api(session, "GET", "/me");
    const home = (me.homes || [])[0];
    if (!home) throw new Error("tado: no home on this account");
    session.homeId = home.id;
  }
  const info = await _api(session, "GET", `/homes/${session.homeId}`);
  if (info && info.generation === "LINE_X") throw new Error("tado: this home uses tado X, which needs a different API - not supported yet");
  const zones = await _api(session, "GET", `/homes/${session.homeId}/zones`);
  session.zones = {};
  for (const z of zones || []) {
    const low = (z.devices || []).some((d) => d.batteryState && d.batteryState !== "NORMAL");
    session.zones[z.id] = { name: z.name, type: z.type, lowBattery: low, devices: (z.devices || []).map((d) => d.serialNo) };
  }
  session.zonesAt = Date.now();
  await _save(store, session);
  return session;
}

const _when = (iso) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
const _hm = (iso) => (iso ? new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : null);

function _zoneSummary(name, meta, s) {
  const set = s.setting || {};
  const ov = s.overlay;
  let mode = "schedule";
  if (ov) {
    const t = ov.termination || {};
    mode = t.type === "MANUAL" ? "manual override (until changed)"
      : `override until ${_hm(t.projectedExpiry || t.expiry) || "next block"}`;
  }
  if (s.tadoMode === "AWAY" && !ov) mode = "away mode";
  const sensors = s.sensorDataPoints || {};
  // A disconnected thermostat keeps its last values; say how old they are.
  const at = sensors.insideTemperature && sensors.insideTemperature.timestamp;
  const stale = at && Date.now() - Date.parse(at) > 30 * 60000;
  return {
    zone: name,
    type: meta.type,
    target: set.power === "ON" && set.temperature ? set.temperature.celsius : null,
    power: set.power || null,
    measured: sensors.insideTemperature ? Math.round(sensors.insideTemperature.celsius * 10) / 10 : null,
    humidity: sensors.humidity ? Math.round(sensors.humidity.percentage) : null,
    heatingPct: s.activityDataPoints && s.activityDataPoints.heatingPower ? s.activityDataPoints.heatingPower.percentage : null,
    mode,
    openWindow: Boolean(s.openWindow || s.openWindowDetected),
    next: s.nextScheduleChange && s.nextScheduleChange.start
      ? `${_hm(s.nextScheduleChange.start)} -> ${s.nextScheduleChange.setting && s.nextScheduleChange.setting.power === "ON" && s.nextScheduleChange.setting.temperature ? s.nextScheduleChange.setting.temperature.celsius + "°" : "off"}`
      : null,
    online: !(s.link && s.link.state === "OFFLINE"),
    readingFrom: stale ? _when(at) : null,
    lowBattery: meta.lowBattery,
  };
}

// Home/away, who is home (phones with tado geofencing) and every zone - 3 requests, plus one
// for the devices when a zone is offline (to tell a bridge problem from thermostats that lost it).
async function status(store) {
  const session = await _home(store, await _session(store));
  const h = session.homeId;
  const [state, phones, zs] = await Promise.all([
    _api(session, "GET", `/homes/${h}/state`),
    _api(session, "GET", `/homes/${h}/mobileDevices`),
    _api(session, "GET", `/homes/${h}/zoneStates`),
  ]);
  const people = (phones || []).map((p) => {
    const tracking = Boolean(p.settings && p.settings.geoTrackingEnabled);
    const loc = p.location || {};
    return { name: p.name, tracking, atHome: tracking && !loc.stale ? Boolean(loc.atHome) : null, stale: Boolean(loc.stale) };
  });
  const zones = Object.entries((zs && zs.zoneStates) || {}).map(([id, s]) => _zoneSummary((session.zones[id] || {}).name || `zone ${id}`, session.zones[id] || {}, s));
  const out = {
    home: { presence: state && state.presence, presenceLocked: Boolean(state && state.presenceLocked) },
    people,
    zones,
  };
  if (zones.some((z) => !z.online)) {
    const devices = (await _api(session, "GET", `/homes/${h}/devices`)) || [];
    const bridge = devices.find((d) => /^IB/.test(d.deviceType || ""));
    const lost = devices.filter((d) => !/^IB/.test(d.deviceType || "") && d.connectionState && d.connectionState.value === false);
    const since = lost.map((d) => d.connectionState.timestamp).filter(Boolean).sort()[0];
    out.connection = {
      bridgeOnline: bridge ? Boolean(bridge.connectionState && bridge.connectionState.value) : null,
      devicesOffline: lost.length,
      devicesTotal: devices.filter((d) => !/^IB/.test(d.deviceType || "")).length,
      offlineSince: since ? _when(since) : null,
    };
  }
  out.rateLimitRemaining = _quota;
  return out;
}

const KIND = { IB: "bridge", RU: "wall thermostat", VA: "radiator valve", SU: "temperature sensor", BU: "boiler module", BR: "boiler receiver", WR: "AC control" };

// Read-only diagnostics: every device with its room, connection (and since when), battery and
// firmware - 1 request.
async function devices(store) {
  const session = await _home(store, await _session(store));
  const list = (await _api(session, "GET", `/homes/${session.homeId}/devices`)) || [];
  const roomOf = {};
  for (const z of Object.values(session.zones || {})) for (const sn of z.devices || []) roomOf[sn] = z.name;
  return {
    devices: list.map((d) => ({
      device: KIND[String(d.deviceType || "").slice(0, 2)] || d.deviceType,
      type: d.deviceType,
      room: roomOf[d.serialNo] || null,
      online: Boolean(d.connectionState && d.connectionState.value),
      since: d.connectionState && d.connectionState.timestamp ? _when(d.connectionState.timestamp) : null,
      battery: d.batteryState || null,
      firmware: d.currentFwVersion || null,
      serial: d.shortSerialNo || d.serialNo || null,
    })),
    rateLimitRemaining: _quota,
  };
}

const _day = (v) => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
  if (!v || /^today$/i.test(v)) return today;
  if (/^yesterday$/i.test(v)) return new Date(Date.parse(`${today}T12:00:00Z`) - 864e5).toISOString().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  throw new Error("tado: day must be today, yesterday or YYYY-MM-DD");
};
const _intervals = (series, keep) => ((series && series.dataIntervals) || [])
  .filter((i) => keep(i.value))
  .map((i) => ({ from: _when(i.from), to: _when(i.to), value: i.value }));

// Read-only day report of one room: when its thermostat was connected, the temperature per hour,
// humidity range and when it asked for heat - 1 request.
async function history(store, zoneName, day) {
  const session = await _home(store, await _session(store));
  const z = _zoneId(session, zoneName);
  const date = _day(day);
  const r = await _api(session, "GET", `/homes/${session.homeId}/zones/${z.id}/dayReport?date=${date}`);
  const m = (r && r.measuredData) || {};
  const hourly = {};
  for (const p of (m.insideTemperature && m.insideTemperature.dataPoints) || []) {
    if (p.value && p.value.celsius != null) hourly[_when(p.timestamp).slice(0, 6) + ":00"] = Math.round(p.value.celsius * 10) / 10;
  }
  const hum = ((m.humidity && m.humidity.dataPoints) || []).map((p) => (p.value > 1 ? p.value : p.value * 100));
  return {
    room: z.name,
    date,
    connected: _intervals(m.measuringDeviceConnected, () => true).map((i) => ({ from: i.from, to: i.to, connected: Boolean(i.value) })),
    temperature: hourly,
    humidity: hum.length ? { min: Math.round(Math.min(...hum)), max: Math.round(Math.max(...hum)) } : null,
    heatingDemand: _intervals(r && r.callForHeat, (v) => v && v !== "NONE"),
    rateLimitRemaining: _quota,
  };
}

function _zoneId(session, name) {
  const want = String(name || "").trim().toLowerCase();
  const all = Object.entries(session.zones || {});
  const exact = all.filter(([, z]) => z.name.toLowerCase() === want);
  const part = exact.length ? exact : all.filter(([, z]) => z.name.toLowerCase().includes(want));
  if (part.length !== 1) throw new Error(`tado: zone '${name}' matches ${part.length} zones (${all.map(([, z]) => z.name).join(", ")})`);
  return { id: part[0][0], name: part[0][1].name };
}

function _termination(minutes) {
  const m = Number(minutes);
  if (minutes != null && minutes !== "" && !(m >= 5 && m <= 720)) throw new Error("tado: a timer must be 5-720 minutes");
  return minutes != null && minutes !== "" ? { typeSkillBasedApp: "TIMER", durationInSeconds: Math.round(m * 60) } : { typeSkillBasedApp: "NEXT_TIME_BLOCK" };
}

// Owner-confirmed actions. Every override ends at the next schedule block (or a timer).
//   set <zone> <°C> [minutes] | off <zone> [minutes] | resume <zone|all> | presence <home|away|auto>
async function command(store, cmd, args) {
  const session = await _home(store, await _session(store));
  const h = session.homeId;
  if (cmd === "set") {
    const z = _zoneId(session, args[0]);
    const c = Number(String(args[1] || "").replace(",", "."));
    if (!(c >= 5 && c <= 25)) throw new Error("tado: temperature must be 5-25 °C");
    await _api(session, "PUT", `/homes/${h}/zones/${z.id}/overlay`, {
      setting: { type: "HEATING", power: "ON", temperature: { celsius: Math.round(c * 2) / 2 } },
      termination: _termination(args[2]),
    });
    return { done: `${z.name} to ${Math.round(c * 2) / 2}°C ${args[2] ? `for ${args[2]} min` : "until the next schedule block"}`, rateLimitRemaining: _quota };
  }
  if (cmd === "off") {
    const z = _zoneId(session, args[0]);
    await _api(session, "PUT", `/homes/${h}/zones/${z.id}/overlay`, { setting: { type: "HEATING", power: "OFF" }, termination: _termination(args[1]) });
    return { done: `${z.name} off ${args[1] ? `for ${args[1]} min` : "until the next schedule block"}`, rateLimitRemaining: _quota };
  }
  if (cmd === "resume") {
    if (String(args[0] || "").toLowerCase() === "all") {
      const ids = Object.keys(session.zones);
      for (const id of ids) await _api(session, "DELETE", `/homes/${h}/zones/${id}/overlay`);
      return { done: `schedule resumed in all ${ids.length} zones`, rateLimitRemaining: _quota };
    }
    const z = _zoneId(session, args[0]);
    await _api(session, "DELETE", `/homes/${h}/zones/${z.id}/overlay`);
    return { done: `${z.name} back on its schedule`, rateLimitRemaining: _quota };
  }
  if (cmd === "presence") {
    const p = String(args[0] || "").toLowerCase();
    if (p === "auto") await _api(session, "DELETE", `/homes/${h}/presenceLock`);
    else if (p === "home" || p === "away") await _api(session, "PUT", `/homes/${h}/presenceLock`, { homePresence: p.toUpperCase() });
    else throw new Error("tado: presence home|away|auto");
    return { done: `presence ${p === "auto" ? "back to automatic (geofencing)" : `set to ${p}`}`, rateLimitRemaining: _quota };
  }
  throw new Error("tado: commands are set <zone> <°C> [minutes] | off <zone> [minutes] | resume <zone|all> | presence <home|away|auto>");
}

module.exports = { isConfigured, deviceAuthorize, tokenRequest, saveTokens, status, devices, history, command, CLIENT_ID };
