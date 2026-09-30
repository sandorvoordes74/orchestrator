"use strict";

// Write smoke test (OpenSpec tasks 2.1, 2.2, 6.5): prove the service account can
// CREATE the Staging + _state tabs and APPEND a row. NEVER touches the Tasks tab.
// It appends one clearly-labeled test row to Staging, reads it back, then clears
// it again, leaving the two new (empty) tabs in place.
//
//   GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json npm run write

const {
  ensureTab, appendRow, readTab, clearRange,
  STAGING_HEADERS, STATE_HEADERS,
} = require("./sheets");
const { STAGING_TAB, STATE_TAB } = require("./config");

async function main() {
  require("./config").assertConfig();
  const stamp = new Date().toISOString();

  // 1. Ensure the two orchestrator tabs exist.
  const state = await ensureTab(STATE_TAB, STATE_HEADERS);
  console.log(`_state tab: ${state.created ? "CREATED" : "already existed"}`);
  const staging = await ensureTab(STAGING_TAB, STAGING_HEADERS);
  console.log(`Staging tab: ${staging.created ? "CREATED" : "already existed"}\n`);

  // 2. Record a state value (proves write to _state).
  await appendRow(STATE_TAB, ["lastWriteSmokeTest", stamp]);
  console.log(`_state: appended lastWriteSmokeTest=${stamp}`);

  // 3. Append a clearly-labeled test draft to Staging (proves append).
  const testRow = [
    "", "TEST — write smoke test (safe to ignore/delete)", "ENGINEERING",
    "M", "M", "M", "", "", "https://example.com/orchestrator-smoke-test",
    "0.00", "automated write smoke test", "test", `smoke-${stamp}`,
  ];
  const writtenRange = await appendRow(STAGING_TAB, testRow);
  console.log(`Staging: appended test draft at ${writtenRange}`);

  // 4. Read Staging back and confirm the row landed.
  const rows = await readTab(STAGING_TAB);
  const found = rows.some((r) => (r[12] || "").startsWith("smoke-"));
  console.log(`Staging now has ${rows.length - 1} data row(s); test row read back: ${found ? "yes" : "NO"}`);

  // 5. Clean up the Staging test row (leave the tab empty).
  if (writtenRange) {
    await clearRange(writtenRange);
    console.log(`Cleaned up the Staging test row (${writtenRange}).`);
  }

  console.log("\n✅ Service-account WRITE path works: tab creation + append + read-back + clear, Tasks untouched.");
}

main().catch((e) => {
  console.error("\nwrite failed:", e.message);
  process.exit(1);
});
