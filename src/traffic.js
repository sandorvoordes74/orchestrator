"use strict";

// Live road traffic for a planned drive via the TomTom Routing API (free developer key, no
// card needed: developer.tomtom.com). Gives the travel time with current traffic, the delay
// versus a free road, and the jams on the route (road number, kind, delay). Env vars:
//
//   TOMTOM_API_KEY  (required) TomTom developer key
//   PA_HOME         (optional) home address or "lat,lon" - used for the alias "home"

const https = require("https");

const HOST = "https://api.tomtom.com";

function isConfigured() {
  return Boolean(process.env.TOMTOM_API_KEY);
}

function _get(path) {
  const url = `${HOST}${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(process.env.TOMTOM_API_KEY)}`;
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 30000 }, (res) => {
      let c = "";
      res.on("data", (d) => (c += d));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`traffic: HTTP ${res.statusCode} ${c.slice(0, 160)}`));
        try { resolve(JSON.parse(c)); } catch (e) { reject(e); }
      });
    }).on("timeout", function () { this.destroy(new Error("traffic: timeout")); }).on("error", reject);
  });
}

// "home", "lat,lon" or a free-text address/place (geocoded, Netherlands first).
async function _where(place) {
  let p = String(place || "").trim();
  if (/^home$/i.test(p)) {
    p = String(process.env.PA_HOME || "").trim();
    if (!p) throw new Error("traffic: 'home' needs PA_HOME");
  }
  const m = p.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) return { lat: +m[1], lon: +m[2], name: p };
  const g = await _get(`/search/2/geocode/${encodeURIComponent(p)}.json?limit=1&countrySet=NL,BE,DE,FR&language=nl-NL`);
  const r = (g.results || [])[0];
  if (!r) throw new Error(`traffic: place not found: ${place}`);
  return { lat: r.position.lat, lon: r.position.lon, name: r.address && r.address.freeformAddress || p };
}

// departAt: omitted/"now", "HH:MM" (today), "tomorrow HH:MM" or "YYYY-MM-DD HH:MM" - local
// time - or an ISO timestamp. A time that has already passed means "now".
const TZ = "Europe/Amsterdam";

function _local(day, hh, mm) {
  // The UTC offset on that day (summer/winter time), read at roughly that moment.
  const at = new Date(`${day}T${hh}:${mm}:00Z`);
  const off = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" })
    .formatToParts(at).find((x) => x.type === "timeZoneName").value.replace("GMT", "") || "+00:00";
  return `${day}T${hh}:${mm}:00${off}`;
}

function _departAt(v) {
  const s = String(v || "").trim();
  if (!s || /^now$/i.test(s)) return "now";
  const m = s.match(/^(?:(tomorrow|\d{4}-\d{2}-\d{2})\s+)?(\d{1,2}):(\d{2})$/i);
  let iso = s;
  if (m) {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
    const day = !m[1] ? today
      : /^tomorrow$/i.test(m[1]) ? new Date(Date.parse(`${today}T12:00:00Z`) + 864e5).toISOString().slice(0, 10)
      : m[1];
    iso = _local(day, m[2].padStart(2, "0"), m[3]);
  }
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`traffic: unknown departure time: ${v}`);
  return t <= Date.now() + 60000 ? "now" : iso;
}

const KIND = { JAM: "jam", ROAD_WORK: "roadworks", ROAD_CLOSURE: "closure", OTHER: "incident" };
const mins = (s) => Math.round((s || 0) / 60);

async function route(from, to, departAt) {
  const [a, b] = await Promise.all([_where(from), _where(to)]);
  const dep = _departAt(departAt);
  const q = `/routing/1/calculateRoute/${a.lat},${a.lon}:${b.lat},${b.lon}/json?traffic=true&travelMode=car&routeType=fastest`
    + `&computeTravelTimeFor=all&sectionType=traffic&instructionsType=text&language=nl-NL&maxAlternatives=1&departAt=${encodeURIComponent(dep)}`;
  const r = await _get(q);
  const [best, alt] = r.routes || [];
  if (!best) throw new Error("traffic: no route");
  const sum = best.summary || {};
  const instr = ((best.guidance || {}).instructions || []).slice().sort((x, y) => x.pointIndex - y.pointIndex);
  const roadAt = (idx) => {
    let road = "";
    for (const i of instr) { if (i.pointIndex > idx) break; if ((i.roadNumbers || []).length) road = i.roadNumbers[0]; }
    return road;
  };
  const jams = (best.sections || []).filter((s) => s.sectionType === "TRAFFIC" && (s.delayInSeconds || 0) >= 60).map((s) => ({
    road: roadAt(s.startPointIndex) || null,
    kind: KIND[s.simpleCategory] || "incident",
    delayMin: mins(s.delayInSeconds),
    speedKmh: s.effectiveSpeedInKmh ?? null,
  }));
  const normal = sum.historicTrafficTravelTimeInSeconds || sum.noTrafficTravelTimeInSeconds || sum.travelTimeInSeconds;
  const out = {
    from: a.name, to: b.name, departAt: dep,
    km: Math.round((sum.lengthInMeters || 0) / 100) / 10,
    minutes: mins(sum.travelTimeInSeconds),
    freeFlowMinutes: mins(sum.noTrafficTravelTimeInSeconds),
    usualMinutes: mins(normal),
    delayMinutes: mins(sum.trafficDelayInSeconds),
    arrival: sum.arrivalTime || null,
    jams,
  };
  if (alt && alt.summary && alt.summary.travelTimeInSeconds + 300 < sum.travelTimeInSeconds) {
    out.fasterAlternative = { minutes: mins(alt.summary.travelTimeInSeconds), km: Math.round(alt.summary.lengthInMeters / 100) / 10 };
  }
  return out;
}

module.exports = { isConfigured, route };
