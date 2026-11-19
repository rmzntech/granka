// granka agent core: embeds the Pi SDK in its own home directory (~/.granka).
// No Electron imports here, so it can be smoke-tested with plain node.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { syncSystemPrompt } from "./prompt-template.mjs";
import { createGrankaTools, drainBackgroundResults, listBackgroundTasks as listTasksImpl, cancelBackgroundTask as cancelTaskImpl } from "./tools.mjs";
import { createDocTools, assertNotSensitive } from "./docs.mjs";
import { writeFileAtomic } from "./atomic-write.mjs";
import { MODEL_LEVELS, acceptsText, textOf, usageOf } from "./agent-utils.mjs";

export { acceptsText };

export const AGENT_DIR = path.join(os.homedir(), ".granka");
export const SESSION_DIR = path.join(AGENT_DIR, "sessions");
const CONFIG_FILE = path.join(AGENT_DIR, "granka.json");
const SYSTEM_RULES_FILE = path.join(AGENT_DIR, "SYSTEM.md"); // replaces pi's system prompt
export const PROMPTS_DIR = path.join(AGENT_DIR, "prompts"); // files become /slash commands
export const SKILLS_DIR = path.join(AGENT_DIR, "skills");
const DEFAULT_CONFIG = {
  apiKey: "",
  model: "anthropic/claude-sonnet-4.5",
  thinkingLevel: "medium",
  theme: "auto",
  cwd: "",
  favorites: [],
  projects: [], // [{ id, name, cwd, instructions }]
  activeProject: "",
  // preferences surfaced in the settings window
  settingsPane: "general",
  fontSize: "m",
  accentSystem: false,
  showUsage: true,
  sendOnEnter: true,
  autoScroll: true,
  osNotifications: true,
  continueLast: true,
  // granka's own tools
  toolTodo: true,
  toolAsk: true,
  toolWeb: true,
  toolSubagents: true,
  toolGit: true,
  planMode: false,
  agentMode: "chat", // chat | plan | auto | debug (Claude Code style permission modes)
  confirmBashWrite: "ask", // ask = confirm bash/write/edit/doc writes; allow = always allow
  bashAllowlist: [], // bash commands (by prefix) allowed without confirmation
  toolDisplay: "live",
  hooks: {}, // { toolName: "shell command after the tool finishes" }
  dailyBudgetUsd: 0, // 0 = off; warn in chat when today's spend passes this
  mcpServers: {}, // { name: { command, args, env, disabled? } } — stdio MCP servers
  mcpEnabled: true, // master switch: off = no MCP process ever starts
  searxUrl: "",
  debugTools: false,
  toolDocs: true,
  compactionEnabled: true,
  compactionReserve: 16384,
  compactionThreshold: 80, // percent of the context window that triggers idle compaction
  attachMaxMb: 25,
  backgroundImage: "",
  backgroundBlur: 0,
  backgroundDim: 35,
  backgroundNoise: 0,
  backgroundOpacity: 100,
  backgroundFit: "cover",
  uiFont: "theme",
  codeFont: "theme",
  cacheRetentionLong: true,
  memoryEnabled: true, // load global + project memory into each session
  toolOutputLimit: 16000,
  pinnedSessions: [],
  sessionSort: "recent",
  density: "comfortable",
  onboarded: false,
  autoTitle: true,
};

let pi; // pi SDK, imported in init() after env isolation
let runtime;
let session;
// Thinking duration per session id (in-memory: the SDK session file does
// not store it, so it only survives while the session stays loaded).
const thinkingMsBySession = new Map();
let appliedKey;
let sessionsById = new Map();
let pending = { kind: "recent" }; // recent | new | open
let uiBridge = { askUser: async () => "", emit: () => {} };
// Tools the user has confirmed for the current session ("always allow" in
// the confirmation dialog). Cleared with the session.
const sessionConfirmedTools = new Set();

// The renderer answers structured questions and receives tool notices.
export function setUiBridge(bridge) {
  uiBridge = { ...uiBridge, ...bridge };
}

export async function init() {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  syncSystemPrompt(AGENT_DIR);
  installBundledSkills();
  // Must happen before the SDK is imported: pi resolves its config dir on load.
  process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
  process.env.PI_SKIP_VERSION_CHECK = "1";
  process.env.PI_TELEMETRY = "0";
  if (loadConfig().cacheRetentionLong !== false) process.env.PI_CACHE_RETENTION = "long";
  pi = await import("@earendil-works/pi-coding-agent");
}

const CONFIG_VERSION = 6;

// MEMORY.md is user notes (volatile), AGENTS.md is rules (stable). They must
// not be merged: merged memory rots inside rules forever. Memory is appended
// per session in createSession instead; nothing to migrate here.

function readProjectMap() {
  try {
    const raw = JSON.parse(fs.readFileSync(PROJECTS_MAP_FILE, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function writeProjectMap(map) {
  fs.mkdirSync(AGENT_DIR, { recursive: true });
  writeFileAtomic(PROJECTS_MAP_FILE, JSON.stringify(map, null, 2) + "\n");
}

export function projectOfSession(sessionId) {
  return readProjectMap()[sessionId] ?? "";
}

// Public helper: move one chat to another project (used by tests and the UI).
export function assignSessionToProject(sessionId, projectId) {
  bindSessionProject(sessionId, projectId ?? "");
  return { ok: true };
}

function bindSessionProject(sessionId, projectId) {
  const map = readProjectMap();
  if ((map[sessionId] ?? "") === (projectId ?? "")) return;
  map[sessionId] = projectId ?? "";
  writeProjectMap(map);
}

function unbindSessionProject(sessionId) {
  const map = readProjectMap();
  if (!(sessionId in map)) return;
  delete map[sessionId];
  writeProjectMap(map);
}

// Old sessions predate the map: assign them once by folder, then keep it.
function backfillProjectMap(infos, cfg = loadConfig()) {
  const map = readProjectMap();
  const projects = cfg.projects ?? [];
  let changed = false;
  for (const info of infos) {
    if (info.id in map) continue;
    const cwd = (info.cwd || "").replace(/\\/g, "/").toLowerCase();
    const match = cwd
      ? projects.find((project) => (project.cwd || "").replace(/\\/g, "/").toLowerCase() === cwd)
      : undefined;
    map[info.id] = match?.id ?? "";
    changed = true;
  }
  if (changed) writeProjectMap(map);
  return map;
}

export function appPaths() {
  return { agentDir: AGENT_DIR, home: os.homedir(), platform: process.platform, sep: path.sep };
}

export function loadConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    const cfg = { ...DEFAULT_CONFIG, ...saved };
    if (saved.configVersion !== CONFIG_VERSION) {
      // v2–v4: themes own their accent (system accent is opt-in), style presets gone
      if (!saved.configVersion || saved.configVersion < 4) cfg.accentSystem = false;
      // v5: bundled Inter is the default face (system fallback was unreadable on Windows)
      if (!saved.configVersion || saved.configVersion < 5) {
        if (!saved.uiFont || saved.uiFont === "system") cfg.uiFont = "inter";
      }
      // v6: themes own the typeface again — a fixed uiFont made every brand
      // theme (Dell serif, OpenCode mono, IBM Plex) look identical.
      if (!saved.configVersion || saved.configVersion < 6) {
        cfg.uiFont = "theme";
        cfg.codeFont = "theme";
      }
      delete cfg.styleMode;
      delete cfg.styleLevel;
      cfg.configVersion = CONFIG_VERSION;
      saveConfig(cfg);
    }
    return cfg;
  } catch (err) {
    // A missing file is normal on first run; a corrupt one is not — back it
    // up instead of silently falling back to defaults and losing settings.
    if (fs.existsSync(CONFIG_FILE)) {
      console.error("[granka] config unreadable, backing up:", err?.message ?? err);
      try {
        fs.copyFileSync(CONFIG_FILE, `${CONFIG_FILE}.bak-${Date.now()}`);
      } catch (backupErr) {
        console.error("[granka] config backup failed:", backupErr?.message ?? backupErr);
      }
    }
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(AGENT_DIR, { recursive: true });
  writeFileAtomic(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

// The Pi catalog is a static snapshot frozen at the Pi release; without a
// network refresh it never learns new models or fresh prices. allowModel-
// Network lets the runtime pull the pi.dev catalog and personalize it via
// OpenRouter /models/user (key-scoped models, limits, prices), cached in
// models-store.json with the built-in catalog as the offline fallback.
const CATALOG_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
let lastCatalogRefresh = 0;

async function getRuntime() {
  if (!runtime) {
    runtime = await pi.ModelRuntime.create({
      authPath: path.join(AGENT_DIR, "auth.json"),
      modelsPath: path.join(AGENT_DIR, "models.json"),
      allowModelNetwork: true,
      modelRefreshTimeoutMs: 8000,
    });
    lastCatalogRefresh = Date.now();
    // The key lives in granka.json until syncKey runs at session start, but
    // the catalog refresh resolves no credential — and makes no network
    // request at all — without one. Sync it now so the personalized
    // catalog (pi.dev + /models/user) can actually refresh on startup.
    // A bad key must not break runtime creation: log and keep the cached
    // catalog; session start will surface the sync error properly.
    try { await syncKey(runtime, loadConfig()); } catch (err) { console.error("[granka]", err?.message ?? err); }
    try { await runtime.refresh({ signal: AbortSignal.timeout(8000) }); } catch (err) { console.error("[granka] catalog refresh failed:", err?.message ?? err); }
    lastCatalogRefresh = Date.now();
  }
  return runtime;
}

// Pi refreshes the personalized OpenRouter catalog on every rt.refresh(),
// so throttle it here: at most once an hour, except after a key change
// (personalization is key-scoped). Fire-and-forget: the caller reads the
// current snapshot; the fresh catalog lands on the next listModels call.
function refreshCatalog(rt, force = false) {
  const now = Date.now();
  if (!force && now - lastCatalogRefresh < CATALOG_REFRESH_INTERVAL_MS) return;
  lastCatalogRefresh = now;
  void rt
    .refresh()
    .catch((err) => console.error("[granka] catalog refresh failed:", err?.message ?? err));
}

// The runtime key is a non-persistent overlay: granka.json is the source of
// truth, the runtime is re-synced from it. Never trust the appliedKey cache
// alone — if the runtime lost its credential (recreated runtime, failed
// write), appliedKey would keep the stale value and every request would
// fail with a login error until restart. Heal by checking the runtime.
async function syncKey(rt, cfg) {
  const key = String(cfg.apiKey ?? "").trim();
  if (!key) {
    if (appliedKey) {
      try { await rt.removeRuntimeApiKey("openrouter"); } catch (err) { console.error("[granka]", err?.message ?? err); }
      appliedKey = "";
    }
    return;
  }
  const runtimeHasAuth = typeof rt.hasConfiguredAuth === "function"
    ? rt.hasConfiguredAuth("openrouter")
    : true;
  if (key === appliedKey && runtimeHasAuth) return;
  try {
    await rt.setRuntimeApiKey("openrouter", key);
    appliedKey = key;
  } catch (err) {
    appliedKey = ""; // force a retry on the next sync instead of caching the failure
    throw err;
  }
}

// (MODEL_LEVELS/acceptsText/textOf/usageOf live in agent-utils.mjs)

// Catalog with the thinking levels each model actually supports: `thinkingLevelMap`
// marks a level as unsupported with null, non-reasoning models only have "off".
export async function listModels() {
  const rt = await getRuntime();
  refreshCatalog(rt);
  return rt
    .getAllModels("openrouter")
    .filter(acceptsText)
    .map((m) => {
      const levels = m.reasoning
        ? MODEL_LEVELS.filter((level) => m.thinkingLevelMap?.[level] !== null)
        : ["off"];
      return {
        id: m.id,
        levels: levels.length ? levels : ["off"],
        context: m.contextWindow,
        maxTokens: m.maxTokens,
        cost: m.cost ? { input: m.cost.input, output: m.cost.output } : null,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

// Save settings from the UI and apply them to the live session.
// Config saves are serialized: settings debounces keystrokes into saveConfig
// calls, and two concurrent applyConfig runs can otherwise interleave
// load→save and persist a stale/partial value (e.g. half-typed API key).
let configQueue = Promise.resolve();

export function applyConfig(patch) {
  const run = configQueue.then(() => applyConfigNow(patch));
  configQueue = run.catch(() => {});
  return run;
}

// IPC arguments are untrusted: only these keys may ever be written via
// config:save. `projects`/`configVersion` are owned by their own handlers.
const CONFIG_WHITELIST = new Set([
  "apiKey", "model", "thinkingLevel", "theme", "cwd", "favorites", "activeProject",
  "fontSize", "accentSystem", "showUsage", "sendOnEnter", "autoScroll", "osNotifications",
  "continueLast", "toolTodo", "toolAsk", "toolWeb", "toolSubagents", "toolGit", "toolDocs",
  "planMode", "agentMode", "confirmBashWrite", "bashAllowlist", "toolDisplay", "thinkingDisplay", "hooks", "dailyBudgetUsd",
  "mcpServers", "mcpEnabled", "searxUrl", "debugTools", "compactionEnabled",
  "compactionReserve", "compactionThreshold", "attachMaxMb", "uiFont", "codeFont", "cacheRetentionLong",
  "toolOutputLimit", "pinnedSessions", "sessionSort", "density", "onboarded", "autoTitle", "memoryEnabled", "settingsPane",
  "backgroundImage", "backgroundBlur", "backgroundDim", "backgroundNoise", "backgroundOpacity", "backgroundFit",
]);

function sanitizeConfigPatch(patch) {
  const clean = {};
  for (const [key, value] of Object.entries(patch && typeof patch === "object" ? patch : {})) {
    if (CONFIG_WHITELIST.has(key)) clean[key] = value;
  }
  // hooks/mcpServers are shell commands by design (user-owned settings):
  // validate their shape so a stray patch cannot smuggle arbitrary types.
  if (clean.hooks !== undefined) {
    if (!clean.hooks || typeof clean.hooks !== "object" || Array.isArray(clean.hooks)) return null;
    for (const v of Object.values(clean.hooks)) if (typeof v !== "string") return null;
  }
  if (clean.mcpServers !== undefined) {
    if (!clean.mcpServers || typeof clean.mcpServers !== "object" || Array.isArray(clean.mcpServers)) return null;
    for (const s of Object.values(clean.mcpServers)) {
      if (!s || typeof s !== "object" || typeof s.command !== "string" || !s.command) return null;
      if (s.args !== undefined && !Array.isArray(s.args)) return null;
      if (s.env !== undefined && (typeof s.env !== "object" || Array.isArray(s.env))) return null;
      if (s.disabled !== undefined && typeof s.disabled !== "boolean") return null;
    }
  }
  return clean;
}

export { sanitizeConfigPatch };

async function applyConfigNow(patch) {
  try {
    const before = loadConfig();
    const clean = sanitizeConfigPatch(patch);
    if (clean === null) return { ok: false, error: "недопустимый формат настроек (hooks/mcpServers)" };
    const cfg = { ...before, ...clean };
    const rt = await getRuntime();
    // Validate before persisting: a rejected patch must not reach the disk
    // or the runtime (previously the file was written first and the UI
    // reported failure while the new key was already saved).
    if (cfg.model && cfg.model !== before.model && !rt.getModel("openrouter", cfg.model)) {
      return { ok: false, error: `неизвестная модель: ${cfg.model}` };
    }
    saveConfig(cfg);
    // Verify the write landed: without this, a failed/partial write looks
    // exactly like "key does not save" in the UI.
    const persisted = loadConfig();
    if ((persisted.apiKey ?? "") !== (cfg.apiKey ?? "")) {
      return { ok: false, error: "ключ не записался на диск" };
    }
    await syncKey(rt, cfg);
    // A new key re-scopes the personalized catalog (/models/user): refresh
    // it immediately instead of waiting for the hourly throttle.
    if ((cfg.apiKey ?? "") !== (before.apiKey ?? "")) refreshCatalog(rt, true);
    // A new key does not help a session that was created with the old
    // credential cached: drop it so the next prompt rebuilds it with the
    // fresh runtime key. Same for a working-folder change.
    if (
      cfg.cwd !== before.cwd ||
      (cfg.apiKey ?? "") !== (before.apiKey ?? "") ||
      Boolean(cfg.planMode) !== Boolean(before.planMode) ||
      (cfg.agentMode ?? "chat") !== (before.agentMode ?? "chat")
    ) {
      await dropSession();
      // A session file created under another mode keeps that mode's tool set
      // when reopened, so a mode change must start a fresh session.
      pending = { kind: "new" };
    }
    if (session) {
      if (cfg.model && cfg.model !== before.model) {
        await session.setModel(rt.getModel("openrouter", cfg.model));
      }
      if (cfg.thinkingLevel && cfg.thinkingLevel !== before.thinkingLevel) {
        session.setThinkingLevel(cfg.thinkingLevel);
      }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

// --- rules (system prompt / agent instructions) -----------------------------

function readIfExists(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}


// --- projects --------------------------------------------------------------

function activeProject(cfg = loadConfig()) {
  return (cfg.projects ?? []).find((p) => p.id === cfg.activeProject) ?? null;
}

// The project layer is a real AGENTS.md inside the project folder: the same
// file other agents read. Projects without a folder keep it in granka.json.
export function projectAgentsPath(project) {
  return project?.cwd ? path.join(project.cwd, "AGENTS.md") : "";
}

function readProjectAgents(project) {
  if (!project) return { path: "", text: "", exists: false };
  const file = projectAgentsPath(project);
  if (file) {
    const text = readIfExists(file);
    if (text.trim()) return { path: file, text, exists: true };
  }
  return { path: file, text: project.instructions ?? "", exists: false };
}

export function getProjectRules(id) {
  const project = (loadConfig().projects ?? []).find((item) => item.id === id);
  if (!project) return { ok: false, error: "проект не найден" };
  return { ok: true, ...readProjectAgents(project) };
}

// Rules for an arbitrary folder (used when the user re-points a project at a
// new folder: the editor must show THAT folder's AGENTS.md, not the old one).
export function rulesForPath(dirPath) {
  const dir = String(dirPath ?? "").trim();
  if (!dir) return { ok: true, path: "", text: "", exists: false };
  const file = path.join(dir, "AGENTS.md");
  const text = readIfExists(file);
  return { ok: true, path: file, text: text.trim() ? text : "", exists: Boolean(text.trim()) };
}

export async function saveProjectRules(id, text) {
  const cfg = loadConfig();
  const projects = [...(cfg.projects ?? [])];
  const index = projects.findIndex((item) => item.id === id);
  if (index < 0) return { ok: false, error: "проект не найден" };
  const project = { ...projects[index], instructions: String(text ?? "") };
  const file = projectAgentsPath(project);
  try {
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, project.instructions);
    }
    projects[index] = project;
    saveConfig({ ...cfg, projects });
    await dropSession();
    pending = { kind: "recent" };
    return { ok: true, path: file, exists: Boolean(file) };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

// --- memory (volatile user notes, separate from AGENTS.md rules) ----------
// Global memory: ~/.granka/MEMORY.md. Project memory: ~/.granka/memory/<id>.md
// (outside the repo: never committed by accident, survives folder moves).
// Loaded per session capped like Claude Code auto memory: 200 lines / 25 KB.
const MEMORY_DIR = path.join(AGENT_DIR, "memory");
const MEMORY_MAX_LINES = 200;
const MEMORY_MAX_CHARS = 25 * 1024;

export function readMemoryCapped(file) {
  const text = readIfExists(file).trim();
  if (!text) return "";
  const lines = text.split("\n").slice(0, MEMORY_MAX_LINES).join("\n");
  return lines.length > MEMORY_MAX_CHARS ? lines.slice(0, MEMORY_MAX_CHARS) : lines;
}

function projectMemoryPath(id) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(id ?? ""))) return "";
  return path.join(MEMORY_DIR, `${id}.md`);
}

export function getMemory() {
  return { ok: true, path: MEMORY_FILE, text: readIfExists(MEMORY_FILE) };
}

export function saveMemory(text) {
  try {
    fs.mkdirSync(AGENT_DIR, { recursive: true });
    fs.writeFileSync(MEMORY_FILE, String(text ?? ""));
    return { ok: true, path: MEMORY_FILE };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

export function getProjectMemory(id) {
  const file = projectMemoryPath(id);
  if (!file) return { ok: false, error: "некорректный id проекта" };
  return { ok: true, path: file, text: readIfExists(file) };
}

export function saveProjectMemory(id, text) {
  const file = projectMemoryPath(id);
  if (!file) return { ok: false, error: "некорректный id проекта" };
  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    fs.writeFileSync(file, String(text ?? ""));
    return { ok: true, path: file };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

export function listBackgroundTasks() {
  return listTasksImpl();
}

export function cancelBackgroundTask(id) {
  return cancelTaskImpl(id);
}

export function listProjects() {
  const cfg = loadConfig();
  return { projects: cfg.projects ?? [], active: cfg.activeProject ?? "" };
}

export async function saveProject(project) {
  const cfg = loadConfig();
  const projects = [...(cfg.projects ?? [])];
  const previous = projects.find((item) => item.id === project.id);
  const entry = {
    id: project.id || `p${Date.now().toString(36)}`,
    name: String(project.name ?? "").trim() || "проект",
    cwd: String(project.cwd ?? "").trim(),
    instructions: String(project.instructions ?? ""),
    // a project carries its own working profile: model, thinking and answer style
    model: String(project.model ?? previous?.model ?? "").trim(),
    thinkingLevel: String(project.thinkingLevel ?? previous?.thinkingLevel ?? "").trim(),
  };
  const index = projects.findIndex((p) => p.id === entry.id);
  if (index >= 0) projects[index] = entry;
  else projects.push(entry);
  // the folder file wins over whatever came from the form
  const file = projectAgentsPath(entry);
  const fromFile = file ? readIfExists(file) : "";
  if (fromFile.trim()) {
    entry.instructions = fromFile;
    const at = projects.findIndex((p) => p.id === entry.id);
    projects[at] = entry;
  }
  saveConfig({ ...cfg, projects });
  return { ok: true, id: entry.id };
}

export async function deleteProject(id) {
  const cfg = loadConfig();
  const projects = (cfg.projects ?? []).filter((p) => p.id !== id);
  const activeProjectId = cfg.activeProject === id ? "" : cfg.activeProject;
  saveConfig({ ...cfg, projects, activeProject: activeProjectId });
  return { ok: true };
}

export async function activateProject(id) {
  const cfg = loadConfig();
  const project = (cfg.projects ?? []).find((p) => p.id === id);
  if (!project) return { ok: false, error: "проект не найден" };
  // Never inherit the previous project's folder: a project without a folder
  // runs in the agent home, not in someone else's directory.
  const patch = { ...cfg, activeProject: id, cwd: project.cwd || "" };
  if (project.model) patch.model = project.model;
  if (project.thinkingLevel) patch.thinkingLevel = project.thinkingLevel;
  saveConfig(patch);

  // Adopt history that predates projects: unbound chats living in the project
  // folder become this project's chats, so the sidebar stops mixing folders.
  if (project.cwd) {
    const infos = await pi.SessionManager.listAll(SESSION_DIR);
    const map = readProjectMap();
    const target = project.cwd.replace(/\\/g, "/").toLowerCase();
    for (const info of infos) {
      if ((map[info.id] ?? "") !== "") continue;
      const sessionCwd = (info.cwd || "").replace(/\\/g, "/").toLowerCase();
      if (sessionCwd === target) bindSessionProject(info.id, id);
    }
  }

  await dropSession();
  pending = { kind: "project", id }; // resume *this project's* last conversation
  return { ok: true, project };
}

// --- prompts & skills (slash commands) -------------------------------------

function firstLine(text) {
  return text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}

export function listPrompts() {
  let files = [];
  try {
    files = fs.readdirSync(PROMPTS_DIR).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  return files
    .map((file) => {
      const text = readIfExists(path.join(PROMPTS_DIR, file));
      const description = /^description:\s*(.+)$/m.exec(text)?.[1] ?? firstLine(text);
      return { name: `/${file.replace(/\.md$/, "")}`, description: description.slice(0, 100) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function skillsDetailed() {
  const dir = SKILLS_DIR;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return [];
  }
  const skills = [];
  for (const entry of entries) {
    const skillFile = path.join(dir, entry.name, "SKILL.md");
    const text = readIfExists(skillFile);
    if (!text) continue;
    const files = fs.readdirSync(path.join(dir, entry.name)).length;
    skills.push({
      folder: entry.name,
      name: /^name:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? entry.name,
      description: (/^description:\s*(.+)$/m.exec(text)?.[1] ?? firstLine(text)).trim().slice(0, 300),
      path: path.join(dir, entry.name),
      files,
      bundled: text.includes("granka-bundled:"),
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function deleteSkill(folder) {
  const target = path.resolve(SKILLS_DIR, String(folder ?? ""));
  const rel = path.relative(path.resolve(SKILLS_DIR), target);
  if (!rel || rel.startsWith(`..${path.sep}`) || rel === ".." || path.isAbsolute(rel)) {
    return { ok: false, error: "недопустимый путь" };
  }
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

// Skills shipped with the app live in electron/skills/<folder>/SKILL.md.
export function installBundledSkills() {
  const sourceDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "skills");
  let installed = [];
  let skipped = [];
  try {
    const entries = fs.readdirSync(sourceDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
    for (const entry of entries) {
      const from = path.join(sourceDir, entry.name, "SKILL.md");
      const text = readIfExists(from);
      if (!text) continue;
      const version = /granka-bundled:\s*v(\d+)/.exec(text)?.[1] ?? "1";
      const targetDir = path.join(SKILLS_DIR, entry.name);
      const target = path.join(targetDir, "SKILL.md");
      const existing = readIfExists(target);
      if (existing && !existing.includes("granka-bundled:")) {
        skipped.push({ folder: entry.name, reason: "изменён вручную" });
        continue;
      }
      const existingVersion = /granka-bundled:\s*v(\d+)/.exec(existing)?.[1] ?? "0";
      if (existing && Number(existingVersion) >= Number(version)) continue;
      fs.mkdirSync(targetDir, { recursive: true });
      fs.copyFileSync(from, target);
      installed.push(entry.name);
    }
  } catch (err) { console.error("[granka]", err?.message ?? err); }
  return { ok: true, installed, skipped };
}

export function listSkills() {
  let entries = [];
  try {
    entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return [];
  }
  const skills = [];
  for (const entry of entries) {
    const text = readIfExists(path.join(SKILLS_DIR, entry.name, "SKILL.md"));
    if (!text) continue;
    const name = /^name:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? entry.name;
    const description = /^description:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? firstLine(text);
    skills.push({ name, description: description.slice(0, 120) });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

// --- session lifecycle -----------------------------------------------------

// Sessions are global state: creation must not race. ensureSession is
// queued so two concurrent prompts cannot build two sessions and drop one.
let sessionQueue = Promise.resolve();

function withSessionLock(fn) {
  const run = sessionQueue.then(fn);
  sessionQueue = run.catch(() => {});
  return run;
}

async function dropSession() {
  const current = session;
  session = undefined; // clear first: a concurrent ensureSession must not reuse it
  sessionConfirmedTools.clear();
  if (!current) return;
  try {
    await current.abort();
  } catch (err) {
    console.error("[granka] dropSession:", err?.message ?? err);
  }
  try {
    current.dispose();
  } catch (err) {
    console.error("[granka] dropSession dispose:", err?.message ?? err);
  }
}

export async function newSession() {
  await dropSession();
  pending = { kind: "new" };
  return { ok: true };
}

export async function openSession(id) {
  const info = sessionsById.get(id);
  if (!info) return { ok: false, error: "сессия не найдена" };
  // Opening a foreign chat also switches the active project, so the titlebar,
  // the sidebar scope and the chat itself always describe the same project.
  const projectId = projectOfSession(id);
  const cfg = loadConfig();
  if ((cfg.activeProject ?? "") !== projectId) {
    const project = (cfg.projects ?? []).find((item) => item.id === projectId);
    saveConfig({
      ...cfg,
      activeProject: projectId,
      cwd: project ? project.cwd || "" : cfg.cwd,
      ...(project?.model ? { model: project.model } : {}),
      ...(project?.thinkingLevel ? { thinkingLevel: project.thinkingLevel } : {}),
    });
  }
  await dropSession();
  pending = { kind: "open", id };
  return { ok: true, projectId };
}

// One definition of "this session belongs to this folder" so the sidebar
// cannot drift from the project scope.
export function sessionInScope(sessionCwd, scope, fallback = AGENT_DIR) {
  const normalize = (value) => path.resolve(value || fallback).replace(/\\/g, "/").toLowerCase();
  if (!scope) return true;
  return normalize(sessionCwd) === normalize(scope);
}

// `query` searches the full text. `options.projectId` is the strict chat↔project
// filter: undefined = all sessions, "" = sessions without a project.
export async function listSessions(query = "", options = {}) {
  const cfg = loadConfig();
  const infos = await pi.SessionManager.listAll(SESSION_DIR);
  sessionsById = new Map(infos.map((info) => [info.id, info]));
  const projectMap = backfillProjectMap(infos, cfg);
  const needle = query.trim().toLowerCase();
  const scopeProject = options.projectId;
  return infos
    .filter((info) => scopeProject === undefined || (projectMap[info.id] ?? "") === scopeProject)
    .filter(
      (i) =>
        !needle ||
        (i.name ?? "").toLowerCase().includes(needle) ||
        i.firstMessage.toLowerCase().includes(needle) ||
        i.allMessagesText.toLowerCase().includes(needle),
    )
    .map((i) => ({
      id: i.id,
      title: (i.name || i.firstMessage || "без названия").replace(/\s+/g, " ").slice(0, 70),
      modified: i.modified.toISOString(),
      cwd: i.cwd,
      projectId: projectMap[i.id] ?? "",
      messages: i.messageCount,
      // Context weight for the sidebar: per-message chars capped at the tool
      // output limit, because longer tool results never reach the model.
      weight: cappedSessionChars(i),
    }));
}

function cappedSessionChars(info) {
  const cap = Math.min(Math.max(Number(loadConfig().toolOutputLimit) || 16000, 500), 32000);
  try {
    return readSessionMessages(info.path).reduce(
      (sum, message) => sum + Math.min(String(message.text ?? "").length, cap),
      0,
    );
  } catch (err) {
    console.error("[granka] session weight:", err?.message ?? err);
    return info.allMessagesText?.length ?? 0;
  }
}

function readSessionMessages(sessionPath) {
  const lines = fs.readFileSync(sessionPath, "utf8").split("\n");
  const messages = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = entry?.message ?? entry?.data?.message;
    if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
    const text = textOf(message);
    if (text.trim()) messages.push({ role: message.role, text, ts: message.timestamp ?? entry.timestamp });
  }
  return messages;
}

// Markdown export of one or more sessions.
export function exportSessions(ids = []) {
  const list = Array.isArray(ids) ? ids : [ids];
  const parts = [];
  for (const id of list) {
    const info = sessionsById.get(id);
    if (!info) continue;
    const title = info.name || info.firstMessage || "без названия";
    parts.push(`# ${title}\n\n_${new Date(info.modified).toLocaleString("ru-RU")}_\n`);
    for (const message of readSessionMessages(info.path)) {
      parts.push(`## ${message.role === "user" ? "Вы" : "granka"}\n\n${message.text}\n`);
    }
    parts.push("\n---\n");
  }
  return { ok: true, text: parts.join("\n") };
}

export function revealSession(id) {
  const info = sessionsById.get(id);
  return info ? { ok: true, path: info.path } : { ok: false, error: "сессия не найдена" };
}

export async function duplicateSession(id) {
  const info = sessionsById.get(id);
  if (!info) return { ok: false, error: "сессия не найдена" };
  const cwd = info.cwd || AGENT_DIR;
  const manager = pi.SessionManager.forkFrom(info.path, cwd, SESSION_DIR);
  const newId = manager.getSessionId();
  bindSessionProject(newId, projectOfSession(id));
  return { ok: true, id: newId };
}

// First message → title. Deterministic, local, applied exactly once:
// appendSessionInfo gives the session a name and later calls bow out.
export function titleFromText(text, maxWords = 7, maxChars = 60) {
  const clean = String(text ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[Вложения сессии[\s\S]*$/m, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[`*_>#|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "";
  let title = clean.split(" ").filter(Boolean).slice(0, maxWords).join(" ");
  if (title.length > maxChars) title = title.slice(0, maxChars).trimEnd();
  title = title.replace(/[\s,;:—–-]+$/, "");
  if (!title) return "";
  return title.charAt(0).toUpperCase() + title.slice(1);
}

export async function autoTitle(sessionId) {
  const cfg = loadConfig();
  if (cfg.autoTitle === false) return { ok: false, error: "автозаголовки выключены" };
  const info = sessionsById.get(sessionId);
  if (!info) return { ok: false, error: "сессия не найдена в индексе" };
  if (info.name) return { ok: false, error: "у сессии уже есть имя" };

  const firstUser =
    readSessionMessages(info.path).find((message) => message.role === "user")?.text ?? info.firstMessage;
  const title = titleFromText(firstUser);
  if (!title) return { ok: false, error: "нет текста для заголовка" };

  const manager =
    session && session.sessionManager.getSessionId() === sessionId
      ? session.sessionManager
      : pi.SessionManager.open(info.path, SESSION_DIR, info.cwd || AGENT_DIR);
  manager.appendSessionInfo(title);
  return { ok: true, title };
}

export async function renameSession(id, name) {
  const title = String(name ?? "").trim();
  if (!title) return { ok: false, error: "пустое имя" };
  if (session && session.sessionManager.getSessionId() === id) {
    session.sessionManager.appendSessionInfo(title);
  } else {
    const info = sessionsById.get(id);
    if (!info) return { ok: false, error: "сессия не найдена" };
    pi.SessionManager.open(info.path, SESSION_DIR, info.cwd).appendSessionInfo(title);
  }
  return { ok: true };
}

export async function deleteSession(id) {
  const info = sessionsById.get(id);
  if (!info) return { ok: false, error: "сессия не найдена" };
  if (session && session.sessionManager.getSessionId() === id) await dropSession();
  fs.rmSync(info.path, { force: true });
  sessionsById.delete(id);
  unbindSessionProject(id);
  return { ok: true };
}

function ensureSession() {
  return withSessionLock(ensureSessionNow);
}

async function ensureSessionNow() {
  if (session) return session;
  const cfg = loadConfig();
  const rt = await getRuntime();
  await syncKey(rt, cfg);

  // Sessions carry their project in our own map; the folder is only a fallback
  // for history created before projects existed.
  const infos = await pi.SessionManager.listAll(SESSION_DIR);
  sessionsById = new Map(infos.map((info) => [info.id, info]));
  const projectMap = backfillProjectMap(infos, cfg);
  const activeProjectId = cfg.activeProject ?? "";
  const mostRecentOfProject = (projectId) => {
    const candidates = infos
      .filter((info) => (projectMap[info.id] ?? "") === projectId)
      .sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
    return candidates[0];
  };

  let cwd = cfg.cwd || AGENT_DIR;
  let manager;
  let created = false;
  let bindTo = activeProjectId;

  if (pending.kind === "open") {
    const info = sessionsById.get(pending.id);
    if (info) {
      cwd = info.cwd || cwd;
      bindTo = projectMap[info.id] ?? activeProjectId;
      manager = pi.SessionManager.open(info.path, SESSION_DIR, cwd);
    } else {
      created = true;
      manager = pi.SessionManager.create(cwd, SESSION_DIR);
    }
  } else if (pending.kind === "project") {
    bindTo = pending.id;
    const last = mostRecentOfProject(pending.id);
    if (last) {
      cwd = last.cwd || cwd;
      manager = pi.SessionManager.open(last.path, SESSION_DIR, cwd);
    } else {
      created = true;
      manager = pi.SessionManager.create(cwd, SESSION_DIR);
    }
  } else if (pending.kind === "new") {
    created = true;
    manager = pi.SessionManager.create(cwd, SESSION_DIR);
  } else {
    const last = cfg.continueLast === false ? undefined : mostRecentOfProject(activeProjectId);
    if (last) {
      cwd = last.cwd || cwd;
      manager = pi.SessionManager.open(last.path, SESSION_DIR, cwd);
    } else {
      created = true;
      manager = pi.SessionManager.create(cwd, SESSION_DIR);
    }
  }
  pending = { kind: "recent" };

  // toolExecution parallel: independent calls in one block run together;
  // same-file writes serialize (SDK queue for edit/write, per-file lock for
  // doc tools — see installFileLocks).
  const options = { cwd, modelRuntime: rt, sessionManager: manager, toolExecution: "parallel" };
  const project = activeProject(cfg);
  const append = [];
  // Plan mode: the agent can read and investigate but cannot change anything.
  // Write-capable tools are excluded at the session level, not just via prompt.
  const effectivePlan = cfg.planMode || cfg.agentMode === "plan";
  if (effectivePlan) {
    options.excludedToolNames = ["write", "edit", "edit_fuzzy", "bash", "doc_create", "doc_edit", "doc_format"];
    append.push(
      "## Plan mode\n" +
        "You are in plan mode: read and investigate only. No edits, no state-changing commands. " +
        "Produce a plan (steps, files, risks, verification) and stop — wait for the user's confirmation.",
    );
  }
  // Project AGENTS.md is loaded by the SDK as a context file (global, then every
  // ancestor up to cwd). Appending it again here would pay for it twice and
  // distort the precedence the system prompt declares. Only the granka.json
  // fallback (projects without a folder) needs the manual append.
  const projectRules = project ? readProjectAgents(project) : null;
  if (projectRules && !projectRules.exists && projectRules.text.trim()) {
    append.push(`## Project instructions (granka.json)\n${projectRules.text.trim()}`);
  }
  // Memory is volatile user notes (agent- or user-written), never merged into
  // AGENTS.md rules. Rules win over memory; memory is capped per file.
  if (cfg.memoryEnabled !== false) {
    const memory = readMemoryCapped(MEMORY_FILE);
    if (memory) append.push(`## User memory (notes, may be outdated; AGENTS.md rules win)\n${memory}`);
    const projectMemoryFile = project ? projectMemoryPath(project.id) : "";
    const projectMemory = projectMemoryFile ? readMemoryCapped(projectMemoryFile) : "";
    if (projectMemory) append.push(`## Project memory (notes, may be outdated; AGENTS.md rules win)\n${projectMemory}`);
  }
  // Always pass the loader explicitly: an explicit systemPrompt path blocks a
  // project-local .pi/SYSTEM.md from replacing the app's prompt, and a
  // provided (even empty) append list blocks a project APPEND_SYSTEM.md.
  const loader = new pi.DefaultResourceLoader({
    cwd,
    agentDir: AGENT_DIR,
    systemPrompt: SYSTEM_RULES_FILE,
    appendSystemPrompt: append,
  });
  await loader.reload();
  options.resourceLoader = loader;
  const model = cfg.model && rt.getModel("openrouter", cfg.model);
  if (model) {
    options.model = model;
  } else {
    // Never let the SDK pick its own provider default (moonshotai/kimi-k2.7-code
    // for OpenRouter): it is a paid model the user did not choose.
    const fallback = rt.getAllModels("openrouter").filter(acceptsText)[0];
    if (fallback) {
      console.warn(`[granka] model ${cfg.model ?? "(none)"} unavailable, using ${fallback.id}`);
      options.model = fallback;
    }
  }

  const tools = createGrankaTools({
    getPi: () => pi,
    getRuntime: () => rt,
    getConfig: () => loadConfig(),
    getCwd: () => cwd,
    getAgentDir: () => AGENT_DIR,
    recordUsage: (sessionId, modelId, usage) => recordUsage(sessionId, modelId, usage),
    askUser: (question) => uiBridge.askUser(question),
    emit: (notice) => uiBridge.emit(notice),
  });
  const enabled = [];
  if (cfg.toolTodo !== false) enabled.push(tools.todoTool);
  if (cfg.toolAsk !== false && cfg.agentMode !== "auto") enabled.push(tools.askTool);
  if (cfg.toolWeb !== false) enabled.push(tools.webSearchTool, tools.webFetchTool);
  if (cfg.toolSubagents !== false) enabled.push(withTimeout(tools.subagentTool));
  if (cfg.toolGit !== false) enabled.push(tools.statusTool, tools.diffTool, withTimeout(tools.repoMapTool));
  if (cfg.memoryEnabled !== false) enabled.push(tools.memoryTool);
  enabled.push(tools.fuzzyEditTool);
  if (cfg.mcpEnabled !== false && cfg.mcpServers && Object.keys(cfg.mcpServers).length) {
    // Lazy MCP: proxies come from the on-disk schema cache, so no server
    // spawns at session start. First use (mcp_search or a proxy call) starts
    // the server and refreshes the cache. A never-seen server connects once
    // here so its proxies exist at all.
    const mcp = await import("./mcp.mjs");
    const cache = mcp.readMcpCache();
    const missing = Object.keys(cfg.mcpServers).filter((name) => !cache[name]?.length);
    if (missing.length) await mcp.refreshMcpCache(cfg.mcpServers, missing);
    enabled.push(mcp.mcpSearchTool(cfg.mcpServers));
    enabled.push(...mcp.mcpProxyTools(cfg.mcpServers, mcp.readMcpCache()));
  }
  if (cfg.toolDocs !== false) {
    const docTools = createDocTools({
      resolve: (p) => assertNotSensitive(path.resolve(cwd, p)),
      emit: (notice) => uiBridge.emit(notice),
    });
    enabled.push(
      withTimeout(docTools.outlineTool),
      withTimeout(docTools.readTool),
      withTimeout(docTools.searchTool),
      withTimeout(docTools.createTool),
      withTimeout(docTools.editTool),
      withTimeout(docTools.formatTool),
      withTimeout(docTools.batchTool),
    );
  }
  enabled.push(...sdkToolsWithTimeout(cwd));
  if (enabled.length) options.customTools = enabled;

  ({ session } = await pi.createAgentSession(options));
  const newId = session.sessionManager.getSessionId();
  if (created || !(newId in projectMap)) bindSessionProject(newId, bindTo);
  if (cfg.thinkingLevel) session.setThinkingLevel(cfg.thinkingLevel);
  installFileLocks(session);
  return session;
}

// Per-tool timeouts: an unbounded tool hangs the whole turn until the
// harness kills it minutes later, unexplained. SDK built-ins have no
// timeout API, so granka registers same-named wrapped copies (custom tools
// override built-ins by name in the SDK registry) — same definitions, same
// file-mutation queues, plus a deadline.
const TOOL_TIMEOUTS = {
  read: 60000,
  write: 60000,
  edit: 60000,
  grep: 60000,
  find: 60000,
  ls: 30000,
  bash: 180000, // backstop; the hook sets a 120s command timeout
  powershell: 180000,
  doc_outline: 60000,
  doc_read: 60000,
  doc_search: 60000,
  doc_create: 120000,
  doc_edit: 120000,
  doc_format: 120000,
  doc_batch: 180000,
  repo_map: 30000,
  task: 600000, // a subagent doing real work legitimately runs for minutes
};

function withTimeout(tool) {
  const ms = TOOL_TIMEOUTS[tool.name];
  if (!ms || typeof tool.execute !== "function") return tool;
  const execute = tool.execute;
  return {
    ...tool,
    execute: async (...args) => {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${tool.name}: превышен таймаут ${Math.round(ms / 1000)} с`)),
          ms,
        );
      });
      try {
        return await Promise.race([execute(...args), timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function sdkToolsWithTimeout(cwd) {
  const defs = [
    pi.createReadToolDefinition(cwd),
    pi.createWriteToolDefinition(cwd),
    pi.createEditToolDefinition(cwd),
    pi.createGrepToolDefinition(cwd),
    pi.createFindToolDefinition(cwd),
    pi.createLsToolDefinition(cwd),
    pi.createBashToolDefinition(cwd),
  ];
  if (process.platform === "win32") defs.push(pi.createPowerShellToolDefinition(cwd));
  return defs.map(withTimeout);
}

// Pi runs the tool calls of one turn in parallel. Two writes to the SAME
// file would race, so they serialize. The SDK's edit/write tools already
// queue per file (withFileMutationQueue) — locking them here too would stack
// two queues and double the failure modes. Granka's own doc tools have no
// such queue, so the per-file lock below covers only them. (A doc_edit and
// an edit racing on the same path in one turn is the accepted residual risk.)
const EDIT_TOOLS = new Set(["doc_edit", "doc_create", "edit_fuzzy"]);

function editTargetPath(toolName, args) {
  if (!EDIT_TOOLS.has(toolName) || !args || typeof args !== "object") return "";
  const raw = args.path ?? args.file_path ?? args.file ?? "";
  return raw ? path.resolve(sessionCwd(), String(raw)) : "";
}

function sessionCwd() {
  try { return session?.sessionManager.getCwd() ?? AGENT_DIR; } catch { return AGENT_DIR; }
}

// Release-all registry: ask()'s finally and abort() reset a session's locks
// so an interrupted turn never leaves a file locked for the next one.
const releaseAllLocksBySession = new WeakMap();
export function resetFileLocks(sess) {
  releaseAllLocksBySession.get(sess)?.();
}

// Does a bash command touch paths outside the project folder? Heuristic:
// `..` segments and absolute paths outside cwd (system dirs excluded).
function bashEscapesCwd(command, cwd) {
  const cmd = String(command ?? "");
  if (/(^|[\s'"`;&|(])\.\.(\/|\\|[\s'"`;&|)]|$)/.test(cmd)) return true;
  const abs = cmd.match(/\/[A-Za-z0-9._\-\/]+/g) ?? [];
  const sys = ["/usr/", "/bin/", "/sbin/", "/opt/", "/lib/", "/dev/", "/tmp/"];
  return abs.some((p) => !p.startsWith(cwd) && !sys.some((prefix) => p.startsWith(prefix)));
}

const LOCK_WAIT_MS = 30000; // absolute cap: never hang a tool call longer
const LOCK_STALE_MS = 20000; // a file write takes milliseconds; older = leaked

function installFileLocks(sess) {
  const locks = new Map(); // file -> Map<toolCallId, acquiredAt>
  const waiters = new Map(); // file -> Set<wake>
  const wake = (file) => {
    const pending = waiters.get(file);
    if (!pending?.size) return;
    waiters.delete(file);
    for (const resolve of pending) resolve();
  };
  const release = (file, id) => {
    const owners = locks.get(file);
    if (!owners) return;
    owners.delete(id);
    if (!owners.size) {
      locks.delete(file);
      wake(file);
    }
  };
  const releaseAll = () => {
    locks.clear();
    for (const file of [...waiters.keys()]) wake(file);
  };
  releaseAllLocksBySession.set(sess, releaseAll);
  // Chain the SDK's own hooks (extensions) instead of replacing them.
  const previousBefore = sess.agent.beforeToolCall;
  const previousAfter = sess.agent.afterToolCall;
  const CONFIRM_TOOLS = new Set(["bash", "write", "edit", "edit_fuzzy", "doc_create", "doc_edit", "doc_format"]);
  sess.agent.beforeToolCall = async (context, signal) => {
    const toolName = context.toolCall?.name ?? "";
    // bash has no default timeout in the SDK: one hanging command would hang
    // the whole tool call. 120s default; the model can override per call.
    if (
      toolName === "bash" &&
      context.args && typeof context.args === "object" &&
      context.args.timeout == null
    ) {
      context.args.timeout = 120;
    }
    const cfg = loadConfig();
    // Allowlisted bash prefixes never ask (user-configured, settings).
    const bashAllowed =
      toolName === "bash" &&
      Array.isArray(cfg.bashAllowlist) &&
      cfg.bashAllowlist.some(
        (prefix) => prefix && String(context.args?.command ?? "").trim().startsWith(prefix),
      );
    // auto mode means "no questions": treat it as always-allow alongside
    // the persisted setting and per-session confirmations.
    if (
      CONFIRM_TOOLS.has(toolName) &&
      !bashAllowed &&
      cfg.confirmBashWrite !== "allow" &&
      cfg.agentMode !== "auto" &&
      !cfg.planMode &&
      !sessionConfirmedTools.has(toolName) &&
      !sessionConfirmedTools.has("*")
    ) {
      const args = context.args && typeof context.args === "object" ? context.args : {};
      const detail =
        toolName === "bash"
          ? String(args.command ?? "").slice(0, 300)
          : String(args.path ?? args.file_path ?? "").slice(0, 300);
      const escapes =
        toolName === "bash" && bashEscapesCwd(args.command ?? "", sessionCwd());
      const answer = await uiBridge.askUser({
        question: `Агент хочет выполнить: ${toolName}${detail ? ` — ${detail}` : ""}.${escapes ? " Внимание: команда затрагивает пути вне папки проекта." : ""} Разрешить?`,
        header: "Подтверждение",
        allowFreeform: false,
        options: [
          { label: "Разрешить", description: "Только этот раз" },
          { label: "Всегда разрешать", description: `Этот инструмент (${toolName}) в текущей сессии — без вопросов` },
          { label: "Запретить", description: "Инструмент не выполнится" },
        ],
      });
      if (answer === "Всегда разрешать") sessionConfirmedTools.add(toolName);
      else if (answer !== "Разрешить") {
        return { block: true, reason: `Пользователь не разрешил ${toolName}` };
      }
    }
    const file = editTargetPath(context.toolCall?.name, context.args);
    if (file) {
      const id = context.toolCall?.id ?? file;
      while (locks.has(file)) {
        if (signal?.aborted) throw new Error("aborted");
        // Evict owners that never release: a file write takes milliseconds,
        // so a lock older than LOCK_STALE_MS is a call that died holding it.
        const owners = locks.get(file);
        const now = Date.now();
        for (const [ownerId, at] of owners) {
          if (now - at > LOCK_STALE_MS) {
            console.error(`[granka] stale file lock evicted: ${file} (${ownerId})`);
            owners.delete(ownerId);
          }
        }
        if (!owners.size) {
          locks.delete(file);
          wake(file);
          break;
        }
        // Bounded wait as a final guard: never burn the whole tool call
        // waiting for a lock that will not come.
        await new Promise((resolve, reject) => {
          const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            waiters.get(file)?.delete(onWake);
          };
          const onWake = () => { cleanup(); resolve(); };
          const onAbort = () => { cleanup(); resolve(); };
          const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`Блокировка файла не снялась за ${LOCK_WAIT_MS / 1000} с: ${file}. Предыдущая правка, возможно, не завершилась.`));
          }, LOCK_WAIT_MS);
          if (!waiters.has(file)) waiters.set(file, new Set());
          waiters.get(file).add(onWake);
          signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
      if (!locks.has(file)) locks.set(file, new Map());
      locks.get(file).set(id, Date.now());
    }
    return previousBefore ? previousBefore(context, signal) : undefined;
  };
  sess.agent.afterToolCall = async (context, signal) => {
    const file = editTargetPath(context.toolCall?.name, context.args);
    if (file) release(file, context.toolCall?.id ?? file);
    return previousAfter ? previousAfter(context, signal) : undefined;
  };
}

// textOf/usageOf imported from agent-utils.mjs
function sumTurnUsage(messages) {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, billed: true };
  let seen = false;
  for (const message of messages ?? []) {
    if (message?.role !== "assistant") continue;
    const usage = usageOf(message);
    if (!usage) continue;
    seen = true;
    total.input += usage.input;
    total.output += usage.output;
    total.cacheRead += usage.cacheRead;
    total.cacheWrite += usage.cacheWrite;
    total.total += usage.total;
    total.cost += usage.cost;
    total.billed = total.billed && usage.billed; // one estimated step taints the sum
  }
  return seen ? total : null;
}

// Full text of one agent turn: every assistant message between tool calls
// contributes. getLastAssistantText() returns only the final message, so a
// turn of text -> tool -> text -> tool -> text would lose everything but the
// tail (the renderer then overwrites the streamed full text with that tail).
export function turnText(messages) {
  const parts = [];
  for (const message of messages ?? []) {
    if (message?.role !== "assistant") continue;
    const text = textOf(message).trim();
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
}

function contextOf(s) {
  // Prefer the provider's own numbers: the last assistant turn's totalTokens
  // is the real context size; the SDK estimate is only a chars/4 fallback.
  const last = [...(s.messages ?? [])].reverse().find((m) => m.role === "assistant");
  const usage = last?.usage;
  const sdk = s.contextUsage;
  if (usage && (usage.totalTokens || 0) > 0 && sdk?.contextWindow > 0) {
    const tokens = usage.totalTokens || usage.input + usage.output + usage.cacheRead + (usage.cacheWrite ?? 0);
    return { tokens, percent: Math.min(100, (tokens / sdk.contextWindow) * 100), window: sdk.contextWindow, estimated: false };
  }
  return sdk ? { tokens: sdk.tokens, percent: sdk.percent, window: sdk.contextWindow, estimated: true } : null;
}

export async function lastUserPrompt() {
  const s = await ensureSession();
  const last = [...s.messages].reverse().find((m) => m.role === "user");
  return last ? textOf(last) : "";
}

// Current conversation, for re-rendering after a restart or session switch.
// Rich history for the UI: one entry per turn (user message or a whole
// assistant turn with its thinking, tool calls and summed usage), instead of
// the flat text-only list that made reloaded chats look empty.
export async function history() {
  const s = await ensureSession();
  const turns = [];
  let current = null;
  const toolIndex = new Map(); // toolCallId -> tool entry in the current turn
  const flush = () => {
    if (!current) return;
    const hasContent =
      current.text.trim() || current.thinking.trim() || current.tools.length;
    if (hasContent) turns.push(current);
    current = null;
    toolIndex.clear();
  };
  for (const message of s.messages ?? []) {
    if (message.role === "user") {
      flush();
      turns.push({
        role: "user",
        text: textOf(message),
        ts: message.timestamp ?? null,
        thinking: "",
        thinkingMs: 0,
        tools: [],
        usage: null,
      });
      continue;
    }
    if (message.role === "toolResult") {
      const entry = toolIndex.get(message.toolCallId);
      if (entry) {
        entry.result = textOf(message);
        entry.isError = Boolean(message.isError);
        entry.durationMs = message.durationMs ?? 0;
      }
      continue;
    }
    if (message.role !== "assistant") continue;
    if (!current || current.role !== "assistant") {
      current = { role: "assistant", text: "", ts: message.timestamp ?? null, thinking: "", thinkingMs: 0, tools: [], usage: null };
    }
    const usage = usageOf(message);
    if (usage) {
      current.usage = current.usage
        ? {
            input: current.usage.input + usage.input,
            output: current.usage.output + usage.output,
            cacheRead: current.usage.cacheRead + usage.cacheRead,
            cacheWrite: current.usage.cacheWrite + usage.cacheWrite,
            total: current.usage.total + usage.total,
            cost: current.usage.cost + usage.cost,
            billed: current.usage.billed && usage.billed,
          }
        : usage;
    }
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string") {
        current.text += (current.text ? "\n\n" : "") + block.text;
      } else if (block.type === "thinking" && typeof block.thinking === "string") {
        current.thinking += (current.thinking ? "\n\n" : "") + block.thinking;
      } else if (block.type === "toolCall") {
        const args = typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments ?? "");
        const entry = { name: block.name ?? "tool", args, result: "", durationMs: 0, isError: false };
        current.tools.push(entry);
        if (block.id) toolIndex.set(block.id, entry);
      }
    }
  }
  flush();
  // The plan is restored from the last todo_write call in the transcript,
  // so a reopened session shows the same strip the agent left behind.
  let plan = null;
  for (const message of s.messages ?? []) {
    if (message.role !== "assistant") continue;
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (!block || block.type !== "toolCall" || block.name !== "todo_write") continue;
      try {
        const args = typeof block.arguments === "string" ? JSON.parse(block.arguments) : block.arguments;
        if (Array.isArray(args?.items)) plan = args.items;
      } catch (err) { console.error("[granka plan restore]", err?.message ?? err); }
    }
  }
  const messages = turns.filter((turn) => turn.role === "user" || turn.text.trim() || turn.tools.length || turn.thinking.trim());
  // Attach the measured thinking duration to the last assistant turn.
  const thinkingMs = thinkingMsBySession.get(s.sessionManager.getSessionId());
  if (thinkingMs) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === "assistant" && messages[i].thinking.trim()) { messages[i].thinkingMs = thinkingMs; break; }
    }
  }
  return {
    plan,
    sessionId: s.sessionManager.getSessionId(),
    cwd: s.sessionManager.getCwd(),
    projectId: projectOfSession(s.sessionManager.getSessionId()),
    context: contextOf(s),
    messages,
  };
}

let compacting = false;

// Fire-and-forget compaction between turns. The next ask() cancels it first.
function compactNowBackground() {
  compactNow()
    .then((result) => {
      uiBridge.emit({ kind: "compaction", background: true, aborted: !result.ok });
    })
    .catch((err) => console.error("[granka compaction]", err?.message ?? err));
}

// Live context breakdown for the meter popover: prompt + rules + memory +
// history, estimated in tokens (chars/4; history is the remainder of the real
// context size so the parts always add up).
export async function contextBreakdown() {
  const s = await ensureSession();
  const context = contextOf(s);
  const charsOf = (file) => {
    try { return fs.readFileSync(file, "utf8").length; } catch { return 0; }
  };
  const cfg = loadConfig();
  const project = activeProject(cfg);
  const projectRulesFile = project ? projectAgentsPath(project) : "";
  const system = charsOf(SYSTEM_RULES_FILE);
  const rules = charsOf(path.join(AGENT_DIR, "AGENTS.md")) + (projectRulesFile ? charsOf(projectRulesFile) : 0);
  const memory =
    readMemoryCapped(MEMORY_FILE).length +
    (project ? readMemoryCapped(projectMemoryPath(project.id)).length : 0);
  const fixed = Math.round((system + rules + memory) / 4);
  const total = context?.tokens ?? fixed;
  const history = Math.max(0, total - fixed);
  return {
    ok: true,
    context,
    parts: [
      { id: "system", label: "Системный промпт", tokens: Math.round(system / 4) },
      { id: "rules", label: "Правила AGENTS.md", tokens: Math.round(rules / 4) },
      { id: "memory", label: "Память", tokens: Math.round(memory / 4) },
      { id: "history", label: "История диалога", tokens: history },
    ],
  };
}

export async function compactNow() {
  try {
    const s = await ensureSession();
    compacting = true;
    await s.compact();
    return { ok: true, context: contextOf(s) };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  } finally {
    compacting = false;
  }
}

// The SDK has no compaction-cancel API; aborting the session cancels the run.
export async function cancelCompaction() {
  if (!compacting) return { ok: false, error: "сжатие не выполняется" };
  await session?.abort();
  return { ok: true };
}

export async function isCompacting() {
  return compacting;
}

// Queue a message while the agent is running: `steer` enters after the current
// assistant turn, `followUp` after all pending work.
export async function queueMessage(text, mode = "followUp") {
  const s = await ensureSession();
  try {
    await (mode === "steer" ? s.steer(text) : s.followUp(text));
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
  return { ok: true };
}

const ATTACH_DIR = path.join(AGENT_DIR, "attachments");
const STATS_FILE = path.join(AGENT_DIR, "stats.jsonl");
const PI_SETTINGS_FILE = path.join(AGENT_DIR, "settings.json");
const MEMORY_FILE = path.join(AGENT_DIR, "MEMORY.md"); // user notes, appended per session, never merged into AGENTS.md
// Strict chat ↔ project binding: a session belongs to exactly one project,
// independent of its folder (two projects may share a folder).
const PROJECTS_MAP_FILE = path.join(AGENT_DIR, "session-projects.json");

function clip(value) {
  // Every tool result is clipped: unbounded tool output is the cheapest way to
  // burn input tokens, and the model rarely needs the tail.
  const limit = Math.min(Math.max(Number(loadConfig().toolOutputLimit) || 16000, 500), 32000);
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "";
  return text.length > limit ? `${text.slice(0, limit)}\n… обрезано` : text;
}

// pi settings live in ~/.granka/settings.json: keep compaction knobs there.
export function readPiSettings() {
  try {
    return JSON.parse(fs.readFileSync(PI_SETTINGS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writePiSettings(patch) {
  const next = { ...readPiSettings(), ...patch };
  fs.mkdirSync(AGENT_DIR, { recursive: true });
  fs.writeFileSync(PI_SETTINGS_FILE, JSON.stringify(next, null, 2) + "\n");
  return next;
}

export async function applyCompactionSettings(cfg = loadConfig()) {
  writePiSettings({
    compaction: {
      enabled: cfg.compactionEnabled !== false,
      reserveTokens: Number(cfg.compactionReserve) || 16384,
    },
  });
  await dropSession();
  pending = { kind: "recent" };
  return { ok: true };
}

function recordUsage(sessionId, model, usage) {
  if (!usage) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    sessionId,
    model,
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    cost: usage.cost,
    billed: Boolean(usage.billed),
  });
  try {
    fs.appendFileSync(STATS_FILE, line + "\n");
    rotateStats();
  } catch (err) { console.error("[granka]", err?.message ?? err); }
}

// stats.jsonl grows forever otherwise and stats() re-parses it every time:
// keep only the most recent rows once the file passes ~1 MB.
const STATS_MAX_BYTES = 1_000_000;
const STATS_KEEP_ROWS = 5000;

function rotateStats() {
  const size = fs.statSync(STATS_FILE).size;
  if (size <= STATS_MAX_BYTES) return;
  const lines = fs.readFileSync(STATS_FILE, "utf8").split("\n").filter(Boolean);
  fs.writeFileSync(STATS_FILE, lines.slice(-STATS_KEEP_ROWS).join("\n") + "\n");
}

let statsCache = null;

export function stats() {
  try {
    const stat = fs.statSync(STATS_FILE);
    if (statsCache && statsCache.mtimeMs === stat.mtimeMs && statsCache.size === stat.size) {
      return statsCache.result;
    }
  } catch (err) { console.error("[granka]", err?.message ?? err); }
  const result = computeStats();
  try {
    const stat = fs.statSync(STATS_FILE);
    statsCache = { mtimeMs: stat.mtimeMs, size: stat.size, result };
  } catch (err) { console.error("[granka]", err?.message ?? err); }
  return result;
}

function computeStats() {
  const rows = [];
  try {
    for (const line of fs.readFileSync(STATS_FILE, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch (err) { console.error("[granka]", err?.message ?? err); }
    }
  } catch (err) { console.error("[granka]", err?.message ?? err); }

  const totals = { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0, billedCalls: 0 };
  const byModel = new Map();
  const byDay = new Map();
  const bySession = new Map();
  const byProject = new Map();
  const projectMap = readProjectMap();
  const projectNames = new Map((loadConfig().projects ?? []).map((p) => [p.id, p.name]));
  for (const row of rows) {
    const inputTotal = (row.input ?? 0) + (row.cacheRead ?? 0) + (row.cacheWrite ?? 0);
    totals.calls += 1;
    totals.input += inputTotal;
    totals.cacheRead += row.cacheRead ?? 0;
    totals.cacheWrite += row.cacheWrite ?? 0;
    totals.output += row.output ?? 0;
    totals.cost += row.cost ?? 0;
    if (row.billed) totals.billedCalls += 1;
    const model = row.model ?? "—";
    const modelRow = byModel.get(model) ?? { model, calls: 0, input: 0, output: 0, cost: 0 };
    modelRow.calls += 1;
    modelRow.input += inputTotal;
    modelRow.output += row.output ?? 0;
    modelRow.cost += row.cost ?? 0;
    byModel.set(model, modelRow);
    const day = (row.ts ?? "").slice(0, 10);
    const dayRow = byDay.get(day) ?? { day, calls: 0, cost: 0, input: 0, output: 0 };
    dayRow.calls += 1;
    dayRow.cost += row.cost ?? 0;
    dayRow.input += inputTotal;
    dayRow.output += row.output ?? 0;
    byDay.set(day, dayRow);
    const sessionRow = bySession.get(row.sessionId) ?? { sessionId: row.sessionId, calls: 0, cost: 0 };
    sessionRow.calls += 1;
    sessionRow.cost += row.cost ?? 0;
    bySession.set(row.sessionId, sessionRow);
    // Per-project spend: session → project via session-projects.json.
    const projectName = projectNameOf(row.sessionId, projectMap, projectNames);
    const projRow = byProject.get(projectName) ?? { project: projectName, calls: 0, cost: 0, input: 0, output: 0 };
    projRow.calls += 1;
    projRow.cost += row.cost ?? 0;
    projRow.input += inputTotal;
    projRow.output += row.output ?? 0;
    byProject.set(projectName, projRow);
  }

  return {
    totals,
    byModel: [...byModel.values()].sort((a, b) => b.cost - a.cost),
    byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)).slice(-14),
    bySession: [...bySession.values()].sort((a, b) => b.cost - a.cost).slice(0, 20),
    byProject: [...byProject.values()].sort((a, b) => b.cost - a.cost).slice(0, 10),
  };
}

// Session → project name: stats recompute is cached by file mtime, so the
// extra read of session-projects.json here is cheap.
function projectNameOf(sessionId, projectMap, projectNames) {
  return projectNames.get(projectMap[sessionId] ?? "") ?? "Без проекта";
}

// Attachments are copied into the agent home so the session keeps working even
// if the original file moves; the model receives paths, images also as pixels.
// Folders are expanded recursively (heavy dirs skipped), identical content is
// deduplicated by hash, old copies are pruned, and large copies report
// progress through onProgress.
const ATTACH_SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".venv", "__pycache__", ".next", "checkpoints"]);
const ATTACH_MAX_FILES = 100;
const ATTACH_MAX_AGE_DAYS = 30;
const ATTACH_MAX_TOTAL_BYTES = 500 * 1024 * 1024;

function collectAttachFiles(source, out) {
  const stat = fs.statSync(source);
  if (stat.isFile()) {
    out.push(source);
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (out.length >= ATTACH_MAX_FILES) return;
    if (entry.isDirectory()) {
      if (ATTACH_SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      collectAttachFiles(path.join(source, entry.name), out);
    } else if (entry.isFile()) {
      out.push(path.join(source, entry.name));
    }
  }
}

function hashFile(filePath) {
  const hash = crypto.createHash("sha1");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.alloc(1024 * 256);
  try {
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function pruneAttachments() {
  try {
    const now = Date.now();
    const byAge = [];
    let total = 0;
    for (const name of fs.readdirSync(ATTACH_DIR)) {
      const full = path.join(ATTACH_DIR, name);
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      byAge.push({ name, full, mtime: stat.mtimeMs, bytes: stat.size });
      total += stat.size;
    }
    byAge.sort((a, b) => a.mtime - b.mtime);
    for (const item of byAge) {
      const tooOld = now - item.mtime > ATTACH_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
      const overBudget = total > ATTACH_MAX_TOTAL_BYTES;
      if (!tooOld && !overBudget) continue;
      fs.rmSync(item.full, { force: true });
      total -= item.bytes;
    }
  } catch (err) { console.error("[granka prune attachments]", err?.message ?? err); }
}

async function copyWithProgress(source, target, onProgress) {
  const total = fs.statSync(source).size;
  if (total < 1024 * 256 || !onProgress) {
    fs.copyFileSync(source, target);
    return;
  }
  const reader = fs.createReadStream(source, { highWaterMark: 1024 * 256 });
  const writer = fs.createWriteStream(target);
  let done = 0;
  await new Promise((resolve, reject) => {
    reader.on("data", (chunk) => {
      done += chunk.length;
      onProgress({ path: source, done, total });
    });
    reader.on("error", reject);
    writer.on("error", reject);
    writer.on("finish", resolve);
    reader.pipe(writer);
  });
}

export async function attachFiles(paths = [], onProgress = () => {}) {
  const cfg = loadConfig();
  const limitBytes = (Number(cfg.attachMaxMb) || 25) * 1024 * 1024;
  fs.mkdirSync(ATTACH_DIR, { recursive: true });
  pruneAttachments();
  const { docInfo } = await import("./docs.mjs");
  const files = [];
  const skipped = [];
  for (const raw of paths) {
    try {
      const source = path.resolve(String(raw));
      fs.statSync(source);
      collectAttachFiles(source, files);
    } catch (err) {
      skipped.push({ path: String(raw), reason: String(err?.message ?? err) });
    }
  }
  const added = [];
  const seenHashes = new Map();
  for (const source of files.slice(0, ATTACH_MAX_FILES)) {
    try {
      const stat = fs.statSync(source);
      if (stat.size > limitBytes) {
        skipped.push({ path: source, reason: `больше ${Math.round(limitBytes / 1024 / 1024)} МБ` });
        continue;
      }
      const digest = hashFile(source);
      let target = seenHashes.get(digest);
      const name = path.basename(source);
      if (!target) {
        const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        target = path.join(ATTACH_DIR, `${stamp}-${name}`);
        await copyWithProgress(source, target, onProgress);
        seenHashes.set(digest, target);
      }
      const ext = path.extname(name).toLowerCase();
      const kind = [".pdf", ".docx", ".md", ".txt", ".html", ".htm", ".xlsx", ".ods", ".csv", ".rtf"].includes(ext)
        ? "document"
        : [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)
          ? "image"
          : "file";
      const info = kind === "document" ? await docInfo(target) : {};
      const meta = info.pages ? `${info.pages} стр.` : info.blocks ? `${info.blocks} блоков` : info.lines ? `${info.lines} строк` : "";
      added.push({
        id: digest.slice(0, 8),
        name,
        path: target,
        source,
        bytes: stat.size,
        kind,
        meta,
      });
    } catch (err) {
      skipped.push({ path: source, reason: String(err?.message ?? err) });
    }
  }
  if (files.length > ATTACH_MAX_FILES) {
    skipped.push({ path: "…", reason: `ограничение ${ATTACH_MAX_FILES} файлов на раз` });
  }
  return { ok: true, added, skipped };
}

// Base64 data URL for an image attachment (used by the renderer to downscale
// it on a canvas before it goes to the model — full-size screenshots would
// otherwise bloat every request).
export function wallpaperDataUrl(filePath) {
  try {
    const full = path.resolve(String(filePath ?? ""));
    if (!fs.existsSync(full)) return { ok: false };
    const ext = path.extname(full).toLowerCase();
    const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp", ".avif": "image/avif" }[ext];
    if (!mime) return { ok: false };
    if (fs.statSync(full).size > 15 * 1024 * 1024) return { ok: false, error: "файл больше 15 МБ" };
    return { ok: true, dataUrl: `data:${mime};base64,${fs.readFileSync(full).toString("base64")}` };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

export function attachmentDataUrl(filePath) {
  try {
    const full = path.resolve(String(filePath ?? ""));
    if (!full.startsWith(ATTACH_DIR) || !fs.existsSync(full)) return { ok: false };
    const ext = path.extname(full).toLowerCase();
    const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" }[ext];
    if (!mime) return { ok: false };
    return { ok: true, dataUrl: `data:${mime};base64,${fs.readFileSync(full).toString("base64")}` };
  } catch (err) {
    console.error("[granka attachmentDataUrl]", err?.message ?? err);
    return { ok: false };
  }
}

// Text preview of an attached document (PDF/DOCX/sheets) as escaped HTML
// for the sandboxed preview window — pdf.js is unavailable without new
// dependencies, so the preview is the extracted text with page markers.
export async function docPreview(filePath) {
  try {
    const target = path.resolve(String(filePath ?? ""));
    if (!target.startsWith(ATTACH_DIR + path.sep) && !target.startsWith(SESSION_DIR + path.sep)) {
      return { ok: false, error: "файл вне каталогов granka" };
    }
    const { createDocTools } = await import("./docs.mjs");
    const tools = createDocTools({ resolve: (p) => p, emit: () => {} });
    const outline = await tools.outlineTool.execute("preview", { path: target }, undefined, undefined, {});
    const text = outline.content[0].text;
    const escape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const html = `<pre style="font:13px/1.6 sans-serif;white-space:pre-wrap">${escape(text)}</pre>`;
    return { ok: true, html, title: path.basename(target) };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

export async function attachText({ name, text }) {
  try {
    const body = String(text ?? "");
    if (!body.trim()) return { ok: false, error: "пустой текст" };
    fs.mkdirSync(ATTACH_DIR, { recursive: true });
    const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const safe = String(name || "вставлено").replace(/[^\w.\-]+/g, "-").slice(0, 40) || "вставлено";
    const target = path.join(ATTACH_DIR, `${stamp}-${safe}.md`);
    fs.writeFileSync(target, body, "utf8");
    return {
      ok: true,
      added: [{ id: stamp, name: `${safe}.md`, path: target, bytes: Buffer.byteLength(body), kind: "document" }],
      skipped: [],
    };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

export async function saveAttachmentImage({ name, dataUrl }) {
  try {
    const match = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i.exec(String(dataUrl ?? ""));
    if (!match) return { ok: false, error: "ожидался data:image/…;base64" };
    const ext = match[1].replace("jpg", "jpeg");
    const bytes = Buffer.from(match[2], "base64");
    fs.mkdirSync(ATTACH_DIR, { recursive: true });
    const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const fileName = `${stamp}-${name || "clipboard"}.${ext === "jpeg" ? "jpg" : ext}`;
    const target = path.join(ATTACH_DIR, fileName);
    fs.writeFileSync(target, bytes);
    return {
      ok: true,
      added: [{ id: stamp, name: fileName, path: target, bytes: bytes.length, kind: "image" }],
      skipped: [],
    };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

// Checkpoints: before the first write/edit of a turn, snapshot the working
// folder (minus heavy dirs) so the user can roll back from the chat.
const CHECKPOINT_DIR = path.join(AGENT_DIR, "checkpoints");
const CHECKPOINT_SKIP = new Set([".git", "node_modules", "dist", "build", ".venv", "__pycache__", ".next"]);

function checkpointFilter(src) {
  return !CHECKPOINT_SKIP.has(path.basename(src));
}

export function createCheckpoint(cwd) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const dest = path.join(CHECKPOINT_DIR, id);
  fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
  fs.cpSync(cwd, dest, { recursive: true, filter: checkpointFilter });
  pruneCheckpoints();
  return id;
}

function pruneCheckpoints() {
  try {
    const entries = fs.readdirSync(CHECKPOINT_DIR)
      .map((name) => ({ name, mtime: fs.statSync(path.join(CHECKPOINT_DIR, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const entry of entries.slice(20)) {
      fs.rmSync(path.join(CHECKPOINT_DIR, entry.name), { recursive: true, force: true });
    }
  } catch (err) { console.error("[granka] prune checkpoints:", err?.message ?? err); }
}

export function restoreCheckpoint(id) {
  const src = path.join(CHECKPOINT_DIR, String(id ?? ""));
  if (!insideCheckpointDir(src) || !fs.existsSync(src)) {
    return { ok: false, error: "чекпоинт не найден" };
  }
  const cwd = session?.sessionManager.getCwd() ?? loadConfig().cwd ?? AGENT_DIR;
  fs.cpSync(src, cwd, { recursive: true, force: true, filter: checkpointFilter });
  return { ok: true };
}

function insideCheckpointDir(target) {
  const rel = path.relative(path.resolve(CHECKPOINT_DIR), path.resolve(target));
  return Boolean(rel) && !rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel);
}

async function maybeCheckpoint(toolName, session, state) {
  if (state.done || !["edit", "write", "doc_edit", "doc_create"].includes(toolName)) return "";
  state.done = true;
  const cwd = session.sessionManager.getCwd();
  return createCheckpoint(cwd);
}

// User hook (settings): a shell command run in the project folder after
// every file edit, e.g. a formatter. Trusted: it comes from the user's own
// config, never from model output.
async function runAfterEditHook(toolName, session) {
  const command = String(loadConfig().hooks?.afterEdit ?? "").trim();
  if (!command || !["edit", "write", "doc_edit", "doc_create"].includes(toolName)) return "";
  const { exec } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execAsync = promisify(exec);
  const cwd = session.sessionManager.getCwd();
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: 60000,
      maxBuffer: 256 * 1024,
      shell: "/bin/bash",
    });
    const out = String(stdout || stderr || "").trim().slice(-500);
    return out ? `hook: ${out}` : "";
  } catch (err) {
    const out = String(err?.stdout || err?.stderr || err?.message || "").trim().slice(-500);
    return `hook не удался: ${out}`;
  }
}

export async function ask(question, onDelta, onTool, onNotify = () => {}, attachments = [], onThinking = () => {}) {
  if (compacting) await cancelCompaction();
  const backgroundResults = drainBackgroundResults();
  if (backgroundResults.length) {
    question = `${question}\n\n[Background subagent results since your last turn]\n${backgroundResults
      .map((r) => `- ${r.agent} (${r.description}):\n${r.text}`)
      .join("\n\n")}`;
  }
  const s = await ensureSession();
  const checkpointState = { done: false };
  let thinkingFirstAt = 0;
  let thinkingLastAt = 0;
  const unsubscribe = s.subscribe((event) => {
    if (event.type === "message_update") {
      const kind = event.assistantMessageEvent.type;
      if (kind === "text_delta") onDelta(event.assistantMessageEvent.delta);
      else if (kind === "thinking_delta") {
        const now = Date.now();
        if (!thinkingFirstAt) thinkingFirstAt = now;
        thinkingLastAt = now;
        onThinking(event.assistantMessageEvent.delta);
      }
    } else if (event.type === "tool_execution_start") {
      onTool({ phase: "start", name: event.toolName, args: clip(event.args), toolCallId: event.toolCallId });
      maybeCheckpoint(event.toolName, s, checkpointState).then((id) => {
        if (id) onNotify({ kind: "checkpoint", id });
      }).catch((err) => console.error("[granka] checkpoint:", err?.message ?? err));
    } else if (event.type === "tool_execution_end") {
      onTool({
        phase: "end",
        name: event.toolName,
        isError: event.isError,
        durationMs: event.durationMs,
        result: clip(event.result),
        toolCallId: event.toolCallId,
      });
      runAfterEditHook(event.toolName, s).then((output) => {
        if (output) onNotify({ kind: "hook", output });
      }).catch((err) => console.error("[granka] hook:", err?.message ?? err));
    } else if (event.type === "compaction_end") {
      onNotify({ kind: "compaction", reason: event.reason, aborted: event.aborted });
    } else if (event.type === "queue_update") {
      onNotify({ kind: "queue", steering: event.steering.length, followUp: event.followUp.length });
    }
  });
  const images = [];
  const docs = [];
  for (const item of attachments ?? []) {
    if (item.kind === "image") {
      try {
        // Prefer the renderer's downscaled copy: full-size screenshots bloat
        // every request with base64 pixels.
        if (item.dataUrl) {
          const match = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(String(item.dataUrl));
          if (match) {
            images.push({ type: "image", data: match[2], mimeType: match[1] });
            continue;
          }
        }
        const mime = item.name.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
        images.push({ type: "image", data: fs.readFileSync(item.path).toString("base64"), mimeType: mime });
      } catch (err) { console.error("[granka]", err?.message ?? err); }
    } else {
      docs.push(item);
    }
  }
  const attachmentNote = docs.length
    ? `\n\n[Вложения сессии — читай их через doc_outline/doc_read по этим путям]\n${docs
        .map((item) => `- ${item.path} (${path.extname(item.name).slice(1) || "файл"}, ${item.bytes} B)`)
        .join("\n")}`
    : "";
  const startIndex = s.messages.length;
  try {
    // One prompt with tool calls produces many assistant turns, each with its
    // own usage. Summing them all is the only honest per-turn total — the
    // last message alone undercounts spend by most of the turn.
    await s.prompt(question + attachmentNote, images.length ? { images } : undefined);
    const fresh = s.messages.slice(startIndex);
    const usage = sumTurnUsage(fresh);
    recordUsage(s.sessionManager.getSessionId(), s.model?.id ?? loadConfig().model, usage);
    const thinkingMs = thinkingFirstAt && thinkingLastAt ? thinkingLastAt - thinkingFirstAt : 0;
    if (thinkingMs) thinkingMsBySession.set(s.sessionManager.getSessionId(), thinkingMs);
    const context = contextOf(s);
    // Background compaction: once the turn is over and the session is idle, a
    // nearly full context compacts itself instead of blocking the next turn.
    const cfg = loadConfig();
    const threshold = Math.min(95, Math.max(50, Number(cfg.compactionThreshold) || 80));
    if (cfg.compactionEnabled !== false && context && context.percent >= threshold && !compacting) {
      uiBridge.emit({ kind: "compaction", background: true, started: true });
      compactNowBackground();
    }
    return { ok: true, text: turnText(fresh), usage, context, thinkingMs };
  } catch (err) {
    // Interrupted/failed turn: the partial answer is already in the session
    // messages — hand it back so the UI finalizes it instead of dropping it.
    let text = "";
    try {
      text = turnText(s.messages.slice(startIndex));
    } catch (recoverErr) { console.error("[granka]", recoverErr?.message ?? recoverErr); }
    return { ok: false, error: String(err?.message ?? err), text };
  } finally {
    unsubscribe();
    // The turn is over (or aborted): never carry its locks into the next one.
    resetFileLocks(s);
  }
}

// Diagnostics: which tools the live session exposes (built-in + granka's).
export async function toolNames() {
  const s = await ensureSession();
  return s.getActiveToolNames();
}

export async function isBusy() {
  return Boolean(session && !session.isIdle);
}

export async function abort() {
  await session?.abort();
  resetFileLocks(session);
}

// --- backup: export/import ~/.granka as a .zip -----------------------------
const BACKUP_SKIP_DIRS = new Set(["logs", "checkpoints", ".git"]);
const BACKUP_SKIP_FILES = new Set(["auth.json"]);

function collectBackupFiles(dir, base, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && BACKUP_SKIP_DIRS.has(entry.name)) continue;
    if (entry.isFile() && BACKUP_SKIP_FILES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).replace(/\\/g, "/");
    if (entry.isDirectory()) collectBackupFiles(full, base, out);
    else if (entry.isFile()) out.push([rel, full]);
  }
}

export async function exportBackup(destPath) {
  try {
    const { zipSync } = await import("fflate");
    const files = [];
    collectBackupFiles(AGENT_DIR, AGENT_DIR, files);
    const entries = {};
    for (const [rel, full] of files) entries[rel] = fs.readFileSync(full);
    entries["granka-backup.json"] = Buffer.from(JSON.stringify({ app: "granka", version: 1, exportedAt: new Date().toISOString(), files: files.length }, null, 2));
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, Buffer.from(zipSync(entries, { level: 6 })));
    return { ok: true, files: files.length, path: destPath };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

export async function importBackup(zipPath) {
  try {
    const { unzipSync } = await import("fflate");
    const entries = unzipSync(fs.readFileSync(zipPath));
    let restored = 0;
    for (const [rel, data] of Object.entries(entries)) {
      if (rel.includes("..") || path.isAbsolute(rel) || rel === "granka-backup.json") continue;
      if (BACKUP_SKIP_FILES.has(path.basename(rel))) continue;
      const dest = path.join(AGENT_DIR, rel);
      if (!dest.startsWith(AGENT_DIR + path.sep)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, data);
      restored += 1;
    }
    await dropSession();
    pending = { kind: "recent" };
    return { ok: true, restored };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

// Graceful shutdown (main before-quit): stop the live turn, dispose the
// session and close MCP child processes so nothing outlives the app.
export async function shutdown() {
  await withSessionLock(async () => {
    await dropSession();
  }).catch(() => {});
  try {
    const mcp = await import("./mcp.mjs");
    if (typeof mcp.mcpClients === "function") mcp.mcpClients({});
  } catch {}
}
