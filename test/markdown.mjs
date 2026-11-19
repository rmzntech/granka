// Check for renderer/markdown.js without a test framework.
import fs from "node:fs";
import assert from "node:assert/strict";

const source = fs.readFileSync(new URL("../renderer/markdown.js", import.meta.url), "utf8");
new Function(source)(); // defines globalThis.mdToHtml
const md = globalThis.mdToHtml;

assert.equal(md("**bold**"), "<p><strong>bold</strong></p>");
assert.equal(md("`a < b`"), "<p><code>a &lt; b</code></p>");
// Fenced code is highlighted (keywords/numbers wrapped) but stays escaped.
assert.equal(
  md("```js\nconst x = 1 < 2;\n```"),
  '<pre><code class="lang-js"><span class="tok-kw">const</span> x = <span class="tok-num">1</span> &lt; <span class="tok-num">2</span>;</code></pre>',
);
assert.match(md("```\n// hi\nx\n```"), /class="tok-com">\/\/ hi</);
assert.match(md("```\n\"str\"\n```"), /class="tok-str">/);
assert.equal(md("# Заголовок"), "<h1>Заголовок</h1>");
assert.equal(md("- один\n- два"), "<ul><li>один</li><li>два</li></ul>");
assert.equal(md("1. один\n2. два"), "<ol><li>один</li><li>два</li></ol>");
assert.equal(md("[pi](https://pi.dev)"), '<p><a href="https://pi.dev" target="_blank" rel="noreferrer">pi</a></p>');
// GFM tables: header, alignment, body
const table = md("| Метрика | Значение |\n|---|---:|\n| Строк | 120 |");
assert.match(table, /<table>/);
assert.match(table, /<th>Метрика<\/th>/);
assert.match(table, /<th class="align-right">Значение<\/th>/);
assert.match(table, /<td class="align-right">120<\/td>/);
assert.match(md("| a | b |\n|:--|:-:|\n| 1 | 2 |"), /align-center/);
assert.equal(md("| a | b |\n|---|---|"), '<div class="mdTableWrap"><table><thead><tr><th>a</th><th>b</th></tr></thead></table></div>');

// blockquotes
assert.equal(md("> цитата"), "<blockquote>цитата</blockquote>");
assert.equal(md("> одна\n> две"), "<blockquote>одна<br>две</blockquote>");

// HTML from the model must never become markup
assert.equal(md('<img src=x onerror="alert(1)">'), '<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>');
// asterisks inside inline code are not emphasis
assert.equal(md("`a*b*c`"), "<p><code>a*b*c</code></p>");
console.log("markdown ok");

// h5/h6 and images (https + raster data: only, no SVG)
assert.match(md("##### Пятый"), /<h5>Пятый<\/h5>/);
assert.match(md("###### Шестой"), /<h6>Шестой<\/h6>/);
assert.match(md("![кот](https://example.com/cat.png)"), /href="https:\/\/example\.com\/cat\.png"[^>]*class="extImg"/);
assert.doesNotMatch(md("![кот](https://example.com/cat.png)"), /<img src="https/);
assert.doesNotMatch(md("![x](data:image/svg+xml;base64,PHN2Zz4=)"), /<img/);
assert.doesNotMatch(md("![x](file:///etc/passwd)"), /<img/);
