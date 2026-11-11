const $ = (id) => document.getElementById(id);
const DARK_MEDIA = window.matchMedia("(prefers-color-scheme: dark)");
const themesLib = globalThis.grankaThemes;

let config = {};
let models = [];
let modelValue = "";
let systemAccent = "";

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
  document.documentElement.style.setProperty("--font", FONT_STACKS[config.uiFont] ?? FONT_STACKS.system);
  document.documentElement.style.setProperty("--mono", MONO_STACKS[config.codeFont] ?? MONO_STACKS.system);
}

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
  "accentSystem",
  "debugTools",
  "cacheRetentionLong",
];

// --- theme ---------------------------------------------------------------

function chevron(text2) {
  return `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='${encodeURIComponent(text2)}' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='m6 9 6 6 6-6'/></svg>")`;
}

function applyTheme() {
  const id = themesLib.resolveThemeId(config.theme, DARK_MEDIA.matches);
  const { mode, tokens } = themesLib.themeVars(id, config.accentSystem === false ? "" : systemAccent);
  document.body.dataset.theme = mode;
  for (const [name, value] of Object.entries(tokens)) {
    const cssName = name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    document.documentElement.style.setProperty(`--${cssName}`, value);
  }
  document.documentElement.style.setProperty("--chevron-img", chevron(tokens.text2));
}

const LEGACY_THEME = { system: "auto", dark: "granka-dark", light: "granka-light" };
let themeSelect = null;
let fontSizeSelect = null;

function buildThemeDropdown() {
  const groups = themesLib.THEME_GROUPS.map((group) => ({
    label: group.label,
    options: group.ids.map((id) => ({ value: id, label: themesLib.THEMES[id].name })),
  }));
  themeSelect = window.grankaSelect.create({
    ariaLabel: "Тема",
    options: [{ value: "auto", label: "Как в системе" }],
    groups,
    value: LEGACY_THEME[config.theme] ?? config.theme ?? "auto",
    onChange: async (value) => {
      config.theme = value;
      applyTheme();
      await persist({ theme: value }, "Тема применена");
    },
  });
  $("themeSelect").replaceChildren(themeSelect.element);
}

function buildFontSizeDropdown() {
  fontSizeSelect = window.grankaSelect.create({
    ariaLabel: "Размер текста",
    options: [
      { value: "s", label: "Мельче" },
      { value: "m", label: "Обычный" },
      { value: "l", label: "Крупнее" },
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

async function persist(patch, message) {
  const result = await window.granka.saveConfig(patch);
  if (!result.ok) {
    $("status").textContent = result.error;
    return false;
  }
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

async function saveKey(silent = true) {
  const value = $("apiKey").value.trim();
  if (value === (config.apiKey ?? "")) return;
  const ok = await persist({ apiKey: value }, silent ? "" : "Ключ сохранён");
  $("keyStatus").textContent = ok
    ? value
      ? "Ключ сохранён ✓"
      : "Ключ удалён"
    : "Не удалось сохранить ключ";
}

$("apiKey").addEventListener("input", () => {
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
  const parts = ["Ключ работает ✓"];
  if (result.freeTier) parts.push("бесплатный тариф");
  if (result.limit) parts.push(`лимит $${result.limit}`);
  if (result.usage != null) parts.push(`использовано $${Number(result.usage).toFixed(2)}`);
  $("keyStatus").textContent = parts.join(" · ");
});

$("pickDir").addEventListener("click", async () => {
  const dir = await window.granka.pickDir();
  if (dir) $("cwd").value = dir;
});

// --- form ----------------------------------------------------------------

function buildFontDropdowns() {
  const ui = window.grankaSelect.create({
    ariaLabel: "Шрифт интерфейса",
    options: [
      { value: "system", label: "Системный" },
      { value: "inter", label: "Inter (в комплекте)" },
      { value: "serif", label: "Georgia (серифный)" },
      { value: "rounded", label: "Rounded" },
    ],
    value: config.uiFont ?? "system",
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
      { value: "system", label: "Системный моно" },
      { value: "jetbrains", label: "JetBrains Mono (в комплекте)" },
      { value: "serif", label: "Courier / Georgia" },
    ],
    value: config.codeFont ?? "system",
    onChange: async (value) => {
      config.codeFont = value;
      applyFonts();
      await persist({ codeFont: value }, "Шрифт кода применён");
    },
  });
  $("codeFontSelect").replaceChildren(code.element);
}

function buildDensityDropdown() {
  const density = window.grankaSelect.create({
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

function fillForm() {
  $("apiKey").value = config.apiKey ?? "";
  $("cwd").value = config.cwd ?? "";
  $("searxUrl").value = config.searxUrl ?? "";
  modelValue = config.model ?? "";
  buildThemeDropdown();
  buildFontSizeDropdown();
  buildFontDropdowns();
  buildDensityDropdown();
  renderSkills();
  applyFonts();
  for (const id of TOGGLES) $(id).checked = config[id] !== false;
  $("compactionEnabled").checked = config.compactionEnabled !== false;
  $("compactionReserve").value = String(config.compactionReserve ?? 16384);
  $("toolOutputLimit").value = String(config.toolOutputLimit ?? 4000);
  renderModels();
}

$("save").addEventListener("click", async () => {
  const patch = {
    apiKey: $("apiKey").value.trim(),
    model: modelValue,
    cwd: $("cwd").value.trim(),
    theme: config.theme ?? "auto",
    fontSize: config.fontSize ?? "m",
    searxUrl: $("searxUrl").value.trim(),
    compactionEnabled: $("compactionEnabled").checked,
    compactionReserve: Number($("compactionReserve").value) || 16384,
    toolOutputLimit: Number($("toolOutputLimit").value) || 4000,
  };
  for (const id of TOGGLES) patch[id] = $(id).checked;
  if (await persist(patch, "Сохранено")) {
    applyTheme();
    await window.granka.applyCompaction();
  }
});

// --- navigation ----------------------------------------------------------

for (const button of document.querySelectorAll(".navItem")) {
  button.addEventListener("click", () => {
    for (const item of document.querySelectorAll(".navItem")) {
      item.classList.toggle("isActive", item === button);
    }
    for (const pane of document.querySelectorAll(".settingsPane")) {
      pane.classList.toggle("isActive", pane.dataset.pane === button.dataset.pane);
    }
  });
}

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
  $("toolOutputLimit").value = String(config.toolOutputLimit ?? 4000);
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
  models = await window.granka.listModels();
  renderModels();
  renderSubagents();
})();
