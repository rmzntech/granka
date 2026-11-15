// granka's own agent tools: plan (todo), structured question, keyless web
// search/fetch and a one-level subagent. Everything runs in the main process,
// uses no API keys and no paid services.
import { Type } from "typebox";
import fs from "node:fs";
import path from "node:path";
import { SUBAGENTS, SUBAGENT_IDS } from "./subagents.mjs";

// ---------------------------------------------------------------- git (thin wrappers)
// Frequent read-only git operations deserve real tools instead of the model
// hand-writing `git diff` through bash every time. Fixed argv, no shell.
import { execFile } from "node:child_process";
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
    return stdout.trim() || "(пусто)";
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
      "Показывает состояние репозитория: ветку, изменённые и новые файлы (git status --short --branch). " +
      "Используй перед правками и ревью вместо bash с git status.",
    promptSnippet: "git_status: состояние репозитория",
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
      "Показывает незакоммиченные изменения (git diff HEAD). Без пути — сводка по файлам (--stat), " +
      "с путём — полный diff файла. Используй для ревью своих правок вместо bash.",
    promptSnippet: "git_diff: незакоммиченные изменения",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Путь к файлу для полного diff" })),
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
  assertPublicUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      headers: { "user-agent": UA, accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.5" },
      signal: controller.signal,
      redirect: "follow",
    });
    assertPublicUrl(response.url || url); // redirect target re-check
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
export function createGrankaTools(host) {
  const todoTool = {
    name: "todo_write",
    label: "План",
    description:
      "Ведёт список задач текущего хода. Передавай ПОЛНЫЙ список каждый раз: элементы, которые уже сделаны, тоже. " +
      "Держи ровно один элемент in_progress и отмечай completed сразу после проверки. Максимум 10 пунктов. " +
      "Чтобы убрать задачу — просто не включай её в новый список; чтобы очистить план целиком — передай пустой массив.",
    promptSnippet: "todo_write: держать список задач хода в актуальном состоянии",
    parameters: Type.Object({
      items: Type.Array(
        Type.Object({
          content: Type.String({ description: "Короткая формулировка задачи" }),
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
        return { content: [{ type: "text", text: "План очищен." }], details: { items: [] } };
      }
      host.emit({ kind: "todo", items });
      const done = items.filter((item) => item.status === "completed").length;
      return {
        content: [{ type: "text", text: `План обновлён: ${done}/${items.length} готово.` }],
        details: { items },
      };
    },
  };

  const askTool = {
    name: "ask_user",
    label: "Вопрос пользователю",
    description:
      "Задаёт пользователю один структурированный вопрос с вариантами ответа и ждёт выбора. " +
      "Используй, когда без решения пользователя можно сделать не то (выбор подхода, файла, формата). " +
      "Не задавай вопрос, если ответ можно узнать из кода или документации.",
    promptSnippet: "ask_user: спросить пользователя с вариантами ответа",
    parameters: Type.Object({
      question: Type.String({ description: "Один конкретный вопрос" }),
      header: Type.Optional(Type.String({ description: "Короткая метка, до 16 символов" })),
      options: Type.Array(
        Type.Object({
          label: Type.String({ description: "Вариант, 1-5 слов" }),
          description: Type.Optional(Type.String({ description: "Что произойдёт при выборе" })),
        }),
        { minItems: 1, maxItems: 4 },
      ),
      allowFreeform: Type.Optional(Type.Boolean({ description: "Разрешить свой ответ" })),
    }),
    execute: async (_id, params) => {
      const answer = await host.askUser({
        question: params.question,
        header: params.header ?? "",
        options: params.options ?? [],
        allowFreeform: params.allowFreeform !== false,
      });
      return {
        content: [{ type: "text", text: answer ? `Пользователь ответил: ${answer}` : "Пользователь не ответил." }],
        details: { answer },
      };
    },
  };

  const webSearchTool = {
    name: "web_search",
    label: "Веб-поиск",
    description:
      "Ищет в открытых источниках без ключей и аккаунтов: Википедия, Hacker News, DuckDuckGo" +
      " (GitHub — без авторизации возможны rate-limit 429/403, при ошибке переключайся на DuckDuckGo). " +
      "Возвращает заголовки, ссылки и короткие описания. Для чтения страницы используй web_fetch.",
    promptSnippet: "web_search: найти страницы по запросу (без API-ключей)",
    parameters: Type.Object({
      query: Type.String({ description: "Поисковый запрос" }),
      limit: Type.Optional(Type.Number({ description: "Сколько результатов вернуть, по умолчанию 8" })),
    }),
    execute: async (_id, params) => {
      const query = String(params.query ?? "").trim();
      if (!query) return { content: [{ type: "text", text: "Пустой запрос." }], details: {} };
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
              text: "Поиск ничего не вернул (источники недоступны или запрос слишком узкий). Попробуй переформулировать или открой конкретный URL через web_fetch.",
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
      "Загружает URL и возвращает заголовок, описание и текст страницы без разметки. " +
      "Работает без ключей. Используй после web_search, чтобы прочитать нужный источник.",
    promptSnippet: "web_fetch: прочитать страницу по URL",
    parameters: Type.Object({
      url: Type.String({ description: "http(s) URL" }),
      maxChars: Type.Optional(Type.Number({ description: "Лимит символов, по умолчанию 6000" })),
    }),
    execute: async (_id, params) => {
      const url = String(params.url ?? "").trim();
      if (!/^https?:\/\//i.test(url)) {
        return { content: [{ type: "text", text: "Нужен полный http(s) URL." }], details: {} };
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
      "Делегирует подзадачу отдельному агенту с собственным контекстом и возвращает его отчёт. " +
      "Выбирай агента по задаче: explore — найти и объяснить код, research — внешние факты со ссылками, " +
      "review — проверить изменения на дефекты, plan — собрать план работ, general — многошаговый разбор. " +
      "Дай самодостаточное задание: что найти, где искать и какой формат ответа нужен. " +
      "Правки кода делай сам, подагентам их не поручай.",
    promptSnippet: "task: делегировать подзадачу специализированному агенту (explore/research/review/plan/general)",
    promptGuidelines: [
      "Вызывай task, когда поиск или чтение займут много места в контексте, а нужен только вывод.",
      "Один вызов — одна подзадача. Не дроби один вопрос на несколько вызовов без нужды.",
      "Подагент не может менять файлы — всё, что требует правок, делай сам.",
    ],
    parameters: Type.Object({
      agent: Type.Optional(
        Type.Union(
          SUBAGENT_IDS.map((id) => Type.Literal(id)),
          { description: "Кто выполняет: explore, research, review, plan или general. По умолчанию explore." },
        ),
      ),
      description: Type.String({ description: "Одна строка: что должен сделать подагент" }),
      prompt: Type.String({ description: "Полное самодостаточное задание" }),
    }),
    execute: async (_id, params, signal) => {
      const pi = host.getPi();
      const runtime = host.getRuntime();
      const cwd = host.getCwd();
      const config = host.getConfig();
      const definition = SUBAGENTS[params.agent] ?? SUBAGENTS.explore;

      const loader = new (await import("@earendil-works/pi-coding-agent")).DefaultResourceLoader({
        cwd,
        agentDir: host.getAgentDir(),
        systemPrompt: definition.systemPrompt,
        appendSystemPrompt: [],
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
        tools: definition.tools,
        // Subagents always run on the parent dialog's model. Without an
        // explicit model the SDK falls back to its provider default
        // (moonshotai/kimi-k2.7-code for OpenRouter) — a paid model the user
        // never chose, billed invisibly outside the parent's usage stats.
        model: config.model ? runtime.getModel("openrouter", config.model) : undefined,
        thinkingLevel: definition.thinking ?? "low",
      });
      const child = created.session; // createAgentSession returns { session, ... }
      // Forward the child's tool activity to the parent chat: the task chip
      // shows what the subagent is doing instead of a blind "работает…".
      const unsub = child.subscribe?.((event) => {
        if (event.type === "tool_execution_start") {
          host.emit({ kind: "subtool", agent: definition.id, name: event.toolName, phase: "start" });
        } else if (event.type === "tool_execution_end") {
          host.emit({ kind: "subtool", agent: definition.id, name: event.toolName, phase: "end", isError: Boolean(event.isError) });
        }
      });
      const abort = () => child.abort().catch(() => {});
      signal?.addEventListener?.("abort", abort);
      try {
        await child.prompt(`Задача: ${params.description}\n\n${params.prompt}`);
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
        const text = (child.getLastAssistantText() ?? "").slice(0, 5000);
        if (config.debugTools) {
          host.emit({ kind: "subagent", agent: definition.id, description: params.description, chars: text.length });
        }
        return {
          content: [{ type: "text", text: text || "Подагент вернул пустой ответ." }],
          details: { agent: definition.id, description: params.description },
        };
      } finally {
        signal?.removeEventListener?.("abort", abort);
        try { unsub?.(); } catch {}
        child.dispose();
      }
    },
  };

  const repoMapTool = {
    name: "repo_map",
    label: "Карта проекта",
    description:
      "Строит компактную карту дерева проекта (до 300 файлов, без .git/node_modules). " +
      "Используй в начале задачи, чтобы понять структуру, вместо ls/find по всему дереву.",
    promptSnippet: "repo_map: карта дерева проекта",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Подпапка, с которой начать (по умолчанию корень)" })),
      maxDepth: Type.Optional(Type.Number({ description: "Глубина, по умолчанию 3" })),
    }),
    execute: async (_id, params) => {
      const root = host.getCwd();
      const start = params.path ? path.resolve(root, String(params.path)) : root;
      const rel = path.relative(path.resolve(root), start);
      if (rel.startsWith(`..${path.sep}`) || rel === ".." || path.isAbsolute(rel)) {
        return { content: [{ type: "text", text: "путь вне рабочей папки" }], details: {} };
      }
      const maxDepth = Math.min(Math.max(Number(params.maxDepth) || 3, 1), 6);
      const SKIP = new Set([".git", "node_modules", "dist", "build", ".venv", "__pycache__"]);
      const lines = [];
      let files = 0;
      const walk = (dir, depth, prefix) => {
        if (files > 300 || depth > maxDepth) return;
        let entries = [];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true })
            .filter((e) => !SKIP.has(e.name) && !e.name.startsWith("."))
            .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
        } catch (err) { console.error("[granka repo_map]", err?.message ?? err); return; }
        for (const entry of entries) {
          if (files > 300) break;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            lines.push(`${prefix}${entry.name}/`);
            walk(full, depth + 1, `${prefix}  `);
          } else {
            files += 1;
            lines.push(`${prefix}${entry.name}`);
          }
        }
      };
      walk(start, 1, "");
      const text = lines.join("\n") || "(пусто)";
      return { content: [{ type: "text", text }], details: { files } };
    },
  };

  const gitTools = createGitTools(host);

  return { todoTool, askTool, webSearchTool, webFetchTool, subagentTool, repoMapTool, ...gitTools };
}
