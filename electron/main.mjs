import { app, BrowserWindow, Menu, Tray, dialog, nativeImage, nativeTheme, shell } from "electron";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as agent from "./agent.mjs";
import { registerIpc } from "./ipc.mjs";
import { getTrayState, resetUnread, setTrayListener } from "./tray-state.mjs";

// Single instance: a second process would race on ~/.granka files.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// File log in ~/.granka/logs (console alone is lost on crash/quit).
const LOG_FILE = path.join(os.homedir(), ".granka", "logs", "granka.log");
function logLine(tag, value) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} [${tag}] ${value}\n`);
  } catch {}
}
process.on("uncaughtException", (err) => logLine("uncaught", err?.stack ?? err));
process.on("unhandledRejection", (err) => logLine("unhandled", err?.stack ?? err));

// External links: https only, opened in the system browser, never in-app.
function guardWindow(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://") || !url.includes("renderer")) {
      event.preventDefault();
      if (url.startsWith("https://")) shell.openExternal(url);
    }
  });
}

registerIpc({ openSettings: () => openSettings() });

const isMac = process.platform === "darwin";
const isWindows = process.platform === "win32";

// Windows notifications and taskbar grouping need an explicit app id.
if (isWindows) app.setAppUserModelId("dev.granka.app");
const renderer = (name) => fileURLToPath(new URL(`../renderer/${name}`, import.meta.url));
const preload = fileURLToPath(new URL("./preload.cjs", import.meta.url));

let mainWindow;
let settingsWindow;
let tray;

const trayIcon = (name) => nativeImage.createFromPath(fileURLToPath(new URL(`../build/icons/${name}.png`, import.meta.url)));

// System tray: click focuses the window, a dot marks an active run, a badge
// counts unseen completion notifications.
function setupTray() {
  if (tray || !mainWindow) return;
  tray = new Tray(trayIcon("tray-idle"));
  tray.setToolTip("granka");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Открыть окно",
        click: () => {
          mainWindow?.show();
          mainWindow?.focus();
        },
      },
      { type: "separator" },
      {
        label: "Закрыть полностью",
        click: () => app.quit(),
      },
    ]),
  );
  tray.on("click", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
  mainWindow.on("focus", () => {
    resetUnread();
  });
}

function refreshTrayIcon() {
  if (!tray) return;
  const { trayBusy, unreadNotifications } = getTrayState();
  tray.setImage(trayIcon(unreadNotifications > 0 ? "tray-badge" : trayBusy ? "tray-dot" : "tray-idle"));
  tray.setToolTip(
    trayBusy ? "granka — агент работает" : unreadNotifications > 0 ? `granka — ${unreadNotifications} уведомлений` : "granka",
  );
}

setTrayListener(refreshTrayIcon);

const send = (channel) => {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
  win?.webContents.send(channel);
};

const WINDOW_STATE_FILE = path.join(os.homedir(), ".granka", "window.json");
function savedBounds() {
  try {
    const data = JSON.parse(fs.readFileSync(WINDOW_STATE_FILE, "utf8"));
    if (Number.isFinite(data.width) && Number.isFinite(data.height)) return data;
  } catch {}
  return null;
}

function createMainWindow() {
  const saved = savedBounds();
  mainWindow = new BrowserWindow({
    ...(saved ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height } : { width: 1120, height: 780 }),
    // everything must stay visible: sidebar + reading column + toolbar controls
    minWidth: 760,
    minHeight: 560,
    title: "granka",
    backgroundColor: "#202124",
    // macOS: native traffic lights over our own unified toolbar row.
    // macOS keeps the native traffic lights; everywhere else the frame is ours so
    // the buttons follow the theme and never cover our own toolbar items.
    frame: isMac,
    titleBarStyle: isMac ? "hiddenInset" : undefined,
    trafficLightPosition: isMac ? { x: 14, y: 18 } : undefined,
    vibrancy: isMac ? "sidebar" : undefined,
    webPreferences: { preload, contextIsolation: true, sandbox: true },
  });
  mainWindow.setMenuBarVisibility(!isMac);
  guardWindow(mainWindow);
  mainWindow.on("close", () => {
    try {
      fs.mkdirSync(path.dirname(WINDOW_STATE_FILE), { recursive: true });
      fs.writeFileSync(WINDOW_STATE_FILE, JSON.stringify({ ...mainWindow.getBounds(), zoom: mainWindow.webContents.zoomFactor }), { mode: 0o600 });
    } catch {}
  });
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
  if (saved?.zoom && Number.isFinite(saved.zoom)) {
    mainWindow.webContents.once("did-finish-load", () => {
      mainWindow.webContents.setZoomFactor(saved.zoom);
    });
  }
  mainWindow.loadFile(renderer("index.html"));
}

function openSettings(pane = "") {
  if (settingsWindow) {
    settingsWindow.focus();
    if (pane) settingsWindow.webContents.send("settings:pane", pane);
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 720,
    height: 640,
    minWidth: 600,
    minHeight: 480,
    title: "Настройки",
    parent: mainWindow,
    backgroundColor: "#202124",
    show: false,
    frame: isMac,
    titleBarStyle: isMac ? "hiddenInset" : undefined,
    trafficLightPosition: isMac ? { x: 12, y: 12 } : undefined,
    webPreferences: { preload, contextIsolation: true, sandbox: true },
  });
  settingsWindow.setMenuBarVisibility(false);
  guardWindow(settingsWindow);
  settingsWindow.once("ready-to-show", () => {
    settingsWindow.show();
    if (pane) settingsWindow.webContents.send("settings:pane", pane);
  });
  settingsWindow.on("closed", () => {
    settingsWindow = undefined;
  });
  settingsWindow.loadFile(renderer("settings.html"));
}

// Standard macOS-style menus; every command also exists as a shortcut in the UI.
Menu.setApplicationMenu(
  Menu.buildFromTemplate([
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "Файл",
      submenu: [
        { label: "Новый диалог", accelerator: "CmdOrCtrl+N", click: () => send("menu:new-chat") },
        { label: "Все диалоги", accelerator: "CmdOrCtrl+Shift+L", click: () => send("menu:all-sessions") },
        ...(isMac
          ? []
          : [
              { type: "separator" },
              { label: "Настройки…", accelerator: "CmdOrCtrl+,", click: openSettings },
              { type: "separator" },
              { role: "quit" },
            ]),
      ],
    },
    { role: "editMenu" },
    {
      label: "Вид",
      submenu: [
        { label: "Боковая панель", accelerator: "CmdOrCtrl+B", click: () => send("menu:toggle-sidebar") },
        { type: "separator" },
        { label: "Аналитика", accelerator: "CmdOrCtrl+Alt+A", click: () => send("menu:stats") },
        { label: "Проект", accelerator: "CmdOrCtrl+Alt+P", click: () => send("menu:project") },
        { label: "Сжать контекст", accelerator: "CmdOrCtrl+Alt+C", click: () => send("menu:compact") },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        // DevTools/reload would lose streaming state: developer-only builds.
        ...(!app.isPackaged
          ? [{ role: "toggleDevTools" }, { role: "reload" }]
          : []),
      ],
    },
    { role: "windowMenu" },
  ]),
);

// Windows paints its own 1px frame around frameless windows: it follows the
// system appearance, so keep nativeTheme in sync with the app theme.
const LIGHT_THEMES = ["granka-light", "claude", "nike", "cursor", "ibm", "opencode", "dell-1996", "apple"];

function syncNativeTheme(config) {
  const pref = config?.theme ?? "auto";
  if (pref === "auto") {
    nativeTheme.themeSource = "system";
    return;
  }
  nativeTheme.themeSource = LIGHT_THEMES.includes(pref) ? "light" : "dark";
}

app.whenReady().then(async () => {
  try {
    await agent.init(); // isolate ~/.granka before anything else touches pi
  } catch (err) {
    console.error("[granka] init failed:", err);
    dialog.showErrorBox("granka не запустился", `Не удалось инициализировать агент:\n${err?.message ?? err}`);
    app.quit();
    return;
  }
  try {
    syncNativeTheme(agent.loadConfig());
  } catch (err) {
    console.error("[granka] theme sync:", err?.message ?? err);
  }
  createMainWindow();
  setupTray();
  logLine("start", `granka ${app.getVersion()}`);
});
let shuttingDown = false;
app.on("before-quit", async (event) => {
  if (shuttingDown) return;
  shuttingDown = true;
  event.preventDefault();
  try { await agent.shutdown(); } catch (err) { logLine("shutdown", err?.message ?? err); }
  app.quit();
});
app.on("window-all-closed", () => app.quit());
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
    setupTray();
  }
});
