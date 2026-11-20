// granka's own agent tools: plan (todo), structured question, keyless web
// search/fetch and a one-level subagent. Everything runs in the main process,
// uses no API keys and no paid services.
import { Type } from "typebox";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { SUBAGENTS, getSubagents } from "./subagents.mjs";
import { assertNotSensitive } from "./docs.mjs";

// ---------------------------------------------------------------- git (thin wrappers)
// Frequent read-only git operations deserve real tools instead of the model
// hand-writing `git diff` through bash every time. Fixed argv, no shell.
import { execFile } from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

async function runGit(cwd, args) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return stdout.trim() || "(empty)";
  } catch (err) {
    const stderr = String(err?.stderr ?? "").trim();
    throw new Error(stderr || String(err?.message ?? err));
  }
}

function createGitTools(host) {
  const statusTool = {
    name: "git_status",
    label: "Git: статус",
    description:
      "Shows repository state: branch, changed and new files (git status --short --branch). " +
      "Use before edits and for review instead of bash with git status.",
    promptSnippet: "git_status: repository state",
    parameters: Type.Object({}),
    execute: async () => {
      const text = await runGit(host.getCwd(), ["status", "--short", "--branch"]);
      return { content: [{ type: "text", text }], details: {} };
    },
  };

  const diffTool = {
    name: "git_diff",
    label: "Git: diff",
    description:
      "Shows uncommitted changes (git diff HEAD). Without a path — file summary (--stat), " +
      "with a path — the full diff of that file. Use to review your own edits instead of bash.",
    promptSnippet: "git_diff: uncommitted changes",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Path to the file for a full diff" })),
    }),
    execute: async (_id, params) => {
      const args = params.path
        ? ["diff", "--no-color", "HEAD", "--", String(params.path)]
        : ["diff", "--no-color", "--stat", "HEAD"];
      const text = await runGit(host.getCwd(), args);
      return { content: [{ type: "text", text }], details: {} };
    },
  };

  return { statusTool, diffTool };
}

// ---------------------------------------------------------------- web (free)

// A real browser UA matters: DuckDuckGo Lite answers 200 only to browser-like
// clients, plain bots get a 202 challenge page.
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const BROWSER_HEADERS = {
  "user-agent": UA,
  accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9,ru;q=0.8",
};
const SEARCH_TIMEOUT = 8000;

// SSRF guard: web_fetch/web_search must never reach loopback, RFC1918,
// link-local (incl. cloud metadata 169.254.169.254) or .local hosts.
// redirect:"follow" can bounce a public URL into the private range, so the
// final response.url is re-checked by callers.
function isPrivateHost(hostname) {
  const host = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  return false;
}

export function assertPublicUrl(raw) {
  let url;
  try { url = new URL(String(raw ?? "")); } catch { throw new Error(`недопустимый URL: ${raw}`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`разрешён только http(s): ${raw}`);
  if (isPrivateHost(url.hostname)) throw new Error(`заблокирован приватный адрес: ${url.hostname}`);
  return url;
}

// Hostname checks alone miss DNS rebinding: a public name can resolve to a
// private IP. Resolve and re-check the addresses before fetching.
async function assertPublicDns(hostname) {
  const host = String(hostname ?? "").toLowerCase();
  if (isPrivateHost(host)) return;
  let addresses;
  try {
    addresses = await dnsLookup(host, { all: true });
  } catch {
    return; // fetch itself will fail with a clear error
  }
  for (const { address } of addresses ?? []) {
    if (isPrivateHost(address)) {
      throw new Error(`заблокирован приватный адрес: ${host} -> ${address}`);
    }
  }
}

const MAX_FETCH_BYTES = 2_000_000;

async function getJson(url, timeout = SEARCH_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      headers: { "user-agent": UA, accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function decodeDdgLink(href) {
  const raw = String(href ?? "");
  const match = /[?&]uddg=([^&]+)/.exec(raw);
  if (match) {
    try {
      return decodeURIComponent(match[1]);
    } catch {}
  }
  if (raw.startsWith("//")) return `https:${raw}`;
  return raw;
}

// DuckDuckGo Lite: independent of API keys and works with a browser UA.
async function ddgLite(query, limit = 8) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT);
  try {
    const response = await fetch(
      `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
      { headers: BROWSER_HEADERS, signal: controller.signal },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    if (/not a bot|Security check|anomaly/i.test(html)) throw new Error("bot challenge");

    const anchors = [...html.matchAll(/<a[^>]+class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi)];
    const snippets = [...html.matchAll(/<td[^>]+class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi)];
    const results = [];
    anchors.forEach((match, index) => {
      const tag = /href=["']([^"']+)["']/i.exec(match[0]);
      const title = decodeEntities(match[1].replace(/<[^>]+>/g, "")).trim();
      const url = decodeDdgLink(tag?.[1]);
      if (!url || !title) return;
      const snippet = snippets[index] ? decodeEntities(snippets[index][1].replace(/<[^>]+>/g, "")).trim() : "";
      results.push({ title, url, snippet: snippet.slice(0, 220), source: "duckduckgo" });
    });
    return results.slice(0, limit);
  } finally {
    clearTimeout(timer);
  }
}

async function wikiSearch(query, lang) {
  const url = `https://${lang}.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=4&format=json`;
  const data = await getJson(url);
  const [, titles = [], snippets = [], urls = []] = data;
  return titles.map((title, index) => ({
    title,
    url: urls[index],
    snippet: (snippets[index] ?? "").replace(/<[^>]+>/g, "").slice(0, 200),
    source: `wikipedia:${lang}`,
  }));
}

async function githubSearch(query) {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=4&sort=stars`;
  const data = await getJson(url);
  return (data.items ?? []).map((item) => ({
    title: item.full_name,
    url: item.html_url,
    snippet: `${item.stargazers_count}★ · ${item.language ?? "—"} · ${(item.description ?? "").slice(0, 160)}`,
    source: "github",
  }));
}

async function hnSearch(query) {
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=4`;
  const data = await getJson(url);
  return (data.hits ?? [])
    .filter((hit) => hit.title || hit.story_title)
    .map((hit) => ({
      title: hit.title ?? hit.story_title,
      url: hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`,
      snippet: `${hit.points ?? 0} points · ${hit.num_comments ?? 0} comments`,
      source: "hackernews",
    }));
}

async function ddgAbstract(query) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`;
  const data = await getJson(url);
  const results = [];
  if (data.AbstractText) {
    results.push({
      title: data.Heading || query,
      url: data.AbstractURL,
      snippet: data.AbstractText.slice(0, 200),
      source: "duckduckgo",
    });
  }
  for (const topic of (data.RelatedTopics ?? []).slice(0, 3)) {
    if (!topic.FirstURL) continue;
    results.push({
      title: topic.Text?.slice(0, 80) ?? topic.FirstURL,
      url: topic.FirstURL,
      snippet: topic.Text?.slice(0, 200) ?? "",
      source: "duckduckgo",
    });
  }
  return results;
}

async function searxSearch(query, baseUrl) {
  assertPublicUrl(baseUrl);
  const url = `${baseUrl.replace(/\/$/, "")}/search?q=${encodeURIComponent(query)}&format=json`;
  const data = await getJson(url);
  return (data.results ?? []).slice(0, 8).map((item) => ({
    title: item.title,
    url: item.url,
    snippet: (item.content ?? "").slice(0, 200),
    source: "searxng",
  }));
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x?(\w+);/g, (match, code) => {
      const value = code.startsWith("x") ? parseInt(code.slice(1), 16) : Number(code);
      return Number.isFinite(value) ? String.fromCodePoint(value) : match;
    });
}

export function htmlToText(html) {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
  const description =
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1] ?? "";
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|pre)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = decodeEntities(body)
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
  return { title: decodeEntities(title), description: decodeEntities(description), text };
}

async function fetchReadable(url, limit = 6000) {
  const parsed = assertPublicUrl(url);
  await assertPublicDns(parsed.hostname);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      headers: { "user-agent": UA, accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.5" },
      signal: controller.signal,
      redirect: "follow",
    });
    const finalUrl = assertPublicUrl(response.url || url); // redirect target re-check
    await assertPublicDns(finalUrl.hostname);
    if (!response.ok) return { ok: false, error: `HTTP ${response.status} для ${url}` };
    const type = response.headers.get("content-type") ?? "";
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_FETCH_BYTES) return { ok: false, error: `ответ слишком большой: ${url}` };
    const raw = (await response.text()).slice(0, MAX_FETCH_BYTES);
    if (type.includes("json")) {
      return { ok: true, title: url, description: "", text: raw.slice(0, limit) };
    }
    if (type.includes("text/plain") || type.includes("xml")) {
      return { ok: true, title: url, description: "", text: raw.slice(0, limit) };
    }
    const { title, description, text } = htmlToText(raw);
    return { ok: true, title: title || url, description, text: text.slice(0, limit) };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ factory

/**
 * @param {object} host
 * @param {() => any} host.getPi            pi SDK module
 * @param {() => any} host.getRuntime       ModelRuntime
 * @param {() => object} host.getConfig     live granka config
 * @param {() => string} host.getCwd        current working directory
 * @param {(question: object) => Promise<string>} host.askUser  renderer round-trip
 * @param {(payload: object) => void} host.emit  push a notice to the renderer
 */

// --- background subagents -------------------------------------------------
// A background task runs detached from the parent turn. Its result is kept in
// the registry (for the UI panel) and queued for the parent's next turn.
const backgroundTasks = new Map();
const backgroundAborts = new Map();
const pendingBackgroundResults = [];
let backgroundHost = null;

export function cancelBackgroundTask(id) {
  const task = backgroundTasks.get(id);
  if (!task || task.status !== "running") return { ok: false, error: "задача не найдена или уже завершена" };
  task.status = "canceled";
  task.text = "отменено";
  backgroundAborts.get(id)?.abort();
  backgroundHost?.emit?.({ kind: "backgroundTask", task: { ...task } });
  return { ok: true };
}

export function listBackgroundTasks() {
  return [...backgroundTasks.values()].map((task) => ({
    id: task.id, agent: task.agent, description: task.description,
    status: task.status, startedAt: task.startedAt, text: task.text ?? "",
  }));
}

export function drainBackgroundResults() {
  const drained = pendingBackgroundResults.splice(0);
  return drained;
}

function readMemoryCappedLocal(file) {
  let text = "";
  try { text = fs.readFileSync(file, "utf8").trim(); } catch { return ""; }
  if (!text) return "";
  const lines = text.split("\n").slice(0, 200).join("\n");
  return lines.length > 25 * 1024 ? lines.slice(0, 25 * 1024) : lines;
}

export function createGrankaTools(host) {
  backgroundHost = host;
  const todoTool = {
    name: "todo_write",
    label: "План",
    description:
      "Keeps the current run's task list. Pass the FULL list every time, including done items. " +
      "Keep exactly one in_progress item and mark completed right after verification. Max 10 items. " +
      "To drop a task, omit it from the new list; to clear the plan entirely, pass an empty array.",
    promptSnippet: "todo_write: keep the run task list up to date",
    parameters: Type.Object({
      items: Type.Array(
        Type.Object({
          content: Type.String({ description: "Short task wording" }),
          status: Type.Union([
            Type.Literal("pending"),
            Type.Literal("in_progress"),
            Type.Literal("completed"),
          ]),
        }),
        { maxItems: 10 },
      ),
    }),
    execute: async (_id, params) => {
      const items = (params.items ?? []).slice(0, 10);
      if (!items.length) {
        host.emit({ kind: "todo", items: [], cleared: true });
        return { content: [{ type: "text", text: "Plan cleared." }], details: { items: [] } };
      }
      host.emit({ kind: "todo", items });
      const done = items.filter((item) => item.status === "completed").length;
      return {
        content: [{ type: "text", text: `Plan updated: ${done}/${items.length} done.` }],
        details: { items },
      };
    },
  };

  const askTool = {
    name: "ask_user",
    label: "Вопрос пользователю",
    description:
      "Asks the user one structured question with options and waits for a choice. " +
      "Use when guessing would pick the wrong approach, file or format. " +
      "Do not ask what code, config or docs can answer.",
    promptSnippet: "ask_user: ask the user with answer options",
    parameters: Type.Object({
      question: Type.String({ description: "One specific question" }),
      header: Type.Optional(Type.String({ description: "Short label, up to 16 chars" })),
      options: Type.Array(
        Type.Object({
          label: Type.String({ description: "Option, 1-5 words" }),
          description: Type.Optional(Type.String({ description: "What happens if chosen" })),
        }),
        { minItems: 1, maxItems: 4 },
      ),
      allowFreeform: Type.Optional(Type.Boolean({ description: "Allow a free-form answer" })),
    }),
    execute: async (_id, params) => {
      const answer = await host.askUser({
        question: params.question,
        header: params.header ?? "",
        options: params.options ?? [],
        allowFreeform: params.allowFreeform !== false,
      });
      return {
        content: [{ type: "text", text: answer ? `User answered: ${answer}` : "User did not answer." }],
        details: { answer },
      };
    },
  };

  const webSearchTool = {
    name: "web_search",
    label: "Веб-поиск",
    description:
      "Searches open sources without keys or accounts: Wikipedia, Hacker News, DuckDuckGo" +
      " (GitHub without auth can rate-limit 429/403 — fall back to DuckDuckGo). " +
      "Returns titles, links and short snippets. Use web_fetch to read a page.",
    promptSnippet: "web_search: find pages by query (no API keys)",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Number({ description: "How many results to return, default 8" })),
    }),
    execute: async (_id, params) => {
      const query = String(params.query ?? "").trim();
      if (!query) return { content: [{ type: "text", text: "Empty query." }], details: {} };
      const limit = Math.min(Math.max(Number(params.limit) || 8, 1), 15);
      const config = host.getConfig();
      const tasks = [
        ddgLite(query, 6).catch(() => []),
        searxSearch(query, config.searxUrl).catch(() => []),
        wikiSearch(query, "ru").catch(() => []),
        wikiSearch(query, "en").catch(() => []),
        githubSearch(query).catch(() => []),
        hnSearch(query).catch(() => []),
        ddgAbstract(query).catch(() => []),
      ];
      const batches = (await Promise.all(tasks)).filter((batch) => batch.length);
      const seen = new Set();
      const results = [];
      for (const item of batches.flat()) {
        if (!item.url || seen.has(item.url)) continue;
        seen.add(item.url);
        results.push(item);
        if (results.length >= limit) break;
      }
      if (!results.length) {
        return {
          content: [
            {
              type: "text",
              text: "Search returned nothing (sources unavailable or query too narrow). Rephrase it or open a concrete URL with web_fetch.",
            },
          ],
          details: { query, results: [] },
        };
      }
      const text = results
        .map((item, index) => `${index + 1}. ${item.title}\n   ${item.url}\n   ${item.snippet} [${item.source}]`)
        .join("\n");
      return { content: [{ type: "text", text }], details: { query, results } };
    },
  };

  const webFetchTool = {
    name: "web_fetch",
    label: "Чтение страницы",
    description:
      "Fetches a URL and returns the page title, description and text without markup. " +
      "No keys needed. Use after web_search to read the source.",
    promptSnippet: "web_fetch: read a page by URL",
    parameters: Type.Object({
      url: Type.String({ description: "http(s) URL" }),
      maxChars: Type.Optional(Type.Number({ description: "Character limit, default 6000" })),
    }),
    execute: async (_id, params) => {
      const url = String(params.url ?? "").trim();
      if (!/^https?:\/\//i.test(url)) {
        return { content: [{ type: "text", text: "A full http(s) URL is required." }], details: {} };
      }
      const limit = Math.min(Math.max(Number(params.maxChars) || 6000, 500), 20000);
      let page;
      try { page = await fetchReadable(url, limit); }
      catch (err) { return { content: [{ type: "text", text: String(err?.message ?? err) }], details: {} }; }
      if (!page.ok) return { content: [{ type: "text", text: page.error }], details: {} };
      const text = [page.title, page.description, page.text].filter(Boolean).join("\n\n");
      return { content: [{ type: "text", text }], details: { url, title: page.title } };
    },
  };

  const subagentTool = {
    name: "task",
    label: "Подагент",
    description:
      "Delegates a subtask to a separate agent with its own context and returns its report. " +
      "Pick the agent by job: explore — find and explain code, research — external facts with links, " +
      "review — check changes for defects, plan — build a work plan, general — multi-step analysis, " +
      "or a custom agent id from ~/.granka/subagents. " +
      "Give a self-contained brief: what to find, where to look, and the output format. " +
      "You make the edits yourself; never delegate them.",
    promptSnippet: "task: delegate a subtask to a specialised agent (explore/research/review/plan/general)",
    promptGuidelines: [
      "Call task when searching or reading would eat context but only the output is needed.",
      "One call — one subtask. Do not split one question into several calls without need.",
      "A subagent cannot change files — anything needing edits, do yourself.",
    ],
    parameters: Type.Object({
      agent: Type.Optional(
        Type.String({ description: "Who does it: explore, research, review, plan, general, or a custom id from ~/.granka/subagents. Default explore." }),
      ),
      background: Type.Optional(
        Type.Boolean({ description: "Run in the background: return immediately, result arrives in the panel and in the next turn" }),
      ),
      description: Type.String({ description: "One line: what the subagent should do" }),
      prompt: Type.String({ description: "Full self-contained brief" }),
    }),
    execute: async (_id, params, signal) => {
      const all = getSubagents(host.getAgentDir());
      const definition = all[params.agent] ?? SUBAGENTS.explore;

      const runSubagent = async (runSignal) => {
        if (runSignal?.aborted) throw new Error("задача отменена");
        const pi = host.getPi();
        const runtime = host.getRuntime();
        const cwd = host.getCwd();
        const config = host.getConfig();
        // Subagents get memory (global, project, own) but not AGENTS rules:
        // memory is learnings, rules are instructions — the firewall stays.
        const agentDir = host.getAgentDir();
        const append = [];
        if (config.memoryEnabled !== false) {
          const globalMemory = readMemoryCappedLocal(path.join(agentDir, "MEMORY.md"));
          if (globalMemory) append.push(`## User memory\n${globalMemory}`);
          const projectId = String(config.activeProject ?? "");
          if (/^[a-zA-Z0-9_-]{1,64}$/.test(projectId)) {
            const projectMemory = readMemoryCappedLocal(path.join(agentDir, "memory", `${projectId}.md`));
            if (projectMemory) append.push(`## Project memory\n${projectMemory}`);
          }
          const ownMemory = readMemoryCappedLocal(path.join(agentDir, "memory", "agents", `${definition.id}.md`));
          if (ownMemory) append.push(`## Your memory (this agent type)\n${ownMemory}`);
        }
        const agentMemoryTool = {
          name: "memory_write",
          label: "Память",
          description:
            "Append a note to this agent type's own memory (~/.granka/memory/agents/" + definition.id + ".md). " +
            "One short note per call. Never store secrets or code-derivable facts.",
          promptSnippet: "memory_write: append a note to this agent type's memory",
          parameters: Type.Object({
            text: Type.String({ description: "One short note" }),
          }),
          execute: async (_id2, params2) => {
            const note = String(params2.text ?? "").trim();
            if (!note) return { content: [{ type: "text", text: "Empty note." }], details: {} };
            const file = path.join(agentDir, "memory", "agents", `${definition.id}.md`);
            await fsp.mkdir(path.dirname(file), { recursive: true });
            let existing = "";
            try {
              existing = await fsp.readFile(file, "utf8");
            } catch (err) {
              if (err?.code !== "ENOENT") throw err;
            }
            if (existing.split("\n").some((line) => line.trim() === note || line.trim() === `- ${note}`)) {
              return { content: [{ type: "text", text: "Already in memory." }], details: { added: false } };
            }
            const entry = note.startsWith("- ") || note.startsWith("#") ? note : `- ${note}`;
            await fsp.writeFile(file, `${existing.trimEnd()}${existing.trimEnd() ? "\n" : ""}${entry}\n`);
            return { content: [{ type: "text", text: "Saved to agent memory." }], details: { added: true } };
          },
        };
        const childTools = [...new Set([...definition.tools, "memory_write"])];
        const loader = new (await import("@earendil-works/pi-coding-agent")).DefaultResourceLoader({
          cwd,
          agentDir,
          systemPrompt: definition.systemPrompt,
          appendSystemPrompt: append,
          noContextFiles: true,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
        });
        await loader.reload();

        const created = await pi.createAgentSession({
          cwd,
          modelRuntime: runtime,
          resourceLoader: loader,
          sessionManager: pi.SessionManager.inMemory(cwd),
          tools: childTools,
          customTools: [agentMemoryTool],
          // Subagents always run on the parent dialog's model. Without an
          // explicit model the SDK falls back to its provider default
          // (moonshotai/kimi-k2.7-code for OpenRouter) — a paid model the user
          // never chose, billed invisibly outside the parent's usage stats.
          model: config.model ? runtime.getModel("openrouter", config.model) : undefined,
          thinkingLevel: definition.thinking ?? "low",
        });
        const child = created.session; // createAgentSession returns { session, ... }
        const abort = () => child.abort().catch(() => {});
        runSignal?.addEventListener?.("abort", abort);
        try {
          await child.prompt(`Task: ${params.description}\n\n${params.prompt}`);
          // Subagent spend must be visible: record it under the parent model so
          // stats/budget account for it instead of billing invisibly.
          try {
            const last = [...(child.messages ?? [])].reverse().find((m) => m.role === "assistant");
            const u = last?.usage;
            if (u && host.recordUsage) {
              host.recordUsage(child.sessionManager.getSessionId(), config.model, {
                input: u.input,
                output: u.output,
                cacheRead: u.cacheRead,
                cost: u.cost?.total ?? 0,
              });
            }
          } catch (err) { console.error("[granka subagent usage]", err?.message ?? err); }
          // All assistant segments of the run, not only the last message:
          // text -> tool -> text turns would otherwise lose the earlier text.
          let full = "";
          try {
            const parts = [];
            for (const m of child.messages ?? []) {
              if (m?.role !== "assistant") continue;
              const t = typeof m.content === "string" ? m.content
                : (Array.isArray(m.content) ? m.content.filter((b) => b?.type === "text").map((b) => b.text).join("") : "");
              if (t.trim()) parts.push(t.trim());
            }
            full = parts.join("\n\n");
          } catch (err) { console.error("[granka subagent text]", err?.message ?? err); }
          const text = (full || child.getLastAssistantText() || "").slice(0, 5000);
          if (config.debugTools) {
            host.emit({ kind: "subagent", agent: definition.id, description: params.description, chars: text.length });
          }
          return text || "The subagent returned an empty answer.";
        } finally {
          runSignal?.removeEventListener?.("abort", abort);
          child.dispose();
        }
      };

      if (params.background) {
        const id = `bg-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;
        const task = { id, agent: definition.id, description: params.description, status: "running", startedAt: Date.now(), text: "" };
        backgroundTasks.set(id, task);
        const controller = new AbortController();
        backgroundAborts.set(id, controller);
        host.emit({ kind: "backgroundTask", task: { ...task } });
        runSubagent(controller.signal).then(
          (text) => {
            if (task.status === "canceled") return;
            task.status = "done";
            task.text = text;
            pendingBackgroundResults.push({ agent: task.agent, description: task.description, text });
            host.emit({ kind: "backgroundTask", task: { ...task } });
          },
          (err) => {
            if (task.status === "canceled") return;
            task.status = "error";
            task.text = String(err?.message ?? err);
            host.emit({ kind: "backgroundTask", task: { ...task } });
          },
        ).finally(() => backgroundAborts.delete(id));
        return {
          content: [{ type: "text", text: `Background task ${id} started (${definition.id}: ${params.description}). Result will appear in the background panel and in your next turn.` }],
          details: { agent: definition.id, description: params.description, background: true, taskId: id },
        };
      }

      const text = await runSubagent(signal);
      return {
        content: [{ type: "text", text }],
        details: { agent: definition.id, description: params.description },
      };
    },
  };

  const repoMapTool = {
    name: "repo_map",
    label: "Карта проекта",
    description:
      "Builds a compact project tree map (up to 300 files, without .git/node_modules). " +
      "Use at the start of a task to understand the structure instead of ls/find over the whole tree.",
    promptSnippet: "repo_map: project tree map",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Subfolder to start from (default: root)" })),
      maxDepth: Type.Optional(Type.Number({ description: "Depth, default 3" })),
    }),
    execute: async (_id, params) => {
      const root = host.getCwd();
      const start = params.path ? path.resolve(root, String(params.path)) : root;
      const rel = path.relative(path.resolve(root), start);
      if (rel.startsWith(`..${path.sep}`) || rel === ".." || path.isAbsolute(rel)) {
        return { content: [{ type: "text", text: "path outside the working folder" }], details: {} };
      }
      const maxDepth = Math.min(Math.max(Number(params.maxDepth) || 3, 1), 6);
      const SKIP = new Set([".git", "node_modules", "dist", "build", ".venv", "__pycache__"]);
      const lines = [];
      let files = 0;
      // Async walk: sync readdir would freeze the main process (UI) for the
      // duration of the scan.
      const walk = async (dir, depth, prefix) => {
        if (files > 300 || depth > maxDepth) return;
        let entries = [];
        try {
          entries = (await fsp.readdir(dir, { withFileTypes: true }))
            .filter((e) => !SKIP.has(e.name) && !e.name.startsWith("."))
            .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
        } catch (err) { console.error("[granka repo_map]", err?.message ?? err); return; }
        for (const entry of entries) {
          if (files > 300) break;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            lines.push(`${prefix}${entry.name}/`);
            await walk(full, depth + 1, `${prefix}  `);
          } else {
            files += 1;
            lines.push(`${prefix}${entry.name}`);
          }
        }
      };
      await walk(start, 1, "");
      const text = lines.join("\n") || "(пусто)";
      return { content: [{ type: "text", text }], details: { files } };
    },
  };

  // Memory: agent-written notes the user can audit and edit in the UI.
  // Append-only and deduped: the agent adds learnings, never rewrites memory.
  const memoryTool = {
    name: "memory_write",
    label: "Память",
    description:
      "Append a note to agent memory: a user preference, a correction, a project fact or a pointer. " +
      "Scope: global (all projects) or project (this project only). Pass one short note per call, " +
      "as a rule plus Why/How when it is feedback. Never store secrets, code-derivable facts, " +
      "git history or ephemeral task details. Exact duplicates are skipped.",
    promptSnippet: "memory_write: append a note to agent memory (global or project)",
    parameters: Type.Object({
      scope: Type.Union([Type.Literal("global"), Type.Literal("project")], { description: "global = all projects, project = this project" }),
      text: Type.String({ description: "One short note" }),
    }),
    execute: async (_id, params) => {
      const note = String(params.text ?? "").trim();
      if (!note) return { content: [{ type: "text", text: "Empty note." }], details: {} };
      const agentDir = host.getAgentDir();
      const cfg = host.getConfig();
      let file;
      if (params.scope === "project") {
        const id = String(cfg.activeProject ?? "");
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
          return { content: [{ type: "text", text: "No active project: use scope global." }], details: {} };
        }
        file = path.join(agentDir, "memory", `${id}.md`);
      } else {
        file = path.join(agentDir, "MEMORY.md");
      }
      await fsp.mkdir(path.dirname(file), { recursive: true });
      let existing = "";
      try {
        existing = await fsp.readFile(file, "utf8");
      } catch (err) {
        if (err?.code !== "ENOENT") throw err;
      }
      if (existing.split("\n").some((line) => line.trim() === note || line.trim() === `- ${note}`)) {
        return { content: [{ type: "text", text: "Already in memory." }], details: { scope: params.scope, added: false } };
      }
      const entry = note.startsWith("- ") || note.startsWith("#") ? note : `- ${note}`;
      await fsp.writeFile(file, `${existing.trimEnd()}${existing.trimEnd() ? "\n" : ""}${entry}\n`);
      return { content: [{ type: "text", text: `Saved to ${params.scope} memory.` }], details: { scope: params.scope, added: true } };
    },
  };


  // Whitespace-tolerant sibling of the SDK edit tool: exact-text matching
  // fails on indentation/trailing-space drift after the model re-reads a
  // file from a truncated view. Matching compares lines with whitespace
  // collapsed, then splices into the original lines.
  const fuzzyEditTool = {
    name: "edit_fuzzy",
    label: "Нечёткая правка",
    description:
      "Like edit, but tolerates whitespace differences (indentation, trailing spaces, blank-line runs). " +
      "Use when exact edit fails on whitespace. The match must be unique in the file.",
    promptSnippet: "edit_fuzzy: whitespace-tolerant edit (unique match required)",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
      oldText: Type.String({ description: "Text to replace (whitespace-tolerant)" }),
      newText: Type.String({ description: "Replacement text" }),
    }),
    execute: async (_id, params) => {
      const filePath = path.resolve(host.getCwd(), String(params.path ?? ""));
      assertNotSensitive(filePath);
      const raw = await fsp.readFile(filePath, "utf8");
      const eol = raw.includes("\r\n") ? "\r\n" : "\n";
      const norm = (line) => String(line).replace(/\s+/g, " ").trim();
      const origLines = raw.split(/\r\n|\r|\n/);
      const normLines = origLines.map(norm);
      const needle = String(params.oldText ?? "").split(/\r\n|\r|\n/).map(norm);
      if (!needle.some(Boolean)) {
        return { content: [{ type: "text", text: "oldText is empty." }], details: {}, isError: true };
      }
      const hits = [];
      for (let i = 0; i + needle.length <= normLines.length; i += 1) {
        let ok = true;
        for (let j = 0; j < needle.length; j += 1) {
          if (normLines[i + j] !== needle[j]) { ok = false; break; }
        }
        if (ok) hits.push(i);
      }
      if (!hits.length) {
        // Hint with the closest anchor: first non-empty needle line.
        const anchor = needle.find(Boolean);
        const at = normLines.findIndex((line) => line === anchor);
        const hint = at >= 0
          ? ` Похожая строка найдена на строке ${at + 1}: ${origLines[at].slice(0, 120)}`
          : ` Файл: ${origLines.length} строк.`;
        return {
          content: [{ type: "text", text: `Не найдено в ${params.path}.${hint} Перечитайте файл и укажите точный текст.` }],
          details: {},
          isError: true,
        };
      }
      if (hits.length > 1) {
        return {
          content: [{ type: "text", text: `Неоднозначно: совпадения на строках ${hits.map((h) => h + 1).join(", ")}. Укажите больший контекст.` }],
          details: {},
          isError: true,
        };
      }
      const at = hits[0];
      const replacement = String(params.newText ?? "").split(/\r\n|\r|\n/);
      const next = [...origLines.slice(0, at), ...replacement, ...origLines.slice(at + needle.length)];
      await fsp.writeFile(filePath, next.join(eol), "utf8");
      return {
        content: [{ type: "text", text: `OK: строки ${at + 1}–${at + needle.length} заменены в ${params.path}.` }],
        details: { firstChangedLine: at + 1 },
      };
    },
  };

  const gitTools = createGitTools(host);

  return { todoTool, askTool, webSearchTool, webFetchTool, subagentTool, repoMapTool, memoryTool, fuzzyEditTool, ...gitTools };
}
