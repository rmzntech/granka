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

  const mcpUi = await win.webContents.executeJavaScript(`(() => {
    const area = document.getElementById("mcpServers");
    area.value = JSON.stringify({ alpha: { command: "cmd" }, beta: { command: "cmd2" } });
    area.dispatchEvent(new Event("input"));
    const rows = document.querySelectorAll("#mcpServerList .switchRow").length;
    const first = document.querySelector("#mcpServerList input");
    first.checked = false;
    first.dispatchEvent(new Event("change"));
    const saved = JSON.parse(area.value);
    return { rows, disabled: saved.alpha.disabled === true, betaIntact: !saved.beta.disabled };
  })()`);

  const state = await win.webContents.executeJavaScript(`({
    groups: document.querySelectorAll(".settingsPane").length,
    navItems: document.querySelectorAll(".navItem").length,
    theme: document.querySelector(".themeCard[aria-pressed='true'] .themeName")?.textContent ?? "",
    themeCards: document.querySelectorAll(".themeCard").length,
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
      threshold: document.getElementById("compactionThreshold")?.value,
    },
    mcpList: !!document.getElementById("mcpServerList"),
    title: document.title,
    subheads: document.querySelectorAll("#pane-agent .settingsSubhead").length,

    switches: document.querySelectorAll(".switchRow input").length,
    titlebar: !!document.getElementById("settingsTitlebar"),
  })`);

  console.log(
    `panes=${state.groups} nav=${state.navItems} theme=${state.theme}/${state.resolved} keyFieldType=${state.secure} ` +
      `models=${state.models} prices=${state.prices.join("/")} groups=${state.modelGroups.length} ` +
      `keyCheck=${state.keyCheck} compaction=${state.compaction.toggle}/${state.compaction.reserve}/${state.compaction.threshold} ` +
      `mcpList=${state.mcpList} mcpUi=${mcpUi.rows}/${mcpUi.disabled}/${mcpUi.betaIntact} ` +
      `title="${state.title}" subheads=${state.subheads} ` +
      `dropdowns=${state.dropdowns} theme="${state.theme}" ` +
      `switches=${state.switches} titlebar=${state.titlebar} consoleErrors=${errors.length}`,
  );
  const ok =
    state.titlebar &&
    state.dropdowns >= 4 &&
    typeof state.theme === "string" && state.theme.length > 0 &&
    state.navItems === 9 &&
    state.groups === 9 &&
    state.themeCards >= 15 &&
    state.switches >= 13 &&
    state.prices.length === 3 &&
    state.modelGroups.length >= 2 &&
    state.keyCheck &&
    state.compaction.toggle &&
    state.compaction.threshold === String(agent.loadConfig().compactionThreshold ?? 80) &&
    state.mcpList &&
    mcpUi.rows === 2 && mcpUi.disabled && mcpUi.betaIntact &&
    state.title.startsWith("Настройки — ") && state.subheads === 5 &&

    ["light", "dark"].includes(state.resolved) &&
    state.secure === "password" &&
    state.models > 40 &&
    errors.length === 0;
  if (!ok) console.error("settings ui failed", errors);
  else console.log("settings ui ok");
  app.exit(ok ? 0 : 1);
});
