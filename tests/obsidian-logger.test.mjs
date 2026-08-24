// Behavior tests for obsidian-logger image embedding
// (run: node tests/obsidian-logger.test.mjs)
import assert from "node:assert";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";

const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractUserImages,
  appendToDailyFile,
  slugifyTitle,
  formatDateISO,
  renameSessionFolder,
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

// --- slugifyTitle: title → folder-name slug ---
assert.strictEqual(
  slugifyTitle("Fix file tree cursor"),
  "fix-file-tree-cursor",
);
ok("slugifyTitle basic");
assert.strictEqual(slugifyTitle("  Hello,  World! "), "hello-world");
ok("slugifyTitle collapses punctuation/whitespace");
assert.strictEqual(slugifyTitle("a--b__c 9"), "a-b-c-9");
ok("slugifyTitle mixed separators");
assert.strictEqual(slugifyTitle("!!!"), "");
ok("slugifyTitle all-punctuation → empty");
assert.strictEqual(slugifyTitle("").length, 0);
ok("slugifyTitle empty → empty");
const longSlug = slugifyTitle("word-".repeat(20)); // 100 chars
assert.ok(longSlug.length <= 40 && !longSlug.endsWith("-"));
ok("slugifyTitle capped at 40, no trailing dash");

// --- formatDateISO: chronological shape ---
assert.match(formatDateISO(), /^\d{4}-\d{2}-\d{2}$/);
ok("formatDateISO is YYYY-MM-DD");

// --- renameSessionFolder: real fs behavior in a temp root ---
await withRoot(async (root) => {
  // existing uuid folder gets renamed, old path gone, content preserved
  const oldDir = sessionFolder(root);
  await mkdir(oldDir, { recursive: true });
  await writeFile(join(oldDir, "MM-DD.md"), "note");
  const res = await renameSessionFolder(root, "proj", "sess1", "Fix the tree");
  assert.strictEqual(res.renamed, true);
  assert.match(res.folder, /^\d{4}-\d{2}-\d{2}-fix-the-tree$/);
  assert.strictEqual(
    await exists(join(root, "Projects", "proj", "sess1")),
    false,
  );
  const md = await readFile(
    join(root, "Projects", "proj", res.folder, "MM-DD.md"),
    "utf8",
  );
  assert.strictEqual(md, "note");
});
ok("renameSessionFolder renames existing folder, keeps content");

await withRoot(async (root) => {
  // title set before first write: no rename, next write creates titled folder
  const res = await renameSessionFolder(root, "proj", "sess1", "Early Title");
  assert.strictEqual(res.renamed, false);
  assert.ok(!res.error);
  await appendToDailyFile(
    makeCtx(root),
    root,
    "proj",
    res.folder,
    "user",
    "hi",
  );
  const files = await readdir(join(root, "Projects", "proj", res.folder));
  assert.ok(files.length === 1 && files[0].endsWith(".md"));
});
ok("renameSessionFolder pre-names folder before first write");

await withRoot(async (root) => {
  // collision: identical target name taken → -2 suffix
  const taken = `${formatDateISO()}-demo`;
  await mkdir(join(root, "Projects", "proj", taken), { recursive: true });
  await mkdir(sessionFolder(root), { recursive: true });
  const res = await renameSessionFolder(root, "proj", "sess1", "Demo");
  assert.strictEqual(res.renamed, true);
  assert.strictEqual(res.folder, `${taken}-2`);
});
ok("renameSessionFolder collision → -2 suffix");

await withRoot(async (root) => {
  const res = await renameSessionFolder(root, "proj", "sess1", "!!!");
  assert.strictEqual(res.error, "empty slug");
  assert.strictEqual(res.folder, "sess1");
});
ok("renameSessionFolder empty slug → error, folder unchanged");

await withRoot(async (root) => {
  // title flows into the note frontmatter
  await appendToDailyFile(
    makeCtx(root),
    root,
    "proj",
    "sess1",
    "user",
    "hi",
    [],
    "vault",
    "My Session Title",
  );
  const md = await readFile(
    join(sessionFolder(root), (await readdir(sessionFolder(root)))[0]),
    "utf8",
  );
  assert.ok(
    md.includes("title: My Session Title"),
    `frontmatter has title, got: ${md.split("\n").slice(0, 6).join(" | ")}`,
  );
});
ok("appendToDailyFile writes title into frontmatter");

console.log("\nAll obsidian-logger tests passed");
