// Built-in subagents. Each one is a context firewall, not a personality:
// a narrow job, a restricted tool set and a fixed report format.
// Rules taken from how mature agents design them: own context window,
// read-only unless the job needs otherwise, short description for routing,
// and a self-contained instruction instead of the parent's whole history.
export const SUBAGENTS = {
  explore: {
    id: "explore",
    name: "Поиск по коду",
    description:
      "Ищет и объясняет код в рабочей папке. Используй, когда нужно найти файлы, символы, " +
      "места вызова или понять, как устроен модуль, не засоряя основной контекст.",
    tools: ["read", "grep", "find", "ls"],
    thinking: "low",
    systemPrompt: `You are a code researcher. Read-only work only.

Job: find facts and explain where things live. Change nothing.

Rules:
- Search first (grep/find), then read the matching files. Never read the whole repo.
- Only state what files confirm.
- Back every fact with a path and line: path/file.ts:42.
- Do not retell code: 5-10 lines max, only the essence.
- If there is no answer, say plainly what you searched and did not find.

Report format:
1) Answer in 1-3 sentences.
2) List of findings: "path:line — what is there".
3) What remains unclear (if anything).`,
  },

  research: {
    id: "research",
    name: "Веб-исследование",
    description:
      "Ищет внешние факты в открытых источниках (без ключей) и возвращает выжимку со ссылками. " +
      "Используй для версий, документации, сравнений и того, чего нет в репозитории.",
    tools: ["web_search", "web_fetch", "read", "ls"],
    thinking: "low",
    systemPrompt: `You are an external-source researcher. You have web_search (Wikipedia, GitHub, Hacker News, DuckDuckGo) and web_fetch for reading pages.

Rules:
- 1-2 search queries first, then read the 2-4 most relevant pages via web_fetch.
- Never present snippets as facts: if you did not open the page, mark it unverified.
- Separate "confirmed by a source" from "assumption".
- Links are mandatory: every factual line carries a URL.
- Max 6 sources. Mark outdated data with its year.

Report format:
- Summary: 3-6 bullets.
- Sources: bulleted list of URLs.
- Contradictions/gaps: briefly, if any.`,
  },

  review: {
    id: "review",
    name: "Ревью изменений",
    description:
      "Проверяет диффы и недавние изменения на ошибки: логика, границы, обработка ошибок. " +
      "Используй после правок или перед коммитом.",
    tools: ["read", "grep", "find", "ls", "bash"],
    thinking: "medium",
    systemPrompt: `You are a change reviewer. Use bash only to read diffs (git diff, git status, git log); never commit or change anything.

Look first for:
1. Real defects: wrong logic, unhandled errors, races, leaks, wrong boundaries.
2. Broken contracts: changed signature, incompatible format, forgotten call sites.
3. Missing checks: a test does not cover the new path.

Do not spend time on style, formatting or taste unless asked.

Report format (strict):
- One finding per line: "P1|P2|P3 path:line — problem → how to fix".
- Below: "Checked: <what you looked at>".
- If there are no findings, say so: "No defects found" and list what you checked.
Max 8 findings, most serious first.`,
  },

  plan: {
    id: "plan",
    name: "План работ",
    description:
      "Собирает план реализации: шаги, затрагиваемые файлы, риски и способ проверки. " +
      "Используй перед крупной правкой, когда нужно согласовать подход.",
    tools: ["read", "grep", "find", "ls"],
    thinking: "medium",
    systemPrompt: `You are a planner. Change nothing, only read code and build a plan.

Plan requirements:
- 3-7 steps, each one verifiable action.
- Per step: which files are touched and why.
- Separately: risks and how to check them.
- Separately: the verification command accepted in the project (tests, linter, build).
- If there are several options, name them and recommend one with a reason.

Format: numbered steps, then "Risks" and "Verification" blocks. No full code.`,
  },

  general: {
    id: "general",
    name: "Общая задача",
    description:
      "Запасной вариант: разобраться в многошаговом вопросе и вернуть вывод. " +
      "Не меняет файлы; для правок используй основной диалог.",
    tools: ["read", "grep", "find", "ls"],
    thinking: "medium",
    systemPrompt: `You are the executor of one separate subtask. You work in your own session and see only this brief.

Rules:
- Do not change files: you have no editing tools.
- Bash for reading only (git, ls, reading logs, running only commands named in the brief).
- Stay on the brief: do not expand the scope.
- Return a result usable without your session: facts, paths, commands, conclusions.

Format: short report (up to 15 lines) + a list of facts with paths/links.`,
  },
};

export const SUBAGENT_IDS = Object.keys(SUBAGENTS);

// --- user subagents: ~/.granka/subagents/*.md ---------------------------
// Frontmatter: name, description, tools (comma list), thinking.
// The body is the system prompt. The model is always inherited from the
// parent dialog (user rule) — a `model:` field is parsed but ignored.
// A file with a bad name or empty body is skipped with a warning, never fatal.
import fs from "node:fs";
import path from "node:path";

const KNOWN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "web_search", "web_fetch", "memory_write"]);
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function parseSubagentFile(text, id) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text ?? ""));
  if (!match) return { ok: false, error: "нет frontmatter (--- блок)" };
  const fields = {};
  for (const line of match[1].split("\n")) {
    const kv = /^([a-zA-Z_]+):\s*(.*)$/.exec(line.trim());
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  const body = match[2].trim();
  if (!body) return { ok: false, error: "пустое тело (системный промпт)" };
  const tools = (fields.tools ?? "read").split(",").map((t) => t.trim()).filter((t) => KNOWN_TOOLS.has(t));
  if (!tools.length) return { ok: false, error: "нет известных инструментов в tools:" };
  const thinking = THINKING_LEVELS.has(fields.thinking) ? fields.thinking : "low";
  return {
    ok: true,
    def: {
      id,
      name: fields.name || id,
      description: fields.description || id,
      tools,
      thinking,
      systemPrompt: body,
      custom: true,
    },
  };
}

export function loadCustomSubagents(agentDir) {
  const dir = path.join(agentDir, "subagents");
  const out = {};
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return out;
  }
  for (const file of files) {
    const id = file.replace(/\.md$/, "");
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) continue;
    if (SUBAGENTS[id]) continue; // builtin wins over a same-named file
    let parsed;
    try {
      parsed = parseSubagentFile(fs.readFileSync(path.join(dir, file), "utf8"), id);
    } catch (err) {
      console.error(`[granka subagents] ${file}: ${err.message}`);
      continue;
    }
    if (!parsed.ok) {
      console.error(`[granka subagents] ${file}: ${parsed.error}`);
      continue;
    }
    out[id] = parsed.def;
  }
  return out;
}

export function getSubagents(agentDir) {
  return { ...SUBAGENTS, ...(agentDir ? loadCustomSubagents(agentDir) : {}) };
}

export function subagentList(agentDir) {
  const all = getSubagents(agentDir);
  return Object.values(all).map((def) => ({
    id: def.id,
    name: def.name,
    description: def.description,
    tools: def.tools,
    custom: Boolean(def.custom),
  }));
}
