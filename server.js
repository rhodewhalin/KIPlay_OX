'use strict';

/**
 * 12:55 — 전사 실시간 OX 서바이벌 게임 서버
 *
 * 설계 원칙 (PRD 7.1)
 *   1. WebSocket이 아니라 SSE + POST. 방송형 동기 게임이라 양방향 채널이 필요 없다.
 *   2. 서버리스가 아니라 상시 단일 프로세스. 콜드스타트와 연결 유지 문제를 피한다.
 *   3. 스케일아웃하지 않는다. 450명은 단일 인스턴스가 정답이다.
 *
 * 의존성 0. Node 내장 모듈만 사용한다.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------- 설정

const CONFIG = {
  port: Number(process.env.PORT) || 12055,
  adminKey: process.env.ADMIN_KEY || 'kipi',

  // 7초는 너무 빡빡했다. 문제를 읽고, 남들이 어디로 가는지 보고, 마음을 정할 틈이 필요하다.
  // 10초로 늘려도 한 판이 2분 안쪽이라 5분 슬롯에 여유가 있다.
  questionMs: Number(process.env.QUESTION_MS) || 10000,

  /**
   * 문항 브리핑 구간. 문항이 화면에 뜨고 나서 응답 시계가 켜지기까지의 시간이다.
   *
   * 이게 없으면 문항 공개와 동시에 시계가 돌기 시작해서, 중계가 "N번 문항, 난이도 …"를
   * 말하는 동안 이미 답을 받고 있다. 화면이 늘 나레이션보다 앞선다.
   * 모두에게 같은 시각에 열리므로 공정성에는 영향이 없다.
   *
   * 3400ms는 "N번 문항. 난이도 어려움."을 읽는 시간(약 3.2초)에서 나왔다. 5문항이면
   * 한 판에 18초가 붙는다. 실측 124초짜리 회차가 143초가 되며, 예산인 5분 안에 넉넉히 남는다.
   * 문항 수나 중계 문구를 바꾸면 이 값도 같이 봐야 한다.
   */
  armMs: Number(process.env.ARM_MS) || 3400,

  /**
   * 서든데스 브리핑. 뜸을 살짝 들였다가 우승곡이 울리면서 문제가 공개된다.
   * 그 20초 뒤 우승이 확정되는 순간이 곡의 클라이맥스와 겹치도록 설계된 값이다.
   */
  suddenArmMs: Number(process.env.SUDDEN_ARM_MS) || 2200,
  revealMs: 3000,     // 정답 공개 (아래 revealMsFor로 인원에 따라 늘어난다)
  suddenMs: 20000,    // 서든데스
  lobbyMs: 30000,     // 기본 대기실 (실전은 5분)
  tallyMs: 1000,      // 실시간 집계 브로드캐스트 간격

  questionCount: 10,
  newbieYears: 2,     // 입사 N년 미만에게 부활권
  heartbeatMs: 15000, // SSE keep-alive

  /**
   * 정기 회차 — 매주 월요일 12:55 KST에 1번 문항이 나간다.
   * 5분 전(12:50)에 서버가 스스로 대기실을 열고, 그 사이 프리쇼로
   * 접속한 모든 화면에 1분에 한 번 로고송 큐를 공통 송출한다.
   * 개별 폰이 제멋대로 트는 게 아니라 전원이 같은 순간에 울리는 것이 요점.
   * 개발·e2e 중에는 AUTO_START=0 으로 끌 수 있다.
   */
  gameDow: Number(process.env.GAME_DOW ?? 1),      // 0=일 … 1=월
  gameHour: Number(process.env.GAME_HOUR ?? 12),   // KST
  gameMinute: Number(process.env.GAME_MINUTE ?? 55),
  preShowMs: 5 * 60000,

  /** 본게임 3분 전(12:52)부터 체험 모드를 잠근다. 체험이 회차 직전 idle을 흔들 수 없게. */
  demoLockoutMs: 3 * 60000,

  /**
   * 생존자가 이 수 미만이면 실시간 O/X 집계를 보내지 않는다.
   * 초반은 군중을 보고 눈치를 보지만 후반은 혼자 판단해야 한다.
   * 반드시 서버에서 잘라야 한다. 클라이언트에서만 숨기면 개발자도구로 그대로 보인다.
   *
   * 처음엔 100으로 뒀는데 그러면 1~2문항 만에 100명 밑으로 떨어져
   * 사람들이 O/X로 달려가는 간판 연출이 초반에만 보이고 나머지 내내 정지 화면이 된다.
   * 30이면 마지막 한두 문항만 깜깜이가 되어 원래 의도(외로운 결승)는 살면서
   * 군중이 갈라지는 장면은 게임 내내 볼 수 있다.
   */
  tallyVisibleFrom: Number(process.env.TALLY_FROM) || 30,
};

/* 게임장은 하나다. 층 상승 구조는 걷어냈다 —— 살아남은 사람들이 같은 자리에서
 * 계속 겨룬다. 옥상은 게임 장면이 아니라 우승 연출 전용으로만 남는다. */

const POINTS = { join: 5, survive: 10, champion: 50 };

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');

// ---------------------------------------------------------------- 데이터 로드

function loadJson(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
}

let BANK = loadJson('questions.json');
let STAFF = loadJson('employees.json');

let ROSTER = new Map(STAFF.roster.map((r) => [r.empId, r]));
let DEPTS = STAFF.departments.map((d) => (typeof d === 'string' ? { name: d, division: 'etc' } : d));
let DIVISIONS = STAFF.divisions || [{ id: 'etc', name: '기타', color: '#8B93B0' }];
let DEPT_DIV = new Map(DEPTS.map((d) => [d.name, d.division]));
let DIV_COLOR = new Map(DIVISIONS.map((d) => [d.id, d.color]));

/**
 * 자동 배정 대상 부서.
 *
 * 'guest'는 본부가 아니다 —— 소속 없이 참전하는 스페셜 게스트를 담는 칸이라
 * 미등록 사번이나 봇이 굴러들어가면 안 된다. 명부에 이름이 적힌 사람만 그 자리에 선다.
 */
let OPEN_DEPTS = DEPTS.filter((d) => d.division !== 'guest');
const rebuildOpenDepts = () => { OPEN_DEPTS = DEPTS.filter((d) => d.division !== 'guest'); };
if (!OPEN_DEPTS.length) OPEN_DEPTS = DEPTS;

const divisionOf = (deptName) => DEPT_DIV.get(deptName) || 'etc';
let ID = Object.assign({ digits: 5, yearPrefix: 2, defaultYears: 5 }, STAFF.idFormat || {});
let ID_RE = new RegExp(`^\\d{${ID.digits}}$`);

/**
 * 사번으로 직원을 찾는다.
 *
 * 명부에 있으면 joinYear를 그대로 쓴다. 없으면 idFormat 규칙으로 입사연도를 추정한다.
 * 사내 사번이 순번제라면 employees.json에서 yearPrefix를 0으로 두면 되고,
 * 그 경우 미등록 사번은 defaultYears 연차로 처리되어 부활권 대상에서 빠진다.
 */
function resolveEmployee(empId) {
  const id = String(empId).trim();
  if (!ID_RE.test(id)) return null;

  const nowYear = new Date().getFullYear();
  const known = ROSTER.get(id);
  let joinYear;

  if (known && known.joinYear) {
    joinYear = known.joinYear;
  } else if (ID.yearPrefix > 0) {
    const yy = Number(id.slice(0, ID.yearPrefix));
    if (!Number.isFinite(yy)) return null;
    // 두 자리 연도 해석: 올해보다 크면 지난 세기로 본다 (26 → 2026, 95 → 1995)
    joinYear = ID.yearPrefix === 2 ? (yy <= nowYear % 100 ? 2000 + yy : 1900 + yy) : yy;
  } else {
    joinYear = nowYear - ID.defaultYears;
  }

  if (joinYear < 1960 || joinYear > nowYear) return null;

  const seq = Number(id.slice(ID.yearPrefix > 0 ? ID.yearPrefix : 0)) || 0;
  const dept = known ? known.dept : OPEN_DEPTS[seq % OPEN_DEPTS.length].name;

  return {
    empId: id,
    name: known ? known.name : `직원 ${id}`,
    dept,
    div: divisionOf(dept),
    title: known ? known.title || null : null,
    vip: known ? !!known.vip : false,
    years: nowYear - joinYear,
  };
}

// ---------------------------------------------------------------- 게임 상태

// ---------------------------------------------------------------- 체험 모드 봇
//
// 혼자서도 게임 전체를 확인할 수 있어야 한다. 봇은 난이도별 목표 정답률(PRD 5.3)에 맞춰
// 답하므로 집계 바 · 생존자 감소 곡선 · 탈락 피드 · 서든데스가 실제 회차와 같은 모양으로 움직인다.

const BOT_SURNAME = ['김', '이', '박', '최', '정', '강', '조', '윤', '장', '임',
                     '한', '오', '서', '신', '권', '황', '안', '송', '전', '홍'];
const BOT_GIVEN = ['민준', '서연', '도윤', '하은', '시우', '지우', '주원', '서윤', '예준', '수아',
                   '지호', '하윤', '건우', '채원', '우진', '지아', '현우', '다은', '승우', '유나',
                   '준서', '소율', '지훈', '가은', '태윤', '서아', '민서', '연우', '동현', '수빈'];

/** 난이도별 기본 정답률. PRD 5.3의 목표 정답률과 맞춰 둔다. */
const BOT_ACCURACY = { easy: 0.85, medium: 0.6, hard: 0.4 };

const BOT_AFK_RATE = 0.04;   // 무응답 비율

let botTimers = [];

function clearBotTimers() {
  for (const t of botTimers) clearTimeout(t);
  botTimers = [];
}

function laterBot(ms, fn) {
  botTimers.push(setTimeout(fn, ms));
}

function makeBotName(i) {
  const s = BOT_SURNAME[(i * 7 + 3) % BOT_SURNAME.length];
  const g = BOT_GIVEN[(i * 13 + 5) % BOT_GIVEN.length];
  return `${s}${g}`;
}

function spawnBots(count) {
  const nowYear = new Date().getFullYear();
  for (let i = 0; i < count; i += 1) {
    // 신입 비중을 실제 조직과 비슷하게 둔다 (약 13%)
    const years = Math.random() < 0.13 ? Math.floor(Math.random() * 2) : 2 + Math.floor(Math.random() * 20);
    const joinYear = nowYear - years;
    const token = `bot-${game.round}-${i}`;
    const p = newPlayer(
      {
        empId: `${String(joinYear % 100).padStart(2, '0')}${String(100 + (i % 900)).padStart(3, '0')}`,
        name: makeBotName(i),
        dept: OPEN_DEPTS[i % OPEN_DEPTS.length].name,
        div: OPEN_DEPTS[i % OPEN_DEPTS.length].division,
        title: null,
        vip: false,
        years,
      },
      token,
    );
    p.isBot = true;
    p.skill = 0.78 + Math.random() * 0.44; // 봇마다 실력 편차를 준다
    p.afk = Math.random() < BOT_AFK_RATE;
    p.points = POINTS.join;
    game.players.set(token, p);
  }
}

function clearBots() {
  clearBotTimers();
  for (const [token, p] of game.players) if (p.isBot) game.players.delete(token);
}

/** 문항 공개와 동시에 봇들의 응답을 응답 창 안에 흩어서 예약한다. */
function scheduleBotAnswers(q, armMs = 0) {
  const base = BOT_ACCURACY[q.difficulty] ?? 0.6;
  for (const p of game.players.values()) {
    if (!p.isBot || !p.alive || p.afk) continue;
    // 브리핑 중에는 봇도 답하지 않는다. 집계 바가 문제도 읽기 전에 움직이면 이상하다.
    const delay = armMs + 500 + Math.random() * (CONFIG.questionMs - 1200);
    laterBot(delay, () => {
      if (game.phase !== 'question' || !p.alive) return;
      const acc = Math.min(0.97, Math.max(0.05, base * p.skill));
      const correct = Math.random() < acc;
      p.answer = correct ? q.answer : (q.answer === 'O' ? 'X' : 'O');
      p.rt = Math.round(delay);
    });
  }
}

function scheduleBotSudden(participants) {
  const target = game.suddenQ.answer;
  for (const p of participants) {
    if (!p.isBot) continue;
    laterBot(CONFIG.suddenArmMs + 1200 + Math.random() * (CONFIG.suddenMs - 3000), () => {
      if (game.phase !== 'sudden') return;
      const spread = 0.12 + Math.random() * 0.7;
      const sign = Math.random() < 0.5 ? -1 : 1;
      p.suddenValue = Math.max(0, Math.round(target * (1 + spread * sign)));
      p.suddenRt = Math.round(1500 + Math.random() * 9000);
    });
  }
}

const DIV_INDEX = new Map(DIVISIONS.map((d, i) => [d.id, i]));

const game = {
  phase: 'idle', // idle | lobby | question | reveal | sudden | result
  demo: false,
  round: 0,
  armAt: 0,      // 응답 시계가 켜지는 시각. 그전은 브리핑 구간이다.
  crowd: [],     // 렌더러가 쓰는 고정 순서 배열. 인덱스가 곧 화면상의 사람이다.
  phaseEndsAt: 0,

  questions: [],
  qIndex: -1,
  suddenQ: null,

  players: new Map(),   // token -> player
  byEmpId: new Map(),   // empId -> token (동시 세션 1개 제한)
  spectators: new Set(),

  lastReveal: null,
  feed: [],             // 전광판 탈락 피드
  result: null,
};

let phaseTimer = null;
let tallyTimer = null;

function newPlayer(emp, token) {
  return {
    token,
    ...emp,
    isNew: emp.years < CONFIG.newbieYears,
    alive: true,
    revives: emp.years < CONFIG.newbieYears ? 1 : 0,
    answer: null,        // 현재 문항 응답
    rt: null,
    survived: 0,         // 생존 문항 수
    eliminatedAt: null,  // 탈락 문항 index
    revivedAt: null,     // 부활권이 자동으로 쓰인 문항 index
    suddenValue: null,
    suddenRt: null,
    points: 0,
    res: null,                    // SSE 연결
    disconnectedAt: Date.now(),   // 아직 스트림을 열지 않은 상태
  };
}

/**
 * 끊긴 참여자를 정리한다.
 * 이게 없으면 폰을 닫은 사람이 영구히 참가자로 집계되어 참여율 지표가 오염된다.
 * 진행 중에는 정리하지 않는다. 재접속하면 자기 생존 상태를 그대로 이어받아야 하기 때문이다.
 */
function prunePlayers(maxIdleMs = 0) {
  const cutoff = Date.now() - maxIdleMs;
  let removed = 0;
  for (const [token, p] of game.players) {
    if (p.isBot) continue; // 봇은 회차 리셋에서 별도로 정리한다
    if (p.res || !p.disconnectedAt || p.disconnectedAt > cutoff) continue;
    game.players.delete(token);
    if (game.byEmpId.get(p.empId) === token) game.byEmpId.delete(p.empId);
    removed += 1;
  }
  return removed;
}

setInterval(() => {
  if (game.phase !== 'idle' && game.phase !== 'lobby' && game.phase !== 'result') return;
  if (prunePlayers(90000) > 0) pushState();
}, 30000).unref();

/**
 * 대기실 "참가자" 표시용 headcount. game.players.size는 끊긴 지 얼마 안 돼
 * 아직 정리되지 않은 유령 접속까지 세어, 혼자 들어와도 숫자가 부풀어 보인다.
 * 지금 실제로 화면을 보고 있는 사람(SSE 연결)과 체험용 봇만 센다.
 */
function connectedCount() {
  let n = 0;
  for (const p of game.players.values()) if (p.isBot || p.res) n += 1;
  return n;
}

function resetPlayerForRound(p) {
  p.alive = true;
  p.revives = p.isNew ? 1 : 0;
  p.answer = null;
  p.rt = null;
  p.survived = 0;
  p.eliminatedAt = null;
  p.revivedAt = null;
  p.suddenValue = null;
  p.suddenRt = null;
  p.points = POINTS.join;
}

const alivePlayers = () => [...game.players.values()].filter((p) => p.alive);
const vipPlayer = () => [...game.players.values()].find((p) => p.vip) || null;

// ---------------------------------------------------------------- SSE

// 중간 프록시(Cloudflare, nginx, 사내 프록시)는 응답이 일정 크기에 닿을 때까지
// 버퍼에 모아두는 경우가 있다. 그러면 SSE 이벤트가 한참 뒤에야 도착하거나 아예 오지 않아
// 화면이 통째로 멈춘다. 스트림을 열 때 패딩 주석을 한 번 보내 버퍼를 강제로 흘려보낸다.
const SSE_PADDING = `:${' '.repeat(4096)}\n\n`;

function sseOpen(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Content-Encoding': 'identity',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(SSE_PADDING);
  res.write('retry: 3000\n\n');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

function sseSend(res, event, data) {
  if (!res || res.writableEnded) return;
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (_) {
    /* 끊긴 연결은 무시한다. cleanup이 정리한다. */
  }
}

setInterval(() => {
  for (const p of game.players.values()) if (p.res) p.res.write(': hb\n\n');
  for (const res of game.spectators) res.write(': hb\n\n');
}, CONFIG.heartbeatMs).unref();

// ---------------------------------------------------------------- 상태 스냅샷

function tallyCounts() {
  let o = 0;
  let x = 0;
  for (const p of game.players.values()) {
    if (!p.alive) continue;
    if (p.answer === 'O') o += 1;
    else if (p.answer === 'X') x += 1;
  }
  return { o, x };
}

// ---------------------------------------------------------------- 군중 데이터
//
// 렌더러는 사람 하나하나를 그린다. 매 틱마다 450명의 객체를 보내면 대역폭이 낭비되므로
// 회차 시작에 고정 순서 배열을 한 번 보내고, 그 뒤로는 인덱스 순서의 문자열 마스크만 보낸다.
// 450명이 450바이트다.

function buildCrowd() {
  game.crowd = [...game.players.values()].filter((p) => p.eliminatedAt !== -1);
  game.crowd.forEach((p, i) => { p.ci = i; });
}

function crowdPayload() {
  return {
    round: game.round,
    n: game.crowd.length,
    divisions: DIVISIONS,
    div: game.crowd.map((p) => DIV_INDEX.get(p.div) ?? DIVISIONS.length - 1).join(''),
    flags: game.crowd.map((p) => (p.vip ? 'v' : p.isNew ? 'n' : '.')).join(''),
  };
}

const aliveMask = () => game.crowd.map((p) => (p.alive ? '1' : '0')).join('');

/** 선택 방향까지 담는다. 생존자가 충분히 많을 때만 내보낸다. */
const choiceMask = () => game.crowd.map((p) => (p.alive ? p.answer || '-' : '.')).join('');

/** 방향은 감추고 "정했는지" 여부만 담는다. */
const decidedMask = () => game.crowd.map((p) => (p.alive ? (p.answer ? '1' : '0') : '.')).join('');

const tallyVisible = () => alivePlayers().length >= CONFIG.tallyVisibleFrom;

/** 본부별 생존자 수. 중계 멘트("어느 본부가 가장 많이 남았는가")의 재료다. */
function divisionCounts() {
  const m = {};
  for (const p of alivePlayers()) m[p.div] = (m[p.div] || 0) + 1;
  return m;
}

/** 카메라가 가까워지는 구간에서만 이름을 붙인다. 인원이 적을 때만이라 양도 적다. */
function namedPayload() {
  const alive = alivePlayers();
  if (alive.length > 30) return null;
  return game.crowd
    .filter((p) => p.alive)
    .map((p) => ({ i: p.ci, name: p.name, empId: p.empId, dept: p.dept }));
}

function publicState() {
  const q = game.questions[game.qIndex] || null;
  const vip = vipPlayer();

  const showTally = tallyVisible();

  return {
    phase: game.phase,
    demo: game.demo,
    round: game.round,
    scene: 'ground',
    tallyVisible: showTally,
    tallyFrom: CONFIG.tallyVisibleFrom,
    questionMs: CONFIG.questionMs,
    armAt: game.phase === 'question' || game.phase === 'sudden' ? game.armAt : null,
    suddenMs: CONFIG.suddenMs,
    divAlive: divisionCounts(),
    // 색까지 함께 보낸다. 군중 배열(crowd)은 회차당 한 번뿐이라, 화면 범례가 그걸
    // 참조하면 두 번째 문항부터 색을 잃는다. 매 틱 오는 이 목록이 범례의 원본이다.
    divisionNames: DIVISIONS.map((d) => ({ id: d.id, name: d.name, short: d.short || d.name, color: d.color })),
    aliveMask: game.crowd.length ? aliveMask() : null,
    named: namedPayload(),
    phaseEndsAt: game.phaseEndsAt,
    serverNow: Date.now(),
    nextGameAt: nextGameAt(),
    demoLocked: demoLocked(),
    joined: connectedCount(),
    alive: alivePlayers().length,
    qIndex: game.qIndex,
    qTotal: game.questions.length,
    question:
      q && (game.phase === 'question' || game.phase === 'reveal')
        ? { text: q.text, difficulty: q.difficulty }
        : null,
    sudden:
      game.phase === 'sudden' && game.suddenQ
        ? { text: game.suddenQ.text, unit: game.suddenQ.unit }
        : null,
    reveal: game.phase === 'reveal' ? game.lastReveal : null,
    vip: vip ? { name: vip.name, title: vip.title, alive: vip.alive, dept: vip.dept } : null,
    feed: game.feed.slice(-14),
    result: game.result,
    // 진행 중에는 생존자가 충분히 많을 때만 집계를 보낸다. 정답 공개 뒤에는 항상 보낸다.
    ...(game.phase === 'question' && !showTally ? { o: null, x: null } : tallyCounts()),
  };
}

function personalState(p) {
  return {
    ...publicState(),
    me: {
      empId: p.empId,
      name: p.name,
      dept: p.dept,
      div: p.div,
      ci: p.ci ?? null,
      years: p.years,
      isNew: p.isNew,
      isVip: p.vip,
      title: p.title,
      alive: p.alive,
      revives: p.revives,
      answer: p.answer,
      survived: p.survived,
      eliminatedAt: p.eliminatedAt,
      // 이번 정답 공개에서 부활권이 자동으로 쓰였는가
      revived: p.revivedAt === game.qIndex && game.phase === 'reveal',
      inSudden: !!p.inSudden,
      points: p.points,
      correct: game.phase === 'reveal' && game.lastReveal ? p.lastCorrect ?? null : null,
    },
  };
}

/** 군중 배열은 회차당 연결당 한 번만 보낸다. 그 뒤로는 마스크만 흐른다. */
function withCrowd(res, payload) {
  if (!game.crowd.length || res._crowdRound === game.round) return payload;
  res._crowdRound = game.round;
  return { ...payload, crowd: crowdPayload() };
}

function pushState() {
  for (const p of game.players.values()) {
    if (p.res) sseSend(p.res, 'state', withCrowd(p.res, personalState(p)));
  }
  const pub = publicState();
  for (const res of game.spectators) sseSend(res, 'state', withCrowd(res, pub));
}

function pushTally() {
  const showTally = tallyVisible();
  const payload = {
    alive: alivePlayers().length,
    joined: connectedCount(),
    tallyVisible: showTally,
    ...(showTally ? { ...tallyCounts(), choices: choiceMask() } : { o: null, x: null, decided: decidedMask() }),
  };
  for (const p of game.players.values()) if (p.res) sseSend(p.res, 'tally', payload);
  for (const res of game.spectators) sseSend(res, 'tally', payload);
}

// ---------------------------------------------------------------- 상태 기계

function clearTimers() {
  if (phaseTimer) clearTimeout(phaseTimer);
  if (tallyTimer) clearInterval(tallyTimer);
  phaseTimer = null;
  tallyTimer = null;
  clearBotTimers();
}

function schedule(ms, fn) {
  if (phaseTimer) clearTimeout(phaseTimer);
  phaseTimer = setTimeout(fn, ms);
}

/**
 * 회차 문항 선발.
 *
 * 사다리는 앞 네 문항까지만 완만하다 —— 1·2번 쉬움, 3·4번 보통. **5번부터 끝까지는
 * 전부 어려움이다.** 쉬운 문항이 이어지면 마지막까지 100명 넘게 살아남아, 우승자를
 * 숫자 하나로 가리는 사실상의 추첨이 되기 때문이다(160명 전원 정답 회차에서 실측).
 * 어려움 구간의 목표 정답률이 30%이므로 생존자는 문항마다 3분의 1로 줄고,
 * 대개 8번 안팎에서 한 명이 남는다. 10번까지 가고도 둘 이상이면 서든데스로 맺는다.
 *
 * 한 난이도가 동나면 이웃 난이도에서 메운다. 문제 은행이 얇아도 회차는 굴러가야 한다.
 */
function pickQuestions(count = CONFIG.questionCount) {
  const pool = BANK.pool;
  const shuffled = (d) => pool.filter((q) => q.difficulty === d).sort(() => Math.random() - 0.5);
  const bins = { easy: shuffled('easy'), medium: shuffled('medium'), hard: shuffled('hard') };
  const used = new Set();

  const take = (order) => {
    for (const d of order) {
      const q = bins[d].find((x) => !used.has(x));
      if (q) { used.add(q); return q; }
    }
    const rest = pool.find((x) => !used.has(x));
    if (rest) used.add(rest);
    return rest || null;
  };

  const PLAN = ['easy', 'easy', 'medium', 'medium'];   // 그 뒤는 전부 hard
  const FALLBACK = {
    easy: ['easy', 'medium', 'hard'],
    medium: ['medium', 'hard', 'easy'],
    hard: ['hard', 'medium', 'easy'],
  };

  const ladder = [];
  for (let i = 0; i < count; i += 1) {
    const q = take(FALLBACK[PLAN[i] || 'hard']);
    if (!q) break;
    ladder.push(q);
  }
  return ladder;
}

function startGame(lobbyMs, opts = {}) {
  clearTimers();
  game.demo = !!opts.demo;
  if (!game.demo) clearBots(); // 실전 회차에 체험용 봇이 섞이지 않게 한다
  game.round += 1;
  game.questions = pickQuestions(opts.questionCount);
  game.suddenQ = BANK.sudden[Math.floor(Math.random() * BANK.sudden.length)];
  game.qIndex = -1;
  game.crowd = [];
  game.lastReveal = null;
  game.result = null;
  game.feed = [];

  for (const p of game.players.values()) resetPlayerForRound(p);

  game.phase = 'lobby';
  game.phaseEndsAt = Date.now() + lobbyMs;
  pushState();

  log(`round ${game.round} 시작 · 대기실 ${Math.round(lobbyMs / 1000)}초 · 접속 ${game.players.size}명`);
  schedule(lobbyMs, () => beginQuestion(0));
}

function beginQuestion(index) {
  clearTimers();
  game.qIndex = index;
  game.phase = 'question';
  // 첫 문항은 대기실 인사까지 이어 말해야 하므로 브리핑을 조금 더 준다
  const armMs = index === 0 ? Math.round(CONFIG.armMs * 1.35) : CONFIG.armMs;
  game.armAt = Date.now() + armMs;
  game.phaseEndsAt = game.armAt + CONFIG.questionMs;
  game.lastReveal = null;

  if (index === 0) buildCrowd(); // 첫 문항 시점의 참가자가 이 회차의 군중이다

  for (const p of game.players.values()) {
    p.answer = null;
    p.rt = null;
    p.lastCorrect = null;
  }

  pushState();
  scheduleBotAnswers(game.questions[index], armMs);
  tallyTimer = setInterval(pushTally, CONFIG.tallyMs);
  schedule(armMs + CONFIG.questionMs, revealQuestion);
}

function revealQuestion() {
  clearTimers();
  const q = game.questions[game.qIndex];
  const { o, x } = tallyCounts();

  // 탈락을 적용하기 전에 찍어야 한다. 나중에 만들면 살아남은 쪽 답만 남아
  // 전원이 같은 선택을 한 것처럼 보인다.
  const choicesAtReveal = game.crowd.length ? choiceMask() : null;

  const eliminated = [];
  for (const p of game.players.values()) {
    if (!p.alive) continue;
    const correct = p.answer === q.answer; // 미응답은 오답 처리 (PRD 5.2)
    p.lastCorrect = correct;
    if (correct) {
      p.survived += 1;
      p.points += POINTS.survive;
    } else {
      p.alive = false;
      p.eliminatedAt = game.qIndex;
      eliminated.push(p);
    }
  }

  /* 부활권은 자동으로 쓴다.
   *
   * 예전에는 4초짜리 선택 화면을 띄우고 「사용 / 아끼기」를 물었다. 그런데 아낄 이유가
   * 없다 —— 회차가 끝나면 권리도 같이 사라지므로 안 쓰면 그냥 버리는 것이다. 실제로
   * 봇도 사람도 거의 전부 사용을 눌렀고, 남은 것은 회차마다 4초의 정적뿐이었다.
   * 5분 예산에서 4초는 문항 하나의 브리핑에 맞먹는다. 물어보지 않고 살려 준다. */
  const revived = [];
  for (const p of eliminated) {
    if (!p.isNew || p.revives <= 0) continue;
    p.revives -= 1;
    p.alive = true;
    p.eliminatedAt = null;
    revived.push(p);
    game.feed.push({ name: p.name, dept: p.dept, q: game.qIndex + 1, revived: true });
  }
  const revivedSet = new Set(revived);
  const finallyOut = eliminated.filter((p) => !revivedSet.has(p));

  for (const p of finallyOut.slice(0, 14)) {
    game.feed.push({ name: p.name, dept: p.dept, q: game.qIndex + 1, vip: p.vip });
  }

  const survivors = alivePlayers().length;

  // 문항과 문항 사이. 탈락 연출이 끝나기 전에 넘어가면 안 되고, 중계 멘트가 들어갈
  // 틈도 있어야 한다. 인원이 적을수록 길게 본다 —— 후반일수록 한 명 한 명이 중요해진다.
  // 10문항으로 늘리면서 각 구간을 1초씩 깎았다. 열 번 반복되므로 1초가 10초다.
  const revealMs = survivors > 0
    ? (survivors <= 10 ? 8000 : survivors < 30 ? 7000 : survivors < 100 ? 6000 : 5000)
    : 4000;

  game.phase = 'reveal';
  game.phaseEndsAt = Date.now() + revealMs;
  game.lastReveal = {
    answer: q.answer,
    evidence: q.evidence,
    source: q.source,
    o,
    x,
    choices: choicesAtReveal, // 공개 순간 전원의 선택이 드러난다
    eliminatedCount: finallyOut.length,
    eliminatedNames: finallyOut.slice(0, 8).map((p) => p.name),
    // 부활권이 자동으로 쓰인 사람들. 화면과 중계가 이걸 읽어 "살아 돌아왔다"고 알린다.
    revivedCount: revived.length,
    revivedNames: revived.slice(0, 8).map((p) => p.name),
    alive: survivors,
  };
  for (const p of revived) p.revivedAt = game.qIndex;
  pushState();

  schedule(revealMs, nextStep);
}

function nextStep() {
  const alive = alivePlayers();

  // 전멸 시 직전 문항 생존자끼리 서든데스로 구제한다.
  if (alive.length === 0) {
    const lastRound = [...game.players.values()].filter((p) => p.eliminatedAt === game.qIndex);
    if (lastRound.length >= 2) return beginSudden(lastRound);
    if (lastRound.length === 1) return finish(lastRound[0]);
    return finish(null);
  }

  // 한 명만 남으면 문항이 남았어도 거기서 끝난다.
  // 그래야 "몇 층에서 챔피언이 나왔는지"가 회차마다 달라져 이야깃거리가 된다.
  if (alive.length === 1) return finish(alive[0]);

  if (game.qIndex + 1 < game.questions.length) return beginQuestion(game.qIndex + 1);
  return beginSudden(alive);
}

function beginSudden(participants) {
  clearTimers();
  game.phase = 'sudden';
  // 뜸 구간. 문제는 armAt에 공개되고 그때 우승곡이 함께 흐른다.
  game.armAt = Date.now() + CONFIG.suddenArmMs;
  game.phaseEndsAt = game.armAt + CONFIG.suddenMs;

  for (const p of game.players.values()) {
    p.suddenValue = null;
    p.suddenRt = null;
    p.inSudden = false;
  }
  for (const p of participants) {
    p.inSudden = true;
    p.alive = true; // 전멸 구제 시 되살린다
  }

  pushState();
  scheduleBotSudden(participants);
  schedule(CONFIG.suddenArmMs + CONFIG.suddenMs, resolveSudden);
}

function resolveSudden() {
  clearTimers();
  const target = game.suddenQ.answer;
  const entries = [...game.players.values()]
    .filter((p) => p.inSudden && p.suddenValue !== null)
    .map((p) => ({ p, diff: Math.abs(p.suddenValue - target), rt: p.suddenRt ?? Infinity }))
    // 오차가 같으면 반응 시간으로 가린다 (PRD 5.5)
    .sort((a, b) => a.diff - b.diff || a.rt - b.rt);

  for (const p of game.players.values()) if (p.inSudden) p.alive = false;

  if (!entries.length) return finish(null);
  entries[0].p.alive = true;
  game.suddenResult = entries.slice(0, 5).map((e) => ({
    name: e.p.name,
    dept: e.p.dept,
    value: e.p.suddenValue,
    diff: e.diff,
    rt: e.rt === Infinity ? null : e.rt,
  }));
  finish(entries[0].p);
}

function finish(champion) {
  clearTimers();
  game.phase = 'result';
  game.phaseEndsAt = 0;

  const vip = vipPlayer();
  const all = [...game.players.values()];

  if (champion) champion.points += POINTS.champion;

  const ranking = all
    .sort((a, b) => {
      if (champion) {
        if (a === champion) return -1;
        if (b === champion) return 1;
      }
      return b.survived - a.survived || b.points - a.points;
    })
    .slice(0, 12)
    .map((p, i) => ({
      rank: i + 1,
      name: p.name,
      dept: p.dept,
      survived: p.survived,
      points: p.points,
      isNew: p.isNew,
      vip: p.vip,
    }));

  game.result = {
    champion: champion
      ? {
          name: champion.name,
          dept: champion.dept,
          div: champion.div,
          isNew: champion.isNew,
          survived: champion.survived,
          ci: champion.ci ?? null,
        }
      : null,
    scene: 'ground',
    ranking,
    sudden: game.suddenResult || null,
    suddenAnswer: game.suddenQ
      ? { text: game.suddenQ.text, value: game.suddenQ.answer, unit: game.suddenQ.unit, evidence: game.suddenQ.evidence }
      : null,
    // 문항 복기 — 회차가 끝난 뒤 무엇이 나왔고 왜 그 답인지 돌아볼 수 있어야 한다
    review: game.questions.map((q, i) => ({
      n: i + 1,
      text: q.text,
      answer: q.answer,
      difficulty: q.difficulty,
      evidence: q.evidence || '',
      source: (q.source && q.source.title) || '',
    })),
    // 스페셜 게스트는 소속 없이 참전한다. 격파 이벤트("원장을 이겨라")는 걷어냈으므로
    // 여기서는 어디까지 갔는지만 알린다 —— 굴욕적 연출도, 격파 집계도 없다.
    vip: vip ? { name: vip.name, title: vip.title, survived: vip.survived } : null,
    totalPlayers: all.length,
  };
  game.suddenResult = null;

  pushState();
  log(`round ${game.round} 종료 · 챔피언 ${champion ? champion.name : '없음'}`);
}

function resetGame() {
  clearTimers();
  game.phase = 'idle';
  game.demo = false;
  game.qIndex = -1;
  game.crowd = [];
  game.phaseEndsAt = 0;
  game.lastReveal = null;
  game.result = null;
  game.feed = [];
  clearBots();
  prunePlayers(0); // 리셋 시점에 끊겨 있는 참여자는 즉시 정리한다
  for (const p of game.players.values()) resetPlayerForRound(p);
  pushState();
}

// ---------------------------------------------------------------- 정기 회차

const KST_MS = 9 * 3600e3; // Render는 UTC로 돈다. KST는 DST가 없어 고정 오프셋이면 충분하다.

/** 다음 정기 회차(1번 문항이 나가는 시각)의 epoch ms. */
function nextGameAt(now = Date.now()) {
  const k = new Date(now + KST_MS); // UTC 게터로 KST를 읽는다
  const days = (CONFIG.gameDow - k.getUTCDay() + 7) % 7;
  let at = Date.UTC(
    k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate() + days,
    CONFIG.gameHour, CONFIG.gameMinute, 0, 0,
  ) - KST_MS;
  if (at <= now) at += 7 * 86400e3;
  return at;
}

/** 본게임 3분 전(12:52)부터 회차 시작(12:55)까지, 체험 모드를 잠근다. */
function demoLocked(now = Date.now()) {
  if (process.env.AUTO_START === '0') return false; // 개발·e2e 중에는 잠그지 않는다
  const gameAt = nextGameAt(now);
  return now >= gameAt - CONFIG.demoLockoutMs && now < gameAt;
}

/** 참여자·관전자 전원에게 같은 이벤트를 쏜다 (프리쇼 로고송 큐 등). */
function broadcastEvent(event, data) {
  for (const p of game.players.values()) if (p.res) sseSend(p.res, event, data);
  for (const res of game.spectators) sseSend(res, event, data);
}

let autoOpenedFor = 0;   // 이 회차를 이미 열었는지 (재시작 루프 방지)
let lastJingleMin = -1;

setInterval(() => {
  if (process.env.AUTO_START === '0') return;
  const now = Date.now();
  const gameAt = nextGameAt(now);
  const preAt = gameAt - CONFIG.preShowMs;
  if (now < preAt || now >= gameAt) return; // 프리쇼 창(12:50~12:55) 밖

  // 12:52 — 체험 모드가 돌고 있으면 끊는다. 본게임 3분 전에는 체험이 idle을 흔들 수 없어야 한다.
  if (game.demo && demoLocked(now)) {
    log('체험 모드 강제 종료 — 정기 회차 3분 전');
    resetGame();
  }

  // 12:50 — 대기실을 연다. 체험 회차는 밀어내고, 이미 도는 실전 회차는 건드리지 않는다.
  if (autoOpenedFor !== gameAt) {
    const realBusy = !game.demo && game.phase !== 'idle' && game.phase !== 'result';
    if (!realBusy) {
      autoOpenedFor = gameAt;
      log(`정기 회차 자동 개장 — ${Math.round((gameAt - now) / 1000)}초 뒤 1번 문항`);
      startGame(Math.max(3000, gameAt - now));
    }
  }

  // 프리쇼 동안 1분에 한 번, 전원이 같은 순간에 로고송
  const min = Math.floor(now / 60000);
  if (min !== lastJingleMin) {
    lastJingleMin = min;
    broadcastEvent('jingle', { at: now });
  }
}, 1000);

function forceNext() {
  switch (game.phase) {
    case 'lobby': return beginQuestion(0);
    case 'question': return revealQuestion();
    case 'reveal': return nextStep();
    case 'sudden': return resolveSudden();
    default: return null;
  }
}

// ---------------------------------------------------------------- HTTP

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e5) req.destroy();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch (_) { resolve({}); }
    });
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });

  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404');
    }
    // 음원은 무겁고 바뀌지 않는다. 매 접속마다 20MB를 다시 받게 하지 않는다.
    const heavy = /\.(wav|mp3|png)$/.test(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': heavy ? 'public, max-age=86400' : 'no-cache',
    });
    res.end(buf);
  });
}

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  // 로컬에서는 이 서버가 정적 파일까지 서빙한다.
  // 서버리스 배포에서는 플랫폼이 public/을 직접 서빙하므로 /api/*만 여기로 온다.
  if (!p.startsWith('/api/')) return serveStatic(req, res, p);

  // ---- 참여자 SSE
  if (p === '/api/stream') {
    const player = game.players.get(url.searchParams.get('token'));
    if (!player) return sendJson(res, 401, { error: 'invalid token' });

    if (player.res && !player.res.writableEnded) player.res.end();
    sseOpen(res);
    player.res = res;
    player.disconnectedAt = null;
    sseSend(res, 'state', personalState(player));

    req.on('close', () => {
      if (player.res !== res) return;
      player.res = null;
      player.disconnectedAt = Date.now();
    });
    return;
  }

  // ---- 상태 점검 (운영·부하 리허설용)
  if (p === '/api/health') {
    const m = process.memoryUsage();
    let connected = 0;
    for (const pl of game.players.values()) if (pl.res) connected += 1;
    return sendJson(res, 200, {
      ok: true,
      phase: game.phase,
      round: game.round,
      players: game.players.size,
      connected,
      spectators: game.spectators.size,
      alive: alivePlayers().length,
      tallyFrom: CONFIG.tallyVisibleFrom,
      bank: { pool: BANK.pool.length, sudden: BANK.sudden.length, roster: ROSTER.size },
      uptimeSec: Math.round(process.uptime()),
      rssMB: +(m.rss / 1048576).toFixed(1),
      heapMB: +(m.heapUsed / 1048576).toFixed(1),
    });
  }

  // ---- 대기실 미리보기 — 정답을 가르는 진술문(text)이 아니라 그 근거가 된 원문
  // 일부(evidence)만 보여준다. 실제로 출제될 문장을 미리 노출하면 안 된다 (인증 불필요).
  if (p === '/api/preview-questions') {
    const sample = [...BANK.pool]
      .sort(() => Math.random() - 0.5)
      .slice(0, 8)
      .map((q) => ({ evidence: q.evidence, difficulty: q.difficulty }));
    return sendJson(res, 200, { questions: sample });
  }

  // ---- 전광판 SSE (인증 불필요)
  if (p === '/api/spectate') {
    sseOpen(res);
    game.spectators.add(res);
    sseSend(res, 'state', publicState());
    req.on('close', () => game.spectators.delete(res));
    return;
  }

  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  const body = await readBody(req);

  // ---- 로그인
  if (p === '/api/login') {
    const emp = resolveEmployee(body.empId);
    if (!emp) return sendJson(res, 400, { error: `사번은 ${ID.digits}자리 숫자입니다.` });

    // 동시 세션 1개 제한 (PRD 7.6)
    const prev = game.byEmpId.get(emp.empId);
    if (prev && game.players.has(prev)) {
      const old = game.players.get(prev);
      if (old.res && !old.res.writableEnded) {
        sseSend(old.res, 'kicked', { reason: '다른 기기에서 접속했습니다.' });
        old.res.end();
      }
      game.players.delete(prev);
    }

    const token = crypto.randomUUID();
    const player = newPlayer(emp, token);
    if (game.phase !== 'idle' && game.phase !== 'lobby') {
      player.alive = false; // 진행 중 입장은 관전만 (PRD 5.1 입장 마감)
      player.eliminatedAt = -1;
    } else {
      player.points = POINTS.join;
    }

    game.players.set(token, player);
    game.byEmpId.set(emp.empId, token);
    pushState();

    return sendJson(res, 200, {
      token,
      user: { ...emp, isNew: player.isNew, revives: player.revives, spectatorOnly: !player.alive },
    });
  }

  // ---- 세션 확인
  //
  // 서버가 재시작되면 브라우저에 남아 있는 토큰은 전부 무효가 된다.
  // 이걸 알려주지 않으면 화면은 멀쩡한데 모든 동작이 조용히 실패한다.
  if (p === '/api/session') {
    const player = game.players.get(body.token);
    if (!player) return sendJson(res, 401, { error: 'invalid token' });
    return sendJson(res, 200, {
      ok: true,
      user: {
        empId: player.empId, name: player.name, dept: player.dept, div: player.div,
        years: player.years, isNew: player.isNew, vip: player.vip, revives: player.revives,
      },
    });
  }

  // ---- 답안 제출
  if (p === '/api/answer') {
    const player = game.players.get(body.token);
    if (!player) return sendJson(res, 401, { error: 'invalid token' });
    if (game.phase !== 'question') return sendJson(res, 409, { error: 'not accepting' });
    if (!player.alive) return sendJson(res, 409, { error: 'eliminated' });
    if (body.qIndex !== game.qIndex) return sendJson(res, 409, { error: 'stale question' });
    // 브리핑이 끝나기 전에는 접수하지 않는다. 서버가 문을 여는 시각이 모두에게 같다.
    // 네트워크와 시계 오차만큼은 봐준다. 진짜로 이른 것만 막는다.
    if (game.armAt && Date.now() < game.armAt - 250) return sendJson(res, 409, { error: 'not armed' });
    if (body.answer !== 'O' && body.answer !== 'X') return sendJson(res, 400, { error: 'bad answer' });

    player.answer = body.answer; // 마감 전까지 변경 가능 (PRD 5.2)
    player.rt = Number(body.rt) || null;
    return sendJson(res, 200, { ok: true });
  }

  // ---- 부활권
  //
  // 이제 서버가 정답 공개 때 자동으로 쓴다. 옛 클라이언트가 남아 있을 수 있어
  // 엔드포인트 자체는 남기되, 언제나 "고를 것이 없다"고 답한다.
  if (p === '/api/revive') {
    if (!game.players.get(body.token)) return sendJson(res, 401, { error: 'invalid token' });
    return sendJson(res, 409, { error: 'auto' });
  }

  // ---- 서든데스
  if (p === '/api/sudden') {
    const player = game.players.get(body.token);
    if (!player) return sendJson(res, 401, { error: 'invalid token' });
    if (game.phase !== 'sudden' || !player.inSudden) return sendJson(res, 409, { error: 'not participant' });
    if (game.armAt && Date.now() < game.armAt - 250) return sendJson(res, 409, { error: 'not armed' });
    const v = Number(body.value);
    if (!Number.isFinite(v)) return sendJson(res, 400, { error: 'bad value' });
    player.suddenValue = v;
    player.suddenRt = Number(body.rt) || null;
    return sendJson(res, 200, { ok: true });
  }

  // ---- 체험 모드
  //
  // 혼자서도, 아무 때나 게임 전체를 확인할 수 있어야 한다. 운영 키가 필요 없고
  // 대기실을 짧게 잡아 바로 시작한다. 실전 회차가 진행 중일 때는 거부한다.
  if (p === '/api/demo/start') {
    const player = game.players.get(body.token);
    if (!player) return sendJson(res, 401, { error: 'invalid token' });
    if (demoLocked()) {
      return sendJson(res, 409, { error: '월요일 12:52부터 본게임 완료까지 체험 모드가 비활성화됩니다.' });
    }
    if (game.phase !== 'idle' && game.phase !== 'result' && !game.demo) {
      return sendJson(res, 409, { error: '실전 회차가 진행 중입니다.' });
    }

    clearBots();
    const bots = Math.max(0, Math.min(600, Number(body.bots) || 80));
    spawnBots(bots);

    player.disconnectedAt = player.res ? null : Date.now();
    startGame(Math.max(2000, (Number(body.lobbySec) || 5) * 1000), { demo: true });
    log(`체험 모드 시작 · 봇 ${bots}명 · 요청자 ${player.name}`);
    return sendJson(res, 200, { ok: true, bots });
  }

  // ---- 운영자
  if (p.startsWith('/api/admin/')) {
    if (body.key !== CONFIG.adminKey) return sendJson(res, 403, { error: 'bad key' });
    const action = p.slice('/api/admin/'.length);

    if (action === 'start') {
      // 문항 수는 5~10만 허용. 범위 밖(미지정 포함)이면 기본 사다리(5문항).
      const qc = Math.round(Number(body.questionCount));
      startGame(
        Number(body.lobbySec) > 0 ? Number(body.lobbySec) * 1000 : CONFIG.lobbyMs,
        { questionCount: qc >= 5 && qc <= 10 ? qc : undefined },
      );
      return sendJson(res, 200, { ok: true });
    }
    // 콘솔 입장 게이트. 키 검사는 위에서 이미 끝났으므로 도달 = 유효한 키.
    if (action === 'verify') return sendJson(res, 200, { ok: true });
    if (action === 'next') { forceNext(); return sendJson(res, 200, { ok: true }); }
    if (action === 'reset') { resetGame(); return sendJson(res, 200, { ok: true }); }
    if (action === 'reload') {
      BANK = loadJson('questions.json');
      STAFF = loadJson('employees.json');
      ROSTER = new Map(STAFF.roster.map((r) => [r.empId, r]));
      DEPTS = STAFF.departments.map((d) => (typeof d === 'string' ? { name: d, division: 'etc' } : d));
      DIVISIONS = STAFF.divisions || DIVISIONS;
      DEPT_DIV = new Map(DEPTS.map((d) => [d.name, d.division]));
      rebuildOpenDepts();
      DIV_COLOR = new Map(DIVISIONS.map((d) => [d.id, d.color]));
      ID = Object.assign({ digits: 5, yearPrefix: 2, defaultYears: 5 }, STAFF.idFormat || {});
      ID_RE = new RegExp(`^\\d{${ID.digits}}$`);
      return sendJson(res, 200, {
        ok: true, pool: BANK.pool.length, roster: ROSTER.size,
        digits: ID.digits, divisions: DIVISIONS.length, departments: DEPTS.length,
      });
    }
    return sendJson(res, 404, { error: 'unknown action' });
  }

  return sendJson(res, 404, { error: 'not found' });
}

const server = http.createServer(handler);

// ---------------------------------------------------------------- 부팅

function log(msg) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`[${t}] ${msg}`);
}

// 직접 실행할 때만 포트를 연다. 서버리스에서는 handler만 가져다 쓴다.
if (require.main === module) {
  server.listen(CONFIG.port, () => {
    const bar = '─'.repeat(46);
    console.log(`\n${bar}`);
    console.log('  12:55  —  전사 실시간 OX 서바이벌');
    console.log(bar);
    console.log(`  참여자   http://localhost:${CONFIG.port}/`);
    console.log(`  전광판   http://localhost:${CONFIG.port}/board.html`);
    console.log(`  운영자   http://localhost:${CONFIG.port}/admin.html   (키: ${CONFIG.adminKey})`);
    console.log(`${bar}`);
    console.log(`  문제 ${BANK.pool.length}개 · 서든데스 ${BANK.sudden.length}개 · 명부 ${ROSTER.size}명`);
    console.log(`${bar}`);

    // 기본 운영 키는 공개 저장소에 그대로 들어 있다.
    // 외부에 노출한 채로 쓰면 URL을 아는 누구나 회차를 리셋할 수 있다.
    if (CONFIG.adminKey === 'kipi') {
      console.log('  ⚠  운영 키가 기본값입니다. 사내망 밖으로 공개할 때는 반드시 바꾸세요.');
      console.log('     ADMIN_KEY=원하는키 node server.js');
      console.log(`${bar}`);
    }
    console.log('');
  });
}

module.exports = handler;
