// Style contract: the interface must be driven entirely by tokens, so a theme
// change reaches every element. This test fails when a component hardcodes a
// radius or a colour instead of using the theme variables.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const files = ["renderer/app.css", "renderer/settings.css"];
const problems = [];

for (const file of files) {
  const css = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

  // :root holds the fallback token values — those are the only allowed literals.
  const withoutRoot = css.replace(/:root\s*\{[^}]*\}/, "");
  // @font-face / @media prelude blocks are not component styles.
  const body = withoutRoot.replace(/@font-face\s*\{[^}]*\}/g, "");

  body.split("\n").forEach((line, index) => {
    const text = line.trim();
    if (!text || text.startsWith("/*") || text.startsWith("*")) return;

    // 1. No hardcoded radii (50% and var() are fine).
    const radius = /border-radius:\s*([^;]+);/.exec(text);
    if (radius) {
      const value = radius[1].trim();
      const allowed = value === "50%" || value === "inherit" || /var\(--radius-[a-z-]+\)/.test(value) || /^0\s+var\(--radius/.test(value);
      if (!allowed) problems.push(`${file}:${index + 1} hardcoded radius "${value}"`);
    }

    // 2. No hardcoded colours for paint properties (fallbacks inside var() are
    //    tolerated only for the two decorative inks that need one).
    const paint = /(?:^|\s)(color|background|background-color|border-color|outline-color|fill|stroke)\s*:\s*([^;]+);/.exec(text);
    if (paint) {
      const value = paint[2];
      const hex = /#[0-9a-fA-F]{3,8}/.test(value);
      const rgb = /rgba?\(/.test(value) && !/color-mix/.test(value);
      if (hex || rgb) problems.push(`${file}:${index + 1} hardcoded colour "${value.trim()}"`);
    }
  });
}

assert.deepEqual(problems, [], `hardcoded style values:\n${problems.join("\n")}`);

// 3. Every theme-dependent variable the CSS uses must be exported by themes.js.
const themes = readFileSync(new URL("../renderer/themes.js", import.meta.url), "utf8");
const css = files.map((file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8")).join("\n");
const used = new Set([...css.matchAll(/var\(--([a-z0-9-]+)/g)].map((match) => match[1]));
const structural = new Set([
  "font", "mono", "body", "prose", "meta", "title", "fs-xs", "fs-sm", "fs-md", "fs-lg", "fs-xl",
  "hair", "dur", "ease", "control", "toolbar-h", "header-h", "sidebar-w", "col", "col-msg",
  "gutter", "scroll-w", "chevron-img", "shadow", "radius-xs", "radius-sm", "radius-md",
  "radius-ctl", "radius-pill",
  // layout vars owned by JS (toolbar/composer measurement), not by themes
  "log-pad-b", "composer-overlap",
  // wallpaper vars owned by settings (backgroundImage/Blur/Dim/Noise/Opacity/Fit)
  "bg-fit", "bg-opacity", "bg-blur", "bg-dim", "bg-noise",
]);
const missing = [...used].filter((name) => {
  if (structural.has(name)) return false;
  // themeVars exports some tokens under a different casing/name than the CSS
  // variable (text2 -> --text-2, accentText -> --accent-text, ...).
  const aliases = {
    "text-2": "text2",
    "fill-2": "fill2",
    "row-active": "rowActive",
    "accent-text": "accentText",
    "on-danger": "onDanger",
    "code-text": "codeText",
    "text-3": "text3Ink",
    success: "success",
    "success-ink": "successInk",
    "accent-ink": "accentInk",
    "danger-ink": "dangerInk",
    warning: "warning",
    "warning-ink": "warningInk",
    "glass-bg": "glassBg",
    "glass-border": "glassBorder",
    sh1: "sh1", sh2: "sh2", sh3: "sh3", sh4: "sh4",
    "radius-l": "radiusL",
  };
  if (name in aliases) {
    const alias = aliases[name];
    return alias ? !themes.includes(alias) : false;
  }
  const camel = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  return !themes.includes(`${camel}:`) && !themes.includes(`"${name}"`);
});
assert.deepEqual(missing, [], `CSS uses variables no theme exports: ${missing.join(", ")}`);

console.log(`css tokens ok (${used.size} variables, no hardcoded radii or colours)`);

// 4. Geometry matrix: the same component must resolve to different radii in
//    different themes — otherwise "the theme changes everything" is a lie.
const vm = await import("node:vm");
const sandbox = { console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(themes, sandbox);
const { THEMES, themeVars } = sandbox.grankaThemes;

const selectorToken = (selector) => {
  const block = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css);
  const radius = block && /border-radius:\s*var\(--radius-([a-z]+)\)/.exec(block[1]);
  return radius ? radius[1] : null;
};

const components = {
  "bubble (.msg.user .text)": ".msg.user .text",
  "composer (#composer)": "#composer",
  "segment (.segment)": ".segment",
  "send (.prominentBtn)": ".prominentBtn",
  "chip (.tool)": ".tool",
  "popover (#popover)": "#popover",
  "modal (.questionDialog)": ".questionDialog",
};

const matrix = {};
for (const [label, selector] of Object.entries(components)) {
  const token = selectorToken(selector);
  assert.ok(token, `${label}: no radius token in CSS`);
  const values = Object.keys(THEMES).map((id) => themeVars(id, "").tokens[`radius${token[0].toUpperCase()}${token.slice(1)}`]);
  matrix[label] = { token, distinct: [...new Set(values)].length };
  assert.ok(matrix[label].distinct >= 3, `${label}: only ${matrix[label].distinct} distinct radii across themes`);
}

console.log(
  "geometry matrix: " +
    Object.entries(matrix).map(([label, info]) => `${label.split(" ")[0]}=${info.distinct}`).join(" "),
);
