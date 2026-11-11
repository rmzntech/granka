// Document tools: create → read → search → edit → format, on real files.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDocTools, parseMarkdownLite } from "../electron/docs.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "granka-docs-"));
const host = {
  resolve: (p) => path.resolve(dir, p),
  emit: () => {},
};
const tools = createDocTools(host);
const run = async (tool, params) => {
  const result = await tool.execute("t", params, undefined, undefined, {});
  return result.content[0].text;
};

// markdown-lite parsing
const blocks = parseMarkdownLite("# Заголовок\n\nАбзац **жирный**.\n\n- пункт\n- пункт\n\n| a | b |\n|---|---|\n| 1 | 2 |");
assert.equal(blocks[0].type, "h1");
assert.ok(blocks.some((b) => b.type === "table" && b.rows.length === 2));
assert.ok(blocks.some((b) => b.type === "li"));

const md = `# Отчёт
Вводный абзац с **важным** словом.

## Раздел
- первый пункт
- второй пункт

| Метрика | Значение |
|---|---|
| Строк | 120 |
| Тестов | 34 |

Финальный абзац.`;

// DOCX create → outline → read → search → edit → format
const docxPath = path.join(dir, "report.docx");
const created = await run(tools.createTool, {
  path: docxPath,
  content: md,
  style: { font: "serif", size: 12, margin: 2.5, accent: "b5651d", header: "granka", footer: "стр." },
});
assert.match(created, /DOCX создан/);
assert.ok(fs.statSync(docxPath).size > 3000, "docx has content");

const outline = await run(tools.outlineTool, { path: docxPath });
assert.match(outline, /DOCX/);
assert.match(outline, /Отчёт/);

const read = await run(tools.readTool, { path: docxPath });
assert.match(read, /Вводный абзац/);
assert.match(read, /Строк/);

const found = await run(tools.searchTool, { path: docxPath, query: "тестов" });
assert.match(found, /блок/);

const edited = await run(tools.editTool, {
  path: docxPath,
  ops: [
    { type: "replace", find: "Финальный абзац.", replace: "Абзац заменён инструментом." },
    { type: "append", content: "Добавка в конец", heading: true },
  ],
});
assert.match(edited, /заменено/);
const afterEdit = await run(tools.readTool, { path: docxPath });
assert.match(afterEdit, /Абзац заменён инструментом/);
assert.match(afterEdit, /Добавка в конец/);

const formatted = await run(tools.formatTool, {
  path: docxPath,
  style: { font: "sans", size: 10, margin: 1.5, accent: "1f4e79", footer: "granka" },
});
assert.match(formatted, /переоформлен/);
assert.ok(fs.statSync(docxPath).size > 3000);

// PDF create → outline → read → edit (overlay/redact/page) → format
const pdfPath = path.join(dir, "report.pdf");
const pdfCreated = await run(tools.createTool, {
  path: pdfPath,
  content: md,
  style: { font: "sans", size: 11, margin: 2, header: "granka", footer: "стр." },
});
assert.match(pdfCreated, /PDF создан/);

const pdfOutline = await run(tools.outlineTool, { path: pdfPath });
assert.match(pdfOutline, /PDF, страниц: [1-9]/);

const pdfRead = await run(tools.readTool, { path: pdfPath, from: 1, to: 1 });
assert.match(pdfRead, /Отчёт|Вводный/);

const pdfSearch = await run(tools.searchTool, { path: pdfPath, query: "Раздел" });
assert.match(pdfSearch, /стр\./);

const pdfEdited = await run(tools.editTool, {
  path: pdfPath,
  ops: [
    { type: "add_text", page: 1, x: 40, y: 40, text: "Подпись", size: 9 },
    { type: "redact", page: 1, x: 40, y: 60, width: 60, height: 10 },
    { type: "add_page" },
  ],
});
assert.match(pdfEdited, /текст добавлен/);
const pdfPagesAfter = await run(tools.outlineTool, { path: pdfPath });
assert.match(pdfPagesAfter, /страниц: 2/);

const pdfFormatted = await run(tools.formatTool, {
  path: pdfPath,
  style: { font: "serif", size: 12, margin: 2.5, accent: "b5651d", header: "granka", footer: "стр." },
});
assert.match(pdfFormatted, /переоформлен/);

// long reads are clipped with a continuation hint
const longMd = Array.from({ length: 400 }, (_, i) => `Абзац номер ${i} с достаточно длинным текстом для лимита.`).join("\n\n");
const longPdf = path.join(dir, "long.pdf");
await run(tools.createTool, { path: longPdf, content: longMd });
const clipped = await run(tools.readTool, { path: longPdf, from: 1, to: 3, limit: 800 });
assert.ok(clipped.includes("дальше: doc_read"), "clip hint for continuation");

fs.rmSync(dir, { recursive: true, force: true });
console.log("docs ok");
