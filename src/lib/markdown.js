// Tiny, dependency-free Markdown → HTML renderer for the in-app preview.
// Intentionally limited: headings, emphasis, inline/fenced code, links,
// images, blockquotes, ordered/unordered lists, task list items and rules.
// All input is HTML-escaped before any markup is produced, so rendering is
// safe for untrusted document content.

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inline(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2" />');
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return out;
}

export function renderMarkdown(md) {
  const lines = String(md || "").replace(/\r\n?/g, "\n").split("\n");
  const html = [];
  let i = 0;
  let listType = null;

  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      closeList();
      const lang = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // consume closing fence
      html.push(
        `<pre class="md-pre"><code${lang ? ` class="lang-${escapeHtml(lang)}"` : ""}>${escapeHtml(
          body.join("\n")
        )}</code></pre>`
      );
      continue;
    }

    // horizontal rule
    if (/^\s*([-*_])\s*\1\s*\1[\s\S]*$/.test(line) && line.replace(/[\s\-*_]/g, "") === "") {
      closeList();
      html.push("<hr />");
      i++;
      continue;
    }

    // headings
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    // blockquote
    if (/^>\s?/.test(line)) {
      closeList();
      const body = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      html.push(`<blockquote>${inline(body.join(" "))}</blockquote>`);
      continue;
    }

    // lists
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const want = ul ? "ul" : "ol";
      if (listType !== want) {
        closeList();
        html.push(`<${want}>`);
        listType = want;
      }
      let content = (ul || ol)[1];
      let cls = "";
      const task = content.match(/^\[([ xX])\]\s+(.*)$/);
      if (task) {
        const checked = task[1].toLowerCase() === "x" ? " checked" : "";
        content = `<input type="checkbox" disabled${checked} /> ${task[2]}`;
        cls = ' class="md-task"';
      } else {
        content = inline(content);
      }
      html.push(`<li${cls}>${content}</li>`);
      i++;
      continue;
    }

    // blank
    if (!line.trim()) {
      closeList();
      i++;
      continue;
    }

    // paragraph (merge consecutive plain lines)
    closeList();
    const para = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    html.push(`<p>${inline(para.join(" "))}</p>`);
  }

  closeList();
  return html.join("\n");
}
