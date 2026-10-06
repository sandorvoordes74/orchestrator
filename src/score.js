"use strict";

// Task scoring as the task app computes it, so the assistant starts from the same baseline the
// owner sees in the app: the list order (starred first, date tier, score) and the context-
// adjusted "Do Now" pick. Pure functions over normalized task fields (ISO dates, H/M/L); the
// assistant adds the real-world context on top. The work/private time windows are passed in
// (owner config, kept out of the code); DEFAULT_TIMING is a plain office-hours fallback.

const IMPORTANCE = { H: 6, M: 3, L: 1 };
const URGENCY = { H: { start: 10, window: 2 }, M: { start: 5, window: 7 }, L: { start: 1, window: 30 } };
const EFFORT_TIE = { L: 0.02, M: 0.01, H: 0 };
const EFFORT_MIN = { L: 25, M: 90, H: 240 };
const QUICK_MIN = 10; // call / mail / booking tasks
const QUICK_WORDS = /\b(call|phone|bel|bellen|mail|e-?mail|mailen|reply|respond|antwoord|book|boek|boeken|reserve|reserveer|reserveren|rsvp)\b/i;
const ENERGY = { LOW: 1, MEDIUM: 2, HIGH: 3 };
const PLACES = ["home", "office", "out", "car", "driving", "transit"];

// days: 1 = Monday ... 7 = Sunday; hours local, [from, to); the first matching window wins
const DEFAULT_TIMING = { windows: [{ days: [1, 2, 3, 4, 5], from: 8, to: 18, work: 5, private: 0 }], else: { work: 0, private: 5 } };

const r2 = (x) => Math.round(x * 100) / 100;
const dayDiff = (iso, today) => Math.round((Date.parse(iso) - Date.parse(today)) / 86400000);

function localNow(date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Amsterdam", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(date).map((x) => [x.type, x.value]));
  return { today: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, dow: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday) + 1, hour: Number(p.hour) + Number(p.minute) / 60 };
}

function timingBonus(taskType, now, timing) {
  const w = ((timing || DEFAULT_TIMING).windows || []).find((x) => (x.days || []).includes(now.dow) && now.hour >= x.from && now.hour < x.to) || (timing || DEFAULT_TIMING).else || {};
  const work = Number(w.work) || 0, priv = Number(w.private) || 0;
  const type = String(taskType || "").toUpperCase();
  return type === "PRIVATE" ? priv : type === "BOTH" ? Math.max(work, priv) : work; // BOTH gets the applicable one, not both
}

// t: { id, task, starred, importance, urgency, effort, taskType, deadline, reviewDate, created, urgencySet }
function baseScore(t, now, timing) {
  const dd = t.deadline ? dayDiff(t.deadline, now.today) : null;
  const dr = t.reviewDate ? dayDiff(t.reviewDate, now.today) : null;
  const parts = { importance: IMPORTANCE[t.importance] ?? IMPORTANCE.M };
  if (t.starred) parts.star = 4;
  if (dd !== null && dd < 14) parts.deadline = dd < 0 ? 20 : 12 * (1 - dd / 14);
  if (t.importance === "H" && t.effort === "L") parts.quickWin = 2;
  if (dr !== null && dr > 0) {
    if (dr < 14) parts.reviewApproach = 5 * (1 - dr / 14); // a future review date replaces urgency and aging
  } else {
    const u = URGENCY[t.urgency] || URGENCY.M;
    parts.urgency = u.start;
    const clock = [t.urgencySet, t.reviewDate, t.created].find((d) => d && !isNaN(Date.parse(d))) || now.today;
    const beyond = -dayDiff(clock, now.today) - u.window;
    if (beyond > 0) parts.aging = Math.min(8, (beyond * 8) / u.window);
  }
  const timingPts = timingBonus(t.taskType, now, timing);
  if (timingPts) parts.timing = timingPts;
  parts.effortTie = EFFORT_TIE[t.effort] ?? EFFORT_TIE.M;
  for (const k of Object.keys(parts)) parts[k] = r2(parts[k]);
  const tier = dd !== null && dd < 0 ? 1 : dd !== null && dd <= 1 ? 2 : dr !== null && dr <= 1 ? 3 : dd !== null && dd <= 7 ? 4 : 5;
  return { score: r2(Object.values(parts).reduce((a, b) => a + b, 0)), tier, parts };
}

// The app's list order: starred first, then date tier, then score, then id.
const listOrder = (a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0) || a.tier - b.tier || b.score - a.score || String(a.id).localeCompare(String(b.id));

const estMinutes = (t) => (QUICK_WORDS.test(String(t.task || "")) ? QUICK_MIN : EFFORT_MIN[t.effort] ?? EFFORT_MIN.M);
const reqTokens = (r) => String(r || "").replace(/^\s*AUTO:\s*/i, "").split(/[,;]+/).map((x) => x.trim().toUpperCase()).filter((x) => x && x !== "NONE");

// Do Now: the base score adjusted for the current context, infeasible tasks excluded.
// ctx: { place: home|office|out|car|driving|transit, energy: LOW|MEDIUM|HIGH, minutes, daylight }
function doNow(scored, ctx, now) {
  const place = String(ctx.place || "home").toLowerCase();
  if (!PLACES.includes(place)) throw new Error(`place must be one of ${PLACES.join(", ")}`);
  const daylight = ctx.daylight ?? (now.hour >= 8 && now.hour < 18);
  const myEnergy = ENERGY[String(ctx.energy || "MEDIUM").toUpperCase()] || ENERGY.MEDIUM;
  const minutes = ctx.minutes == null ? null : Number(ctx.minutes);
  const feasible = [], excluded = {};
  for (const s of scored) {
    const req = reqTokens(s.requirements), est = estMinutes(s);
    const why =
      req.includes("HOME_TOOLS") && place !== "home" ? "needs home" :
      req.includes("ERRAND") && place !== "out" ? "errand - only when out" :
      place === "driving" && req.some((r) => !["PHONE_CALL", "HANDS_FREE", "INTERNET", "BUSINESS_HOURS"].includes(r)) ? "not while driving" :
      place === "transit" && req.some((r) => ["PHONE_CALL", "QUIET_PRIVACY", "HOME_TOOLS", "HANDS_FREE"].includes(r)) ? "not on public transport" :
      req.includes("BUSINESS_HOURS") && !(now.dow <= 5 && now.hour >= 9 && now.hour < 17) ? "outside business hours" :
      req.includes("DAYLIGHT") && !daylight ? "needs daylight" :
      minutes !== null && est > minutes ? "does not fit the time" : "";
    if (why) { excluded[why] = (excluded[why] || 0) + 1; continue; }
    const adj = {};
    if (s.committedToday) adj.committed = 10;
    const desk = req.includes("LAPTOP") || req.includes("FOCUS");
    if (desk && (place === "home" || place === "office")) adj.desk = 5;
    if (desk && (place === "out" || place === "car")) adj.desk = -6;
    if (req.includes("PHONE_CALL") && place !== "driving" && place !== "transit") adj.call = 3;
    const gap = (ENERGY[String(s.energy || "MEDIUM").toUpperCase()] || ENERGY.MEDIUM) - myEnergy;
    adj.energy = gap <= 0 ? 4 : gap === 1 ? -7 : -14;
    if (minutes !== null) adj.fits = 5;
    feasible.push({ ...s, estMin: est, adjusted: r2(s.score + Object.values(adj).reduce((a, b) => a + b, 0)), adjustments: adj });
  }
  // like the app today: no starred-first grouping here, the star only counts its +4
  feasible.sort((a, b) => a.tier - b.tier || b.adjusted - a.adjusted || String(a.id).localeCompare(String(b.id)));
  return { feasible, excluded };
}

module.exports = { DEFAULT_TIMING, localNow, baseScore, listOrder, estMinutes, doNow };
