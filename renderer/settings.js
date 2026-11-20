const $ = (id) => document.getElementById(id);
const DARK_MEDIA = window.matchMedia("(prefers-color-scheme: dark)");
const themesLib = globalThis.grankaThemes;

let config = {};
let models = [];
let modelValue = "";
let systemAccent = "";
let mcpStatuses = {};

const TOGGLES = [
  "continueLast",
  "sendOnEnter",
  "autoScroll",
  "showUsage",
  "osNotifications",
  "toolTodo",
  "toolAsk",
  "toolWeb",
  "toolSubagents",
  "toolGit",
  "planMode",
  "accentSystem",
  "debugTools",
  "cacheRetentionLong",
  "mcpEnabled",
  "memoryEnabled",
];

// --- theme ---------------------------------------------------------------

function applyTheme() {
  withoutTransitions(() => applyThemeShared(DARK_MEDIA.matches, systemAccent));
}

const LEGACY_THEME = { system: "auto", dark: "granka-dark", light: "granka-light" };
let themeSelect = null;
let fontSizeSelect = null;

function svgCheck() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#i-check");
  svg.append(use);
  return svg;
}

function buildThemeCards() {
  const root = $("themeCards");
  root.replaceChildren();
  const current = LEGACY_THEME[config.theme] ?? config.theme ?? "auto";

  const cardStyle = (card, previewId) => {
    const { tokens } = themesLib.themeVars(previewId, "");
    card.querySelector(".themeSwatch").style.backgroundColor = tokens.bg;
    card.querySelector(".themeSwatch").style.color = tokens.text;
    card.querySelector(".themeSwatch").style.borderColor = tokens.separator;
    card.querySelector(".themeAccent").style.backgroundColor = tokens.accent;
    card.querySelector(".themeCode").style.backgroundColor = tokens.code;
    card.querySelector(".themeCode").style.color = tokens.text2;
    if (tokens.font) card.querySelector(".themeSample").style.fontFamily = tokens.font;
  };

  const makeCard = (id, label, mode) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "themeCard";
    card.dataset.themeId = id;
    const swatch = document.createElement("span");
    swatch.className = "themeSwatch";
    const sample = document.createElement("span");
    sample.className = "themeSample";
    sample.textContent = "Aa";
    const accent = document.createElement("span");
    accent.className = "themeAccent";
    const code = document.createElement("span");
    code.className = "themeCode";
    code.textContent = "code";
    swatch.append(sample, accent, code);
    const name = document.createElement("span");
    name.className = "themeName";
    name.textContent = label;
    const check = document.createElement("span");
    check.className = "themeCheck";
    check.append(svgCheck());
    card.append(swatch, name, check);
    card.setAttribute("aria-pressed", String(current === id));
    card.querySelector(".themeSwatch").style.backgroundColor = mode === "dark" ? "#1a1a1a" : "#ffffff";
    card.addEventListener("click", async () => {
      config.theme = id;
      applyTheme();
      await persist({ theme: id }, "Тема применена");
      buildThemeCards();
    });
    return card;
  };

  // "System" card: follows the OS appearance with granka's own pair.
  const resolved = document.body.dataset.theme === "dark" ? "granka-dark" : "granka-light";
  const autoCard = makeCard("auto", "Как в системе", document.body.dataset.theme === "dark" ? "dark" : "light");
  autoCard.dataset.previewId = resolved;
  cardStyle(autoCard, resolved);
  const autoGroup = document.createElement("div");
  autoGroup.className = "themeGroup";
  autoGroup.append(autoCard);
  root.append(autoGroup);

  for (const group of themesLib.THEME_GROUPS) {
    const heading = document.createElement("h3");
    heading.className = "themeGroupTitle";
    heading.textContent = group.label;
    const grid = document.createElement("div");
    grid.className = "themeGrid";
    for (const id of group.ids) {
      const theme = themesLib.THEMES[id];
      const card = makeCard(id, theme.name, theme.mode);
      cardStyle(card, id);
      grid.append(card);
    }
    root.append(heading, grid);
  }
}

function buildFontSizeDropdown() {
  fontSizeSelect = window.grankaSelect.create({
    ariaLabel: "Размер текста",
    options: [
      { value: "s", label: "Мельче" },
      { value: "m", label: "Обычный" },
      { value: "l", label: "Крупнее" },
      { value: "xl", label: "Очень крупный" },
      { value: "xxl", label: "Максимальный" },
    ],
    value: config.fontSize ?? "m",
    onChange: async (value) => {
      config.fontSize = value;
      await persist({ fontSize: value }, "Размер текста применён");
    },
  });
  $("fontSizeSelect").replaceChildren(fontSizeSelect.element);
}

// --- persistence ---------------------------------------------------------

// Saves are queued: rapid keystrokes fire overlapping persist() calls and,
// without a queue, a slower earlier save can land after a later one and
// overwrite the fresh value with a stale one.
let persistQueue = Promise.resolve();

function persist(patch, message) {
  const run = persistQueue.then(() => persistNow(patch, message));
  persistQueue = run.catch(() => {});
  return run;
}

async function persistNow(patch, message) {
  const result = await window.granka.saveConfig(patch);
  if (!result.ok) {
    $("status").textContent = result.error;
    $("status").classList.add("isError");
    return false;
  }
  if (!$("status").classList.contains("isError")) $("status").textContent = message ?? "";
  config = await window.granka.loadConfig();
  if (message) {
    $("status").textContent = message;
    setTimeout(() => {
      if ($("status").textContent === message) $("status").textContent = "";
    }, 1800);
  }
  return true;
}

// appearance dropdowns persist immediately and broadcast to every window

$("planMode").addEventListener("change", async () => {
  const plan = $("planMode").checked;
  config.planMode = plan;
  config.agentMode = plan ? "plan" : "chat";
  await persist({ planMode: plan, agentMode: config.agentMode }, plan ? "Режим плана включён" : "Режим плана выключен");
  buildAgentModeDropdown();
});

$("accentSystem").addEventListener("change", async () => {
  config.accentSystem = $("accentSystem").checked;
  applyTheme();
  await persist({ accentSystem: config.accentSystem }, "Сохранено");
});

// --- models --------------------------------------------------------------

function renderModels() {
  const favorites = config.favorites ?? [];
  globalThis.grankaModels.renderModelRows($("modelRows"), {
    models,
    favorites,
    current: modelValue,
    query: $("modelFilter").value,
    limit: 60,
    onSelect: (id) => {
      modelValue = id;
      renderModels();
      persist({ model: id }, "Модель выбрана");
    },
    onToggleFavorite: async (id) => {
      const next = new Set(config.favorites ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      if (await persist({ favorites: [...next] }, "Избранное обновлено")) renderModels();
    },
  });
  const model = models.find((item) => item.id === modelValue);
  $("starBtn").textContent = favorites.includes(modelValue) ? "Убрать из избранного" : "В избранное";
  $("modelMeta").textContent = model
    ? `$${model.cost?.input ?? "?"}/$${model.cost?.output ?? "?"} за 1M · ${Math.round(model.context / 1000)}K контекст`
    : "";
}

$("modelFilter").addEventListener("input", renderModels);
$("starBtn").addEventListener("click", async () => {
  const favorites = new Set(config.favorites ?? []);
  if (favorites.has(modelValue)) favorites.delete(modelValue);
  else favorites.add(modelValue);
  if (await persist({ favorites: [...favorites] }, "Избранное обновлено")) renderModels();
});
let keyTimer = null;

let keyDirty = false;
async function saveKey(silent = true) {
  const value = $("apiKey").value.trim();
  // The key itself never reaches the renderer (masked on load): an untouched
  // empty field means "keep the stored key", not "delete it".
  if (!value && config.hasApiKey && !keyDirty) return;
  if (!value && !config.hasApiKey) return;
  const ok = await persist({ apiKey: value }, silent ? "" : "Ключ сохранён");
  $("keyStatus").textContent = ok
    ? value
      ? "Ключ сохранён"
      : "Ключ удалён"
    : "Ключ не сохранён. Проверьте подключение и повторите";
}

$("apiKey").addEventListener("input", () => {
  keyDirty = true;
  clearTimeout(keyTimer);
  $("keyStatus").textContent = "Сохраняю…";
  keyTimer = setTimeout(() => saveKey(true), 600);
});
$("apiKey").addEventListener("blur", () => saveKey(true));

$("checkKey").addEventListener("click", async () => {
  $("keyStatus").textContent = "Проверяю ключ…";
  await saveKey(true);
  const result = await window.granka.checkKey();
  if (!result.ok) {
    $("keyStatus").textContent = `Ключ не работает: ${result.error}`;
    return;
  }
  const parts = ["Ключ работает"];
  if (result.freeTier) parts.push("бесплатный тариф");
  if (result.limit) parts.push(`лимит $${result.limit}`);
  if (result.usage != null) parts.push(`использовано $${Number(result.usage).toFixed(2)}`);
  $("keyStatus").textContent = parts.join(" · ");
});

$("bgPick").addEventListener("click", async () => {
  const picked = await window.granka.pickImage();
  if (picked) {
    $("bgImagePath").value = picked;
    config.backgroundImage = picked;
    await persist({ backgroundImage: picked }, "Фон выбран");
    refreshBgPreview();
  }
});
$("bgClear").addEventListener("click", async () => {
  $("bgImagePath").value = "";
  config.backgroundImage = "";
  await persist({ backgroundImage: "" }, "Фон убран");
  refreshBgPreview();
});

$("pickDir").addEventListener("click", async () => {
  const dir = await window.granka.pickDir();
  if (dir) $("cwd").value = dir;
});

// --- form ----------------------------------------------------------------

function buildFontDropdowns() {
  const ui = window.grankaSelect.create({
    ariaLabel: "Шрифт интерфейса",
    // The typeface is independent of the theme: any stack can be paired with
    // any palette (see grankaFonts in theme-apply.js).
    options: globalThis.grankaFonts?.FONT_CHOICES ?? [{ value: "theme", label: "Из темы" }],
    value: config.uiFont ?? "theme",
    onChange: async (value) => {
      config.uiFont = value;
      applyFonts();
      await persist({ uiFont: value }, "Шрифт интерфейса применён");
    },
  });
  $("uiFontSelect").replaceChildren(ui.element);

  const code = window.grankaSelect.create({
    ariaLabel: "Шрифт кода",
    options: [
      { value: "theme", label: "Из темы" },
      { value: "jetbrains", label: "JetBrains Mono (в комплекте)" },
    ],
    value: config.codeFont ?? "theme",
    onChange: async (value) => {
      config.codeFont = value;
      applyFonts();
      await persist({ codeFont: value }, "Шрифт кода применён");
    },
  });
  $("codeFontSelect").replaceChildren(code.element);
}

function buildDensityDropdown() {
  const density = window.grankaSelect.createSegment({
    ariaLabel: "Плотность интерфейса",
    options: [
      { value: "comfortable", label: "Обычная" },
      { value: "compact", label: "Компактная" },
    ],
    value: config.density ?? "comfortable",
    onChange: async (value) => {
      config.density = value;
      document.body.dataset.density = value === "compact" ? "compact" : "comfortable";
      await persist({ density: value }, "Плотность применена");
    },
  });
  $("densitySelect").replaceChildren(density.element);
}

function buildThinkingDisplayDropdown() {
  const thinking = window.grankaSelect.createSegment({
    ariaLabel: "Мышление модели в чате",
    options: [
      { value: "off", label: "Скрывать" },
      { value: "live", label: "Вживую, свернуть" },
      { value: "always", label: "Держать открытым" },
    ],
    value: ["off", "live", "always"].includes(config.thinkingDisplay) ? config.thinkingDisplay : "off",
    onChange: async (value) => {
      config.thinkingDisplay = value;
      await persist({ thinkingDisplay: value }, "Настройка мышления применена");
    },
  });
  $("thinkingDisplaySelect").replaceChildren(thinking.element);
}

function buildToolDisplayDropdown() {
  const tool = window.grankaSelect.createSegment({
    ariaLabel: "Вызовы инструментов в чате",
    options: [
      { value: "off", label: "Скрывать полностью" },
      { value: "live", label: "Свёрнуто, раскрывается" },
      { value: "always", label: "Показывать всегда" },
    ],
    value: ["off", "live", "always"].includes(config.toolDisplay) ? config.toolDisplay : "live",
    onChange: async (value) => {
      config.toolDisplay = value;
      await persist({ toolDisplay: value }, "Настройка инструментов применена");
    },
  });
  $("toolDisplaySelect").replaceChildren(tool.element);
}

function buildAgentModeDropdown() {
  const mode = window.grankaSelect.createSegment({
    ariaLabel: "Режим работы агента",
    options: [
      { value: "chat", label: "Чат" },
      { value: "plan", label: "План" },
      { value: "auto", label: "Авто" },
      { value: "debug", label: "Дебаг" },
    ],
    value: ["chat", "plan", "auto", "debug"].includes(config.agentMode) ? config.agentMode : "chat",
    onChange: async (value) => {
      config.agentMode = value;
      config.planMode = value === "plan";
      $("planMode").checked = config.planMode;
      await persist({ agentMode: value, planMode: config.planMode }, "Режим работы применён");
    },
  });
  $("agentModeSelect").replaceChildren(mode.element);
}

function buildConfirmBashWriteDropdown() {
  const select = window.grankaSelect.create({
    ariaLabel: "Подтверждение записи и команд",
    options: [
      { value: "ask", label: "Спрашивать" },
      { value: "allow", label: "Всегда разрешать" },
    ],
    value: config.confirmBashWrite === "allow" ? "allow" : "ask",
    onChange: async (value) => {
      config.confirmBashWrite = value;
      await persist({ confirmBashWrite: value }, "Настройка подтверждения применена");
    },
  });
  $("confirmBashWriteSelect").replaceChildren(select.element);
}

function buildPresetDropdown() {
  const preset = window.grankaSelect.createSegment({
    ariaLabel: "Пресет работы",
    options: [
      { value: "economy", label: "Эконом (мышление low)" },
      { value: "balance", label: "Баланс (мышление medium)" },
      { value: "max", label: "Максимум (мышление high)" },
    ],
    value: { low: "economy", minimal: "economy", off: "economy", medium: "balance", high: "max" }[config.thinkingLevel] ?? "balance",
    onChange: async (value) => {
      const level = { economy: "low", balance: "medium", max: "high" }[value];
      config.thinkingLevel = level;
      await persist({ thinkingLevel: level }, "Пресет применён");
    },
  });
  $("presetSelect").replaceChildren(preset.element);
}

async function renderSkills() {
  const list = $("skillsList");
  const skills = await window.granka.listSkills();
  $("skillsMeta").textContent = skills.length ? `${skills.length} установлено` : "пока нет";
  list.replaceChildren();
  if (!skills.length) {
    const empty = document.createElement("div");
    empty.className = "hint";
    empty.textContent = "Скиллов нет. Нажмите «Установить встроенные» — добавим 6 готовых.";
    list.append(empty);
    return;
  }
  for (const skill of skills) {
    const row = document.createElement("div");
    row.className = "skillRow";
    const main = document.createElement("div");
    main.className = "skillMain";
    const name = document.createElement("b");
    name.textContent = skill.name;
    if (skill.bundled) {
      const badge = document.createElement("span");
      badge.className = "skillBadge";
      badge.textContent = "встроенный";
      name.append(badge);
    }
    const desc = document.createElement("span");
    desc.textContent = skill.description;
    const path = document.createElement("code");
    path.textContent = skill.path;
    main.append(name, desc, path);
    const open = document.createElement("button");
    open.className = "ghostBtn";
    open.textContent = "Папка";
    open.addEventListener("click", () => window.granka.revealSkill(skill.path));
    const remove = document.createElement("button");
    remove.className = "ghostBtn danger";
    remove.textContent = "Удалить";
    remove.addEventListener("click", async () => {
      const ok = await window.granka.confirm(
        `Удалить скилл «${skill.name}»?`,
        "Папка скилла в ~/.granka/skills будет удалена без восстановления.",
        "Удалить скилл",
      );
      if (!ok) return;
      const result = await window.granka.deleteSkill(skill.folder);
      if (!result.ok) return;
      await renderSkills();
      $("status").textContent = `Удалён скилл ${skill.name}`;
    });
    row.append(main, open, remove);
    list.append(row);
  }
}

$("installSkills")?.addEventListener("click", async () => {
  const result = await window.granka.installSkills();
  await renderSkills();
  $("status").textContent = result.installed?.length
    ? `Установлено: ${result.installed.length}`
    : "Все встроенные скиллы уже на месте";
});

$("exportBackup")?.addEventListener("click", async () => {
  const result = await window.granka.exportBackup();
  $("backupMeta").textContent = result.ok ? `Сохранено файлов: ${result.files}` : result.error;
});
$("importBackup")?.addEventListener("click", async () => {
  const result = await window.granka.importBackup();
  $("backupMeta").textContent = result.ok ? `Восстановлено файлов: ${result.restored}. Перезапустите granka.` : result.error;
});

async function refreshBgPreview() {
  const path = $("bgImagePath").value.trim();
  const preview = $("bgPreview");
  if (!path) { preview.hidden = true; return; }
  const result = await window.granka.wallpaperDataUrl(path);
  if (result?.ok) {
    preview.querySelector(".bgPreviewImg").style.backgroundImage = `url("${result.dataUrl}")`;
    preview.hidden = false;
  } else {
    preview.hidden = true;
  }
}

function buildBgFitDropdown() {
  const fit = window.grankaSelect.create({
    ariaLabel: "Заполнение фона",
    options: [
      { value: "cover", label: "Заполнить (обрезать)" },
      { value: "contain", label: "Вписать целиком" },
      { value: "fill", label: "Растянуть" },
      { value: "auto", label: "Исходный размер" },
    ],
    value: config.backgroundFit ?? "cover",
    onChange: async (value) => {
      config.backgroundFit = value;
      await persist({ backgroundFit: value }, "Заполнение фона применено");
    },
  });
  $("bgFitSelect").replaceChildren(fit.element);
}

function fillForm() {
  // apiKey is masked by main (hasApiKey flag only): never prefill the field.
  $("apiKey").value = "";
  keyDirty = false;
  $("apiKey").placeholder = config.hasApiKey ? "Ключ задан — введите новый, чтобы заменить" : "sk-or-v1-…";
  $("cwd").value = config.cwd ?? "";
  $("searxUrl").value = config.searxUrl ?? "";
  modelValue = config.model ?? "";
  buildThemeCards();
  buildFontSizeDropdown();
  buildFontDropdowns();
  buildDensityDropdown();
  buildThinkingDisplayDropdown();
  buildToolDisplayDropdown();
  buildAgentModeDropdown();
  buildConfirmBashWriteDropdown();
  buildPresetDropdown();
  buildBgFitDropdown();
  $("bgImagePath").value = config.backgroundImage ?? "";
  $("bgBlur").value = String(config.backgroundBlur ?? 0);
  $("bgDim").value = String(config.backgroundDim ?? 35);
  $("bgNoise").value = String(config.backgroundNoise ?? 0);
  $("bgOpacity").value = String(config.backgroundOpacity ?? 100);
  for (const [id, key] of [["bgBlur", "backgroundBlur"], ["bgDim", "backgroundDim"], ["bgNoise", "backgroundNoise"], ["bgOpacity", "backgroundOpacity"]]) {
    $(`${id}Val`).textContent = String($(id).value);
    $(id).addEventListener("input", () => $(`${id}Val`).textContent = $(id).value);
    $(id).addEventListener("change", async () => {
      config[key] = Number($(id).value);
      await persist({ [key]: config[key] }, "Фон обновлён");
    });
  }
  refreshBgPreview();
  renderSkills();
  applyFonts();
  for (const id of TOGGLES) $(id).checked = config[id] !== false;
  $("compactionEnabled").checked = config.compactionEnabled !== false;
  $("compactionReserve").value = String(config.compactionReserve ?? 16384);
  $("compactionThreshold").value = String(config.compactionThreshold ?? 80);
  $("toolOutputLimit").value = String(config.toolOutputLimit ?? 16000);
  $("dailyBudget").value = String(config.dailyBudgetUsd ?? 0);
  $("afterEditHook").value = String(config.hooks?.afterEdit ?? "");
  $("bashAllowlist").value = Array.isArray(config.bashAllowlist) ? config.bashAllowlist.join(", ") : "";
  window.granka.getMemory?.().then((m) => {
    if (!m?.ok) return;
    const text = m.text ?? "";
    $("globalMemory").value = text;
    const lines = text ? text.split("\n").length : 0;
    const kb = Math.round(text.length / 1024);
    const hint = $("globalMemoryHint");
    if (hint) {
      hint.textContent = lines > 200 || text.length > 25 * 1024
        ? `~/.granka/MEMORY.md: ${lines} строк, ${kb} КБ — больше лимита загрузки (200 строк / 25 КБ), почистите память.`
        : `~/.granka/MEMORY.md: ${lines} строк, ${kb} КБ. Не смешивайте с правилами: протухшее удаляйте.`;
    }
  }).catch(() => {});
  $("mcpServers").value = config.mcpServers && Object.keys(config.mcpServers).length
    ? JSON.stringify(config.mcpServers, null, 2)
    : "";
  renderMcpServers();
  renderModels();
}

// MCP servers are edited as JSON; an invalid value must not silently drop
// the previous config — surface the parse error in the status line.
function parseMcpServers() {
  const raw = $("mcpServers").value.trim();
  if (!raw) return {};
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("ожидался объект");
    return data;
  } catch (err) {
    $("status").textContent = `MCP JSON: ${err.message}`;
    return config.mcpServers ?? {};
  }
}

$("save")?.addEventListener("click", async () => {
  const patch = {
    // Never overwrite the stored key with the masked (empty) field value.
    ...(keyDirty ? { apiKey: $("apiKey").value.trim() } : {}),
    model: modelValue,
    cwd: $("cwd").value.trim(),
    theme: config.theme ?? "auto",
    fontSize: config.fontSize ?? "m",
    searxUrl: $("searxUrl").value.trim(),
    compactionEnabled: $("compactionEnabled").checked,
    compactionReserve: Number($("compactionReserve").value) || 16384,
    compactionThreshold: Math.min(95, Math.max(50, Number($("compactionThreshold").value) || 80)),
    toolOutputLimit: Number($("toolOutputLimit").value) || 16000,
    dailyBudgetUsd: Number($("dailyBudget").value) || 0,
    hooks: { afterEdit: $("afterEditHook").value.trim() },
    bashAllowlist: $("bashAllowlist").value.split(",").map((v) => v.trim()).filter(Boolean),
    backgroundImage: $("bgImagePath").value.trim(),
    backgroundBlur: Number($("bgBlur").value) || 0,
    backgroundDim: Number($("bgDim").value) || 0,
    backgroundNoise: Number($("bgNoise").value) || 0,
    backgroundOpacity: Number($("bgOpacity").value) || 100,
    backgroundFit: config.backgroundFit ?? "cover",
    mcpServers: parseMcpServers(),
  };
  for (const id of TOGGLES) patch[id] = $(id).checked;
  const memoryResult = await window.granka.saveMemory?.($("globalMemory").value ?? "");
  if (memoryResult && memoryResult.ok === false) $("status").textContent = `Память: ${memoryResult.error}`;
  if (await persist(patch, "Сохранено")) {
    applyTheme();
    await window.granka.applyCompaction();
  }
});

// --- navigation ----------------------------------------------------------

for (const button of document.querySelectorAll(".navItem")) {
  button.addEventListener("click", () => activatePane(button.dataset.pane));
}

function activatePane(pane) {
  const activeItem = [...document.querySelectorAll(".navItem")].find((item) => item.dataset.pane === pane);
  if (activeItem) {
    document.title = `Настройки — ${activeItem.textContent.trim()}`;
    if (config.settingsPane !== pane) {
      config.settingsPane = pane;
      void window.granka.saveConfig({ settingsPane: pane }).catch(() => {});
    }
  }
  for (const item of document.querySelectorAll(".navItem")) {
    const active = item.dataset.pane === pane;
    item.classList.toggle("isActive", active);
    item.setAttribute("aria-selected", String(active));
    item.tabIndex = active ? 0 : -1;
  }
  for (const section of document.querySelectorAll(".settingsPane")) {
    section.classList.toggle("isActive", section.dataset.pane === pane);
    section.hidden = section.dataset.pane !== pane;
  }
  $("settingsPanes").scrollTop = 0;
  if (pane === "mcp") refreshMcpStatus();
}

document.querySelectorAll(".navItem").forEach((item, index, all) => {
  item.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const next = all[(index + (event.key === "ArrowDown" ? 1 : -1) + all.length) % all.length];
    activatePane(next.dataset.pane);
    next.focus();
  });
});

$("settingsSearch").addEventListener("input", () => {
  const query = $("settingsSearch").value.trim().toLowerCase();
  if (!query) {
    document.querySelectorAll(".settingsPane .field, .settingsPane .switchRow, .settingsSubhead").forEach((el) => { el.hidden = false; });
    return;
  }
  document.querySelectorAll(".settingsSubhead").forEach((el) => { el.hidden = false; });
  let firstPane = null;
  for (const pane of document.querySelectorAll(".settingsPane")) {
    let anyVisible = false;
    for (const el of pane.querySelectorAll(".field, .switchRow")) {
      const hit = el.textContent.toLowerCase().includes(query);
      el.hidden = !hit;
      if (hit) anyVisible = true;
    }
    if (anyVisible && !firstPane) firstPane = pane.dataset.pane;
  }
  if (firstPane) activatePane(firstPane);
  for (const heading of document.querySelectorAll(".settingsSubhead")) {
    let hasVisible = false;
    for (let el = heading.nextElementSibling; el && !el.classList.contains("settingsSubhead"); el = el.nextElementSibling) {
      if ((el.classList.contains("field") || el.classList.contains("switchRow")) && !el.hidden) { hasVisible = true; break; }
    }
    heading.hidden = !hasVisible;
  }
});

function parseServersForList() {
  try {
    const data = JSON.parse($("mcpServers").value.trim() || "{}");
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function mcpStatusLabel(value, disabled) {
  if (disabled || value === "off") return "выключен";
  if (value === "ok") return "подключён";
  if (typeof value === "string" && value.startsWith("error:")) return value;
  return "не запущен";
}

function renderMcpServers() {
  const list = $("mcpServerList");
  if (!list) return;
  const servers = parseServersForList();
  if (servers === null) {
    list.replaceChildren();
    $("mcpServerHint").textContent = "Исправьте JSON ниже, чтобы увидеть список серверов.";
    return;
  }
  const entries = Object.entries(servers).filter(([, spec]) => spec && typeof spec === "object");
  list.replaceChildren();
  if (!entries.length) {
    $("mcpServerHint").textContent = "Серверов нет — добавьте их в JSON ниже.";
    return;
  }
  for (const [name, spec] of entries) {
    const row = document.createElement("label");
    row.className = "switchRow";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !spec.disabled;
    input.setAttribute("aria-label", `Сервер ${name}`);
    input.addEventListener("change", () => {
      const current = parseServersForList();
      if (!current?.[name]) return;
      if (input.checked) delete current[name].disabled;
      else current[name].disabled = true;
      $("mcpServers").value = JSON.stringify(current, null, 2);
      renderMcpServers();
    });
    const text = document.createElement("span");
    text.className = "switchText";
    text.textContent = name;
    const status = document.createElement("small");
    status.textContent = mcpStatusLabel(mcpStatuses[name], spec.disabled);
    text.append(status);
    row.append(input, text);
    list.append(row);
  }
}

async function refreshMcpStatus() {
  try { mcpStatuses = (await window.granka.mcpStatus?.()) ?? {}; }
  catch { mcpStatuses = {}; }
  renderMcpServers();
}

$("mcpServers")?.addEventListener("input", renderMcpServers);
$("mcpRefresh")?.addEventListener("click", refreshMcpStatus);

$("mcpCheck").addEventListener("click", () => {
  const raw = $("mcpServers").value.trim();
  if (!raw) {
    $("mcpStatus").textContent = "Пусто — MCP выключен по сути";
    return;
  }
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("ожидался объект серверов");
    for (const [name, srv] of Object.entries(data)) {
      if (!srv || typeof srv.command !== "string" || !srv.command) {
        throw new Error(`сервер «${name}»: нет command`);
      }
    }
    $("mcpStatus").textContent = `JSON корректен: серверов ${Object.keys(data).length}`;
    $("mcpStatus").classList.remove("isError");
  } catch (err) {
    $("mcpStatus").textContent = `Ошибка: ${err.message}`;
  }
});

window.granka.onSettingsPane((pane) => {
  if (pane) activatePane(pane);
});

// --- window chrome -------------------------------------------------------

$("setWinMin").addEventListener("click", () => window.granka.windowMinimize());
$("setWinClose").addEventListener("click", () => window.granka.windowClose());
$("settingsTitlebar").addEventListener("dblclick", (event) => {
  if (!event.target.closest("button")) window.granka.windowToggleMaximize();
});

DARK_MEDIA.addEventListener("change", () => {
  if (!config.theme || config.theme === "auto") applyTheme();
});

window.granka.onConfigChanged((next) => {
  config = next;
  applyTheme();
  applyFonts();
  for (const id of TOGGLES) $(id).checked = config[id] !== false;
  $("compactionEnabled").checked = config.compactionEnabled !== false;
  $("compactionReserve").value = String(config.compactionReserve ?? 16384);
  $("compactionThreshold").value = String(config.compactionThreshold ?? 80);
  $("toolOutputLimit").value = String(config.toolOutputLimit ?? 16000);
});

$("openSubagentsDir")?.addEventListener("click", async () => {
  await window.granka.revealSubagentsDir();
});

async function renderSubagents() {
  const list = await window.granka.listSubagents();
  const container = $("subagentList");
  container.replaceChildren(
    ...list.map((agent) => {
      const row = document.createElement("div");
      row.className = "subagentRow";
      const name = document.createElement("b");
      name.textContent = `${agent.name} · ${agent.id}`;
      const desc = document.createElement("span");
      desc.textContent = agent.description;
      const tools = document.createElement("code");
      tools.textContent = agent.tools.join(", ");
      row.append(name, desc, tools);
      return row;
    }),
  );
}

(async () => {
  document.body.dataset.mac = String(window.granka.platform === "darwin");
  config = await window.granka.loadConfig();
  systemAccent = (await window.granka.accentColor()) || "";
  applyTheme();
  fillForm();
  const savedPane = config.settingsPane;
  if (savedPane && document.querySelector(`.navItem[data-pane="${savedPane}"]`)) activatePane(savedPane);
  try {
    const v = await window.granka.version();
    if (v) $("aboutVersionNum").textContent = `Версия ${v}`;
  } catch {}
  $("aboutLog").addEventListener("click", async () => {
    const paths = await window.granka.paths();
    await window.granka.revealPath(`${paths.agentDir}/logs/granka.log`);
  });
  $("aboutBackup").addEventListener("click", async () => {
    const result = await window.granka.exportBackup();
    $("backupMeta").textContent = result.ok ? `Сохранено файлов: ${result.files}` : result.error;
  });
  models = await window.granka.listModels();
  renderModels();
  renderSubagents();
})();
