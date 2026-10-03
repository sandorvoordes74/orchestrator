"use strict";

// Smoke test (OpenSpec tasks 1.2 + 2.3): prove the service account can READ the
// real sheet. Read-only — makes no changes. Run locally with the SA key:
//
//   GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json npm run read
//   # or
//   GOOGLE_SERVICE_ACCOUNT_KEY="$(cat key.json)" npm run read

const { listTabs, getTasks, distinctLabels, sourceUrlIndex } = require("./sheets");
const { SPREADSHEET_ID, STAGING_TAB, STATE_TAB } = require("./config");

async function main() {
  require("./config").assertConfig();
  console.log(`Spreadsheet: ${SPREADSHEET_ID}\n`);

  const { spreadsheetTitle, tabs } = await listTabs();
  console.log(`AUTH OK — opened "${spreadsheetTitle}"`);
  console.log(`Tabs: ${tabs.join(", ")}`);
  console.log(`  Staging tab present: ${tabs.includes(STAGING_TAB) ? "yes" : "no (will be created later)"}`);
  console.log(`  ${STATE_TAB} tab present: ${tabs.includes(STATE_TAB) ? "yes" : "no (will be created later)"}\n`);

  const { sheetName, map, tasks } = await getTasks();
  console.log(`Tasks tab: "${sheetName}"`);
  console.log(`Column map (header → index): ${JSON.stringify(
    Object.fromEntries(Object.entries(map).filter(([k]) => !k.startsWith("_") && k !== "hasIdColumn")),
  )}`);
  console.log(`Has ID column: ${map.hasIdColumn}\n`);

  console.log(`READ OK — ${tasks.length} task(s).`);
  console.log(`Labels in use (${distinctLabels(tasks).length}): ${distinctLabels(tasks).join(", ") || "(none)"}`);
  console.log(`Distinct source URLs in Context: ${sourceUrlIndex(tasks).size}\n`);

  console.log("First few tasks:");
  for (const t of tasks.slice(0, 5)) {
    console.log(`  • [${t.id || "no-id"}] ${t.task || "(no title)"}  {imp:${t.importance} urg:${t.urgency} eff:${t.effort}${t.prio ? " PRIO" : ""}}  label:${t.label || "-"}`);
  }

  console.log("\n✅ Service-account READ path works against the live sheet.");
}

main().catch((e) => {
  console.error("\nread failed:", e.message);
  if (e.message && e.message.includes("not found")) {
    console.error("→ Is the sheet shared with the service-account client_email as Editor?");
  }
  process.exit(1);
});
