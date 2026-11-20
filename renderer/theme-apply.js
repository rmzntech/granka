// Shared theme/font application for the main and settings windows.
// Loaded after themes.js, before app.js/settings.js. Both windows keep a
// thin applyTheme() wrapper that passes their own media query + config.
// Bundled faces (renderer/fonts, OFL) plus explicit system stacks. Themes
// ship one UI face each, so "из темы" and "Inter" used to be the same thing;
// the stacks below let the typeface be chosen independently of the palette.
const FONT_STACKS = {
  system: '"Granka Inter", sans-serif',
  inter: '"Granka Inter", sans-serif',
  "system-sans": 'system-ui, -apple-system, "Segoe UI", Roboto, Cantarell, "DejaVu Sans", sans-serif',
  "system-serif": 'Georgia, "Times New Roman", "DejaVu Serif", serif',
  "system-mono": 'ui-monospace, "SF Mono", Consolas, "DejaVu Sans Mono", monospace',
  mono: '"Granka Mono", monospace',
};
// Shared with the settings window: one list, one source of truth.
const FONT_CHOICES = [
  { value: "theme", label: "Из темы" },
  { value: "inter", label: "Inter (в комплекте)" },
  { value: "mono", label: "JetBrains Mono (в комплекте)" },
  { value: "system-sans", label: "Системный — без засечек" },
  { value: "system-serif", label: "Системный — с засечками" },
  { value: "system-mono", label: "Системный — моноширинный" },
];
globalThis.grankaFonts = { FONT_CHOICES, FONT_STACKS };
const MONO_STACKS = {
  system: '"Granka Mono", monospace',
  jetbrains: '"Granka Mono", monospace',
};

let themeFont = "";
let themeMono = "";

function applyFonts() {
  const uiChoice = config.uiFont ?? "theme";
  const ui = uiChoice && uiChoice !== "theme" && uiChoice !== "system"
    ? FONT_STACKS[uiChoice] ?? FONT_STACKS.system
    : uiChoice === "system" && !themeFont
      ? FONT_STACKS.system
      : themeFont || FONT_STACKS.system;
  const codeChoice = config.codeFont ?? "theme";
  // "Из темы" falls back to the bundled mono: themes rarely declare their
  // own, and the system stack dropped the shipped JetBrains Mono entirely.
  const code = codeChoice && codeChoice !== "theme" && codeChoice !== "system"
    ? MONO_STACKS[codeChoice] ?? MONO_STACKS.system
    : themeMono || MONO_STACKS.jetbrains;
  document.documentElement.style.setProperty("--font", ui);
  document.documentElement.style.setProperty("--mono", code);
}

let themeSwapStyle = null;

function withoutTransitions(mutate) {
  if (!themeSwapStyle) {
    themeSwapStyle = document.createElement("style");
    themeSwapStyle.textContent = "*,*::before,*::after{transition:none !important}";
  }
  document.head.append(themeSwapStyle);
  mutate();
  void document.body.offsetHeight;
  requestAnimationFrame(() => themeSwapStyle?.remove());
}

let wallpaperPath = "";
let wallpaperLayer = null;

function ensureWallpaperLayer() {
  if (wallpaperLayer) return wallpaperLayer;
  wallpaperLayer = document.createElement("div");
  wallpaperLayer.id = "wallpaper";
  wallpaperLayer.setAttribute("aria-hidden", "true");
  const img = document.createElement("div");
  img.className = "wpImage";
  const overlay = document.createElement("div");
  overlay.className = "wpOverlay";
  wallpaperLayer.append(img, overlay);
  document.body.prepend(wallpaperLayer);
  return wallpaperLayer;
}

async function applyWallpaper() {
  // The wallpaper belongs to the chat window only: the settings window
  // keeps a plain themed background.
  if (window.location.pathname.endsWith("settings.html")) {
    document.body.dataset.wallpaper = "off";
    if (wallpaperLayer) wallpaperLayer.hidden = true;
    return;
  }
  const target = config.backgroundImage ?? "";
  const layer = ensureWallpaperLayer();
  const img = layer.querySelector(".wpImage");
  const overlay = layer.querySelector(".wpOverlay");
  document.documentElement.style.setProperty("--bg-blur", `${Number(config.backgroundBlur ?? 0)}px`);
  document.documentElement.style.setProperty("--bg-dim", `${Number(config.backgroundDim ?? 35) / 100}`);
  document.documentElement.style.setProperty("--bg-noise", `${Number(config.backgroundNoise ?? 0) / 100}`);
  document.documentElement.style.setProperty("--bg-opacity", `${Number(config.backgroundOpacity ?? 100) / 100}`);
  document.documentElement.style.setProperty("--bg-fit", config.backgroundFit ?? "cover");
  if (!target) {
    layer.hidden = true;
    document.body.dataset.wallpaper = "off";
    wallpaperPath = "";
    return;
  }
  if (target !== wallpaperPath) {
    const result = await window.granka.wallpaperDataUrl(target);
    if (!result?.ok) {
      layer.hidden = true;
      document.body.dataset.wallpaper = "off";
      return;
    }
    img.style.backgroundImage = `url("${result.dataUrl}")`;
    wallpaperPath = target;
  }
  layer.hidden = false;
  document.body.dataset.wallpaper = "on";
}

function applyThemeShared(isDark, systemAccentValue) {
  const { THEMES, resolveThemeId, themeVars } = globalThis.grankaThemes;
  const id = resolveThemeId(config.theme, isDark);
  const { mode, tokens } = themeVars(id, config.accentSystem === false ? "" : systemAccentValue);
  document.body.dataset.theme = mode;
  document.body.dataset.themeId = id;
  themeFont = tokens.font ?? "";
  themeMono = tokens.mono ?? "";
  for (const [name, value] of Object.entries(tokens)) {
    if (name === "font" || name === "mono") continue;
    const cssName = name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    document.documentElement.style.setProperty(`--${cssName}`, value);
  }
  applyFonts();
  document.documentElement.style.setProperty("--text-2", tokens.text2);
  document.documentElement.style.setProperty("--fill-2", tokens.fill2);
  document.documentElement.style.setProperty("--row-active", tokens.rowActive);
  document.documentElement.style.setProperty("--text-3", tokens.text3Ink ?? tokens.text2);
  const size = config.fontSize ?? "m";
  const base = ({ s: 12.5, m: 14, l: 16, xl: 18, xxl: 21 })[size] ?? 14;
  const prose = config.density === "compact" ? base - 0.5 : base;
  document.documentElement.style.setProperty("--prose", `${prose}px`);
  document.documentElement.style.setProperty(
    "--chevron-img",
    `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='${encodeURIComponent(tokens.text2)}' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='m6 9 6 6 6-6'/></svg>")`,
  );
  applyWallpaper();
  document.body.classList.toggle("noUsage", config.showUsage === false);
  document.body.dataset.density = config.density === "compact" ? "compact" : "comfortable";
}
