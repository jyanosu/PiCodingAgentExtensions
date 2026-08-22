// Behavior tests for highlight-footer width clamping
// (run: node tests/highlight-footer.test.mjs)
// Regression: footer lines that exceed the terminal width crash the TUI
// ("Rendered line N exceeds terminal width"). Lines are clamped with
// pi-tui's own truncateToWidth, so this test measures with pi-tui's own
// visibleWidth — the same algorithm the TUI checker uses.
import assert from "node:assert";
import { visibleWidth } from "@earendil-works/pi-tui";
import footerExt from "../extensions/highlight-footer.ts";

const ok = (name) => console.log(`  ok - ${name}`);

// --- composeModelLine is exported; sanity-check its width honesty ---
import { composeModelLine } from "../extensions/highlight-footer.ts";

{
  const line = composeModelLine(
    "model",
    "⚡ 0.1s (fast)",
    "[bar] 1% | 1k/200k",
    120,
  );
  assert.ok(
    visibleWidth(line) <= 120,
    `model line fits: ${visibleWidth(line)}`,
  );
  const narrow = composeModelLine("m", "", "b", 10);
  assert.ok(visibleWidth(narrow) <= 10);
}
ok("composeModelLine output fits its width");

// --- Full render: long statuses must not overflow the terminal width ---
async function renderFooter({
  width = 120,
  statuses,
  model = "test-model",
} = {}) {
  const handlers = {};
  const pi = { on: (ev, h) => (handlers[ev] = h) };
  footerExt(pi);
  let factory;
  const ctx = {
    mode: "tui",
    cwd: "/proj/test",
    model: { name: model },
    getContextUsage: () => ({ tokens: 1000, contextWindow: 200000 }),
    ui: {
      setWidget: () => {},
      setFooter: (f) => (factory = f),
    },
  };
  await handlers.session_start({}, ctx);
  assert.ok(factory, "setFooter was called");
  const theme = {
    fg: (_c, s) => `\x1b[34m${s}\x1b[0m`,
    bold: (s) => s,
    dim: (s) => s,
  };
  const footerData = {
    getExtensionStatuses: () =>
      new Map(
        statuses ?? [
          ["voice", "ready"],
          ["response-latency", "\x1b[32m⚡ 0.1s (fast)\x1b[0m"],
          [
            "working-indicator",
            "\x1b[2m>>> context-aware (auto) | thinking\x1b[0m",
          ],
        ],
      ),
  };
  const { render } = factory({ requestRender() {} }, theme, footerData);
  const lines = render(width);
  // Clean up the git-refresh interval so the test process can exit
  handlers.session_shutdown();
  return lines;
}

{
  const lines = await renderFooter();
  assert.strictEqual(lines.length, 2);
  for (const [i, line] of lines.entries()) {
    assert.ok(
      visibleWidth(line) <= 120,
      `line ${i + 1} fits 120 (got ${visibleWidth(line)}): ${JSON.stringify(line)}`,
    );
  }
  assert.ok(lines[0].includes("test"), "line 1 keeps project name");
}
ok("render with voice+latency+indicator statuses fits 120");

// The original crash: ⚡ counts 2 cells in pi's width algorithm — a line that
// a string-width-style measure calls 120 is 121 for the TUI.
{
  const lines = await renderFooter({
    statuses: [
      ["response-latency", "\x1b[32m⚡ 12.3s (fast)\x1b[0m"],
      [
        "working-indicator",
        "\x1b[2m>>> context-aware (auto) | thinking\x1b[0m",
      ],
    ],
    model: "a-very-long-model-name-that-takes-up-space-in-the-footer-line",
  });
  for (const [i, line] of lines.entries()) {
    assert.ok(
      visibleWidth(line) <= 120,
      `line ${i + 1} fits 120 (got ${visibleWidth(line)})`,
    );
  }
}
ok("emoji latency icon (2 cells) never pushes a line past the width");

// Narrow terminal: everything clamps, nothing overflows
{
  const lines = await renderFooter({ width: 40 });
  for (const [i, line] of lines.entries()) {
    assert.ok(
      visibleWidth(line) <= 40,
      `line ${i + 1} fits 40 (got ${visibleWidth(line)})`,
    );
  }
}
ok("narrow terminal (40) clamps both lines");

// No statuses at all: minimal footer still fits and has no ellipsis junk
{
  const lines = await renderFooter({ statuses: [] });
  assert.ok(visibleWidth(lines[0]) <= 120);
  assert.ok(visibleWidth(lines[1]) <= 120);
  assert.ok(!lines[0].includes("..."), "no ellipsis when line fits");
}
ok("minimal footer renders without ellipsis");

console.log("\nAll highlight-footer tests passed");
