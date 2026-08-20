// Behavior tests for voice-input (run: node tests/voice-input.test.mjs)
// Covers: pure helpers, recordAudio stop() wiring, and the Alt+Q toggle state machine.
import assert from "node:assert";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import voiceExt, {
  recordAudio,
  voiceTextToInput,
  parseMaxDuration,
} from "../extensions/voice-input/index.ts";

let passed = 0;
const ok = (name) => {
  passed++;
  console.log(`  ok - ${name}`);
};

async function waitFor(fn, timeoutMs = 15000, intervalMs = 20) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
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
  let resolved = null,
    rejected = null;
  ra.promise.then(
    (r) => {
      resolved = r;
    },
    (e) => {
      rejected = e;
    },
  );
  const settled = await waitFor(() => resolved !== null || rejected !== null);
  assert.ok(settled, "promise settles after stop()");
  if (resolved) {
    assert.equal(
      resolved.silenceEnd,
      undefined,
      "manual stop has no silenceEnd",
    );
    const buf = await readFile(resolved.filePath);
    assert.ok(buf.length >= 44, "WAV written");
    assert.equal(buf.toString("ascii", 0, 4), "RIFF");
    await unlink(resolved.filePath).catch(() => {});
  } else {
    // Error path (e.g. ffmpeg missing): no orphan temp WAV written
    const orphans = (await readdir(tmpdir())).filter(
      (n) => n.startsWith("voice-") && !tmpBefore.has(n),
    );
    assert.deepEqual(orphans, [], "no orphan temp WAV after rejection");
  }
  ok("recordAudio stop() settles promise, no orphan file");
}

// --- recordAudio: settles without stop (device error / close→settle path) ---
{
  const ra = recordAudio(2, "no-such-mic-device", 1);
  let resolved = null,
    rejected = null;
  ra.promise.then(
    (r) => {
      resolved = r;
    },
    (e) => {
      rejected = e;
    },
  );
  const settled = await waitFor(
    () => resolved !== null || rejected !== null,
    20000,
  );
  assert.ok(settled, "promise settles without stop()");
  if (resolved) await unlink(resolved.filePath).catch(() => {});
  ok("recordAudio settles on its own");
}

// --- Silence detection path: fake ffmpeg streams 4s loud then silence ---
{
  const fakeBin = join(tmpdir(), `fake-ffmpeg-bin-${Date.now()}`);
  await mkdir(fakeBin);
  // Streams 500ms chunks in real time: loud (amplitude 10000) for 4s, then silence.
  // With silenceDuration=1, detection fires after 1s of silence → ~t=5s,
  // and the silence-end timestamp should be ≈ 4.0 (when speech actually ended).
  const script = `#!/usr/bin/env bash
exec node -e "
const R=16000;
const chunk=(sec,loud)=>{const b=Buffer.alloc(R*sec*2);if(loud)for(let i=0;i<R*sec;i++)b.writeInt16LE(10000,i*2);return b;};
let t=0;
const iv=setInterval(()=>{process.stdout.write(chunk(0.5,t<4));t+=0.5;if(t>=6)clearInterval(iv);},500);
setTimeout(()=>process.exit(0),6800);
"
`;
  await writeFile(join(fakeBin, "ffmpeg"), script, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${oldPath}`;
  try {
    const ra = recordAudio(10, "any-device", 1);
    let resolved = null;
    ra.promise.then((r) => {
      resolved = r;
    });
    const settled = await waitFor(() => resolved !== null, 15000);
    assert.ok(settled, "silence path settles the promise");
    assert.ok(
      resolved.silenceEnd !== undefined &&
        resolved.silenceEnd > 3.7 &&
        resolved.silenceEnd < 4.3,
      `silenceEnd ≈ 4.0s (speech end), got ${resolved.silenceEnd}`,
    );
    await unlink(resolved.filePath).catch(() => {});
  } finally {
    process.env.PATH = oldPath;
  }
  ok("silence detection stops recording and reports speech end (silenceEnd)");
}

// --- Mock ExtensionAPI for state-machine tests ---
function makePi() {
  const pi = {
    handlers: {},
    shortcuts: {},
    sent: [],
    on(ev, h) {
      (pi.handlers[ev] ??= []).push(h);
    },
    registerShortcut(key, def) {
      pi.shortcuts[key] = def;
    },
    sendUserMessage(msg, opts) {
      pi.sent.push({ msg, opts });
    },
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
      setStatus: (key, val) => {
        statuses[key] = val;
      },
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
  assert.ok(
    notifications.some((n) => n.msg.includes("Listening")),
    "listening notification",
  );

  // Press 2 + 3 immediately: stop path, idempotent (no double-start, no crash)
  await press(ctx);
  await press(ctx);
  const stops = notifications.filter((n) => n.msg.includes("stopping")).length;
  assert.ok(stops >= 1, "second press stops recording");
  assert.equal(
    statuses.voice,
    "recording",
    "still recording while flow finishes",
  );

  // Flow must finish: status back to ready + exactly one terminal notification
  const done = await waitFor(() => statuses.voice === "ready");
  assert.ok(done, "flow returns to ready");
  const terminals = notifications.filter(
    (n) =>
      n.msg.includes("too short") ||
      n.msg.startsWith("Voice error") ||
      n.msg.includes("no speech"),
  );
  assert.equal(
    terminals.length,
    1,
    `exactly one terminal notification (got: ${notifications.map((n) => n.msg).join(" | ")}`,
  );

  // Press after ready: starts a new recording
  await press(ctx);
  assert.equal(
    statuses.voice,
    "recording",
    "press after ready starts new recording",
  );
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
  assert.ok(
    notifications.some((n) => n.msg.includes("busy")),
    "busy guard rejects concurrent /voice",
  );

  // Alt+Q stops the /voice recording
  await press(ctx);
  assert.ok(
    notifications.some((n) => n.msg.includes("stopping")),
    "Alt+Q stops /voice recording",
  );

  const done = await waitFor(() => statuses.voice === "ready");
  assert.ok(done, "/voice flow returns to ready");
  await inputPromise; // ensure no unhandled rejection
  ok("/voice: busy guard + Alt+Q cross-stop");
}

// --- Alt+Q flow trims on silence stop (regression: shortcut path used to skip trim) ---
{
  const fakeBin = join(tmpdir(), `fake-ffmpeg-trim-${Date.now()}`);
  const logFile = join(tmpdir(), `fake-ffmpeg-log-${Date.now()}`);
  await mkdir(fakeBin);
  // Combined fake: record mode (first arg -nostdin) streams 4s loud + silence
  // in real time; trim mode writes a stub file to the last arg. All argv logged.
  const script = `#!/usr/bin/env bash
[ -n "$FAKE_FFMPEG_LOG" ] && echo "$@" >> "$FAKE_FFMPEG_LOG"
if [ "$1" = "-nostdin" ]; then
  exec node -e "
const R=16000;
const chunk=(sec,loud)=>{const b=Buffer.alloc(R*sec*2);if(loud)for(let i=0;i<R*sec;i++)b.writeInt16LE(10000,i*2);return b;};
let t=0;
const iv=setInterval(()=>{process.stdout.write(chunk(0.5,t<4));t+=0.5;if(t>=6)clearInterval(iv);},500)
setTimeout(()=>process.exit(0),6800)
"
fi
for last; do :; done
case "$last" in /*) printf 'RIFF' > "$last";; esac
`;
  await writeFile(join(fakeBin, "ffmpeg"), script, { mode: 0o755 });

  const oldPath = process.env.PATH;
  const oldWhisper = process.env.WHISPER_URL;
  const oldLog = process.env.FAKE_FFMPEG_LOG;
  process.env.PATH = `${fakeBin}:${oldPath}`;
  process.env.WHISPER_URL = "http://127.0.0.1:9"; // force fast transcribe failure
  process.env.FAKE_FFMPEG_LOG = logFile;
  try {
    const pi = makePi();
    const { statuses, ctx } = makeCtx();
    await pi.handlers.session_start[0]({}, ctx);

    await pi.shortcuts["alt+q"].handler(ctx); // start via shortcut
    assert.equal(statuses.voice, "recording", "Alt+Q starts recording");

    // Silence stop at ~t=5s → trim with -t ≈ 4.0 → transcribe fails fast → ready
    const done = await waitFor(() => statuses.voice === "ready", 20000);
    assert.ok(done, "Alt+Q flow returns to ready");

    const log = await readFile(logFile, "utf8").catch(() => "");
    const trimLine = log.split("\n").find((l) => l.split(/\s+/).includes("-t"));
    assert.ok(trimLine, `Alt+Q flow called trim on silence stop (log: ${log})`);
    const args = trimLine.split(/\s+/);
    const dur = parseFloat(args[args.indexOf("-t") + 1]);
    assert.ok(
      dur > 3.7 && dur < 4.3,
      `trim duration ≈ 4.0s (speech end), got ${dur}`
    );
  } finally {
    process.env.PATH = oldPath;
    if (oldWhisper === undefined) delete process.env.WHISPER_URL;
    else process.env.WHISPER_URL = oldWhisper;
    if (oldLog === undefined) delete process.env.FAKE_FFMPEG_LOG;
    else process.env.FAKE_FFMPEG_LOG = oldLog;
  }
  ok("Alt+Q flow trims trailing silence (silenceEnd reaches the shortcut path)");
}

console.log(`\n${passed} test groups passed`);
