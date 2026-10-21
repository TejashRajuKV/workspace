import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../src/lib/markdown.js";

test("headings render at the right level and escape HTML", () => {
  const html = renderMarkdown("# Title\n## Sub <script>");
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<h2>Sub &lt;script&gt;<\/h2>/);
  assert.doesNotMatch(html, /<script>/);
});

test("inline emphasis, code and links are converted", () => {
  const html = renderMarkdown("**bold** and *ital* and `code` and [site](https://x.test)");
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>ital<\/em>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<a href="https:\/\/x\.test" target="_blank" rel="noreferrer">site<\/a>/);
});

test("fenced code blocks are preserved verbatim and not parsed as markdown", () => {
  const html = renderMarkdown("```js\nconst a = 1 < 2;\n# not a heading\n```");
  assert.match(html, /<pre class="md-pre"><code class="lang-js">/);
  assert.match(html, /const a = 1 &lt; 2;/);
  assert.match(html, /# not a heading/);
  assert.doesNotMatch(html, /<h1>/);
});

test("lists, task items, blockquotes and rules render", () => {
  const ul = renderMarkdown("- one\n- two");
  assert.match(ul, /<ul>\n<li>one<\/li>\n<li>two<\/li>\n<\/ul>/);

  const ol = renderMarkdown("1. first\n2. second");
  assert.match(ol, /<ol>/);
  assert.match(ol, /<li>first<\/li>/);

  const task = renderMarkdown("- [x] done\n- [ ] todo");
  assert.match(task, /<li class="md-task"><input type="checkbox" disabled checked \/> done<\/li>/);
  assert.match(task, /<li class="md-task"><input type="checkbox" disabled \/> todo<\/li>/);

  const quote = renderMarkdown("> quoted text");
  assert.match(quote, /<blockquote>quoted text<\/blockquote>/);

  const hr = renderMarkdown("---");
  assert.match(hr, /<hr \/>/);
});

test("consecutive plain lines collapse into one paragraph", () => {
  const html = renderMarkdown("line one\nline two\n\nsecond para");
  assert.match(html, /<p>line one line two<\/p>/);
  assert.match(html, /<p>second para<\/p>/);
});

test("paragraphs are never left unclosed", () => {
  const html = renderMarkdown("# a\n\ntext\n\n- x\n\n> q");
  const opens = (html.match(/<p>/g) || []).length;
  const closes = (html.match(/<\/p>/g) || []).length;
  assert.equal(opens, closes);
  assert.equal((html.match(/<ul>/g) || []).length, (html.match(/<\/ul>/g) || []).length);
});

test("empty input is safe", () => {
  assert.equal(renderMarkdown(""), "");
  assert.equal(renderMarkdown(null), "");
});
