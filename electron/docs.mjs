// Document tools: PDF and DOCX read/create/edit/format with pure-JS libraries
// (unpdf, @cantoo/pdf-lib, mammoth, docx, fflate). No native binaries, no
// services, works the same on Linux, macOS and Windows.
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";

// Single source of truth for tool-output size: the same toolOutputLimit the
// agent applies globally (agent.mjs clip). Previously doc_read defaulted to
// 8000+ while the global clip cut everything to 4000 — the tool promised
// more than the model ever saw.
function toolOutputLimit() {
  try {
    const cfg = JSON.parse(fsSync.readFileSync(path.join(os.homedir(), ".granka", "granka.json"), "utf8"));
    const n = Number(cfg.toolOutputLimit);
    if (Number.isFinite(n) && n >= 500 && n <= 20000) return n;
  } catch (err) { console.error("[granka docs]", err?.message ?? err); }
  return 4000;
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
  if (ext === ".md") return "md";
  if (ext === ".txt") return "txt";
  if (ext === ".html" || ext === ".htm") return "html";
  return "other";
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

async function pdfText(filePath, stat) {
  stat = stat ?? (await ensureReadable(filePath));
  const cached = cacheGet(filePath, stat);
  if (cached) return cached;
  const { getDocumentProxy, extractText } = await import("unpdf");
  const buffer = await fs.readFile(filePath);
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  if (totalPages > MAX_PAGES) throw new Error(`слишком много страниц: ${totalPages} (лимит ${MAX_PAGES})`);
  const result = { totalPages, pages: text.map((page) => String(page ?? "")) };
  cacheSet(filePath, stat, result);
  return result;
}

// Cheap metadata for attachments: page/block counts shown in the chip so
// the user sees what they attached without opening the file.
export async function docInfo(filePath) {
  try {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".pdf") {
      const { totalPages } = await pdfText(filePath);
      return { pages: totalPages };
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
  const hasImages = /<img\b/i.test(html);
  const pattern = /<(h[1-6]|p|li|tr)[^>]*>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    const tag = match[1].toLowerCase();
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
    if (!text) continue;
    if (tag === "h1") blocks.push({ type: "h1", text });
    else if (tag === "h2") blocks.push({ type: "h2", text });
    else if (tag === "h3") blocks.push({ type: "h3", text });
    else if (/^h[4-6]$/.test(tag)) blocks.push({ type: tag, text });
    else if (tag === "li") blocks.push({ type: "li", text });
    else if (tag === "tr") blocks.push({ type: "tableRow", text, cells });
    else blocks.push({ type: "p", text });
  }
  if (hasImages) blocks.push({ type: "note", text: "⚠ в документе есть картинки: они не переносятся в текстовые блоки" });
  return blocks;
}

async function docxBlocks(filePath, stat) {
  stat = stat ?? (await ensureReadable(filePath));
  const cached = cacheGet(filePath, stat);
  if (cached) return cached;
  const mammoth = (await import("mammoth")).default;
  const { value: html } = await mammoth.convertToHtml({ path: filePath });
  const blocks = htmlToBlocks(html);
  // merge consecutive table rows into a table
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
  cacheSet(filePath, stat, merged);
  return merged;
}

async function plainText(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  if (kindOf(filePath) === "html") return decodeEntities(raw.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
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
      const level = Math.min(heading[1].length, 4);
      blocks.push({ type: `h${level}`, text: heading[2] });
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
    const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      blocks.push({ type: "li", text: bullet[1] });
      continue;
    }
    const numbered = /^\d+\.\s+(.*)$/.exec(trimmed);
    if (numbered) {
      blocks.push({ type: "li", text: numbered[1], ordered: true });
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
  };

  const children = [];
  for (const block of blocks) {
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
      children.push(
        new Paragraph({
          bullet: block.ordered ? undefined : { level: 0 },
          numbering: block.ordered ? { reference: "ordered", level: 0 } : undefined,
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
    numbering: {
      config: [
        {
          reference: "ordered",
          levels: [{ level: 0, format: "decimal", text: "%1.", alignment: AlignmentType.START }],
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

  const bytes = await doc.save();
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
  };
}

// -------------------------------------------------------------------- tools

export function createDocTools(host) {
  const outlineTool = {
    name: "doc_outline",
    label: "Структура документа",
    description:
      "Показывает структуру PDF/DOCX/MD/TXT без полного текста: число страниц, заголовки, таблицы. " +
      "Всегда начинай работу с документа этим инструментом, чтобы не читать файл целиком.",
    promptSnippet: "doc_outline: структура PDF/DOCX (страницы, заголовки, таблицы)",
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
          return `стр. ${index + 1}: ${head || "(пусто)"}`;
        });
        return {
          content: [{ type: "text", text: `PDF, страниц: ${totalPages}\n${summary.join("\n")}` }],
          details: { kind, pages: totalPages },
        };
      }

      if (kind === "docx") {
        const blocks = await docxBlocks(filePath);
        const headings = blocks.filter((block) => /^h[1-4]$/.test(block.type));
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

      const text = await plainText(filePath);
      const headings = text
        .split("\n")
        .filter((line) => /^#{1,4}\s+/.test(line))
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
      "Возвращает текст документа: для PDF — по страницам (from/to), для DOCX — по блокам. " +
      "Вывод ограничен, чтобы не забивать контекст; если обрезано, будет подсказка со следующей страницей.",
    promptSnippet: "doc_read: прочитать страницы/блоки PDF/DOCX",
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

      const text = await plainText(filePath);
      const clipped = clip(text, limit);
      return { content: [{ type: "text", text: clipped.text }], details: { kind, truncated: clipped.truncated } };
    },
  };

  const searchTool = {
    name: "doc_search",
    label: "Поиск в документе",
    description: "Ищет строку в PDF/DOCX и возвращает страницы/блоки с фрагментами. Регистр не важен.",
    promptSnippet: "doc_search: найти фрагмент в документе по страницам",
    parameters: Type.Object({
      path: Type.String({ description: "Путь к файлу" }),
      query: Type.String({ description: "Что искать" }),
    }),
    execute: async (_id, params) => {
      const filePath = path.resolve(host.resolve(params.path));
      await ensureReadable(filePath);
      const needle = String(params.query ?? "").toLowerCase();
      if (!needle) return { content: [{ type: "text", text: "Пустой запрос." }], details: {} };
      const kind = kindOf(filePath);

      const units =
        kind === "pdf"
          ? (await pdfText(filePath)).pages.map((text, index) => ({ label: `стр. ${index + 1}`, text }))
          : kind === "docx"
            ? (await docxBlocks(filePath)).map((block, index) => ({
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
      "Создаёт DOCX или PDF из markdown-подобного текста (# заголовки, - списки, | таблицы |) с оформлением: " +
      "шрифт (sans/serif/mono), размер, межстрочный интервал, поля в см, акцентный цвет, колонтитулы, формат страницы. " +
      "Формат определяется по расширению файла.",
    promptSnippet: "doc_create: создать DOCX/PDF из markdown с оформлением",
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

  const editTool = {
    name: "doc_edit",
    label: "Правка документа",
    description:
      "Точечные правки. DOCX: заменить текст (replace: обязательны find и replace), добавить абзацы/заголовок/таблицу в конец (append). " +
      "PDF: добавить текст на страницу (add_text: нужны page/text/x/y), белую плашку (redact: page/x/y/width/height), новую страницу (add_page), вписать поля формы (fill_form: нужны fields), объединить файлы (merge: нужен source). " +
      "Для смены шрифтов и полей всего документа используй doc_format.",
    promptSnippet: "doc_edit: точечные правки DOCX/PDF",
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
      const log = [];

      if (kind === "docx") {
        for (const op of ops) {
          if (op.type === "replace") {
            if (!op.find) throw new Error("replace требует find");
            await patchDocxXml(filePath, (xml) =>
              xml.split(xmlEscape(op.find)).join(xmlEscape(op.replace ?? "")),
            );
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
            page.drawRectangle({
              x: op.x ?? 40,
              y: op.y ?? 40,
              width: op.width ?? 200,
              height: op.height ?? 16,
              color: rgb(1, 1, 1),
            });
            log.push(`плашка на стр. ${op.page ?? 1}`);
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
              try {
                form.getTextField(field).setText(value);
                filled.push(field);
              } catch {
                try {
                  form.getCheckBox(field).check();
                  filled.push(field);
                } catch {
                  log.push(`поле не найдено: ${field}`);
                }
              }
            }
            form.flatten();
            log.push(`заполнено полей: ${filled.length}`);
            dirty = true;
          } else if (op.type === "merge") {
            if (!op.source) throw new Error("merge: не указан source");
            const sourcePath = assertNotSensitive(host.resolve(op.source));
            await ensureReadable(sourcePath);
            if (kindOf(sourcePath) !== "pdf") throw new Error("merge: source должен быть PDF");
            const extra = await PDFDocument.load(await fs.readFile(sourcePath));
            if (doc.getPageCount() + extra.getPageCount() > MAX_PAGES) throw new Error(`merge: суммарно больше ${MAX_PAGES} страниц`);
            const pages = await doc.copyPages(extra, extra.getPageIndices());
            pages.forEach((page) => doc.addPage(page));
            log.push(`добавлено страниц из ${op.source}: ${pages.length}`);
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

      return { content: [{ type: "text", text: "doc_edit работает с .docx и .pdf" }], details: {} };
    },
  };

  const formatTool = {
    name: "doc_format",
    label: "Оформление документа",
    description:
      "Меняет оформление всего документа: шрифт (sans/serif/mono), кегль, интервал, поля в см, акцентный цвет заголовков, " +
      "колонтитулы с номерами страниц, формат страницы, выравнивание. Документ перерисовывается: " +
      "текст, заголовки, списки и таблицы сохраняются, тонкая вёрстка (картинки, ручные переносы) — нет.",
    promptSnippet: "doc_format: единый стиль документа (шрифт, поля, колонтитулы)",
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
      return { content: [{ type: "text", text: "doc_format работает с .docx и .pdf" }], details: {} };
    },
  };

  return { outlineTool, readTool, searchTool, createTool, editTool, formatTool };
}
