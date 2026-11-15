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
  systemAccent = (await granka.accentColor()) || "#0a84ff";
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
  $("toasts").append(node);
  const TOAST_LIFETIME = { ok: 4000, error: 9000 };
  const lifetime = error ? TOAST_LIFETIME.error : TOAST_LIFETIME.ok;
  const dismiss = () => {
    node.classList.add("isLeaving");
    setTimeout(() => node.remove(), 240);
  };
  setTimeout(() => {
    if (document.body.contains(node)) dismiss();
  }, lifetime);
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
  toast(String(message ?? "Неизвестная ошибка"), { error: true, action });
}

function setBusy(value) {
  busy = value;
  $("stop").hidden = !value;
  $("send").disabled = false; // stays usable: while busy it queues a follow-up
  $("send").title = value ? "Поставить в очередь (Enter)" : "Отправить (Enter)";
  renderActivity();
  granka.trayBusy?.(value);
}

function syncQueueBadge() {
  renderActivity();
}

function formatTokens(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

function showContext(context) {
  const meter = $("ctx");
  if (!context || context.percent == null) {
    meter.textContent = "";
    meter.title = "Заполнение контекста неизвестно (после сжатия — до следующего ответа)";
    return;
  }
  const percent = Math.min(100, Math.max(0, Math.round(context.percent)));
  meter.textContent = `${percent}%`;
  meter.title = context.tokens
    ? `контекст ${formatTokens(context.tokens)} из ${formatTokens(context.window)} токенов${context.estimated ? " (оценка)" : ""}`
    : "заполнение контекста";
}

// --- popover ---------------------------------------------------------------

let popoverAnchor = null;

function closePopover() {
  const panel = $("popover");
  if (panel.hidden) return;
  panel.hidden = true;
  // Return focus to the anchor the user opened the popover from.
  popoverAnchor?.focus();
  popoverAnchor = null;
}

function openPopover(anchor, build) {
  const panel = $("popover");
  if (popoverAnchor === anchor && !panel.hidden) return closePopover();
  panel.replaceChildren();
  build(panel);
  panel.hidden = false;
  const rect = anchor.getBoundingClientRect();
  const width = panel.offsetWidth;
  const height = panel.offsetHeight;
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
  const top = Math.min(rect.bottom + 4, window.innerHeight - height - 8);
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
  popoverAnchor = anchor;
  panel.querySelector("button, input")?.focus();
}

document.addEventListener("mousedown", (event) => {
  if ($("popover").hidden) return;
  if (event.target.closest("#popover") || event.target.closest("[aria-haspopup]")) return;
  closePopover();
});

// Generic focus trap for any visible dialog container.
function trapTab(container, event) {
  if (event.key !== "Tab") return;
  const focusables = [...container.querySelectorAll("button:not(:disabled), input, [tabindex]")]
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
  item.setAttribute("role", "menuitem");
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
  const list = document.createElement("div");
  list.className = "modelList";
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
      models: allModels,
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
      popoverItem(level, {
        current: level === (config.thinkingLevel ?? "off"),
        onSelect: () => {
          saveConfig({ thinkingLevel: level });
          renderBrain();
        },
      }),
    );
  }
  panel.append(
    popoverItem(`показ в чате: ${THINKING_MODES[mode]}`, {
      icon: "layers",
      current: mode !== "off",
      onSelect: () => {
        const next = modes[(modes.indexOf(mode) + 1) % modes.length];
        saveConfig({ thinkingDisplay: next });
        if (next === "off" && thinkingBlock && busy) {
          thinkingBlock.remove();
          resetThinking();
        }
      },
    }),
  );
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
    const modelTab = document.createElement("button");
    modelTab.className = "segment isActive";
    modelTab.textContent = "Модель";
    const thinkTab = document.createElement("button");
    thinkTab.className = "segment";
    thinkTab.textContent = "Мышление";
    const modelBody = document.createElement("div");
    const thinkBody = document.createElement("div");
    buildModelSection(modelBody);
    buildThinkingSection(thinkBody);
    thinkBody.hidden = true;
    const show = (model) => {
      modelTab.classList.toggle("isActive", model);
      thinkTab.classList.toggle("isActive", !model);
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
  renderWorkspaceMeta();
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
  renderWorkspaceMeta();
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
  if (level) level.textContent = current ?? "off";
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
  const data = await granka.getStats();
  const pane = $("statsPane");
  pane.replaceChildren();
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
    card("Запросы", String(data.totals.calls), `${data.byDay.length} дней`),
    card("Вход", formatTokens(data.totals.input), "токенов, включая кэш"),
    card("Кэш", formatTokens((data.totals.cacheRead ?? 0) + (data.totals.cacheWrite ?? 0)), "чтение + запись"),
    card("Выход", formatTokens(data.totals.output), "токенов"),
  );
  pane.append(summary);

  const maxCost = Math.max(...data.byDay.map((day) => day.cost), 0.0001);
  const chart = document.createElement("div");
  chart.className = "statsChart";
  for (const day of data.byDay) {
    const column = document.createElement("div");
    column.className = "statsBar";
    column.title = `${day.day}: ${day.calls} запросов · $${day.cost.toFixed(4)}`;
    const fill = document.createElement("span");
    fill.style.height = `${Math.max(2, Math.round((day.cost / maxCost) * 100))}%`;
    column.append(fill);
    chart.append(column);
  }
  pane.append(chart);

  const table = document.createElement("div");
  table.className = "statsTable";
  const head = document.createElement("div");
  head.className = "statsRow isHead";
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
    if (!text) return fail("Нечего повторять");
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
  const who = document.createElement("div");
  who.className = "who";
  const label = document.createElement("span");
  label.textContent = role === "user" ? "вы" : "granka";
  who.append(label, messageActions(role, wrapper));
  const body = document.createElement("div");
  body.className = "text";
  if (role === "assistant") {
    body.innerHTML = window.mdToHtml(wrapper.__raw);
    decorateCodeBlocks(body);
  } else body.textContent = wrapper.__raw;
  wrapper.append(who, body);
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
  if (!usage) return;
  const line = document.createElement("div");
  line.className = "usage";
  const cost = usage.cost >= 0.01 ? `$${usage.cost.toFixed(3)}` : `$${usage.cost.toFixed(5)}`;
  line.textContent = `↑${formatTokens(usage.input)} · ↓${formatTokens(usage.output)} · ${cost}${usage.billed ? "" : " оценка"}`;
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
    primary.className = "ghostBtn";
    primary.textContent = "Открыть настройки";
    primary.style.marginBottom = "14px";
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

  if (hasKey) box.append(title, hint);
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
    renderAssistant(streamWrapper, streamBody, streamText);
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
    head.append(svgIcon("chevron-down"));
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
    thinkingBlock.addEventListener("click", (event) => {
      if (event.target.closest("a")) return;
      toggleThinking(thinkingBlock);
    });
    thinkingBlock.addEventListener("keydown", (event) => {
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

function makeToolChip(name, args) {
  const chip = document.createElement("div");
  chip.className = "tool isRunning";
  chip.tabIndex = 0;
  chip.dataset.name = name;
  chip.setAttribute("role", "button");
  chip.setAttribute("aria-expanded", "false");
  chip.__detail = { name, args: args ?? "", result: "", durationMs: 0, isError: false };
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
  if (name === "task") {
    try {
      agentRole = JSON.parse(args ?? "{}").agent ?? "";
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
  }
  chip.append(texts);
  const preview = toolPreview(name, args) || toolFirstLine(args);
  if (preview && name !== "task") {
    const previewEl = document.createElement("span");
    previewEl.className = "toolArgs";
    previewEl.textContent = preview;
    previewEl.title = pickArg(name, args) || preview;
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
  group.querySelector(".toolCount").textContent = `×${chips.length}`;
  const total = chips.reduce((sum, chip) => sum + (chip.__detail?.durationMs || 0), 0);
  const totalText = formatDuration(total);
  group.querySelector(".toolTime").textContent = totalText ? `· ${totalText}` : "";
  group.classList.toggle("isCollapsed", chips.length >= 3);
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
  toolBlockHead.append(icon, label, count, time, svgIcon("chevron-down", "icon chev"));
  const toggle = () => {
    toolBlock.classList.toggle("isOpen");
    toolBlockHead.setAttribute("aria-expanded", String(toolBlock.classList.contains("isOpen")));
  };
  toolBlockHead.addEventListener("click", toggle);
  toolBlockHead.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
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
  toolBlockHead.querySelector(".toolCount").textContent = `· ${chips.length}`;
  toolBlockHead.querySelector(".toolTime").textContent = totalText ? `· ${totalText}` : "";
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
    const chip = makeToolChip(tool.name, tool.args);
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
    const pending = [...streamWrapper.querySelectorAll(".tool.isRunning:not(.done):not(.error)")];
    const chip = pending[pending.length - 1];
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
      announce(`Инструмент ${chip.querySelector(".toolLabel").textContent} ${tool.isError ? "завершился с ошибкой" : "завершён"}.`);
      const group = chip.closest(".toolGroup");
      if (group) updateGroupHead(group);
      if (toolBlock) updateToolBlockHead();
    }
  }
  scrollIf(stick);
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
    addDivider(`подагент: ${notice.description} · ${notice.chars} символов`);
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
    for (const line of text.split("\n")) {
      const row = document.createElement("div");
      row.className = `diffLine ${cls}`;
      row.textContent = (cls === "del" ? "− " : "+ ") + line;
      diff.append(row);
    }
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
  const [firstKey, firstValue] = entries[0];
  const main = document.createElement("div");
  main.className = "argRow";
  const key = document.createElement("span");
  key.className = "argKey";
  key.textContent = firstKey;
  const value = document.createElement("span");
  value.className = "argValue";
  value.textContent = typeof firstValue === "string" ? firstValue : JSON.stringify(firstValue);
  main.append(key, value);
  section.append(main);
  if (entries.length > 1) {
    const meta = document.createElement("div");
    meta.className = "argMeta";
    meta.textContent = entries
      .slice(1)
      .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" · ");
    section.append(meta);
  }
  return section;
}

function toggleToolDetail(chip) {
  const existing = chip.nextElementSibling;
  if (existing?.classList.contains("toolDetail")) {
    existing.remove();
    chip.setAttribute("aria-expanded", "false");
    return;
  }
  const detail = document.createElement("div");
  detail.className = "toolDetail";
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
    await navigator.clipboard.writeText(`${args}\n\n— результат —\n${unwrapResult(result) || "(нет)"}`);
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
  chip.after(detail);
  chip.setAttribute("aria-expanded", "true");
}

log.addEventListener("click", (event) => {
  const chip = event.target.closest(".tool");
  if (chip) toggleToolDetail(chip);
});

log.addEventListener("keydown", (event) => {
  const chip = event.target.closest?.(".tool");
  if (chip && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    toggleToolDetail(chip);
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
  localStorage.setItem("granka.sidebar", hidden ? "hidden" : "shown");
}

$("sidebarToggle").addEventListener("click", toggleSidebar);

function renderProjectLabel() {
  const project = projects.find((item) => item.id === activeProjectId);
  $("projectName").textContent = project ? project.name : "Без проекта";
  $("projectPopup").title = project?.cwd || "Проект не выбран";
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
  list.replaceChildren(
    ...visible.map((item) => {
      const row = document.createElement("div");
      row.className = `planRow is-${item.status}`;
      row.append(Object.assign(document.createElement("span"), { className: "planDot" }));
      const text = document.createElement("span");
      text.textContent = item.content;
      row.append(text);
      return row;
    }),
  );
  list.hidden = visible.length === 0;
}

$("planStripToggle").addEventListener("click", () => {
  const button = $("planStripToggle");
  const expanded = button.getAttribute("aria-expanded") === "true";
  button.setAttribute("aria-expanded", String(!expanded));
  button.title = expanded ? "Развернуть все задачи" : "Свернуть задачи";
  button.classList.toggle("isOpen", !expanded);
  renderPlanStrip();
});

$("planStripClear").addEventListener("click", () => {
  plans.delete(planKey());
  renderPlanStrip();
});

let currentQuestionId = "";

function renderQuestion(payload) {
  currentQuestionId = payload.id ?? "";
  const modal = $("questionModal");
  const options = $("questionOptions");
  const freeform = $("questionFreeform");
  $("questionHeader").textContent = payload.header ?? "";
  $("questionHeader").hidden = !payload.header;
  $("questionTitle").textContent = payload.question ?? "";
  options.replaceChildren();
  freeform.hidden = payload.allowFreeform === false;

  const close = (answer) => {
    modal.hidden = true;
    granka.answer(currentQuestionId, answer);
    currentQuestionId = "";
    $("prompt").focus();
  };

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
    button.addEventListener("click", () => close(option.label));
    options.append(button);
  }

  const input = $("questionInput");
  input.value = "";
  $("questionSubmit").onclick = () => {
    const value = input.value.trim();
    if (value) close(value);
  };
  input.onkeydown = (event) => {
    if (event.key === "Enter") $("questionSubmit").click();
    if (event.key === "Escape") close("");
  };

  modal.hidden = false;
  options.querySelector("button")?.focus();
}

// Question modal: Escape and overlay click close it, Tab stays inside.
// Registered once; renderQuestion only fills the content.
$("questionModal").addEventListener("click", (event) => {
  if (event.target === $("questionModal")) {
    $("questionModal").hidden = true;
    granka.answer(currentQuestionId, "");
    currentQuestionId = "";
    $("prompt").focus();
  }
});

document.addEventListener("keydown", (event) => {
  const modal = $("questionModal");
  if (modal.hidden) return;
  if (event.key === "Escape") {
    event.preventDefault();
    modal.hidden = true;
    granka.answer(currentQuestionId, "");
    currentQuestionId = "";
    $("prompt").focus();
    return;
  }
  if (event.key === "Tab") trapTab(modal, event);
});

function renderWorkspaceMeta() {
  const mode = AGENT_MODES[agentMode()];
  const meta = $("titlebarMeta");
  meta.textContent = agentMode() === "chat" ? "" : mode.name;
  meta.title = agentMode() === "chat" ? "" : `${mode.name}: ${mode.hint}`;
  $("composerHint").textContent =
    agentMode() === "plan"
      ? "режим плана — только чтение · Enter — отправить · «/» — команды"
      : "Enter — отправить · Shift+Enter — новая строка · «/» — команды";
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
  input.setAttribute("aria-label", "Новое имя сессии");
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
  add("Экспорт в Markdown", {
    icon: "file-text",
    onSelect: async () => {
      const result = await granka.exportSessions([item.id]);
      if (!result.ok) return fail(result.error ?? "не удалось экспортировать");
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
      toast("Чат перенесён в «Без проекта»");
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
        toast(`Чат перенесён в «${project.name}»`);
      },
    });
  }

  separator();
  add("Удалить", {
    danger: true,
    icon: "trash-2",
    onSelect: async () => {
      const result = await granka.deleteSession(item.id);
      if (!result.ok) return fail(result.error);
      if (item.id === currentSessionId) {
        await granka.newSession();
        currentSessionId = "";
        await refreshHistory();
      }
      await refreshSessions();
      toast("Сессия удалена");
    },
  });

  panel.hidden = false;
  const width = panel.offsetWidth;
  panel.style.left = `${Math.min(x, window.innerWidth - width - 8)}px`;
  panel.style.top = `${Math.min(y, window.innerHeight - panel.offsetHeight - 8)}px`;
  popoverAnchor = null;
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
    if (query) {
      empty.append("Ничего не найдено. ");
      const reset = document.createElement("button");
      reset.className = "linkBtn";
      reset.textContent = "Сбросить";
      reset.addEventListener("click", () => {
        $("sessionSearch").value = "";
        refreshSessions();
      });
      empty.append(reset);
    } else {
      empty.textContent = "Диалогов пока нет.";
    }
    list.append(empty);
    return;
  }

  // Absolute scale: share of the current model's context window, estimated
  // from message chars (chars/4). The previous relative scale (longest
  // session = 100%) made every list look full regardless of real size.
  const modelWindow = modelById(config.model)?.context ?? 0;

  sessions.forEach((item, index) => {
    const row = document.createElement("button");
    const active = item.id === currentSessionId;
    row.className = `sessionItem${active ? " isActive" : ""}`;
    row.dataset.id = item.id;
    row.dataset.projectId = item.projectId ?? "";
    if (active) row.setAttribute("aria-current", "true");
    row.tabIndex = -1;

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
    row.append(title, meta);

    row.addEventListener("click", () => switchSession(item.id));
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
  renderWorkspaceMeta();
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
  if (busy || !id || id === currentSessionId) return;
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
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    listIndex = Math.min(Math.max(listIndex + delta, 0), sessions.length - 1);
    const rows = [...$("sessionList").querySelectorAll(".sessionItem")];
    rows.forEach((row, index) => row.toggleAttribute("data-active", index === listIndex));
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
  renderWorkspaceMeta();
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
    const block = buildThinkingBlock(message.thinking, thinkingMode() === "always");
    wrapper.insertBefore(block, body);
  }
  for (const tool of message.tools ?? []) {
    appendHistoryTool(wrapper, tool);
  }
  if (message.usage) addUsage(wrapper, message.usage);
}

function buildThinkingBlock(text, open) {
  const block = document.createElement("div");
  block.className = `thinking${open ? " isOpen" : ""}`;
  block.tabIndex = 0;
  block.setAttribute("role", "button");
  block.setAttribute("aria-expanded", String(open));
  const head = document.createElement("div");
  head.className = "thinkingHead";
  head.append(svgIcon("chevron-down"));
  const title = document.createElement("span");
  title.textContent = "мышление";
  head.append(title);
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

function appendHistoryTool(wrapper, tool) {
  const chip = makeToolChip(tool.name, tool.args);
  chip.__detail.result = tool.result ?? "";
  chip.__detail.durationMs = tool.durationMs ?? 0;
  chip.__detail.isError = Boolean(tool.isError);
  chip.classList.remove("isRunning");
  chip.classList.add(tool.isError ? "error" : "done");
  setToolIcon(chip, tool.isError ? "circle-alert" : "check");
  const time = formatDuration(tool.durationMs);
  chip.querySelector(".toolTime").textContent = time ? `· ${time}` : "";
  if (toolMode() === "off") return;
  // History renders flat chips (grouping was a live-only nicety).
  wrapper.insertBefore(chip, wrapper.querySelector(".text"));
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
    box.append(chip);
  }
}

async function addAttachments(paths) {
  const result = await granka.attachFiles(paths);
  if (!result.ok) return fail(result.error ?? "не удалось прикрепить файлы");
  for (const item of result.added) attachments.push(item);
  for (const skip of result.skipped) fail(`Пропущено: ${skip.path} — ${skip.reason}`);
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
    fail(`Не удалось открыть диалог выбора файла: ${err?.message ?? err}`);
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

granka.onAttachProgress((progress) => {
  const percent = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  setStatus(`копирую ${progress.path.split(/[\\/]/).pop()}… ${percent}%`);
});

$("prompt").addEventListener("paste", async (event) => {
  const rawText = event.clipboardData?.getData("text/plain") ?? "";
  // A pasted filesystem path becomes an attachment instead of plain text.
  const trimmed = rawText.trim();
  if (
    !event.clipboardData?.types?.includes("Files") &&
    /^\/[\w.\- /]+$/.test(trimmed) &&
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
    box.hidden = true;
    suggestIndex = -1;
    return;
  }
  box.replaceChildren(
    ...matches.map((entry) => {
      const row = document.createElement("button");
      row.className = "suggestRow";
      const name = document.createElement("b");
      name.textContent = entry.name;
      const desc = document.createElement("span");
      desc.textContent = entry.description;
      row.append(name, desc);
      row.__entry = entry;
      row.addEventListener("click", () => {
        if (entry.action === "plan") {
          saveConfig({ planMode: !config.planMode });
          renderWorkspaceMeta();
          $("prompt").value = "";
          box.hidden = true;
          toast(config.planMode ? "Режим плана выключен" : "Режим плана включён: только чтение");
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
    if (!result.ok) return fail(result.error ?? "Очередь недоступна");
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
  $("composerHint").hidden = true;
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
      const target = streamWrapper ?? addMessage("assistant", "").wrapper;
      attachError(target, result.error);
      setStatus("");
    } else {
      if (!streamWrapper) {
        const created = addMessage("assistant", result.text);
        created.wrapper.__prompt = streamPrompt;
        addUsage(created.wrapper, result.usage);
      } else {
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
    scrollIf(true);
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
    if (event.key === "Tab" || (event.key === "Enter" && suggestIndex >= 0)) {
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
  if (event.key === "Tab" && event.shiftKey) {
    event.preventDefault();
    const ids = Object.keys(AGENT_MODES);
    setAgentMode(ids[(ids.indexOf(agentMode()) + 1) % ids.length]);
    return;
  }
  const sendOnEnter = config.sendOnEnter !== false;
  const wantsSend = sendOnEnter
    ? event.key === "Enter" && !event.shiftKey
    : event.key === "Enter" && (event.metaKey || event.ctrlKey);
  if (wantsSend) {
    event.preventDefault();
    send();
  }
});

$("prompt").addEventListener("focus", () => {
  $("composerHint").hidden = false;
});
$("prompt").addEventListener("blur", () => {
  $("composerHint").hidden = true;
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
  text.textContent = "Сжимаю контекст…";
  text.style.flex = "1";
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
  renderWorkspaceMeta();
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
  renderWorkspaceMeta();
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

  const name = document.createElement("input");
  name.className = "textInput";
  name.id = "projectNameInput";
  name.placeholder = "Имя проекта";
  name.value = project?.name ?? "";

  const cwdInput = document.createElement("input");
  cwdInput.className = "textInput";
  cwdInput.placeholder = "Папка проекта";
  // Fresh (new project) starts completely empty — no inherited folder,
  // name or rules from the previously open project.
  cwdInput.value = fresh ? "" : (project?.cwd ?? "");
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
    instructions.value = rules.text ?? "";
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

  const saveProject = document.createElement("button");
  saveProject.className = "ghostBtn";
  saveProject.textContent = project ? "Сохранить проект" : "Создать проект";
  saveProject.addEventListener("click", async () => {
    if (!name.value.trim()) return fail("Нужно имя проекта");
    const result = await granka.saveProject({
      id: project?.id,
      name: name.value,
      cwd: cwdInput.value.trim(),
      instructions: instructions.value,
      model: profileModelValue,
      thinkingLevel: profileThinkingValue,
    });
    if (!result.ok) return fail(result.error);

    if (cwdInput.value.trim()) {
      const savedRules = await granka.saveProjectRules(result.id, instructions.value);
      if (!savedRules.ok) return fail(savedRules.error);
    }
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
    labeled("Модель проекта", profileModel.element),
    labeled("Уровень мышления", profileThinking.element),
    profileHint,
    saveProject,
  );

  if (fresh || focusName) name.focus();
}

function labeled(text, control) {
  const box = document.createElement("div");
  box.className = "field";
  const label = document.createElement("label");
  label.textContent = text;
  box.append(label, control);
  return box;
}

// --- all sessions ----------------------------------------------------------

async function buildSessionsPane() {
  const pane = $("sessionsPane");
  pane.replaceChildren();

  sessionsAll = await granka.listSessions("");
  $("sessionsMeta").textContent = `${sessionsAll.length} диалогов · ~/.granka`;

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
  exportButton.textContent = "Экспорт";
  exportButton.addEventListener("click", async () => {
    const ids = [...selectedSessions];
    if (!ids.length) return;
    const result = await granka.exportSessions(ids);
    if (!result.ok) return fail(result.error ?? "не удалось экспортировать");
    await copyText(result.text);
    toast(`Скопировано в буфер: ${ids.length} диалог(ов) в Markdown`);
  });
  const deleteButton = document.createElement("button");
  deleteButton.className = "ghostBtn danger";
  deleteButton.textContent = "Удалить";
  deleteButton.addEventListener("click", async () => {
    const ids = [...selectedSessions];
    if (!ids.length) return;
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
        const result = await granka.deleteSession(item.id);
        if (!result.ok) return;
        sessionsAll = sessionsAll.filter((entry) => entry.id !== item.id);
        if (item.id === currentSessionId) {
          await granka.newSession();
          currentSessionId = "";
          await refreshHistory();
        }
        $("sessionsMeta").textContent = `${sessionsAll.length} диалогов · ~/.granka`;
        render();
        await refreshSessions();
        toast("Сессия удалена");
      });
      row.append(checkbox, main, rename, remove);
      list.append(row);
    }
    renderBulk();
  };

  const searchWrap = document.createElement("label");
  searchWrap.className = "searchField";
  searchWrap.style.maxWidth = "var(--col)";
  searchWrap.append(svgIcon("search"));
  const search = document.createElement("input");
  search.id = "allSessionsSearch";
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
      popoverItem("Новый диалог", { icon: "plus", onSelect: newChat }),
      popoverItem("Все сессии", { icon: "layers", onSelect: () => setView("sessions") }),
      popoverItem("Аналитика", { icon: "chart", onSelect: () => setView("stats") }),
      popoverItem("Проект", { icon: "settings-2", onSelect: () => setView("project") }),
      Object.assign(document.createElement("div"), { className: "popoverSeparator" }),
      popoverItem("Сжать контекст", {
        icon: "archive",
        onSelect: () => compactNow(),
      }),
      popoverItem("Настройки…", { icon: "settings-2", onSelect: () => granka.openSettings() }),
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
  renderWorkspaceMeta();
});

granka.onMenu((action) => {
  if (action === "new-chat") newChat();
  else if (action === "all-sessions") setView("sessions");
  else if (action === "toggle-sidebar") toggleSidebar();
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
    if ($("prompt").value) {
      $("prompt").value = "";
      autoGrow();
      return;
    }
    if (busy) granka.abort();
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
}

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
    renderWorkspaceMeta();
  }
});

// --- onboarding ------------------------------------------------------------

let onboardingStep = 1;

function showOnboardingStep(step) {
  onboardingStep = step;
  for (const index of [1, 2, 3]) {
    $(`onboardingStep${index}`).hidden = index !== step;
  }
  if (step === 1) $("onboardingKey").focus();
  if (step === 2) $("onboardingCwd").value = config.cwd ?? "";
  if (step === 3) $("onboardingPrompt").focus();
}

function closeOnboarding() {
  $("onboarding").hidden = true;
}

// Onboarding is a modal dialog: keep Tab inside it while visible.
document.addEventListener("keydown", (event) => {
  const box = $("onboarding");
  if (!box || box.hidden) return;
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

// --- boot -----------------------------------------------------------------

if (localStorage.getItem("granka.sidebar") === "hidden") document.body.classList.add("noSidebar");
syncScrollButton();
syncMaximizedIcon();

(async () => {
  const paths = await granka.paths();
  agentDir = paths.agentDir;
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
    $("onboardingKey").value = "";
    $("onboardingKey").placeholder = config.hasApiKey ? "Ключ задан" : "sk-or-v1-…";
    showOnboardingStep(1);
  }
})();
