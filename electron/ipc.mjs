import { BrowserWindow, Notification, dialog, ipcMain, nativeTheme, shell, systemPreferences } from "electron";
import * as agent from "./agent.mjs";

const pendingQuestions = new Map();
let questionSeq = 0;

const LIGHT_THEMES = ["granka-light", "catppuccin-latte", "rose-pine-dawn", "nord-light", "gruvbox-light", "solarized-light"];

function syncNativeTheme(config) {
  const pref = config?.theme ?? "auto";
  if (pref === "auto") {
    nativeTheme.themeSource = "system";
    return;
  }
  nativeTheme.themeSource = LIGHT_THEMES.includes(pref) ? "light" : "dark";
}

export function registerIpc({ openSettings } = {}) {
  const winOf = (event) => BrowserWindow.fromWebContents(event.sender);
  ipcMain.handle("window:minimize", (e) => winOf(e)?.minimize());
  ipcMain.handle("window:toggleMaximize", (e) => {
    const win = winOf(e);
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle("window:close", (e) => winOf(e)?.close());
  ipcMain.handle("window:isMaximized", (e) => Boolean(winOf(e)?.isMaximized()));

  ipcMain.handle("config:load", () => agent.loadConfig());
  ipcMain.handle("config:save", async (e, patch) => {
    const result = await agent.applyConfig(patch);
    if (result.ok) {
      const next = agent.loadConfig();
      syncNativeTheme(next);
      const message = { config: next };
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("config:changed", message.config);
      }
    }
    return result;
  });
  ipcMain.handle("models:list", () => agent.listModels());

  ipcMain.handle("sessions:list", (_e, query, options) => agent.listSessions(query, options ?? {}));
  ipcMain.handle("sessions:new", () => agent.newSession());
  ipcMain.handle("sessions:open", (_e, id) => agent.openSession(id));
  ipcMain.handle("sessions:rename", (_e, id, name) => agent.renameSession(id, name));
  ipcMain.handle("sessions:duplicate", (_e, id) => agent.duplicateSession(id));
  ipcMain.handle("sessions:assign", (_e, id, projectId) => agent.assignSessionToProject(id, projectId));
  ipcMain.handle("sessions:export", (_e, ids) => agent.exportSessions(ids));
  ipcMain.handle("sessions:reveal", (_e, id) => {
    const info = agent.revealSession(id);
    if (info.ok) shell.showItemInFolder(info.path);
    return info;
  });
  ipcMain.handle("sessions:autoTitle", (_e, id) => agent.autoTitle(id));

  ipcMain.handle("skills:list", () => agent.skillsDetailed());
  ipcMain.handle("skills:delete", (_e, folder) => agent.deleteSkill(folder));
  ipcMain.handle("skills:install", () => agent.installBundledSkills());
  ipcMain.handle("skills:reveal", async (_e, folder) => {
    const { shell: sh } = await import("electron");
    sh.openPath(String(folder));
    return { ok: true };
  });
  ipcMain.handle("sessions:delete", async (_e, id) => {
    const { response } = await dialog.showMessageBox({
      type: "warning",
      buttons: ["Удалить", "Отмена"],
      defaultId: 1,
      cancelId: 1,
      message: "Удалить сессию?",
      detail: "Файл сессии будет удалён с диска без возможности восстановления.",
    });
    return response === 0 ? agent.deleteSession(id) : { ok: false, error: "отменено" };
  });

  ipcMain.handle("rules:get", () => agent.getRules());
  ipcMain.handle("rules:save", (_e, rules) => agent.saveRules(rules));

  ipcMain.handle("projects:list", () => agent.listProjects());
  ipcMain.handle("projects:save", (_e, project) => agent.saveProject(project));
  ipcMain.handle("projects:delete", (_e, id) => agent.deleteProject(id));
  ipcMain.handle("projects:activate", (_e, id) => agent.activateProject(id));
  ipcMain.handle("projects:rules", (_e, id) => agent.getProjectRules(id));
  ipcMain.handle("projects:saveRules", (_e, id, text) => agent.saveProjectRules(id, text));

  ipcMain.handle("subagents:list", async () => {
    const { subagentList } = await import("./subagents.mjs");
    return subagentList();
  });

  ipcMain.handle("commands:list", () => ({
    prompts: agent.listPrompts(),
    skills: agent.listSkills(),
  }));

  ipcMain.handle("chat:history", () => agent.history());
  ipcMain.handle("chat:answer", (_e, id, answer) => {
    const resolve = pendingQuestions.get(id);
    if (!resolve) return { ok: false };
    pendingQuestions.delete(id);
    resolve(answer);
    return { ok: true };
  });

  ipcMain.handle("chat:ask", async (e, question, attachments) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    agent.setUiBridge({
      askUser: (payload) =>
        new Promise((resolve) => {
          const id = `q${++questionSeq}`;
          pendingQuestions.set(id, resolve);
          e.sender.send("chat:question", { id, ...payload });
          setTimeout(() => {
            if (!pendingQuestions.has(id)) return;
            pendingQuestions.delete(id);
            resolve("");
          }, 300000);
        }),
      emit: (notice) => e.sender.send("chat:notice", notice),
    });
    const result = await agent.ask(
      question,
      (delta) => e.sender.send("chat:delta", delta),
      (tool) => e.sender.send("chat:tool", tool),
      (notice) => e.sender.send("chat:notice", notice),
      Array.isArray(attachments) ? attachments : [],
    );
    // OS notification when the window is in the background (feature: notify on settle)
    const wantsNotify = agent.loadConfig().osNotifications !== false;
    if (wantsNotify && win && !win.isFocused() && result.ok) {
      new Notification({
        title: "granka",
        body: (result.text || "готово").replace(/\s+/g, " ").slice(0, 160),
      }).show();
    }
    return result;
  });
  ipcMain.handle("chat:queue", (_e, text, mode) => agent.queueMessage(text, mode));
  ipcMain.handle("attach:add", (_e, paths) => agent.attachFiles(paths));
  ipcMain.handle("attach:image", (_e, payload) => agent.saveAttachmentImage(payload));
  ipcMain.handle("attach:text", (_e, payload) => agent.attachText(payload));
  ipcMain.handle("stats:get", () => agent.stats());
  ipcMain.handle("app:paths", () => agent.appPaths());
  ipcMain.handle("compaction:apply", async () => agent.applyCompactionSettings());
  ipcMain.handle("shell:reveal", (_e, target) => {
    shell.showItemInFolder(String(target));
    return { ok: true };
  });

  // Key check without any paid dependency: OpenRouter's own /key endpoint.
  ipcMain.handle("config:checkKey", async () => {
    const { apiKey } = agent.loadConfig();
    if (!apiKey) return { ok: false, error: "ключ не задан" };
    try {
      const response = await fetch("https://openrouter.ai/api/v1/key", {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      if (!response.ok) {
        return { ok: false, error: response.status === 401 ? "ключ отклонён (401)" : `HTTP ${response.status}` };
      }
      const data = await response.json();
      const info = data?.data ?? {};
      return {
        ok: true,
        label: info.label ?? "ключ",
        limit: info.limit ?? null,
        usage: info.usage ?? null,
        freeTier: Boolean(info.is_free_tier),
      };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  });

  // Artifacts: render an HTML document in its own sandboxed window.
  ipcMain.handle("preview:open", async (_e, payload) => {
    const fsp = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const file = join(tmpdir(), `granka-preview-${Date.now()}.html`);
    await fsp.writeFile(file, String(payload?.html ?? ""), "utf8");
    const win = new BrowserWindow({
      width: 900,
      height: 700,
      title: payload?.title ?? "Превью",
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    win.setMenuBarVisibility(false);
    await win.loadFile(file);
    return { ok: true, file };
  });
  ipcMain.handle("chat:compact", () => agent.compactNow());
  ipcMain.handle("chat:compactCancel", () => agent.cancelCompaction());
  ipcMain.handle("chat:lastPrompt", () => agent.lastUserPrompt());
  ipcMain.handle("app:accent", () => {
    try {
      const value = systemPreferences.getAccentColor?.().replace("#", "") ?? "";
      return value ? `#${value.slice(0, 6)}` : "";
    } catch {
      return "";
    }
  });
  ipcMain.handle("window:openSettings", () => openSettings());
  ipcMain.handle("chat:abort", () => agent.abort());

  ipcMain.handle("dialog:confirm", async (_e, message, detail) => {
    const { response } = await dialog.showMessageBox({
      type: "warning",
      buttons: ["Удалить", "Отмена"],
      defaultId: 1,
      cancelId: 1,
      message: String(message ?? "Подтвердите действие"),
      detail: String(detail ?? ""),
    });
    return response === 0;
  });

  ipcMain.handle("dialog:pickFiles", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Документы", extensions: ["pdf", "docx", "md", "txt", "html"] },
        { name: "Изображения", extensions: ["png", "jpg", "jpeg", "webp", "gif"] },
        { name: "Все файлы", extensions: ["*"] },
      ],
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle("dialog:pickDir", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? "" : result.filePaths[0];
  });
}
