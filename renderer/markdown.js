// Minimal, safe markdown renderer: escapes HTML first, then applies a few
// inline/block patterns. No dependencies, no raw HTML pass-through.
function escapeHtml(text) {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

// Tiny safe highlighter for fenced code: input is already HTML-escaped, so
// the tokenizer only wraps spans around keywords, strings, numbers and
// comments without ever creating markup from the code itself.
const KEYWORDS = [
  "const", "let", "var", "function", "return", "if", "else", "for", "while", "do",
  "switch", "case", "break", "continue", "new", "class", "extends", "import", "export",
  "from", "default", "async", "await", "try", "catch", "finally", "throw", "typeof",
  "instanceof", "in", "of", "void", "delete", "yield", "static", "this", "super",
  "null", "undefined", "true", "false", "fn", "def", "print", "lambda", "pass",
  "raise", "with", "as", "assert", "global", "nonlocal", "del", "is", "not", "and",
  "or", "public", "private", "protected", "int", "float", "double", "char", "bool",
  "interface", "enum", "impl", "struct", "trait", "match", "object", "val",
  "constructor", "operator", "inline", "internal", "open", "abstract", "final",
  "override", "suspend", "fun", "when", "data", "companion", "init", "lazy", "by",
];

function highlightCode(code) {
  // Input comes from the already-escaped markdown text: do not escape again,
  // just wrap token spans. Strings appear as &quot;...&quot; / &#39;...&#39;.
  const escaped = code;
  const tokenPattern = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|&quot;.*?&quot;|&#39;.*?&#39;|\b\d[\d_]*(?:\.\d+)?\b)/g;
  const wordPattern = new RegExp("\\b(?:" + KEYWORDS.join("|") + ")\\b", "g");
  const paintWords = (chunk, out) =>
    out + chunk.replace(wordPattern, (word) => '<span class="tok-kw">' + word + "</span>");
  let out = "";
  let last = 0;
  let match;
  while ((match = tokenPattern.exec(escaped))) {
    out = paintWords(escaped.slice(last, match.index), out);
    const token = match[0];
    let cls = "tok-kw";
    if (token.startsWith("&quot;") || token.startsWith("&#39;")) cls = "tok-str";
    else if (token.startsWith("//") || token.startsWith("#") || token.startsWith("/*")) cls = "tok-com";
    else if (/^[0-9]/.test(token)) cls = "tok-num";
    out += '<span class="' + cls + '">' + token + "</span>";
    last = match.index + token.length;
  }
  return paintWords(escaped.slice(last), out);
}

function mdToHtml(source) {
  const stash = [];
  const keep = (html) => `\u0000${stash.push(html) - 1}\u0000`;

  let text = escapeHtml(source)
    .replace(
      /```[ \t]*(\w*)\n([\s\S]*?)```/g,
      (_m, lang, code) => keep(`<pre><code class="lang-${lang}">${highlightCode(code.replace(/\n$/, ""))}</code></pre>`),
    )
    .replace(/`([^`\n]+)`/g, (_m, code) => keep(`<code>${code}</code>`))
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    // Images first, before links eat the bracket part: http(s) only, plus
    // small raster data: URLs (no SVG — XSS vector).
    .replace(/!\[([^\]\n]*)\]\((data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]{100,200000})\)/g, '<img src="$2" alt="$1" loading="lazy" />')
    .replace(/!\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/g, '<img src="$2" alt="$1" loading="lazy" />')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');

  const isTableRow = (line) => /^\s*\|?.+\|.*$/.test(line) && line.includes("|");
  const isTableSeparator = (line) =>
    /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line) && line.includes("-");

  const splitCells = (line) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());

  const alignmentsOf = (line) =>
    splitCells(line).map((cell) => {
      const left = cell.startsWith(":");
      const right = cell.endsWith(":");
      if (left && right) return "center";
      if (right) return "right";
      if (left) return "left";
      return "";
    });

  const renderTable = (headerLine, separatorLine, bodyLines) => {
    const header = splitCells(headerLine);
    const aligns = alignmentsOf(separatorLine);
    const cell = (tag, content, index) => {
      const align = aligns[index] ? ` class="align-${aligns[index]}"` : "";
      return `<${tag}${align}>${content}</${tag}>`;
    };
    const head = `<thead><tr>${header.map((text, index) => cell("th", text, index)).join("")}</tr></thead>`;
    const body = bodyLines.length
      ? `<tbody>${bodyLines
          .map((line) => `<tr>${splitCells(line).map((text, index) => cell("td", text, index)).join("")}</tr>`)
          .join("")}</tbody>`
      : "";
    return `<div class="mdTableWrap"><table>${head}${body}</table></div>`;
  };

  const blocks = [];
  for (const raw of text.split(/\n{2,}/)) {
    const block = raw.trim();
    if (!block) continue;
    const stashRef = /^\u0000(\d+)\u0000$/.exec(block);
    if (stashRef && stash[Number(stashRef[1])].startsWith("<pre")) {
      blocks.push(block); // fenced code stands on its own, inline code does not
      continue;
    }
    const lines = block.split("\n");

    // GFM table: header row, separator row, then body rows
    if (lines.length >= 2 && isTableRow(lines[0]) && isTableSeparator(lines[1])) {
      let end = 2;
      while (end < lines.length && isTableRow(lines[end]) && !isTableSeparator(lines[end])) end += 1;
      blocks.push(renderTable(lines[0], lines[1], lines.slice(2, end)));
      const rest = lines.slice(end).join("\n").trim();
      if (rest) blocks.push(`<p>${rest}</p>`);
      continue;
    }

    if (/^\s*(>|&gt;)/.test(lines[0])) {
      const quoted = lines
        .map((line) => line.replace(/^\s*(&gt;|>)\s?/, ""))
        .join("<br>")
        .trim();
      blocks.push(`<blockquote>${quoted}</blockquote>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(lines[0]);
    if (heading && lines.length === 1) {
      blocks.push(`<h${heading[1].length}>${heading[2]}</h${heading[1].length}>`);
      continue;
    }
    if (lines.every((line) => /^\s*([-*]|\d+\.)\s+/.test(line))) {
      const tag = /^\s*\d+\./.test(lines[0]) ? "ol" : "ul";
      const items = lines.map((line) => `<li>${line.replace(/^\s*([-*]|\d+\.)\s+/, "")}</li>`).join("");
      blocks.push(`<${tag}>${items}</${tag}>`);
      continue;
    }
    blocks.push(`<p>${lines.join("<br>")}</p>`);
  }

  return blocks.join("").replace(/\u0000(\d+)\u0000/g, (_m, index) => stash[Number(index)]);
}

globalThis.mdToHtml = mdToHtml;
