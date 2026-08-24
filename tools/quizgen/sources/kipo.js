'use strict';
// 지식재산처 (구 특허청) www.kipo.go.kr — 보도자료.

const { get, newJar } = require('../lib/http');
const { htmlToText, decodeEntities, sentences } = require('../lib/html');
const { parseDate, withinDays, isoLocal } = require('../lib/dates');

const BASE = 'https://www.kipo.go.kr';
const LIST = '/ko/kpoBultnMgmt.do?menuCd=SCD0200618';

function parseRows(html) {
  const rows = [];
  const parts = html.split(/<tr\b/i);
  for (const part of parts) {
    if (!/kpoBultnDetail\.do/i.test(part)) continue;
    const linkM = part.match(
      /kpoBultnDetail\.do\?([^"']*ntatcSeq=(\d+)[^"']*aprchId=([^"'&]+)[^"']*)/i
    );
    if (!linkM) continue;
    const titleM =
      part.match(/title\s*=\s*"([^"]+)"/i) ||
      part.match(/kpoBultnDetail\.do[^>]*>([\s\S]*?)<\/a>/i);
    const dateM = part.match(/20\d\d-\d\d-\d\d/);
    rows.push({
      seq: linkM[2],
      aprch: linkM[3],
      title: titleM ? htmlToText(decodeEntities(titleM[1])).replace(/\s+/g, ' ').trim() : '',
      dateStr: dateM ? dateM[0] : '',
    });
  }
  return rows;
}

function detailUrl(seq, aprch) {
  return `${BASE}/ko/kpoBultnDetail.do?menuCd=SCD0200618&ntatcSeq=${seq}&sysCd=SCD02&aprchId=${aprch}`;
}

async function fetchDetail(jar, row) {
  const url = detailUrl(row.seq, row.aprch);
  const html = (await get(url, { jar })).decode('utf-8');
  const vTit = matchClassBlock(html, 'v_tit');
  const vBody = matchClassBlock(html, 'v_body');
  const dept = firstAfter(html, '담당부서');
  return {
    url,
    title: vTit ? htmlToText(vTit).replace(/\s+/g, ' ').trim() : row.title,
    body: vBody ? htmlToText(vBody) : '',
    dept,
  };
}

// Extract inner HTML of the first <div class="...name...">, balancing divs.
function matchClassBlock(html, cls) {
  const re = new RegExp(`<div[^>]*class\\s*=\\s*["'][^"']*\\b${cls}\\b[^"']*["'][^>]*>`, 'i');
  const m = re.exec(html);
  if (!m) return '';
  let start = m.index + m[0].length;
  const scan = /<(\/?)div\b[^>]*>/gi;
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

function firstAfter(html, label) {
  const i = html.indexOf(label);
  if (i < 0) return '';
  const seg = html.slice(i, i + 300);
  const m = seg.match(/<div[^>]*>([^<]+)<\/div>/i);
  return m ? m[1].trim() : '';
}

// opts: { days, now, log, maxPages }
async function scrape(opts) {
  const { days, log } = opts;
  const now = opts.now || new Date();
  const maxPages = opts.maxPages || 3;
  const jar = newJar();
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `${BASE}${LIST}&pageIndex=${page}`;
    const html = (await get(url, { jar })).decode('utf-8');
    const rows = parseRows(html);
    if (!rows.length) break;
    let lastDate = null;
    for (const row of rows) {
      const d = parseDate(row.dateStr);
      lastDate = d || lastDate;
      if (!withinDays(d, days, now)) continue;
      if (out.some((x) => x.num === row.seq)) continue;
      const detail = await fetchDetail(jar, row);
      out.push({
        source: '지식재산처',
        sourceType: 'news',
        num: row.seq,
        title: detail.title || row.title,
        author: detail.dept || '지식재산처',
        date: isoLocal(d),
        url: detail.url,
        body: detail.body,
        evidence: sentences(detail.body).slice(0, 6),
      });
    }
    log(`  지식재산처: ${page}페이지 처리, 누적 ${out.length}건`);
    if (lastDate && !withinDays(lastDate, days, now)) break;
  }
  return out;
}

module.exports = { scrape, id: 'kipo', label: '지식재산처 보도자료' };
