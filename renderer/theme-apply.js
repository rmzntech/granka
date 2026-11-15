// Shared theme/font application for the main and settings windows.
// Loaded after themes.js, before app.js/settings.js. Both windows keep a
// thin applyTheme() wrapper that passes their own media query + config.
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
  const code = codeChoice && codeChoice !== "theme" && codeChoice !== "system"
    ? MONO_STACKS[codeChoice] ?? MONO_STACKS.system
    : themeMono || MONO_STACKS.system;
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
  document.documentElement.style.setProperty("--text-3", `color-mix(in oklab, ${tokens.text} 38%, transparent)`);
  const size = config.fontSize ?? "m";
  const base = size === "l" ? 15 : size === "s" ? 12.5 : 13.5;
  const prose = config.density === "compact" ? base - 0.5 : base;
  document.documentElement.style.setProperty("--prose", `${prose}px`);
  document.documentElement.style.setProperty(
    "--chevron-img",
    `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='${encodeURIComponent(tokens.text2)}' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='m6 9 6 6 6-6'/></svg>")`,
  );
  document.body.classList.toggle("noUsage", config.showUsage === false);
  document.body.dataset.density = config.density === "compact" ? "compact" : "comfortable";
}
