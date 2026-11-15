// Regression test for "theme changed only in settings": picking a theme card
// in the settings window must reach the main window through config:changed.
import { app, BrowserWindow } from "electron";
import { fileURLToPath } from "node:url";
import * as agent from "../electron/agent.mjs";
import { registerIpc } from "../electron/ipc.mjs";

await agent.init();
registerIpc({ openSettings: () => {} });
app.disableHardwareAcceleration();

const preload = fileURLToPath(new URL("../electron/preload.cjs", import.meta.url));
const page = (name) => fileURLToPath(new URL(`../renderer/${name}`, import.meta.url));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const originalTheme = agent.loadConfig().theme;
  const errors = [];

  const main = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true } });
  main.webContents.on("console-message", (event) => {
    if (event.level === "error") errors.push(event.message);
  });
  await main.loadFile(page("index.html"));

  const settings = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true } });
  await settings.loadFile(page("settings.html"));
  await wait(2500);

  const before = await main.webContents.executeJavaScript("document.body.dataset.themeId");

  await settings.webContents.executeJavaScript(`(async () => {
    document.querySelector('[data-pane="themes"]').click();
    await new Promise((r) => setTimeout(r, 200));
    const card = [...document.querySelectorAll(".themeCard")]
      .find((el) => el.textContent.includes("Spotify"));
    if (!card) throw new Error("карточка Spotify не найдена");
    card.click();
    return true;
  })()`);
  await wait(1200);

  const after = await main.webContents.executeJavaScript("document.body.dataset.themeId");
  const settingsTheme = await settings.webContents.executeJavaScript("document.body.dataset.theme");
  const saved = agent.loadConfig().theme;

  // restore the user's preference
  await agent.applyConfig({ theme: originalTheme });

  console.log(`before=${before} after=${after} saved=${saved} settingsMode=${settingsTheme} errors=${errors.length}`);
  const ok = after === "spotify" && saved === "spotify" && settingsTheme === "dark" && errors.length === 0;
  if (!ok) console.error("theme broadcast failed");
  else console.log("theme broadcast ok");
  app.exit(ok ? 0 : 1);
});
