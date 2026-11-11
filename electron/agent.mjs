// granka agent core: embeds the Pi SDK in its own home directory (~/.granka).
// No Electron imports here, so it can be smoke-tested with plain node.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { syncSystemPrompt } from "./prompt-template.mjs";
import { createGrankaTools } from "./tools.mjs";
import { createDocTools } from "./docs.mjs";

export const AGENT_DIR = path.join(os.homedir(), ".granka");
export const SESSION_DIR = path.join(AGENT_DIR, "sessions");
const CONFIG_FILE = path.join(AGENT_DIR, "granka.json");
const SYSTEM_RULES_FILE = path.join(AGENT_DIR, "SYSTEM.md"); // replaces pi's system prompt
const AGENT_RULES_FILE = path.join(AGENT_DIR, "AGENTS.md"); // extra instructions
export const PROMPTS_DIR = path.join(AGENT_DIR, "prompts"); // files become /slash commands
export const SKILLS_DIR = path.join(AGENT_DIR, "skills");
const DEFAULT_CONFIG = {
  apiKey: "",
  model: "anthropic/claude-sonnet-4.5",
  thinkingLevel: "medium",
  theme: "dark",
  cwd: "",
  favorites: [],
  projects: [], // [{ id, name, cwd, instructions }]
  activeProject: "",
  // preferences surfaced in the settings window
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
  searxUrl: "",
  debugTools: false,
  toolDocs: true,
  compactionEnabled: true,
  compactionReserve: 16384,
  attachMaxMb: 25,
  uiFont: "inter",
  codeFont: "system",
  cacheRetentionLong: true,
  toolOutputLimit: 4000,
  pinnedSessions: [],
  sessionSort: "recent",
  density: "comfortable",
  onboarded: false,
  autoTitle: true,
};

let pi; // pi SDK, imported in init() after env isolation
let runtime;
let session;
let appliedKey;
let sessionsById = new Map();
let pending = { kind: "recent" }; // recent | new | open
let uiBridge = { askUser: async () => "", emit: () => {} };

// The renderer answers structured questions and receives tool notices.
export function setUiBridge(bridge) {
  uiBridge = { ...uiBridge, ...bridge };
}

export async function init() {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  syncSystemPrompt(AGENT_DIR);
  installBundledSkills();
  migrateMemoryIntoRules();
  // Must happen before the SDK is imported: pi resolves its config dir on load.
  process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
  process.env.PI_SKIP_VERSION_CHECK = "1";
  process.env.PI_TELEMETRY = "0";
  if (loadConfig().cacheRetentionLong !== false) process.env.PI_CACHE_RETENTION = "long";
  pi = await import("@earendil-works/pi-coding-agent");
}

const CONFIG_VERSION = 5;

// MEMORY.md duplicated AGENTS.md: same file appended to the same prompt.
// Content is merged once and the old file is kept as a backup.
function migrateMemoryIntoRules() {
  const memory = readIfExists(MEMORY_FILE).trim();
  if (!memory) return;
  try {
    const current = readIfExists(AGENT_RULES_FILE).trim();
    if (!current.includes(memory.slice(0, 80))) {
      const merged = `${current}${current ? "\n\n" : ""}## Память\n${memory}\n`;
      fs.writeFileSync(AGENT_RULES_FILE, merged);
    }
    fs.renameSync(MEMORY_FILE, `${MEMORY_FILE}.bak`);
  } catch {}
}

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
  fs.writeFileSync(PROJECTS_MAP_FILE, JSON.stringify(map, null, 2) + "\n");
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
      delete cfg.styleMode;
      delete cfg.styleLevel;
      cfg.configVersion = CONFIG_VERSION;
      saveConfig(cfg);
    }
    return cfg;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(AGENT_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

async function getRuntime() {
  if (!runtime) {
    runtime = await pi.ModelRuntime.create({
      authPath: path.join(AGENT_DIR, "auth.json"),
      modelsPath: path.join(AGENT_DIR, "models.json"),
    });
  }
  return runtime;
}

async function syncKey(rt, cfg) {
  if (cfg.apiKey && cfg.apiKey !== appliedKey) {
    await rt.setRuntimeApiKey("openrouter", cfg.apiKey);
    appliedKey = cfg.apiKey;
  }
}

const MODEL_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// Only chat models that take text input (the catalog also carries image and
// classifier models, which cannot answer a chat prompt).
export const acceptsText = (model) =>
  (model.type ?? "chat") === "chat" && Array.isArray(model.input) && model.input.includes("text");

// Catalog with the thinking levels each model actually supports: `thinkingLevelMap`
// marks a level as unsupported with null, non-reasoning models only have "off".
export async function listModels() {
  const rt = await getRuntime();
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
export async function applyConfig(patch) {
  try {
    const before = loadConfig();
    const cfg = { ...before, ...patch };
    saveConfig(cfg);
    const rt = await getRuntime();
    await syncKey(rt, cfg);
    if (cfg.cwd !== before.cwd) {
      await dropSession();
      pending = { kind: "recent" };
    }
    if (session) {
      if (cfg.model && cfg.model !== before.model) {
        const model = rt.getModel("openrouter", cfg.model);
        if (!model) return { ok: false, error: `неизвестная модель: ${cfg.model}` };
        await session.setModel(model);
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

export function getRules() {
  return { system: readIfExists(SYSTEM_RULES_FILE), agents: readIfExists(AGENT_RULES_FILE) };
}

export async function saveRules({ system, agents }) {
  try {
    fs.mkdirSync(AGENT_DIR, { recursive: true });
    fs.writeFileSync(SYSTEM_RULES_FILE, String(system ?? ""));
    fs.writeFileSync(AGENT_RULES_FILE, String(agents ?? ""));
    await dropSession(); // the loader reads these files on session creation
    pending = { kind: "recent" };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
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
  const target = path.join(SKILLS_DIR, String(folder));
  if (!target.startsWith(SKILLS_DIR)) return { ok: false, error: "недопустимый путь" };
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
  } catch {}
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

async function dropSession() {
  if (!session) return;
  try {
    await session.abort();
  } catch {}
  session.dispose();
  session = undefined;
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
      // rough context weight for the sidebar meter (chars, not tokens)
      weight: i.allMessagesText.length,
    }));
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

async function ensureSession() {
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

  const options = { cwd, modelRuntime: rt, sessionManager: manager };
  const project = activeProject(cfg);
  const append = [];
  const projectRules = project ? readProjectAgents(project).text.trim() : "";
  if (projectRules) append.push(`## Правила проекта (${projectAgentsPath(project) || "granka.json"})\n${projectRules}`);
  if (append.length) {
    const loader = new pi.DefaultResourceLoader({
      cwd,
      agentDir: AGENT_DIR,
      appendSystemPrompt: append,
    });
    await loader.reload();
    options.resourceLoader = loader;
  }
  const model = cfg.model && rt.getModel("openrouter", cfg.model);
  if (model) options.model = model;

  const tools = createGrankaTools({
    getPi: () => pi,
    getRuntime: () => rt,
    getConfig: () => loadConfig(),
    getCwd: () => cwd,
    getAgentDir: () => AGENT_DIR,
    askUser: (question) => uiBridge.askUser(question),
    emit: (notice) => uiBridge.emit(notice),
  });
  const enabled = [];
  if (cfg.toolTodo !== false) enabled.push(tools.todoTool);
  if (cfg.toolAsk !== false) enabled.push(tools.askTool);
  if (cfg.toolWeb !== false) enabled.push(tools.webSearchTool, tools.webFetchTool);
  if (cfg.toolSubagents !== false) enabled.push(tools.subagentTool);
  if (cfg.toolDocs !== false) {
    const docTools = createDocTools({
      resolve: (p) => path.resolve(cwd, p),
      emit: (notice) => uiBridge.emit(notice),
    });
    enabled.push(
      docTools.outlineTool,
      docTools.readTool,
      docTools.searchTool,
      docTools.createTool,
      docTools.editTool,
      docTools.formatTool,
    );
  }
  if (enabled.length) options.customTools = enabled;

  ({ session } = await pi.createAgentSession(options));
  const newId = session.sessionManager.getSessionId();
  if (created || !(newId in projectMap)) bindSessionProject(newId, bindTo);
  if (cfg.thinkingLevel) session.setThinkingLevel(cfg.thinkingLevel);
  return session;
}

function textOf(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b.type === "text").map((b) => b.text).join("");
}

function usageOf(message) {
  const usage = message?.usage;
  if (!usage) return null;
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    total: usage.totalTokens,
    cost: usage.cost?.total ?? 0,
    billed: Boolean(usage.cost?.totalFromProvider),
  };
}

function contextOf(s) {
  const usage = s.contextUsage;
  return usage ? { tokens: usage.tokens, percent: usage.percent, window: usage.contextWindow } : null;
}

export async function lastUserPrompt() {
  const s = await ensureSession();
  const last = [...s.messages].reverse().find((m) => m.role === "user");
  return last ? textOf(last) : "";
}

// Current conversation, for re-rendering after a restart or session switch.
export async function history() {
  const s = await ensureSession();
  return {
    sessionId: s.sessionManager.getSessionId(),
    cwd: s.sessionManager.getCwd(),
    projectId: projectOfSession(s.sessionManager.getSessionId()),
    context: contextOf(s),
    messages: s.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, text: textOf(m) }))
      .filter((m) => m.text.trim()),
  };
}

let compacting = false;

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
  const state = mode === "steer" ? s.steer(text) : s.followUp(text);
  return { ok: true, state };
}

const ATTACH_DIR = path.join(AGENT_DIR, "attachments");
const STATS_FILE = path.join(AGENT_DIR, "stats.jsonl");
const PI_SETTINGS_FILE = path.join(AGENT_DIR, "settings.json");
const MEMORY_FILE = path.join(AGENT_DIR, "MEMORY.md"); // legacy, merged into AGENTS.md
// Strict chat ↔ project binding: a session belongs to exactly one project,
// independent of its folder (two projects may share a folder).
const PROJECTS_MAP_FILE = path.join(AGENT_DIR, "session-projects.json");

function clip(value) {
  // Every tool result is clipped: unbounded tool output is the cheapest way to
  // burn input tokens, and the model rarely needs the tail.
  const limit = Math.min(Math.max(Number(loadConfig().toolOutputLimit) || 4000, 500), 20000);
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
    cacheRead: usage.cacheRead,
    cost: usage.cost,
  });
  try {
    fs.appendFileSync(STATS_FILE, line + "\n");
  } catch {}
}

export function stats() {
  const rows = [];
  try {
    for (const line of fs.readFileSync(STATS_FILE, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {}
    }
  } catch {}

  const totals = { calls: 0, input: 0, output: 0, cost: 0 };
  const byModel = new Map();
  const byDay = new Map();
  const bySession = new Map();
  for (const row of rows) {
    totals.calls += 1;
    totals.input += row.input ?? 0;
    totals.output += row.output ?? 0;
    totals.cost += row.cost ?? 0;
    const model = row.model ?? "—";
    const modelRow = byModel.get(model) ?? { model, calls: 0, input: 0, output: 0, cost: 0 };
    modelRow.calls += 1;
    modelRow.input += row.input ?? 0;
    modelRow.output += row.output ?? 0;
    modelRow.cost += row.cost ?? 0;
    byModel.set(model, modelRow);
    const day = (row.ts ?? "").slice(0, 10);
    const dayRow = byDay.get(day) ?? { day, calls: 0, cost: 0, input: 0, output: 0 };
    dayRow.calls += 1;
    dayRow.cost += row.cost ?? 0;
    dayRow.input += row.input ?? 0;
    dayRow.output += row.output ?? 0;
    byDay.set(day, dayRow);
    const sessionRow = bySession.get(row.sessionId) ?? { sessionId: row.sessionId, calls: 0, cost: 0 };
    sessionRow.calls += 1;
    sessionRow.cost += row.cost ?? 0;
    bySession.set(row.sessionId, sessionRow);
  }

  return {
    totals,
    byModel: [...byModel.values()].sort((a, b) => b.cost - a.cost),
    byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)).slice(-14),
    bySession: [...bySession.values()].sort((a, b) => b.cost - a.cost).slice(0, 20),
  };
}

// Attachments are copied into the agent home so the session keeps working even
// if the original file moves; the model receives paths, images also as pixels.
export async function attachFiles(paths = []) {
  const cfg = loadConfig();
  const limitBytes = (Number(cfg.attachMaxMb) || 25) * 1024 * 1024;
  fs.mkdirSync(ATTACH_DIR, { recursive: true });
  const added = [];
  const skipped = [];
  for (const raw of paths) {
    try {
      const source = path.resolve(String(raw));
      const stat = fs.statSync(source);
      if (!stat.isFile()) {
        skipped.push({ path: source, reason: "не файл" });
        continue;
      }
      if (stat.size > limitBytes) {
        skipped.push({ path: source, reason: `больше ${Math.round(limitBytes / 1024 / 1024)} МБ` });
        continue;
      }
      const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const name = path.basename(source);
      const target = path.join(ATTACH_DIR, `${stamp}-${name}`);
      fs.copyFileSync(source, target);
      const ext = path.extname(name).toLowerCase();
      added.push({
        id: stamp,
        name,
        path: target,
        source,
        bytes: stat.size,
        kind: [".pdf", ".docx", ".md", ".txt", ".html", ".htm"].includes(ext)
          ? "document"
          : [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)
            ? "image"
            : "file",
      });
    } catch (err) {
      skipped.push({ path: String(raw), reason: String(err?.message ?? err) });
    }
  }
  return { ok: true, added, skipped };
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

export async function ask(question, onDelta, onTool, onNotify = () => {}, attachments = []) {
  const s = await ensureSession();
  const unsubscribe = s.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      onDelta(event.assistantMessageEvent.delta);
    } else if (event.type === "tool_execution_start") {
      onTool({ phase: "start", name: event.toolName, args: clip(event.args) });
    } else if (event.type === "tool_execution_end") {
      onTool({
        phase: "end",
        name: event.toolName,
        isError: event.isError,
        durationMs: event.durationMs,
        result: clip(event.result),
      });
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
        const mime = item.name.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
        images.push({ type: "image", data: fs.readFileSync(item.path).toString("base64"), mimeType: mime });
      } catch {}
    } else {
      docs.push(item);
    }
  }
  const attachmentNote = docs.length
    ? `\n\n[Вложения сессии — читай их через doc_outline/doc_read по этим путям]\n${docs
        .map((item) => `- ${item.path} (${path.extname(item.name).slice(1) || "файл"}, ${item.bytes} B)`)
        .join("\n")}`
    : "";
  try {
    await s.prompt(question + attachmentNote, images.length ? { images } : undefined);
    const last = [...s.messages].reverse().find((m) => m.role === "assistant");
    const usage = usageOf(last);
    recordUsage(s.sessionManager.getSessionId(), loadConfig().model, usage);
    return { ok: true, text: s.getLastAssistantText() ?? "", usage, context: contextOf(s) };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  } finally {
    unsubscribe();
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
}
