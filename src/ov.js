"use strict";

// Public transport: NS trains (official NS API, free 'Ns-App' product) and live bus/tram
// departures (OVapi, open data, no key). Env vars, never code:
//
//   NS_API_KEY  (needed for trains) the primary subscription key from apiportal.ns.nl
//
// Bus stops are passed in by the caller (timing point codes), so no home location lives here.

const https = require("https");
const http = require("http");

const NS = "https://gateway.apiportal.ns.nl/reisinformatie-api/api";
const OVAPI = "http://v0.ovapi.nl"; // OVapi only serves plain http
const TZ = "Europe/Amsterdam";

function nsConfigured() {
  return Boolean(process.env.NS_API_KEY);
}

function _get(url, headers) {
  const lib = url.startsWith("https:") ? https : http;
  return new Promise((resolve, reject) => {
    lib.get(url, { headers: { Accept: "application/json", ...headers }, timeout: 30000 }, (res) => {
      let c = "";
      res.on("data", (d) => (c += d));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`ov: HTTP ${res.statusCode} ${c.slice(0, 160)}`));
        try { resolve(JSON.parse(c)); } catch (e) { reject(new Error("ov: not JSON")); }
      });
    }).on("timeout", function () { this.destroy(new Error("ov: timeout")); }).on("error", reject);
  });
}

const _ns = (path) => _get(`${NS}${path}`, { "Ocp-Apim-Subscription-Key": process.env.NS_API_KEY });
const _hm = (iso) => (iso ? new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : null);
// OVapi gives local wall-clock times without an offset; make them absolute.
const _ams = (local) => {
  if (!local) return local;
  const off = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" })
    .formatToParts(new Date(`${local}Z`)).find((x) => x.type === "timeZoneName").value.replace("GMT", "") || "+00:00";
  return `${local}${off}`;
};
const _late = (planned, actual) => (planned && actual ? Math.round((Date.parse(actual) - Date.parse(planned)) / 60000) : 0);

// 'now', 'HH:MM' (today), 'tomorrow HH:MM' or 'YYYY-MM-DD HH:MM' (local time) -> ISO with offset.
function _when(v) {
  const s = String(v || "").trim();
  if (!s || /^now$/i.test(s)) return null;
  const m = s.match(/^(?:(tomorrow|\d{4}-\d{2}-\d{2})\s+)?(\d{1,2}):(\d{2})$/i);
  if (!m) return s;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
  const day = !m[1] ? today : /^tomorrow$/i.test(m[1]) ? new Date(Date.parse(`${today}T12:00:00Z`) + 864e5).toISOString().slice(0, 10) : m[1];
  const hh = m[2].padStart(2, "0");
  const off = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" })
    .formatToParts(new Date(`${day}T${hh}:${m[3]}:00Z`)).find((x) => x.type === "timeZoneName").value.replace("GMT", "") || "+00:00";
  return `${day}T${hh}:${m[3]}:00${off}`;
}

// A station code ('UT', 'RTD') as is; a name is looked up once.
async function _station(q) {
  const s = String(q || "").trim();
  if (/^[A-Z]{2,5}$/.test(s)) return s;
  const r = await _ns(`/v2/stations?q=${encodeURIComponent(s)}&limit=1`);
  const st = (r.payload || [])[0];
  if (!st) throw new Error(`ov: station not found: ${q}`);
  return st.code;
}

// Next train trips from -> to around a time: departure/arrival with delays and platforms,
// duration, transfers, status (NORMAL, CANCELLED, DISRUPTION, ...), crowding and messages.
async function trips(from, to, when) {
  const [a, b] = await Promise.all([_station(from), _station(to)]);
  const t = _when(when);
  const r = await _ns(`/v3/trips?fromStation=${a}&toStation=${b}${t ? `&dateTime=${encodeURIComponent(t)}` : ""}`);
  return {
    from: a, to: b,
    trips: (r.trips || []).slice(0, 5).map((trip) => {
      const legs = trip.legs || [];
      const first = (legs[0] || {}).origin || {}, last = (legs[legs.length - 1] || {}).destination || {};
      return {
        depart: _hm(first.plannedDateTime),
        departLate: _late(first.plannedDateTime, first.actualDateTime),
        track: first.actualTrack || first.plannedTrack || null,
        arrive: _hm(last.plannedDateTime),
        arriveLate: _late(last.plannedDateTime, last.actualDateTime),
        minutes: trip.actualDurationInMinutes || trip.plannedDurationInMinutes || null,
        transfers: trip.transfers,
        status: trip.status,
        crowd: trip.crowdForecast || null,
        trains: legs.filter((l) => l.product).map((l) => `${l.product.shortCategoryName || l.product.categoryCode || ""} ${l.direction || ""}`.trim() + (l.cancelled ? " (cancelled)" : "")),
        messages: [...(trip.messages || []), ...legs.flatMap((l) => l.messages || [])].map((m) => m.text || m.title || m.head).filter(Boolean).slice(0, 3),
      };
    }),
  };
}

// Active disruptions and maintenance: all of them, or only those affecting the given stations.
async function disruptions(stations) {
  const codes = await Promise.all((stations || []).map(_station));
  const lists = codes.length
    ? await Promise.all(codes.map((c) => _ns(`/v3/disruptions/station/${c}`)))
    : [await _ns("/v3/disruptions?isActive=true")];
  const seen = new Set();
  const out = [];
  for (const d of lists.flat()) {
    if (!d || seen.has(d.id) || d.isActive === false) continue;
    seen.add(d.id);
    out.push({
      type: d.type,
      title: d.title || (d.titleSections || []).flat().map((x) => x.value).join(" ") || null,
      impact: d.impact && d.impact.value != null ? d.impact.value : null,
      until: d.expectedDuration && d.expectedDuration.endTime ? _hm(d.expectedDuration.endTime) : null,
      period: d.period || null,
    });
  }
  return { stations: codes, disruptions: out.slice(0, 10) };
}

// Live departures at one or more bus/tram stops (OVapi timing point codes), optionally one line,
// plus the operator's messages for those stops (detours, a stop that is skipped or moved: KV15
// "GeneralMessages") and buses marked cancelled at the stop. A bus that skips a stop because of
// a detour usually does not show up at all - the messages are then the only clue.
const _msgText = (m) => [m.MessageContent, m.ReasonContent, m.EffectContent, m.MeasureContent, m.AdviceContent]
  .filter((x) => x && String(x).trim()).map((x) => String(x).trim()).filter((x, i, a) => a.indexOf(x) === i).join(" - ");
async function departures(stops, line) {
  const r = await _get(`${OVAPI}/tpc/${encodeURIComponent(String(stops).replace(/\s+/g, ""))}`);
  const out = [];
  const messages = [];
  for (const [code, stop] of Object.entries(r || {})) {
    for (const m of Object.values(stop.GeneralMessages || {})) {
      const text = _msgText(m || {});
      if (!text) continue;
      messages.push({ stop: (stop.Stop && stop.Stop.TimingPointName) || code, text, from: _hm(_ams(m.MessageStartTime)), until: _hm(_ams(m.MessageEndTime)), type: m.MessageType || null });
    }
    for (const p of Object.values(stop.Passes || {})) {
      if (line && String(p.LinePublicNumber) !== String(line)) continue;
      const planned = _ams(p.TargetDepartureTime), expected = _ams(p.ExpectedDepartureTime) || planned;
      if (Date.parse(expected) < Date.now() - 60000) continue;
      out.push({
        stop: (stop.Stop && stop.Stop.TimingPointName) || code,
        line: p.LinePublicNumber,
        to: p.DestinationName50,
        planned: _hm(planned),
        expected: _hm(expected),
        late: _late(planned, expected),
        status: p.TripStopStatus, // PLANNED, DRIVING, ARRIVED, PASSED, CANCEL, ...
        ...(p.TripStopStatus === "CANCEL" ? { cancelled: true } : {}),
        sort: Date.parse(expected),
      });
    }
  }
  out.sort((x, y) => (x.sort < y.sort ? -1 : 1));
  const deps = out.slice(0, 8).map(({ sort, ...d }) => d);
  return { departures: deps, messages, warning: messages.length || deps.some((d) => d.cancelled) ? "check messages / cancelled trips" : null };
}

module.exports = { nsConfigured, trips, disruptions, departures };
