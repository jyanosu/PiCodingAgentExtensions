// Behavior tests for danger-guard pattern matching (run: node tests/danger-guard.test.mjs)
import assert from "node:assert";
import { matchDangerousCommand, loadPatterns, loadTimeoutMs, DEFAULT_PATTERNS } from "../extensions/danger-guard.ts";

const patterns = DEFAULT_PATTERNS;
const hit = (cmd) => matchDangerousCommand(cmd, patterns)?.name ?? null;

// Should MATCH (destructive)
const shouldMatch = [
  ["rm -rf /", "rm -r/-f"],
  ["rm -rf ~/projects", "rm -r/-f"],
  ["rm -fr node_modules", "rm -r/-f"],
  ["rm -r dir", "rm -r/-f"],
  ["rm -f important.txt", "rm -r/-f"],
  ["sudo apt install x", "sudo"],
  ["chmod 777 /etc/passwd", "chmod 777"],
  ["del /s /q C:\\temp", "del/rd /s"],
  ["rd /s /q build", "del/rd /s"],
  ["rmdir /s /q old", "del/rd /s"],
  ["format c: /q", "format/diskpart"],
  ["diskpart", "format/diskpart"],
  ["Remove-Item C:\\data -Recurse -Force", "PowerShell remove/format"],
  ["Clear-Disk -Number 1", "PowerShell remove/format"],
  ["Format-Volume -DriveLetter D", "PowerShell remove/format"],
  ["git push --force origin main", "git push --force"],
  ["git push -f", "git push --force"],
  ["git push --force-with-lease origin main", "git push --force"],
  ["git push && git reset --hard HEAD~1", "git reset --hard"],
  ["git reset --hard", "git reset --hard"],
  ["git clean -fd", "git clean -d"],
  ["git clean -fdx", "git clean -d"],
  ["git clean -f -d -x", "git clean -d"],
  ["git checkout -- .", "git checkout --"],
  ["git branch -D old-feature", "git branch -D"],
  ["mysql -e 'DROP TABLE users'", "DROP/TRUNCATE"],
  ["psql -c 'drop database prod'", "DROP/TRUNCATE"],
  ["psql -c 'TRUNCATE TABLE logs'", "DROP/TRUNCATE"],
  ["mkfs.ext4 /dev/sda1", "mkfs/dd/shred"],
  ["dd if=/dev/zero of=/dev/sda bs=1M", "mkfs/dd/shred"],
  ["shred -u secret.txt", "mkfs/dd/shred"],
];

// Should NOT match (benign lookalikes)
const shouldNotMatch = [
  "rm file.txt",
  "rm -v old.log",
  "cat readme.md",
  "git push origin main",
  "git push feature",
  "git reset --merge",
  "git reset HEAD~1",
  "git clean -f",
  "git checkout main",
  "git checkout -b new-branch",
  "git branch -d merged",
  "git branch -a",
  "drop the price at 5pm",
  "SELECT * FROM users",
  "npm run build",
  "del file.txt",
  "rd subdir",
  "format '%d', date",
];
// Note: bare words `sudo` and `shred` match by design (the commands themselves).

let failed = 0;
for (const [cmd, expectedName] of shouldMatch) {
  const got = hit(cmd);
  if (got !== expectedName) {
    console.error(`FAIL (should match ${expectedName}): "${cmd}" → ${got}`);
    failed++;
  }
}
// "sudo" bare: /\bsudo\b/ matches — verify it does (documented behavior)
assert.strictEqual(hit("echo sudo"), "sudo", "bare 'sudo' word should match");

for (const cmd of shouldNotMatch) {
  const got = hit(cmd);
  if (got !== null) {
    console.error(`FAIL (should NOT match): "${cmd}" → ${got}`);
    failed++;
  }
}

// loadPatterns: env override
const custom = loadPatterns({ DANGER_GUARD_PATTERNS: '["\\\\bgit\\\\s+push\\\\b", "bad[regex"]' });
assert.strictEqual(custom.length, 1, "invalid regex entries skipped");
assert.strictEqual(hit2("git push x", custom), true);
assert.strictEqual(hit2("rm -rf /", custom), false, "override replaces defaults");
function hit2(cmd, pats) { return matchDangerousCommand(cmd, pats) !== null; }

// loadPatterns: bad JSON → defaults
assert.strictEqual(loadPatterns({ DANGER_GUARD_PATTERNS: "not json" }), DEFAULT_PATTERNS);
// loadPatterns: empty array → defaults
assert.strictEqual(loadPatterns({ DANGER_GUARD_PATTERNS: "[]" }), DEFAULT_PATTERNS);
// loadPatterns: no env → defaults
assert.strictEqual(loadPatterns({}), DEFAULT_PATTERNS);

// loadTimeoutMs
assert.strictEqual(loadTimeoutMs({}), 120000);
assert.strictEqual(loadTimeoutMs({ DANGER_GUARD_TIMEOUT_MS: "500" }), 1000, "clamped to min");
assert.strictEqual(loadTimeoutMs({ DANGER_GUARD_TIMEOUT_MS: "9999999" }), 600000, "clamped to max");
assert.strictEqual(loadTimeoutMs({ DANGER_GUARD_TIMEOUT_MS: "30000" }), 30000);
assert.strictEqual(loadTimeoutMs({ DANGER_GUARD_TIMEOUT_MS: "garbage" }), 120000);

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log(`All ${shouldMatch.length + shouldNotMatch.length + 1} matcher tests + config tests passed`);
