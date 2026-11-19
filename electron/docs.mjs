// Document tools: PDF and DOCX read/create/edit/format with pure-JS libraries
// (unpdf, @cantoo/pdf-lib, mammoth, docx, fflate). No native binaries, no
// services, works the same on Linux, macOS and Windows.
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";

// Single source of truth for tool-output size: the same toolOutputLimit the
// agent applies globally (agent.mjs clip), so a tool never promises more
// than the model ever sees.
function toolOutputLimit() {
  try {
    const cfg = JSON.parse(fsSync.readFileSync(path.join(os.homedir(), ".granka", "granka.json"), "utf8"));
    const n = Number(cfg.toolOutputLimit);
    if (Number.isFinite(n) && n >= 500 && n <= 32000) return n;
  } catch (err) { console.error("[granka docs]", err?.message ?? err); }
  return 16000;
}

const SEARCH_HITS = 12;

// Input caps: a single document must not OOM the main process.
const MAX_DOC_BYTES = 25 * 1024 * 1024;
const MAX_PAGES = 500;

// Parsed-document cache keyed by path, invalidated by mtime+size+ctime.
const docCache = new Map();
const DOC_CACHE_MAX = 20;
function cacheGet(key, stat) {
  const hit = docCache.get(key);
  if (!hit) return null;
  if (hit.mtimeMs !== stat.mtimeMs || hit.size !== stat.size || hit.ctimeMs !== stat.ctimeMs) {
    docCache.delete(key);
    return null;
  }
  docCache.delete(key);
  docCache.set(key, hit); // LRU refresh
  return hit.value;
}
function cacheSet(key, stat, value) {
  docCache.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, ctimeMs: stat.ctimeMs, value });
  while (docCache.size > DOC_CACHE_MAX) docCache.delete(docCache.keys().next().value);
}

// Secrets and granka's own home are never document-tool targets.
export function assertNotSensitive(filePath) {
  const resolved = path.resolve(String(filePath));
  const home = os.homedir();
  const sensitive = [
    path.join(home, ".granka"),
    path.join(home, ".ssh"),
    path.join(home, ".gnupg"),
    path.join(home, ".aws"),
    path.join(home, ".config", "gcloud"),
  ];
  for (const dir of sensitive) {
    if (resolved === dir || resolved.startsWith(dir + path.sep)) {
      throw new Error(`запрещено: ${filePath} (чувствительный путь)`);
    }
  }
  if (/(^|[\/\\])(auth\.json|id_rsa|id_ed25519|\.env)$/.test(resolved)) {
    throw new Error(`запрещено: ${filePath} (чувствительный файл)`);
  }
  return resolved;
}

const PAGE_SIZES = {
  a4: [595.28, 841.89],
  letter: [612, 792],
  a5: [419.53, 595.28],
};

// Unicode-capable system fonts: standard PDF fonts cannot encode Cyrillic.
// Probed per platform, first existing path wins; no bundled binaries.
const FONT_FILES = {
  sans: [
    ["/usr/share/fonts/TTF/DejaVuSans.ttf", "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf"],
    ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"],
    ["/usr/share/fonts/liberation/LiberationSans-Regular.ttf", "/usr/share/fonts/liberation/LiberationSans-Bold.ttf"],
    ["C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/segoeuib.ttf"],
    ["C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/arialbd.ttf"],
    ["/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf"],
    ["/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/Helvetica.ttc"],
  ],
  serif: [
    ["/usr/share/fonts/TTF/DejaVuSerif.ttf", "/usr/share/fonts/TTF/DejaVuSerif-Bold.ttf"],
    ["/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf"],
    ["/usr/share/fonts/liberation/LiberationSerif-Regular.ttf", "/usr/share/fonts/liberation/LiberationSerif-Bold.ttf"],
    ["C:/Windows/Fonts/times.ttf", "C:/Windows/Fonts/timesbd.ttf"],
    ["/System/Library/Fonts/Supplemental/Times New Roman.ttf", "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf"],
  ],
  mono: [
    ["/usr/share/fonts/TTF/DejaVuSansMono.ttf", "/usr/share/fonts/TTF/DejaVuSansMono-Bold.ttf"],
    ["/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"],
    ["/usr/share/fonts/liberation/LiberationMono-Regular.ttf", "/usr/share/fonts/liberation/LiberationMono-Bold.ttf"],
    ["C:/Windows/Fonts/consola.ttf", "C:/Windows/Fonts/consolab.ttf"],
    ["/System/Library/Fonts/Supplemental/Courier New.ttf", "/System/Library/Fonts/Supplemental/Courier New Bold.ttf"],
  ],
};

async function findUnicodeFont(family) {
  for (const [regularPath, boldPath] of FONT_FILES[family] ?? FONT_FILES.sans) {
    try {
      const regular = await fs.readFile(regularPath);
      let bold = regular;
      try {
        bold = await fs.readFile(boldPath);
      } catch {}
      return { regular, bold, file: regularPath };
    } catch {}
  }
  return null;
}

const FONTS = {
  // pdf values are @cantoo/pdf-lib StandardFonts enum keys
  sans: { pdf: ["Helvetica", "HelveticaBold"], docx: "Calibri" },
  serif: { pdf: ["TimesRoman", "TimesRomanBold"], docx: "Cambria" },
  mono: { pdf: ["Courier", "CourierBold"], docx: "Consolas" },
};

// ------------------------------------------------------------------ helpers

function kindOf(filePath) {
  const ext = path.extname(String(filePath)).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".docx") return "docx";
  if (ext === ".xlsx") return "xlsx";
  if (ext === ".ods") return "ods";
  if (ext === ".csv") return "csv";
  if (ext === ".rtf") return "rtf";
  if (ext === ".md") return "md";
  if (ext === ".txt") return "txt";
  if (ext === ".html" || ext === ".htm") return "html";
  return "other";
}

// --- spreadsheets / plain formats (pure JS, no new dependencies) --------

function xmlText(xml) {
  return decodeEntities(String(xml ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
}

async function sheetBlocks(filePath) {
  const kind = kindOf(filePath);
  if (kind === "csv") {
    const raw = await fs.readFile(filePath, "utf8");
    const rows = raw.split(/\r?\n/).filter((l) => l.trim()).map((line) =>
      line.split(/\t|,|;/).map((c) => c.trim().replace(/^"|"$/g, "")),
    );
    return rows.length ? [{ type: "table", rows }] : [];
  }
  if (kind === "rtf") {
    const raw = await fs.readFile(filePath, "utf8");
    const text = raw.replace(/\\par[d]?/g, "\n").replace(/\\[a-z]+-?\d* ?/g, " ").replace(/[{}]/g, "").replace(/\\'([0-9a-fA-F]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/\s+/g, " ").trim();
    return text ? text.split(/\n+/).map((t) => ({ type: "p", text: t.trim() })).filter((b) => b.text) : [];
  }
  // XLSX / ODS are zip archives: read shared strings + sheet XML via fflate.
  const { unzipSync } = await import("fflate");
  const raw = new Uint8Array(await fs.readFile(filePath));
  const files = unzipSync(raw);
  const decoder = new TextDecoder("utf-8");
  const read = (name) => (files[name] ? decoder.decode(files[name]) : "");
  const blocks = [];
  if (kind === "xlsx") {
    const shared = [...read("xl/sharedStrings.xml").matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => xmlText(m[1]));
    const sheetNames = Object.keys(files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort();
    for (const sheetName of sheetNames) {
      const xml = read(sheetName);
      const rows = [];
      for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
        const cells = [];
        for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
          const attrs = cellMatch[1];
          const type = /t="([^"]*)"/.exec(attrs)?.[1];
          const inner = cellMatch[2];
          if (type === "s") cells.push(shared[Number(xmlText(inner))] ?? "");
          else if (type === "inlineStr") cells.push(xmlText(inner));
          else cells.push(xmlText(inner));
        }
        if (cells.some(Boolean)) rows.push(cells);
      }
      if (rows.length) blocks.push({ type: "table", rows });
    }
  } else if (kind === "ods") {
    const xml = read("content.xml");
    const rows = [];
    for (const rowMatch of xml.matchAll(/<table:table-row[^>]*>([\s\S]*?)<\/table:table-row>/g)) {
      const cells = [];
      for (const cellMatch of rowMatch[1].matchAll(/<table:table-cell[^>]*>([\s\S]*?)<\/table:table-cell>/g)) {
        cells.push(xmlText(cellMatch[1]));
      }
      if (cells.some(Boolean)) rows.push(cells);
    }
    if (rows.length) blocks.push({ type: "table", rows });
  }
  return blocks;
}

async function ensureReadable(filePath) {
  assertNotSensitive(filePath);
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error("не файл");
    if (stat.size > MAX_DOC_BYTES) throw new Error(`файл слишком большой: ${Math.round(stat.size / 1024 / 1024)} МБ (лимит ${MAX_DOC_BYTES / 1024 / 1024} МБ)`);
    return stat;
  } catch (err) {
    if (err?.message?.startsWith("запрещено") || err?.message?.startsWith("файл слишком")) throw err;
    throw new Error(`файл не найден или недоступен: ${filePath}`);
  }
}

function clip(text, limit = toolOutputLimit()) {
  return { text: text.slice(0, limit), truncated: text.length > limit };
}

// Reconstruct page text from positioned items: group by line (y), sort by x,
// and split into columns/tables on large horizontal gaps. This keeps table
// rows and multi-column layouts instead of flattening them into a blob.
function itemsToPageText(items) {
  const lines = [];
  for (const item of items ?? []) {
    const text = String(item.str ?? "").trim();
    if (!text) continue;
    const y = Math.round((item.y ?? 0) / Math.max(item.height ?? 10, 6));
    let line = lines.find((l) => Math.abs(l.y - y) <= 1);
    if (!line) { line = { y, parts: [] }; lines.push(line); }
    line.parts.push({ x: item.x ?? 0, w: item.width ?? 0, text, size: item.fontSize ?? 10 });
  }
  lines.sort((a, b) => b.y - a.y);
  return lines.map((line) => {
    line.parts.sort((a, b) => a.x - b.x);
    const out = [];
    let prev = null;
    for (const part of line.parts) {
      if (prev) {
        const gap = part.x - (prev.x + prev.w);
        // Large gap relative to font size = table column / column break.
        out.push(gap > Math.max(14, part.size * 1.2) ? "\t" : " ");
      }
      out.push(part.text);
      prev = part;
    }
    return out.join("").replace(/\t+/g, "\t").trim();
  }).filter(Boolean).join("\n");
}

// Detect repeated header/footer lines (same text on >50% of pages at the
// top or bottom) and strip them so they do not pollute search/read.
function stripRunningHeaders(pages) {
  if (pages.length < 3) return pages;
  const split = pages.map((p) => String(p).split("\n").filter(Boolean));
  const countEdge = (idxFromStart) => {
    const counts = new Map();
    for (const lines of split) {
      const line = idxFromStart ? lines[lines.length - 1] : lines[0];
      if (line) counts.set(line, (counts.get(line) ?? 0) + 1);
    }
    return counts;
  };
  const threshold = Math.ceil(pages.length / 2);
  const headers = countEdge(false);
  const footers = countEdge(true);
  return split.map((lines) => {
    let out = lines;
    if (out.length && (headers.get(out[0]) ?? 0) >= threshold) out = out.slice(1);
    if (out.length && (footers.get(out[out.length - 1]) ?? 0) >= threshold) out = out.slice(0, -1);
    return out.join("\n");
  });
}

async function pdfText(filePath, stat) {
  stat = stat ?? (await ensureReadable(filePath));
  const cached = cacheGet(filePath, stat);
  if (cached) return cached;
  const { getDocumentProxy, extractTextItems, extractText } = await import("unpdf");
  const buffer = await fs.readFile(filePath);
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  // Cheap gate first: numPages is known before any page is parsed.
  const totalPages = pdf.numPages ?? 0;
  if (totalPages > MAX_PAGES) throw new Error(`слишком много страниц: ${totalPages} (лимит ${MAX_PAGES})`);
  let pages;
  try {
    const { items } = await extractTextItems(pdf);
    pages = items.map((pageItems) => itemsToPageText(pageItems));
  } catch {
    const { text } = await extractText(pdf, { mergePages: false });
    pages = text.map((page) => String(page ?? ""));
  }
  pages = stripRunningHeaders(pages);
  const result = { totalPages, pages };
  cacheSet(filePath, stat, result);
  return result;
}

// Cheap page count for attachment chips: numPages without extracting text.
export async function pdfPageCount(filePath) {
  const { getDocumentProxy } = await import("unpdf");
  const buffer = await fs.readFile(filePath);
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  return pdf.numPages ?? 0;
}

// Cheap metadata for attachments: page/block counts shown in the chip so
// the user sees what they attached without opening the file.
export async function docInfo(filePath) {
  try {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".pdf") {
      const totalPages = await pdfPageCount(filePath).catch(() => 0);
      if (totalPages) return { pages: totalPages };
      const { totalPages: parsed } = await pdfText(filePath);
      return { pages: parsed };
    }
    if ([".xlsx", ".ods", ".csv"].includes(ext)) {
      const blocks = await sheetBlocks(filePath);
      return { blocks: blocks.length };
    }
    if (ext === ".docx") {
      const blocks = await docxBlocks(filePath);
      return { blocks: blocks.length };
    }
    if ([".md", ".txt", ".html", ".htm"].includes(ext)) {
      const text = await fs.readFile(filePath, "utf8").catch(() => "");
      return { lines: text.split("\n").length };
    }
  } catch (err) { console.error("[granka docInfo]", err?.message ?? err); }
  return {};
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function htmlToBlocks(html) {
  const blocks = [];
  const pattern = /<(h[1-6]|p|li|tr)[^>]*>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    const tag = match[1].toLowerCase();
    // Images inside the block become real image blocks (order preserved).
    const imgMatches = [...match[2].matchAll(/<img\b[^>]*>/gi)];
    let raw;
    let cells = null;
    if (tag === "tr") {
      // Split by real cells (td/th) instead of guessing on whitespace.
      const cellMatches = [...match[2].matchAll(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)];
      if (cellMatches.length) {
        cells = cellMatches.map((c) => decodeEntities(c[1].replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()));
        raw = cells.join("\t");
      } else {
        raw = match[2].replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim();
      }
    } else {
      raw = match[2].replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim();
    }
    const text = decodeEntities(raw);
    for (const img of imgMatches) {
      const src = /src=["']([^"']+)["']/i.exec(img[0])?.[1] ?? "";
      const alt = decodeEntities(/alt=["']([^"']*)["']/i.exec(img[0])?.[1] ?? "");
      const dataMatch = /^data:([^;,]+);base64,(.*)$/s.exec(src);
      if (dataMatch) {
        blocks.push({ type: "image", alt, contentType: dataMatch[1], data: Buffer.from(dataMatch[2], "base64") });
      } else if (src) {
        blocks.push({ type: "image", alt, src });
      }
    }
    if (!text) continue;
    if (tag === "h1") blocks.push({ type: "h1", text });
    else if (tag === "h2") blocks.push({ type: "h2", text });
    else if (tag === "h3") blocks.push({ type: "h3", text });
    else if (/^h[4-6]$/.test(tag)) blocks.push({ type: tag, text });
    else if (tag === "li") blocks.push({ type: "li", text });
    else if (tag === "tr") blocks.push({ type: "tableRow", text, cells });
    else blocks.push({ type: "p", text });
  }
  return blocks;
}

async function docxBlocks(filePath, stat) {
  stat = stat ?? (await ensureReadable(filePath));
  const cached = cacheGet(filePath, stat);
  if (cached) return cached;
  const mammoth = (await import("mammoth")).default;
  const convertImage = mammoth.images.imgElement(async (image) => {
    const data = await image.readAsBuffer();
    return { src: `data:${image.contentType};base64,${data.toString("base64")}` };
  });
  const { value: html } = await mammoth.convertToHtml({ path: filePath }, { convertImage });
  const blocks = htmlToBlocks(html);
  // Headers/footers, footnotes and comments live in separate XML parts.
  const extra = await docxExtraBlocks(filePath);
  const merged = [];
  let table = null;
  for (const block of blocks) {
    if (block.type === "tableRow") {
      const cells = block.cells ?? block.text.split(/\s{2,}|\t/).filter(Boolean);
      if (!table) table = { type: "table", rows: [] };
      table.rows.push(cells);
      continue;
    }
    if (table) {
      merged.push(table);
      table = null;
    }
    merged.push(block);
  }
  if (table) merged.push(table);
  const result = [...extra.header, ...merged, ...extra.footer, ...extra.notes];
  cacheSet(filePath, stat, result);
  return result;
}

// Headers/footers/footnotes/comments/tracked changes from the zip parts
// mammoth does not surface in the body HTML.
async function docxExtraBlocks(filePath) {
  const extra = { header: [], footer: [], notes: [] };
  try {
    const { unzipSync } = await import("fflate");
    const raw = new Uint8Array(await fs.readFile(filePath));
    const files = unzipSync(raw);
    const decoder = new TextDecoder("utf-8");
    const textOf = (xml) => decodeEntities(String(xml ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    for (const name of Object.keys(files).sort()) {
      const xml = decoder.decode(files[name]);
      if (/^word\/header\d*\.xml$/.test(name)) {
        const text = textOf(xml);
        if (text) extra.header.push({ type: "header", text });
      } else if (/^word\/footer\d*\.xml$/.test(name)) {
        const text = textOf(xml);
        if (text) extra.footer.push({ type: "footer", text });
      } else if (name === "word/footnotes.xml") {
        for (const m of xml.matchAll(/<w:footnote[^>]*>([\s\S]*?)<\/w:footnote>/g)) {
          const text = textOf(m[1]);
          if (text) extra.notes.push({ type: "footnote", text });
        }
      } else if (name === "word/comments.xml") {
        for (const m of xml.matchAll(/<w:comment[^>]*>([\s\S]*?)<\/w:comment>/g)) {
          const text = textOf(m[1]);
          if (text) extra.notes.push({ type: "comment", text });
        }
      }
    }
    // Tracked insertions/deletions in the body.
    const body = files["word/document.xml"] ? decoder.decode(files["word/document.xml"]) : "";
    for (const m of body.matchAll(/<w:(ins|del)[^>]*>([\s\S]*?)<\/w:\1>/g)) {
      const text = textOf(m[2]);
      if (text) extra.notes.push({ type: m[1] === "ins" ? "insertion" : "deletion", text });
    }
    // TOC / field instructions.
    for (const m of body.matchAll(/<w:instrText[^>]*>([\s\S]*?)<\/w:instrText>/g)) {
      const text = textOf(m[1]);
      if (text) extra.notes.push({ type: "field", text });
    }
  } catch (err) { console.error("[granka docxExtra]", err?.message ?? err); }
  return extra;
}

async function plainText(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  if (kindOf(filePath) === "md") {
    // Inline small local images as data URLs so the model (and chat
    // markdown, which only allows https/data) can actually see them.
    const dir = path.dirname(filePath);
    let out = raw;
    for (const match of raw.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)) {
      const src = match[2];
      if (/^(https?:|data:)/.test(src)) continue;
      try {
        const imagePath = path.resolve(dir, src);
        const stat = await fs.stat(imagePath);
        if (stat.size > 200_000) continue;
        const ext = path.extname(imagePath).toLowerCase();
        const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" }[ext];
        if (!mime) continue;
        const dataUrl = `data:${mime};base64,${(await fs.readFile(imagePath)).toString("base64")}`;
        out = out.split(match[0]).join(`![${match[1]}](${dataUrl})`);
      } catch {}
    }
    return out;
  }
  if (kindOf(filePath) === "html") {
    // Keep document structure: headings/lists/tables become readable lines
    // instead of one flattened blob.
    const blocks = htmlToBlocks(raw);
    return blocks.map((block) => block.type === "table" ? block.rows.map((row) => row.join(" | ")).join("\n") : block.text ?? "").filter(Boolean).join("\n\n");
  }
  return raw;
}

// markdown-lite used by doc_create: headings, lists, tables, paragraphs
export function parseMarkdownLite(source) {
  const lines = String(source ?? "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let table = null;
  const flushTable = () => {
    if (table && table.rows.length) blocks.push(table);
    table = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushTable();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushTable();
      const level = Math.min(heading[1].length, 6);
      blocks.push({ type: `h${level}`, text: heading[2] });
      continue;
    }
    const image = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(trimmed);
    if (image) {
      flushTable();
      blocks.push({ type: "image", alt: image[1], src: image[2] });
      continue;
    }
    if (/^\|.*\|$/.test(trimmed)) {
      const cells = trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
      if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue; // separator row
      if (!table) table = { type: "table", rows: [] };
      table.rows.push(cells);
      continue;
    }
    flushTable();
    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      blocks.push({ type: "li", text: bullet[2], level: Math.min(Math.floor(bullet[1].length / 2), 2) });
      continue;
    }
    const numbered = /^(\s*)\d+\.\s+(.*)$/.exec(line);
    if (numbered) {
      blocks.push({ type: "li", text: numbered[2], ordered: true, level: Math.min(Math.floor(numbered[1].length / 2), 2) });
      continue;
    }
    blocks.push({ type: "p", text: trimmed });
  }
  flushTable();
  return blocks;
}

function stripInline(text) {
  return text.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\*([^*]+)\*/g, "$1");
}

function inlineRuns(text, base = {}) {
  const parts = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(text))) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index), ...base });
    const token = match[0];
    if (token.startsWith("**")) parts.push({ text: token.slice(2, -2), bold: true, ...base });
    else if (token.startsWith("`")) parts.push({ text: token.slice(1, -1), mono: true, ...base });
    else parts.push({ text: token.slice(1, -1), italic: true, ...base });
    last = pattern.lastIndex;
  }
  if (last < text.length) parts.push({ text: text.slice(last), ...base });
  return parts.filter((part) => part.text);
}

// ------------------------------------------------------------------- docx IO

async function writeDocx(filePath, blocks, style) {
  const docx = await import("docx");
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell, WidthType, BorderStyle, Header, Footer, PageNumber } = docx;

  const font = FONTS[style.font]?.docx ?? FONTS.sans.docx;
  const size = style.size ?? 11;             // pt
  const half = Math.round(size * 2);         // docx uses half-points
  const accent = (style.accent ?? "1f4e79").replace("#", "").toUpperCase();
  const margins = Math.round((style.margin ?? 2) * 567); // cm -> twips (1cm ≈ 567)

  // docx needs TextRun instances, not plain objects
  const runsOf = (text, base = {}) =>
    inlineRuns(text, base).map(
      (run) =>
        new TextRun({
          text: run.text,
          bold: run.bold,
          italics: run.italic,
          font: run.mono ? "Consolas" : run.font ?? base.font,
          size: run.size ?? base.size,
          color: run.color ?? base.color,
        }),
    );

  const headingLevels = {
    h1: HeadingLevel.HEADING_1,
    h2: HeadingLevel.HEADING_2,
    h3: HeadingLevel.HEADING_3,
    h4: HeadingLevel.HEADING_4,
    h5: HeadingLevel.HEADING_5,
    h6: HeadingLevel.HEADING_6,
  };

  const children = [];
  for (const block of blocks) {
    if (block.type === "image") {
      const data = block.data ?? (block.src ? Buffer.from(String(block.src).split(",")[1] ?? "", "base64") : null);
      const type = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/bmp": "bmp" }[block.contentType ?? ""];
      if (data && type) {
        children.push(new Paragraph({ children: [new docx.ImageRun({ data, type, transformation: { width: 480, height: 360 } })] }));
      } else if (block.alt) {
        children.push(new Paragraph({ children: runsOf(`[картинка: ${block.alt}]`, { font, size: half }) }));
      }
      continue;
    }
    if (block.type in headingLevels) {
      children.push(
        new Paragraph({
          heading: headingLevels[block.type],
          spacing: { before: 240, after: 120 },
          children: runsOf(block.text, { font, size: Math.round(half * 1.25), bold: true, color: accent }),
        }),
      );
      continue;
    }
    if (block.type === "li") {
      const level = Math.min(Number(block.level) || 0, 2);
      children.push(
        new Paragraph({
          bullet: block.ordered ? undefined : { level },
          numbering: block.ordered ? { reference: "ordered", level } : undefined,
          indent: level ? { left: level * 360 } : undefined,
          spacing: { after: 60 },
          children: runsOf(block.text, { font, size: half }),
        }),
      );
      continue;
    }
    if (block.type === "table") {
      const rows = block.rows.map(
        (cells, rowIndex) =>
          new TableRow({
            children: cells.map(
              (cell) =>
                new TableCell({
                  margins: { top: 60, bottom: 60, left: 100, right: 100 },
                  shading: rowIndex === 0 ? { fill: style.tableHeadFill ?? "EFF3F8" } : undefined,
                  children: [
                    new Paragraph({
                      children: runsOf(cell, { font, size: half, bold: rowIndex === 0 }),
                    }),
                  ],
                }),
            ),
          }),
      );
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          borders: {
            top: { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" },
            bottom: { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" },
            left: { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" },
            right: { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" },
            insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: "D9D9D9" },
            insideVertical: { style: BorderStyle.SINGLE, size: 2, color: "D9D9D9" },
          },
          rows,
        }),
      );
      children.push(new Paragraph({ text: "", spacing: { after: 120 } }));
      continue;
    }
    children.push(
      new Paragraph({
        spacing: { after: 120, line: Math.round((style.lineHeight ?? 1.4) * 240) },
        alignment: style.align === "justify" ? AlignmentType.JUSTIFIED : undefined,
        children: runsOf(block.text, { font, size: half }),
      }),
    );
  }

  const document = new Document({
    title: style.title || "",
    author: style.author || "granka",
    description: style.description || "",
    numbering: {
      config: [
        {
          reference: "ordered",
          levels: [
            { level: 0, format: "decimal", text: "%1.", alignment: AlignmentType.START },
            { level: 1, format: "decimal", text: "%2.", alignment: AlignmentType.START },
            { level: 2, format: "decimal", text: "%3.", alignment: AlignmentType.START },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: style.page === "letter" ? { width: 12240, height: 15840 } : undefined,
            margin: { top: margins, right: margins, bottom: margins, left: margins },
          },
        },
        headers: style.header
          ? { default: new Header({ children: [new Paragraph({ children: runsOf(style.header, { font, size: half - 2, color: "666666" }) })] }) }
          : undefined,
        footers: style.footer
          ? {
              default: new Footer({
                children: [
                  new Paragraph({
                    alignment: AlignmentType.CENTER,
                    children: [
                      ...runsOf(style.footer, { font, size: half - 2, color: "666666" }),
                      new TextRun({ text: "  ", font, size: half - 2 }),
                      new TextRun({ children: [PageNumber.CURRENT], font, size: half - 2, color: "666666" }),
                    ],
                  }),
                ],
              }),
            }
          : undefined,
        children,
      },
    ],
  });

  const buffer = await Packer.toBuffer(document);
  await fs.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  await fs.writeFile(filePath, buffer);
  return { bytes: buffer.length, blocks: blocks.length };
}

async function patchDocxXml(filePath, patch) {
  const { unzipSync, zipSync } = await import("fflate");
  const raw = await fs.readFile(filePath);
  const files = unzipSync(new Uint8Array(raw));
  const documentXml = new TextDecoder().decode(files["word/document.xml"]);
  const patched = patch(documentXml);
  if (patched === documentXml) throw new Error("в документе не найдено указанное место");
  files["word/document.xml"] = new TextEncoder().encode(patched);
  const out = zipSync(files);
  await fs.writeFile(filePath, Buffer.from(out));
  return { bytes: out.length };
}

function xmlEscape(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Replace across Word runs: a phrase split over several <w:t> elements
// (Word does this constantly) is matched on the concatenated paragraph
// text and rewritten into the first run, keeping its styling.
function replaceAcrossRuns(xml, find, replacement) {
  const findEsc = xmlEscape(find);
  if (!findEsc) return xml;
  // Fast path: phrase inside a single run.
  if (xml.includes(findEsc)) return xml.split(findEsc).join(xmlEscape(replacement));
  const textOfRun = (runXml) => decodeEntities(runXml.replace(/<[^>]+>/g, ""));
  return xml.replace(/<w:p[\s\S]*?<\/w:p>/g, (paragraph) => {
    const runs = [...paragraph.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)];
    if (!runs.length) return paragraph;
    const full = runs.map((r) => textOfRun(r[1])).join("");
    if (!full.includes(find)) return paragraph;
    const next = full.split(find).join(replacement);
    let out = paragraph;
    let first = true;
    for (const run of runs) {
      const tag = `<w:t${run[0].includes("xml:space") ? ' xml:space="preserve"' : ""}>${xmlEscape(first ? next : "")}</w:t>`;
      out = out.replace(run[0], tag);
      first = false;
    }
    return out;
  });
}

function paragraphXml(text, style = {}) {
  const runs = inlineRuns(text)
    .map((run) => {
      const props = [
        run.bold ? "<w:b/>" : "",
        run.italic ? "<w:i/>" : "",
        style.font ? `<w:rFonts w:ascii="${style.font}" w:hAnsi="${style.font}"/>` : "",
        style.size ? `<w:sz w:val="${style.size}"/>` : "",
        style.color ? `<w:color w:val="${style.color}"/>` : "",
      ].join("");
      const rPr = props ? `<w:rPr>${props}</w:rPr>` : "";
      return `<w:r>${rPr}<w:t xml:space="preserve">${xmlEscape(run.text)}</w:t></w:r>`;
    })
    .join("");
  const pPr = style.heading
    ? `<w:pPr><w:pStyle w:val="${style.heading}"/></w:pPr>`
    : style.bullet
      ? '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>'
      : "";
  return `<w:p>${pPr}${runs}</w:p>`;
}

// ------------------------------------------------------------- PDF rendering

async function writePdf(filePath, blocks, style) {
  const { PDFDocument, StandardFonts, rgb } = await import("@cantoo/pdf-lib");
  const fontkit = (await import("@pdf-lib/fontkit")).default;
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const family = FONTS[style.font]?.pdf ?? FONTS.sans.pdf;
  const unicode = await findUnicodeFont(style.font ?? "sans");
  // Embed a real Unicode font when the system has one (Cyrillic and other
  // non-Latin scripts), otherwise fall back to the built-in Latin-only fonts.
  const regular = unicode
    ? await doc.embedFont(unicode.regular)
    : await doc.embedFont(StandardFonts[family[0]]);
  const bold = unicode
    ? await doc.embedFont(unicode.bold)
    : await doc.embedFont(StandardFonts[family[1]]);

  const [pageWidth, pageHeight] = PAGE_SIZES[style.page] ?? PAGE_SIZES.a4;
  const margin = (style.margin ?? 2) * 28.35; // cm -> points
  const size = style.size ?? 11;
  const lineGap = size * (style.lineHeight ?? 1.4);
  const hex = (style.accent ?? "#1f4e79").replace("#", "");
  const accent = rgb(
    parseInt(hex.slice(0, 2), 16) / 255,
    parseInt(hex.slice(2, 4), 16) / 255,
    parseInt(hex.slice(4, 6), 16) / 255,
  );
  const ink = rgb(0.1, 0.1, 0.12);
  const grey = rgb(0.42, 0.42, 0.46);

  let page = doc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  const newPage = () => {
    page = doc.addPage([pageWidth, pageHeight]);
    y = pageHeight - margin;
  };

  const wrap = (text, font, fontSize, maxWidth) => {
    const words = stripInline(text).split(/\s+/);
    const lines = [];
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, fontSize) > maxWidth && current) {
        lines.push(current);
        current = word;
      } else current = candidate;
    }
    if (current) lines.push(current);
    return lines;
  };

  const drawLines = (text, { font, fontSize, color, indent = 0, bullet }) => {
    const maxWidth = pageWidth - margin * 2 - indent;
    const lines = wrap(text, font, fontSize, maxWidth);
    lines.forEach((line, index) => {
      if (y - lineGap < margin) newPage();
      y -= lineGap;
      if (bullet && index === 0) {
        page.drawText("•", { x: margin + indent - 10, y: y + fontSize * 0.25, size: fontSize, font, color });
      }
      page.drawText(line, { x: margin + indent, y: y + fontSize * 0.25, size: fontSize, font, color });
    });
  };

  const drawTable = (rows) => {
    if (!rows.length) return;
    const columns = Math.max(...rows.map((row) => row.length));
    const tableWidth = pageWidth - margin * 2;
    const colWidth = tableWidth / columns;
    const fontSize = size - 1;

    for (const [rowIndex, row] of rows.entries()) {
      const cellLines = row.map((cell) => wrap(cell, rowIndex === 0 ? bold : regular, fontSize, colWidth - 12));
      const height = Math.max(...cellLines.map((lines) => lines.length)) * (fontSize * 1.35) + 10;
      if (y - height < margin) newPage();
      if (rowIndex === 0) {
        page.drawRectangle({ x: margin, y: y - height, width: tableWidth, height, color: rgb(0.93, 0.95, 0.98) });
      }
      page.drawLine({
        start: { x: margin, y: y - height },
        end: { x: margin + tableWidth, y: y - height },
        thickness: 0.5,
        color: rgb(0.78, 0.8, 0.84),
      });
      cellLines.forEach((lines, cellIndex) => {
        lines.forEach((line, lineIndex) => {
          page.drawText(line, {
            x: margin + cellIndex * colWidth + 6,
            y: y - 12 - lineIndex * fontSize * 1.35,
            size: fontSize,
            font: rowIndex === 0 ? bold : regular,
            color: ink,
          });
        });
      });
      y -= height;
    }
    y -= 8;
  };

  for (const block of blocks) {
    if (block.type === "h1") {
      if (y - lineGap * 2 < margin) newPage();
      y -= lineGap * 0.6;
      drawLines(block.text, { font: bold, fontSize: size + 8, color: accent });
      y -= 4;
      continue;
    }
    if (block.type === "h2") {
      y -= lineGap * 0.4;
      drawLines(block.text, { font: bold, fontSize: size + 5, color: accent });
      continue;
    }
    if (block.type === "h3") {
      drawLines(block.text, { font: bold, fontSize: size + 2, color: accent });
      continue;
    }
    if (block.type === "h4") {
      drawLines(block.text, { font: bold, fontSize: size, color: ink });
      continue;
    }
    if (block.type === "li") {
      drawLines(block.text, { font: regular, fontSize: size, color: ink, indent: 16, bullet: true });
      continue;
    }
    if (block.type === "table") {
      drawTable(block.rows);
      continue;
    }
    drawLines(block.text, { font: regular, fontSize: size, color: ink });
    y -= 2;
  }

  // header / footer with page numbers
  const pages = doc.getPages();
  pages.forEach((current, index) => {
    if (style.header) {
      current.drawText(style.header, {
        x: margin,
        y: pageHeight - margin / 2,
        size: size - 2,
        font: regular,
        color: grey,
      });
    }
    if (style.footer) {
      current.drawText(`${style.footer}  ${index + 1} / ${pages.length}`, {
        x: margin,
        y: margin / 2,
        size: size - 2,
        font: regular,
        color: grey,
      });
    }
  });

  const bytes = await doc.save({ useObjectStreams: true });
  await fs.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  await fs.writeFile(filePath, Buffer.from(bytes));
  return { bytes: bytes.length, pages: doc.getPageCount(), unicodeFont: Boolean(unicode) };
}

function styleOf(raw = {}) {
  return {
    font: raw.font ?? "sans",
    size: Number(raw.size ?? 11),
    lineHeight: Number(raw.lineHeight ?? 1.4),
    margin: Number(raw.margin ?? 2),
    accent: (raw.accent ?? "1f4e79").replace("#", ""),
    header: raw.header ?? "",
    footer: raw.footer ?? "",
    page: raw.page ?? "a4",
    tableHeadFill: raw.tableHeadFill ?? "EFF3F8",
    align: raw.align ?? "left",
    title: raw.title ?? "",
    author: raw.author ?? "",
    description: raw.description ?? "",
  };
}

// -------------------------------------------------------------------- tools

// Fill one form field trying each field kind in turn (text, checkbox,
// dropdown/combo, option list, radio group). No flatten: the form survives.
function tryFillField(form, field, value) {
  const attempts = [
    () => form.getTextField(field).setText(String(value)),
    () => (value ? form.getCheckBox(field).check() : form.getCheckBox(field).uncheck()),
    () => form.getDropdown(field).select(String(value)),
    () => form.getOptionList(field).select([String(value)]),
    () => form.getRadioGroup(field).select(String(value)),
  ];
  for (const attempt of attempts) {
    try { attempt(); return true; } catch {}
  }
  return false;
}

// Real redaction: decode each page content stream, drop text-showing
// operators (Tj/TJ) whose Tm text position falls inside the rect, then
// re-encode. The caller paints an opaque rectangle over what remains
// (vector graphics), so text is neither visible nor extractable.
async function redactPageText(page, rect, lib) {
  const { PDFName } = lib;
  const { decompressSync, zlibSync } = await import("fflate");
  let removed = 0;
  const raw = page.node.get(PDFName.of("Contents"));
  if (!raw) return 0;
  const refs = raw.asArray ? raw.asArray() : [raw];
  for (const ref of refs) {
    let stream;
    try { stream = page.doc.context.lookup(ref); } catch { continue; }
    if (!stream?.getContents) continue;
    let decoded;
    try { decoded = decompressSync(stream.getContents()); } catch { continue; }
    const text = new TextDecoder("latin1").decode(decoded);
    // Tokenize operator-by-operator: Tm/Td move the text cursor, Tj/TJ show.
    const tokenRe = /(-?[0-9.]+) (-?[0-9.]+) (-?[0-9.]+) (-?[0-9.]+) (-?[0-9.]+) (-?[0-9.]+) Tm|(-?[0-9.]+) (-?[0-9.]+) Td|<[0-9A-Fa-f]*> Tj|\[[^\]]*\] TJ/g;
    let tx = 0;
    let ty = 0;
    let out = "";
    let last = 0;
    let match;
    let changed = false;
    while ((match = tokenRe.exec(text)) !== null) {
      if (match[1] !== undefined) {
        tx = Number(match[5]);
        ty = Number(match[6]);
      } else if (match[7] !== undefined) {
        tx += Number(match[7]);
        ty += Number(match[8]);
      } else {
        const inside = tx >= rect.x && tx <= rect.x + rect.width && ty >= rect.y && ty <= rect.y + rect.height;
        if (inside) {
          out += text.slice(last, match.index);
          last = match.index + match[0].length;
          removed += 1;
          changed = true;
          continue;
        }
      }
    }
    if (changed) {
      out += text.slice(last);
      stream.updateContents(zlibSync(new TextEncoder().encode(out)));
    }
  }
  return removed;
}

export function createDocTools(host) {
  const outlineTool = {
    name: "doc_outline",
    label: "Структура документа",
    description:
      "Shows the structure of a PDF/DOCX/MD/TXT without the full text: page count, headings, tables. " +
      "Always start document work with this tool instead of reading the whole file.",
    promptSnippet: "doc_outline: PDF/DOCX structure (pages, headings, tables)",
    parameters: Type.Object({
      path: Type.String({ description: "Путь к файлу" }),
    }),
    execute: async (_id, params) => {
      const filePath = path.resolve(host.resolve(params.path));
      await ensureReadable(filePath);
      const kind = kindOf(filePath);

      if (kind === "pdf") {
        const { totalPages, pages } = await pdfText(filePath);
        const summary = pages.slice(0, 20).map((text, index) => {
          const head = text.replace(/\s+/g, " ").trim().slice(0, 110);
          return `стр. ${index + 1}: ${head || "(пусто — возможно скан без текстового слоя, OCR не поддерживается)"}`;
        });
        return {
          content: [{ type: "text", text: `PDF, страниц: ${totalPages}\n${summary.join("\n")}` }],
          details: { kind, pages: totalPages },
        };
      }

      if (kind === "docx") {
        const blocks = await docxBlocks(filePath);
        const headings = blocks.filter((block) => /^h[1-6]$/.test(block.type));
        const tables = blocks.filter((block) => block.type === "table");
        const text = blocks.map((block) => block.text ?? "").join("\n");
        const lines = [
          `DOCX, блоков: ${blocks.length}, таблиц: ${tables.length}`,
          headings.length ? `Заголовки:\n${headings.map((h) => `${h.type}: ${h.text}`).join("\n")}` : "Заголовков нет",
        ];
        return {
          content: [{ type: "text", text: `${lines.join("\n")}\nПервые строки:\n${text.slice(0, 600)}` }],
          details: { kind, blocks: blocks.length, tables: tables.length },
        };
      }

      if (["xlsx", "ods", "csv", "rtf"].includes(kind)) {
        const blocks = await sheetBlocks(filePath);
        const tables = blocks.filter((block) => block.type === "table");
        const preview = blocks.map((block) => block.type === "table" ? block.rows.map((row) => row.join(" | ")).join("\n") : block.text ?? "").join("\n").slice(0, 600);
        return {
          content: [{ type: "text", text: `${kind.toUpperCase()}, блоков: ${blocks.length}, таблиц: ${tables.length}\n${preview}` }],
          details: { kind, blocks: blocks.length, tables: tables.length },
        };
      }

      const text = await plainText(filePath);
      const headings = text
        .split("\n")
        .filter((line) => /^#{1,6}\s+/.test(line))
        .slice(0, 30);
      return {
        content: [
          {
            type: "text",
            text: `${kind.toUpperCase()}, символов: ${text.length}\n${headings.join("\n") || text.slice(0, 400)}`,
          },
        ],
        details: { kind, chars: text.length },
      };
    },
  };

  const readTool = {
    name: "doc_read",
    label: "Чтение документа",
    description:
      "Returns document text: for PDF by pages (from/to), for DOCX by blocks. " +
      "Output is capped so it does not flood the context; if truncated, a hint names the next page.",
    promptSnippet: "doc_read: read PDF/DOCX pages/blocks",
    parameters: Type.Object({
      path: Type.String({ description: "Путь к файлу" }),
      from: Type.Optional(Type.Number({ description: "Начальная страница (PDF) или блок (DOCX), с 1" })),
      to: Type.Optional(Type.Number({ description: "Конечная страница/блок включительно" })),
      limit: Type.Optional(Type.Number({ description: "Лимит символов; по умолчанию — лимит вывода инструментов из настроек" })),
    }),
    execute: async (_id, params) => {
      const filePath = path.resolve(host.resolve(params.path));
      await ensureReadable(filePath);
      const kind = kindOf(filePath);
      const limit = Math.min(Math.max(Number(params.limit) || toolOutputLimit(), 500), 24000);

      if (kind === "pdf") {
        const { totalPages, pages } = await pdfText(filePath);
        const from = Math.min(Math.max(Number(params.from) || 1, 1), totalPages);
        const to = Math.min(Number(params.to) || from + 2, totalPages);
        const slice = pages.slice(from - 1, to);
        const text = slice.map((page, index) => `--- стр. ${from + index} ---\n${page.trim()}`).join("\n\n");
        const clipped = clip(text, limit);
        const hint = clipped.truncated || to < totalPages ? `\n\n[дальше: doc_read(from=${to + 1})]` : "";
        return {
          content: [{ type: "text", text: clipped.text + hint }],
          details: { kind, from, to, totalPages, truncated: clipped.truncated },
        };
      }

      if (kind === "docx") {
        const blocks = await docxBlocks(filePath);
        const from = Math.max(Number(params.from) || 1, 1);
        const to = Math.min(Number(params.to) || from + 40, blocks.length);
        const slice = blocks.slice(from - 1, to);
        const text = slice
          .map((block, index) =>
            block.type === "table"
              ? `[таблица ${from + index}]\n${block.rows.map((row) => row.join(" | ")).join("\n")}`
              : `${block.type === "p" ? "" : `${block.type.toUpperCase()}: `}${stripInline(block.text)}`,
          )
          .join("\n");
        const clipped = clip(text, limit);
        const hint = clipped.truncated || to < blocks.length ? `\n\n[дальше: doc_read(from=${to + 1})]` : "";
        return {
          content: [{ type: "text", text: clipped.text + hint }],
          details: { kind, from, to, total: blocks.length },
        };
      }

      if (["xlsx", "ods", "csv", "rtf"].includes(kind)) {
        const blocks = await sheetBlocks(filePath);
        const from = Math.max(Number(params.from) || 1, 1);
        const to = Math.min(Number(params.to) || from + 40, blocks.length);
        const text = blocks.slice(from - 1, to)
          .map((block, index) => block.type === "table" ? `[таблица ${from + index}]\n${block.rows.map((row) => row.join(" | ")).join("\n")}` : block.text ?? "")
          .join("\n");
        const clipped = clip(text, limit);
        return { content: [{ type: "text", text: clipped.text }], details: { kind, from, to, total: blocks.length } };
      }

      const text = await plainText(filePath);
      const clipped = clip(text, limit);
      return { content: [{ type: "text", text: clipped.text }], details: { kind, truncated: clipped.truncated } };
    },
  };

  const searchTool = {
    name: "doc_search",
    label: "Поиск в документе",
    description: "Searches a string in a PDF/DOCX and returns pages/blocks with fragments. Case-insensitive.",
    promptSnippet: "doc_search: найти фрагмент в документе по страницам",
    parameters: Type.Object({
      path: Type.String({ description: "Путь к файлу" }),
      query: Type.String({ description: "Что искать" }),
    }),
    execute: async (_id, params) => {
      const filePath = path.resolve(host.resolve(params.path));
      await ensureReadable(filePath);
      const needle = String(params.query ?? "").toLowerCase();
      if (!needle) return { content: [{ type: "text", text: "Empty query." }], details: {} };
      const kind = kindOf(filePath);

      const units =
        kind === "pdf"
          ? (await pdfText(filePath)).pages.map((text, index) => ({ label: `стр. ${index + 1}`, text }))
          : kind === "docx"
            ? (await docxBlocks(filePath)).map((block, index) => ({
                label: `блок ${index + 1}`,
                text: block.type === "table" ? block.rows.map((row) => row.join(" ")).join(" ") : block.text,
              }))
            : ["xlsx", "ods", "csv", "rtf"].includes(kind)
              ? (await sheetBlocks(filePath)).map((block, index) => ({
                  label: `блок ${index + 1}`,
                  text: block.type === "table" ? block.rows.map((row) => row.join(" ")).join(" ") : block.text,
                }))
              : [{ label: "файл", text: await plainText(filePath) }];

      const hits = [];
      for (const unit of units) {
        const haystack = String(unit.text ?? "").toLowerCase();
        let index = haystack.indexOf(needle);
        while (index >= 0 && hits.length < SEARCH_HITS) {
          hits.push(`${unit.label}: …${String(unit.text).slice(Math.max(0, index - 60), index + 90).replace(/\s+/g, " ")}…`);
          index = haystack.indexOf(needle, index + needle.length);
        }
        if (hits.length >= SEARCH_HITS) break;
      }
      return {
        content: [{ type: "text", text: hits.length ? hits.join("\n") : `Не найдено: ${params.query}` }],
        details: { hits: hits.length },
      };
    },
  };

  const createTool = {
    name: "doc_create",
    label: "Создать документ",
    description:
      "Creates a DOCX or PDF from markdown-like text (# headings, - lists, | tables |) with styling: " +
      "font (sans/serif/mono), size, line spacing, margins in cm, accent colour, headers/footers, page format. " +
      "The format is taken from the file extension.",
    promptSnippet: "doc_create: create a styled DOCX/PDF from markdown",
    parameters: Type.Object({
      path: Type.String({ description: "Куда сохранить (.docx или .pdf)" }),
      content: Type.String({ description: "Содержимое в markdown-lite" }),
      style: Type.Optional(
        Type.Object({
          font: Type.Optional(Type.Union([Type.Literal("sans"), Type.Literal("serif"), Type.Literal("mono")])),
          size: Type.Optional(Type.Number({ description: "Кегль, pt" })),
          lineHeight: Type.Optional(Type.Number({ description: "Множитель интервала" })),
          margin: Type.Optional(Type.Number({ description: "Поля, см" })),
          accent: Type.Optional(Type.String({ description: "Цвет заголовков, hex без #" })),
          header: Type.Optional(Type.String()),
          footer: Type.Optional(Type.String()),
          page: Type.Optional(Type.Union([Type.Literal("a4"), Type.Literal("letter"), Type.Literal("a5")])),
          align: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("justify")])),
        }),
      ),
    }),
    execute: async (_id, params) => {
      const filePath = path.resolve(host.resolve(params.path));
      const blocks = parseMarkdownLite(params.content);
      if (!blocks.length) return { content: [{ type: "text", text: "Пустое содержимое." }], details: {} };
      const style = styleOf(params.style);
      const kind = kindOf(filePath);

      if (kind === "docx") {
        const result = await writeDocx(filePath, blocks, style);
        host.emit({ kind: "doc", action: "create", path: filePath });
        return { content: [{ type: "text", text: `DOCX создан: ${filePath} (${result.blocks} блоков, ${result.bytes} B)` }], details: result };
      }
      if (kind === "pdf") {
        const result = await writePdf(filePath, blocks, style);
        host.emit({ kind: "doc", action: "create", path: filePath });
        const note = result.unicodeFont ? "" : " · шрифт без Unicode: не-латиница может не отобразиться";
        return {
          content: [{ type: "text", text: `PDF создан: ${filePath} (${result.pages} стр., ${result.bytes} B)${note}` }],
          details: result,
        };
      }
      if (kind === "md" || kind === "txt" || kind === "html") {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, params.content, "utf8");
        return { content: [{ type: "text", text: `Файл записан: ${filePath}` }], details: {} };
      }
      return { content: [{ type: "text", text: "Поддерживаются .docx, .pdf, .md, .txt, .html" }], details: {} };
    },
  };

// Version history: before every destructive edit/format, copy the original
// to <file>.granka-versions/<timestamp>.<ext> (keeps the last 10) so a
// document can always be rolled back next to itself.
async function backupDocumentVersion(filePath) {
  try {
    const dir = `${filePath}.granka-versions`;
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await fs.copyFile(filePath, path.join(dir, `${stamp}${path.extname(filePath)}`));
    const versions = (await fs.readdir(dir)).sort();
    for (const old of versions.slice(0, Math.max(0, versions.length - 10))) {
      await fs.rm(path.join(dir, old), { force: true });
    }
    return dir;
  } catch (err) {
    console.error("[granka doc version]", err?.message ?? err);
    return "";
  }
}

  const editTool = {
    name: "doc_edit",
    label: "Правка документа",
    description:
      "Targeted edits. DOCX: replace text (replace: find and replace required), append paragraphs/headings/tables (append). " +
      "PDF: add text to a page (add_text: page/text/x/y), redact text (real removal from the content stream plus a patch), new page (add_page), fill form fields (fill_form: fields; text, checkbox, list, radio), merge files (merge: source or sources), rotate (rotate: degrees), delete/extract/reorder pages (delete_pages/extract_pages/reorder_pages: pages), split (split: at). " +
      "Before editing, the original is kept in <file>.granka-versions/ — restore by copying back. " +
      "For document-wide fonts and margins use doc_format.",
    promptSnippet: "doc_edit: targeted DOCX/PDF edits",
    parameters: Type.Object({
      path: Type.String({ description: "Путь к файлу" }),
      ops: Type.Optional(
        Type.Array(
          Type.Object({
            type: Type.Union([
              Type.Literal("replace"),
              Type.Literal("append"),
              Type.Literal("add_text"),
              Type.Literal("redact"),
              Type.Literal("add_page"),
              Type.Literal("fill_form"),
              Type.Literal("merge"),
              Type.Literal("rotate"),
              Type.Literal("delete_pages"),
              Type.Literal("extract_pages"),
              Type.Literal("reorder_pages"),
              Type.Literal("split"),
            ]),
            find: Type.Optional(Type.String()),
            replace: Type.Optional(Type.String()),
            content: Type.Optional(Type.String()),
            heading: Type.Optional(Type.Boolean({ description: "append как заголовок" })),
            page: Type.Optional(Type.Number({ description: "Страница PDF, с 1" })),
            x: Type.Optional(Type.Number()),
            y: Type.Optional(Type.Number()),
            width: Type.Optional(Type.Number()),
            height: Type.Optional(Type.Number()),
            size: Type.Optional(Type.Number()),
            text: Type.Optional(Type.String()),
            fields: Type.Optional(Type.Record(Type.String(), Type.String())),
            source: Type.Optional(Type.String({ description: "Путь к PDF для merge" })),
            sources: Type.Optional(Type.Array(Type.String())),
            degrees: Type.Optional(Type.Number()),
            pages: Type.Optional(Type.Array(Type.Number())),
            at: Type.Optional(Type.Number()),
          }),
        ),
      ),
    }),
    execute: async (_id, params) => {
      const filePath = path.resolve(host.resolve(params.path));
      await ensureReadable(filePath);
      const kind = kindOf(filePath);
      const ops = params.ops ?? [];
      if (!ops.length) return { content: [{ type: "text", text: "Нет операций." }], details: {} };
      const versionDir = await backupDocumentVersion(filePath);
      const log = [];

      if (kind === "docx") {
        for (const op of ops) {
          if (op.type === "replace") {
            if (!op.find) throw new Error("replace требует find");
            await patchDocxXml(filePath, (xml) => replaceAcrossRuns(xml, op.find, op.replace ?? ""));
            log.push(`заменено «${op.find}» → «${op.replace ?? ""}»`);
            continue;
          }
          if (op.type === "append") {
            const xml = paragraphXml(op.content ?? op.text ?? "", {
              heading: op.heading ? "Heading1" : undefined,
            });
            await patchDocxXml(filePath, (body) => body.replace(/<\/w:body>/, `${xml}</w:body>`));
            log.push("добавлен абзац в конец");
            continue;
          }
          log.push(`пропущено для DOCX: ${op.type}`);
        }
        host.emit({ kind: "doc", action: "edit", path: filePath });
        return { content: [{ type: "text", text: `${filePath}\n${log.join("\n")}` }], details: { ops: log.length } };
      }

      if (kind === "pdf") {
        const { PDFDocument, StandardFonts, rgb } = await import("@cantoo/pdf-lib");
        const fontkit = (await import("@pdf-lib/fontkit")).default;
        const existing = await fs.readFile(filePath);
        const doc = await PDFDocument.load(existing);
        doc.registerFontkit(fontkit);
        const unicode = await findUnicodeFont("sans");
        const font = unicode ? await doc.embedFont(unicode.regular) : await doc.embedFont(StandardFonts.Helvetica);
        let dirty = false;

        for (const op of ops) {
          if (op.type === "add_text") {
            const page = doc.getPage(Math.min(Math.max((op.page ?? 1) - 1, 0), doc.getPageCount() - 1));
            page.drawText(op.text ?? "", {
              x: op.x ?? 40,
              y: op.y ?? page.getHeight() - 60,
              size: op.size ?? 11,
              font,
              color: rgb(0.1, 0.1, 0.12),
            });
            log.push(`текст добавлен на стр. ${op.page ?? 1}`);
            dirty = true;
          } else if (op.type === "redact") {
            const page = doc.getPage(Math.min(Math.max((op.page ?? 1) - 1, 0), doc.getPageCount() - 1));
            const rect = { x: op.x ?? 40, y: op.y ?? 40, width: op.width ?? 200, height: op.height ?? 16 };
            let removed = 0;
            try {
              removed = await redactPageText(page, rect, await import("@cantoo/pdf-lib"));
            } catch (err) { console.error("[granka redact]", err?.message ?? err); }
            // Opaque cover on top of whatever glyphs remain (e.g. vector text).
            page.drawRectangle({ ...rect, color: rgb(1, 1, 1) });
            log.push(`закрашено на стр. ${op.page ?? 1}: удалено текстовых блоков ${removed}`);
            dirty = true;
          } else if (op.type === "add_page") {
            if (doc.getPageCount() === 0) throw new Error("пустой PDF: не с чем взять размер страницы");
            doc.addPage([doc.getPage(0).getWidth(), doc.getPage(0).getHeight()]);
            log.push("добавлена страница");
            dirty = true;
          } else if (op.type === "fill_form") {
            const form = doc.getForm();
            const filled = [];
            for (const [field, value] of Object.entries(op.fields ?? {})) {
              const done = tryFillField(form, field, value);
              if (done) filled.push(field);
              else log.push(`поле не найдено: ${field}`);
            }
            // NOTE: no flatten() — the form stays editable after filling.
            log.push(`заполнено полей: ${filled.length}`);
            dirty = true;
          } else if (op.type === "rotate") {
            const { degrees } = await import("@cantoo/pdf-lib");
            const page = doc.getPage(Math.min(Math.max((op.page ?? 1) - 1, 0), doc.getPageCount() - 1));
            const current = page.getRotation().angle;
            page.setRotation(degrees((current + (Number(op.degrees) || 90)) % 360));
            log.push(`поворот стр. ${op.page ?? 1} на ${Number(op.degrees) || 90}°`);
            dirty = true;
          } else if (op.type === "delete_pages" || op.type === "extract_pages" || op.type === "reorder_pages") {
            const count = doc.getPageCount();
            const pagesIn = (op.pages ?? op.indices ?? []).map((p) => Number(p) - 1).filter((i) => i >= 0 && i < count);
            if (!pagesIn.length) throw new Error(`${op.type}: нет действительных страниц`);
            const keep = op.type === "delete_pages"
              ? Array.from({ length: count }, (_v, i) => i).filter((i) => !pagesIn.includes(i))
              : pagesIn;
            if (!keep.length) throw new Error(`${op.type}: не останется страниц`);
            if (keep.length > MAX_PAGES) throw new Error(`слишком много страниц: ${keep.length} (лимит ${MAX_PAGES})`);
            const copied = await doc.copyPages(doc, keep);
            for (let i = count - 1; i >= 0; i -= 1) doc.removePage(i);
            copied.forEach((p) => doc.addPage(p));
            log.push(`${op.type}: страниц теперь ${keep.length}`);
            dirty = true;
          } else if (op.type === "split") {
            const count = doc.getPageCount();
            const at = Math.min(Math.max(Number(op.at) || Math.floor(count / 2), 1), count - 1);
            const first = await doc.copyPages(doc, Array.from({ length: at }, (_v, i) => i));
            const second = await doc.copyPages(doc, Array.from({ length: count - at }, (_v, i) => at + i));
            const outDir = path.dirname(filePath);
            const base = path.basename(filePath, path.extname(filePath));
            const part1 = path.join(outDir, `${base}-part1.pdf`);
            const part2 = path.join(outDir, `${base}-part2.pdf`);
            const doc1 = await PDFDocument.create();
            first.forEach((p) => doc1.addPage(p));
            await fs.writeFile(part1, Buffer.from(await doc1.save()));
            const doc2 = await PDFDocument.create();
            second.forEach((p) => doc2.addPage(p));
            await fs.writeFile(part2, Buffer.from(await doc2.save()));
            log.push(`разделено на ${part1} и ${part2}`);
            dirty = true;
          } else if (op.type === "merge") {
            const sources = op.sources ?? (op.source ? [op.source] : []);
            if (!sources.length) throw new Error("merge: не указан source/sources");
            for (const source of sources) {
              const sourcePath = assertNotSensitive(host.resolve(source));
              await ensureReadable(sourcePath);
              if (kindOf(sourcePath) !== "pdf") throw new Error("merge: source должен быть PDF");
              const extra = await PDFDocument.load(await fs.readFile(sourcePath));
              if (doc.getPageCount() + extra.getPageCount() > MAX_PAGES) throw new Error(`merge: суммарно больше ${MAX_PAGES} страниц`);
              const pages = await doc.copyPages(extra, extra.getPageIndices());
              pages.forEach((page) => doc.addPage(page));
              log.push(`добавлено страниц из ${source}: ${pages.length}`);
            }
            dirty = true;
          } else {
            log.push(`пропущено для PDF: ${op.type}`);
          }
        }

        if (dirty) {
          const bytes = await doc.save();
          await fs.writeFile(filePath, Buffer.from(bytes));
          host.emit({ kind: "doc", action: "edit", path: filePath });
        }
        return { content: [{ type: "text", text: `${filePath}\n${log.join("\n")}` }], details: { ops: log.length } };
      }

      return { content: [{ type: "text", text: "doc_edit работает с .docx и .pdf" }], details: {}, isError: true };
    },
  };

  const formatTool = {
    name: "doc_format",
    label: "Оформление документа",
    description:
      "Restyles the whole document: font (sans/serif/mono), size, spacing, margins in cm, heading accent colour, " +
      "headers/footers with page numbers, page format, alignment. The document is redrawn: " +
      "text, headings, lists and tables are preserved, fine layout (images, manual breaks) is not.",
    promptSnippet: "doc_format: one document style (font, margins, headers/footers)",
    parameters: Type.Object({
      path: Type.String({ description: "Путь к .docx или .pdf" }),
      style: Type.Object({
        font: Type.Optional(Type.Union([Type.Literal("sans"), Type.Literal("serif"), Type.Literal("mono")])),
        size: Type.Optional(Type.Number({ description: "Кегль, pt" })),
        lineHeight: Type.Optional(Type.Number()),
        margin: Type.Optional(Type.Number({ description: "Поля, см" })),
        accent: Type.Optional(Type.String({ description: "hex без #" })),
        header: Type.Optional(Type.String()),
        footer: Type.Optional(Type.String()),
        page: Type.Optional(Type.Union([Type.Literal("a4"), Type.Literal("letter"), Type.Literal("a5")])),
        align: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("justify")])),
      }),
    }),
    execute: async (_id, params) => {
      const filePath = path.resolve(host.resolve(params.path));
      await ensureReadable(filePath);
      const kind = kindOf(filePath);
      const style = styleOf(params.style);
      await backupDocumentVersion(filePath);

      if (kind === "docx") {
        const blocks = await docxBlocks(filePath);
        const result = await writeDocx(filePath, blocks, style);
        host.emit({ kind: "doc", action: "format", path: filePath });
        return { content: [{ type: "text", text: `DOCX переоформлен: ${filePath} (${result.blocks} блоков)` }], details: result };
      }
      if (kind === "pdf") {
        const { pages } = await pdfText(filePath);
        const blocks = [];
        pages.forEach((page, index) => {
          const text = page.trim();
          if (!text) return;
          if (index === 0) blocks.push({ type: "h1", text: text.split("\n")[0].slice(0, 90) });
          for (const line of text.split("\n").slice(index === 0 ? 1 : 0)) {
            if (line.trim()) blocks.push({ type: "p", text: line.trim() });
          }
        });
        const result = await writePdf(filePath, blocks, style);
        host.emit({ kind: "doc", action: "format", path: filePath });
        return { content: [{ type: "text", text: `PDF переоформлен: ${filePath} (${result.pages} стр.)` }], details: result };
      }
      return { content: [{ type: "text", text: "doc_format работает с .docx и .pdf" }], details: {}, isError: true };
    },
  };

  const batchTool = {
    name: "doc_batch",
    label: "Пакетный поиск по папке",
    description:
      "Searches a query across all supported documents (PDF/DOCX/XLSX/ODS/CSV/RTF/MD/TXT) " +
      "in a folder and returns per-file hit counts with the first fragment. " +
      "Use to scan a whole folder of documents at once instead of per-file doc_search.",
    promptSnippet: "doc_batch: поиск запроса по всем документам в папке",
    parameters: Type.Object({
      dir: Type.String({ description: "Папка с документами" }),
      query: Type.String({ description: "Что искать" }),
    }),
    execute: async (_id, params) => {
      const dirPath = path.resolve(host.resolve(String(params.dir ?? "")));
      const needle = String(params.query ?? "").trim();
      if (!needle) return { content: [{ type: "text", text: "Empty query." }], details: {} };
      let entries;
      try {
        entries = await fs.readdir(dirPath, { withFileTypes: true });
      } catch (err) {
        return { content: [{ type: "text", text: `Не удалось прочитать папку: ${err?.message ?? err}` }], details: {} };
      }
      const files = entries
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(dirPath, entry.name))
        .filter((file) => !["other", "html"].includes(kindOf(file)))
        .slice(0, 40);
      if (!files.length) {
        return { content: [{ type: "text", text: `В папке нет поддерживаемых документов: ${dirPath}` }], details: {} };
      }
      // Limited fan-out: documents parse in the main process, so a flat
      // Promise.all over 40 files would spike CPU/memory. 4 workers keep
      // the scan fast without freezing the app; order is preserved.
      const results = new Array(files.length);
      const hitsByIndex = new Array(files.length).fill(0);
      let next = 0;
      const worker = async () => {
        while (next < files.length) {
          const index = next++;
          const file = files[index];
          try {
            const result = await searchTool.execute("doc_batch", { path: file, query: needle });
            const hits = result.details?.hits ?? 0;
            hitsByIndex[index] = hits;
            const first = hits ? String(result.content[0]?.text ?? "").split("\n")[0] : "";
            results[index] = `${path.basename(file)}: ${hits ? `${hits} совп. · ${first}` : "нет совпадений"}`;
          } catch (err) {
            results[index] = `${path.basename(file)}: ошибка (${err?.message ?? err})`;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, files.length) }, () => worker()));
      const total = hitsByIndex.reduce((sum, n) => sum + n, 0);
      const lines = [`Документов: ${files.length}, запрос: «${needle}»`, ...results];
      return { content: [{ type: "text", text: lines.join("\n") }], details: { files: files.length, hits: total } };
    },
  };

  return { outlineTool, readTool, searchTool, createTool, editTool, formatTool, batchTool };
}
