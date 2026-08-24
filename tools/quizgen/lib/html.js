'use strict';
// Tiny HTML utilities — no DOM, no dependencies. Good enough for scraping
// well-formed server-rendered pages.

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  middot: '·', hellip: '…', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', ndash: '–', mdash: '—',
};

function decodeEntities(s) {
  if (!s) return '';
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X'
        ? parseInt(e.slice(2), 16)
        : parseInt(e.slice(1), 10);
      if (!isNaN(code)) {
        try { return String.fromCodePoint(code); } catch (_) { return m; }
      }
      return m;
    }
    return Object.prototype.hasOwnProperty.call(NAMED, e) ? NAMED[e] : m;
  });
}

function stripTags(s) {
  return (s || '').replace(/<[^>]*>/g, '');
}

// Convert an HTML fragment to readable plain text.
function htmlToText(html) {
  if (!html) return '';
  let s = html.replace(/\r\n?/g, '\n'); // normalize Windows/Mac newlines first
  s = s.replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ');
  s = s.replace(/<\s*br\s*\/?\s*>/gi, '\n');
  s = s.replace(/<\s*\/\s*(p|div|li|tr|h[1-6]|table|thead|tbody)\s*>/gi, '\n');
  s = s.replace(/<\s*(td|th)[^>]*>/gi, ' ');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/ /g, ' ');
  s = s.replace(/[ \t\f\v]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

// Return the inner HTML of the first element carrying id="wanted",
// balancing nested tags of the same name.
function extractById(html, wanted) {
  const openRe = new RegExp(
    `<([a-zA-Z][\\w-]*)\\b[^>]*\\bid\\s*=\\s*["']?${wanted}["'\\s>]`,
    'i'
  );
  const m = openRe.exec(html);
  if (!m) return '';
  const tag = m[1].toLowerCase();
  // find the end of this opening tag
  let start = html.indexOf('>', m.index);
  if (start < 0) return '';
  start += 1;
  const scan = new RegExp(`<(\\/?)${tag}\\b[^>]*>`, 'gi');
  scan.lastIndex = start;
  let depth = 1;
  let mm;
  while ((mm = scan.exec(html)) !== null) {
    if (mm[1] === '/') {
      depth -= 1;
      if (depth === 0) return html.slice(start, mm.index);
    } else if (!/\/>$/.test(mm[0])) {
      depth += 1;
    }
  }
  return html.slice(start);
}

// Value of a hidden input by name (ASP.NET __VIEWSTATE etc.).
function hiddenValue(html, name) {
  const re = new RegExp(
    `<input[^>]*\\bname\\s*=\\s*["']${name}["'][^>]*\\bvalue\\s*=\\s*["']([\\s\\S]*?)["']`,
    'i'
  );
  const m = re.exec(html);
  if (m) return decodeEntities(m[1]);
  // attribute order can be reversed
  const re2 = new RegExp(
    `<input[^>]*\\bvalue\\s*=\\s*["']([\\s\\S]*?)["'][^>]*\\bname\\s*=\\s*["']${name}["']`,
    'i'
  );
  const m2 = re2.exec(html);
  return m2 ? decodeEntities(m2[1]) : '';
}

// Split body text into candidate declarative sentences (Korean-aware).
// Splits per line first so headings/subtitles don't glue onto real sentences.
function sentences(text) {
  if (!text) return [];
  const out = [];
  for (const rawLine of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    // Split on Korean sentence-final "다." or on .!?。 — but NOT after a digit,
    // so dates like "8. 19." stay intact.
    const parts = line.split(/(?<=다\.)\s+|(?<=[^0-9][.!?。][)"'”’」』]?)\s+/);
    for (const p of parts) {
      const s = p.trim();
      if (s.length >= 12 && s.length <= 220) out.push(s);
    }
  }
  return out;
}

module.exports = {
  decodeEntities,
  stripTags,
  htmlToText,
  extractById,
  hiddenValue,
  sentences,
};
