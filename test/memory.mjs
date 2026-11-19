// Memory: capped loading, global/project storage, agent append tool.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "granka-memory-"));
process.env.HOME = agentDir;
// agent.mjs resolves AGENT_DIR from ~/.granka at import time via PI_CODING_AGENT_DIR?
// It uses its own AGENT_DIR constant — check by exercising the exported helpers
// against the real ~/.granka instead of a temp dir.
const agent = await import("../electron/agent.mjs");
const { readMemoryCapped, getMemory, saveMemory, getProjectMemory, saveProjectMemory } = agent;

// cap: 200 lines / 25 KB
const bigFile = path.join(agentDir, "big.md");
fs.writeFileSync(bigFile, Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n"));
const capped = readMemoryCapped(bigFile);
assert.equal(capped.split("\n").length, 200, "memory is capped at 200 lines");
assert.ok(!capped.includes("line 499"), "cap drops the tail");

// global memory round-trip (real ~/.granka, cleaned up after)
const before = getMemory();
assert.equal(before.ok, true);
const original = before.text;
try {
  assert.equal(saveMemory("- test note\n").ok, true);
  assert.equal(getMemory().text, "- test note\n");
  // project memory: id sanitisation
  assert.equal(getProjectMemory("../evil").ok, false, "path-traversal id rejected");
  assert.equal(saveProjectMemory("p-test-memory", "- proj note\n").ok, true);
  assert.equal(getProjectMemory("p-test-memory").text, "- proj note\n");
} finally {
  saveMemory(original);
  try { fs.rmSync(path.join(os.homedir(), ".granka", "memory", "p-test-memory.md")); } catch {}
}

// memory_write tool: append + dedupe
const { createGrankaTools } = await import("../electron/tools.mjs");
const realAgentDir = path.join(os.homedir(), ".granka");
const host = {
  getPi: () => null,
  getRuntime: () => null,
  getCwd: () => agentDir,
  getAgentDir: () => realAgentDir,
  getConfig: () => ({ activeProject: "p-test-memory", model: "x" }),
  recordUsage: () => {},
  askUser: async () => "",
  emit: () => {},
};
const tools = createGrankaTools(host);
assert.equal(tools.memoryTool.name, "memory_write");
const first = await tools.memoryTool.execute("1", { scope: "global", text: "dedup-check-note" });
assert.equal(first.details.added, true);
const second = await tools.memoryTool.execute("2", { scope: "global", text: "dedup-check-note" });
assert.equal(second.details.added, false, "exact duplicate is skipped");
const proj = await tools.memoryTool.execute("3", { scope: "project", text: "project-note" });
assert.equal(proj.details.added, true);
const noProject = createGrankaTools({ ...host, getConfig: () => ({ activeProject: "" }) });
const rejected = await noProject.memoryTool.execute("4", { scope: "project", text: "x" });
assert.match(rejected.content[0].text, /No active project/);
// cleanup: remove the test notes
saveMemory(original);
try { fs.rmSync(path.join(realAgentDir, "memory", "p-test-memory.md")); } catch {}

fs.rmSync(agentDir, { recursive: true, force: true });
console.log("memory ok");
