'use strict';
// Local button UI for the material scraper. Binds to loopback only, so
// groupware credentials typed into the page never leave this machine.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { run } = require('./core');

const PORT = Number(process.env.SCRAPER_PORT || 8899);
const HOST = '127.0.0.1';
// 게임의 문제 은행 위치. 이제 게임 repo 안(tools/quizgen)에 살므로 상대 경로가 기본이다.
const GAME_QUESTIONS =
  process.env.GAME_QUESTIONS || path.join(__dirname, '..', '..', 'data', 'questions.json');
// 반영 후 무중단 리로드를 부를 게임 서버 주소. 떠 있지 않아도 반영은 성공한다.
const GAME_URL = process.env.GAME_URL || 'http://127.0.0.1:12055';

const state = { running: false, logs: [], result: null, error: null, quiz: null };
const subscribers = new Set();

// ---------- API 키 보관 (로컬 전용) ----------
// output/은 gitignore 대상이라 키가 repo에 올라갈 일이 없다.
// admin.html(게임 운영 콘솔)이 브라우저에서 직접 여기로 저장한다 —
// 키는 게임 서버(Render)를 거치지 않고 이 PC 안에서만 돈다.
const OUTPUT_DIR = path.join(__dirname, 'output');
const CONFIG_FILE = path.join(OUTPUT_DIR, 'config.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) { return {}; }
}
function savedApiKey() {
  return String(loadConfig().anthropicApiKey || '');
}
function maskKey(k) {
  return k.length > 14 ? `${k.slice(0, 10)}…${k.slice(-4)}` : `${k.slice(0, 4)}…`;
}
function saveApiKey(key) {
  const cfg = loadConfig();
  if (key) cfg.anthropicApiKey = key;
  else delete cfg.anthropicApiKey;
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

// admin.html은 게임 서버 오리진(로컬 또는 Render)에서 열리므로 교차 출처 허용이 필요하다.
// 이 서버는 127.0.0.1에만 묶여 있어 어차피 이 PC의 브라우저만 닿는다.
const CONFIG_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Private-Network': 'true',
};

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of subscribers) {
    try { res.write(payload); } catch (_) { /* client gone */ }
  }
}

function log(line) {
  const entry = { t: Date.now(), line };
  state.logs.push(entry);
  broadcast('log', entry);
}

async function startRun(opts) {
  if (state.running) return;
  state.running = true;
  state.logs = [];
  state.result = null;
  state.error = null;
  state.quiz = null;
  broadcast('start', { at: Date.now() });
  try {
    const result = await run({
      days: opts.days,
      groupware: opts.groupware,
      apiKey: opts.apiKey,
      log,
    });
    // Never echo credentials back.
    state.result = {
      meta: result.meta,
      files: result.files,
    };
    state.quiz = result.quiz || null;
    log(`완료 — 재료 ${result.meta.total}건, OX ${result.quiz.pool.length}문항, 서든데스 ${result.quiz.sudden.length}문항`);
    broadcast('done', state.result);
    if (state.quiz) broadcast('quiz', state.quiz);
  } catch (e) {
    state.error = e.message;
    log(`실행 오류: ${e.message}`);
    broadcast('error', { message: e.message });
  } finally {
    state.running = false;
  }
}

// 검수 통과한 문항을 게임 questions.json에 병합한다 (기존 파일은 백업).
function applyToGame(poolIds, suddenIds) {
  if (!state.quiz) throw new Error('생성된 문항이 없습니다. 먼저 수집을 실행하세요.');
  if (!fs.existsSync(GAME_QUESTIONS)) {
    throw new Error(`게임 문제 파일을 찾을 수 없습니다: ${GAME_QUESTIONS}`);
  }
  const bank = JSON.parse(fs.readFileSync(GAME_QUESTIONS, 'utf8'));
  if (!Array.isArray(bank.pool) || !Array.isArray(bank.sudden)) {
    throw new Error('게임 questions.json 형식이 예상과 다릅니다 (pool/sudden 배열 필요).');
  }

  const strip = (q) => {
    const out = {};
    for (const k of Object.keys(q)) if (!k.startsWith('_')) out[k] = q[k];
    return out;
  };
  const existingIds = new Set([...bank.pool, ...bank.sudden].map((q) => q.id));
  const pickedPool = state.quiz.pool.filter((q) => poolIds.includes(q.id) && !existingIds.has(q.id));
  const pickedSudden = state.quiz.sudden.filter((q) => suddenIds.includes(q.id) && !existingIds.has(q.id));
  if (!pickedPool.length && !pickedSudden.length) {
    throw new Error('반영할 새 문항이 없습니다 (미선택 또는 이미 반영됨).');
  }

  const ts = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const backup = GAME_QUESTIONS.replace(
    /questions\.json$/,
    `questions.backup.${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.json`
  );
  fs.copyFileSync(GAME_QUESTIONS, backup);

  bank.pool.push(...pickedPool.map(strip));
  bank.sudden.push(...pickedSudden.map(strip));
  fs.writeFileSync(GAME_QUESTIONS, JSON.stringify(bank, null, 2), 'utf8');

  return {
    added: { pool: pickedPool.length, sudden: pickedSudden.length },
    total: { pool: bank.pool.length, sudden: bank.sudden.length },
    backup,
    file: GAME_QUESTIONS,
  };
}

/**
 * 게임 서버에 무중단 리로드를 요청한다.
 *
 * 파일만 쓰면 떠 있는 서버는 옛 은행으로 계속 돈다 —— 부팅 때 한 번 읽기 때문이다.
 * 서버가 없으면(월요일 아침, 아직 안 켰을 때) 조용히 넘어간다. 어차피 켤 때 새 파일을 읽는다.
 */
function reloadGame(adminKey) {
  return new Promise((resolve) => {
    try {
      const u = new URL('/api/admin/reload', GAME_URL);
      const body = JSON.stringify({ key: adminKey || 'kipi' });
      const req = require('http').request(
        { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          timeout: 3000 },
        (res) => {
          let d = '';
          res.on('data', (c) => { d += c; });
          res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body: d.slice(0, 200) }));
        },
      );
      req.on('error', () => resolve({ ok: false, offline: true }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, offline: true }); });
      req.write(body);
      req.end();
    } catch (e) {
      resolve({ ok: false, offline: true });
    }
  });
}

function serveFile(res, file, type) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': type });
    res.end(buf);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return serveFile(res, path.join(__dirname, 'public', 'index.html'), 'text/html; charset=utf-8');
  }

  if (req.method === 'GET' && url.pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    // Replay current state to a late subscriber.
    for (const entry of state.logs) res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
    if (state.result) res.write(`event: done\ndata: ${JSON.stringify(state.result)}\n\n`);
    if (state.quiz) res.write(`event: quiz\ndata: ${JSON.stringify(state.quiz)}\n\n`);
    subscribers.add(res);
    req.on('close', () => subscribers.delete(res));
    return;
  }

  // API 키 보관: GET은 마스킹된 상태만, POST는 저장(빈 값이면 삭제). 키 원문은 절대 돌려주지 않는다.
  if (url.pathname === '/api/config') {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CONFIG_CORS);
      return res.end();
    }
    if (req.method === 'GET') {
      const k = savedApiKey();
      res.writeHead(200, { 'Content-Type': 'application/json', ...CONFIG_CORS });
      return res.end(JSON.stringify({ hasKey: !!k, keyMasked: k ? maskKey(k) : null }));
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      let opts;
      try { opts = JSON.parse(body || '{}'); } catch (_) { opts = {}; }
      const key = String(opts.apiKey || '').trim();
      saveApiKey(key);
      log(key ? `API 키 저장됨 (${maskKey(key)})` : 'API 키 삭제됨');
      res.writeHead(200, { 'Content-Type': 'application/json', ...CONFIG_CORS });
      return res.end(JSON.stringify({ ok: true, hasKey: !!key, keyMasked: key ? maskKey(key) : null }));
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ running: state.running, result: state.result, error: state.error }));
  }

  if (req.method === 'POST' && url.pathname === '/api/scrape') {
    const body = await readBody(req);
    let opts;
    try { opts = JSON.parse(body || '{}'); } catch (_) { opts = {}; }
    if (state.running) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: '이미 실행 중입니다.' }));
    }
    const days = Number(opts.days) || 8;
    const gw = opts.includeGroupware && opts.id
      ? { id: String(opts.id), password: String(opts.password || '') }
      : null;
    // 키 우선순위: 방금 입력한 키 → 저장된 키(output/config.json) → 환경변수(quizgen.js에서 처리).
    // saveKey 체크 시에만 디스크에 남긴다. 키는 로그에 원문으로 남기지 않는다.
    const typedKey = String(opts.apiKey || '').trim();
    if (typedKey && opts.saveKey) saveApiKey(typedKey);
    startRun({ days, groupware: gw, apiKey: typedKey || savedApiKey() });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (req.method === 'POST' && url.pathname === '/api/apply') {
    const body = await readBody(req);
    let opts;
    try { opts = JSON.parse(body || '{}'); } catch (_) { opts = {}; }
    try {
      const result = applyToGame(
        Array.isArray(opts.poolIds) ? opts.poolIds : [],
        Array.isArray(opts.suddenIds) ? opts.suddenIds : []
      );
      log(`게임에 반영: OX ${result.added.pool}문항 + 서든데스 ${result.added.sudden}문항 → ${result.file}`);
      // 떠 있는 게임 서버가 있으면 곧바로 새 은행을 읽게 한다
      const reload = await reloadGame(opts.adminKey);
      result.reload = reload;
      log(reload.ok
        ? '게임 서버 리로드 완료 — 다음 회차부터 새 문항이 나온다'
        : reload.offline
          ? '게임 서버 미실행 — 켤 때 새 은행을 자동으로 읽는다'
          : `게임 서버 리로드 실패 (HTTP ${reload.status}) — 운영 키를 확인하라`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, ...result }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  res.writeHead(404);
  res.end('not found');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  포트 ${PORT}가 이미 사용 중입니다.`);
    console.error(`  이미 서버가 떠 있다면 브라우저에서  http://${HOST}:${PORT}/  로 접속하세요.`);
    console.error(`  다른 포트로 실행하려면:  SCRAPER_PORT=9000 node server.js\n`);
  } else {
    console.error('서버 오류:', err.message);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`\n  문제 재료 스크래퍼 실행 중`);
  console.log(`  브라우저에서 열기:  http://${HOST}:${PORT}/\n`);
});
