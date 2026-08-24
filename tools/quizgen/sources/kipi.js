'use strict';
// 한국특허정보원 KIPI소식 www.kipi.or.kr (eGovFrame board).

const { get, post, newJar } = require('../lib/http');
const { htmlToText, extractById, decodeEntities, sentences } = require('../lib/html');
const { parseDate, withinDays, isoLocal } = require('../lib/dates');

const BASE = 'https://www.kipi.or.kr';
const BBS_ID = 'BBSMSTR_IIIIIIIIIIII';
const LIST = `/cop/bbs/selectBoardList.do?bbsId=${BBS_ID}`;

function parseRows(html) {
  const rows = [];
  const parts = html.split(/<li\b/i);
  for (const part of parts) {
    const idM = part.match(/kipinewsForm_submit\('(\d+)'\s*,\s*'([^']+)'\)/i);
    if (!idM) continue;
    const altM = part.match(/alt\s*=\s*"([^"]*)"/i);
    const aM = part.match(/kipinewsForm_submit[^>]*>([\s\S]*?)<\/a>/i);
    const dateM = part.match(/pic_list_date"?[^>]*>\s*(20\d\d-\d\d-\d\d)/i);
    let title = altM ? decodeEntities(altM[1]).trim() : '';
    if (!title && aM) title = htmlToText(aM[1]).replace(/\s+/g, ' ').trim();
    rows.push({
      nttId: idM[1],
      bbsId: idM[2],
      title,
      dateStr: dateM ? dateM[1] : '',
    });
  }
  return rows;
}

async function fetchDetail(jar, row) {
  const body = `bbsId=${encodeURIComponent(row.bbsId)}&nttId=${encodeURIComponent(row.nttId)}`;
  const html = (await post(BASE + '/cop/bbs/selectBoardArticle.do', body, {
    jar,
    headers: { Referer: BASE + LIST },
  })).decode('utf-8');
  // The article content sits inside the main content wrapper.
  const content = extractById(html, 'content');
  const text = htmlToText(content);
  return {
    url: `${BASE}/cop/bbs/selectBoardArticle.do?bbsId=${row.bbsId}&nttId=${row.nttId}`,
    body: text,
  };
}

// opts: { days, now, log, maxPages }
async function scrape(opts) {
  const { days, log } = opts;
  const now = opts.now || new Date();
  const maxPages = opts.maxPages || 2;
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
      if (out.some((x) => x.num === row.nttId)) continue;
      const detail = await fetchDetail(jar, row);
      out.push({
        source: '한국특허정보원',
        sourceType: 'news',
        num: row.nttId,
        title: row.title,
        author: '한국특허정보원',
        date: isoLocal(d),
        url: detail.url,
        body: detail.body,
        evidence: sentences(detail.body).slice(0, 6),
      });
    }
    log(`  한국특허정보원: ${page}페이지 처리, 누적 ${out.length}건`);
    if (lastDate && !withinDays(lastDate, days, now)) break;
  }
  return out;
}

module.exports = { scrape, id: 'kipi', label: '한국특허정보원 KIPI소식' };
