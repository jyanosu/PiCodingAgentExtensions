// Behavior tests for voice-input (run: node tests/voice-input.test.mjs)
// Covers: pure helpers, recordAudio stop() wiring, and the Alt+Q toggle state machine.
import assert from "node:assert";
import { readdir, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import voiceExt, { recordAudio, voiceTextToInput, parseMaxDuration } from "../extensions/voice-input/index.ts";

let passed = 0;
const ok = (name) => { passed++; console.log(`  ok - ${name}`); };

async function waitFor(fn, timeoutMs = 15000, intervalMs = 20) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return fn();
}

// --- voiceTextToInput: "slash <cmd>" → "/<cmd>" ---
assert.equal(voiceTextToInput("hello world"), "hello world");
assert.equal(voiceTextToInput("slash look what's wrong"), "/look what's wrong");
assert.equal(voiceTextToInput("slash voice."), "/voice");
assert.equal(voiceTextToInput("SLASH compact now"), "/compact now");
assert.equal(voiceTextToInput("slash"), "slash");
ok("voiceTextToInput rewrites spoken slash commands");

// --- parseMaxDuration: default 20s, cap 60s ---
assert.equal(parseMaxDuration("/voice"), 20);
assert.equal(parseMaxDuration("/voice 10"), 10);
assert.equal(parseMaxDuration("/voice 30"), 30);
assert.equal(parseMaxDuration("/voice 100"), 60);
assert.equal(parseMaxDuration("/voice 2"), 20);
assert.equal(parseMaxDuration("/voice abc"), 20);
ok("parseMaxDuration defaults 20s, caps 60s");

// --- recordAudio: stop() wiring ---
{
  const tmpBefore = new Set(await readdir(tmpdir()));
  const ra = recordAudio(2, "no-such-mic-device", 1);
  assert.equal(typeof ra.stop, "function");
  ra.stop();
  ra.stop(); // idempotent
  let resolved = null, rejected = null;
  ra.promise.then(r => { resolved = r; }, e => { rejected = e; });
  const settled = await waitFor(() => resolved !== null || rejected !== null);
  assert.ok(settled, "promise settles after stop()");
  if (resolved) {
    assert.equal(resolved.silenceEnd, undefined, "manual stop has no silenceEnd");
    const buf = await readFile(resolved.filePath);
    assert.ok(buf.length >= 44, "WAV written");
    assert.equal(buf.toString("ascii", 0, 4), "RIFF");
    await unlink(resolved.filePath).catch(() => {});
  } else {
    // Error path (e.g. ffmpeg missing): no orphan temp WAV written
    const orphans = (await readdir(tmpdir())).filter(n => n.startsWith("voice-") && !tmpBefore.has(n));
    assert.deepEqual(orphans, [], "no orphan temp WAV after rejection");
  }
  ok("recordAudio stop() settles promise, no orphan file");
}

// --- recordAudio: settles without stop (device error / close→settle path) ---
{
  const ra = recordAudio(2, "no-such-mic-device", 1);
  let resolved = null, rejected = null;
  ra.promise.then(r => { resolved = r; }, e => { rejected = e; });
  const settled = await waitFor(() => resolved !== null || rejected !== null, 20000);
  assert.ok(settled, "promise settles without stop()");
  if (resolved) await unlink(resolved.filePath).catch(() => {});
  ok("recordAudio settles on its own");
}

// --- Mock ExtensionAPI for state-machine tests ---
function makePi() {
  const pi = {
    handlers: {},
    shortcuts: {},
    sent: [],
    on(ev, h) { (pi.handlers[ev] ??= []).push(h); },
    registerShortcut(key, def) { pi.shortcuts[key] = def; },
    sendUserMessage(msg, opts) { pi.sent.push({ msg, opts }); },
  };
  voiceExt(pi);
  return pi;
}

function makeCtx() {
  const notifications = [];
  const statuses = {};
  const ctx = {
    ui: {
      notify: (msg, sev) => notifications.push({ msg, sev }),
      setStatus: (key, val) => { statuses[key] = val; },
    },
  };
  return { notifications, statuses, ctx };
}

// --- Alt+Q toggle: start → stop → ready → start → stop → ready ---
{
  const pi = makePi();
  const { notifications, statuses, ctx } = makeCtx();
  await pi.handlers.session_start[0]({}, ctx);
  assert.equal(statuses.voice, "ready", "session_start sets voice ready");

  const press = pi.shortcuts["alt+q"].handler;

  // Press 1: start
  await press(ctx);
  assert.equal(statuses.voice, "recording", "first press starts recording");
  assert.ok(notifications.some(n => n.msg.includes("Listening")), "listening notification");

  // Press 2 + 3 immediately: stop path, idempotent (no double-start, no crash)
  await press(ctx);
  await press(ctx);
  const stops = notifications.filter(n => n.msg.includes("stopping")).length;
  assert.ok(stops >= 1, "second press stops recording");
  assert.equal(statuses.voice, "recording", "still recording while flow finishes");

  // Flow must finish: status back to ready + exactly one terminal notification
  const done = await waitFor(() => statuses.voice === "ready");
  assert.ok(done, "flow returns to ready");
  const terminals = notifications.filter(n =>
    n.msg.includes("too short") || n.msg.startsWith("Voice error") || n.msg.includes("no speech"));
  assert.equal(terminals.length, 1, `exactly one terminal notification (got: ${notifications.map(n => n.msg).join(" | ")}`);

  // Press after ready: starts a new recording
  await press(ctx);
  assert.equal(statuses.voice, "recording", "press after ready starts new recording");
  await press(ctx); // stop it again
  const done2 = await waitFor(() => statuses.voice === "ready");
  assert.ok(done2, "second flow returns to ready");
  ok("Alt+Q toggle: start → stop → ready → start → stop → ready");
}

// --- /voice: busy guard + Alt+Q cross-stop ---
{
  const pi = makePi();
  const { notifications, statuses, ctx } = makeCtx();
  await pi.handlers.session_start[0]({}, ctx);
  const press = pi.shortcuts["alt+q"].handler;

  // Start via /voice (handler suspends at await promise — still "recording")
  const inputPromise = pi.handlers.input[0]({ text: "/voice" }, ctx);
  assert.equal(statuses.voice, "recording", "/voice starts recording");

  // While recording: second /voice is rejected as busy
  const r = await pi.handlers.input[0]({ text: "/voice" }, ctx);
  assert.equal(r.action, "handled");
  assert.ok(notifications.some(n => n.msg.includes("busy")), "busy guard rejects concurrent /voice");

  // Alt+Q stops the /voice recording
  await press(ctx);
  assert.ok(notifications.some(n => n.msg.includes("stopping")), "Alt+Q stops /voice recording");

  const done = await waitFor(() => statuses.voice === "ready");
  assert.ok(done, "/voice flow returns to ready");
  await inputPromise; // ensure no unhandled rejection
  ok("/voice: busy guard + Alt+Q cross-stop");
}

console.log(`\n${passed} test groups passed`);
