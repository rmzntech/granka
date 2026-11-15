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
  // Brand palettes from getdesign.md design analyses. `design` overrides
  // geometry and type: radii, shadow, UI/mono font stacks.
  claude: {
    name: "Claude",
    mode: "light",
    tokens: {
      bg: "#faf9f5", sidebar: "#f5f0e8", chrome: "#f5f0e8", text: "#141413", text2: "#6c6a64",
      separator: "#e6dfd8", fill: "rgba(108,106,100,0.12)", fill2: "rgba(108,106,100,0.2)",
      accent: "#cc785c", danger: "#c64545", code: "#f5f0e8", rowActive: "rgba(204,120,92,0.16)",
    },
    design: { radiusXs: "4px", radiusSm: "6px", radiusMd: "8px", radiusCtl: "8px", radiusPill: "999px", fontUi: 'Georgia, "Times New Roman", serif' },
  },
  spotify: {
    name: "Spotify",
    mode: "dark",
    tokens: {
      bg: "#121212", sidebar: "#181818", chrome: "#1f1f1f", text: "#ffffff", text2: "#b3b3b3",
      separator: "rgba(255,255,255,0.12)", fill: "rgba(255,255,255,0.08)", fill2: "rgba(255,255,255,0.14)",
      accent: "#1ed760", danger: "#f3727f", code: "#181818", rowActive: "rgba(255,255,255,0.12)",
    },
    design: { radiusXs: "4px", radiusSm: "10px", radiusMd: "14px", radiusCtl: "9999px", radiusPill: "9999px", shadow: "0 8px 24px rgba(0,0,0,0.5)" },
  },
  nike: {
    name: "Nike",
    mode: "light",
    tokens: {
      bg: "#ffffff", sidebar: "#f5f5f5", chrome: "#f5f5f5", text: "#111111", text2: "#707072",
      separator: "#e5e5e5", fill: "rgba(17,17,17,0.08)", fill2: "rgba(17,17,17,0.14)",
      accent: "#111111", danger: "#d30005", code: "#f5f5f5", rowActive: "rgba(17,17,17,0.1)",
    },
    design: { radiusXs: "0px", radiusSm: "10px", radiusMd: "14px", radiusCtl: "9999px", radiusPill: "9999px", fontUi: 'Helvetica, Arial, system-ui, sans-serif' },
  },
  cursor: {
    name: "Cursor",
    mode: "light",
    tokens: {
      bg: "#f7f7f4", sidebar: "#fafaf7", chrome: "#fafaf7", text: "#26251e", text2: "#6f6c61",
      separator: "#e6e5e0", fill: "rgba(38,37,30,0.08)", fill2: "rgba(38,37,30,0.14)",
      accent: "#f54e00", danger: "#cf2d56", code: "#ffffff", rowActive: "rgba(245,78,0,0.12)",
    },
    design: { radiusXs: "4px", radiusSm: "6px", radiusMd: "8px", radiusCtl: "6px", radiusPill: "999px", shadow: "none" },
  },
  discord: {
    name: "Discord",
    mode: "dark",
    tokens: {
      bg: "#0a0d3a", sidebar: "#1e2353", chrome: "#151a4a", text: "#ffffff", text2: "#b5bac1",
      separator: "rgba(255,255,255,0.14)", fill: "rgba(255,255,255,0.08)", fill2: "rgba(255,255,255,0.14)",
      accent: "#5865f2", danger: "#ed4245", code: "#10122e", rowActive: "rgba(88,101,242,0.2)",
    },
    design: { radiusXs: "6px", radiusSm: "12px", radiusMd: "14px", radiusCtl: "12px", radiusPill: "50px" },
  },
  ibm: {
    name: "IBM Carbon",
    mode: "light",
    tokens: {
      bg: "#ffffff", sidebar: "#f4f4f4", chrome: "#f4f4f4", text: "#161616", text2: "#525252",
      separator: "#e0e0e0", fill: "rgba(22,22,22,0.08)", fill2: "rgba(22,22,22,0.14)",
      accent: "#0f62fe", danger: "#da1e28", code: "#f4f4f4", rowActive: "rgba(15,98,254,0.12)",
    },
    design: { radiusXs: "0px", radiusSm: "0px", radiusMd: "2px", radiusCtl: "0px", radiusPill: "0px", shadow: "none", fontUi: '"IBM Plex Sans", system-ui, sans-serif' },
  },
  opencode: {
    name: "OpenCode",
    mode: "light",
    tokens: {
      bg: "#fdfcfc", sidebar: "#f8f7f7", chrome: "#f1eeee", text: "#201d1d", text2: "#646262",
      separator: "rgba(15,0,0,0.12)", fill: "rgba(32,29,29,0.08)", fill2: "rgba(32,29,29,0.14)",
      accent: "#007aff", danger: "#ff3b30", code: "#f1eeee", rowActive: "rgba(0,122,255,0.12)",
    },
    design: { radiusXs: "4px", radiusSm: "4px", radiusMd: "4px", radiusCtl: "4px", radiusPill: "4px", shadow: "none", fontUi: '"JetBrains Mono", ui-monospace, monospace' },
  },
  "dell-1996": {
    name: "Dell (1996)",
    mode: "light",
    tokens: {
      bg: "#ffffff", sidebar: "#f0f0f0", chrome: "#e8e8e8", text: "#000000", text2: "#444444",
      separator: "#000000", fill: "rgba(0,0,0,0.08)", fill2: "rgba(0,0,0,0.14)",
      accent: "#e91d2a", danger: "#e91d2a", code: "#f5f5f5", rowActive: "rgba(233,29,42,0.1)",
    },
    design: { radiusXs: "0px", radiusSm: "0px", radiusMd: "0px", radiusCtl: "0px", radiusPill: "0px", shadow: "none", fontUi: 'Georgia, "Times New Roman", serif' },
  },
  opencodeDark: {
    name: "OpenCode Dark",
    mode: "dark",
    tokens: {
      bg: "#201d1d", sidebar: "#181717", chrome: "#201d1d", text: "#fdfcfc", text2: "#9a9898",
      separator: "rgba(253,252,252,0.12)", fill: "rgba(253,252,252,0.08)", fill2: "rgba(253,252,252,0.14)",
      accent: "#007aff", danger: "#ff3b30", code: "#302c2c", rowActive: "rgba(0,122,255,0.16)",
    },
    design: { radiusXs: "4px", radiusSm: "4px", radiusMd: "4px", radiusCtl: "4px", radiusPill: "4px", shadow: "none", fontUi: '"JetBrains Mono", ui-monospace, monospace' },
  },
  cursorDark: {
    name: "Cursor Dark",
    mode: "dark",
    tokens: {
      bg: "#171714", sidebar: "#1f1f1c", chrome: "#1f1f1c", text: "#ededeb", text2: "#a1a09c",
      separator: "rgba(237,237,235,0.12)", fill: "rgba(237,237,235,0.08)", fill2: "rgba(237,237,235,0.14)",
      accent: "#f54e00", danger: "#cf2d56", code: "#232320", rowActive: "rgba(245,78,0,0.16)",
    },
    design: { radiusXs: "4px", radiusSm: "6px", radiusMd: "8px", radiusCtl: "6px", radiusPill: "999px", shadow: "none" },
  },
  apple: {
    name: "Apple",
    mode: "light",
    tokens: {
      bg: "#ffffff", sidebar: "#f5f5f7", chrome: "#f5f5f7", text: "#1d1d1f", text2: "#6e6e73",
      separator: "#e0e0e0", fill: "rgba(29,29,31,0.08)", fill2: "rgba(29,29,31,0.14)",
      accent: "#0066cc", danger: "#d70015", code: "#f5f5f7", rowActive: "rgba(0,102,204,0.12)",
    },
    design: { radiusXs: "4px", radiusSm: "8px", radiusMd: "12px", radiusCtl: "9999px", radiusPill: "9999px", fontUi: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif' },
  },
  appleDark: {
    name: "Apple Dark",
    mode: "dark",
    tokens: {
      // Apple's dark surfaces are graphite, not pure black: layered greys so
      // cards and code keep a visible edge against the canvas.
      bg: "#1c1c1e", sidebar: "#2c2c2e", chrome: "#1c1c1e", text: "#f5f5f7", text2: "#98989d",
      separator: "rgba(255,255,255,0.14)", fill: "rgba(255,255,255,0.08)", fill2: "rgba(255,255,255,0.14)",
      accent: "#2997ff", danger: "#ff453a", code: "#2c2c2e", rowActive: "rgba(41,151,255,0.16)",
    },
    design: { radiusXs: "4px", radiusSm: "8px", radiusMd: "12px", radiusCtl: "9999px", radiusPill: "9999px", fontUi: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif' },
  },
  spacex: {
    name: "SpaceX",
    mode: "dark",
    tokens: {
      bg: "#000000", sidebar: "#0a0a0a", chrome: "#000000", text: "#ffffff", text2: "#a1a1aa",
      separator: "#3a3a3f", fill: "rgba(255,255,255,0.08)", fill2: "rgba(255,255,255,0.14)",
      accent: "#5aa9ff", danger: "#ff453a", code: "#0a0a0a", rowActive: "rgba(90,169,255,0.16)",
    },
    design: { radiusXs: "4px", radiusSm: "8px", radiusMd: "16px", radiusCtl: "9999px", radiusPill: "32px", fontUi: '"Arial Narrow", Arial, sans-serif' },
  },
};

const THEME_GROUPS = [
  { label: "Светлые", ids: ["granka-light", "claude", "nike", "cursor", "ibm", "opencode", "dell-1996", "apple"] },
  { label: "Тёмные", ids: ["granka-dark", "spotify", "discord", "opencodeDark", "cursorDark", "appleDark", "spacex"] },
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

// Text on an accent fill: pick whichever ink (dark or light) gives more
// contrast, so bright accents (Spotify green, Gruvbox yellow) stay readable
// instead of a fixed luminance threshold choosing white too eagerly.
function accentTextFor(accent) {
  const light = contrastRatio("#ffffff", accent);
  const dark = contrastRatio("#12131a", accent);
  if (light === null || dark === null) return "#ffffff";
  return dark > light ? "#12131a" : "#ffffff";
}

function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// Geometry defaults: a theme that does not override a radius still exports it,
// otherwise switching from a square theme (IBM/Dell) to a rounded one leaves
// the previous inline value on :root and the radius "sticks".
const RADIUS_DEFAULTS = {
  radiusXs: "4px",    // inline code, marks, tiny badges
  radiusSm: "6px",    // small containers: message bubble, tool detail
  radiusMd: "10px",   // panels: composer, popover, cards
  radiusCtl: "6px",   // every interactive control: buttons, rows, inputs
  radiusPill: "999px",// chips and tags
};

function themeVars(id, systemAccent) {
  const theme = THEMES[id] ?? THEMES["granka-dark"];
  const tokens = { ...RADIUS_DEFAULTS, ...theme.tokens };
  if (systemAccent) tokens.accent = systemAccent;
  tokens.accentText = accentTextFor(tokens.accent);
  // Ink that stays readable on the danger fill (window close button).
  tokens.onDanger = accentTextFor(tokens.danger);
  // Semantic tokens every theme must provide but individual palettes omit:
  tokens.success = theme.mode === "dark" ? "#4caf7d" : "#157347";
  // Design geometry/type overrides (radii, fonts) map onto the shared CSS vars.
  const design = theme.design ?? {};
  if (design.fontUi) tokens.font = design.fontUi;
  else delete tokens.font;
  if (design.fontMono) tokens.mono = design.fontMono;
  else delete tokens.mono;
  if (design.radiusXs) tokens.radiusXs = design.radiusXs;
  if (design.radiusSm) tokens.radiusSm = design.radiusSm;
  if (design.radiusMd) tokens.radiusMd = design.radiusMd;
  if (design.radiusPill) tokens.radiusPill = design.radiusPill;
  if (design.radiusCtl) tokens.radiusCtl = design.radiusCtl;
  if (design.shadow) tokens.shadow = design.shadow;
  // Code blocks need visible separation from the background. Brands that ship
  // a deliberate code tone keep it; only a tone indistinguishable from bg is
  // nudged, so dark palettes never lose their code surface.
  if (theme.mode === "dark" && contrastRatio(tokens.code ?? tokens.bg, tokens.bg) < 1.12) {
    tokens.code = `color-mix(in oklab, ${tokens.bg} 92%, #ffffff)`;
  }
  if (theme.mode === "dark") {
    // A theme's own shadow (e.g. Spotify's heavy drop) wins over the default.
    if (!design.shadow) tokens.shadow = "0 8px 24px rgba(0, 0, 0, 0.5), 0 0 0 0.5px rgba(255, 255, 255, 0.08)";
  } else if (!design.shadow) {
    tokens.shadow = "0 8px 24px rgba(0, 0, 0, 0.12), 0 0 0 0.5px rgba(0, 0, 0, 0.06)";
  }
  return { mode: theme.mode, tokens };
}

globalThis.grankaThemes = { THEMES, THEME_GROUPS, resolveThemeId, themeVars };
})();
