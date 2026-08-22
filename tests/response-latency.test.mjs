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

// --- State machine: per-model-call wait, not whole-turn ---
import latencyExt from "../extensions/response-latency.ts";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

{
  const handlers = {};
  const pi = { on: (ev, h) => (handlers[ev] = h) };
  latencyExt(pi);
  const statuses = [];
  const ctx = {
    ui: {
      theme: { fg: (_c, s) => s },
      setStatus: (_k, v) => statuses.push(v),
    },
  };

  await handlers.agent_start({}, ctx);
  assert.ok(statuses.length >= 1, "counting starts on agent_start");
  // Combined display: response wait | whole-turn stopwatch
  assert.match(statuses[0], /^⚡ 0ms \| ◷ 0ms$/, `first tick: ${statuses[0]}`);
  await sleep(250);
  const counting = statuses.length;
  assert.ok(counting > 1, "timer keeps ticking while waiting");

  // Response arrives → response part freezes with ✓, turn part keeps running
  await handlers.message_start({ message: { role: "assistant" } }, ctx);
  await sleep(50);
  const frozen = statuses[statuses.length - 1];
  assert.match(
    frozen,
    /⚡ \d.* ✓ \| ◷ /,
    `response frozen, turn live: ${frozen}`,
  );

  // Tools finish → next model call counts again (no ✓ on response part)
  await handlers.tool_execution_end({}, ctx);
  await sleep(50);
  const restarted = statuses[statuses.length - 1];
  assert.ok(
    !restarted.split("|")[0].includes("✓"),
    `counting resumes after tools: ${restarted}`,
  );

  // Turn ends → both parts freeze with ✓, no more ticks
  await handlers.agent_end({}, ctx);
  const ended = statuses[statuses.length - 1];
  assert.match(ended, /◷ .* ✓$/, `frozen turn value: ${ended}`);
  const afterEnd = statuses.length;
  await sleep(300);
  assert.strictEqual(statuses.length, afterEnd, "no ticks after agent_end");

  handlers.session_shutdown();
}
ok("state machine: per-call wait + whole-turn stopwatch, freeze at turn end");

console.log("\nAll response-latency tests passed");
