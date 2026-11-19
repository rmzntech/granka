import { app, BrowserWindow, Notification, dialog, ipcMain, nativeTheme, shell, systemPreferences } from "electron";
import fs from "node:fs";
import path from "node:path";
import * as agent from "./agent.mjs";
import { mcpStatus } from "./mcp.mjs";
import { setTrayBusy, bumpUnread } from "./tray-state.mjs";

const pendingQuestions = new Map();
let questionSeq = 0;

// The renderer is trusted UI, but IPC arguments are still untrusted input:
// never open or reveal a path that is not inside granka's own directories.
function insideDir(dir, target) {
  const resolved = path.resolve(String(target ?? ""));
  const base = path.resolve(dir);
  const rel = path.relative(base, resolved);
  return rel !== "" && !rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel);
}

const LIGHT_THEMES = ["granka-light", "claude", "nike", "cursor", "ibm", "opencode", "dell-1996", "apple"];

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
  const notifyTaskSettled = (win, notice) => {
    if (notice?.kind !== "backgroundTask") return;
    if (notice.task?.status !== "done" && notice.task?.status !== "error") return;
    if (agent.loadConfig().osNotifications === false || !win || win.isFocused()) return;
    bumpUnread();
    const notification = new Notification({
      title: notice.task.status === "error" ? "granka — задача с ошибкой" : "granka — фоновая задача",
      body: `${notice.task.agent}: ${notice.task.description}`.replace(/\s+/g, " ").slice(0, 160),
    });
    notification.on("click", () => { win.show(); win.focus(); });
    notification.show();
  };
  ipcMain.handle("tray:busy", (_e, value) => setTrayBusy(value));
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

  // The key never leaves main: renderer only learns whether one is set.
  const publicConfig = (cfg) => {
    const { apiKey, ...rest } = cfg ?? {};
    return { ...rest, hasApiKey: Boolean(apiKey) };
  };

  ipcMain.handle("config:load", () => publicConfig(agent.loadConfig()));
  ipcMain.handle("config:save", async (e, patch) => {
    const result = await agent.applyConfig(patch);
    if (result.ok) {
      const next = agent.loadConfig();
      syncNativeTheme(next);
      const message = publicConfig(next);
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("config:changed", message);
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
  ipcMain.handle("sessions:exportFile", async (e, ids) => {
    const result = agent.exportSessions(ids);
    if (!result.ok) return result;
    const win = BrowserWindow.fromWebContents(e.sender);
    const picked = win
      ? await dialog.showSaveDialog(win, { defaultPath: "granka-session.md", filters: [{ name: "Markdown", extensions: ["md"] }] })
      : await dialog.showSaveDialog({ defaultPath: "granka-session.md", filters: [{ name: "Markdown", extensions: ["md"] }] });
    if (picked.canceled || !picked.filePath) return { ok: false, error: "отменено" };
    fs.writeFileSync(picked.filePath, result.text);
    return { ok: true, path: picked.filePath };
  });
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
    const target = path.join(agent.SKILLS_DIR, String(folder ?? ""));
    if (!insideDir(agent.SKILLS_DIR, target)) return { ok: false, error: "недопустимый путь" };
    const { shell: sh } = await import("electron");
    sh.openPath(target);
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

  ipcMain.handle("projects:list", () => agent.listProjects());
  ipcMain.handle("projects:save", (_e, project) => agent.saveProject(project));
  ipcMain.handle("projects:delete", (_e, id) => agent.deleteProject(id));
  ipcMain.handle("projects:activate", (_e, id) => agent.activateProject(id));
  ipcMain.handle("projects:rules", (_e, id) => agent.getProjectRules(id));
  ipcMain.handle("projects:rulesForPath", (_e, dir) => agent.rulesForPath(dir));
  ipcMain.handle("projects:saveRules", (_e, id, text) => agent.saveProjectRules(id, text));
  ipcMain.handle("memory:get", () => agent.getMemory());
  ipcMain.handle("memory:save", (_e, text) => agent.saveMemory(text));
  ipcMain.handle("projects:memory", (_e, id) => agent.getProjectMemory(id));
  ipcMain.handle("projects:saveMemory", (_e, id, text) => agent.saveProjectMemory(id, text));

  ipcMain.handle("subagents:list", async () => {
    const { subagentList } = await import("./subagents.mjs");
    return subagentList(agent.AGENT_DIR);
  });
  ipcMain.handle("subagents:reveal", () => {
    const dir = path.join(agent.AGENT_DIR, "subagents");
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
    return { ok: true, path: dir };
  });
  ipcMain.handle("tasks:list", () => agent.listBackgroundTasks());
  ipcMain.handle("tasks:cancel", (_e, id) => agent.cancelBackgroundTask(id));
  ipcMain.handle("mcp:status", () => mcpStatus(agent.loadConfig().mcpServers));
  ipcMain.handle("chat:contextBreakdown", () => agent.contextBreakdown());

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

  // One ask at a time: the agent session and the UI bridge are global, so
  // concurrent asks would interleave deltas and question answers.
  let askQueue = Promise.resolve();
  ipcMain.handle("chat:ask", (e, question, attachments) => {
    const run = askQueue.then(() => handleAsk(e, question, attachments));
    askQueue = run.catch(() => {});
    return run;
  });

  async function handleAsk(e, question, attachments) {
    const win = BrowserWindow.fromWebContents(e.sender);
    agent.setUiBridge({
      askUser: (payload) =>
        new Promise((resolve) => {
          if (e.sender.isDestroyed()) return resolve("");
          const id = `q${++questionSeq}`;
          pendingQuestions.set(id, resolve);
          try {
            e.sender.send("chat:question", { id, ...payload });
          } catch (err) {
            pendingQuestions.delete(id);
            console.error("[granka] question send:", err?.message ?? err);
            return resolve("");
          }
          setTimeout(() => {
            if (!pendingQuestions.has(id)) return;
            pendingQuestions.delete(id);
            // The renderer still shows the modal: dismiss it, otherwise the
            // dialog lingers with no way to answer (the promise is settled).
            try { e.sender.send("chat:question", { id, closed: true }); } catch {}
            resolve("");
          }, 300000);
        }),
      emit: (notice) => forwardNotice(notice),
    });
    const forwardNotice = (notice) => {
      if (!e.sender.isDestroyed()) e.sender.send("chat:notice", notice);
      notifyTaskSettled(win, notice);
    };
    const result = await agent.ask(
      question,
      (delta) => { if (!e.sender.isDestroyed()) e.sender.send("chat:delta", delta); },
      (tool) => { if (!e.sender.isDestroyed()) e.sender.send("chat:tool", tool); },
      (notice) => forwardNotice(notice),
      Array.isArray(attachments) ? attachments : [],
      (thinking) => { if (!e.sender.isDestroyed()) e.sender.send("chat:thinking", thinking); },
    );
    // OS notification when the window is in the background (feature: notify on settle)
    const wantsNotify = agent.loadConfig().osNotifications !== false;
    if (wantsNotify && win && !win.isFocused() && result.ok) {
      bumpUnread();
      const notification = new Notification({
        title: "granka",
        body: (result.text || "готово").replace(/\s+/g, " ").slice(0, 160),
      });
      notification.on("click", () => {
        win?.show();
        win?.focus();
      });
      notification.show();
    }
    return result;
  }
  ipcMain.handle("chat:queue", (_e, text, mode) => agent.queueMessage(text, mode));
  ipcMain.handle("attach:add", (e, paths) =>
    agent.attachFiles(paths, (progress) => {
      if (!e.sender.isDestroyed()) e.sender.send("attach:progress", progress);
    }),
  );
  ipcMain.handle("attach:dataUrl", (_e, filePath) => agent.attachmentDataUrl(filePath));
  ipcMain.handle("doc:preview", (_e, filePath) => agent.docPreview(filePath));
  ipcMain.handle("attach:image", (_e, payload) => agent.saveAttachmentImage(payload));
  ipcMain.handle("attach:text", (_e, payload) => agent.attachText(payload));
  ipcMain.handle("stats:get", () => agent.stats());
  ipcMain.handle("app:paths", () => agent.appPaths());
  ipcMain.handle("backup:export", async (e) => {
    const win = winOf(e);
    const result = win
      ? await dialog.showSaveDialog(win, { defaultPath: `granka-backup-${new Date().toISOString().slice(0, 10)}.zip`, filters: [{ name: "Zip", extensions: ["zip"] }] })
      : await dialog.showSaveDialog({ defaultPath: `granka-backup-${new Date().toISOString().slice(0, 10)}.zip`, filters: [{ name: "Zip", extensions: ["zip"] }] });
    if (result.canceled || !result.filePath) return { ok: false, error: "отменено" };
    return agent.exportBackup(result.filePath);
  });
  ipcMain.handle("backup:import", async (e) => {
    const win = winOf(e);
    const options = { properties: ["openFile"], filters: [{ name: "Zip", extensions: ["zip"] }] };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return { ok: false, error: "отменено" };
    const { response } = await dialog.showMessageBox(win ?? undefined, {
      type: "warning", buttons: ["Восстановить", "Отмена"], defaultId: 1, cancelId: 1,
      message: "Восстановить данные granka из бэкапа?",
      detail: "Текущие сессии, настройки и скиллы будут заменены файлами из архива. Ключи (auth.json) не восстанавливаются.",
    });
    if (response !== 0) return { ok: false, error: "отменено" };
    return agent.importBackup(result.filePaths[0]);
  });
  ipcMain.handle("compaction:apply", async () => agent.applyCompactionSettings());
  ipcMain.handle("shell:reveal", (_e, target) => {
    const allowed = [agent.AGENT_DIR, agent.SESSION_DIR];
    if (!allowed.some((dir) => insideDir(dir, target))) {
      return { ok: false, error: "путь вне каталогов granka" };
    }
    shell.showItemInFolder(path.resolve(String(target)));
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
    const { randomBytes } = await import("node:crypto");
    const file = join(tmpdir(), `granka-preview-${randomBytes(8).toString("hex")}.html`);
    const csp = "default-src 'self' data:; script-src 'none'; style-src 'unsafe-inline' data:; img-src data:; font-src 'self' data:";
    await fsp.writeFile(file, `<!doctype html><html><head><meta charset="utf-8" /><meta http-equiv="Content-Security-Policy" content="${csp}" /></head><body>${String(payload?.html ?? "")}</body></html>`, { encoding: "utf8", mode: 0o600 });
    const win = new BrowserWindow({
      width: 900,
      height: 700,
      title: payload?.title ?? "Превью",
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    win.setMenuBarVisibility(false);
    win.on("closed", () => fsp.rm(file, { force: true }).catch(() => {}));
    await win.loadFile(file);
    return { ok: true };
  });
  ipcMain.handle("chat:compact", () => agent.compactNow());
  ipcMain.handle("checkpoint:restore", (_e, id) => agent.restoreCheckpoint(id));
  ipcMain.handle("chat:compactCancel", () => agent.cancelCompaction());
  ipcMain.handle("chat:lastPrompt", () => agent.lastUserPrompt());
  ipcMain.handle("app:version", () => app.getVersion());
  ipcMain.handle("app:wallpaper", (_e, target) => agent.wallpaperDataUrl(target));
  ipcMain.handle("app:accent", () => {
    try {
      const value = systemPreferences.getAccentColor?.().replace("#", "") ?? "";
      return value ? `#${value.slice(0, 6)}` : "";
    } catch {
      return "";
    }
  });
  ipcMain.handle("window:openSettings", (_e, pane) => openSettings(pane ?? ""));
  ipcMain.handle("chat:abort", () => agent.abort());

  ipcMain.handle("dialog:confirm", async (_e, message, detail, confirmLabel = "Удалить") => {
    const { response } = await dialog.showMessageBox({
      type: "warning",
      buttons: [confirmLabel, "Отмена"],
      defaultId: 1,
      cancelId: 1,
      message: String(message ?? "Подтвердите действие"),
      detail: String(detail ?? ""),
    });
    return response === 0;
  });

  ipcMain.handle("dialog:pickFiles", async (e) => {
    const win = winOf(e);
    const options = {
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Документы", extensions: ["pdf", "docx", "md", "txt", "html", "xlsx", "ods", "csv", "rtf"] },
        { name: "Изображения", extensions: ["png", "jpg", "jpeg", "webp", "gif"] },
      ],
    };
    // Parent the dialog to the calling window: without it the native dialog
    // can open behind the frameless window and looks unresponsive.
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths;
  });

  // Background image: images-only and FIRST, so PNG/JPG are visible
  // immediately (the attachments dialog starts on "Documents" and hides them).
  ipcMain.handle("dialog:pickImage", async (e) => {
    const win = winOf(e);
    const options = {
      properties: ["openFile"],
      filters: [
        { name: "Изображения", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"] },
        { name: "Все файлы", extensions: ["*"] },
      ],
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? "" : result.filePaths[0];
  });

  ipcMain.handle("dialog:pickDir", async (e) => {
    const win = winOf(e);
    const options = { properties: ["openDirectory", "createDirectory"] };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? "" : result.filePaths[0];
  });
}
