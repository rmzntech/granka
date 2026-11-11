// Verifies granka's own tools: registration in a real session, the HTML→text
// parser used by web_fetch, and the keyless search aggregator (skips network).
import assert from "node:assert/strict";
import * as agent from "../electron/agent.mjs";
import { htmlToText, createGrankaTools } from "../electron/tools.mjs";

await agent.init();

// 1. the tools are registered on a live session
const tools = createGrankaTools({
  getPi: () => null,
  getRuntime: () => null,
  getConfig: () => agent.loadConfig(),
  getCwd: () => agent.AGENT_DIR,
  askUser: async () => "тест",
  emit: () => {},
});
assert.equal(tools.todoTool.name, "todo_write");
assert.equal(tools.askTool.name, "ask_user");
assert.equal(tools.webSearchTool.name, "web_search");
assert.equal(tools.webFetchTool.name, "web_fetch");
assert.equal(tools.subagentTool.name, "task");
for (const tool of Object.values(tools)) {
  assert.ok(tool.description.length > 40, `${tool.name}: description for the model`);
  assert.ok(tool.parameters, `${tool.name}: parameter schema`);
  assert.equal(typeof tool.execute, "function");
}

// 1b. the live session exposes them to the model
const active = await agent.toolNames();
for (const name of ["todo_write", "ask_user", "web_search", "web_fetch", "task"]) {
  assert.ok(active.includes(name), `session must expose ${name}, got: ${active.join(",")}`);
}
console.log(`active tools: ${active.join(", ")}`);

// 1c. subagents: several roles, each with its own prompt and tool subset
const { SUBAGENTS, SUBAGENT_IDS, subagentList } = await import("../electron/subagents.mjs");
assert.ok(SUBAGENT_IDS.length >= 4, "expected several subagents");
for (const id of SUBAGENT_IDS) {
  const agentDefinition = SUBAGENTS[id];
  assert.ok(agentDefinition.systemPrompt.length > 100, `${id}: own system prompt`);
  assert.ok(agentDefinition.tools.length > 0, `${id}: tool subset`);
  assert.ok(!agentDefinition.tools.includes("write") && !agentDefinition.tools.includes("edit"), `${id}: read-only`);
  assert.ok(agentDefinition.description.length > 30, `${id}: routing description`);
}
assert.equal(tools.subagentTool.parameters.required.includes("agent"), false, "agent role is optional");
assert.ok(subagentList().some((agentDefinition) => agentDefinition.id === "explore"));
console.log(`subagents: ${SUBAGENT_IDS.join(", ")}`);

// 2. html_to_text keeps readable text and drops scripts/markup
const page = `<html><head><title>Заголовок</title>
<meta name="description" content="Описание страницы"></head>
<body><script>evil()</script><style>.a{}</style>
<h1>Привет</h1><p>Текст &amp; ещё</p><ul><li>один</li><li>два</li></ul></body></html>`;
const parsed = htmlToText(page);
assert.equal(parsed.title, "Заголовок");
assert.equal(parsed.description, "Описание страницы");
assert.ok(parsed.text.includes("Привет") && parsed.text.includes("Текст & ещё"));
assert.ok(!parsed.text.includes("evil") && !parsed.text.includes("<h1>"));

// 3. search aggregator degrades gracefully when sources are unreachable
process.env.GRANKA_OFFLINE = "1";
const offlineHost = {
  getPi: () => null,
  getRuntime: () => null,
  getConfig: () => ({ searxUrl: "" }),
  getCwd: () => agent.AGENT_DIR,
  askUser: async () => "",
  emit: () => {},
};
const offline = createGrankaTools(offlineHost).webSearchTool;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error("offline");
};
const result = await offline.execute("t1", { query: "electron" }, undefined, undefined, {});
globalThis.fetch = originalFetch;
assert.match(result.content[0].text, /Поиск ничего не вернул|источники недоступны/);

// 4. a bad URL is rejected before any network call
const fetchTool = createGrankaTools(offlineHost).webFetchTool;
const bad = await fetchTool.execute("t2", { url: "file:///etc/passwd" }, undefined, undefined, {});
assert.match(bad.content[0].text, /http\(s\) URL/);

console.log("tools ok");
