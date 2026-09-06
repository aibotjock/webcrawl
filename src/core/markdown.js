// html -> markdown. domino DOM (turndown's own dep) + Readability + Turndown GFM.
// Clean-room reimplementation of observed Firecrawl markdown behavior.
import domino from '@mixmark-io/domino';
import TurndownService from 'turndown';
import { Readability } from '@mozilla/readability';
import { URL as U } from 'node:url';

// --- domino shims so Readability 0.6 runs on it (iterable node lists, baseURI) ---
{
  const d = domino.createDocument('<html><body></body></html>');
  let p = Object.getPrototypeOf(d.querySelectorAll('x'));
  while (p && !Object.getOwnPropertyNames(p).includes('item')) p = Object.getPrototypeOf(p);
  if (p && !p[Symbol.iterator]) {
    p[Symbol.iterator] = function* () {
      for (let i = 0; i < this.length; i++) yield this[i];
    };
    p.forEach = function (fn, self) {
      for (let i = 0; i < this.length; i++) fn.call(self, this[i], i, this);
    };
  }
  const EP = domino.impl.Element.prototype;
  if (!EP.append)
    EP.append = function (...ns) {
      for (const n of ns) this.appendChild(typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n);
    };
}

const BOILER = new Set(
  'cookie cookies consent banner sidebar breadcrumb breadcrumbs social-share social social-media social-links modal popup overlay newsletter footer nav navbar navigation menu masthead toolbar widget header hidden share ad ads advert lang-selector language-selector toc recommended comments comment'.split(
    ' '
  )
);
const STRIP = 'script,style,noscript,svg,iframe,form,head,meta,link,title';
const txt = (s) => (s || '').replace(/\s+/g, '').length;

const parse = (html, url) => {
  const doc = domino.createDocument(html);
  if (url) {
    Object.defineProperty(doc, 'baseURI', { value: url });
    Object.defineProperty(doc, 'documentURI', { value: url });
  }
  return doc;
};

// srcset -> single largest candidate (numeric descriptor; missing counts as 1)
function largestSrcset(srcset) {
  if (!srcset) return '';
  let best = '', bestN = -1;
  for (const part of srcset.split(',')) {
    const [url, d] = part.trim().split(/\s+/);
    const n = parseFloat(String(d || '').replace(/[^\d.]/g, '')) || 1;
    if (n >= bestN) { bestN = n; best = url; }
  }
  return best || '';
}

// Strip boilerplate, absolutize links, resolve/drop images. Mutates root's tree.
function clean(root, baseUrl, mainOnly) {
  for (const n of [...root.querySelectorAll(STRIP)]) if (n.parentNode) n.remove();
  if (mainOnly) {
    for (const n of [...root.querySelectorAll('header,footer,nav,aside')]) if (n.parentNode) n.remove();
    for (const n of [...root.querySelectorAll('[class],[id]')]) {
      const toks = `${n.getAttribute('class') || ''} ${n.getAttribute('id') || ''}`.toLowerCase().split(/[^a-z-]+/);
      if (toks.some((t) => BOILER.has(t)) && n.parentNode) n.remove();
    }
  }
  for (const img of [...root.querySelectorAll('img')]) {
    // Ad/tracking pixels: tiny dimensions or known ad-tech hosts (blockAds parity).
    const w = parseFloat(img.getAttribute('width') || '') || 0;
    const h = parseFloat(img.getAttribute('height') || '') || 0;
    const src0 = img.getAttribute('src') || '';
    if ((w > 0 && w <= 50) || (h > 0 && h <= 50) || /doubleclick|googlesyndication|scorecardresearch|adsystem|adservice|analytics|beacon|pixel|bbcdotcom|2x2|1x1/i.test(src0)) {
      if (img.parentNode) img.remove();
      continue;
    }
    const best = largestSrcset(img.getAttribute('srcset'));
    if (best) img.setAttribute('src', best);
    const src = img.getAttribute('src') || '';
    if (!src || src.startsWith('data:')) { if (img.parentNode) img.remove(); continue; }
    try { img.setAttribute('src', new U(src, baseUrl).href); } catch {}
  }
  for (const a of [...root.querySelectorAll('a[href]')]) {
    try { a.setAttribute('href', new U(a.getAttribute('href'), baseUrl).href); } catch {}
  }
}

const TD = new TurndownService({ gfm: true, headingStyle: 'atx', bulletListMarker: '-', br: '\\\n' });
TD.addRule('blankLink', {
  filter: (n) => n.nodeName === 'A' && !(n.textContent || '').trim() && !n.querySelector('img'),
  replacement: () => '',
});
// Card links (<a> wrapping block content — news front pages): flatten instead
// of emitting "[## Heading\n\nsummary](url)" pseudo-links. Heading text becomes
// the link; the rest renders as plain content.
TD.addRule('blockLink', {
  filter: (n) =>
    n.nodeName === 'A' && !!(n.querySelector && n.querySelector('p,div,h1,h2,h3,h4,h5,h6,ul,ol,table,figure,section,article')),
  replacement: (content, node) => {
    const href = node.getAttribute('href') || '';
    const link = (t) => (href ? `[${t}](${href})` : t);
    const m = content.match(/^#{1,6} .+$/m);
    if (m) {
      const head = m[0].replace(/^(#{1,6}) (.*)$/s, (_, hs, rest) => `${hs} ${link(rest.trim())}`);
      const body = (content.slice(0, m.index) + '\n' + content.slice(m.index + m[0].length)).trim();
      return `\n\n${head}\n\n${body}\n\n`;
    }
    const t = (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    return t ? `\n\n${link(t)}\n\n` : '';
  },
});
TD.addRule('fencedCodeBlock', {
  filter: (n) => n.nodeName === 'PRE',
  replacement: (_c, n) => {
    const code = n.querySelector('code') || n;
    const cls = `${n.getAttribute('class') || ''} ${n.querySelector('code')?.getAttribute('class') || ''}`;
    const lang = (cls.match(/(?:language-|highlight-source-|highlight-)([\w#+.-]+)/) || [])[1] || '';
    const text = (code.textContent || '').replace(/\s+$/, '');
    const fence = text.includes('```') ? '````' : '```';
    return `\n\n${fence}${lang}\n${text}\n${fence}\n\n`;
  },
});

// --- GFM tables: turndown 7 has no table rule, so tables are pre-rendered
// (deepest first) and swapped for alnum tokens that survive turndown verbatim;
// tokens become markdown again after conversion. Nested tables end up as tokens
// inside parent cells, so their lines splice mid-row like the bar.
const tableStore = new Map();

function cellMd(cell) {
  return TD.turndown(cell)
    .replace(/\s*\n\s*/g, " ")
    .replace(/\|/g, "\\|")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function tableMd(table) {
  const rows = [];
  for (const sect of table.childNodes) {
    if (sect.nodeName === "TR") rows.push(sect);
    else if (sect.nodeName === "THEAD" || sect.nodeName === "TBODY" || sect.nodeName === "TFOOT")
      for (const tr of sect.childNodes) if (tr.nodeName === "TR") rows.push(tr);
  }
  const grid = rows.map((tr) =>
    [...tr.childNodes].filter((c) => c.nodeName === "TD" || c.nodeName === "TH").map(cellMd)
  );
  if (!grid.length || !grid.some((r) => r.length)) return "";
  const n = Math.max(...grid.map((r) => r.length));
  const norm = grid.map((r) => [...r, ...Array(n - r.length).fill("")]);
  const hasTh = rows[0] && [...rows[0].childNodes].some((c) => c.nodeName === "TH");
  const header = hasTh ? norm[0] : Array(n).fill("");
  const body = hasTh ? norm.slice(1) : norm;
  const line = (r) => r.map((c) => `| ${c} `).join("").slice(0, -1) + " |";
  const sep = `| ${Array(n).fill("---").join(" | ")} |`;
  return expandTokens([line(header), sep, ...body.map(line)].join("\n"));
}

function expandTokens(md) {
  return md.replace(/wcMD[0-9a-f]{8}/g, (t) => tableStore.get(t) ?? t);
}

function transformTables(root) {
  for (const table of [...root.querySelectorAll("table")].reverse()) {
    const token = "wcMD" + Math.random().toString(16).slice(2, 10);
    tableStore.set(token, tableMd(table));
    const holder = table.ownerDocument.createElement("p");
    holder.textContent = token;
    if (table.parentNode) table.parentNode.replaceChild(holder, table);
  }
}


// Main-content HTML: Readability article when it captures most of the cleaned
// body (>= 2/3 — on sectioned reference/index pages Readability truncates hard),
// else the cleaned full body.
export function extractMain(html, baseUrl, { mainOnly = true } = {}) {
  const doc = parse(html, baseUrl);
  const docTitle = (doc.title || '').trim();
  const origH1 = doc.querySelector('h1'); // grab before Readability mutates the doc
  const full = parse(html, baseUrl);
  clean(full, baseUrl, mainOnly);
  const bodyText = txt(full.body?.textContent);
  const bodyLinks = full.body?.querySelectorAll('a[href]').length || 0;
  const bodyHeads = full.body?.querySelectorAll('h2,h3').length || 0;
  let r = null;
  if (mainOnly) { try { r = new Readability(doc).parse(); } catch {} }
  // Reject Readability when it truncates text (sectioned reference pages),
  // strips most links (card/list pages whose links ARE the content), or
  // drops section headings (modern wikipedia wraps h2 in divs Readability eats).
  let rLinks = 0;
  let rHeads = 0;
  if (r?.content) {
    const host = parse(r.content, baseUrl);
    rLinks = host.querySelectorAll('a[href]').length;
    rHeads = host.querySelectorAll('h2,h3').length;
  }
  if (r?.content && txt(r.textContent) >= 200 && txt(r.textContent) >= bodyText * (2 / 3) && rLinks >= bodyLinks * 0.5 && rHeads >= bodyHeads * 0.7) {
    const host = doc.createElement('div');
    host.innerHTML = r.content;
    if (!host.querySelector('h1')) {
      let h = null;
      if (origH1) {
        h = origH1.cloneNode(true);
        while (h.attributes.length) h.removeAttribute(h.attributes[0].name);
      } else if (r.title) {
        h = doc.createElement('h1');
        h.textContent = r.title;
      }
      if (h) host.insertBefore(h, host.firstChild);
    }
    clean(host, baseUrl, mainOnly);
    transformTables(host);
    return { contentHtml: host.innerHTML, title: r.title || docTitle };
  }
  transformTables(full);
  return { contentHtml: full.body?.innerHTML || '', title: docTitle };
}

export function htmlToMarkdown(html, { baseUrl } = {}) {
  const p = parse(html);
  const titleTag = (p.title || '').trim();
  const description = (
    p.querySelector('meta[name="description"]')?.getAttribute('content') ||
    p.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
    ''
  ).trim();
  tableStore.clear();
  const { contentHtml, title } = extractMain(html, baseUrl);
  let md = '';
  try { md = TD.turndown(contentHtml); } catch {}
  md = expandTokens(md)
    .replace(/^(\s*)-   /gm, '$1- ')
    .replace(/^[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { markdown: md, title: title || titleTag, description };
}
