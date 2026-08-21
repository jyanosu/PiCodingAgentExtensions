// Behavior tests for obsidian-logger image embedding
// (run: node tests/obsidian-logger.test.mjs)
import assert from "node:assert";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractUserImages,
  appendToDailyFile,
} from "../extensions/obsidian-logger/index.ts";

const ok = (name) => console.log(`  ok - ${name}`);

// 1x1 transparent PNG
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

// --- extractUserImages: pure extraction from message content ---
assert.deepStrictEqual(extractUserImages("plain string"), []);
assert.deepStrictEqual(extractUserImages(undefined), []);
assert.deepStrictEqual(
  extractUserImages([
    { type: "text", text: "hi" },
    { type: "image", data: "AAA", mimeType: "image/png" },
  ]),
  [{ data: "AAA", mimeType: "image/png" }],
);
// invalid blocks are skipped, not fatal
assert.deepStrictEqual(
  extractUserImages([
    { type: "image", data: 123, mimeType: "image/png" },
    { type: "image", data: "AAA" },
    null,
    { type: "thinking", text: "x" },
  ]),
  [],
);
assert.deepStrictEqual(
  extractUserImages([
    { type: "image", data: "AAA", mimeType: "image/png" },
    { type: "image", data: "BBB", mimeType: "image/jpeg" },
  ]),
  [
    { data: "AAA", mimeType: "image/png" },
    { data: "BBB", mimeType: "image/jpeg" },
  ],
  "multiple images keep order",
);
ok("extractUserImages picks image blocks, skips invalid");

// --- appendToDailyFile: writes image + embeds it under the entry ---
async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "obslog-test-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const makeCtx = (root) => ({
  cwd: root,
  model: undefined,
  hasUI: false,
  ui: { notify: () => {} },
});

const sessionFolder = (root) => join(root, "Projects", "proj", "sess1");

// tmp mode: relative markdown link
await withRoot(async (root) => {
  await appendToDailyFile(
    makeCtx(root),
    root,
    "proj",
    "sess1",
    "user",
    "my prompt",
    [{ data: PNG_B64, mimeType: "image/png" }],
    "tmp",
  );
  const files = await readdir(sessionFolder(root));
  const mdName = files.find((f) => f.endsWith(".md"));
  assert.ok(mdName, "daily md file created");
  const md = await readFile(join(sessionFolder(root), mdName), "utf8");
  assert.ok(md.includes("## 👤 Prompt"), "prompt entry present");
  const m = md.match(/!\[\]\(images\/(img-[^)]+\.png)\)/);
  assert.ok(m, `relative embed present (md: ${md})`);
  const imgBytes = await readFile(join(sessionFolder(root), "images", m[1]));
  assert.ok(
    imgBytes[0] === 0x89 && imgBytes.slice(1, 4).toString() === "PNG",
    "written file is a valid PNG",
  );
  assert.strictEqual(imgBytes.length, Buffer.from(PNG_B64, "base64").length);
});
ok("appendToDailyFile (tmp) writes image + relative embed");

// vault mode: Obsidian wikilink
await withRoot(async (root) => {
  await appendToDailyFile(
    makeCtx(root),
    root,
    "proj",
    "sess1",
    "user",
    "screenshot question",
    [{ data: PNG_B64, mimeType: "image/jpeg" }],
    "vault",
  );
  const files = await readdir(sessionFolder(root));
  const mdName = files.find((f) => f.endsWith(".md"));
  const md = await readFile(join(sessionFolder(root), mdName), "utf8");
  const m = md.match(/!\[\[(img-[^\]]+\.jpg)\]\]/);
  assert.ok(m, `wikilink embed present (md: ${md})`);
  const imgFiles = await readdir(join(sessionFolder(root), "images"));
  assert.deepStrictEqual(imgFiles, [m[1]]);
});
ok("appendToDailyFile (vault) writes image + wikilink embed");

// no images: no images/ dir, no embed (default param path)
await withRoot(async (root) => {
  await appendToDailyFile(makeCtx(root), root, "proj", "sess1", "user", "hi");
  const files = await readdir(sessionFolder(root));
  assert.ok(!files.includes("images"), "no images dir without images");
  const md = await readFile(join(sessionFolder(root), files[0]), "utf8");
  assert.ok(!md.includes("!["), "no embed without images");
});
ok("appendToDailyFile without images leaves entry unchanged");

// assistant role: images param ignored by caller contract — passing none works
await withRoot(async (root) => {
  await appendToDailyFile(
    makeCtx(root),
    root,
    "proj",
    "sess1",
    "assistant",
    "response text",
  );
  const md = await readFile(
    join(sessionFolder(root), (await readdir(sessionFolder(root)))[0]),
    "utf8",
  );
  assert.ok(md.includes("## 🤖 Response"), "response entry present");
  assert.ok(md.includes("response text"));
});
ok("appendToDailyFile assistant entry unchanged");

console.log("\nAll obsidian-logger tests passed");
