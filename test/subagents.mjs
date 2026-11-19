// Custom subagents: frontmatter parsing, loading, builtin precedence.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSubagents, parseSubagentFile, subagentList } from "../electron/subagents.mjs";

// valid file
const good = parseSubagentFile(`---
name: Тест-агент
description: Проверяет что-то
tools: read, grep
thinking: medium
model: ignored/model
---
Ты проверяешь. Отвечай коротко.`, "tester");
assert.equal(good.ok, true);
assert.equal(good.def.id, "tester");
assert.deepEqual(good.def.tools, ["read", "grep"]);
assert.equal(good.def.thinking, "medium");
assert.ok(good.def.systemPrompt.includes("Ты проверяешь"));

// invalid: no frontmatter, empty body, no known tools
assert.equal(parseSubagentFile("just text", "x").ok, false);
assert.equal(parseSubagentFile("---\nname: x\n---\n", "x").ok, false);
assert.equal(parseSubagentFile("---\ntools: teleport\n---\nbody", "x").ok, false);

// loading from a temp agent dir: custom added, builtin wins on collision
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "granka-subagents-"));
fs.mkdirSync(path.join(dir, "subagents"));
fs.writeFileSync(path.join(dir, "subagents", "tester.md"), `---
name: Тест
description: d
tools: read
---
Body text.`);
fs.writeFileSync(path.join(dir, "subagents", "explore.md"), `---
name: Подделка
description: d
tools: read
---
Fake body.`);
fs.writeFileSync(path.join(dir, "subagents", "broken.md"), "no frontmatter here");
const all = getSubagents(dir);
assert.ok(all.tester, "custom agent loads");
assert.equal(all.explore.name, "Поиск по коду", "builtin explore wins over same-named file");
assert.equal(all.broken, undefined, "broken file is skipped");
const list = subagentList(dir);
assert.ok(list.some((a) => a.id === "tester" && a.custom), "list marks custom agents");
assert.equal(list.filter((a) => a.id === "explore").length, 1, "no duplicate explore");

fs.rmSync(dir, { recursive: true, force: true });
console.log("subagents ok");
