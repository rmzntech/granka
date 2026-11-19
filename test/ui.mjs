// UI smoke test: loads the real renderer in a hidden window and asserts that
// app.js ran to completion (model picker populated via IPC). Run: npm run test:ui
import { app, BrowserWindow } from "electron";
import { fileURLToPath } from "node:url";
import * as agent from "../electron/agent.mjs";
import { registerIpc } from "../electron/ipc.mjs";

await agent.init();
registerIpc();

app.disableHardwareAcceleration(); // no GPU in a headless test environment

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
  await win.loadFile(fileURLToPath(new URL("../renderer/index.html", import.meta.url)));

  // the picker shows a disabled "loading" row first: wait for the real catalog
  const waitFor = async (expr, ms = 30000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await win.webContents.executeJavaScript(expr)) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  };

  // the first-run wizard would cover the UI; dismiss it like a returning user
  await win.webContents.executeJavaScript('document.getElementById("onboarding").hidden = true');
  const modelsReady = await waitFor('document.getElementById("brainPopup").title.includes("/")');
  const sessionsReady = await waitFor('document.querySelector(".msg, .emptyState") !== null', 8000);

  const state = await win.webContents.executeJavaScript(`({
    bridge: typeof window.granka.ask === "function",
    platform: window.granka.platform,
    icons: document.querySelectorAll(".sprite symbol").length,
    modelName: document.getElementById("brainPopup").title,
    modelTitle: document.getElementById("brainPopup").title,
    thinking: document.getElementById("brainLevel").textContent,
    theme: document.body.dataset.theme,
    accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
    sessions: document.querySelectorAll(".sessionItem").length,
    sessionWeightBars: document.querySelectorAll(".sessionWeight").length,
    msgActions: document.querySelectorAll(".msgAction").length,
    segments: document.querySelectorAll(".segment").length,
    titleInTitlebar: (document.title ?? "").includes("granka"),
    themesLoaded: !!window.grankaThemes && Object.keys(window.grankaThemes.THEMES).length,
    listboxRole: document.getElementById("sessionList").getAttribute("role"),
    empty: !!document.querySelector(".emptyState") || document.querySelectorAll(".msg").length > 0,
    fontFamily: getComputedStyle(document.body).fontFamily,
    bundledFont: document.fonts.size > 0,
    customControls: getComputedStyle(document.getElementById("windowControls")).display !== "none",
  })`);

  // model popover opens, filters, and closes
  const popover = await win.webContents.executeJavaScript(`(async () => {
    document.getElementById("brainPopup").click();
    const open = !document.getElementById("popover").hidden;
    const search = document.querySelector(".popoverSearch");
    search.value = "anthropic";
    search.dispatchEvent(new Event("input"));
    const filtered = document.querySelectorAll(".modelRow").length;
    const favToggles = document.querySelectorAll(".modelFav").length;
    const prices = [...document.querySelectorAll(".modelPrice")].slice(0, 2).map((el) => el.textContent);
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    return { open, filtered, favToggles, prices, closed: document.getElementById("popover").hidden };
  })()`);

  // all-sessions view renders rows
  const allSessions = await win.webContents.executeJavaScript(`(async () => {
    document.getElementById("allSessions").click();
    await new Promise((r) => setTimeout(r, 900));
    const visible = !document.getElementById("sessionsView").hidden;
    const rows = document.querySelectorAll(".sessionRowFull").length;
    document.getElementById("closeSessions").click();
    return { visible, rows };
  })()`);

  // project pane renders the two rules editors
  const projectPane = await win.webContents.executeJavaScript(`(async () => {
    document.getElementById("segmentProject").click();
    await new Promise((r) => setTimeout(r, 500));
    const visible = !document.getElementById("projectView").hidden;
    const fields = document.querySelectorAll("#projectPane .panelTextarea").length;
    const globalRules = document.querySelectorAll("#projectPane #rulesAgents, #projectPane #rulesSystemView").length;
    const projectRules = !!document.getElementById("projectRulesArea");
    const projectRulesHint = document.getElementById("projectRulesHint")?.textContent ?? "";
    const labels = [...document.querySelectorAll("#projectPane label")].map((el) => el.textContent);
    document.getElementById("segmentChat").click();
    return { visible, fields, globalRules, projectRules, projectRulesHint, labels };
  })()`);

  // session context menu opens with project actions
  const menu = await win.webContents.executeJavaScript(`(async () => {
    const row = document.querySelector(".sessionItem");
    if (!row) return { skipped: true };
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 200, clientY: 240 }));
    await new Promise((r) => setTimeout(r, 150));
    const items = [...document.querySelectorAll("#popover .popoverItem")].map((el) => el.textContent.trim());
    document.getElementById("popover").hidden = true;
    return { skipped: false, items };
  })()`);

  // strict chat ↔ project binding: every visible chat belongs to the active project
  const binding = await win.webContents.executeJavaScript(`(() => {
    const rows = [...document.querySelectorAll(".sessionItem")];
    const foreign = rows.filter((row) => (row.dataset.projectId ?? "") !== (activeProjectId ?? ""));
    return { rows: rows.length, foreign: foreign.length, activeProjectId: activeProjectId ?? "" };
  })()`);

  // opening another session must move the active highlight
  const highlight = await win.webContents.executeJavaScript(`(async () => {
    const rows = [...document.querySelectorAll(".sessionItem")];
    if (rows.length < 2) return { skipped: true };
    rows[rows.length - 1].click();
    await new Promise((r) => setTimeout(r, 900));
    const active = document.querySelector(".sessionItem.isActive");
    return { skipped: false, activeId: active?.dataset.id, current: currentSessionId, count: rows.length };
  })()`);

  // A tool chip opens its detail and the same chip closes it again (both in
  // the message flow and inside a history .toolList).
  const toolToggle = await win.webContents.executeJavaScript(`(() => {
    const make = () => {
      const chip = makeToolChip("bash", JSON.stringify({ command: "ls" }), "call-1");
      chip.__detail.result = "ok";
      return chip;
    };
    const inline = make();
    document.getElementById("log").append(inline);
    toggleToolDetail(inline);
    const openedInline = !!toolDetailOf(inline);
    toggleToolDetail(inline);
    const closedInline = !toolDetailOf(inline) && inline.getAttribute("aria-expanded") === "false";

    const list = document.createElement("div");
    list.className = "toolList";
    const inList = make();
    list.append(inList);
    document.getElementById("log").append(list);
    toggleToolDetail(inList);
    const openedList = !!toolDetailOf(inList) && inList.getAttribute("aria-expanded") === "true";
    toggleToolDetail(inList);
    const closedList = !toolDetailOf(inList) && !document.querySelector(".toolDetail");

    inline.remove();
    list.remove();
    return { openedInline, closedInline, openedList, closedList };
  })()`);

  // sidebar toggle works and is restored afterwards
  const sidebarAfterToggle = await win.webContents.executeJavaScript(`(() => {
    document.getElementById("sidebarToggle").click();
    const hidden = getComputedStyle(document.getElementById("sidebar")).display;
    document.getElementById("sidebarToggle").click();
    return hidden;
  })()`);

  console.log(
    `bridge=${state.bridge} icons=${state.icons} model=${state.modelName} thinking=${state.thinking} ` +
      `font="${state.fontFamily.split(",")[0]}" loaded=${state.bundledFont} controls=${state.customControls} ` +
      `theme=${state.theme} accent=${state.accent} sessions=${state.sessions} weights=${state.sessionWeightBars} ` +
      `popover=${popover.open}/${popover.filtered}/${popover.favToggles}/${popover.prices.join("|")}/${popover.closed} ` +
      `allSessions=${allSessions.visible}/${allSessions.rows} project=${projectPane.visible}/${projectPane.fields}/${projectPane.globalRules} ` +
      `projectRules=${projectPane.projectRules} ` +
      `sidebarHidden=${sidebarAfterToggle} active=${highlight.skipped ? "n/a" : highlight.activeId === highlight.current} ` +
      `binding=${binding.rows}/${binding.foreign} menu=${menu.skipped ? "n/a" : menu.items.length} ` +
      `toolToggle=${Object.values(toolToggle).every(Boolean)} errors=${errors.length}`,
  );

  const ok =
    state.bridge &&
    state.icons >= 20 &&
    modelsReady &&
    sessionsReady &&
    state.modelTitle.includes("контекст") &&
    state.bundledFont &&
    state.fontFamily.length > 3 &&
    state.segments === 2 &&
    state.listboxRole === "list" &&
    state.titleInTitlebar &&
    state.themesLoaded >= 10 &&
    popover.open &&
    popover.filtered > 0 &&
    popover.favToggles === popover.filtered &&
    popover.prices.length === 2 &&
    popover.closed &&
    allSessions.visible &&
    allSessions.rows >= 0 &&
    projectPane.visible &&
    projectPane.fields >= 1 &&
    projectPane.globalRules === 0 &&
    projectPane.projectRules &&
    projectPane.labels.some((label) => label.includes("Проектный AGENTS.md")) &&
    sidebarAfterToggle === "none" &&
    (highlight.skipped || highlight.activeId === highlight.current) &&
    binding.foreign === 0 &&
    (menu.skipped || (menu.items.includes("Дублировать") && menu.items.includes("Удалить"))) &&
    toolToggle.openedInline &&
    toolToggle.closedInline &&
    toolToggle.openedList &&
    toolToggle.closedList &&
    errors.length === 0;
  if (!ok) {
    console.error("ui smoke failed", {
      bridge: state.bridge,
      icons: state.icons,
      modelsReady,
      sessionsReady,
      title: state.titleInTitlebar,
      themesLoaded: state.themesLoaded,
      segments: state.segments,
      listbox: state.listboxRole,
      popover,
      allSessions,
      projectPane,
      sidebarAfterToggle,
      highlight,
      toolToggle,
      errors,
    });
  }
  else console.log("ui ok");
  app.exit(ok ? 0 : 1);
});
