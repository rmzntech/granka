(function () {
// Theme fonts stay in one visual family: clean sans for UI, monospaced for
// code. Serif/mono-as-UI presets read as handwritten or typewriter-like and
// give an uneven grid in a dense interface.
const UI_FONT = '"Granka Inter", sans-serif';
const MONO_FONT = '"Granka Mono", monospace';

// Theme presets. Palettes come from the published colour systems of each
// project (Catppuccin, Rosé Pine, Nord, Tokyo Night, Gruvbox, Solarized),
// mapped onto granka's semantic tokens. Contrast of `text2` on `bg` is kept
// at or above 4.5:1 for every entry.
const THEMES = {
  "granka-light": {
    name: "Granka",
    mode: "light",
    tokens: {
      // DESIGN.md: clean white canvas, Apple ladder, muted slate-blue accent.
      // text2 is #828287 in the spec (3.82:1, known gap §9); darkened to
      // #76767b so secondary text stays AA on white.
      bg: "#ffffff", sidebar: "#fbfbfd", chrome: "#f5f5f7", text: "#1d1d1f", text2: "#76767b",
      separator: "rgba(0,0,0,0.18)", fill: "rgba(0,0,0,0.07)", fill2: "rgba(0,0,0,0.10)",
      accent: "#576992", danger: "#b93636", code: "#17171c", rowActive: "rgba(87,105,146,0.10)",
    },
    design: {
      radiusXs: "8px", radiusSm: "8px", radiusMd: "14px", radiusCtl: "8px", radiusPill: "999px",
      fontUi: UI_FONT,
      shadow: "0 0px 1px rgba(30,30,40,0.031), 0 1px 3px rgba(30,30,40,0.022)",
    },
  },
  "granka-dark": {
    name: "Granka",
    mode: "dark",
    tokens: {
      // DESIGN.md dark: pure black canvas, graphite surfaces, muted slate accent.
      bg: "#131316", sidebar: "#1a1a1e", chrome: "#232329", text: "#f5f5f7", text2: "#8c8c90",
      separator: "rgba(255,255,255,0.18)", fill: "rgba(255,255,255,0.09)", fill2: "rgba(255,255,255,0.14)",
      accent: "#4f5d7f", danger: "#b93636", code: "#101014", rowActive: "rgba(79,93,127,0.22)",
    },
    design: {
      radiusXs: "8px", radiusSm: "8px", radiusMd: "14px", radiusCtl: "8px", radiusPill: "999px",
      fontUi: UI_FONT,
      shadow: "0 0px 1px rgba(0,0,0,0.172), 0 1px 3px rgba(0,0,0,0.120)",
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
    design: { radiusXs: "4px", radiusSm: "6px", radiusMd: "8px", radiusCtl: "8px", radiusPill: "999px", fontUi: UI_FONT },
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
    design: { radiusXs: "0px", radiusSm: "10px", radiusMd: "14px", radiusCtl: "9999px", radiusPill: "9999px", fontUi: UI_FONT },
  },
  cursor: {
    name: "Cursor",
    mode: "light",
    tokens: {
      bg: "#f7f7f4", sidebar: "#fafaf7", chrome: "#fafaf7", text: "#26251e", text2: "#6f6c61",
      separator: "#e6e5e0", fill: "rgba(38,37,30,0.08)", fill2: "rgba(38,37,30,0.14)",
      accent: "#f54e00", danger: "#cf2d56", code: "#ffffff", rowActive: "rgba(245,78,0,0.12)",
    },
    design: { radiusXs: "4px", radiusSm: "6px", radiusMd: "8px", radiusCtl: "6px", radiusPill: "999px", radiusL: "12px", shadow: "none" },
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
    design: { radiusXs: "0px", radiusSm: "0px", radiusMd: "2px", radiusCtl: "0px", radiusPill: "0px", radiusL: "2px", shadow: "none", fontUi: UI_FONT },
  },
  opencode: {
    name: "OpenCode",
    mode: "light",
    tokens: {
      bg: "#fdfcfc", sidebar: "#f8f7f7", chrome: "#f1eeee", text: "#201d1d", text2: "#646262",
      separator: "rgba(15,0,0,0.12)", fill: "rgba(32,29,29,0.08)", fill2: "rgba(32,29,29,0.14)",
      accent: "#007aff", danger: "#ff3b30", code: "#f1eeee", rowActive: "rgba(0,122,255,0.12)",
    },
    design: { radiusXs: "4px", radiusSm: "4px", radiusMd: "4px", radiusCtl: "4px", radiusPill: "4px", radiusL: "6px", shadow: "none", fontUi: UI_FONT },
  },
  "dell-1996": {
    name: "Dell (1996)",
    mode: "light",
    tokens: {
      bg: "#ffffff", sidebar: "#f0f0f0", chrome: "#e8e8e8", text: "#000000", text2: "#444444",
      separator: "#000000", fill: "rgba(0,0,0,0.08)", fill2: "rgba(0,0,0,0.14)",
      accent: "#e91d2a", danger: "#e91d2a", code: "#f5f5f5", rowActive: "rgba(233,29,42,0.1)",
    },
    design: { radiusXs: "0px", radiusSm: "0px", radiusMd: "0px", radiusCtl: "0px", radiusPill: "0px", radiusL: "0px", shadow: "none", fontUi: UI_FONT },
  },
  opencodeDark: {
    name: "OpenCode Dark",
    mode: "dark",
    tokens: {
      bg: "#201d1d", sidebar: "#181717", chrome: "#201d1d", text: "#fdfcfc", text2: "#9a9898",
      separator: "rgba(253,252,252,0.12)", fill: "rgba(253,252,252,0.08)", fill2: "rgba(253,252,252,0.14)",
      accent: "#007aff", danger: "#ff3b30", code: "#302c2c", rowActive: "rgba(0,122,255,0.16)",
    },
    design: { radiusXs: "4px", radiusSm: "4px", radiusMd: "4px", radiusCtl: "4px", radiusPill: "4px", radiusL: "6px", shadow: "none", fontUi: UI_FONT },
  },
  cursorDark: {
    name: "Cursor Dark",
    mode: "dark",
    tokens: {
      bg: "#171714", sidebar: "#1f1f1c", chrome: "#1f1f1c", text: "#ededeb", text2: "#a1a09c",
      separator: "rgba(237,237,235,0.12)", fill: "rgba(237,237,235,0.08)", fill2: "rgba(237,237,235,0.14)",
      accent: "#f54e00", danger: "#cf2d56", code: "#232320", rowActive: "rgba(245,78,0,0.16)",
    },
    design: { radiusXs: "4px", radiusSm: "6px", radiusMd: "8px", radiusCtl: "6px", radiusPill: "999px", radiusL: "12px", shadow: "none" },
  },
  apple: {
    name: "Apple",
    mode: "light",
    tokens: {
      bg: "#ffffff", sidebar: "#f5f5f7", chrome: "#f5f5f7", text: "#1d1d1f", text2: "#6e6e73",
      separator: "#e0e0e0", fill: "rgba(29,29,31,0.08)", fill2: "rgba(29,29,31,0.14)",
      accent: "#0066cc", danger: "#d70015", code: "#f5f5f7", rowActive: "rgba(0,102,204,0.12)",
    },
    design: { radiusXs: "4px", radiusSm: "8px", radiusMd: "12px", radiusCtl: "9999px", radiusPill: "9999px", fontUi: UI_FONT },
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
    design: { radiusXs: "4px", radiusSm: "8px", radiusMd: "12px", radiusCtl: "9999px", radiusPill: "9999px", fontUi: UI_FONT },
  },
  spacex: {
    name: "SpaceX",
    mode: "dark",
    tokens: {
      bg: "#000000", sidebar: "#0a0a0a", chrome: "#000000", text: "#ffffff", text2: "#a1a1aa",
      separator: "#3a3a3f", fill: "rgba(255,255,255,0.08)", fill2: "rgba(255,255,255,0.14)",
      accent: "#5aa9ff", danger: "#ff453a", code: "#0a0a0a", rowActive: "rgba(90,169,255,0.16)",
    },
    design: { radiusXs: "4px", radiusSm: "8px", radiusMd: "16px", radiusCtl: "9999px", radiusPill: "32px", fontUi: UI_FONT },
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
  radiusL: "20px",    // modals
};

// Blend two hex colours (t = share of `to`).
function mixHex(from, to, t) {
  const parse = (hex) => {
    let v = String(hex).replace("#", "");
    if (v.length === 3) v = v.split("").map((c) => c + c).join("");
    return [0, 2, 4].map((o) => parseInt(v.slice(o, o + 2), 16));
  };
  const a = parse(from), b = parse(to);
  return "#" + a.map((c, i) => Math.round(c + (b[i] - c) * t).toString(16).padStart(2, "0")).join("");
}

// Nudge a colour toward `anchor` until it reaches `target` contrast on `bg`.
function ensureContrast(fg, bg, anchor, target = 4.5) {
  if (!/^[0-9a-f]{6}$/i.test(String(fg).slice(1)) || !/^[0-9a-f]{6}$/i.test(String(bg).slice(1))) return fg;
  let value = fg;
  for (let step = 0; step <= 20; step++) {
    if (contrastRatio(value, bg) >= target) return value;
    value = mixHex(fg, anchor, step / 20);
  }
  return value;
}

const SHADOWS = {
  light: [
    "0 0px 1px rgba(30,30,40,0.018), 0 1px 3px rgba(30,30,40,0.012)",
    "0 2px 3px rgba(30,30,40,0.024), 0 6px 11px rgba(30,30,40,0.017)",
    "0 4px 8px rgba(30,30,40,0.030), 0 12px 22px rgba(30,30,40,0.021)",
    "0 10px 16px rgba(30,30,40,0.038), 0 23px 38px rgba(30,30,40,0.026)",
  ],
  dark: [
    "0 0px 1px rgba(0,0,0,0.100), 0 1px 3px rgba(0,0,0,0.070)",
    "0 2px 3px rgba(0,0,0,0.140), 0 6px 11px rgba(0,0,0,0.098)",
    "0 4px 8px rgba(0,0,0,0.180), 0 12px 22px rgba(0,0,0,0.126)",
    "0 10px 16px rgba(0,0,0,0.230), 0 23px 38px rgba(0,0,0,0.160)",
  ],
};

function themeVars(id, systemAccent) {
  const theme = THEMES[id] ?? THEMES["granka-dark"];
  const tokens = { ...RADIUS_DEFAULTS, ...theme.tokens };
  if (systemAccent) tokens.accent = systemAccent;
  tokens.accentText = accentTextFor(tokens.accent);
  // Ink that stays readable on the danger fill (window close button).
  tokens.onDanger = accentTextFor(tokens.danger);
  // Readable inks for small text of a semantic colour on the canvas:
  // accent/danger themselves fail AA as body text in several themes.
  tokens.accentInk = ensureContrast(tokens.accent, tokens.bg, tokens.text, 4.5);
  tokens.dangerInk = ensureContrast(tokens.danger, tokens.bg, tokens.text, 4.5);
  // Captions need their own AA step instead of an alpha mix that fails on
  // light canvases. Start at the old 52% mix and lift only as far as needed.
  tokens.text3Ink = ensureContrast(mixHex(tokens.text, tokens.bg, 0.48), tokens.bg, tokens.text, 4.5);
  // Secondary text must also pass AA on filled chips (bg + fill), not only bg.
  tokens.text2 = ensureContrast(tokens.text2, tokens.bg, tokens.text, 4.6);
  // Ink for code blocks: derived from the actual code surface, so light
  // code tones (Claude/Nike/IBM/…) get dark ink instead of white.
  tokens.codeText = accentTextFor(tokens.code ?? tokens.bg);
  // Warning was missing entirely (rendered as danger).
  tokens.warning = theme.mode === "dark" ? "#f0a35e" : "#9a5b00";
  // Glass and the shadow scale follow the theme instead of staying frozen
  // to the granka palette in every brand theme.
  tokens.glassBg = `color-mix(in oklab, ${tokens.bg} 55%, transparent)`;
  tokens.glassBorder = theme.mode === "dark"
    ? "rgba(255,255,255,0.175)"
    : "rgba(255,255,255,0.35)";
  const scale = SHADOWS[theme.mode] ?? SHADOWS.light;
  tokens.sh1 = scale[0]; tokens.sh2 = scale[1]; tokens.sh3 = scale[2]; tokens.sh4 = scale[3];
  // Semantic tokens every theme must provide but individual palettes omit.
  // Base themes follow DESIGN.md (muted "dusty" semantics in tone with the
  // slate accent); other palettes keep their previous derived values.
  tokens.success = (id === "granka-light" || id === "granka-dark")
    ? "#7d9c65"
    : theme.mode === "dark" ? "#4caf7d" : "#157347";
  tokens.successInk = ensureContrast(tokens.success, tokens.bg, tokens.text, 4.5);
  tokens.warningInk = ensureContrast(tokens.warning, tokens.bg, tokens.text, 4.5);
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
  if (design.radiusL) tokens.radiusL = design.radiusL;
  if (design.shadow) tokens.shadow = design.shadow;
  // Code blocks need visible separation from the background. Brands that ship
  // a deliberate code tone keep it; only a tone indistinguishable from bg is
  // nudged, so dark palettes never lose their code surface.
  if (theme.mode === "dark" && tokens.code && contrastRatio(tokens.code, tokens.bg) < 1.12) {
    tokens.code = mixHex(tokens.bg, "#ffffff", 0.08);
  }
  if (theme.mode === "light" && tokens.code && contrastRatio(tokens.code, tokens.bg) < 1.03) {
    tokens.code = mixHex(tokens.bg, "#000000", 0.05);
  }
  tokens.codeText = accentTextFor(tokens.code ?? tokens.bg);
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
