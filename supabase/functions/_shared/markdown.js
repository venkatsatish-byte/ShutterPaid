// A small, safe Markdown renderer for event instructions and policies.
// Supports paragraphs, line breaks, # headings, - and 1. lists, **bold**, *italic* and
// [links](https://...). Everything is HTML-escaped first, and only http(s) and mailto links
// are allowed, so photographer text can never inject markup or scripts into customer pages
// or emails. Shared by the app, the booking page, the tests and (later) Edge Functions.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SPMarkdown = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // Inline formatting on already-escaped text.
  function inline(text) {
    let out = text;
    // [label](url): only safe schemes; the URL is already escaped, so quotes can't break out.
    out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
      if (!/^(https?:\/\/|mailto:)/i.test(url)) return label;
      return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
    });
    // Bare links.
    out = out.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, (m, pre, url) => pre + '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>');
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    return out;
  }

  function toHtml(markdown) {
    const lines = esc(String(markdown || '').replace(/\r\n?/g, '\n')).split('\n');
    const html = [];
    let para = [];
    let list = null; // { tag, items }

    const flushPara = () => {
      if (para.length) html.push('<p>' + para.map(inline).join('<br>') + '</p>');
      para = [];
    };
    const flushList = () => {
      if (list) html.push('<' + list.tag + '>' + list.items.map((i) => '<li>' + inline(i) + '</li>').join('') + '</' + list.tag + '>');
      list = null;
    };

    lines.forEach((raw) => {
      const line = raw.trim();
      let m;
      if (!line) { flushPara(); flushList(); return; }
      if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) {
        flushPara(); flushList();
        // Headings in instructions are small: h3 to h5, so they sit below the page's own headings.
        const level = m[1].length + 2;
        html.push('<h' + level + '>' + inline(m[2]) + '</h' + level + '>');
        return;
      }
      if ((m = /^[-*•]\s+(.*)$/.exec(line)) || (m = /^\d+[.)]\s+(.*)$/.exec(line))) {
        flushPara();
        const tag = /^\d/.test(line) ? 'ol' : 'ul';
        if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
        list.items.push(m[1]);
        return;
      }
      flushList();
      para.push(line);
    });
    flushPara();
    flushList();
    return html.join('\n');
  }

  // Plain text for emails and calendar descriptions.
  function toText(markdown) {
    return String(markdown || '')
      .replace(/\r\n?/g, '\n')
      .replace(/^#{1,3}\s+/gm, '')
      .replace(/\*\*([^*\n]+)\*\*/g, '$1')
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
      .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
      .replace(/^\s*[*•]\s+/gm, '- ')
      .trim();
  }

  return { toHtml, toText, escape: esc };
});
