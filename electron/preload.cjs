const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("granka", {
  platform: process.platform,
  loadConfig: () => ipcRenderer.invoke("config:load"),
  saveConfig: (patch) => ipcRenderer.invoke("config:save", patch),
  listModels: () => ipcRenderer.invoke("models:list"),

  listSessions: (query, options) => ipcRenderer.invoke("sessions:list", query, options),
  newSession: () => ipcRenderer.invoke("sessions:new"),
  openSession: (id) => ipcRenderer.invoke("sessions:open", id),
  renameSession: (id, name) => ipcRenderer.invoke("sessions:rename", id, name),
  duplicateSession: (id) => ipcRenderer.invoke("sessions:duplicate", id),
  assignSession: (id, projectId) => ipcRenderer.invoke("sessions:assign", id, projectId),
  exportSessions: (ids) => ipcRenderer.invoke("sessions:export", ids),
  revealSession: (id) => ipcRenderer.invoke("sessions:reveal", id),
  autoTitle: (id) => ipcRenderer.invoke("sessions:autoTitle", id),

  listSkills: () => ipcRenderer.invoke("skills:list"),
  deleteSkill: (folder) => ipcRenderer.invoke("skills:delete", folder),
  installSkills: () => ipcRenderer.invoke("skills:install"),
  revealSkill: (folder) => ipcRenderer.invoke("skills:reveal", folder),
  deleteSession: (id) => ipcRenderer.invoke("sessions:delete", id),

  getRules: () => ipcRenderer.invoke("rules:get"),
  saveRules: (rules) => ipcRenderer.invoke("rules:save", rules),

  listProjects: () => ipcRenderer.invoke("projects:list"),
  saveProject: (project) => ipcRenderer.invoke("projects:save", project),
  deleteProject: (id) => ipcRenderer.invoke("projects:delete", id),
  activateProject: (id) => ipcRenderer.invoke("projects:activate", id),
  getProjectRules: (id) => ipcRenderer.invoke("projects:rules", id),
  saveProjectRules: (id, text) => ipcRenderer.invoke("projects:saveRules", id, text),

  listCommands: () => ipcRenderer.invoke("commands:list"),
  listSubagents: () => ipcRenderer.invoke("subagents:list"),

  attachFiles: (paths) => ipcRenderer.invoke("attach:add", paths),
  attachImage: (payload) => ipcRenderer.invoke("attach:image", payload),
  attachText: (payload) => ipcRenderer.invoke("attach:text", payload),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  getStats: () => ipcRenderer.invoke("stats:get"),
  paths: () => ipcRenderer.invoke("app:paths"),
  applyCompaction: () => ipcRenderer.invoke("compaction:apply"),
  checkKey: () => ipcRenderer.invoke("config:checkKey"),
  revealPath: (target) => ipcRenderer.invoke("shell:reveal", target),
  openPreview: (payload) => ipcRenderer.invoke("preview:open", payload),

  history: () => ipcRenderer.invoke("chat:history"),
  ask: (question, attachments) => ipcRenderer.invoke("chat:ask", question, attachments),
  queue: (text, mode) => ipcRenderer.invoke("chat:queue", text, mode),
  compact: () => ipcRenderer.invoke("chat:compact"),
  abort: () => ipcRenderer.invoke("chat:abort"),
  pickDir: () => ipcRenderer.invoke("dialog:pickDir"),
  pickFiles: () => ipcRenderer.invoke("dialog:pickFiles"),
  confirm: (message, detail) => ipcRenderer.invoke("dialog:confirm", message, detail),

  onDelta: (cb) => ipcRenderer.on("chat:delta", (_event, delta) => cb(delta)),
  onTool: (cb) => ipcRenderer.on("chat:tool", (_event, tool) => cb(tool)),
  onNotice: (cb) => ipcRenderer.on("chat:notice", (_event, notice) => cb(notice)),
  onQuestion: (cb) => ipcRenderer.on("chat:question", (_event, payload) => cb(payload)),
  answer: (id, answer) => ipcRenderer.invoke("chat:answer", id, answer),
  onConfigChanged: (cb) => ipcRenderer.on("config:changed", (_event, config) => cb(config)),
  onMenu: (cb) => {
    ipcRenderer.on("menu:new-chat", () => cb("new-chat"));
    ipcRenderer.on("menu:all-sessions", () => cb("all-sessions"));
    ipcRenderer.on("menu:toggle-sidebar", () => cb("toggle-sidebar"));
  },

  windowMinimize: () => ipcRenderer.invoke("window:minimize"),
  windowToggleMaximize: () => ipcRenderer.invoke("window:toggleMaximize"),
  windowClose: () => ipcRenderer.invoke("window:close"),
  windowIsMaximized: () => ipcRenderer.invoke("window:isMaximized"),
  openSettings: () => ipcRenderer.invoke("window:openSettings"),
  accentColor: () => ipcRenderer.invoke("app:accent"),
  lastPrompt: () => ipcRenderer.invoke("chat:lastPrompt"),
  cancelCompaction: () => ipcRenderer.invoke("chat:compactCancel"),
});
