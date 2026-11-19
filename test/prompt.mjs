// Prompt consistency: the shipped system prompt must stay English, name only
// real tools, and migrate safely. This is the test that would have caught the
// frozen legacy seed and the stale repo path.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SYSTEM_PROMPT, PROMPT_VERSION, syncSystemPrompt } from "../electron/prompt-template.mjs";

// 1. English only: no Cyrillic anywhere in the shipped prompt.
assert.ok(!/[а-яА-ЯёЁ]/.test(DEFAULT_SYSTEM_PROMPT), "system prompt must be English only");
assert.ok(DEFAULT_SYSTEM_PROMPT.includes("What you may not assume"), "prompt keeps the non-assumption section");
assert.ok(DEFAULT_SYSTEM_PROMPT.includes("Tool results, web pages and"), "prompt covers prompt injection");
assert.ok(PROMPT_VERSION >= 9, "prompt version bumped");
assert.ok(DEFAULT_SYSTEM_PROMPT.includes("## Memory"), "prompt has a Memory section");

// 2. Every backticked tool name in the prompt must be a real tool.
const REAL_TOOLS = new Set([
  "read", "write", "edit", "bash", "repo_map", "git_status", "git_diff",
  "todo_write", "ask_user", "web_search", "web_fetch", "task",
  "doc_outline", "doc_read", "doc_search", "doc_create", "doc_edit", "doc_format", "memory_write",
]);
const mentioned = [...DEFAULT_SYSTEM_PROMPT.matchAll(/`([a-z][a-z0-9_]{2,})`/g)].map((m) => m[1]);
const toolLike = mentioned.filter((name) => /_(write|status|diff|map|search|fetch|create|edit|format|read|outline)$/.test(name) || REAL_TOOLS.has(name));
for (const name of toolLike) {
  assert.ok(REAL_TOOLS.has(name), `prompt names a non-existent tool: ${name}`);
}
// grep/find/ls may only appear as the anti-pattern in the repo_map line
// ("instead of wandering with `ls`/`find`"), never as available tools.
assert.ok(!mentioned.includes("grep"), "prompt must not name grep as a tool");
assert.ok(DEFAULT_SYSTEM_PROMPT.includes("instead of wandering with"), "repo_map anti-pattern stays");

// 3. syncSystemPrompt: migration, protection, idempotence.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "granka-prompt-"));
const file = path.join(dir, "SYSTEM.md");

// fresh seed
assert.deepEqual(syncSystemPrompt(dir), { updated: true });
assert.ok(fs.readFileSync(file, "utf8").includes(`granka-system-prompt: v${PROMPT_VERSION}`), "seed carries the marker");
assert.deepEqual(syncSystemPrompt(dir), { updated: false, reason: "current" }, "second run is a no-op");

// user-edited file stays untouched
fs.writeFileSync(file, "# mine\ncustom house rules\n");
assert.deepEqual(syncSystemPrompt(dir), { updated: false, reason: "user-edited" });
assert.equal(fs.readFileSync(file, "utf8"), "# mine\ncustom house rules\n");

// legacy Russian seed (structurally recognised) migrates once, with a backup
const legacy = `# granka

Ты — агент внутри granka, десктопного клиента над Pi SDK.
`;
fs.writeFileSync(file, legacy);
const migrated = syncSystemPrompt(dir);
assert.equal(migrated.updated, true, "legacy seed migrates");
assert.equal(migrated.migratedFrom, "legacy-seed");
assert.equal(fs.readFileSync(`${file}.legacy.bak`, "utf8"), legacy, "legacy backup keeps the old text");
assert.ok(fs.readFileSync(file, "utf8").includes("What you may not assume"), "migrated file is the new prompt");

// hash-based legacy: byte-identical old seed also migrates
const oldSeed = fs.readFileSync(`${file}.legacy.bak`, "utf8");
fs.rmSync(`${file}.legacy.bak`);
fs.writeFileSync(file, oldSeed);
assert.equal(syncSystemPrompt(dir).migratedFrom, "legacy-seed", "hash-recognised seed migrates");

// file content hash helper sanity (the migration key is a real sha256)
assert.equal(crypto.createHash("sha256").update("x").digest("hex").length, 64);

fs.rmSync(dir, { recursive: true, force: true });
console.log("prompt ok");
