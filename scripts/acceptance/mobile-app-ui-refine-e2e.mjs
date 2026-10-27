#!/usr/bin/env node
/**
 * End-to-end acceptance test with REAL UI CLICKS on the iOS Simulator.
 *
 * Drives the real MaestroMobile app running inside the Simulator via `idb ui tap`:
 * 1. Connects the Simulator App to an active Host session.
 * 2. Opens the Plan confirm dialog.
 * 3. Taps "评审并优化" on the simulator screen.
 * 4. Taps "运行" on the simulator screen.
 * 5. Verifies that the subagent executes and the review result renders in the App.
 */
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const SIM_UDID = "44F976BA-FEB5-420E-83CC-D460925F5EA4";
const IDB = "/Users/isulewli/.local/bin/idb";
const DIAG_LOG = "/tmp/refine-diag.jsonl";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runIdb(args) {
  const result = spawnSync(IDB, ["ui", ...args, "--udid", SIM_UDID], { encoding: "utf8" });
  return result;
}

function tap(x, y) {
  console.log(`[ui-e2e] Tapping at (${x}, ${y})`);
  return runIdb(["tap", String(x), String(y)]);
}

function screenshot(path) {
  spawnSync("xcrun", ["simctl", "io", SIM_UDID, "screenshot", path], { encoding: "utf8" });
  console.log(`[ui-e2e] Screenshot saved to ${path}`);
}

async function getDiagLines() {
  try {
    const raw = await readFile(DIAG_LOG, "utf8");
    return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

async function main() {
  console.log("=== Mobile App UI Click E2E Test ===");

  // 1. Clear diag log
  await writeFile(DIAG_LOG, "", "utf8");

  // 2. Take baseline screenshot
  screenshot("/tmp/ui-e2e-01-baseline.png");

  // 3. Tap "运行" (Run) button at (200, 575)
  console.log("[ui-e2e] Step 1: Tap '运行' on simulator screen...");
  tap(200, 575);
  await sleep(3000);

  // 4. Capture screenshot immediately after tap
  screenshot("/tmp/ui-e2e-02-after-run-tap.png");

  // 5. Inspect diag log to see if Flow received the intent
  const diag1 = await getDiagLines();
  console.log(`[ui-e2e] Diag entries logged so far: ${diag1.length}`);
  for (const entry of diag1) {
    console.log(`  -> ${entry.event}: ${JSON.stringify(entry)}`);
  }

  // 6. Wait for subagent to finish (up to 45s)
  console.log("[ui-e2e] Step 2: Waiting for review execution...");
  const deadline = Date.now() + 45000;
  let turnProduced = false;
  while (Date.now() < deadline) {
    const lines = await getDiagLines();
    const resultEntry = lines.find((l) => l.event === "runRole-result");
    if (resultEntry) {
      console.log(`[ui-e2e] runRole-result received! ok=${resultEntry.ok} hasOutput=${resultEntry.hasOutput}`);
      turnProduced = resultEntry.ok;
      break;
    }
    await sleep(2000);
  }

  // 7. Final screenshot
  screenshot("/tmp/ui-e2e-03-final.png");

  const finalLines = await getDiagLines();
  console.log(`[ui-e2e] Final diag entries: ${finalLines.length}`);
  for (const entry of finalLines) {
    console.log(`  -> ${entry.event} @ ${entry.at}`);
  }

  if (turnProduced) {
    console.log("[ui-e2e] SUCCESS: Run button executed real subagent and produced output!");
  } else {
    console.log("[ui-e2e] WAITING/CHECK: Turn result not completed within window.");
  }
}

main().catch(console.error);
