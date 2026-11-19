// Theme contract: every palette must stay readable, keep its semantic tokens
// and declare the geometry it promises. Runs offline on the shipped themes.js
// (no Electron, no network).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../renderer/themes.js", import.meta.url), "utf8");
const sandbox = { globalThis: {}, Math, Object, Number, String, Array, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const api = sandbox.grankaThemes;
assert.ok(api, "themes.js must expose grankaThemes");

const { THEMES, THEME_GROUPS, themeVars, resolveThemeId } = api;

function luminance(hex) {
  const value = String(hex).trim().replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(value)) return null;
  const channels = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return null;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const ids = Object.keys(THEMES);
assert.ok(ids.length >= 10, `expected at least 10 themes, got ${ids.length}`);

// Every theme belongs to exactly one group, and groups cover every theme.
const grouped = THEME_GROUPS.flatMap((group) => group.ids);
assert.equal(grouped.length, new Set(grouped).size, "a theme is listed twice in groups");
for (const id of ids) {
  assert.ok(grouped.includes(id), `${id}: missing from THEME_GROUPS`);
  const theme = THEMES[id];
  assert.ok(["light", "dark"].includes(theme.mode), `${id}: bad mode`);
  assert.ok(theme.name && theme.name.length > 1, `${id}: name`);

  const { tokens } = themeVars(id, "");
  for (const key of ["bg", "sidebar", "chrome", "text", "text2", "accent", "separator", "fill", "fill2", "code", "rowActive", "danger", "success", "shadow", "accentText", "accentInk", "dangerInk", "warning", "glassBg", "glassBorder", "sh1", "sh2", "sh3", "sh4", "radiusL"]) {
    assert.ok(tokens[key], `${id}: token ${key} missing`);
  }

  const body = contrast(tokens.text, tokens.bg);
  const secondary = contrast(tokens.text2, tokens.bg);
  const accentOnBg = contrast(tokens.accent, tokens.bg);
  const onAccent = contrast(tokens.accentText, tokens.accent);
  assert.ok(body >= 7, `${id}: body text contrast ${body?.toFixed(2)} < 7`);
  assert.ok(secondary >= 4.5, `${id}: secondary text contrast ${secondary?.toFixed(2)} < 4.5`);
  const codeInk = contrast(tokens.codeText, tokens.code ?? tokens.bg);
  assert.ok(codeInk >= 4.5, `${id}: code ink contrast ${codeInk?.toFixed(2)} < 4.5`);
  const accentInk = contrast(tokens.accentInk, tokens.bg);
  assert.ok(accentInk >= 4.5, `${id}: accent ink contrast ${accentInk?.toFixed(2)} < 4.5`);
  const dangerInk = contrast(tokens.dangerInk, tokens.bg);
  assert.ok(dangerInk >= 4.5, `${id}: danger ink contrast ${dangerInk?.toFixed(2)} < 4.5`);
  assert.ok(accentOnBg >= 2.2, `${id}: accent vs bg ${accentOnBg?.toFixed(2)} < 2.2`);
  assert.ok(onAccent >= 3, `${id}: accentText contrast ${onAccent?.toFixed(2)} < 3`);

  // Light themes must be light, dark themes dark: a swapped palette is a bug.
  const bgLum = luminance(tokens.bg);
  if (theme.mode === "light") assert.ok(bgLum > 0.5, `${id}: light theme with dark bg`);
  else assert.ok(bgLum < 0.2, `${id}: dark theme with light bg`);
}

// Brand themes declare their own geometry and/or typeface.
for (const id of ["claude", "spotify", "nike", "cursor", "discord", "ibm", "opencode", "dell-1996"]) {
  assert.ok(THEMES[id], `${id}: brand theme missing`);
  const design = THEMES[id].design ?? {};
  assert.ok(design.radiusSm || design.fontUi, `${id}: no geometry or typeface override`);
  const { tokens } = themeVars(id, "");
  assert.ok(tokens.radiusSm, `${id}: --radius-sm not exported`);
}

// Geometry promise: containers stay soft, controls and pills follow the brand,
// and switching themes never leaves a stale radius behind (every token is
// always exported with a concrete value).
for (const id of Object.keys(THEMES)) {
  const t = themeVars(id, "").tokens;
  for (const key of ["radiusXs", "radiusSm", "radiusMd", "radiusCtl", "radiusPill"]) {
    assert.ok(t[key] && /^\d+(\.\d+)?(px|%)$/.test(t[key]), `${id}: ${key} = ${t[key]}`);
  }
  // A message bubble (radiusSm) must never be a pill: multi-line bubbles in a
  // 9999px radius render as blobs.
  assert.notEqual(t.radiusSm, "9999px", `${id}: bubble radius must not be a pill`);
}
assert.equal(themeVars("ibm", "").tokens.radiusMd, "2px");
assert.equal(themeVars("dell-1996", "").tokens.radiusMd, "0px");
assert.equal(themeVars("dell-1996", "").tokens.radiusCtl, "0px");
assert.equal(themeVars("spotify", "").tokens.radiusCtl, "9999px");
assert.equal(themeVars("nike", "").tokens.radiusPill, "9999px");
assert.equal(themeVars("opencode", "").tokens.radiusCtl, "4px");

// System preference always resolves to a theme that exists.
assert.ok(THEMES[resolveThemeId("auto", true)]);
assert.ok(THEMES[resolveThemeId("auto", false)]);
assert.ok(THEMES[resolveThemeId("dark", false)]);
assert.ok(THEMES[resolveThemeId("nonexistent", true)]);

console.log(`themes ok (${ids.length} themes, groups cover all, contrast + geometry verified)`);
