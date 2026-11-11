// Minimal, safe markdown renderer: escapes HTML first, then applies a few
// inline/block patterns. No dependencies, no raw HTML pass-through.
function escapeHtml(text) {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function mdToHtml(source) {
  const stash = [];
  const keep = (html) => `\u0000${stash.push(html) - 1}\u0000`;

  let text = escapeHtml(source)
    .replace(
      /```[ \t]*(\w*)\n([\s\S]*?)```/g,
      (_m, lang, code) => keep(`<pre><code class="lang-${lang}">${code.replace(/\n$/, "")}</code></pre>`),
    )
    .replace(/`([^`\n]+)`/g, (_m, code) => keep(`<code>${code}</code>`))
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>")
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
      const align = aligns[index] ? ` style="text-align:${aligns[index]}"` : "";
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

    const heading = /^(#{1,4})\s+(.*)$/.exec(lines[0]);
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
