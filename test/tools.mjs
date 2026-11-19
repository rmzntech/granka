// Verifies granka's own tools: registration in a real session, the HTML→text
// parser used by web_fetch, and the keyless search aggregator (skips network).
import assert from "node:assert/strict";
import * as agent from "../electron/agent.mjs";
import { htmlToText, createGrankaTools } from "../electron/tools.mjs";

await agent.init();

// The session's tool set depends on the user's agentMode (auto hides
// ask_user by design), so pin chat mode for the duration of the test and
// restore the user's setting afterwards.
const savedMode = agent.loadConfig().agentMode;
await agent.applyConfig({ agentMode: "chat", planMode: false });

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

// 1b. the live session exposes them to the model (a fresh session: reopening
// a file created under another mode keeps that mode's tool set)
await agent.newSession();
const active = await agent.toolNames();
for (const name of ["todo_write", "ask_user", "web_search", "web_fetch", "task"]) {
  assert.ok(active.includes(name), `session must expose ${name}, got: ${active.join(",")}`);
}
console.log(`active tools: ${active.join(", ")}`);
await agent.applyConfig({ agentMode: savedMode });

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

// 1d. subagents must run on the parent dialog's model — never on the SDK's
// provider default (moonshotai/kimi-k2.7-code for OpenRouter, a paid model).
// Verified with a fake SDK: no network, no tokens, no paid calls.
{
  const parentModel = { id: "parent/model-1" };
  let capturedOptions = null;
  const fakeSession = {
    messages: [{ role: "assistant", usage: { input: 10, output: 5, cacheRead: 0, cost: { total: 0.001 } } }],
    sessionManager: { getSessionId: () => "fake-subagent-session" },
    async prompt() {},
    getLastAssistantText: () => "done",
    abort: async () => {},
    dispose: () => {},
  };
  const fakePi = {
    SessionManager: { inMemory: () => ({}) },
    async createAgentSession(options) {
      capturedOptions = options;
      return { session: fakeSession };
    },
  };
  const fakeRuntime = { getModel: (_provider, id) => (id === parentModel.id ? parentModel : undefined) };
  const recorded = [];
  const hostTools = createGrankaTools({
    getPi: () => fakePi,
    getRuntime: () => fakeRuntime,
    getConfig: () => ({ model: parentModel.id, debugTools: false }),
    getCwd: () => agent.AGENT_DIR,
    getAgentDir: () => agent.AGENT_DIR,
    askUser: async () => "",
    emit: () => {},
    recordUsage: (sessionId, modelId, usage) => recorded.push({ sessionId, modelId, usage }),
  });
  const sessions = [];
  fakePi.createAgentSession = async (options) => {
    capturedOptions = options;
    const id = sessions.length;
    sessions.push(options);
    return {
      session: {
        ...fakeSession,
        sessionManager: { getSessionId: () => `sub-${id}` },
        messages: [{ role: "assistant", usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0005 } } }],
        async prompt() { await new Promise((r) => setTimeout(r, 10)); },
        getLastAssistantText: () => `done-${id}`,
      },
    };
  };
  await Promise.all([
    hostTools.subagentTool.execute("t2", { agent: "explore", description: "a", prompt: "find x" }),
    hostTools.subagentTool.execute("t3", { agent: "review", description: "b", prompt: "check y" }),
  ]);
  assert.equal(sessions.length, 2, "parallel subagents must each get a session");
  assert.ok(sessions.every((options) => options.model === parentModel), "parallel subagents inherit the parent model");
  assert.equal(capturedOptions.model, parentModel, "subagent must inherit the parent model object");
  assert.ok(recorded.length >= 1, "subagent usage must be recorded");
  assert.equal(recorded[0].modelId, parentModel.id, "usage recorded under the parent model");
  console.log("subagent model inheritance ok");

  // background subagent: returns immediately, result lands in the registry
  // and in the pending queue for the parent's next turn
  const bg = await hostTools.subagentTool.execute("t4", { agent: "explore", description: "bg", prompt: "find y", background: true });
  assert.equal(bg.details.background, true, "background call returns immediately");
  assert.ok(bg.details.taskId, "background call returns a task id");
  await new Promise((r) => setTimeout(r, 50));
  const { listBackgroundTasks, drainBackgroundResults } = await import("../electron/tools.mjs");
  const tasks = listBackgroundTasks();
  const mine = tasks.find((task) => task.id === bg.details.taskId);
  assert.ok(mine, "background task is in the registry");
  assert.equal(mine.status, "done", "background task finished");
  assert.ok(mine.text.length > 0, "background task has a result");
  const drained = drainBackgroundResults();
  assert.ok(drained.some((r) => r.description === "bg"), "result queued for the next turn");
  console.log("background subagent ok");

  // cancellation reaches the running child and never queues a result
  fakePi.createAgentSession = async () => ({
    session: {
      ...fakeSession,
      sessionManager: { getSessionId: () => "sub-cancel" },
      async prompt() { await new Promise((_resolve, reject) => { cancelPrompt = reject; }); },
      getLastAssistantText: () => "never",
    },
  });
  let cancelPrompt = null;
  const toCancel = await hostTools.subagentTool.execute("t5", {
    agent: "explore", description: "cancel me", prompt: "wait", background: true,
  });
  for (let i = 0; i < 20 && !cancelPrompt; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(cancelPrompt, "background child started");
  const { cancelBackgroundTask } = await import("../electron/tools.mjs");
  assert.equal(cancelBackgroundTask(toCancel.details.taskId).ok, true);
  cancelPrompt(new Error("aborted"));
  await new Promise((r) => setTimeout(r, 20));
  const stopped = listBackgroundTasks().find((task) => task.id === toCancel.details.taskId);
  assert.equal(stopped.status, "canceled", "canceled task is marked accordingly");
  assert.ok(!drainBackgroundResults().some((r) => r.description === "cancel me"), "canceled result is not queued");
  console.log("background cancellation ok");
}

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
assert.match(result.content[0].text, /Search returned nothing|sources unavailable/);

// 4. a bad URL is rejected before any network call
const fetchTool = createGrankaTools(offlineHost).webFetchTool;
const bad = await fetchTool.execute("t2", { url: "file:///etc/passwd" }, undefined, undefined, {});
assert.match(bad.content[0].text, /http\(s\) URL/);

console.log("tools ok");

// 5. SSRF guard: private/loopback/metadata hosts are rejected before fetch
import { assertPublicUrl } from "../electron/tools.mjs";
for (const badUrl of ["http://127.0.0.1/x", "http://localhost/x", "http://169.254.169.254/latest/meta-data/", "http://192.168.1.1/x", "http://10.0.0.1/x", "http://172.16.0.1/x", "file:///etc/passwd"]) {
  assert.throws(() => assertPublicUrl(badUrl), /заблокирован|разрешён|недопустимый/, badUrl);
}
assert.equal(assertPublicUrl("https://example.com/x").hostname, "example.com");
const ssrf = await fetchTool.execute("t3", { url: "http://169.254.169.254/" }, undefined, undefined, {});
assert.match(ssrf.content[0].text, /заблокирован/);

// 6. config whitelist: unknown keys and bad hooks/mcp shapes are dropped/rejected
assert.deepEqual(agent.sanitizeConfigPatch({ theme: "dark", evil: 1, projects: [] }), { theme: "dark" });
assert.deepEqual(agent.sanitizeConfigPatch({ compactionThreshold: 90 }), { compactionThreshold: 90 });
assert.equal(agent.sanitizeConfigPatch({ hooks: { afterEdit: 42 } }), null);
assert.equal(agent.sanitizeConfigPatch({ mcpServers: { s: { command: "" } } }), null);
assert.deepEqual(agent.sanitizeConfigPatch({ mcpServers: { s: { command: "npx", args: [] } } }), { mcpServers: { s: { command: "npx", args: [] } } });
assert.equal(agent.sanitizeConfigPatch({ mcpServers: { s: { command: "npx", disabled: "yes" } } }), null);
const { mcpStatus } = await import("../electron/mcp.mjs");
assert.equal(mcpStatus({ s: { command: "npx", disabled: true } }).s, "off", "disabled MCP server reports off without spawning");

// 7. confirmation setting: allow/ask only, unknown values fall back in UI
assert.deepEqual(agent.sanitizeConfigPatch({ confirmBashWrite: "allow" }), { confirmBashWrite: "allow" });
assert.deepEqual(agent.sanitizeConfigPatch({ confirmBashWrite: "ask" }), { confirmBashWrite: "ask" });
