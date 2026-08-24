// Behavior tests for secret-scrubber (run: node tests/secret-scrubber.test.mjs)
import assert from "node:assert";
import {
    DEFAULT_SECRET_PATTERNS,
    matchSecret,
    maskSecret,
    extractScannableText,
    loadPatterns,
    loadTimeoutMs,
} from "../extensions/secret-scrubber.ts";

const ok = (name) => console.log(`  ok - ${name}`);

// --- matchSecret: known secret shapes are caught ---
assert.deepStrictEqual(
    matchSecret(
        "export OPENAI_KEY=sk-abcdefghij1234567890abcd",
        DEFAULT_SECRET_PATTERNS,
    ),
    { name: "OpenAI API key", match: "sk-abcdefghij1234567890abcd" },
);
ok("catches OpenAI sk- key");

// Anthropic pattern must win over the generic OpenAI sk- pattern
assert.strictEqual(
    matchSecret(
        "key: sk-ant-api01-abcdefghijklmnopqrst",
        DEFAULT_SECRET_PATTERNS,
    ).name,
    "Anthropic API key",
);
ok("catches Anthropic key (specific before generic)");

// sk-proj- is the standard format for new OpenAI keys; the generic sk-
// pattern cannot match it, so it needs its own dedicated pattern.
assert.strictEqual(
    matchSecret(
        "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuv12",
        DEFAULT_SECRET_PATTERNS,
    ).name,
    "OpenAI project key",
);
ok("catches OpenAI sk-proj- project key");

const ghp = "ghp_" + "a".repeat(36);
assert.strictEqual(
    matchSecret(
        `curl -H "Authorization: Bearer ${ghp}"`,
        DEFAULT_SECRET_PATTERNS,
    ).name,
    "GitHub PAT (classic)",
);
ok("catches GitHub classic PAT");

// fine-grained tokens are base64url: [A-Za-z0-9], no dashes
const githubPat = "github_pat_" + "Ab1Cd2".repeat(12);
assert.strictEqual(
    matchSecret(`token=${githubPat}`, DEFAULT_SECRET_PATTERNS).name,
    "GitHub PAT (fine-grained)",
);
ok("catches GitHub fine-grained PAT");

assert.strictEqual(
    matchSecret(
        "aws configure set aws_access_key_id AKIAIOSFODNN7EXAMPLE",
        DEFAULT_SECRET_PATTERNS,
    ).name,
    "AWS access key id",
);
ok("catches AWS access key id");
// lowercase akia is not an AWS key prefix
assert.strictEqual(
    matchSecret("akiaiosfodnn7example", DEFAULT_SECRET_PATTERNS),
    null,
);
ok("lowercase akia does not match");

const google = "AIza" + "a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuVwXy"; // 35 chars after AIza
assert.strictEqual(
    matchSecret(
        `https://maps.googleapis.com/?key=${google}`,
        DEFAULT_SECRET_PATTERNS,
    ).name,
    "Google API key",
);
ok("catches Google API key");

assert.strictEqual(
    matchSecret("slack token xoxb-1234567890-abcdefg", DEFAULT_SECRET_PATTERNS)
        .name,
    "Slack token",
);
ok("catches Slack bot token");

const hf = "hf_" + "Ab1".repeat(12); // 36 chars after hf_
assert.strictEqual(
    matchSecret(`HF_TOKEN=${hf}`, DEFAULT_SECRET_PATTERNS).name,
    "HuggingFace token",
);
ok("catches HuggingFace token");

assert.strictEqual(
    matchSecret(
        "bot=7000000000:AAHdqTcvCH1vGWJxfSeofSAs0K5DCUmXMJ4",
        DEFAULT_SECRET_PATTERNS,
    ).name,
    "Telegram bot token",
);
ok("catches Telegram bot token");

assert.strictEqual(
    matchSecret(
        "-----BEGIN RSA PRIVATE KEY-----\\nMIIEpAIB",
        DEFAULT_SECRET_PATTERNS,
    ).name,
    "Private key block",
);
ok("catches private key header");

// Built at runtime: a literal sk_live_* token in source would trip GitHub
// push protection even when it is only a synthetic test value.
const stripeKey =
    ["sk", "live_"].join(String.fromCharCode(95)) + "a1b2c3d4e5f6g7h8i9j0k1l2";
assert.strictEqual(
    matchSecret(`stripe ${stripeKey}`, DEFAULT_SECRET_PATTERNS).name,
    "Stripe live key",
);
ok("catches Stripe live key");

// --- matchSecret: benign content passes ---
assert.strictEqual(
    matchSecret("git status && ls -la", DEFAULT_SECRET_PATTERNS),
    null,
);
ok("benign bash command does not match");
assert.strictEqual(
    matchSecret("const x = 1; // todo: fix later", DEFAULT_SECRET_PATTERNS),
    null,
);
ok("benign code does not match");
assert.strictEqual(matchSecret("", DEFAULT_SECRET_PATTERNS), null);
ok("empty text does not match");
// commit SHAs / short tokens are NOT secrets
assert.strictEqual(
    matchSecret(
        "git checkout a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
        DEFAULT_SECRET_PATTERNS,
    ),
    null,
);
ok("commit SHA does not match");

// --- maskSecret: never echoes the full value ---
assert.strictEqual(maskSecret("sk-abcdefghij123"), "sk-a…j123");
ok("masks long secrets first4…last4");
assert.strictEqual(maskSecret("abc"), "****");
ok("short secrets fully masked");
assert.strictEqual(maskSecret("12345678"), "****");
ok("8-char secrets fully masked");

// --- extractScannableText: per-tool input shapes ---
assert.strictEqual(
    extractScannableText("bash", { command: "echo hi" }),
    "echo hi",
);
ok("bash → command");
assert.strictEqual(extractScannableText("bash", { args: ["x"] }), null);
ok("bash without command → null");
assert.strictEqual(
    extractScannableText("write", { path: "/tmp/x", content: "hello" }),
    "hello",
);
ok("write → content");
assert.strictEqual(
    extractScannableText("edit", {
        path: "f.ts",
        edits: [
            { oldText: "a", newText: "KEY=sk-abcdefghij1234567890abcd" },
            { oldText: "b", newText: "plain" },
            { broken: true },
            null,
        ],
    }),
    "KEY=sk-abcdefghij1234567890abcd\nplain",
);
ok("edit → joins all newText values, skips invalid entries");
assert.strictEqual(extractScannableText("read", { path: "/tmp/x" }), null);
ok("unscanned tool (read) → null");
assert.strictEqual(extractScannableText("bash", undefined), null);
ok("missing input → null");
assert.strictEqual(extractScannableText("bash", "not-an-object"), null);
ok("non-object input → null");

// --- env overrides ---
assert.strictEqual(loadPatterns({}), DEFAULT_SECRET_PATTERNS);
ok("no env → defaults");
const custom = loadPatterns({
    SECRET_SCRUBBER_PATTERNS: JSON.stringify(["\\bMYKEY_[A-Za-z0-9]{16}"]),
});
assert.strictEqual(custom.length, 1);
assert.ok(matchSecret("MYKEY_abcdefghijklmnop", custom));
ok("env replaces defaults with custom regexes");
assert.strictEqual(
    loadPatterns({ SECRET_SCRUBBER_PATTERNS: "not json" }).length,
    DEFAULT_SECRET_PATTERNS.length,
);
ok("invalid JSON → defaults");
assert.strictEqual(
    loadPatterns({ SECRET_SCRUBBER_PATTERNS: '["[broken"]' }).length,
    DEFAULT_SECRET_PATTERNS.length,
);
ok("all-invalid regexes → defaults");

// --- timeout ---
assert.strictEqual(loadTimeoutMs({}), 120000);
ok("default timeout 120s");
assert.strictEqual(loadTimeoutMs({ SECRET_SCRUBBER_TIMEOUT_MS: "5" }), 1000);
ok("timeout clamped to minimum 1s");
assert.strictEqual(
    loadTimeoutMs({ SECRET_SCRUBBER_TIMEOUT_MS: "99999999" }),
    600000,
);
ok("timeout clamped to maximum 600s");
assert.strictEqual(
    loadTimeoutMs({ SECRET_SCRUBBER_TIMEOUT_MS: "abc" }),
    120000,
);
ok("non-numeric timeout → default");

console.log(
    `\nAll secret-scrubber tests passed (${DEFAULT_SECRET_PATTERNS.length} default patterns).`,
);
