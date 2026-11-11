import { app, BrowserWindow, Menu, nativeTheme } from "electron";
import { fileURLToPath } from "node:url";
import * as agent from "./agent.mjs";
import { registerIpc } from "./ipc.mjs";

await agent.init(); // isolate ~/.granka before anything else touches pi
registerIpc({ openSettings: () => openSettings() });

const isMac = process.platform === "darwin";
const isWindows = process.platform === "win32";

// Windows notifications and taskbar grouping need an explicit app id.
if (isWindows) app.setAppUserModelId("dev.granka.app");
const renderer = (name) => fileURLToPath(new URL(`../renderer/${name}`, import.meta.url));
const preload = fileURLToPath(new URL("./preload.cjs", import.meta.url));

let mainWindow;
let settingsWindow;

const send = (channel) => {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
  win?.webContents.send(channel);
};

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 780,
    // everything must stay visible: sidebar + reading column + toolbar controls
    minWidth: 900,
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
    webPreferences: { preload, contextIsolation: true },
  });
  mainWindow.setMenuBarVisibility(!isMac);
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
  mainWindow.loadFile(renderer("index.html"));
}

function openSettings() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 560,
    height: 620,
    minWidth: 460,
    minHeight: 420,
    title: "Настройки",
    parent: mainWindow,
    backgroundColor: "#202124",
    show: false,
    frame: isMac,
    titleBarStyle: isMac ? "hiddenInset" : undefined,
    trafficLightPosition: isMac ? { x: 12, y: 12 } : undefined,
    webPreferences: { preload, contextIsolation: true },
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.once("ready-to-show", () => settingsWindow.show());
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
        { label: "Все сессии", accelerator: "CmdOrCtrl+Shift+S", click: () => send("menu:all-sessions") },
        { type: "separator" },
        { label: "Настройки…", accelerator: "CmdOrCtrl+,", click: openSettings },
        ...(isMac ? [] : [{ type: "separator" }, { role: "quit" }]),
      ],
    },
    { role: "editMenu" },
    {
      label: "Вид",
      submenu: [
        { label: "Боковая панель", accelerator: "CmdOrCtrl+B", click: () => send("menu:toggle-sidebar") },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "toggleDevTools" },
        { role: "reload" },
      ],
    },
    { role: "windowMenu" },
  ]),
);

// Windows paints its own 1px frame around frameless windows: it follows the
// system appearance, so keep nativeTheme in sync with the app theme.
const LIGHT_THEMES = ["granka-light", "catppuccin-latte", "rose-pine-dawn", "nord-light", "gruvbox-light", "solarized-light"];

function syncNativeTheme(config) {
  const pref = config?.theme ?? "auto";
  if (pref === "auto") {
    nativeTheme.themeSource = "system";
    return;
  }
  nativeTheme.themeSource = LIGHT_THEMES.includes(pref) ? "light" : "dark";
}

app.whenReady().then(() => {
  try {
    syncNativeTheme(agent.loadConfig());
  } catch {}
  createMainWindow();
});
app.on("window-all-closed", () => app.quit());
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});
