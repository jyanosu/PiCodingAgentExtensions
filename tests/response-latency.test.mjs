// Behavior tests for response-latency phase thresholds (local AI scale)
// (run: node tests/response-latency.test.mjs)
import assert from "node:assert";
import { getPhase, formatTime } from "../extensions/response-latency.ts";

const ok = (name) => console.log(`  ok - ${name}`);

// --- Phase boundaries: 60s is still normal, stalling starts at 120s ---
assert.strictEqual(getPhase(0).label, "fast");
assert.strictEqual(getPhase(29_999).label, "fast");
assert.strictEqual(getPhase(30_000).label, "normal");
assert.strictEqual(getPhase(59_999).label, "normal");
assert.strictEqual(getPhase(60_000).label, "slow");
assert.strictEqual(getPhase(119_999).label, "slow");
assert.strictEqual(getPhase(120_000).label, "stalling");
assert.strictEqual(getPhase(600_000).label, "stalling");
ok("getPhase: <30s fast, 30-60s normal, 60-120s slow, >120s stalling");

assert.strictEqual(getPhase(0).color, "success");
assert.strictEqual(getPhase(120_000).color, "error");
ok("getPhase colors: fast=success, stalling=error");

// --- formatTime: seconds under a minute, m:ss above ---
assert.strictEqual(formatTime(500), "500ms");
assert.strictEqual(formatTime(1_500), "1.5s");
assert.strictEqual(formatTime(59_999), "60.0s");
assert.strictEqual(formatTime(60_000), "1m00s");
assert.strictEqual(formatTime(90_000), "1m30s");
assert.strictEqual(formatTime(125_000), "2m05s");
assert.strictEqual(formatTime(300_000), "5m00s");
ok("formatTime: ms / x.xs / m:ss");

console.log("\nAll response-latency tests passed");
