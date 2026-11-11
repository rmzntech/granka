// Smoke test: verifies granka's pi embedding resolves models from an isolated
// agent directory and reports only the thinking levels each model supports.
// No API key or network calls needed.
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import * as agent from "../electron/agent.mjs";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

await agent.init();

assert.equal(
  process.env.PI_CODING_AGENT_DIR,
  path.join(os.homedir(), ".granka"),
  "agent dir must be isolated to ~/.granka",
);

// text-only catalog filter
assert.equal(agent.acceptsText({ input: ["text"] }), true);
assert.equal(agent.acceptsText({ type: "chat", input: ["text", "image"] }), true);
assert.equal(agent.acceptsText({ type: "image", input: ["text"] }), false);
assert.equal(agent.acceptsText({ type: "classifier", input: ["text"] }), false);
assert.equal(agent.acceptsText({ input: ["image"] }), false);
assert.equal(agent.acceptsText({}), false);

const models = await agent.listModels();
assert.ok(models.length > 0, "openrouter catalog should resolve");
assert.ok(models[0].id && Array.isArray(models[0].levels), "every entry carries id and levels");

for (const model of models) {
  assert.ok(model.levels.length > 0, `${model.id}: at least one thinking level`);
  for (const level of model.levels) assert.ok(LEVELS.includes(level), `${model.id}: ${level}`);
}

const restricted = models.filter((m) => m.levels.length < LEVELS.length);
const offOnly = models.filter((m) => m.levels.length === 1 && m.levels[0] === "off");
assert.ok(restricted.length > 0, "some models must expose a restricted level set");
assert.ok(offOnly.length > 0, "non-reasoning models must be limited to off");

// rules files are readable and never null
const rules = agent.getRules();
assert.equal(typeof rules.system, "string");
assert.equal(typeof rules.agents, "string");

// slash-command catalog is an array of { name, description }
assert.ok(Array.isArray(agent.listPrompts()));
for (const prompt of agent.listPrompts()) {
  assert.ok(prompt.name.startsWith("/"), "prompt names start with a slash");
  assert.equal(typeof prompt.description, "string");
}
assert.ok(Array.isArray(agent.listSkills()));
console.log(`rules: system=${rules.system.length}b agents=${rules.agents.length}b, prompts=${agent.listPrompts().length}, skills=${agent.listSkills().length}`);

// prompt/skill discovery parses real files (created and removed here)
import fs from "node:fs";
fs.mkdirSync(agent.PROMPTS_DIR, { recursive: true });
fs.mkdirSync(agent.SKILLS_DIR, { recursive: true });
const promptFile = path.join(agent.PROMPTS_DIR, "zz-test-prompt.md");
const skillDir = path.join(agent.SKILLS_DIR, "zz-test-skill");
fs.writeFileSync(promptFile, "---\ndescription: тестовый шаблон\n---\nСделай что-нибудь");
fs.mkdirSync(skillDir, { recursive: true });
fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: zz-test\ndescription: тестовый скилл\n---\nИнструкции");
const promptsFound = agent.listPrompts().find((p) => p.name === "/zz-test-prompt");
const skillsFound = agent.listSkills().find((s) => s.name === "zz-test");
assert.equal(promptsFound?.description, "тестовый шаблон");
assert.equal(skillsFound?.description, "тестовый скилл");
fs.rmSync(promptFile, { force: true });
fs.rmSync(skillDir, { recursive: true, force: true });

// history carries a context meter slot (null until the model answers once)
const history = await agent.history();
assert.ok("context" in history);
assert.ok(Array.isArray(history.messages));

// chat ↔ project binding: strict, independent of folders
const allSessions = await agent.listSessions("");
assert.ok(allSessions.length > 0, "there is at least one session on disk");
const target = allSessions[0];
const previousProject = agent.projectOfSession(target.id);
const unboundBefore = (await agent.listSessions("", { projectId: "" })).length;

agent.assignSessionToProject(target.id, "p-test");
const inProject = await agent.listSessions("", { projectId: "p-test" });
assert.deepEqual(inProject.map((row) => row.id), [target.id], "exactly one chat in the project");

const unboundAfter = (await agent.listSessions("", { projectId: "" })).length;
assert.ok(
  !(await agent.listSessions("", { projectId: "" })).some((row) => row.id === target.id),
  "bound chat is not in «без проекта»",
);
assert.equal(unboundAfter, unboundBefore - (previousProject === "" ? 1 : 0), "other chats keep their project");

const everywhere = await agent.listSessions("");
assert.equal(everywhere.length, allSessions.length, "undefined projectId means all chats");

agent.assignSessionToProject(target.id, previousProject);

// project layer is a real AGENTS.md inside the project folder
assert.equal(agent.projectAgentsPath({ cwd: "/tmp/proj" }), "/tmp/proj/AGENTS.md");
assert.equal(agent.projectAgentsPath({ cwd: "" }), "");
assert.equal(agent.projectAgentsPath(null), "");

// session search (read-only): matching query finds rows, a nonsense query finds none
const all = agent.listSessions ? await agent.listSessions() : [];
assert.ok(all.length > 0, "at least one session on disk");
assert.ok(all[0].id && all[0].title !== undefined && all[0].modified, "session rows carry id/title/date");
assert.equal((await agent.listSessions("q~z~q-no-such-text")).length, 0, "unmatched search returns nothing");
console.log(`sessions on disk: ${all.length}`);

const sample = restricted[0];
console.log(`openrouter models: ${models.length}, restricted: ${restricted.length}, off-only: ${offOnly.length}`);
console.log(`example: ${sample.id} -> ${sample.levels.join(",")}`);
console.log(`default model in config: ${agent.loadConfig().model}`);
console.log("smoke ok");
