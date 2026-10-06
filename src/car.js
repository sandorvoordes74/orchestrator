"use strict";

// Car access via Škoda's official MyŠkoda public API (REST, API key created in the MyŠkoda
// app, bound to the owner's vehicle). Docs: https://public.api.connect.skoda-auto.cz/docs
// The key and VIN come from env vars only - never from code:
//
//   SKODA_API_KEY   (required) key created in the MyŠkoda app
//   SKODA_VIN       (required) vehicle identification number the key is bound to
//   SKODA_API_BASE  (optional) override of the public API host
//
// Quota: ~20 requests per hour per VIN (also failed 5xx calls count), so callers should
// read the status once per run. Commands are answered with 202 (accepted); the effect shows
// up in a later status read.

const https = require("https");

const BASE = (process.env.SKODA_API_BASE || "https://public.api.connect.skoda-auto.cz").replace(/\/+$/, "");
const PARTS = ["info", "status", "fuelStatus", "odometer", "parkingPosition", "airConditioning",
  "auxiliaryHeating", "activeVentilation", "charging", "chargingProfiles", "operations"];
const DEFAULT_PARTS = ["status", "odometer", "parkingPosition", "airConditioning", "charging", "operations"];

function isConfigured() {
  return Boolean(process.env.SKODA_API_KEY && process.env.SKODA_VIN);
}

function _request(method, path, body) {
  const url = new URL(BASE + path);
  const payload = body == null ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method,
      headers: {
        "X-API-Key": process.env.SKODA_API_KEY,
        Accept: "application/json, application/problem+json",
        ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
      },
      timeout: 60000,
    }, (res) => {
      let c = "";
      res.on("data", (d) => (c += d));
      res.on("end", () => {
        let json = null;
        try { json = c ? JSON.parse(c) : null; } catch (_) { /* non-JSON body */ }
        const h = res.headers;
        const meta = {
          status: res.statusCode,
          rateLimitRemaining: h["ratelimit-remaining"] != null ? Number(h["ratelimit-remaining"]) : null,
          keyExpiresAt: h["x-api-key-expires-at"] || null,
        };
        if (meta.keyExpiresAt) meta.keyExpiresInDays = Math.floor((Date.parse(meta.keyExpiresAt) - Date.now()) / 86400000);
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve({ ...meta, data: json });
        // RFC 9457 problem: keep only the short problem name, title and detail.
        const p = json || {};
        const problem = p.type && p.type !== "about:blank" ? String(p.type).split("/").pop() : null;
        const err = new Error(`car API ${res.statusCode}${problem ? " " + problem : ""}: ${p.detail || p.title || c.slice(0, 200)}`);
        err.meta = { ...meta, problem, retryAfter: h["retry-after"] || null };
        reject(err);
      });
    });
    req.on("timeout", () => req.destroy(new Error("car API timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const _vinPath = () => `/api/v1/vehicles/${encodeURIComponent(process.env.SKODA_VIN)}`;

// One status read (costs one request of the hourly quota). Returns a compact summary for
// the briefing plus the raw parts and any per-part errors.
async function status(parts) {
  const want = (parts && parts.length ? parts : DEFAULT_PARTS).filter((p) => PARTS.includes(p));
  const r = await _request("GET", `${_vinPath()}?${want.map((p) => "include=" + p).join("&")}`);
  const v = (r.data && r.data.vehicle) || {};
  const ch = v.charging || {}, cs = ch.status || {}, bat = cs.battery || {}, set = ch.settings || {};
  const ov = (v.status && v.status.overall) || {};
  const ac = v.airConditioning || {};
  const pos = v.parkingPosition || {};
  return {
    configured: true,
    summary: {
      name: v.name || null,
      batteryPercent: bat.stateOfChargeInPercent ?? null,
      rangeKm: bat.remainingCruisingRangeInMeters != null ? Math.round(bat.remainingCruisingRangeInMeters / 1000) : null,
      charging: cs.state || null,
      plug: cs.plugConnectionState || null,
      chargePowerKw: cs.chargePowerInKw ?? null,
      fullyChargedAt: cs.fullyChargedAt || null,
      targetPercent: set.targetStateOfChargeInPercent ?? null,
      chargeMode: set.preferredChargeMode || null,
      locked: ov.locked || ov.doorsLocked || null,
      doors: ov.doors || null,
      windows: ov.windows || null,
      lights: ov.lights || null,
      climate: ac.state || null,
      climateTarget: ac.targetTemperature ? `${ac.targetTemperature.value} ${ac.targetTemperature.unit}` : null,
      parkedAt: pos.formattedAddress || null,
      mileageKm: (v.odometer && v.odometer.mileageInKm) ?? null,
      capturedAt: ch.carCapturedTimestamp || (v.status && v.status.carCapturedTimestamp) || null,
      operations: Array.isArray(v.operations) ? v.operations.map((o) => o.name) : null,
    },
    errors: (r.data && r.data.errors) || [],
    rateLimitRemaining: r.rateLimitRemaining,
    keyExpiresAt: r.keyExpiresAt,
    keyExpiresInDays: r.keyExpiresInDays ?? null,
    vehicle: v,
  };
}

// Remote commands - they physically act on the car, so the routine only runs them after
// the owner approved that specific command.
const COMMANDS = {
  "charge-start": () => ["POST", "/charging/start"],
  "charge-stop": () => ["POST", "/charging/stop"],
  "charge-limit": (a) => {
    const pct = Number(a[0]);
    if (!Number.isInteger(pct) || pct < 50 || pct > 100 || pct % 10) throw new Error("charge-limit: give 50-100 in steps of 10");
    return ["PUT", "/charging/limit", { targetStateOfChargeInPercent: pct }];
  },
  "charge-mode": (a) => {
    if (!a[0]) throw new Error("charge-mode: give a mode, e.g. MANUAL or TIMER");
    return ["PUT", "/charging/mode", { chargeMode: String(a[0]).toUpperCase() }];
  },
  "ac-start": (a) => {
    const t = a[0] != null && a[0] !== "" ? Number(a[0]) : 21;
    if (!(t >= 16 && t <= 29.5)) throw new Error("ac-start: target temperature 16-29.5 °C");
    // Without a cable the climate runs on the traction battery only when explicitly allowed.
    return ["POST", "/air-conditioning/start", { targetTemperature: { value: t, unit: "CELSIUS" }, airConditioningWithoutExternalPower: a.includes("--battery") }];
  },
  "ac-stop": () => ["POST", "/air-conditioning/stop"],
  "vent-start": () => ["POST", "/active-ventilation/start"],
  "vent-stop": () => ["POST", "/active-ventilation/stop"],
};

async function command(name, args) {
  const build = COMMANDS[name];
  if (!build) throw new Error(`car: unknown command '${name}' (use: ${Object.keys(COMMANDS).join(", ")})`);
  const [method, sub, body] = build(args || []);
  const r = await _request(method, _vinPath() + sub, body);
  return { ok: true, command: name, status: r.status, rateLimitRemaining: r.rateLimitRemaining,
    note: "accepted by the API; the car executes it asynchronously - read car-status later to confirm" };
}

module.exports = { isConfigured, status, command, COMMANDS, PARTS };
