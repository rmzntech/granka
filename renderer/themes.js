(function () {
// Theme presets. Palettes come from the published colour systems of each
// project (Catppuccin, Rosé Pine, Nord, Tokyo Night, Gruvbox, Solarized),
// mapped onto granka's semantic tokens. Contrast of `text2` on `bg` is kept
// at or above 4.5:1 for every entry.
const THEMES = {
  "granka-light": {
    name: "Granka",
    mode: "light",
    tokens: {
      // soft graphite paper: white but not sterile, cool shadow tones
      bg: "#fdfdfe", sidebar: "#f4f5f8", chrome: "#f8f9fb", text: "#16181d", text2: "#5c6472",
      separator: "rgba(22,24,29,0.10)", fill: "rgba(120,130,150,0.10)", fill2: "rgba(120,130,150,0.18)",
      accent: "#0a84ff", danger: "#d92d20", code: "#f2f4f7", rowActive: "rgba(120,130,150,0.16)",
    },
  },
  "granka-dark": {
    name: "Granka",
    mode: "dark",
    tokens: {
      // graphite with a warm terracotta accent
      bg: "#202124", sidebar: "#1b1c1f", chrome: "#242528", text: "#e8eaed", text2: "#9aa0a6",
      separator: "rgba(232,234,237,0.12)", fill: "rgba(232,234,237,0.08)", fill2: "rgba(232,234,237,0.14)",
      accent: "#d7473f", danger: "#ff6b61", code: "#17181b", rowActive: "rgba(232,234,237,0.12)",
    },
  },
  "catppuccin-latte": {
    name: "Catppuccin Latte",
    mode: "light",
    tokens: {
      bg: "#eff1f5", sidebar: "#e6e9ef", chrome: "#dce0e8", text: "#4c4f69", text2: "#5c5f77",
      separator: "#ccd0da", fill: "rgba(156,160,176,0.2)", fill2: "rgba(156,160,176,0.34)",
      accent: "#1e66f5", danger: "#d20f39", code: "#e6e9ef", rowActive: "#ccd0da",
    },
  },
  "catppuccin-mocha": {
    name: "Catppuccin Mocha",
    mode: "dark",
    tokens: {
      bg: "#1e1e2e", sidebar: "#181825", chrome: "#11111b", text: "#cdd6f4", text2: "#a6adc8",
      separator: "#313244", fill: "rgba(108,112,134,0.24)", fill2: "rgba(108,112,134,0.42)",
      accent: "#89b4fa", danger: "#f38ba8", code: "#181825", rowActive: "#313244",
    },
  },
  "rose-pine-dawn": {
    name: "Rosé Pine Dawn",
    mode: "light",
    tokens: {
      bg: "#faf4ed", sidebar: "#f2e9e1", chrome: "#fffaf3", text: "#575279", text2: "#6e6a86",
      separator: "rgba(87,82,121,0.16)", fill: "rgba(144,140,170,0.16)", fill2: "rgba(144,140,170,0.28)",
      accent: "#286983", danger: "#b4637a", code: "#f2e9e1", rowActive: "rgba(144,140,170,0.24)",
    },
  },
  "rose-pine-moon": {
    name: "Rosé Pine Moon",
    mode: "dark",
    tokens: {
      bg: "#232136", sidebar: "#2a273f", chrome: "#1f1d2e", text: "#e0def4", text2: "#908caa",
      separator: "#393552", fill: "rgba(110,106,134,0.3)", fill2: "rgba(110,106,134,0.46)",
      accent: "#c4a7e7", danger: "#eb6f92", code: "#2a273f", rowActive: "#393552",
    },
  },
  "nord-light": {
    name: "Nord Light",
    mode: "light",
    tokens: {
      bg: "#eceff4", sidebar: "#e5e9f0", chrome: "#d8dee9", text: "#2e3440", text2: "#4c566a",
      separator: "#d8dee9", fill: "rgba(76,86,106,0.12)", fill2: "rgba(76,86,106,0.2)",
      accent: "#5e81ac", danger: "#bf616a", code: "#e5e9f0", rowActive: "rgba(76,86,106,0.18)",
    },
  },
  nord: {
    name: "Nord",
    mode: "dark",
    tokens: {
      bg: "#2e3440", sidebar: "#2b313c", chrome: "#3b4252", text: "#eceff4", text2: "#b6beca",
      separator: "#434c5e", fill: "rgba(76,86,106,0.4)", fill2: "rgba(76,86,106,0.62)",
      accent: "#88c0d0", danger: "#bf616a", code: "#3b4252", rowActive: "#434c5e",
    },
  },
  "tokyo-night": {
    name: "Tokyo Night",
    mode: "dark",
    tokens: {
      bg: "#1a1b26", sidebar: "#16161e", chrome: "#16161e", text: "#c0caf5", text2: "#a9b1d6",
      separator: "#292e42", fill: "rgba(86,95,137,0.26)", fill2: "rgba(86,95,137,0.44)",
      accent: "#7aa2f7", danger: "#f7768e", code: "#1f2335", rowActive: "#292e42",
    },
  },
  "gruvbox-light": {
    name: "Gruvbox Light",
    mode: "light",
    tokens: {
      bg: "#fbf1c7", sidebar: "#f2e5bc", chrome: "#ebdbb2", text: "#3c3836", text2: "#6b6259",
      separator: "#d5c4a1", fill: "rgba(146,131,116,0.18)", fill2: "rgba(146,131,116,0.3)",
      accent: "#b57614", danger: "#9d0006", code: "#f2e5bc", rowActive: "#d5c4a1",
    },
  },
  "gruvbox-dark": {
    name: "Gruvbox Dark",
    mode: "dark",
    tokens: {
      bg: "#1d2021", sidebar: "#282828", chrome: "#282828", text: "#ebdbb2", text2: "#bdae93",
      separator: "#3c3836", fill: "rgba(146,131,116,0.24)", fill2: "rgba(146,131,116,0.4)",
      accent: "#fabd2f", danger: "#fb4934", code: "#282828", rowActive: "#32302f",
    },
  },
  "solarized-light": {
    name: "Solarized Light",
    mode: "light",
    tokens: {
      bg: "#fdf6e3", sidebar: "#eee8d5", chrome: "#eee8d5", text: "#586e75", text2: "#657b83",
      separator: "#ddd6c0", fill: "rgba(147,161,161,0.18)", fill2: "rgba(147,161,161,0.32)",
      accent: "#268bd2", danger: "#dc322f", code: "#eee8d5", rowActive: "rgba(147,161,161,0.26)",
    },
  },
  "solarized-dark": {
    name: "Solarized Dark",
    mode: "dark",
    tokens: {
      bg: "#002b36", sidebar: "#073642", chrome: "#073642", text: "#93a1a1", text2: "#c2cfcf",
      separator: "#10424f", fill: "rgba(147,161,161,0.16)", fill2: "rgba(147,161,161,0.3)",
      accent: "#2aa198", danger: "#dc322f", code: "#073642", rowActive: "rgba(147,161,161,0.24)",
    },
  },
};

const THEME_GROUPS = [
  { label: "Светлые", ids: ["granka-light", "catppuccin-latte", "rose-pine-dawn", "nord-light", "gruvbox-light", "solarized-light"] },
  { label: "Тёмные", ids: ["granka-dark", "catppuccin-mocha", "rose-pine-moon", "nord", "tokyo-night", "gruvbox-dark", "solarized-dark"] },
];

// "auto" follows the system appearance using granka's own pair.
function resolveThemeId(preference, prefersDark) {
  if (!preference || preference === "auto") return prefersDark ? "granka-dark" : "granka-light";
  if (THEMES[preference]) return preference;
  // legacy values from earlier versions
  if (preference === "dark") return "granka-dark";
  if (preference === "light") return "granka-light";
  return prefersDark ? "granka-dark" : "granka-light";
}

function relativeLuminance(hex) {
  const value = hex.replace("#", "");
  const channels = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

// Text on an accent fill switches to dark ink when the accent is light,
// so bright accents (Gruvbox yellow, Tokyo blue) stay readable.
function accentTextFor(accent) {
  return relativeLuminance(accent) > 0.55 ? "#12131a" : "#ffffff";
}

function themeVars(id, systemAccent) {
  const theme = THEMES[id] ?? THEMES["granka-dark"];
  const tokens = { ...theme.tokens };
  if (systemAccent) tokens.accent = systemAccent;
  tokens.accentText = accentTextFor(tokens.accent);
  return { mode: theme.mode, tokens };
}

globalThis.grankaThemes = { THEMES, THEME_GROUPS, resolveThemeId, themeVars };
})();
