// Settings window smoke test: loads renderer/settings.html on its own.
import { app, BrowserWindow } from "electron";
import { fileURLToPath } from "node:url";
import * as agent from "../electron/agent.mjs";
import { registerIpc } from "../electron/ipc.mjs";

await agent.init();
registerIpc({ openSettings: () => {} });
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: fileURLToPath(new URL("../electron/preload.cjs", import.meta.url)),
      contextIsolation: true,
    },
  });
  const errors = [];
  win.webContents.on("console-message", (event) => {
    if (event.level === "error") errors.push(event.message);
  });
  await win.loadFile(fileURLToPath(new URL("../renderer/settings.html", import.meta.url)));

  const deadline = Date.now() + 30000;
  let models = 0;
  while (Date.now() < deadline) {
    models = await win.webContents.executeJavaScript('document.querySelectorAll("#modelRows .modelRow").length');
    if (models > 10) break;
    await new Promise((r) => setTimeout(r, 300));
  }

  const state = await win.webContents.executeJavaScript(`({
    groups: document.querySelectorAll(".settingsPane").length,
    navItems: document.querySelectorAll(".navItem").length,
    theme: document.querySelector("#themeSelect .selectLabel")?.textContent,
    dropdowns: document.querySelectorAll(".selectBtn").length,
    resolved: document.body.dataset.theme,
    secure: document.getElementById("apiKey").type,
    models: document.querySelectorAll("#modelRows .modelRow").length,
    prices: [...document.querySelectorAll("#modelRows .modelPrice")].slice(0, 3).map((el) => el.textContent),
    modelGroups: [...document.querySelectorAll("#modelRows .modelGroup")].map((el) => el.textContent),
    keyCheck: !!document.getElementById("checkKey"),
    compaction: {
      toggle: !!document.getElementById("compactionEnabled"),
      reserve: document.getElementById("compactionReserve")?.value,
    },

    switches: document.querySelectorAll(".switchRow input").length,
    titlebar: !!document.getElementById("settingsTitlebar"),
  })`);

  console.log(
    `panes=${state.groups} nav=${state.navItems} theme=${state.theme}/${state.resolved} keyFieldType=${state.secure} ` +
      `models=${state.models} prices=${state.prices.join("/")} groups=${state.modelGroups.length} ` +
      `keyCheck=${state.keyCheck} compaction=${state.compaction.toggle}/${state.compaction.reserve} ` +
      `dropdowns=${state.dropdowns} theme="${state.theme}" ` +
      `switches=${state.switches} titlebar=${state.titlebar} consoleErrors=${errors.length}`,
  );
  const ok =
    state.titlebar &&
    state.dropdowns >= 4 &&
    typeof state.theme === "string" && state.theme.length > 0 &&
    state.navItems === 6 &&
    state.groups === 6 &&
    state.switches === 13 &&
    state.prices.length === 3 &&
    state.modelGroups.length >= 2 &&
    state.keyCheck &&
    state.compaction.toggle &&

    ["light", "dark"].includes(state.resolved) &&
    state.secure === "password" &&
    state.models > 40 &&
    errors.length === 0;
  if (!ok) console.error("settings ui failed", errors);
  else console.log("settings ui ok");
  app.exit(ok ? 0 : 1);
});
