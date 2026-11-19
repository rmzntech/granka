// granka renderer. External file because the page CSP is `default-src 'self'`
// (an inline <script> is silently blocked and every handler dies).
const $ = (id) => document.getElementById(id);
const log = $("log");
const MONO_MEDIA = window.matchMedia("(prefers-color-scheme: dark)");

let config = {};
let allModels = [];
let modelsLoaded = false;
let projects = [];
let activeProjectId = "";
let commands = { prompts: [], skills: [] };
let sessions = [];
let sessionsAll = [];
let currentSessionId = "";
let busy = false;
let queued = 0;
let streamText = "";
let streamWrapper = null;
let streamPrompt = "";
let streamBody = null;
let thinkingBlock = null;   // .thinking container for the current answer
let thinkingText = "";
let thinkingStartedAt = 0;

const THINKING_MODES = {
  off: "скрывать",
  live: "вживую, свернуть",
  always: "держать открытым",
};

const TOOL_MODES = {
  off: "скрывать полностью",
  live: "свёрнуто, раскрывается",
  always: "показывать всегда",
};

function thinkingMode() {
  if (agentMode() === "debug") return "always";
  return THINKING_MODES[config.thinkingDisplay] ? config.thinkingDisplay : "off";
}

function toolMode() {
  if (agentMode() === "debug") return "always";
  return TOOL_MODES[config.toolDisplay] ? config.toolDisplay : "live";
}

function resetThinking() {
  thinkingBlock = null;
  thinkingText = "";
  thinkingStartedAt = 0;
}

function thinkingDuration() {
  return thinkingStartedAt ? `${((Date.now() - thinkingStartedAt) / 1000).toFixed(1)} с` : "";
}

function thinkingTimeLabel() {
  const duration = thinkingBlock?.querySelector(".thinkingTime");
  if (!duration) return;
  const text = thinkingDuration();
  if (text) duration.textContent = text;
}

function expandThinking(block, expanded) {
  if (!block) return;
  block.classList.toggle("isOpen", expanded);
  block.setAttribute("aria-expanded", String(expanded));
}

function toggleThinking(block) {
  if (!block) return;
  expandThinking(block, !block.classList.contains("isOpen"));
}

// Option A: while streaming the block is open; once the answer settles
// the mode decides — “live” folds it, “always” leaves it expanded.
function settleThinking() {
  if (!thinkingBlock) return;
  thinkingTimeLabel();
  if (thinkingMode() === "live") expandThinking(thinkingBlock, false);
}
let suggestIndex = -1;
let listIndex = -1;
let view = "chat";
let attachments = [];
let historyMessages = [];      // full transcript of the open chat
let visibleCount = 40;         // windowed rendering: only the tail is in the DOM
let selectedSessions = new Set();
const plans = new Map(); // sessionId -> todo items, plan is bound to one chat
let compactTimer = null;

const isMac = granka.platform === "darwin";
document.body.dataset.mac = String(isMac);

// --- theme & accent --------------------------------------------------------

let systemAccent = "";

// The bundled Inter covers Cyrillic and Latin, so it is the reliable base on
// every platform; the "system" option still prefers the OS face when it exists.
function applyTheme() {
  withoutTransitions(() => applyThemeShared(MONO_MEDIA.matches, systemAccent));
}

MONO_MEDIA.addEventListener("change", () => {
  if (!config.theme || config.theme === "auto") applyTheme();
});

async function applyAccent() {
  systemAccent = (await granka.accentColor()) || "";
  applyTheme();
}

// --- generic helpers -------------------------------------------------------

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

function stickToBottom() {
  return log.scrollHeight - log.scrollTop - log.clientHeight < 48;
}

function scrollIf(should) {
  if (should) log.scrollTop = log.scrollHeight;
}

function syncScrollButton() {
  $("scrollDown").hidden = stickToBottom();
}

function setStatus(text) {
  $("status").textContent = text;
}

// Live activity line shown while the agent works — the main feedback when
// thinking and tool calls are hidden. States: think / work / write.
let activity = "think";
let activityTool = "";

function setActivity(kind, toolName = "") {
  if (!busy) return;
  activity = kind;
  activityTool = toolName;
  renderActivity();
}

function renderActivity() {
  const status = $("status");
  if (!busy) {
    status.textContent = "";
    status.removeAttribute("data-activity");
    return;
  }
  const labels = {
    think: "Думает",
    work: activityTool ? `Работает: ${TOOL_LABELS[activityTool] ?? activityTool}` : "Работает",
    write: "Пишет ответ",
  };
  status.dataset.activity = activity;
  const queue = queued > 0 ? ` · в очереди: ${queued}` : "";
  status.textContent = `${labels[activity] ?? "Думает"}${queue}`;
}

function announce(text) {
  const node = $("announcer");
  node.textContent = "";
  requestAnimationFrame(() => {
    node.textContent = text;
  });
}

function svgIcon(name, cls = "icon") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", cls);
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

// toasts sit inside the composer flow; action label is optional
function toast(message, { error = false, action } = {}) {
  const node = document.createElement("div");
  node.className = `toast${error ? " isError" : ""}`;
  node.setAttribute("role", error ? "alert" : "status");
  node.append(svgIcon(error ? "circle-alert" : "check"));
  const text = document.createElement("div");
  text.className = "toastText";
  text.textContent = message;
  node.append(text);
  if (action) {
    const button = document.createElement("button");
    button.className = "toastAction";
    button.textContent = action.label;
    button.addEventListener("click", () => {
      action.run();
      node.remove();
    });
    node.append(button);
  }
  const close = document.createElement("button");
  close.className = "toastClose";
  close.append(svgIcon("x"));
  close.setAttribute("aria-label", "Закрыть сообщение");
  close.addEventListener("click", () => node.remove());
  node.append(close);
  const stack = $("toasts");
  while (stack.children.length >= 3) stack.firstElementChild?.remove();
  stack.append(node);
  const dismiss = () => {
    node.classList.add("isLeaving");
    setTimeout(() => node.remove(), 240);
  };
  // Errors and toasts with an action stay until dismissed: their content is
  // the recovery path, so a timer can remove the only way forward.
  if (!error && !action) {
    let remaining = 4000;
    let startedAt = Date.now();
    let timer = null;
    const arm = () => {
      startedAt = Date.now();
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (document.body.contains(node)) dismiss();
      }, remaining);
    };
    const pause = () => {
      clearTimeout(timer);
      remaining = Math.max(0, remaining - (Date.now() - startedAt));
    };
    node.addEventListener("pointerenter", pause);
    node.addEventListener("pointerleave", arm);
    node.addEventListener("focusin", pause);
    node.addEventListener("focusout", arm);
    arm();
  }
  return dismiss;
}

// errors that suggest a fix get the fix attached
function fail(message) {
  const lower = String(message ?? "").toLowerCase();
  let action;
  if (/ключ|key|auth|401|unauthor/.test(lower)) {
    action = { label: "Настройки", run: () => granka.openSettings() };
  } else if (/модел|model/.test(lower)) {
    action = { label: "Выбрать модель", run: () => openModelPopover() };
  }
  toast(String(message ?? "Не удалось выполнить действие. Повторите попытку"), { error: true, action });
}

function setBusy(value) {
  busy = value;
  log.setAttribute("aria-busy", String(value));
  $("stop").hidden = !value;
  $("send").disabled = false; // stays usable: while busy it queues a follow-up
  $("send").title = value ? "Поставить в очередь (Enter)" : "Отправить (Enter)";
  renderActivity();
  granka.trayBusy?.(value);
}

function syncQueueBadge() {
  renderActivity();
  const badge = $("queueBadge");
  if (badge) {
    badge.hidden = queued === 0;
    badge.textContent = String(queued);
  }

}

function formatTokens(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

// Russian plural: plural(5, ["диалог", "диалога", "диалогов"]) -> "5 диалогов"
function plural(n, forms) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  const form = mod10 === 1 && mod100 !== 11 ? forms[0]
    : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? forms[1]
    : forms[2];
  return `${n} ${form}`;
}

const LEVEL_RU = { off: "выкл", minimal: "мин", low: "низк", medium: "сред", high: "выс", xhigh: "макс", max: "макс" };
function levelRu(level) { return LEVEL_RU[level] ?? level; }

function showContext(context) {
  const meter = $("ctx");
  if (!context || context.percent == null) {
    meter.textContent = "";
    meter.title = "Заполнение контекста неизвестно (после сжатия — до следующего ответа)";
    return;
  }
  const percent = Math.min(100, Math.max(0, Math.round(context.percent)));
  const warn = percent >= (config.compactionThreshold ?? 80);
  meter.textContent = `${percent}%`;
  meter.classList.toggle("isWarn", warn);
  meter.setAttribute("aria-label", warn ? `Контекст: ${percent}%, почти полон` : `Контекст: ${percent}%`);
  const tokens = context.tokens
    ? `контекст ${formatTokens(context.tokens)} из ${formatTokens(context.window)} токенов${context.estimated ? " (оценка)" : ""}`
    : "заполнение контекста";
  meter.title = warn ? `${tokens} · почти полон, клик: сжать` : tokens;
}

$("ctx").addEventListener("click", async () => {
  if (!$("ctx").textContent) return;
  openPopover($("ctx"), (panel) => {
    const hint = document.createElement("div");
    hint.className = "popoverHint";
    hint.textContent = "Контекст: состав по токенам";
    panel.append(hint);
    const body = document.createElement("div");
    body.className = "ctxBreak";
    body.textContent = "Считаю…";
    panel.append(body);
    panel.append(popoverItem("Сжать контекст", { icon: "archive", onSelect: () => compactNow() }));
    granka.contextBreakdown().then((result) => {
      if (!result?.ok || !result.context) {
        body.textContent = "Неизвестно до следующего ответа.";
        return;
      }
      body.replaceChildren();
      const total = Math.max(1, result.context.tokens);
      for (const part of result.parts) {
        const row = document.createElement("div");
        row.className = "ctxBreakRow";
        const label = document.createElement("span");
        label.textContent = part.label;
        const bar = document.createElement("div");
        bar.className = "ctxBreakBar";
        const fill = document.createElement("div");
        fill.className = "ctxBreakFill";
        fill.style.width = `${Math.min(100, (part.tokens / total) * 100)}%`;
        bar.append(fill);
        const val = document.createElement("span");
        val.className = "ctxBreakVal";
        val.textContent = formatTokens(part.tokens);
        row.append(label, bar, val);
        body.append(row);
      }
      const totalRow = document.createElement("div");
      totalRow.className = "ctxBreakRow";
      totalRow.textContent = `Всего ${formatTokens(result.context.tokens)} из ${formatTokens(result.context.window)} (${Math.round(result.context.percent)}%)`;
      body.append(totalRow);
    }).catch(() => {
      body.textContent = "Не удалось посчитать состав.";
    });
  });
});

// --- popover ---------------------------------------------------------------

let popoverAnchor = null;

function closePopover() {
  const panel = $("popover");
  if (panel.hidden) return;
  panel.hidden = true;
  disarmPopoverReposition();
  if (popoverAnchor) popoverAnchor.setAttribute("aria-expanded", "false");
  // Return focus to the anchor the user opened the popover from.
  popoverAnchor?.focus();
  popoverAnchor = null;
}

function openPopover(anchor, build) {
  const panel = $("popover");
  if (popoverAnchor === anchor && !panel.hidden) return closePopover();
  panel.replaceChildren();
  build(panel);
  panel.setAttribute("aria-label", anchor.getAttribute("aria-label") || anchor.title || "Меню");
  panel.hidden = false;
  const rect = anchor.getBoundingClientRect();
  const width = panel.offsetWidth;
  const height = panel.offsetHeight;
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
  const top = Math.min(rect.bottom + 4, window.innerHeight - height - 8);
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
  if (rect.bottom + height > window.innerHeight - 8) {
    panel.style.top = `${Math.max(8, rect.top - height - 4)}px`;
  }
  popoverAnchor = anchor;
  anchor.setAttribute("aria-expanded", "true");
  armPopoverReposition();
  panel.querySelector("button, input")?.focus();
}

document.addEventListener("mousedown", (event) => {
  if ($("popover").hidden) return;
  if (event.target.closest("#popover") || event.target.closest("[aria-haspopup]")) return;
  closePopover();
});

// Keep an open popover attached to its anchor while scrolling/resizing.
let popoverReposition = null;
function armPopoverReposition() {
  disarmPopoverReposition();
  popoverReposition = () => {
    if ($("popover").hidden || !popoverAnchor) return;
    const rect = popoverAnchor.getBoundingClientRect();
    const panel = $("popover");
    panel.style.left = `${Math.min(Math.max(8, rect.left), window.innerWidth - panel.offsetWidth - 8)}px`;
    panel.style.top = `${Math.min(rect.bottom + 4, Math.max(8, window.innerHeight - panel.offsetHeight - 8))}px`;
  };
  window.addEventListener("resize", popoverReposition);
  window.addEventListener("scroll", popoverReposition, true);
}
function disarmPopoverReposition() {
  if (popoverReposition) {
    window.removeEventListener("resize", popoverReposition);
    window.removeEventListener("scroll", popoverReposition, true);
    popoverReposition = null;
  }
}

// Generic focus trap for any visible dialog container.
function trapTab(container, event) {
  if (event.key !== "Tab") return;
  const focusables = [...container.querySelectorAll("button:not(:disabled), input, textarea, select, a[href], [tabindex]")]
    .filter((el) => el.offsetParent !== null || el === document.activeElement);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

// Keep Tab inside an open popover (simple focus trap).
document.addEventListener("keydown", (event) => {
  if (event.key !== "Tab" || $("popover").hidden) return;
  trapTab($("popover"), event);
});

function popoverItem(label, { meta, current, danger, icon, onSelect, contextMenu } = {}) {
  const item = document.createElement("button");
  item.className = `popoverItem${current ? " isCurrent" : ""}${danger ? " danger" : ""}`;
  if (icon) item.append(svgIcon(icon));
  const text = document.createElement("span");
  text.textContent = label;
  item.append(text);
  if (meta) {
    const note = document.createElement("span");
    note.className = "meta";
    note.textContent = meta;
    item.append(note);
  }
  if (current) item.append(svgIcon("check"));
  item.addEventListener("click", () => {
    closePopover();
    onSelect?.();
  });
  if (contextMenu) {
    item.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      contextMenu(event);
    });
  }
  return item;
}

// --- model / thinking ------------------------------------------------------

function modelById(id) {
  return allModels.find((model) => model.id === id);
}

function levelsOf(modelId) {
  return modelById(modelId)?.levels ?? ["off"];
}

function renderModelLabel() {
  const model = modelById(config.model);
  const button = $("brainPopup");
  button.title = model
    ? `${model.id}\n${formatTokens(model.context)} контекст · $${model.cost?.input ?? "?"}/$${model.cost?.output ?? "?"} за 1M токенов`
    : "Выбрать модель";
}

function buildModelSection(panel) {
  const search = document.createElement("input");
  search.className = "popoverSearch";
  search.placeholder = "Поиск модели";
  search.setAttribute("aria-label", "Поиск модели");
  panel.append(search);
  let freeOnly = false;
  const freeToggle = document.createElement("button");
  freeToggle.className = "popoverFreeToggle";
  freeToggle.setAttribute("aria-pressed", "false");
  freeToggle.textContent = "Только бесплатные";
  freeToggle.addEventListener("click", () => {
    freeOnly = !freeOnly;
    freeToggle.setAttribute("aria-pressed", String(freeOnly));
    freeToggle.classList.toggle("isActive", freeOnly);
    render();
  });
  panel.append(freeToggle);
  const list = document.createElement("div");
  list.className = "modelList";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Модели");
  panel.append(list);

  const render = () => {
    if (!modelsLoaded) {
      list.replaceChildren(
        Object.assign(document.createElement("div"), {
          className: "popoverHint",
          textContent: "Загрузка каталога моделей…",
        }),
      );
      return;
    }
    globalThis.grankaModels.renderModelRows(list, {
      models: freeOnly ? allModels.filter((m) => globalThis.grankaModels.isFree(m)) : allModels,
      favorites: config.favorites ?? [],
      current: config.model,
      query: search.value,
      onSelect: (id) => selectModel(id),
      onToggleFavorite: async (id) => {
        await toggleFavorite(id);
        render();
      },
    });
  };
  render();
  search.addEventListener("input", render);
}

function buildThinkingSection(panel) {
  const modes = Object.keys(THINKING_MODES);
  const mode = thinkingMode();
  for (const level of levelsOf(config.model)) {
    panel.append(
      popoverItem(levelRu(level), {
        current: level === (config.thinkingLevel ?? "off"),
        onSelect: () => {
          saveConfig({ thinkingLevel: level });
          renderBrain();
        },
      }),
    );
  }
  panel.append(popoverHeading("Показ мышления в чате"));
  for (const value of modes) {
    panel.append(
      popoverItem(THINKING_MODES[value], {
        icon: "layers",
        current: mode === value,
        onSelect: () => {
          saveConfig({ thinkingDisplay: value });
          if (value === "off" && thinkingBlock && busy) {
            thinkingBlock.remove();
            resetThinking();
          }
        },
      }),
    );
  }
}

function popoverHeading(text) {
  const heading = document.createElement("div");
  heading.className = "popoverHeading";
  heading.textContent = text;
  return heading;
}

// One brain button for both choices: segmented tabs like Dialog/Project.
function openBrainPopover() {
  openPopover($("brainPopup"), (panel) => {
    const tabs = document.createElement("div");
    tabs.className = "segmented popoverTabs";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Модель и мышление");
    const modelTab = document.createElement("button");
    modelTab.className = "segment isActive";
    modelTab.setAttribute("role", "tab");
    modelTab.setAttribute("aria-selected", "true");
    modelTab.textContent = "Модель";
    const thinkTab = document.createElement("button");
    thinkTab.className = "segment";
    thinkTab.setAttribute("role", "tab");
    thinkTab.setAttribute("aria-selected", "false");
    thinkTab.textContent = "Мышление";
    const modelBody = document.createElement("div");
    const thinkBody = document.createElement("div");
    buildModelSection(modelBody);
    buildThinkingSection(thinkBody);
    thinkBody.hidden = true;
    modelBody.setAttribute("role", "tabpanel");
    thinkBody.setAttribute("role", "tabpanel");
    const show = (model) => {
      modelTab.classList.toggle("isActive", model);
      thinkTab.classList.toggle("isActive", !model);
      modelTab.setAttribute("aria-selected", String(model));
      thinkTab.setAttribute("aria-selected", String(!model));
      modelBody.hidden = !model;
      thinkBody.hidden = model;
    };
    modelTab.addEventListener("click", () => show(true));
    thinkTab.addEventListener("click", () => show(false));
    tabs.append(modelTab, thinkTab);
    panel.append(tabs, modelBody, thinkBody);
  });
}

function openModelPopover() {
  openPopover($("brainPopup"), (panel) => {
    panel.append(popoverHeading("Модель"));
    buildModelSection(panel);
  });
}

async function toggleFavorite(modelId) {
  const favorites = new Set(config.favorites ?? []);
  if (favorites.has(modelId)) favorites.delete(modelId);
  else favorites.add(modelId);
  await saveConfig({ favorites: [...favorites] });
}

function openThinkingPopover() {
  openPopover($("brainPopup"), (panel) => {
    panel.append(popoverHeading("Мышление"));
    buildThinkingSection(panel);
  });
}

// Agent work modes (Claude Code style permission modes): the mode changes
// which tools the session exposes and how much the UI shows.
const AGENT_MODES = {
  chat: { name: "Чат", icon: "message-circle", hint: "Обычная работа: все инструменты, вопросы при неясности" },
  plan: { name: "План", icon: "clipboard-list", hint: "Только чтение: план без правок" },
  auto: { name: "Авто", icon: "zap", hint: "Без вопросов: агент решает сам, правки разрешены" },
  debug: { name: "Дебаг", icon: "bug", hint: "Отладка: инструменты и мышление всегда открыты" },
};

function agentMode() {
  return AGENT_MODES[config.agentMode] ? config.agentMode : "chat";
}

function renderMode() {
  const mode = AGENT_MODES[agentMode()];
  const button = $("modePopup");
  button.replaceChildren(
    svgIcon(mode.icon),
    Object.assign(document.createElement("span"), { id: "modeName", textContent: mode.name }),
  );
  button.title = `Режим работы: ${mode.name} — ${mode.hint}`;
  button.setAttribute("aria-label", button.title);
}

function openModePopover() {
  openPopover($("modePopup"), (panel) => {
    for (const [id, mode] of Object.entries(AGENT_MODES)) {
      panel.append(
        popoverItem(mode.name, {
          icon: mode.icon,
          current: agentMode() === id,
          onSelect: () => setAgentMode(id),
        }),
      );
    }
  });
}

async function setAgentMode(id) {
  if (!AGENT_MODES[id]) return;
  await saveConfig({ agentMode: id, planMode: id === "plan" });
  renderMode();
  toast(`Режим: ${AGENT_MODES[id].name}`);
}

function renderBrain() {
  const model = modelById(config.model);
  const levels = levelsOf(config.model);
  const current = levels.includes(config.thinkingLevel)
    ? config.thinkingLevel
    : levels.includes("medium")
      ? "medium"
      : levels[0];
  const button = $("brainPopup");
  button.title = model
    ? `${model.id}\n${formatTokens(model.context)} контекст · мышление: ${current ?? "off"}`
    : "Выбрать модель";
  button.setAttribute("aria-label", button.title);
  const level = $("brainLevel");
  const short = model ? globalThis.grankaModels.modelName(model.id) : "Модель";
  if (level) level.textContent = current && current !== "off" ? `${short} · ${levelRu(current)}` : short;
  if (current && current !== config.thinkingLevel) saveConfig({ thinkingLevel: current });
}

function renderThinking() {
  renderBrain();
}

async function selectModel(modelId) {
  if (!modelId || modelId === config.model) return;
  if (!(await saveConfig({ model: modelId }))) return;
  renderModelLabel();
  renderThinking();
}

// --- views -----------------------------------------------------------------

function setView(next) {
  view = next;
  $("chatView").hidden = next !== "chat";
  $("projectView").hidden = next !== "project";
  $("sessionsView").hidden = next !== "sessions";
  $("statsView").hidden = next !== "stats";
  for (const name of ["chat", "project"]) {
    const button = $(`segment${name[0].toUpperCase()}${name.slice(1)}`);
    button.classList.toggle("isActive", next === name);
    button.setAttribute("aria-selected", String(next === name));
  }
  if (next === "project") void buildProjectPane();
  if (next === "sessions") buildSessionsPane();
  if (next === "stats") buildStatsPane();
}

async function buildStatsPane() {
  const pane = $("statsPane");
  pane.replaceChildren();
  let data;
  try {
    data = await granka.getStats();
  } catch (err) {
    $("statsMeta").textContent = "";
    const box = document.createElement("div");
    box.className = "sessionError";
    box.setAttribute("role", "alert");
    const text = document.createElement("span");
    text.textContent = `Не удалось загрузить аналитику: ${err?.message ?? err}`;
    const retry = document.createElement("button");
    retry.className = "ghostBtn";
    retry.textContent = "Повторить";
    retry.addEventListener("click", () => buildStatsPane());
    box.append(text, retry);
    pane.append(box);
    return;
  }
  $("statsMeta").textContent = `${data.totals.calls} запросов · $${data.totals.cost.toFixed(4)} · ${data.totals.input + data.totals.output} токенов`;

  if (!data.totals.calls) {
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "Пока нет данных: статистика появится после первого ответа модели.";
    pane.append(hint);
    return;
  }

  const summary = document.createElement("div");
  summary.className = "statsCards";
  const card = (label, value, note) => {
    const box = document.createElement("div");
    box.className = "statsCard";
    const title = document.createElement("div");
    title.className = "statsLabel";
    title.textContent = label;
    const big = document.createElement("div");
    big.className = "statsValue";
    big.textContent = value;
    box.append(title, big);
    if (note) {
      const small = document.createElement("div");
      small.className = "statsNote";
      small.textContent = note;
      box.append(small);
    }
    return box;
  };
  summary.append(
    card("Стоимость", `$${data.totals.cost.toFixed(3)}`, data.totals.billedCalls ? `${data.totals.billedCalls}/${data.totals.calls} вызовов — по счёту провайдера` : "оценка по каталогу"),
    card("Запросы", String(data.totals.calls), plural(data.byDay.length, ["день", "дня", "дней"])),
    card("Вход", formatTokens(data.totals.input), "токенов, включая кэш"),
    card("Кэш", formatTokens((data.totals.cacheRead ?? 0) + (data.totals.cacheWrite ?? 0)), "чтение + запись"),
    card("Выход", formatTokens(data.totals.output), "токенов"),
  );
  pane.append(summary);

  // Charts: tabs for days (cost/tokens), projects and models.
  let chartMode = "days";
  let dayMetric = "cost";
  const tabs = document.createElement("div");
  tabs.className = "statsTabs";
  tabs.setAttribute("role", "tablist");
  const chartBox = document.createElement("div");
  const hbar = (label, value, share, title) => {
    const row = document.createElement("div");
    row.className = "statsHRow";
    row.title = title;
    const name = document.createElement("span");
    name.className = "statsHName";
    name.textContent = label;
    const track = document.createElement("span");
    track.className = "statsHBar";
    const fill = document.createElement("span");
    fill.style.width = `${Math.max(2, Math.round(share * 100))}%`;
    track.append(fill);
    const valueEl = document.createElement("span");
    valueEl.className = "statsHValue";
    valueEl.textContent = value;
    row.append(name, track, valueEl);
    return row;
  };
  const renderChart = () => {
    for (const btn of tabs.querySelectorAll("button")) {
      const on = btn.dataset.mode === chartMode;
      btn.classList.toggle("isOn", on);
      btn.setAttribute("aria-selected", String(on));
    }
    chartBox.replaceChildren();
    if (chartMode === "days") {
      const byDay = data.byDay;
      const values = byDay.map((day) => (dayMetric === "cost" ? day.cost : day.input + day.output));
      const max = Math.max(...values, dayMetric === "cost" ? 0.0001 : 1);
      const chart = document.createElement("div");
      chart.className = "statsChart";
      chart.setAttribute("role", "img");
      chart.setAttribute("aria-label", dayMetric === "cost"
        ? `Расходы по дням: максимум $${max.toFixed(4)}, дней: ${byDay.length}`
        : `Токены по дням: максимум ${formatTokens(max)}, дней: ${byDay.length}`);
      byDay.forEach((day, index) => {
        const column = document.createElement("div");
        column.className = "statsBar";
        column.title = dayMetric === "cost"
          ? `${day.day}: ${day.calls} запросов · $${day.cost.toFixed(4)}`
          : `${day.day}: ${formatTokens(day.input + day.output)} токенов · ${day.calls} запросов`;
        const fill = document.createElement("span");
        fill.style.height = `${Math.max(2, Math.round((values[index] / max) * 100))}%`;
        column.append(fill);
        chart.append(column);
      });
      const metric = document.createElement("div");
      metric.className = "statsMetric";
      for (const [key, label] of [["cost", "Стоимость"], ["tokens", "Токены"]]) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "statsMetricBtn";
        btn.textContent = label;
        btn.classList.toggle("isOn", dayMetric === key);
        btn.addEventListener("click", () => { dayMetric = key; renderChart(); });
        metric.append(btn);
      }
      chartBox.append(metric, chart);
    } else {
      const rows = chartMode === "projects" ? data.byProject : data.byModel;
      const labelKey = chartMode === "projects" ? "project" : "model";
      const total = Math.max(...rows.map((row) => row.cost), 0.0001);
      const bars = document.createElement("div");
      bars.className = "statsHBars";
      bars.setAttribute("role", "img");
      bars.setAttribute("aria-label", chartMode === "projects" ? "Расход по проектам" : "Расход по моделям");
      for (const row of rows) {
        const name = chartMode === "projects" ? row[labelKey] : globalThis.grankaModels.modelName(row[labelKey]);
        bars.append(hbar(name, `$${row.cost.toFixed(4)} · ${formatTokens(row.input + row.output)}`, row.cost / total,
          `${row.calls} запросов · $${row.cost.toFixed(4)}`));
      }
      chartBox.append(bars);
    }
  };
  for (const [mode, label] of [["days", "По дням"], ["projects", "По проектам"], ["models", "По моделям"]]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.mode = mode;
    btn.className = "statsTab";
    btn.setAttribute("role", "tab");
    btn.textContent = label;
    btn.addEventListener("click", () => { chartMode = mode; renderChart(); });
    tabs.append(btn);
  }
  pane.append(tabs, chartBox);
  renderChart();

  const table = document.createElement("div");
  table.className = "statsTable";
  table.setAttribute("role", "table");
  table.setAttribute("aria-label", "Расходы по моделям");
  const head = document.createElement("div");
  head.className = "statsRow isHead";
  head.setAttribute("role", "row");
  head.append(
    Object.assign(document.createElement("span"), { textContent: "Модель" }),
    Object.assign(document.createElement("span"), { textContent: "Запросы" }),
    Object.assign(document.createElement("span"), { textContent: "Токены" }),
    Object.assign(document.createElement("span"), { textContent: "Стоимость" }),
  );
  table.append(head);
  for (const row of data.byModel) {
    const line = document.createElement("div");
    line.className = "statsRow";
    line.setAttribute("role", "row");
    line.append(
      Object.assign(document.createElement("span"), { textContent: globalThis.grankaModels.modelName(row.model) }),
      Object.assign(document.createElement("span"), { textContent: String(row.calls) }),
      Object.assign(document.createElement("span"), { textContent: formatTokens(row.input + row.output) }),
      Object.assign(document.createElement("span"), { textContent: `$${row.cost.toFixed(4)}` }),
    );
    table.append(line);
  }
  pane.append(table);
}

// --- log rendering ---------------------------------------------------------

function decorateCodeBlocks(container) {
  for (const pre of container.querySelectorAll("pre:not([data-ready])")) {
    pre.dataset.ready = "1";
    const lang = (pre.querySelector("code")?.className ?? "").replace("lang-", "").toLowerCase();
    if (["html", "svg", "htm"].includes(lang)) {
      const preview = document.createElement("button");
      preview.className = "codeCopy codePreview";
      preview.title = "Открыть превью";
      preview.textContent = "превью";
      preview.addEventListener("click", async (event) => {
        event.stopPropagation();
        const code = pre.querySelector("code")?.textContent ?? "";
        const html = lang === "svg" ? `<!doctype html><body>${code}</body>` : code;
        await granka.openPreview({ html, title: "Превью" });
      });
      pre.prepend(preview);
    }
    const button = document.createElement("button");
    button.className = "codeCopy";
    button.title = "Скопировать код";
    button.setAttribute("aria-label", "Скопировать код");
    button.append(svgIcon("copy"));
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const code = pre.querySelector("code")?.textContent ?? "";
      if (await copyText(code)) toast("Код скопирован");
      else fail("Не удалось скопировать код");
    });
    pre.append(button);
  }
}

function messageActions(role, wrapper) {
  const actions = document.createElement("div");
  actions.className = "actions";

  const copy = document.createElement("button");
  copy.className = "msgAction";
  copy.title = "Копировать";
  copy.setAttribute("aria-label", "Копировать сообщение");
  copy.append(svgIcon("copy"));
  copy.addEventListener("click", async () => {
    if (await copyText(wrapper.__raw)) toast("Скопировано");
    else fail("Не удалось скопировать");
  });

  const quote = document.createElement("button");
  quote.className = "msgAction";
  quote.title = "Цитировать";
  quote.setAttribute("aria-label", "Цитировать сообщение");
  quote.append(svgIcon("quote"));
  quote.addEventListener("click", () => {
    const quoted = wrapper.__raw
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    $("prompt").value = `${quoted}\n\n`;
    autoGrow();
    $("prompt").focus();
  });

  const repeat = document.createElement("button");
  repeat.className = "msgAction";
  repeat.title = role === "user" ? "Отправить снова" : "Повторить запрос";
  repeat.setAttribute("aria-label", repeat.title);
  repeat.append(svgIcon("repeat"));
  repeat.addEventListener("click", async () => {
    // The correct prompt is the one this answer replied to, not necessarily
    // the latest one in the session.
    const text = role === "user" ? wrapper.__raw : wrapper.__prompt || (await granka.lastPrompt());
    if (!text) return fail("Нет текста для повтора. Напишите запрос");
    $("prompt").value = stripAttachmentNote(text);
    autoGrow();
    send();
  });

  actions.append(copy, quote, repeat);
  return actions;
}

function addMessage(role, text, { animate = true } = {}) {
  const wrapper = document.createElement("div");
  wrapper.className = `msg ${role}${animate ? " isNew" : ""}`;
  wrapper.__raw = text ?? "";
  const body = document.createElement("div");
  body.className = "text";
  if (role === "assistant") {
    body.innerHTML = window.mdToHtml(wrapper.__raw);
    decorateCodeBlocks(body);
  } else body.textContent = wrapper.__raw;
  wrapper.append(messageActions(role, wrapper), body);
  log.append(wrapper);
  return { wrapper, body };
}

// Attachments stay visible on the message they were sent with.
function appendBubbleAttachments(wrapper, items) {
  if (!items?.length) return;
  const row = document.createElement("div");
  row.className = "bubbleAttachments";
  for (const item of items) {
    const chip = document.createElement("span");
    chip.className = "bubbleChip";
    chip.title = item.path;
    chip.textContent = item.name;
    row.append(chip);
  }
  wrapper.append(row);
}

// Downscale an image data URL on a canvas (max 1280px) so the model gets
// pixels without paying for full-resolution screenshots.
function resizeImageDataUrl(dataUrl, maxDim = 1280) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
      if (scale >= 1) return resolve(dataUrl);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

async function ensureResized(item) {
  if (item.kind !== "image" || item.dataUrl) return item;
  const result = await granka.attachmentDataUrl(item.path);
  if (result.ok && result.dataUrl) item.dataUrl = await resizeImageDataUrl(result.dataUrl);
  return item;
}

function addDivider(text) {
  const line = document.createElement("div");
  line.className = "divider";
  line.textContent = text;
  log.append(line);
}

function addCheckpointDivider(id) {
  const line = document.createElement("div");
  line.className = "divider";
  const label = document.createElement("span");
  label.textContent = "чекпоинт перед правками";
  const button = document.createElement("button");
  button.className = "dividerAction";
  button.textContent = "откатить";
  button.title = "Вернуть файлы к состоянию перед этими правками (новые файлы останутся)";
  button.addEventListener("click", async () => {
    const ok = await granka.confirm("Откатить файлы к чекпоинту?", "Файлы вернутся к состоянию перед этими правками. Новые файлы останутся.", "Откатить");
    if (!ok) return;
    button.disabled = true;
    const result = await granka.restoreCheckpoint(id);
    toast(result.ok ? "Файлы откачены к чекпоинту" : `Не удалось: ${result.error ?? "ошибка"}`, { error: !result.ok });
    button.disabled = false;
  });
  line.append(label, button);
  log.append(line);
}

// errors are attached to the turn they belong to, not to a global banner
function attachError(wrapper, message) {
  const box = document.createElement("div");
  box.className = "msgError";
  box.setAttribute("role", "alert");
  box.append(svgIcon("circle-alert"));
  const text = document.createElement("div");
  text.className = "msgErrorText";
  text.textContent = message;
  box.append(text);
  const lower = String(message).toLowerCase();
  const fix = /ключ|key|auth|401|unauthor/.test(lower)
    ? { label: "Настройки", run: () => granka.openSettings() }
    : /модел|model/.test(lower)
      ? { label: "Выбрать модель", run: () => openModelPopover() }
      : null;
  if (fix) {
    const button = document.createElement("button");
    button.className = "toastAction";
    button.textContent = fix.label;
    button.addEventListener("click", fix.run);
    box.append(button);
  }
  wrapper.append(box);
}

function renderAssistant(wrapper, body, text) {
  wrapper.__raw = text;
  body.innerHTML = window.mdToHtml(text);
}

function addUsage(wrapper, usage) {
  // Minimal chat: token/cost line is not rendered (stats stay in Analytics).
  return;
  const line = document.createElement("div");
  line.className = "usage";
  const cost = usage.cost >= 0.01 ? `$${usage.cost.toFixed(3)}` : `$${usage.cost.toFixed(5)}`;
  line.textContent = `вход ${formatTokens(usage.input)} · выход ${formatTokens(usage.output)} · ${cost}${usage.billed ? "" : " (оценка)"}`;
  line.title = `input ${usage.input}, output ${usage.output}, cache read ${usage.cacheRead}, всего ${usage.total}`;
  wrapper.append(line);
}

const TOOL_ICONS = {
  bash: "terminal",
  read: "file-text",
  write: "file-text",
  edit: "file-text",
  grep: "search",
  find: "search",
  ls: "folder",
  web_search: "globe",
  web_fetch: "globe",
  task: "bot",
  todo_write: "list-todo",
  ask_user: "help-circle",
  doc_outline: "file-text",
  doc_read: "file-text",
  doc_search: "search",
  doc_create: "file-text",
  doc_edit: "file-text",
  doc_format: "file-text",
  git_status: "folder",
  git_diff: "file-text",
  repo_map: "folder",
};

const TOOL_LABELS = {
  todo_write: "план",
  ask_user: "вопрос",
  web_search: "поиск в вебе",
  web_fetch: "чтение страницы",
  task: "подагент",
  doc_outline: "структура файла",
  doc_read: "чтение файла",
  doc_search: "поиск в файле",
  doc_create: "создание файла",
  doc_edit: "правка файла",
  doc_format: "оформление файла",
  git_status: "статус репозитория",
  git_diff: "изменения репозитория",
  repo_map: "карта проекта",
  bash: "bash",
  read: "чтение файла",
  write: "запись файла",
  edit: "правка файла",
  grep: "поиск в коде",
  find: "поиск файлов",
  ls: "список файлов",
};

const STARTERS = [
  "Объясни, что делает этот репозиторий",
  "Найди и исправь падающий тест",
  "Сделай ревью последних изменений",
];

function showEmptyState() {
  log.replaceChildren();
  const box = document.createElement("div");
  box.className = "emptyState";
  box.append(svgIcon("tray", "emptyStateIcon"));
  const title = document.createElement("h2");
  const hint = document.createElement("p");

  const hasKey = Boolean(config.hasApiKey ?? config.apiKey);
  if (hasKey) {
    title.textContent = "Готов к работе";
    hint.textContent = "Опишите задачу или нажмите «/» для команд.";
  } else {
    title.textContent = "Подключите модель";
    hint.textContent = "Нужен ключ OpenRouter — он хранится в ~/.granka.";
    const primary = document.createElement("button");
    primary.className = "softBtn";
    primary.textContent = "Открыть настройки";
    primary.addEventListener("click", () => granka.openSettings());
    box.append(title, hint, primary);
  }

  const starters = document.createElement("div");
  starters.className = "starters";
  for (const sample of STARTERS) {
    const chip = document.createElement("button");
    chip.className = "starter";
    chip.textContent = sample;
    // Without a key the starters lead nowhere: disable them instead of
    // letting the user put text into the composer that cannot be sent.
    chip.disabled = !hasKey;
    chip.addEventListener("click", () => {
      $("prompt").value = sample;
      autoGrow();
      $("prompt").focus();
    });
    starters.append(chip);
  }

  if (hasKey) {
    box.append(title, hint);
    const ask = document.createElement("button");
    ask.className = "primaryBtn";
    ask.textContent = "Спросить о проекте";
    ask.addEventListener("click", () => {
      $("prompt").value = STARTERS[0];
      autoGrow();
      $("prompt").focus();
    });
    box.append(ask);
  }
  box.append(starters);
  log.append(box);
}

function currentAssistant() {
  if (!streamWrapper) {
    ({ wrapper: streamWrapper, body: streamBody } = addMessage("assistant", ""));
    streamWrapper.__prompt = streamPrompt;
  }
  return streamBody;
}

// Markdown re-render of the whole accumulated text on every delta is O(n^2)
// on long answers: coalesce to one render per animation frame instead.
let streamRenderQueued = false;

function scheduleStreamRender() {
  if (streamRenderQueued) return;
  streamRenderQueued = true;
  requestAnimationFrame(() => {
    streamRenderQueued = false;
    if (!busy || !streamWrapper) return;
    // While streaming, keep the raw text in a <pre>: re-rendering markdown
    // on every delta would reset selection and code-block scroll. The
    // formatted render happens once when the answer settles (send()).
    // The model emits '\n\n' text blocks around tool calls; with pre-wrap
    // they pile up into big blank gaps that the final markdown render would
    // collapse. Collapse them here so streaming looks like the settled render.
    streamBody.textContent = streamText.replace(/(\n\s*){3,}/g, "\n\n");
    streamBody.classList.add("isStreaming");
  });
}

granka.onDelta((delta) => {
  if (!busy) return;
  setActivity("write");
  const stick = config.autoScroll === false ? false : stickToBottom();
  currentAssistant();
  streamText += delta;
  scheduleStreamRender();
  scrollIf(stick);
});

granka.onThinking((delta) => {
  if (!busy || thinkingMode() === "off") return;
  setActivity("think");
  const stick = config.autoScroll === false ? false : stickToBottom();
  currentAssistant();
  if (!thinkingBlock) {
    thinkingStartedAt = Date.now();
    thinkingBlock = document.createElement("div");
    thinkingBlock.className = "thinking isOpen";
    thinkingBlock.tabIndex = 0;
    thinkingBlock.setAttribute("role", "button");
    thinkingBlock.setAttribute("aria-expanded", "true");
    const head = document.createElement("div");
    head.className = "thinkingHead";
    head.append(svgIcon("brain"));
    const title = document.createElement("span");
    title.textContent = "мышление";
    head.append(title);
    const time = document.createElement("span");
    time.className = "thinkingTime";
    head.append(time);
    const body = document.createElement("pre");
    body.className = "thinkingBody";
    thinkingBlock.append(head, body);
    streamWrapper.insertBefore(thinkingBlock, streamBody);
    // Only the head toggles: the body stays selectable.
    head.addEventListener("click", (event) => {
      if (event.target.closest("a")) return;
      toggleThinking(thinkingBlock);
    });
    thinkingBlock.addEventListener("keydown", (event) => {
      if (event.target.closest(".thinkingBody")) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleThinking(thinkingBlock);
      }
    });
  }
  thinkingText += delta;
  thinkingBlock.querySelector(".thinkingBody").textContent = thinkingText;
  scrollIf(stick);
});

const NO_GROUP_TOOLS = new Set(["ask_user", "todo_write", "task"]);

const PATH_TOOLS = new Set([
  "read", "write", "edit", "ls",
  "doc_read", "doc_create", "doc_edit", "doc_format", "doc_outline",
]);

function formatDuration(ms) {
  if (!ms) return "";
  if (ms < 1000) return `${Math.round(ms)} мс`;
  return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")} с`;
}

function shortPath(filePath) {
  if (!filePath) return "";
  const normalized = String(filePath).replace(/\\/g, "/");
  const bases = [config.cwd, ...projects.map((item) => item?.cwd)].filter(Boolean);
  for (const base of bases) {
    const prefix = String(base).replace(/\\/g, "/").replace(/\/$/, "");
    if (prefix && normalized.startsWith(`${prefix}/`)) {
      return normalized.slice(prefix.length + 1);
    }
  }
  const parts = normalized.split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : normalized;
}

function pickArg(name, args) {
  let data = null;
  try { data = JSON.parse(args); } catch {}
  const pick = (...keys) => {
    for (const key of keys) {
      const value = data && typeof data === "object" ? data[key] : undefined;
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  };
  switch (name) {
    case "bash": return pick("command", "cmd");
    case "read": case "write": case "edit":
    case "doc_read": case "doc_create": case "doc_edit": case "doc_format": case "doc_outline":
      return pick("path", "file_path", "file");
    case "grep": return pick("pattern", "query");
    case "find": return pick("pattern", "glob", "query");
    case "ls": return pick("path");
    case "web_search": return pick("query");
    case "web_fetch": return pick("url");
    case "task": return pick("description");
    case "git_status": return "";
    case "git_diff": return pick("path");
    case "repo_map": return pick("path");
    case "todo_write": return "";
  }
  return "";
}

function toolPreview(name, args) {
  const raw = pickArg(name, args);
  if (!raw) return "";
  return PATH_TOOLS.has(name) ? shortPath(raw) : raw;
}

function toolFirstLine(args) {
  return (args ?? "").split("\n")[0].slice(0, 80);
}

function makeToolChip(name, args, toolCallId) {
  const chip = document.createElement("div");
  chip.className = "tool isRunning";
  chip.tabIndex = -1;
  chip.dataset.name = name;
  chip.setAttribute("role", "button");
  chip.setAttribute("aria-expanded", "false");
  chip.__detail = { name, args: args ?? "", result: "", durationMs: 0, isError: false, toolCallId: toolCallId ?? "", startedAt: Date.now() };
  const icon = svgIcon(TOOL_ICONS[name] ?? "square");
  icon.classList.add("toolIcon");
  chip.append(icon);
  // Subagent chips are two-line: role name over its live status (Group 5).
  const texts = document.createElement("span");
  texts.className = "toolTexts";
  const label = document.createElement("span");
  label.className = "toolLabel";
  const SUBAGENT_NAMES = {
    explore: "Поиск по коду",
    research: "Веб-исследование",
    review: "Ревью изменений",
    plan: "План работ",
    general: "Общая задача",
  };
  let agentRole = "";
  let agentTask = "";
  if (name === "task") {
    try {
      const parsed = JSON.parse(args ?? "{}");
      agentRole = parsed.agent ?? "";
      agentTask = String(parsed.description ?? "").replace(/\s+/g, " ").trim();
    } catch {}
  }
  label.textContent = agentRole ? (SUBAGENT_NAMES[agentRole] ?? "подагент") : (TOOL_LABELS[name] ?? name);
  label.title = toolPreview(name, args) || "";
  texts.append(label);
  if (name === "task") {
    const status = document.createElement("span");
    status.className = "toolStatus";
    status.textContent = "работает…";
    texts.append(status);
    chip.classList.add("isSubagent");
  }
  chip.append(texts);
  const preview = name === "task" ? (agentTask || toolFirstLine(args)) : (toolPreview(name, args) || toolFirstLine(args));
  if (preview) {
    const previewEl = document.createElement("span");
    previewEl.className = "toolArgs";
    previewEl.textContent = preview;
    previewEl.title = preview;
    chip.append(previewEl);
  }
  const time = document.createElement("span");
  time.className = "toolTime";
  chip.append(time);
  return chip;
}

function setToolIcon(chip, icon) {
  const use = chip.querySelector("svg use");
  if (use) use.setAttribute("href", `#i-${icon}`);
}

function updateGroupHead(group) {
  const list = group.querySelector(".toolGroupList");
  const chips = [...list.children];
  group.querySelector(".toolCount").textContent = `${chips.length} вызовов`;
  const total = chips.reduce((sum, chip) => sum + (chip.__detail?.durationMs || 0), 0);
  const totalText = formatDuration(total);
  group.querySelector(".toolTime").textContent = totalText ? `· ${totalText}` : "";
  const errors = chips.filter((chip) => chip.classList.contains("error")).length;
  group.classList.toggle("hasError", errors > 0);
  const badge = group.querySelector(".toolErrorBadge");
  if (badge) badge.textContent = errors ? `${errors} ош.` : "";
  group.classList.toggle("isCollapsed", chips.length >= 3);
  group.querySelector(".toolGroupHead")?.setAttribute("aria-expanded", String(chips.length < 3));
}

function toolGroupHead(group) {
  const head = document.createElement("div");
  head.className = "toolGroupHead";
  head.tabIndex = 0;
  head.setAttribute("role", "button");
  head.setAttribute("aria-expanded", "false");
  const icon = svgIcon(TOOL_ICONS[group.dataset.name] ?? "square");
  icon.classList.add("toolIcon");
  head.append(icon);
  const label = document.createElement("span");
  label.className = "toolLabel";
  label.textContent = TOOL_LABELS[group.dataset.name] ?? group.dataset.name;
  head.append(label);
  const count = document.createElement("span");
  count.className = "toolCount";
  head.append(count);
  const time = document.createElement("span");
  time.className = "toolTime";
  head.append(time);
  const badge = document.createElement("span");
  badge.className = "toolErrorBadge";
  head.append(badge);
  head.append(svgIcon("chevron-down", "icon chev"));
  const toggle = () => {
    group.classList.toggle("isCollapsed");
    head.setAttribute("aria-expanded", String(!group.classList.contains("isCollapsed")));
  };
  head.addEventListener("click", toggle);
  head.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
    }
  });
  return head;
}

// Consecutive same-tool calls collapse into one row: “чтение файла ×6 · 1.2 с”.
// In "live" mode chips live inside a collapsed summary block instead of
// the message flow; in "always" mode they sit directly before the answer.
let toolBlock = null;
let toolBlockList = null;
let toolDetailSeq = 0; // ids for aria-details wiring between a chip and its panel
let toolBlockHead = null;

function resetToolBlock() {
  toolBlock = null;
  toolBlockList = null;
  toolBlockHead = null;
}

function ensureToolBlock() {
  if (toolBlock) return toolBlock;
  toolBlock = document.createElement("div");
  toolBlock.className = "toolBlock";
  toolBlockHead = document.createElement("div");
  toolBlockHead.className = "toolBlockHead";
  toolBlockHead.tabIndex = 0;
  toolBlockHead.setAttribute("role", "button");
  toolBlockHead.setAttribute("aria-expanded", "false");
  const icon = svgIcon("terminal");
  icon.classList.add("toolIcon");
  const label = document.createElement("span");
  label.className = "toolLabel";
  label.textContent = "инструменты";
  const count = document.createElement("span");
  count.className = "toolCount";
  const time = document.createElement("span");
  time.className = "toolTime";
  const badge = document.createElement("span");
  badge.className = "toolErrorBadge";
  toolBlockHead.append(icon, label, count, time, badge, svgIcon("chevron-down", "icon chev"));
  const toggle = () => {
    toolBlock.classList.toggle("isOpen");
    toolBlockHead.setAttribute("aria-expanded", String(toolBlock.classList.contains("isOpen")));
  };
  toolBlockHead.addEventListener("click", toggle);
  toolBlockHead.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
    } else if (event.key === "ArrowDown") {
      const first = toolBlockList?.querySelector(".tool");
      if (!first) return;
      event.preventDefault();
      first.tabIndex = 0;
      first.focus();
    }
  });
  toolBlockList = document.createElement("div");
  toolBlockList.className = "toolList";
  toolBlock.append(toolBlockHead, toolBlockList);
  streamWrapper.insertBefore(toolBlock, streamBody);
  return toolBlock;
}

function updateToolBlockHead() {
  if (!toolBlockHead || !toolBlockList) return;
  const chips = [...toolBlockList.querySelectorAll(".tool")];
  const total = chips.reduce((sum, chip) => sum + (chip.__detail?.durationMs || 0), 0);
  const totalText = formatDuration(total);
  const errors = chips.filter((chip) => chip.classList.contains("error")).length;
  toolBlockHead.querySelector(".toolCount").textContent = `${chips.length} вызовов`;
  toolBlockHead.querySelector(".toolTime").textContent = totalText ? `· ${totalText}` : "";
  toolBlockHead.classList.toggle("hasError", errors > 0);
  const badge = toolBlockHead.querySelector(".toolErrorBadge");
  if (badge) badge.textContent = errors ? `${errors} ош.` : "";
}

// Live elapsed timer for running chips (500ms tick, stops when none run).
let toolElapsedTimer = null;
function startToolElapsedTicker() {
  if (toolElapsedTimer) return;
  toolElapsedTimer = setInterval(() => {
    if (!streamWrapper) { clearInterval(toolElapsedTimer); toolElapsedTimer = null; return; }
    const running = [...streamWrapper.querySelectorAll(".tool.isRunning:not(.done):not(.error):not(.isWaiting)")];
    if (!running.length) { clearInterval(toolElapsedTimer); toolElapsedTimer = null; return; }
    for (const chip of running) {
      const startedAt = chip.__detail?.startedAt;
      if (!startedAt) continue;
      const elapsed = formatDuration(Date.now() - startedAt);
      chip.querySelector(".toolTime").textContent = elapsed ? `· ${elapsed}` : "";
    }
  }, 500);
}

function appendToolChip(chip, name) {
  const inBlock = toolMode() === "live";
  if (inBlock) ensureToolBlock();
  const parent = inBlock ? toolBlockList : streamWrapper;
  const prev = inBlock ? parent.lastElementChild : streamBody.previousElementSibling;
  if (!NO_GROUP_TOOLS.has(name) && prev?.classList.contains("toolGroup") && prev.dataset.name === name) {
    prev.querySelector(".toolGroupList").append(chip);
    updateGroupHead(prev);
    if (inBlock) updateToolBlockHead();
    return;
  }
  if (!NO_GROUP_TOOLS.has(name) && prev?.classList.contains("tool") && prev.dataset.name === name) {
    const group = document.createElement("div");
    group.className = "toolGroup";
    group.dataset.name = name;
    const list = document.createElement("div");
    list.className = "toolGroupList";
    group.append(toolGroupHead(group), list);
    list.append(prev, chip);
    parent.insertBefore(group, inBlock ? null : streamBody);
    updateGroupHead(group);
    if (inBlock) updateToolBlockHead();
    return;
  }
  parent.insertBefore(chip, inBlock ? null : streamBody);
  if (inBlock) updateToolBlockHead();
}

granka.onTool((tool) => {
  if (!busy) return;
  const stick = stickToBottom();
  currentAssistant();
  setActivity(tool.phase === "start" ? "work" : "think", tool.name);
  if (tool.phase === "start") {
    // Subagents are always visible, even when other tools are hidden: the
    // user must see who is working on their behalf.
    if (toolMode() === "off" && tool.name !== "task") return;
    const chip = makeToolChip(tool.name, tool.args, tool.toolCallId);
    startToolElapsedTicker();
    if (tool.name === "task") {
      streamWrapper.insertBefore(chip, streamBody);
      scrollIf(stick);
      return;
    }
    // Per-file lock marker: another edit to the same file is still running,
    // so this one waits (the agent serializes same-file edits).
    const target = pickArg(tool.name, tool.args);
    const busy = target && [...streamWrapper.querySelectorAll(".tool.isRunning")].some((other) =>
      other.__detail && pickArg(other.__detail.name, other.__detail.args) === target,
    );
    if (busy) {
      chip.classList.add("isWaiting");
      chip.querySelector(".toolTime").textContent = "· ждёт";
    }
    appendToolChip(chip, tool.name);
  } else {
    // Bind end to the exact call by id (parallel tools finish out of order);
    // fall back to the last running chip for legacy events without an id.
    let chip = null;
    if (tool.toolCallId) {
      chip = [...streamWrapper.querySelectorAll(".tool.isRunning:not(.done):not(.error)")]
        .find((el) => el.__detail?.toolCallId === tool.toolCallId) ?? null;
    }
    if (!chip) {
      const pending = [...streamWrapper.querySelectorAll(".tool.isRunning:not(.done):not(.error)")];
      chip = pending[pending.length - 1] ?? null;
    }
    if (chip) {
      chip.__detail.result = tool.result ?? "";
      chip.__detail.durationMs = tool.durationMs ?? 0;
      chip.__detail.isError = Boolean(tool.isError);
      chip.classList.remove("isRunning");
      chip.classList.add(tool.isError ? "error" : "done");
      setToolIcon(chip, tool.isError ? "circle-alert" : "check");
      const chipTime = formatDuration(tool.durationMs);
      chip.querySelector(".toolTime").textContent = chipTime ? `· ${chipTime}` : "";
      const status = chip.querySelector(".toolStatus");
      if (status) status.textContent = tool.isError ? "ошибка" : "готово";
      announce(tool.isError ? "Подагент завершился с ошибкой." : "Подагент завершён.");
      if (tool.isError) chip.classList.add("hasResult");
      const group = chip.closest(".toolGroup");
      if (group) updateGroupHead(group);
      if (toolBlock) updateToolBlockHead();
    }
  }
  scrollIf(stick);
});

let bgTasks = [];
let bgPanelHidden = false;

async function renderBgPanel() {
  try {
    bgTasks = await granka.listBackgroundTasks();
  } catch {
    return;
  }
  const panel = $("bgPanel");
  if (!panel) return;
  const running = bgTasks.filter((task) => task.status === "running").length;
  $("bgPanelCount").textContent = running ? `${running} работает` : `${bgTasks.length}`;
  panel.hidden = !bgTasks.length;
  const items = $("bgPanelItems");
  items.hidden = bgPanelHidden;
  const toggle = $("bgPanelToggle");
  if (toggle) {
    const action = bgPanelHidden ? "Развернуть" : "Свернуть";
    toggle.title = `${action} панель`;
    toggle.setAttribute("aria-label", `${action} панель фоновых задач`);
    toggle.setAttribute("aria-expanded", String(!bgPanelHidden));
    toggle.classList.toggle("isCollapsed", bgPanelHidden);
  }
  items.replaceChildren();
  for (const task of [...bgTasks].reverse()) {
    const row = document.createElement("div");
    row.className = `bgRow${task.status === "done" ? " isDone" : ""}${task.status === "error" ? " isError" : ""}`;
    const title = document.createElement("span");
    title.className = "bgRowTitle";
    title.textContent = `${task.agent}: ${task.description}`;
    title.title = title.textContent;
    const status = document.createElement("span");
    status.className = "bgRowStatus";
    status.textContent = task.status === "running" ? "работает…"
      : task.status === "done" ? "готово"
      : task.status === "canceled" ? "отменено" : "ошибка";
    row.append(title, status);
    if (task.status === "running") {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "iconBtn";
      cancel.title = "Отменить задачу";
      cancel.setAttribute("aria-label", `Отменить задачу: ${task.description}`);
      cancel.append(svgIcon("x"));
      cancel.addEventListener("click", async () => {
        await granka.cancelBackgroundTask(task.id);
        renderBgPanel();
      });
      row.append(cancel);
    }
    row.classList.toggle("isCanceled", task.status === "canceled");
    items.append(row);
    if (task.status !== "running" && task.text) {
      const result = document.createElement("div");
      result.className = "bgRowResult";
      result.textContent = task.text;
      items.append(result);
    }
  }
}

$("bgPanelToggle")?.addEventListener("click", () => {
  bgPanelHidden = !bgPanelHidden;
  renderBgPanel();
});

granka.onNotice((notice) => {
  if (notice.kind === "todo") {
    renderPlan(notice.items, notice.cleared);
    return;
  }
  if (notice.kind === "doc") {
    const label = notice.action === "create" ? "файл создан" : notice.action === "format" ? "оформление обновлено" : "файл изменён";
    addDivider(`${label}: ${notice.path}`);
    return;
  }
  if (notice.kind === "hook") {
    addDivider(notice.output);
    return;
  }
  if (notice.kind === "checkpoint") {
    addCheckpointDivider(notice.id);
    return;
  }
  if (notice.kind === "subagent") {
    const line = document.createElement("div");
    line.className = "subagentResult";
    const label = document.createElement("span");
    label.textContent = `подагент: ${notice.description}`;
    const size = document.createElement("span");
    size.className = "subagentResultSize";
    size.textContent = `${notice.chars} символов`;
    line.append(label, size);
    log.append(line);
    return;
  }
  if (notice.kind === "subtool") {
    // Live progress inside the running task chip (last one wins).
    const chips = streamWrapper ? [...streamWrapper.querySelectorAll('.tool[data-name="task"].isRunning')] : [];
    const chip = chips[chips.length - 1];
    const status = chip?.querySelector(".toolStatus");
    if (status) {
      status.textContent = notice.phase === "start" ? `работает · ${notice.name}…` : `работает · ${notice.name} готово`;
    }
    return;
  }
  if (notice.kind === "backgroundTask") {
    renderBgPanel();
    if (notice.task?.status === "done") {
      addDivider(`фоновая задача готова: ${notice.task.agent} — ${notice.task.description}`);
      toast("Фоновая задача завершена");
    } else if (notice.task?.status === "error") {
      addDivider(`фоновая задача упала: ${notice.task.agent} — ${notice.task.text}`);
    } else if (notice.task?.status === "canceled") {
      addDivider(`фоновая задача отменена: ${notice.task.description}`);
    }
    return;
  }
  if (notice.kind === "compaction") {
    stopCompactionBar();
    addDivider(notice.aborted ? "сжатие отменено" : "контекст сжат");
  } else if (notice.kind === "queue") {
    queued = notice.steering + notice.followUp;
    syncQueueBadge();
    if (queued) setStatus(`в очереди: ${queued}`);
  }
});

function renderDiff(args) {
  let data = null;
  try { data = JSON.parse(args); } catch {}
  if (!data || typeof data !== "object") return null;
  const before = typeof data.oldText === "string" ? data.oldText : null;
  const after = typeof data.newText === "string" ? data.newText : null;
  if (before === null && after === null) return null;
  const diff = document.createElement("div");
  diff.className = "toolDiff";
  const addLines = (text, cls) => {
    if (text === null) return;
    text.split("\n").forEach((line, index) => {
      const row = document.createElement("div");
      row.className = `diffLine ${cls}`;
      const num = document.createElement("span");
      num.className = "diffNum";
      num.textContent = String(index + 1);
      num.setAttribute("aria-hidden", "true");
      row.append(num, document.createTextNode((cls === "del" ? "− " : "+ ") + line));
      diff.append(row);
    });
  };
  addLines(before, "del");
  addLines(after, "add");
  return diff;
}

function detailSection(title, text) {
  const section = document.createElement("div");
  section.className = "toolDetailSection";
  const head = document.createElement("div");
  head.className = "toolDetailTitle";
  head.textContent = title;
  const pre = document.createElement("pre");
  pre.className = "toolDetailPre";
  pre.textContent = text;
  section.append(head, pre);
  return section;
}

function parseJson(text) {
  try {
    const data = JSON.parse(text);
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

function unwrapResult(result) {
  if (!result) return "";
  const data = parseJson(result);
  if (!data) return result;
  if (Array.isArray(data.content)) {
    const texts = data.content
      .filter((part) => part && (part.type === "text" || typeof part.text === "string"))
      .map((part) => part.text ?? "");
    if (texts.length) return texts.join("\n");
  }
  if (typeof data.text === "string") return data.text;
  if (typeof data.output === "string") return data.output;
  return result;
}

function argsSection(args) {
  const section = document.createElement("div");
  section.className = "toolDetailSection";
  const head = document.createElement("div");
  head.className = "toolDetailTitle";
  head.textContent = "аргументы";
  section.append(head);
  const data = parseJson(args);
  if (!data) {
    const pre = document.createElement("pre");
    pre.className = "toolDetailPre";
    pre.textContent = args || "(нет)";
    section.append(pre);
    return section;
  }
  const entries = Object.entries(data);
  if (!entries.length) {
    const pre = document.createElement("pre");
    pre.className = "toolDetailPre";
    pre.textContent = "(нет)";
    section.append(pre);
    return section;
  }
  for (const [k, v] of entries) {
    const main = document.createElement("div");
    main.className = "argRow";
    const key = document.createElement("span");
    key.className = "argKey";
    key.textContent = k;
    const value = document.createElement("span");
    value.className = "argValue";
    value.textContent = typeof v === "string" ? v : JSON.stringify(v);
    main.append(key, value);
    section.append(main);
  }
  return section;
}

// The detail a chip owns: found by aria-details, or as its next sibling.
// Both cases matter — live chips carry the detail inline, history chips open
// it after the whole list.
function toolDetailOf(chip) {
  const id = chip.getAttribute("aria-details");
  const byId = id ? document.getElementById(id) : null;
  if (byId?.classList.contains("toolDetail")) return byId;
  const next = chip.nextElementSibling;
  return next?.classList.contains("toolDetail") ? next : null;
}

function toggleToolDetail(chip) {
  // Close this chip's own detail first: removing siblings before the check
  // also removed its own detail, so a second click re-opened it.
  const existing = toolDetailOf(chip);
  if (existing) {
    existing.remove();
    chip.setAttribute("aria-expanded", "false");
    chip.removeAttribute("aria-details");
    return;
  }
  // One detail per parent.
  const scope = chip.closest(".msg") ?? chip.parentElement;
  for (const other of [...scope.querySelectorAll(".toolDetail")]) other.remove();
  for (const other of [...scope.querySelectorAll(".tool[aria-expanded='true']")]) {
    other.setAttribute("aria-expanded", "false");
    other.removeAttribute("aria-details");
  }
  const detail = document.createElement("div");
  detail.className = "toolDetail";
  detail.setAttribute("role", "region");
  detail.setAttribute("aria-label", `Детали инструмента ${chip.__detail?.name ?? ""}`);
  const { name, args, result, durationMs, isError } = chip.__detail;
  const label = TOOL_LABELS[name] ?? name;
  const head = document.createElement("div");
  head.className = "toolDetailHead";
  const title = document.createElement("span");
  title.className = "toolDetailName";
  const durationText = formatDuration(durationMs);
  title.textContent = `${label}${isError ? " · ошибка" : ""}${durationText ? ` · ${durationText}` : ""}`;
  head.append(title);
  const copy = document.createElement("button");
  copy.className = "toolDetailCopy";
  copy.append(svgIcon("copy"));
  const copyLabel = document.createElement("span");
  copyLabel.textContent = "копировать";
  copy.append(copyLabel);
  copy.addEventListener("click", async () => {
    await copyText(`${args}\n\n— результат —\n${unwrapResult(result) || "(нет)"}`);
    copyLabel.textContent = "скопировано";
    setTimeout(() => (copyLabel.textContent = "копировать"), 1500);
  });
  head.append(copy);
  detail.append(head);
  const diff = renderDiff(args);
  if (diff) {
    const section = document.createElement("div");
    section.className = "toolDetailSection";
    const diffTitle = document.createElement("div");
    diffTitle.className = "toolDetailTitle";
    diffTitle.textContent = "изменения";
    section.append(diffTitle, diff);
    detail.append(section);
  }
  detail.append(argsSection(args));
  detail.append(detailSection("результат", unwrapResult(result) || "(нет)"));
  // In history the chips live in a flex column: put the detail after that
  // column, not between the rows.
  detail.id = `tool-detail-${++toolDetailSeq}`;
  chip.setAttribute("aria-details", detail.id);
  const detailHost = chip.parentElement.classList.contains("toolList") ? chip.parentElement : chip;
  detailHost.after(detail);
  chip.setAttribute("aria-expanded", "true");
}

log.addEventListener("click", (event) => {
  const chip = event.target.closest(".tool");
  if (chip) toggleToolDetail(chip);
});

log.addEventListener("focusout", (event) => {
  const chip = event.target.closest?.(".tool");
  if (chip && !event.relatedTarget?.closest?.(".tool")) chip.tabIndex = -1;
});

log.addEventListener("keydown", (event) => {
  const chip = event.target.closest?.(".tool");
  if (chip) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleToolDetail(chip);
    } else if (event.key === "ArrowUp" && chip === chip.parentElement.querySelector(".tool")) {
      event.preventDefault();
      chip.tabIndex = -1;
      toolBlockHead?.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const chips = [...chip.parentElement.querySelectorAll(".tool")];
      const next = chips[chips.indexOf(chip) + (event.key === "ArrowDown" ? 1 : -1)];
      if (!next) return;
      chip.tabIndex = -1;
      next.tabIndex = 0;
      next.focus();
    }
    return;
  }
  // From a block/group head, ArrowDown enters its chip list (chips are
  // roving-tabindex: one Tab stop per group, not per chip).
  const head = event.target.closest?.(".toolBlockHead, .toolGroupHead");
  if (head && event.key === "ArrowDown") {
    event.preventDefault();
    head.parentElement.querySelector(".tool")?.focus();
  }
});

log.addEventListener("scroll", syncScrollButton);
$("scrollDown").addEventListener("click", () => {
  log.scrollTop = log.scrollHeight;
  $("scrollDown").hidden = true;
});

// --- sidebar ---------------------------------------------------------------

function toggleSidebar() {
  const hidden = document.body.classList.toggle("noSidebar");
  $("sidebarToggle").setAttribute("aria-expanded", String(!hidden));
  localStorage.setItem("granka.sidebar", hidden ? "hidden" : "shown");
}

$("sidebarToggle").addEventListener("click", toggleSidebar);

// Sidebar resize by dragging its right edge (200–400px, saved locally).
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 400;
function applySidebarWidth(width) {
  const clamped = Math.min(Math.max(Math.round(width) || 232, SIDEBAR_MIN), SIDEBAR_MAX);
  document.documentElement.style.setProperty("--sidebar-w", `${clamped}px`);
  localStorage.setItem("granka.sidebarWidth", String(clamped));
}

function initSidebarResize() {
  const sidebar = $("sidebar");
  if (!sidebar) return;
  const handle = document.createElement("div");
  handle.className = "sidebarResize";
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-label", "Изменить ширину боковой панели");
  handle.tabIndex = 0;
  sidebar.append(handle);
  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    const move = (moveEvent) => {
      applySidebarWidth(moveEvent.clientX);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
  handle.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const current = Number(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-w")) || 232;
    applySidebarWidth(current + (event.key === "ArrowRight" ? 8 : -8));
  });
  handle.addEventListener("dblclick", () => applySidebarWidth(232));
}

function renderProjectLabel() {
  const project = projects.find((item) => item.id === activeProjectId);
  $("projectName").textContent = project ? project.name : "Без проекта";
  $("projectPopup").title = project?.cwd || "Проект не выбран";
  const meta = $("projectCardMeta");
  if (meta) {
    const count = sessions.length;
    meta.textContent = project
      ? [project.cwd ? project.cwd.split(/[\\/]/).pop() : "", count ? plural(count, ["диалог", "диалога", "диалогов"]) : ""].filter(Boolean).join(" · ")
      : "";
  }
}

let draftSeq = 0;
let draftKeyValue = "draft";

function planKey() {
  return currentSessionId || draftKeyValue;
}

function renderPlan(items, cleared = false) {
  const key = planKey();
  if (cleared || !items?.length) plans.delete(key);
  else plans.set(key, items);
  renderPlanStrip();
}

function renderPlanStrip() {
  const items = plans.get(planKey()) ?? [];
  const strip = $("planStrip");
  strip.hidden = items.length === 0;
  if (!items.length) return;

  const done = items.filter((item) => item.status === "completed").length;
  $("planStripCount").textContent = `${done}/${items.length}`;
  $("planProgressFill").style.width = `${Math.round((done / items.length) * 100)}%`;

  const list = $("planStripItems");
  const expanded = $("planStripToggle").getAttribute("aria-expanded") === "true";
  const pending = items.filter((item) => item.status !== "completed");
  const lastDone = [...items].reverse().find((item) => item.status === "completed");
  const visible = expanded ? items : [...(lastDone ? [lastDone] : []), ...pending.slice(0, 2)];
  const rows = visible.map((item) => {
    const row = document.createElement("div");
    row.className = `planRow is-${item.status}`;
    row.append(Object.assign(document.createElement("span"), { className: "planDot" }));
    const text = document.createElement("span");
    text.textContent = item.content;
    row.append(text);
    const status = document.createElement("span");
    status.className = "planStatus";
    status.textContent = item.status === "completed" ? "готово" : item.status === "in_progress" ? "в работе" : "ждёт";
    row.append(status);
    return row;
  });
  if (!expanded && items.length > visible.length) {
    const more = document.createElement("div");
    more.className = "planRow planMore";
    more.textContent = `ещё ${items.length - visible.length}`;
    rows.push(more);
  }
  list.replaceChildren(...rows);
  list.hidden = visible.length === 0;
  strip.setAttribute("aria-live", "polite");
}

$("planStripToggle").addEventListener("click", () => {
  const button = $("planStripToggle");
  const expanded = button.getAttribute("aria-expanded") === "true";
  button.setAttribute("aria-expanded", String(!expanded));
  button.title = expanded ? "Развернуть все задачи" : "Свернуть задачи";
  button.setAttribute("aria-label", button.title);
  button.classList.toggle("isOpen", !expanded);
  renderPlanStrip();
});

$("planStripClear").addEventListener("click", () => {
  plans.delete(planKey());
  renderPlanStrip();
});

let currentQuestionId = "";
let lastModalTrigger = null;

function setBackgroundInert(on) {
  for (const id of ["shell", "toolbar"]) {
    const el = $(id);
    if (el) el.inert = on;
  }
}

function closeQuestion(answer) {
  const modal = $("questionModal");
  if (modal.hidden) return;
  modal.hidden = true;
  setBackgroundInert(false);
  granka.answer(currentQuestionId, answer);
  currentQuestionId = "";
  (lastModalTrigger ?? $("prompt")).focus();
}

function renderQuestion(payload) {
  // Timeout-dismiss from the main process: the question already resolved
  // with an empty answer, just hide the modal without sending another one.
  if (payload.closed) {
    if (payload.id === currentQuestionId) {
      $("questionModal").hidden = true;
      setBackgroundInert(false);
      currentQuestionId = "";
      (lastModalTrigger ?? $("prompt")).focus();
    }
    return;
  }
  lastModalTrigger = document.activeElement;
  currentQuestionId = payload.id ?? "";
  const modal = $("questionModal");
  const options = $("questionOptions");
  const freeform = $("questionFreeform");
  $("questionHeader").textContent = payload.header ?? "";
  $("questionHeader").hidden = !payload.header;
  $("questionTitle").textContent = payload.question ?? "";
  options.replaceChildren();
  freeform.hidden = payload.allowFreeform === false;

  for (const option of payload.options ?? []) {
    const button = document.createElement("button");
    button.className = "questionOption";
    const label = document.createElement("b");
    label.textContent = option.label;
    button.append(label);
    if (option.description) {
      const note = document.createElement("span");
      note.textContent = option.description;
      button.append(note);
    }
    button.addEventListener("click", () => closeQuestion(option.label));
    options.append(button);
  }

  $("questionCancel").onclick = () => closeQuestion("");
  const input = $("questionInput");
  input.value = "";
  $("questionSubmit").onclick = () => {
    const value = input.value.trim();
    if (value) closeQuestion(value);
  };
  input.onkeydown = (event) => {
    if (event.key === "Enter") $("questionSubmit").click();
    if (event.key === "Escape") closeQuestion("");
  };

  modal.hidden = false;
  setBackgroundInert(true);
  options.querySelector("button")?.focus();
}

// Question modal: Escape and overlay click close it, Tab stays inside.
// Registered once; renderQuestion only fills the content.
$("questionModal").addEventListener("click", (event) => {
  if (event.target === $("questionModal")) closeQuestion("");
});

document.addEventListener("keydown", (event) => {
  const modal = $("questionModal");
  if (modal.hidden) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopImmediatePropagation();
    closeQuestion("");
    return;
  }
  if (event.key === "Tab") trapTab(modal, event);
});

function updateToolbarChatTitle() {
  const el = $("chatTitle");
  if (!el) return;
  const session = sessions.find((item) => item.id === currentSessionId);
  el.textContent = session?.title ?? "";
  el.title = session?.title ?? "";
}


function highlightMatch(text, query) {
  if (!query) return document.createTextNode(text);
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return document.createTextNode(text);
  const fragment = document.createDocumentFragment();
  fragment.append(
    document.createTextNode(text.slice(0, index)),
    Object.assign(document.createElement("mark"), { textContent: text.slice(index, index + query.length) }),
    document.createTextNode(text.slice(index + query.length)),
  );
  return fragment;
}

function startRailRename(item) {
  const row = $("sessionList").querySelector(`[data-id="${item.id}"]`);
  if (!row) return;
  const title = row.querySelector(".sessionTitle");
  const input = document.createElement("input");
  input.className = "sessionRename";
  input.value = item.title;
  input.setAttribute("aria-label", "Новое название диалога");
  title.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (save && name) {
      const result = await granka.renameSession(item.id, name);
      if (!result.ok) fail(result.error);
      else toast("Имя сохранено");
    }
    await refreshSessions();
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") finish(true);
    if (event.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

function sortSessions(items) {
  const pinned = new Set(config.pinnedSessions ?? []);
  const mode = config.sessionSort ?? "recent";
  const sorted = [...items];
  sorted.sort((a, b) => {
    const pinDiff = Number(pinned.has(b.id)) - Number(pinned.has(a.id));
    if (pinDiff) return pinDiff;
    if (mode === "name") return a.title.localeCompare(b.title);
    if (mode === "size") return (b.weight ?? 0) - (a.weight ?? 0);
    return String(b.modified).localeCompare(String(a.modified));
  });
  return sorted;
}

function openSessionMenu(x, y, item) {
  const pinned = new Set(config.pinnedSessions ?? []);
  const panel = $("popover");
  panel.replaceChildren();
  const add = (label, options = {}) => panel.append(popoverItem(label, options));
  const separator = () =>
    panel.append(Object.assign(document.createElement("div"), { className: "popoverSeparator" }));

  add("Открыть", { onSelect: () => switchSession(item.id) });
  add("Переименовать", { icon: "pencil", onSelect: () => startRailRename(item) });
  add(pinned.has(item.id) ? "Открепить" : "Закрепить", {
    icon: "star",
    onSelect: async () => {
      if (pinned.has(item.id)) pinned.delete(item.id);
      else pinned.add(item.id);
      if (await saveConfig({ pinnedSessions: [...pinned] })) renderSessions();
    },
  });
  add("Дублировать", {
    icon: "copy",
    onSelect: async () => {
      const result = await granka.duplicateSession(item.id);
      if (!result.ok) return fail(result.error);
      await refreshSessions();
      await switchSession(result.id);
      toast("Диалог продублирован");
    },
  });
  add("Сохранить в файл…", {
    icon: "file-text",
    onSelect: async () => {
      const result = await granka.exportSessionFile([item.id]);
      if (!result.ok) return fail(result.error ?? "Не удалось сохранить файл. Повторите попытку");
      toast(`Сохранено: ${result.path}`);
    },
  });
  add("Скопировать Markdown", {
    icon: "file-text",
    onSelect: async () => {
      const result = await granka.exportSessions([item.id]);
      if (!result.ok) return fail(result.error ?? "Не удалось скопировать Markdown. Повторите попытку");
      await copyText(result.text);
      toast("Диалог скопирован в буфер как Markdown");
    },
  });
  add("Показать файл", { icon: "folder", onSelect: () => granka.revealSession(item.id) });

  separator();
  const moveHeading = document.createElement("div");
  moveHeading.className = "popoverHint";
  moveHeading.textContent = "Перенести в проект";
  panel.append(moveHeading);
  add("Без проекта", {
    icon: "circle",
    current: !item.projectId,
    onSelect: async () => {
      await granka.assignSession(item.id, "");
      await refreshSessions();
      toast("Диалог перенесён в «Без проекта»");
    },
  });
  for (const project of projects) {
    add(project.name, {
      meta: project.cwd ? project.cwd.split(/[\\/]/).pop() : undefined,
      icon: "folder",
      current: project.id === item.projectId,
      onSelect: async () => {
        await granka.assignSession(item.id, project.id);
        await refreshSessions();
        toast(`Диалог перенесён в «${project.name}»`);
      },
    });
  }

  separator();
  add("Удалить", {
    danger: true,
    icon: "trash-2",
    onSelect: async () => {
      const ok = await granka.confirm(`Удалить диалог «${item.title}»?`, "Диалог будет удалён без возможности восстановления.");
      if (!ok) return;
      const result = await granka.deleteSession(item.id);
      if (!result.ok) return fail(result.error);
      if (item.id === currentSessionId) {
        await granka.newSession();
        currentSessionId = "";
        await refreshHistory();
      }
      await refreshSessions();
      toast("Диалог удалён");
    },
  });

  panel.hidden = false;
  const width = panel.offsetWidth;
  panel.style.left = `${Math.min(x, window.innerWidth - width - 8)}px`;
  panel.style.top = `${Math.min(y, window.innerHeight - panel.offsetHeight - 8)}px`;
  popoverAnchor = document.querySelector(`.sessionItem[data-id="${item.id}"]`);
  if (popoverAnchor) popoverAnchor.setAttribute("aria-expanded", "true");
  panel.querySelector("button")?.focus();
}

function renderSessions() {
  const list = $("sessionList");
  const query = $("sessionSearch").value.trim();
  const pinned = new Set(config.pinnedSessions ?? []);
  sessions = sortSessions(sessions);
  list.replaceChildren();

  $("sessionCount").textContent = String(sessions.length || "");

  if (!sessions.length) {
    const empty = document.createElement("div");
    empty.className = "sidebarEmpty";
    empty.append(svgIcon("tray", "emptyIcon"));
    const emptyText = document.createElement("span");
    if (query) {
      emptyText.textContent = "Ничего не найдено. ";
      const reset = document.createElement("button");
      reset.className = "linkBtn";
      reset.textContent = "Сбросить";
      reset.addEventListener("click", () => {
        $("sessionSearch").value = "";
        refreshSessions();
      });
      empty.append(emptyText, reset);
    } else {
      emptyText.textContent = "Диалогов пока нет.";
      empty.append(emptyText);
    }
    list.append(empty);
    return;
  }

  // Absolute scale: share of the current model's context window, estimated
  // from message chars (chars/4). The previous relative scale (longest
  // session = 100%) made every list look full regardless of real size.
  const modelWindow = modelById(config.model)?.context ?? 0;

  sessions.forEach((item, index) => {
    const row = document.createElement("div");
    const active = item.id === currentSessionId;
    row.className = `sessionItem${active ? " isActive" : ""}`;
    row.setAttribute("role", "listitem");
    row.dataset.id = item.id;
    row.dataset.projectId = item.projectId ?? "";
    if (active) row.setAttribute("aria-current", "true");
    row.tabIndex = active || index === 0 ? 0 : -1;
    const open = document.createElement("button");
    open.className = "sessionOpen";
    open.setAttribute("aria-haspopup", "dialog");
    open.title = `${item.title} — Shift+F10: действия`;

    const title = document.createElement("span");
    title.className = "sessionTitle";
    if (pinned.has(item.id)) title.append(svgIcon("star", "icon pinIcon"));
    title.append(highlightMatch(item.title, query));
    const meta = document.createElement("span");
    meta.className = "sessionMeta";
    const date = new Date(item.modified).toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    // Context occupancy as text (no misleading bars): share of the current
    // model's window, estimated from message chars.
    let contextText = "";
    if (item.weight && modelWindow > 0) {
      const tokens = Math.round(item.weight / 4);
      const raw = Math.min(100, (tokens / modelWindow) * 100);
      // Sub-1% shares round to a meaningless 0%: keep one decimal instead.
      const percent = raw < 10 ? raw.toFixed(1).replace(/\.0$/, "") : String(Math.round(raw));
      contextText = ` · ${percent}%`;
      meta.title = `~${formatTokens(tokens)} токенов · ${percent}% контекста ${config.model ?? ""}`;
    }
    meta.textContent = `${date}${contextText}`;
    open.append(title, meta);
    const menuBtn = document.createElement("button");
    menuBtn.className = "sessionMenuBtn";
    menuBtn.setAttribute("aria-label", `Действия: ${item.title}`);
    menuBtn.setAttribute("aria-haspopup", "dialog");
    menuBtn.append(svgIcon("ellipsis"));
    menuBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      const rect = menuBtn.getBoundingClientRect();
      openSessionMenu(rect.left, rect.bottom + 4, item);
    });
    row.append(open, menuBtn);

    open.addEventListener("click", () => switchSession(item.id));
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openSessionMenu(event.clientX, event.clientY, item);
    });
    list.append(row);
  });

  const activeRow = list.querySelector(".sessionItem.isActive");
  activeRow?.scrollIntoView({ block: "nearest" });
}

async function refreshTitle() {
  const project = projects.find((item) => item.id === (currentProjectId || activeProjectId));
  document.title = project ? `${project.name} — granka` : "granka";
}

let agentDir = "";
let currentProjectId = "";

async function refreshSessions() {
  // strict binding: the sidebar only ever shows this project's chats
  const list = $("sessionList");
  if (!sessions.length && list) {
    list.replaceChildren();
    const status = document.createElement("div");
    status.className = "sessionLoading";
    status.textContent = "Загрузка диалогов…";
    list.append(status);
  }
  try {
    sessions = await granka.listSessions($("sessionSearch").value, { projectId: activeProjectId });
  } catch (err) {
    sessions = [];
    const box = document.createElement("div");
    box.className = "sessionError";
    box.setAttribute("role", "alert");
    const text = document.createElement("span");
    text.textContent = `Не удалось загрузить диалоги: ${err?.message ?? err}`;
    const retry = document.createElement("button");
    retry.className = "ghostBtn";
    retry.textContent = "Повторить";
    retry.addEventListener("click", () => refreshSessions());
    box.append(text, retry);
    list.replaceChildren(box);
    return;
  }
  renderSessions();
  await refreshTitle();
}

async function switchSession(id) {
  if (busy) return fail("Дождитесь ответа или нажмите «Стоп»");
  if (!id || id === currentSessionId) return;
  saveDraft();
  const result = await granka.openSession(id);
  if (!result.ok) return fail(result.error);
  $("sessionSearch").value = ""; // never keep a filter from the previous session
  config = await granka.loadConfig();
  await refreshProjects();
  await refreshSessions();
  await refreshHistory();
  restoreDraft();
  setStatus("");
}

// keyboard navigation for the source list (HIG: arrow keys move, Return opens)
$("sessionList").addEventListener("keydown", (event) => {
  if (!sessions.length) return;
  if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") {
    event.preventDefault();
    const item = sessions[listIndex] ?? sessions.find((entry) => entry.id === currentSessionId) ?? sessions[0];
    if (!item) return;
    const row = $("sessionList").querySelector(`[data-id="${item.id}"]`);
    const rect = row?.getBoundingClientRect();
    if (rect) openSessionMenu(rect.left + 16, rect.bottom, item);
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    listIndex = Math.min(Math.max(listIndex + delta, 0), sessions.length - 1);
    const rows = [...$("sessionList").querySelectorAll(".sessionItem")];
    rows.forEach((row, index) => { row.tabIndex = index === listIndex ? 0 : -1; });
    rows[listIndex]?.querySelector(".sessionOpen")?.focus();
    rows[listIndex]?.scrollIntoView({ block: "nearest" });
  } else if (event.key === "Enter" && listIndex >= 0) {
    event.preventDefault();
    switchSession(sessions[listIndex].id);
  }
});

// --- history ---------------------------------------------------------------

async function refreshHistory() {
  const history = await granka.history();
  currentSessionId = history.sessionId ?? "";
  currentProjectId = history.projectId ?? "";
  listIndex = -1;
  historyMessages = history.messages;
  visibleCount = 40;
  if (history.plan) plans.set(history.sessionId ?? currentSessionId, history.plan);
  renderHistoryWindow();
  renderPlanStrip();
  syncScrollButton();
  showContext(history.context);
  renderSessions(); // keep the active highlight in sync with the opened chat
  await refreshTitle();
}

// Long chats are rendered in a window: the DOM keeps only the tail, older
// messages load on demand instead of growing without bound.
function dayLabel(ts) {
  if (!ts) return "";
  const date = new Date(Number(ts));
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(date, today)) return "Сегодня";
  if (sameDay(date, yesterday)) return "Вчера";
  return date.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: date.getFullYear() !== today.getFullYear() ? "numeric" : undefined });
}

// One history turn (user or a whole assistant turn) rendered with its
// thinking, tool calls, usage and attachments — not just bare text.
function renderHistoryTurn(message, promptText) {
  const { wrapper, body } = addMessage(message.role, message.text, { animate: false });
  if (message.role === "user") {
    // The attachment note is part of the prompt text: show it as chips.
    const note = /\n\n\[Вложения сессии — читай их через doc_outline\/doc_read по этим путям\]\n([\s\S]*)$/.exec(message.text);
    if (note) {
      const items = note[1]
        .split("\n")
        .map((line) => /^- (.+?) \(([^,]+),/.exec(line.trim()))
        .filter(Boolean)
        .map((match) => ({ name: match[1].split(/[\\/]/).pop(), path: match[1] }));
      body.textContent = message.text.slice(0, note.index);
      appendBubbleAttachments(wrapper, items);
    }
    return;
  }
  wrapper.__prompt = promptText ?? "";
  if (message.thinking && thinkingMode() !== "off") {
    const block = buildThinkingBlock(message.thinking, thinkingMode() === "always", message.thinkingMs);
    wrapper.insertBefore(block, body);
  }
  const historyTools = message.tools ?? [];
  if (historyTools.length && toolMode() !== "off") {
    // Same summary as live: one collapsible block per turn instead of a
    // flat row of identical pills.
    const block = document.createElement("div");
    block.className = "toolBlock";
    const head = document.createElement("div");
    head.className = "toolBlockHead";
    head.tabIndex = 0;
    head.setAttribute("role", "button");
    head.setAttribute("aria-expanded", "false");
    head.append(svgIcon("terminal"));
    const headLabel = document.createElement("span");
    headLabel.className = "toolLabel";
    headLabel.textContent = "инструменты";
    const headCount = document.createElement("span");
    headCount.className = "toolCount";
    const headTime = document.createElement("span");
    headTime.className = "toolTime";
    const headBadge = document.createElement("span");
    headBadge.className = "toolErrorBadge";
    head.append(headLabel, headCount, headTime, headBadge, svgIcon("chevron-down", "icon chev"));
    const list = document.createElement("div");
    list.className = "toolList";
    block.append(head, list);
    const toggle = () => {
      block.classList.toggle("isOpen");
      head.setAttribute("aria-expanded", String(block.classList.contains("isOpen")));
    };
    head.addEventListener("click", toggle);
    head.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(); }
    });
    let total = 0;
    let errors = 0;
    for (const tool of historyTools) {
      const chip = appendHistoryTool(list, tool);
      total += chip.__detail.durationMs || 0;
      if (chip.classList.contains("error")) errors += 1;
    }
    headCount.textContent = `${historyTools.length} вызовов`;
    const totalText = formatDuration(total);
    headTime.textContent = totalText ? `· ${totalText}` : "";
    headBadge.textContent = errors ? `${errors} ош.` : "";
    head.classList.toggle("hasError", errors > 0);
    wrapper.insertBefore(block, body);
  }
  if (message.usage) addUsage(wrapper, message.usage);
}

function buildThinkingBlock(text, open, durationMs) {
  const block = document.createElement("div");
  block.className = `thinking${open ? " isOpen" : ""}`;
  block.tabIndex = 0;
  block.setAttribute("role", "button");
  block.setAttribute("aria-expanded", String(open));
  const head = document.createElement("div");
  head.className = "thinkingHead";
  head.append(svgIcon("brain"));
  const title = document.createElement("span");
  title.textContent = "мышление";
  head.append(title);
  const time = document.createElement("span");
  time.className = "thinkingTime";
  const durationText = formatDuration(durationMs);
  time.textContent = durationText ? `· ${durationText}` : "";
  head.append(time);
  const body = document.createElement("pre");
  body.className = "thinkingBody";
  body.textContent = text;
  block.append(head, body);
  const toggle = () => expandThinking(block, !block.classList.contains("isOpen"));
  block.addEventListener("click", toggle);
  block.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
    }
  });
  return block;
}

function appendHistoryTool(parent, tool) {
  const chip = makeToolChip(tool.name, tool.args, tool.toolCallId);
  chip.__detail.result = tool.result ?? "";
  chip.__detail.durationMs = tool.durationMs ?? 0;
  chip.__detail.isError = Boolean(tool.isError);
  chip.classList.remove("isRunning");
  chip.classList.add(tool.isError ? "error" : "done");
  setToolIcon(chip, tool.isError ? "circle-alert" : "check");
  if (tool.name === "task") {
    chip.classList.add("isSubagent");
    const status = chip.querySelector(".toolStatus");
    if (status) status.textContent = tool.isError ? "ошибка" : "готово";
  }
  const time = formatDuration(tool.durationMs);
  chip.querySelector(".toolTime").textContent = time ? `· ${time}` : "";
  parent.append(chip);
  return chip;
}

function renderHistoryWindow() {
  log.replaceChildren();
  if (!historyMessages.length) {
    showEmptyState();
    return;
  }
  const start = Math.max(0, historyMessages.length - visibleCount);
  if (start > 0) {
    const more = document.createElement("button");
    more.className = "ghostBtn loadOlder";
    more.textContent = `Показать ещё ${Math.min(start, 40)} из ${start}`;
    more.addEventListener("click", () => {
      const before = log.scrollHeight;
      visibleCount = Math.min(historyMessages.length, visibleCount + 40);
      renderHistoryWindow();
      log.scrollTop += log.scrollHeight - before; // keep the reading position
    });
    log.append(more);
  }
  let lastDay = "";
  let promptText = "";
  for (const message of historyMessages.slice(start)) {
    const day = dayLabel(message.ts);
    if (day && day !== lastDay) {
      addDivider(day);
      lastDay = day;
    }
    if (message.role === "user") promptText = stripAttachmentNote(message.text);
    renderHistoryTurn(message, promptText);
  }
  log.scrollTop = log.scrollHeight;
}

function stripAttachmentNote(text) {
  return String(text ?? "").replace(/\n\n\[Вложения сессии —[\s\S]*$/, "");
}

// --- composer --------------------------------------------------------------

function renderAttachments() {
  const box = $("attachments");
  const totalMb = attachments.reduce((sum, item) => sum + (item.bytes ?? 0), 0) / 1024 / 1024;
  box.title = attachments.length
    ? `${plural(attachments.length, ["файл", "файла", "файлов"])} · ${totalMb.toFixed(1)} МБ`
    : "";
  box.hidden = attachments.length === 0;
  box.replaceChildren();
  for (const item of attachments) {
    const chip = document.createElement("div");
    chip.className = "attachmentChip";
    chip.title = `${item.path} · ${Math.round(item.bytes / 1024)} KB`;
    const name = document.createElement("span");
    name.className = "attachmentName";
    name.textContent = item.name;
    const kind = document.createElement("span");
    kind.className = "attachmentKind";
    kind.textContent = item.kind === "image" ? "изобр." : item.kind === "document" ? "документ" : "файл";
    if (item.meta) kind.textContent = `${kind.textContent} · ${item.meta}`;
    const remove = document.createElement("button");
    remove.className = "attachmentRemove";
    remove.append(svgIcon("x"));
    remove.setAttribute("aria-label", `Убрать ${item.name}`);
    remove.addEventListener("click", () => {
      attachments = attachments.filter((entry) => entry.id !== item.id);
      renderAttachments();
    });
    chip.append(name, kind, remove);
    if (item.kind === "document") {
      const preview = document.createElement("button");
      preview.type = "button";
      preview.className = "attachmentPreview";
      preview.append(svgIcon("file-text"));
      preview.setAttribute("aria-label", `Превью: ${item.name}`);
      preview.addEventListener("click", async () => {
        const result = await granka.docPreview(item.path);
        if (result.ok) granka.openPreview({ html: result.html, title: result.title });
        else fail(result.error ?? "Превью недоступно. Откройте файл в папке.");
      });
      chip.append(preview);
    }
    box.append(chip);
  }
}

async function addAttachments(paths) {
  const result = await granka.attachFiles(paths);
  if (!result.ok) return fail(result.error ?? "Файл не прикреплён. Проверьте путь и попробуйте снова");
  for (const item of result.added) {
    if (attachments.some((entry) => entry.path === item.path)) continue;
    attachments.push(item);
  }
  if (result.skipped?.length) {
    fail(`Не прикреплено файлов: ${result.skipped.length}. Первый: ${result.skipped[0].path} — ${result.skipped[0].reason}. Попробуйте снова`);
  }
  renderAttachments();
  // Downscale images in the background so prompts stay cheap.
  for (const item of result.added) {
    if (item.kind === "image") ensureResized(item).then(renderAttachments).catch(() => {});
  }
}

$("attachBtn").addEventListener("click", async () => {
  const button = $("attachBtn");
  button.disabled = true;
  try {
    const paths = await granka.pickFiles();
    if (paths.length) await addAttachments(paths);
  } catch (err) {
    fail(`Не удалось открыть выбор файла. Перетащите файл в окно. ${err?.message ?? err}`);
  } finally {
    button.disabled = false;
  }
});

// Drag & drop works over the whole window, with an overlay hint.
let dragDepth = 0;
window.addEventListener("dragenter", (event) => {
  if (!event.dataTransfer?.types?.includes("Files")) return;
  event.preventDefault();
  dragDepth += 1;
  $("dropOverlay").hidden = false;
});
window.addEventListener("dragover", (event) => {
  if (event.dataTransfer?.types?.includes("Files")) event.preventDefault();
});
window.addEventListener("dragleave", (event) => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $("dropOverlay").hidden = true;
});
window.addEventListener("drop", async (event) => {
  event.preventDefault();
  dragDepth = 0;
  $("dropOverlay").hidden = true;
  const paths = [...(event.dataTransfer?.files ?? [])]
    .map((file) => granka.pathForFile(file))
    .filter(Boolean);
  if (paths.length) await addAttachments(paths);
});

let attachProgressTimer = null;
granka.onAttachProgress((progress) => {
  const percent = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  setStatus(`копирую ${progress.path.split(/[\\/]/).pop()}… ${percent}%`);
  clearTimeout(attachProgressTimer);
  attachProgressTimer = setTimeout(() => {
    if (!busy) setStatus("");
  }, 1200);
});

$("prompt").addEventListener("paste", async (event) => {
  const rawText = event.clipboardData?.getData("text/plain") ?? "";
  // A pasted filesystem path becomes an attachment instead of plain text.
  const trimmed = rawText.trim();
  if (
    !event.clipboardData?.types?.includes("Files") &&
    /^(?:[A-Za-z]:[\\/]|\/|~[\\/])/.test(trimmed) &&
    !trimmed.includes("\n") &&
    trimmed.length < 500
  ) {
    const result = await granka.attachFiles([trimmed]);
    if (result.ok && result.added.length > 0) {
      event.preventDefault();
      attachments.push(...result.added);
      renderAttachments();
      toast("Путь превращён во вложение");
      return;
    }
  }
  // A huge paste belongs in a file, not in the context window.
  const text = rawText;
  if (text.length > 5000 && !event.clipboardData?.types?.includes("Files")) {
    event.preventDefault();
    const result = await granka.attachText({ name: "вставлено", text });
    if (result.ok) {
      attachments.push(...result.added);
      renderAttachments();
      toast(`Вставлено ${text.length.toLocaleString("ru-RU")} символов — сохранено как вложение`);
    } else fail(result.error);
    return;
  }
  const items = [...(event.clipboardData?.items ?? [])];
  const images = items.filter((item) => item.type.startsWith("image/"));
  if (!images.length) return;
  event.preventDefault();
  for (const item of images) {
    const file = item.getAsFile();
    if (!file) continue;
    const dataUrl = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(file);
    });
    const result = await granka.attachImage({ name: "скриншот", dataUrl });
    if (result.ok) {
      attachments.push(...result.added);
      renderAttachments();
    } else fail(result.error);
  }
});

function autoGrow() {
  const field = $("prompt");
  field.style.height = "auto";
  field.style.height = `${Math.min(field.scrollHeight, 180)}px`;
}

function suggestRows() {
  return [...$("suggest").querySelectorAll(".suggestRow")];
}

function highlightSuggest() {
  suggestRows().forEach((row, index) => {
    row.classList.toggle("isCurrent", index === suggestIndex);
    row.setAttribute("aria-selected", String(index === suggestIndex));
  });
  suggestRows()[suggestIndex]?.scrollIntoView({ block: "nearest" });
}

async function compactNow() {
  if (busy) return fail("Дождитесь ответа, прежде чем сжимать контекст");
  startCompactionBar();
  compactTimer = setTimeout(stopCompactionBar, 120000);
  const result = await granka.compact();
  stopCompactionBar();
  if (!result.ok) return fail(result.error);
  showContext(result.context);
  addDivider("контекст сжат");
}

function applySuggest(name) {
  $("prompt").value = `${name} `;
  $("suggest").hidden = true;
  suggestIndex = -1;
  autoGrow();
  $("prompt").focus();
}

// Slash suggestions above the composer: user prompts, installed skills and
// built-in commands, filtered as the user types after the leading slash.
const BUILTIN_COMMANDS = [
  { name: "/новый", description: "Начать новый диалог", action: () => newChat() },
  { name: "/план", description: "Режим плана: только чтение, без правок", action: "plan" },
  { name: "/сжать", description: "Сжать контекст в резюме", action: "compact" },
  { name: "/темы", description: "Открыть раздел тем в настройках", action: "themes" },
];

function suggestEntries() {
  const entries = [
    ...commands.prompts.map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      insert: prompt.name,
    })),
    ...commands.skills.map((skill) => ({
      name: `/${skill.name}`,
      description: `скилл: ${skill.description}`,
      insert: `/${skill.name} `,
    })),
    ...BUILTIN_COMMANDS.map((command) => ({
      name: command.name,
      description: command.description,
      insert: command.name,
      action: command.action,
    })),
  ];
  return entries;
}

function renderSuggest() {
  const value = $("prompt").value;
  const box = $("suggest");
  if (!value.startsWith("/")) {
    box.hidden = true;
    suggestIndex = -1;
    return;
  }
  const query = value.slice(1).toLowerCase();
  const matches = suggestEntries()
    .filter((entry) => entry.name.slice(1).toLowerCase().includes(query))
    .slice(0, 8);
  if (!matches.length) {
    box.replaceChildren(Object.assign(document.createElement("div"), {
      className: "popoverHint",
      textContent: `Ничего не найдено: /${value.slice(1)}`,
    }));
    box.hidden = false;
    suggestIndex = -1;
    return;
  }
  box.replaceChildren(
    ...matches.map((entry) => {
      const row = document.createElement("button");
      row.className = "suggestRow";
      const name = document.createElement("b");
      name.replaceChildren(highlightMatch(entry.name, value.slice(1)));
      const desc = document.createElement("span");
      desc.textContent = entry.description;
      row.append(name, desc);
      row.__entry = entry;
      row.addEventListener("click", () => {
        if (entry.action === "plan") {
          saveConfig({ planMode: !config.planMode, agentMode: !config.planMode ? "plan" : "chat" });
          renderMode();
          $("prompt").value = "";
          box.hidden = true;
          toast(config.planMode ? "Режим плана включён: только чтение" : "Режим плана выключен");
        } else if (entry.action === "compact") {
          $("prompt").value = "";
          box.hidden = true;
          compactNow();
        } else if (entry.action === "themes") {
          $("prompt").value = "";
          box.hidden = true;
          granka.openSettings("themes");
        } else if (typeof entry.action === "function") {
          $("prompt").value = "";
          box.hidden = true;
          entry.action();
        } else {
          applySuggest(entry.insert);
        }
      });
      return row;
    }),
  );
  box.hidden = false;
  suggestIndex = -1;
  highlightSuggest();
}

let budgetWarnedDay = "";

async function checkDailyBudget() {
  const budget = Number(config.dailyBudgetUsd) || 0;
  if (!budget) return;
  const today = new Date().toISOString().slice(0, 10);
  if (budgetWarnedDay === today) return;
  const stats = await granka.getStats().catch(() => null);
  const row = stats?.byDay?.find((day) => day.day === today);
  if (row && row.cost > budget) {
    budgetWarnedDay = today;
    toast(`Бюджет на сегодня превышен: $${row.cost.toFixed(2)} из $${budget}`, { error: true });
  }
}

async function send() {
  const question = $("prompt").value.trim();
  if (!question) return;
  if (view !== "chat") setView("chat");
  if (busy) {
    const result = await granka.queue(question, "followUp");
    if (!result.ok) return fail(result.error ?? "Очередь недоступна. Дождитесь ответа и отправьте снова");
    addMessage("user", question);
    $("prompt").value = "";
    autoGrow();
    $("suggest").hidden = true;
    return;
  }
  streamText = "";
  streamWrapper = null;
  streamBody = null;
  resetThinking();
  resetToolBlock();
  queued = 0;
  setBusy(true);
  syncQueueBadge();
  log.querySelector(".emptyState")?.remove();
  const userMessage = addMessage("user", question);
  appendBubbleAttachments(userMessage.wrapper, attachments.map((item) => ({ name: item.name, path: item.path })));
  streamPrompt = question;
  log.scrollTop = log.scrollHeight;
  $("prompt").value = "";
  autoGrow();
  $("suggest").hidden = true;
  setStatus("");
  setActivity("think");
  renderActivity();
  try {
    const sent = attachments.map((item) => ({
      path: item.path,
      name: item.name,
      kind: item.kind,
      bytes: item.bytes,
      dataUrl: item.dataUrl ?? "",
    }));
  const result = await granka.ask(question, sent);
  if (sent.length) {
    attachments = [];
    renderAttachments();
  }
  try { localStorage.removeItem(draftKey()); } catch {}
  try { localStorage.removeItem(`${DRAFT_PREFIX}new`); } catch {}
    if (!result.ok) {
      // Interrupted/failed turn: keep whatever the model already said (the
      // agent returns it in result.text) and finalize it as markdown —
      // otherwise the raw <pre> stream and the error box are all that stays.
      const partial = result.text || streamText;
      let target;
      if (streamWrapper && streamBody) {
        streamBody.classList.remove("isStreaming");
        if (partial) {
          renderAssistant(streamWrapper, streamBody, partial);
          decorateCodeBlocks(streamBody);
        }
        target = streamWrapper;
      } else if (partial) {
        const created = addMessage("assistant", partial);
        created.wrapper.__prompt = streamPrompt;
        target = created.wrapper;
      } else {
        target = addMessage("assistant", "").wrapper;
      }
      const aborted = /abort|прерван/i.test(result.error ?? "");
      attachError(target, aborted ? "Ответ прерван" : result.error);
      setStatus("");
    } else {
      if (!streamWrapper) {
        const created = addMessage("assistant", result.text);
        created.wrapper.__prompt = streamPrompt;
        addUsage(created.wrapper, result.usage);
      } else {
        streamBody.classList.remove("isStreaming");
        renderAssistant(streamWrapper, streamBody, result.text || streamText);
        decorateCodeBlocks(streamBody);
        addUsage(streamWrapper, result.usage);
      }
      announce(`Ответ готов. ${(result.text || "").length} символов.`);
      // Naming is local and happens once: first message → title.
      if (config.autoTitle !== false && currentSessionId) {
        granka.autoTitle(currentSessionId).then(async (titled) => {
          if (titled?.ok) await refreshSessions();
        });
      }
    }
    if (result.context) showContext(result.context);
    checkDailyBudget();
  } catch (err) {
    const target = streamWrapper ?? addMessage("assistant", "").wrapper;
    attachError(target, String(err?.message ?? err));
  } finally {
    settleThinking();
    // A settled turn collapses its plan to the header row.
    const toggle = $("planStripToggle");
    if (toggle && toggle.getAttribute("aria-expanded") === "true") {
      toggle.setAttribute("aria-expanded", "false");
      toggle.classList.remove("isOpen");
      renderPlanStrip();
    }
    setBusy(false);
    syncQueueBadge();
    $("prompt").focus();
    scrollIf(config.autoScroll !== false);
    refreshSessions();
    setTimeout(() => {
      if (!busy) setStatus("");
    }, 1500);
  }
}

$("send").addEventListener("click", send);
$("stop").addEventListener("click", () => granka.abort());

// Unsent drafts survive session switches: one draft per session id
// ("new" for the unsent first message), kept in localStorage.
const DRAFT_PREFIX = "granka.draft.";

function draftKey() {
  return DRAFT_PREFIX + (currentSessionId || "new");
}

function saveDraft() {
  const value = $("prompt").value;
  try {
    if (value) localStorage.setItem(draftKey(), value);
    else localStorage.removeItem(draftKey());
  } catch (err) { console.error("[granka draft]", err?.message ?? err); }
}

function restoreDraft() {
  let value = "";
  try {
    value = localStorage.getItem(draftKey()) ?? "";
  } catch (err) { console.error("[granka draft]", err?.message ?? err); }
  $("prompt").value = value;
  autoGrow();
}

$("prompt").addEventListener("input", () => {
  saveDraft();
  autoGrow();
  renderSuggest();
});

$("prompt").addEventListener("keydown", (event) => {
  const box = $("suggest");
  if (!box.hidden && suggestRows().length) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      suggestIndex = (suggestIndex + 1) % suggestRows().length;
      highlightSuggest();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      suggestIndex = suggestIndex <= 0 ? suggestRows().length - 1 : suggestIndex - 1;
      highlightSuggest();
      return;
    }
    if (event.key === "Enter" && suggestIndex >= 0) {
      event.preventDefault();
      const row = suggestRows()[Math.max(suggestIndex, 0)];
      const entry = row?.__entry;
      if (entry && typeof entry.action === "function") {
        $("prompt").value = "";
        box.hidden = true;
        entry.action();
      } else if (entry && typeof entry.action === "string") {
        row.click();
      } else {
        applySuggest(row.querySelector("b").textContent);
      }
      return;
    }
    if (event.key === "Escape") {
      box.hidden = true;
      return;
    }
  }
  // Shift+Tab stays a normal focus move: it must not switch the agent mode
  // or trap keyboard users inside the composer.
  const sendOnEnter = config.sendOnEnter !== false;
  const wantsSend = sendOnEnter
    ? event.key === "Enter" && !event.shiftKey
    : event.key === "Enter" && (event.metaKey || event.ctrlKey);
  if (wantsSend) {
    event.preventDefault();
    send();
  }
});


let searchTimer;
$("sessionSearch").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => refreshSessions(), 250);
});

// --- compaction ------------------------------------------------------------

function startCompactionBar() {
  stopCompactionBar();
  const bar = document.createElement("div");
  bar.className = "compactionBar";
  bar.id = "compactionBar";
  bar.append(Object.assign(document.createElement("span"), { className: "spinner" }));
  const text = document.createElement("span");
  text.className = "compactionText";
  text.textContent = "Сжимаю контекст…";
  const cancel = document.createElement("button");
  cancel.className = "toastAction";
  cancel.textContent = "Отменить";
  cancel.addEventListener("click", async () => {
    await granka.cancelCompaction();
    stopCompactionBar();
    addDivider("сжатие отменено");
  });
  bar.append(text, cancel);
  $("toasts").append(bar);
}

function stopCompactionBar() {
  clearTimeout(compactTimer);
  $("compactionBar")?.remove();
}


// --- session actions -------------------------------------------------------

async function newChat() {
  if (busy) return fail("Дождитесь ответа или нажмите «Стоп»");
  saveDraft();
  await granka.newSession();
  currentSessionId = "";
  draftKeyValue = `draft-${Date.now().toString(36)}`;
  currentProjectId = activeProjectId;
  setView("chat");
  showEmptyState();
  plans.delete(planKey());
  renderPlanStrip();
  showContext(null);
  await refreshSessions();
  restoreDraft();
  $("prompt").focus();
}

$("newChatRow").addEventListener("click", newChat);

// --- projects --------------------------------------------------------------

async function refreshProjects() {
  const data = await granka.listProjects();
  projects = data.projects;
  activeProjectId = data.active ?? "";
  renderProjectLabel();
}

async function activateProject(id) {
  if (!id) {
    // Leaving a project must also leave its folder, otherwise its sessions
    // stay in the sidebar scope.
    await saveConfig({ activeProject: "", cwd: "" });
    activeProjectId = "";
    currentProjectId = "";
    config = await granka.loadConfig();
    await refreshProjects();
    renderProjectLabel();
    await refreshSessions();
    await refreshHistory();
    return;
  }
  const result = await granka.activateProject(id);
  if (!result.ok) return fail(result.error);
  activeProjectId = id;
  config = await granka.loadConfig();
  await refreshProjects();
  renderProjectLabel();
  await refreshSessions();
  await refreshHistory();
  currentProjectId = activeProjectId;
  toast("Проект применён");
}

function openProjectMenu() {
  openPopover($("projectPopup"), (panel) => {
    panel.append(
      popoverItem("Без проекта", {
        current: !activeProjectId,
        onSelect: () => activateProject(""),
      }),
    );
    for (const project of projects) {
      panel.append(
        popoverItem(project.name, {
          meta: project.cwd ? project.cwd.split(/[\\/]/).pop() : undefined,
          current: project.id === activeProjectId,
          onSelect: () => activateProject(project.id),
          contextMenu: () => openProjectActions(project),
        }),
      );
    }
    panel.append(Object.assign(document.createElement("div"), { className: "popoverSeparator" }));
    panel.append(
      popoverItem("Новый проект", {
        icon: "plus",
        onSelect: () => {
          setView("project");
          buildProjectPane({ fresh: true });
        },
      }),
    );
    panel.append(
      popoverItem("Настроить проект…", {
        icon: "settings-2",
        onSelect: () => setView("project"),
      }),
    );
  });
}

// right-click on a project → its own actions
function openProjectActions(project) {
  const panel = $("popover");
  panel.replaceChildren();
  panel.hidden = false;
  const title = document.createElement("div");
  title.className = "popoverHint";
  title.textContent = project.name;
  panel.append(title);
  panel.append(
    popoverItem("Открыть проект", {
      icon: "folder",
      onSelect: async () => {
        await activateProject(project.id);
        setView("project");
      },
    }),
    popoverItem("Переименовать", {
      icon: "pencil",
      onSelect: () => {
        setView("project");
        buildProjectPane({ focusName: true });
      },
    }),
    Object.assign(document.createElement("div"), { className: "popoverSeparator" }),
    popoverItem("Удалить проект", {
      danger: true,
      icon: "trash-2",
      onSelect: () => deleteProjectWithConfirm(project),
    }),
  );
}

async function deleteProjectWithConfirm(project) {
  const ok = await granka.confirm(
    `Удалить проект «${project.name}»?`,
    "Проект исчезнет из списка. Файлы и AGENTS.md в папке останутся на диске.",
  );
  if (!ok) return;
  await granka.deleteProject(project.id);
  if (activeProjectId === project.id) {
    activeProjectId = "";
    currentProjectId = "";
    await saveConfig({ activeProject: "", cwd: "" });
  }
  await refreshProjects();
  await refreshSessions();
  await refreshHistory();
  toast("Проект удалён");
}

$("projectPopup").addEventListener("click", openProjectMenu);
$("projectPopup").addEventListener("contextmenu", (event) => {
  event.preventDefault();
  const project = projects.find((item) => item.id === activeProjectId);
  if (project) openProjectActions(project);
});

async function buildProjectPane({ fresh = false, focusName = false } = {}) {
  const pane = $("projectPane");
  pane.replaceChildren();
  const project = fresh ? null : projects.find((item) => item.id === activeProjectId);

  const explainer = document.createElement("div");
  explainer.className = "hint";
  explainer.textContent =
    "Проектный AGENTS.md действует только в этой папке. Глобальный — ~/.granka/AGENTS.md (редактируется вручную в файле).";
  pane.append(explainer);

  // Header buttons: create / edit / delete. Delete is only for an existing
  // project being edited (its folder is open) — never in create mode.
  const newBtn = $("newProjectBtn");
  const editBtn = $("editProjectBtn");
  const deleteTop = $("deleteProjectTop");
  newBtn.onclick = () => buildProjectPane({ fresh: true, focusName: true });
  editBtn.onclick = () => buildProjectPane();
  editBtn.disabled = !activeProjectId;
  editBtn.hidden = !activeProjectId;
  const editing = Boolean(project) && !fresh;
  deleteTop.hidden = !editing;
  deleteTop.onclick = () => project && deleteProjectWithConfirm(project);
  $("projectMeta").textContent = fresh
    ? "новый проект"
    : project
      ? project.name
      : "только для этого проекта";

  const draft = (() => {
    try { return JSON.parse(localStorage.getItem("granka.projectDraft") ?? "null"); } catch { return null; }
  })();
  const name = document.createElement("input");
  name.className = "textInput";
  name.id = "projectNameInput";
  name.placeholder = "Имя проекта";
  name.value = project && !fresh ? (project.name ?? "") : (draft?.name ?? project?.name ?? "");

  const cwdInput = document.createElement("input");
  cwdInput.className = "textInput";
  cwdInput.placeholder = "Папка проекта";
  // Fresh (new project) starts completely empty — no inherited folder,
  // name or rules from the previously open project.
  cwdInput.value = fresh ? (draft?.cwd ?? "") : (project?.cwd ?? "");
  const pick = document.createElement("button");
  pick.className = "ghostBtn";
  pick.textContent = "Выбрать…";
  pick.addEventListener("click", async () => {
    const dir = await granka.pickDir();
    if (dir) {
      cwdInput.value = dir;
      await reloadRulesForCwd();
    }
  });
  // The rules editor must always reflect the folder in the input: picking a
  // new folder reloads ITS AGENTS.md (and saving must not overwrite the new
  // folder's file with the old folder's text).
  let rulesHint;
  const cwdHint = document.createElement("div");
  cwdHint.className = "hint";
  cwdHint.id = "projectCwdHint";
  cwdHint.hidden = true;
  async function reloadRulesForCwd() {
    const dir = cwdInput.value.trim();
    const rules = await granka.getRulesForPath(dir);
    instructions.value = project && !fresh ? (rules.text ?? "") : (draft?.instructions ?? rules.text ?? "");
    rulesHint.textContent = rules.exists
      ? `Загружен из ${rules.path}`
      : dir
        ? `Будет создан: ${dir.replace(/[\\/]$/, "")}/AGENTS.md`
        : "У проекта нет папки — правила сохранятся в ~/.granka/granka.json";
    // If the chosen folder already belongs to another project, say so
    // instead of silently creating a duplicate.
    const other = dir
      ? projects.find(
          (item) => item.cwd && item.id !== activeProjectId && item.cwd.replace(/[\\/]$/, "") === dir.replace(/[\\/]$/, ""),
        )
      : null;
    cwdHint.hidden = !other;
    if (other) cwdHint.textContent = `Эта папка уже является проектом «${other.name}».`;
  }
  cwdInput.addEventListener("change", reloadRulesForCwd);
  const cwdRow = document.createElement("div");
  cwdRow.className = "row";
  cwdRow.append(cwdInput, pick);

  const rules = project ? await granka.getProjectRules(project.id) : { ok: true, text: "", path: "" };
  const memory = project ? await granka.getProjectMemory(project.id) : { ok: true, text: "" };
  const memoryHint = document.createElement("div");
  memoryHint.className = "hint";
  const updateMemoryHint = () => {
    const text = memoryArea.value;
    const lines = text ? text.split("\n").length : 0;
    memoryHint.textContent = lines > 200 || text.length > 25 * 1024
      ? `Память: ${lines} строк — больше лимита загрузки (200 строк / 25 КБ), почистите.`
      : `Память: ${lines} строк. Заметки агента, не правила.`;
  };
  const memoryArea = document.createElement("textarea");
  memoryArea.className = "panelTextarea";
  memoryArea.id = "projectMemoryArea";
  memoryArea.placeholder = "Заметки агента для этого проекта: факты, исправления, контекст (не правила)";
  memoryArea.value = memory.text ?? "";
  memoryArea.rows = 6;
  memoryArea.addEventListener("input", updateMemoryHint);
  updateMemoryHint();
  const instructions = document.createElement("textarea");
  instructions.className = "panelTextarea";
  instructions.id = "projectRulesArea";
  instructions.placeholder = "Правила этой папки: как собирать, как тестировать, что не трогать";
  instructions.value = rules.text ?? "";
  instructions.rows = 12;

  rulesHint = document.createElement("div");
  rulesHint.className = "hint";
  rulesHint.id = "projectRulesHint";
  rulesHint.textContent = rules.exists
    ? `Загружен из ${rules.path}`
    : project?.cwd
      ? `Будет создан: ${project.cwd.replace(/[\\/]$/, "")}/AGENTS.md`
      : "У проекта нет папки — правила сохранятся в ~/.granka/granka.json";
  // reloadRulesForCwd (defined above) writes into this element

  let profileModelValue = project?.model ?? "";
  let profileThinkingValue = project?.thinkingLevel ?? "";

  const profileModel = window.grankaSelect.create({
    ariaLabel: "Модель проекта",
    options: [
      { value: "", label: "Как в приложении" },
      ...allModels.map((model) => ({ value: model.id, label: globalThis.grankaModels.modelName(model.id) })),
    ],
    value: profileModelValue,
    onChange: (value) => {
      profileModelValue = value;
    },
  });
  const profileThinking = window.grankaSelect.create({
    ariaLabel: "Thinking проекта",
    options: [
      { value: "", label: "Как в приложении" },
      ...["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => ({ value: level, label: level })),
    ],
    value: profileThinkingValue,
    onChange: (value) => {
      profileThinkingValue = value;
    },
  });

  const saveDraft = () => {
    try {
      localStorage.setItem("granka.projectDraft", JSON.stringify({
        name: name.value, cwd: cwdInput.value, instructions: instructions.value,
      }));
    } catch {}
  };
  name.addEventListener("input", saveDraft);
  cwdInput.addEventListener("input", saveDraft);
  instructions.addEventListener("input", saveDraft);
  const saveProject = document.createElement("button");
  saveProject.className = "primaryBtn";
  saveProject.textContent = project ? "Сохранить проект" : "Создать проект";
  saveProject.addEventListener("click", async () => {
    if (!name.value.trim()) return fail("Введите имя проекта");
    const result = await granka.saveProject({
      id: project?.id,
      name: name.value,
      cwd: cwdInput.value.trim(),
      instructions: instructions.value,
      model: profileModelValue,
      thinkingLevel: profileThinkingValue,
    });
    if (!result.ok) return fail(result.error);
    try { localStorage.removeItem("granka.projectDraft"); } catch {}

    if (cwdInput.value.trim()) {
      const savedRules = await granka.saveProjectRules(result.id, instructions.value);
      if (!savedRules.ok) return fail(savedRules.error);
    }
    const savedMemory = await granka.saveProjectMemory(result.id, memoryArea.value);
    if (!savedMemory.ok) return fail(savedMemory.error);
    await refreshProjects();
    if (!project) await activateProject(result.id);
    await buildProjectPane(); // show the just-saved project in edit mode
    toast(project ? "Проект сохранён" : "Проект создан");
  });

  const profileHint = document.createElement("div");
  profileHint.className = "hint";
  profileHint.textContent = "Пусто — берётся модель и мышление из настроек приложения.";
  pane.append(
    labeled("Название проекта", name),
    labeled("Рабочая папка", cwdRow),
    cwdHint,
    labeled("Проектный AGENTS.md", instructions),
    rulesHint,
    labeled("Память проекта", memoryArea),
    memoryHint,
    labeled("Модель проекта", profileModel.element),
    labeled("Уровень мышления", profileThinking.element),
    profileHint,
    saveProject,
  );

  if (fresh || focusName) name.focus();
}

let fieldSeq = 0;
function labeled(text, control) {
  const box = document.createElement("div");
  box.className = "field";
  const label = document.createElement("label");
  label.textContent = text;
  const id = control.id || `field-${++fieldSeq}`;
  control.id = id;
  label.htmlFor = id;
  box.append(label, control);
  return box;
}

// --- all sessions ----------------------------------------------------------

async function buildSessionsPane() {
  const pane = $("sessionsPane");
  pane.replaceChildren();
  selectedSessions.clear();

  sessionsAll = await granka.listSessions("");
  $("sessionsMeta").textContent = `${plural(sessionsAll.length, ["диалог", "диалога", "диалогов"])} · ~/.granka`;

  const toolbar = document.createElement("div");
  toolbar.className = "bulkBar";
  const selectAll = document.createElement("label");
  selectAll.className = "bulkSelectAll";
  const selectAllBox = document.createElement("input");
  selectAllBox.type = "checkbox";
  selectAll.append(selectAllBox, Object.assign(document.createElement("span"), { textContent: "Выбрать все" }));
  const bulkCount = document.createElement("span");
  bulkCount.className = "bulkCount";
  const exportButton = document.createElement("button");
  exportButton.className = "ghostBtn";
  exportButton.textContent = "Скопировать Markdown";
  exportButton.addEventListener("click", async () => {
    const ids = [...selectedSessions];
    if (!ids.length) return;
    const result = await granka.exportSessions(ids);
    if (!result.ok) return fail(result.error ?? "Не удалось скопировать Markdown. Повторите попытку");
    await copyText(result.text);
    toast(`Скопировано в буфер: ${ids.length} диалог(ов) в Markdown`);
  });
  const deleteButton = document.createElement("button");
  deleteButton.className = "ghostBtn danger";
  deleteButton.textContent = "Удалить";
  deleteButton.addEventListener("click", async () => {
    const ids = [...selectedSessions];
    if (!ids.length) return;
    const ok = await granka.confirm(`Удалить выбранные диалоги (${ids.length})?`, "Удалённые диалоги нельзя восстановить.");
    if (!ok) return;
    for (const id of ids) await granka.deleteSession(id);
    selectedSessions.clear();
    if (ids.includes(currentSessionId)) {
      await granka.newSession();
      currentSessionId = "";
      await refreshHistory();
    }
    sessionsAll = sessionsAll.filter((item) => !ids.includes(item.id));
    renderBulk();
    await refreshSessions();
    toast(`Удалено: ${ids.length}`);
  });
  toolbar.append(selectAll, bulkCount, exportButton, deleteButton);

  const list = document.createElement("div");
  pane.append(toolbar, list);

  const renderBulk = () => {
    bulkCount.textContent = selectedSessions.size ? `Выбрано: ${selectedSessions.size}` : "";
    const visibleIds = [...list.querySelectorAll("[data-session-id]")].map((row) => row.dataset.sessionId);
    selectAllBox.checked = visibleIds.length > 0 && visibleIds.every((id) => selectedSessions.has(id));
    exportButton.disabled = selectedSessions.size === 0;
    deleteButton.disabled = selectedSessions.size === 0;
  };

  selectAllBox.addEventListener("change", () => {
    for (const row of list.querySelectorAll("[data-session-id]")) {
      if (selectAllBox.checked) selectedSessions.add(row.dataset.sessionId);
      else selectedSessions.delete(row.dataset.sessionId);
    }
    for (const box of list.querySelectorAll("input[type=checkbox]")) box.checked = selectAllBox.checked;
    renderBulk();
  });

  const render = () => {
    const query = ($("allSessionsSearch")?.value ?? "").trim().toLowerCase();
    const items = sessionsAll.filter(
      (item) => !query || item.title.toLowerCase().includes(query),
    );
    list.replaceChildren();
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "hint";
      empty.textContent = "Ничего не найдено.";
      list.append(empty);
      return;
    }
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "sessionRowFull";
      row.dataset.sessionId = item.id;
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "rowCheck";
      checkbox.checked = selectedSessions.has(item.id);
      checkbox.setAttribute("aria-label", `Выбрать ${item.title}`);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selectedSessions.add(item.id);
        else selectedSessions.delete(item.id);
        renderBulk();
      });
      const main = document.createElement("button");
      main.className = "rowMain";
      const title = document.createElement("div");
      title.className = "rowTitle";
      title.textContent = item.title;
      const meta = document.createElement("div");
      meta.className = "rowMeta";
      meta.textContent = `${new Date(item.modified).toLocaleString("ru-RU")} · ${item.messages ?? 0} сообщений`;
      main.append(title, meta);
      main.addEventListener("click", async () => {
        setView("chat");
        await switchSession(item.id, { sessionCwd: item.cwd });
      });
      const rename = document.createElement("button");
      rename.className = "ghostBtn";
      rename.textContent = "Переименовать";
      rename.addEventListener("click", () => {
        const item2 = sessionsAll.find((entry) => entry.id === item.id);
        startRailRename(item2 ?? item);
      });
      const remove = document.createElement("button");
      remove.className = "ghostBtn danger";
      remove.textContent = "Удалить";
      remove.addEventListener("click", async () => {
        const ok = await granka.confirm(`Удалить диалог «${item.title}»?`, "Диалог будет удалён без возможности восстановления.");
        if (!ok) return;
        const result = await granka.deleteSession(item.id);
        if (!result.ok) return;
        sessionsAll = sessionsAll.filter((entry) => entry.id !== item.id);
        if (item.id === currentSessionId) {
          await granka.newSession();
          currentSessionId = "";
          await refreshHistory();
        }
        $("sessionsMeta").textContent = `${plural(sessionsAll.length, ["диалог", "диалога", "диалогов"])} · ~/.granka`;
        render();
        await refreshSessions();
        toast("Диалог удалён");
      });
      row.append(checkbox, main, rename, remove);
      list.append(row);
    }
    renderBulk();
  };

  const searchWrap = document.createElement("label");
  searchWrap.className = "searchField sessionsSearch";
  searchWrap.append(svgIcon("search"));
  const search = document.createElement("input");
  search.id = "allSessionsSearch";
  search.setAttribute("aria-label", "Поиск по диалогам");
  search.placeholder = "Поиск по названию";
  search.addEventListener("input", render);
  searchWrap.append(search);
  pane.prepend(searchWrap);
  render();
}

$("allSessions").addEventListener("click", () => setView("sessions"));
$("closeSessions").addEventListener("click", () => setView("chat"));
$("closeStats").addEventListener("click", () => setView("chat"));
$("segmentChat").addEventListener("click", () => setView("chat"));
$("segmentProject").addEventListener("click", () => setView("project"));

// --- menus and shortcuts ---------------------------------------------------

$("menuBtn").addEventListener("click", () => {
  openPopover($("menuBtn"), (panel) => {
    panel.append(
      popoverItem("Новый диалог", { icon: "plus", meta: isMac ? "⌘N" : "Ctrl+N", onSelect: newChat }),
      popoverItem("Все диалоги", { icon: "layers", meta: isMac ? "⌘⇧L" : "Ctrl+Shift+L", onSelect: () => setView("sessions") }),
      popoverItem("Аналитика", { icon: "chart", onSelect: () => setView("stats") }),
      popoverItem("Проект", { icon: "folder", onSelect: () => setView("project") }),
      Object.assign(document.createElement("div"), { className: "popoverSeparator" }),
      popoverItem("Сжать контекст", {
        icon: "archive",
        onSelect: () => compactNow(),
      }),
      popoverItem("Настройки…", { icon: "settings-2", meta: isMac ? "⌘," : "Ctrl+,", onSelect: () => granka.openSettings() }),
    );
  });
});

$("brainPopup").addEventListener("click", openBrainPopover);
$("modePopup").addEventListener("click", openModePopover);

async function saveConfig(patch) {
  const result = await granka.saveConfig(patch);
  if (!result.ok) {
    fail(result.error);
    return false;
  }
  config = await granka.loadConfig();
  applyTheme();
  return true;
}

granka.onQuestion((payload) => renderQuestion(payload));

granka.onConfigChanged((next) => {
  config = next;
  applyTheme();
  renderModelLabel();
  renderThinking();
  renderMode();
});

granka.onMenu((action) => {
  if (action === "new-chat") newChat();
  else if (action === "all-sessions") setView("sessions");
  else if (action === "toggle-sidebar") toggleSidebar();
  else if (action === "stats") setView("stats");
  else if (action === "project") setView("project");
  else if (action === "compact") compactNow();
});

document.addEventListener("keydown", (event) => {
  const mod = isMac ? event.metaKey : event.ctrlKey;
  if (event.key === "Escape") {
    if (!$("popover").hidden) return closePopover();
    if (!$("suggest").hidden) {
      $("suggest").hidden = true;
      return;
    }
    if (view !== "chat") return setView("chat");
    if (busy) {
      granka.abort();
      return;
    }
    if ($("prompt").value) {
      saveDraft();
      $("prompt").value = "";
      autoGrow();
      return;
    }
    return;
  }
  if (mod && event.key.toLowerCase() === "n") {
    event.preventDefault();
    newChat();
  } else if (mod && event.key.toLowerCase() === "b") {
    event.preventDefault();
    toggleSidebar();
  } else if (mod && event.key.toLowerCase() === "k") {
    event.preventDefault();
    $("sessionSearch").focus();
    $("sessionSearch").select();
  } else if (mod && event.key === "Enter") {
    event.preventDefault();
    send();
  } else if (mod && event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
    event.preventDefault();
    const levels = levelsOf(config.model);
    const index = levels.indexOf(config.thinkingLevel);
    const next =
      event.key === "ArrowDown" ? Math.min(index + 1, levels.length - 1) : Math.max(index - 1, 0);
    if (levels[next] && levels[next] !== config.thinkingLevel) {
      saveConfig({ thinkingLevel: levels[next] }).then(renderThinking);
    }
  }
});

// --- window chrome ---------------------------------------------------------

async function syncMaximizedIcon() {
  const maximized = await granka.windowIsMaximized();
  const use = $("winMax").querySelector("use");
  use.setAttribute("href", maximized ? "#i-minimize-2" : "#i-maximize-2");
  $("winMax").title = maximized ? "Восстановить" : "Развернуть";
  $("winMax").setAttribute("aria-label", $("winMax").title);
  $("winMax").setAttribute("aria-pressed", String(maximized));
}

$("winMin").addEventListener("click", () => granka.windowMinimize());
$("winMax").addEventListener("click", async () => {
  await granka.windowToggleMaximize();
  syncMaximizedIcon();
});
$("winClose").addEventListener("click", () => granka.windowClose());
$("toolbar").addEventListener("dblclick", async (event) => {
  if (event.target.closest("button")) return;
  await granka.windowToggleMaximize();
  syncMaximizedIcon();
});
window.addEventListener("resize", syncMaximizedIcon);

// settings live in their own window: refresh local state when it closes
window.addEventListener("focus", async () => {
  const next = await granka.loadConfig();
  if (next.theme !== config.theme || next.cwd !== config.cwd || Boolean(next.hasApiKey) !== Boolean(config.hasApiKey)) {
    config = next;
    applyTheme();
    renderModelLabel();
    renderThinking();
  }
});

// --- onboarding ------------------------------------------------------------

let onboardingStep = 1;

function showOnboardingStep(step) {
  onboardingStep = step;
  for (const index of [1, 2, 3]) {
    $(`onboardingStep${index}`).hidden = index !== step;
  }
  const dialog = document.querySelector(".onboardingDialog");
  const heading = $(`onboardingStep${step}`)?.querySelector("h2");
  if (heading) {
    if (!heading.id) heading.id = `onboardingTitle${step}`;
    dialog.setAttribute("aria-labelledby", heading.id);
  }
  if (step === 1) $("onboardingKey").focus();
  if (step === 2) $("onboardingCwd").value = config.cwd ?? "";
  if (step === 3) $("onboardingPrompt").focus();
}

function closeOnboarding() {
  $("onboarding").hidden = true;
  setBackgroundInert(false);
  $("prompt").focus();
}

// Onboarding is a modal dialog: keep Tab inside it while visible.
document.addEventListener("keydown", (event) => {
  const box = $("onboarding");
  if (!box || box.hidden) return;
  if (event.key === "Escape") {
    event.preventDefault();
    $("onboardingSkip").click();
    return;
  }
  trapTab(box, event);
});

async function saveOnboardingKey() {
  const key = $("onboardingKey").value.trim();
  if (!key) return false;
  await saveConfig({ apiKey: key });
  applyFonts();
  return true;
}

$("onboardingCheck").addEventListener("click", async () => {
  if (!(await saveOnboardingKey())) {
    $("onboardingStatus").textContent = "Вставьте ключ";
    return;
  }
  $("onboardingStatus").textContent = "Проверяю…";
  const result = await granka.checkKey();
  $("onboardingStatus").textContent = result.ok
    ? `Ключ работает${result.freeTier ? " · бесплатный тариф" : ""}`
    : `Не работает: ${result.error}`;
});

$("onboardingNext1").addEventListener("click", async () => {
  if (!(await saveOnboardingKey())) {
    $("onboardingStatus").textContent = "Без ключа модель не ответит — можно вставить позже в настройках";
  }
  showOnboardingStep(2);
});

$("onboardingPick").addEventListener("click", async () => {
  const dir = await granka.pickDir();
  if (dir) $("onboardingCwd").value = dir;
});

$("onboardingBack2").addEventListener("click", () => showOnboardingStep(1));
$("onboardingBack3").addEventListener("click", () => showOnboardingStep(2));

$("onboardingNext2").addEventListener("click", async () => {
  await saveConfig({ cwd: $("onboardingCwd").value.trim() });
  showOnboardingStep(3);
});

$("onboardingSkip1").addEventListener("click", async () => {
  await saveConfig({ onboarded: true });
  closeOnboarding();
  await refreshSessions();
  await refreshHistory();
});
$("onboardingSkip2").addEventListener("click", async () => {
  await saveConfig({ onboarded: true });
  closeOnboarding();
  await refreshSessions();
  await refreshHistory();
});
$("onboardingSkip").addEventListener("click", async () => {
  await saveConfig({ onboarded: true });
  closeOnboarding();
  await refreshSessions();
  await refreshHistory();
});

$("onboardingStart").addEventListener("click", async () => {
  const question = $("onboardingPrompt").value.trim() || "Объясни, что делает этот проект";
  await saveConfig({ onboarded: true });
  closeOnboarding();
  await refreshSessions();
  await refreshHistory();
  $("prompt").value = question;
  autoGrow();
  send();
});

// --- layout sync: toolbar height and composer overlap -------------------

function syncLayout() {
  const toolbar = $("toolbar");
  const composer = $("composer");
  if (toolbar) {
    document.documentElement.style.setProperty("--toolbar-h", `${toolbar.offsetHeight}px`);
  }
  if (composer) {
    const overlap = Math.min(composer.offsetHeight, 320);
    document.documentElement.style.setProperty("--composer-overlap", `${overlap}px`);
    document.documentElement.style.setProperty("--log-pad-b", `${overlap + 24}px`);
  }
}
if ("ResizeObserver" in window) {
  const ro = new ResizeObserver(() => syncLayout());
  ro.observe($("toolbar"));
  ro.observe($("composer"));
}
window.addEventListener("resize", syncLayout);

// --- boot -----------------------------------------------------------------

if (localStorage.getItem("granka.sidebar") === "hidden") document.body.classList.add("noSidebar");
{
  const savedWidth = Number(localStorage.getItem("granka.sidebarWidth"));
  if (savedWidth >= SIDEBAR_MIN && savedWidth <= SIDEBAR_MAX) {
    document.documentElement.style.setProperty("--sidebar-w", `${savedWidth}px`);
  }
}
initSidebarResize();
syncScrollButton();
syncMaximizedIcon();

(async () => {
  const paths = await granka.paths();
  agentDir = paths.agentDir;
  try {
    const version = await granka.version();
    if (version) $("sidebarVersion").textContent = `v${version}`;
  } catch {}
  config = await granka.loadConfig();
  applyTheme();
  applyAccent();
  renderModelLabel();
  renderThinking();
  renderMode();

  allModels = await granka.listModels();
  modelsLoaded = true;
  renderModelLabel();
  renderThinking();

  commands = await granka.listCommands();
  await refreshProjects();
  await refreshSessions();
  await refreshHistory();
  autoGrow();

  if (config.onboarded !== true) {
    $("onboarding").hidden = false;
    setBackgroundInert(true);
    $("onboardingKey").value = "";
    $("onboardingKey").placeholder = config.hasApiKey ? "Ключ задан" : "sk-or-v1-…";
    showOnboardingStep(1);
  }
})();
