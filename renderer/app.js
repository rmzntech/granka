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
let streamBody = null;
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
const FONT_STACKS = {
  system: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Granka Inter", system-ui, sans-serif',
  inter: '"Granka Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  serif: 'Georgia, "Times New Roman", "Granka Inter", serif',
  rounded: '"SF Pro Rounded", "Granka Inter", -apple-system, system-ui, sans-serif',
};
const MONO_STACKS = {
  system: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  jetbrains: '"Granka Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  serif: '"Iosevka", "Courier New", Georgia, monospace',
};

function applyFonts() {
  const ui = FONT_STACKS[config.uiFont] ?? FONT_STACKS.system;
  const code = MONO_STACKS[config.codeFont] ?? MONO_STACKS.system;
  document.documentElement.style.setProperty("--font", ui);
  document.documentElement.style.setProperty("--mono", code);
}

function applyTheme() {
  const { THEMES, resolveThemeId, themeVars } = globalThis.grankaThemes;
  const id = resolveThemeId(config.theme, MONO_MEDIA.matches);
  const { mode, tokens } = themeVars(
    id,
    config.accentSystem === false ? "" : systemAccent,
  );
  document.body.dataset.theme = mode;
  document.body.dataset.themeId = id;
  applyFonts();
  for (const [name, value] of Object.entries(tokens)) {
    const cssName = name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    document.documentElement.style.setProperty(`--${cssName}`, value);
  }
  // text size preference (settings)
  const size = config.fontSize ?? "m";
  document.documentElement.style.setProperty("--prose", size === "l" ? "15px" : size === "s" ? "12.5px" : "13.5px");
  document.documentElement.style.setProperty("--mono-chevron", THEMES[id] ? tokens.text2 : "#63636a");
  document.documentElement.style.setProperty(
    "--chevron-img",
    `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='${encodeURIComponent(tokens.text2)}' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='m6 9 6 6 6-6'/></svg>")`,
  );
  document.body.classList.toggle("noUsage", config.showUsage === false);
  document.body.dataset.density = config.density === "compact" ? "compact" : "comfortable";
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
  const lifetime = error ? 9000 : 4000;
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
  $("runBtn").hidden = !value;
  $("send").disabled = false; // stays usable: while busy it queues a follow-up
  $("send").title = value ? "Поставить в очередь (Enter)" : "Отправить (Enter)";
}

function syncQueueBadge() {
  const badge = $("runBtn").querySelector(".queueBadge");
  if (queued > 0 && busy) {
    if (!badge) {
      const node = document.createElement("span");
      node.className = "queueBadge";
      node.textContent = String(queued);
      $("runBtn").append(node);
    } else badge.textContent = String(queued);
    $("runBtn").title = `Агент работает · в очереди ${queued}`;
  } else {
    badge?.remove();
    $("runBtn").title = "Агент работает";
  }
}

function formatTokens(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

function showContext(context) {
  const meter = $("ctx");
  meter.textContent = context?.percent == null ? "" : `${Math.round(context.percent)}%`;
  meter.title = context?.tokens
    ? `контекст ${context.tokens} из ${context.window} токенов`
    : "заполнение контекста";
}

// --- popover ---------------------------------------------------------------

let popoverAnchor = null;

function closePopover() {
  $("popover").hidden = true;
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
  $("modelName").textContent = config.model ?? "модель";
  $("modelPopup").title = model
    ? `${model.id}\n${formatTokens(model.context)} контекст · $${model.cost?.input ?? "?"}/$${model.cost?.output ?? "?"} за 1M токенов`
    : "Выбрать модель";
}

function openModelPopover() {
  openPopover($("modelPopup"), (panel) => {
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
  });
}

async function toggleFavorite(modelId) {
  const favorites = new Set(config.favorites ?? []);
  if (favorites.has(modelId)) favorites.delete(modelId);
  else favorites.add(modelId);
  await saveConfig({ favorites: [...favorites] });
}

function openThinkingPopover() {
  openPopover($("thinkingPopup"), (panel) => {
    for (const level of levelsOf(config.model)) {
      panel.append(
        popoverItem(level, {
          current: level === (config.thinkingLevel ?? "off"),
          onSelect: () => {
            $("thinkingName").textContent = level;
            saveConfig({ thinkingLevel: level });
          },
        }),
      );
    }
  });
}

function renderThinking() {
  const levels = levelsOf(config.model);
  const current = levels.includes(config.thinkingLevel)
    ? config.thinkingLevel
    : levels.includes("medium")
      ? "medium"
      : levels[0];
  $("thinkingName").textContent = current ?? "off";
  $("thinkingPopup").disabled = levels.length < 2;
  $("thinkingPopup").title = levels.length < 2 ? "модель без уровней мышления" : "Уровень мышления";
  if (current && current !== config.thinkingLevel) saveConfig({ thinkingLevel: current });
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
  $("memoryView").hidden = next !== "memory";
  for (const name of ["chat", "project", "memory"]) {
    const button = $(`segment${name[0].toUpperCase()}${name.slice(1)}`);
    button.classList.toggle("isActive", next === name);
    button.setAttribute("aria-selected", String(next === name));
  }
  if (next === "project") void buildProjectPane();
  if (next === "sessions") buildSessionsPane();
  if (next === "stats") buildStatsPane();
  if (next === "memory") buildMemoryPane();
}

// One global layer: AGENTS.md. It is read by the agent for every project.
async function buildMemoryPane() {
  const pane = $("memoryPane");
  pane.replaceChildren();
  const rules = await granka.getRules();

  const area = document.createElement("textarea");
  area.className = "panelTextarea";
  area.id = "rulesAgents";
  area.placeholder = "Правила для всех проектов: что делать всегда, чего не делать никогда";
  area.value = rules.agents;
  area.rows = 12;

  const hint = document.createElement("div");
  hint.className = "hint";
  hint.textContent =
    "Файл ~/.granka/AGENTS.md читается для каждого проекта. Держите здесь постоянные предпочтения и запреты; правила конкретной папки — на вкладке «Проект». Применяется при создании сессии.";

  const save = document.createElement("button");
  save.className = "ghostBtn";
  save.textContent = "Сохранить правила";
  save.addEventListener("click", async () => {
    const result = await granka.saveRules({ system: rules.system, agents: area.value });
    if (!result.ok) return fail(result.error);
    toast("Правила сохранены");
    await refreshHistory();
  });

  const promptBox = document.createElement("details");
  promptBox.className = "promptDetails";
  const promptSummary = document.createElement("summary");
  promptSummary.textContent = "Системный промпт (только чтение)";
  const promptView = document.createElement("pre");
  promptView.className = "readonlyRules";
  promptView.id = "rulesSystemView";
  promptView.tabIndex = 0;
  promptView.textContent = rules.system || "(пусто)";
  promptBox.append(promptSummary, promptView);

  pane.append(labeled("Правила — AGENTS.md", area), hint, save, promptBox);
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
    card("Стоимость", `$${data.totals.cost.toFixed(3)}`, "по каталогу провайдера"),
    card("Запросы", String(data.totals.calls), `${data.byDay.length} дней`),
    card("Вход", formatTokens(data.totals.input), "токенов"),
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
    const text = role === "user" ? wrapper.__raw : await granka.lastPrompt();
    if (!text) return fail("Нечего повторять");
    $("prompt").value = text;
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

function addDivider(text) {
  const line = document.createElement("div");
  line.className = "divider";
  line.textContent = text;
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

  if (config.apiKey) {
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
    chip.addEventListener("click", () => {
      $("prompt").value = sample;
      autoGrow();
      $("prompt").focus();
    });
    starters.append(chip);
  }

  if (config.apiKey) box.append(title, hint);
  box.append(starters);
  log.append(box);
}

function currentAssistant() {
  if (!streamWrapper) ({ wrapper: streamWrapper, body: streamBody } = addMessage("assistant", ""));
  return streamBody;
}

granka.onDelta((delta) => {
  if (!busy) return;
  const stick = config.autoScroll === false ? false : stickToBottom();
  currentAssistant();
  streamText += delta;
  renderAssistant(streamWrapper, streamBody, streamText);
  scrollIf(stick);
});

granka.onTool((tool) => {
  if (!busy) return;
  const stick = stickToBottom();
  currentAssistant();
  if (tool.phase === "start") {
    const chip = document.createElement("div");
    chip.className = "tool";
    chip.tabIndex = 0;
    chip.setAttribute("role", "button");
    chip.setAttribute("aria-expanded", "false");
    chip.__detail = { args: tool.args ?? "", result: "" };
    const label = TOOL_LABELS[tool.name] ?? tool.name;
    chip.textContent = `▸ ${label}${tool.args ? " · " + tool.args.split("\n")[0].slice(0, 80) : ""}`;
    streamWrapper.insertBefore(chip, streamBody);
  } else {
    const pending = [...streamWrapper.querySelectorAll(".tool:not(.done):not(.error)")];
    const chip = pending[pending.length - 1];
    if (chip) {
      chip.__detail.result = tool.result ?? "";
      chip.classList.add(tool.isError ? "error" : "done");
      const name = chip.textContent.replace(/^[▸✓✗]\s*/, "").split(" · ")[0];
      chip.textContent = `${tool.isError ? "✗" : "✓"} ${name}${tool.durationMs ? ` · ${tool.durationMs} ms` : ""}`;
      announce(`Инструмент ${name} ${tool.isError ? "завершился с ошибкой" : "завершён"}.`);
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

function toggleToolDetail(chip) {
  const existing = chip.nextElementSibling;
  if (existing?.classList.contains("toolDetail")) {
    existing.remove();
    chip.setAttribute("aria-expanded", "false");
    return;
  }
  const detail = document.createElement("pre");
  detail.className = "toolDetail";
  detail.textContent = `${chip.__detail.args}\n\n— результат —\n${chip.__detail.result || "(нет)"}`;
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

function planKey() {
  return currentSessionId || "draft";
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
  $("planStripCount").textContent = `План ${done}/${items.length}`;

  const list = $("planStripItems");
  const expanded = $("planStripToggle").getAttribute("aria-expanded") === "true";
  const visible = expanded ? items : items.filter((item) => item.status !== "completed").slice(0, 3);
  list.replaceChildren(
    ...visible.map((item) => {
      const row = document.createElement("div");
      row.className = `planRow is-${item.status}`;
      row.append(svgIcon(item.status === "completed" ? "check" : item.status === "in_progress" ? "loader" : "circle"));
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
  button.textContent = expanded ? "развернуть" : "свернуть";
  renderPlanStrip();
});

$("planStripClear").addEventListener("click", () => {
  plans.delete(planKey());
  renderPlanStrip();
});

function renderQuestion(payload) {
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
    granka.answer(payload.id, answer);
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

function renderWorkspaceMeta() {
  const meta = $("titlebarMeta");
  meta.textContent = "";
  meta.title = "";
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

  const maxWeight = Math.max(...sessions.map((item) => item.weight ?? 0), 1);

  sessions.forEach((item, index) => {
    const row = document.createElement("button");
    const active = item.id === currentSessionId;
    row.className = `sessionItem${active ? " isActive" : ""}${item.weight && sessions.length > 1 ? " hasWeight" : ""}`;
    row.dataset.id = item.id;
    row.dataset.projectId = item.projectId ?? "";
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(active || index === listIndex));
    row.tabIndex = -1;

    const title = document.createElement("span");
    title.className = "sessionTitle";
    if (pinned.has(item.id)) title.append(svgIcon("star", "icon pinIcon"));
    title.append(highlightMatch(item.title, query));
    const meta = document.createElement("span");
    meta.className = "sessionMeta";
    meta.textContent = new Date(item.modified).toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    row.append(title, meta);

    if (item.weight && sessions.length > 1) {
      const bar = document.createElement("span");
      bar.className = "sessionWeight";
      const fill = document.createElement("span");
      fill.className = "sessionWeightFill";
      fill.style.width = `${Math.max(4, Math.round((item.weight / maxWeight) * 100))}%`;
      bar.append(fill);
      bar.title = `~${formatTokens(Math.round(item.weight / 4))} токенов контекста`;
      row.append(bar);
    }

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
  const chat = sessions.find((session) => session.id === currentSessionId);
  const project = projects.find((item) => item.id === (currentProjectId || activeProjectId));
  // the titlebar names the workspace, not the chat: one stable label, readable
  $("titleText").textContent = project ? project.name : "granka";
  $("titleText").title = project ? project.cwd || project.name : "granka";
  document.title = project ? `${project.name} — granka` : "granka";
  renderWorkspaceMeta();
}

let agentDir = "";
let currentProjectId = "";

async function refreshSessions() {
  // strict binding: the sidebar only ever shows this project's chats
  sessions = await granka.listSessions($("sessionSearch").value, { projectId: activeProjectId });
  renderSessions();
  await refreshTitle();
}

async function switchSession(id) {
  if (busy || !id || id === currentSessionId) return;
  const result = await granka.openSession(id);
  if (!result.ok) return fail(result.error);
  $("sessionSearch").value = ""; // never keep a filter from the previous session
  config = await granka.loadConfig();
  await refreshProjects();
  await refreshSessions();
  await refreshHistory();
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
    rows.forEach((row, index) => row.setAttribute("aria-selected", String(index === listIndex)));
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
  renderHistoryWindow();
  syncScrollButton();
  showContext(history.context);
  renderWorkspaceMeta();
  renderSessions(); // keep the active highlight in sync with the opened chat
  await refreshTitle();
}

// Long chats are rendered in a window: the DOM keeps only the tail, older
// messages load on demand instead of growing without bound.
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
      visibleCount = Math.min(historyMessages.length, visibleCount + 40);
      renderHistoryWindow();
      log.scrollTop = 0;
    });
    log.append(more);
  }
  for (const message of historyMessages.slice(start)) addMessage(message.role, message.text, { animate: false });
  log.scrollTop = log.scrollHeight;
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
    name.textContent = item.name;
    const kind = document.createElement("span");
    kind.className = "attachmentKind";
    kind.textContent = item.kind === "image" ? "изобр." : item.kind === "document" ? "документ" : "файл";
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
}

$("attachBtn").addEventListener("click", async () => {
  const paths = await granka.pickFiles();
  if (paths.length) await addAttachments(paths);
});

const composer = $("composer");
composer.addEventListener("dragover", (event) => {
  event.preventDefault();
  composer.classList.add("isDropping");
});
composer.addEventListener("dragleave", () => composer.classList.remove("isDropping"));
composer.addEventListener("drop", async (event) => {
  event.preventDefault();
  composer.classList.remove("isDropping");
  const paths = [...(event.dataTransfer?.files ?? [])]
    .map((file) => granka.pathForFile(file))
    .filter(Boolean);
  if (paths.length) await addAttachments(paths);
});

$("prompt").addEventListener("paste", async (event) => {
  // A huge paste belongs in a file, not in the context window.
  const text = event.clipboardData?.getData("text/plain") ?? "";
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

function applySuggest(name) {
  $("prompt").value = `${name} `;
  $("suggest").hidden = true;
  suggestIndex = -1;
  autoGrow();
  $("prompt").focus();
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
  const matches = commands.prompts
    .filter((prompt) => prompt.name.slice(1).toLowerCase().includes(query))
    .slice(0, 8);
  if (!matches.length) {
    box.hidden = true;
    suggestIndex = -1;
    return;
  }
  box.replaceChildren(
    ...matches.map((prompt) => {
      const row = document.createElement("button");
      row.className = "suggestRow";
      row.setAttribute("role", "option");
      const name = document.createElement("b");
      name.textContent = prompt.name;
      const desc = document.createElement("span");
      desc.textContent = prompt.description;
      row.append(name, desc);
      row.addEventListener("click", () => applySuggest(prompt.name));
      return row;
    }),
  );
  box.hidden = false;
  suggestIndex = -1;
  highlightSuggest();
}

async function send() {
  const question = $("prompt").value.trim();
  if (!question) return;
  if (view !== "chat") setView("chat");
  if (busy) {
    const result = await granka.queue(question, "followUp");
    if (!result.ok) return fail(result.error ?? "Очередь недоступна");
    addMessage("user", `${question}  · в очереди`);
    $("prompt").value = "";
    autoGrow();
    $("suggest").hidden = true;
    return;
  }
  streamText = "";
  streamWrapper = null;
  streamBody = null;
  queued = 0;
  setBusy(true);
  syncQueueBadge();
  log.querySelector(".emptyState")?.remove();
  addMessage("user", question);
  log.scrollTop = log.scrollHeight;
  $("prompt").value = "";
  autoGrow();
  $("suggest").hidden = true;
  $("composerHint").hidden = true;
  setStatus("думаю…");
  try {
    const sent = attachments.map((item) => ({ path: item.path, name: item.name, kind: item.kind, bytes: item.bytes }));
  const result = await granka.ask(question, sent);
  if (sent.length) {
    attachments = [];
    renderAttachments();
  }
    if (!result.ok) {
      const target = streamWrapper ?? addMessage("assistant", "").wrapper;
      attachError(target, result.error);
      setStatus("");
    } else {
      if (!streamWrapper) {
        const created = addMessage("assistant", result.text);
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
  } catch (err) {
    const target = streamWrapper ?? addMessage("assistant", "").wrapper;
    attachError(target, String(err?.message ?? err));
  } finally {
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

$("prompt").addEventListener("input", () => {
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
      applySuggest(suggestRows()[Math.max(suggestIndex, 0)].querySelector("b").textContent);
      return;
    }
    if (event.key === "Escape") {
      box.hidden = true;
      return;
    }
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

$("runBtn").addEventListener("click", () => setStatus(queued ? `в очереди: ${queued}` : "агент работает"));

// --- session actions -------------------------------------------------------

async function newChat() {
  if (busy) return fail("Дождитесь ответа или нажмите «Стоп»");
  await granka.newSession();
  currentSessionId = "";
  currentProjectId = activeProjectId;
  setView("chat");
  showEmptyState();
  showContext(null);
  await refreshSessions();
  $("prompt").focus();
}

$("newChat").addEventListener("click", newChat);

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
  explainer.className = "explainer";
  explainer.innerHTML = `
    <div class="explainerRow">
      <b>Проектный AGENTS.md</b>
      <span>Файл <code>AGENTS.md</code> в папке проекта. Действует только здесь: как собирать и тестировать, какие конвенции соблюдать, что нельзя трогать. Если файл уже есть — подгружается автоматически.</span>
    </div>
    <div class="explainerRow">
      <b>Глобальный AGENTS.md</b>
      <span>Файл <code>~/.granka/AGENTS.md</code> на вкладке «Правила». Действует во всех проектах: язык, стиль ответов, постоянные предпочтения и запреты.</span>
    </div>
    <div class="explainerRow">
      <b>Чем отличаются</b>
      <span>Глобальный — про вас и ваш стиль работы, он одинаков везде. Проектный — про конкретную папку и её правила. При конфликте побеждает проектный: он ближе к задаче.</span>
    </div>
    <div class="explainerRow">
      <b>Как это работает</b>
      <span>При старте сессии собирается промпт: системный промпт → глобальный AGENTS.md → проектный AGENTS.md, а выбранная папка становится рабочей для инструментов.</span>
    </div>`;
  pane.append(explainer);

  // the header button deletes the project the pane is showing
  const deleteTop = $("deleteProjectTop");
  deleteTop.hidden = !project;
  deleteTop.onclick = () => project && deleteProjectWithConfirm(project);

  const name = document.createElement("input");
  name.className = "textInput";
  name.id = "projectNameInput";
  name.placeholder = "Имя проекта";
  name.value = project?.name ?? "";

  const cwdInput = document.createElement("input");
  cwdInput.className = "textInput";
  cwdInput.placeholder = "~";
  cwdInput.value = project?.cwd ?? (project ? "" : config.cwd || "");
  const pick = document.createElement("button");
  pick.className = "ghostBtn";
  pick.textContent = "Выбрать…";
  pick.addEventListener("click", async () => {
    const dir = await granka.pickDir();
    if (dir) cwdInput.value = dir;
  });
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

  const rulesHint = document.createElement("div");
  rulesHint.className = "hint";
  rulesHint.id = "projectRulesHint";
  rulesHint.textContent = rules.exists
    ? `Загружен из ${rules.path}`
    : project?.cwd
      ? `Будет создан: ${project.cwd.replace(/[\\/]$/, "")}/AGENTS.md`
      : "У проекта нет папки — правила сохранятся в ~/.granka/granka.json";

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
    else await buildProjectPane();
    toast(project ? "Проект сохранён" : "Проект создан");
  });

  if (project) {
    const remove = document.createElement("button");
    remove.className = "ghostBtn danger";
    remove.textContent = "Удалить проект";
    remove.addEventListener("click", () => deleteProjectWithConfirm(project));
    saveProject.after(remove);
  }

  pane.append(
    labeled("Название проекта", name),
    labeled("Рабочая папка", cwdRow),
    labeled("Проектный AGENTS.md", instructions),
    rulesHint,
    labeled("Модель проекта", profileModel.element),
    labeled("Уровень мышления", profileThinking.element),
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
$("segmentMemory").addEventListener("click", () => setView("memory"));

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
        onSelect: async () => {
          if (busy) return fail("Дождитесь ответа, прежде чем сжимать контекст");
          startCompactionBar();
          compactTimer = setTimeout(stopCompactionBar, 120000);
          const result = await granka.compact();
          stopCompactionBar();
          if (!result.ok) return fail(result.error);
          showContext(result.context);
          addDivider("контекст сжат");
        },
      }),
      popoverItem("Настройки…", { icon: "settings-2", onSelect: () => granka.openSettings() }),
    );
  });
});

$("modelPopup").addEventListener("click", openModelPopover);
$("thinkingPopup").addEventListener("click", openThinkingPopover);

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
  if (next.theme !== config.theme || next.cwd !== config.cwd || next.apiKey !== config.apiKey) {
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
    $("onboardingKey").value = config.apiKey ?? "";
    showOnboardingStep(1);
  }
})();
