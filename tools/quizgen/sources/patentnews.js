'use strict';
// 특허뉴스 www.e-patentnews.com. Requires a browser User-Agent (403 otherwise);
// the shared http client already sends one.

const { get, newJar } = require('../lib/http');
const { htmlToText, decodeEntities, sentences } = require('../lib/html');
const { parseDate, withinDays, isoLocal } = require('../lib/dates');

const BASE = 'https://www.e-patentnews.com';
// sc1 = 특허 (main patent news section). Chronological, dated list.
const SECTIONS = [{ code: 'sc1', name: '특허' }];

function parseList(html) {
  const rows = [];
  const parts = html.split(/sub_read_list_box/i);
  for (const part of parts) {
    const hrefM = part.match(/<dt>\s*<a[^>]*href\s*=\s*['"](\/(\d{3,7}))['"][^>]*>([\s\S]*?)<\/a>/i);
    if (!hrefM) continue;
    const dateM = part.match(/20\d\d\.\d\d\.\d\d/);
    rows.push({
      uid: hrefM[2],
      url: BASE + hrefM[1],
      title: htmlToText(decodeEntities(hrefM[3])).replace(/\s+/g, ' ').trim(),
      dateStr: dateM ? dateM[0] : '',
    });
  }
  return rows;
}

async function fetchDetail(jar, row) {
  const html = (await get(row.url, { jar, headers: { Referer: BASE + '/' } })).decode('utf-8');
  const titleM =
    html.match(/<h1[^>]*class=['"][^'"]*read_title[^'"]*['"][^>]*>([\s\S]*?)<\/h1>/i) ||
    html.match(/<title>([\s\S]*?)<\/title>/i);
  const subM = html.match(/<h2[^>]*class=['"][^'"]*read_subtitle[^'"]*['"][^>]*>([\s\S]*?)<\/h2>/i);
  const writerM = html.match(/class=['"]writer['"][^>]*>([^<]+)</i);
  const dateM = html.match(/기사입력\s*(20\d\d[./]\d\d[./]\d\d)/) || html.match(/20\d\d[./]\d\d[./]\d\d/);

  // Body: starts right after the "기사입력 <date> [time]" byline marker and
  // runs to the related-articles list.
  let body = '';
  const anchorM = html.match(/기사입력[\s\S]{0,40}?\[[^\]]*\]/);
  const startIdx = anchorM
    ? anchorM.index + anchorM[0].length
    : html.search(/read_subtitle/i);
  const endIdx = html.search(/id\s*=\s*['"]news_read_list['"]/i);
  if (startIdx >= 0) {
    const slice = html.slice(startIdx, endIdx > startIdx ? endIdx : startIdx + 20000);
    body = htmlToText(slice)
      .split('\n')
      .filter((l) => l && !/저작권|무단전재|재배포|Copyright|ⓒ|^[^가-힣]*기자$|@|^특허\s*>|^\S+\s*>\s*\S+동향/.test(l))
      .join('\n')
      .trim();
  }
  return {
    title: titleM ? htmlToText(decodeEntities(titleM[1])).replace(/:특허뉴스$/, '').replace(/\s+/g, ' ').trim() : row.title,
    subtitle: subM ? htmlToText(decodeEntities(subM[1])).replace(/\s+/g, ' ').trim() : '',
    writer: writerM ? writerM[1].trim() : '',
    dateStr: dateM ? dateM[1] || dateM[0] : row.dateStr,
    body,
  };
}

// opts: { days, now, log, maxPages }
async function scrape(opts) {
  const { days, log } = opts;
  const now = opts.now || new Date();
  const maxPages = opts.maxPages || 4;
  const jar = newJar();
  const out = [];
  for (const section of SECTIONS) {
    for (let page = 1; page <= maxPages; page++) {
      const url = `${BASE}/sub.html?section=${section.code}&page=${page}`;
      const html = (await get(url, { jar, headers: { Referer: BASE + '/' } })).decode('utf-8');
      const rows = parseList(html);
      if (!rows.length) break;
      let lastDate = null;
      let added = 0;
      for (const row of rows) {
        const d = parseDate(row.dateStr);
        lastDate = d || lastDate;
        if (!withinDays(d, days, now)) continue;
        if (out.some((x) => x.num === row.uid)) continue;
        const detail = await fetchDetail(jar, row);
        const dd = parseDate(detail.dateStr) || d;
        out.push({
          source: '특허뉴스',
          sourceType: 'news',
          num: row.uid,
          title: detail.title || row.title,
          subtitle: detail.subtitle,
          author: detail.writer || '특허뉴스',
          date: isoLocal(dd),
          url: row.url,
          body: detail.body,
          evidence: sentences(detail.body).slice(0, 6),
        });
        added += 1;
      }
      log(`  특허뉴스[${section.name}]: ${page}페이지 처리, 누적 ${out.length}건`);
      if (lastDate && !withinDays(lastDate, days, now)) break;
      if (added === 0 && page > 1) break;
    }
  }
  return out;
}

module.exports = { scrape, id: 'patentnews', label: '특허뉴스' };
