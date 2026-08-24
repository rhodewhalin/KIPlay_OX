'use strict';
// 그룹웨어 gw.kipi.or.kr — 공지사항(bbs_num=1) + 뉴스&행사(bbs_num=11).
// Requires the user's own login. The password is hashed and used in-memory
// only; it is never written to disk.

const crypto = require('crypto');
const { get, post, newJar } = require('../lib/http');
const { htmlToText, extractById, hiddenValue, decodeEntities, sentences } = require('../lib/html');
const { parseDate, withinDays, isoLocal } = require('../lib/dates');

const BASE = 'https://gw.kipi.or.kr';
const BOARDS = [
  { num: 1, name: '공지사항' },
  { num: 11, name: '뉴스&행사' },
];

function sha256hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

async function login(id, password, log) {
  const jar = newJar();
  log('그룹웨어 로그인 페이지 로드…');
  const page = await get(BASE + '/', { jar });
  const html = page.decode('utf-8');
  const form = new URLSearchParams();
  form.set('__EVENTTARGET', '');
  form.set('__EVENTARGUMENT', '');
  form.set('__VIEWSTATE', hiddenValue(html, '__VIEWSTATE'));
  form.set('__VIEWSTATEGENERATOR', hiddenValue(html, '__VIEWSTATEGENERATOR'));
  form.set('__EVENTVALIDATION', hiddenValue(html, '__EVENTVALIDATION'));
  form.set('txtClientType', 'W');
  form.set('txtUserid', id);
  form.set('txtPassword', '!SHA!' + sha256hex(password));
  form.set('btnLogin', 'Login');

  log('로그인 요청 전송…');
  await post(BASE + '/index1.aspx', form.toString(), {
    jar,
    headers: { Referer: BASE + '/' },
  });
  // Let any session initialization on the main frame run.
  await get(BASE + '/main_frame.aspx', { jar, headers: { Referer: BASE + '/' } });

  // Verify: a board list should now contain read_bbs links, not a login form.
  const probe = (await get(BASE + '/bbs/bbs_list.aspx?bbs_num=1&curPage=1', { jar })).decode('utf-8');
  if (/type=["']password["']/i.test(probe) || !/read_bbs\.aspx/i.test(probe)) {
    throw new Error('그룹웨어 로그인 실패 — ID/비밀번호를 확인해 주세요.');
  }
  log('그룹웨어 로그인 성공.');
  return jar;
}

function parseRows(html) {
  const rows = [];
  const parts = html.split(/<tr\b/i);
  for (const part of parts) {
    if (!/read_bbs\.aspx/i.test(part)) continue;
    const hrefM = part.match(/href\s*=\s*["']([^"']*read_bbs\.aspx[^"']*)["']/i);
    if (!hrefM) continue;
    const href = decodeEntities(hrefM[1]);
    const numM = href.match(/[?&](?:amp;)?num=(\d+)/i);
    const dateM = part.match(/20\d\d-\d\d-\d\d(?: \d\d:\d\d:\d\d)?/);
    const cells = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cm;
    while ((cm = cellRe.exec(part)) !== null) {
      cells.push(htmlToText(cm[1]).replace(/\s+/g, ' ').trim());
    }
    const titleM = part.match(/<a[^>]*read_bbs\.aspx[^>]*>([\s\S]*?)<\/a>/i);
    const title = titleM ? htmlToText(titleM[1]).replace(/\s+/g, ' ').trim() : '';
    let author = '';
    if (dateM) {
      const di = cells.findIndex((c) => c.startsWith(dateM[0].slice(0, 10)));
      if (di > 0) author = cells[di - 1];
    }
    rows.push({
      href,
      num: numM ? numM[1] : null,
      title,
      author,
      dateStr: dateM ? dateM[0] : '',
    });
  }
  return rows;
}

async function fetchDetail(jar, board, row) {
  const url = BASE + '/bbs/' + row.href.replace(/^\/?bbs\//, '');
  const html = (await get(url, { jar, headers: { Referer: BASE + '/bbs/bbs_list.aspx' } })).decode('utf-8');
  const subject = htmlToText(extractById(html, 'lblSubject')).trim() || row.title;
  const body = htmlToText(extractById(html, 'lblContents'));
  const attachments = [];
  let embeddedImages = 0;
  const dlRe = /download\.aspx\?[^"'<>\s]*file=([^&"'<>\s]+)/gi;
  let dm;
  const seen = new Set();
  while ((dm = dlRe.exec(html)) !== null) {
    let name;
    try { name = decodeURIComponent(dm[1].replace(/\+/g, ' ')); } catch (_) { name = dm[1]; }
    if (name.startsWith('/')) { embeddedImages += 1; continue; }
    if (!seen.has(name)) { seen.add(name); attachments.push(name); }
  }
  return { subject, body, attachments, embeddedImages, url };
}

async function scrapeBoard(jar, board, days, now, log, maxPages) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const listUrl = `${BASE}/bbs/bbs_list.aspx?bbs_num=${board.num}&curPage=${page}`;
    const html = (await get(listUrl, { jar })).decode('utf-8');
    const rows = parseRows(html);
    if (!rows.length) break;
    let lastDate = null;
    for (const row of rows) {
      const d = parseDate(row.dateStr);
      lastDate = d || lastDate;
      if (!withinDays(d, days, now)) continue;
      if (out.some((x) => x.num === row.num)) continue;
      const detail = await fetchDetail(jar, board, row);
      out.push({
        source: `그룹웨어·${board.name}`,
        sourceType: 'groupware',
        num: row.num,
        title: detail.subject,
        author: row.author,
        date: isoLocal(d),
        url: detail.url,
        attachments: detail.attachments,
        embeddedImages: detail.embeddedImages,
        body: detail.body,
        evidence: sentences(detail.body).slice(0, 6),
      });
    }
    log(`  ${board.name}: ${page}페이지 처리, 누적 ${out.length}건`);
    if (lastDate && !withinDays(lastDate, days, now)) break;
  }
  return out;
}

// opts: { id, password, days, now, log, maxPages }
async function scrape(opts) {
  const { id, password, days, log } = opts;
  const now = opts.now || new Date();
  const maxPages = opts.maxPages || 5;
  if (!id || !password) throw new Error('그룹웨어 ID/비밀번호가 필요합니다.');
  const jar = await login(id, password, log);
  let items = [];
  for (const board of BOARDS) {
    log(`그룹웨어 ${board.name} 수집…`);
    const boardItems = await scrapeBoard(jar, board, days, now, log, maxPages);
    items = items.concat(boardItems);
  }
  return items;
}

module.exports = { scrape, id: 'groupware', label: '그룹웨어(공지·뉴스행사)' };
