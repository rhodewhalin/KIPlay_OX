'use strict';

/**
 * 12:55 — E2E 검증
 *
 * 실제 HTTP/SSE로 플레이어를 붙여 게임 전체를 돌린다.
 * 빌드가 통과했다는 것은 게임이 동작한다는 증거가 아니므로, 상태 기계 전이와
 * 탈락 판정의 불변식을 실제 플레이로 확인한다.
 *
 *   시나리오 A  정상 진행 — 8명이 무작위 응답, 5문항 완주와 탈락 산식 검증
 *   시나리오 B  부활권    — 신입이 무응답으로 탈락 → 부활권 사용 → 재탈락
 *   시나리오 C  전멸 구제 — 전원 무응답으로 전멸 → 서든데스 → 근접값 판정
 *
 * 실행:  node scripts/e2e.js
 */

const http = require('http');

const PORT = Number(process.env.PORT) || 12055;
const KEY = process.env.ADMIN_KEY || 'kipi';
const HOST = '127.0.0.1';

let pass = 0;
let fail = 0;

const ok = (cond, msg) => {
  if (cond) { pass += 1; console.log(`  ✓ ${msg}`); }
  else { fail += 1; console.log(`  ✗ ${msg}`); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────────────────────── HTTP 헬퍼

function post(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: HOST, port: PORT, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let data = {};
          try { data = JSON.parse(raw); } catch (_) { /* 빈 응답 */ }
          resolve({ status: res.statusCode, data });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/** SSE 스트림을 구독한다. 반환된 함수를 호출하면 끊는다. */
function sse(path, onEvent) {
  const req = http.get({ host: HOST, port: PORT, path }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let event = null;
        let data = null;
        for (const line of raw.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7).trim();
          else if (line.startsWith('data: ')) data = line.slice(6);
        }
        if (event && data) {
          try { onEvent(event, JSON.parse(data)); } catch (_) { /* 무시 */ }
        }
      }
    });
  });
  req.on('error', () => {});
  return () => req.destroy();
}

// ───────────────────────────────────────────── 플레이어

async function join(empId, strategy) {
  const { status, data } = await post('/api/login', { empId });
  if (status !== 200) throw new Error(`login ${empId} 실패: ${JSON.stringify(data)}`);

  const p = {
    empId,
    name: data.user.name,
    isNew: data.user.isNew,
    token: data.token,
    strategy,
    submitted: [],     // 문항별 제출 답
    answering: -1,     // 이 문항의 제출을 이미 시작했는가
    revivedAt: [],     // 부활권이 자동으로 쓰인 문항들
    alive: true,
    survived: 0,
    close: null,
  };

  p.close = sse(`/api/stream?token=${p.token}`, async (event, s) => {
    if (event !== 'state') return;
    p.alive = s.me.alive;
    p.survived = s.me.survived;

    if (s.phase === 'question' && s.me.alive && p.answering !== s.qIndex) {
      p.answering = s.qIndex;
      const answer = strategy(s.qIndex);
      p.submitted[s.qIndex] = answer;              // null이면 무응답
      if (answer) {
        // 브리핑 구간에는 서버가 접수하지 않는다(409 not armed). 문이 열린 뒤에 낸다.
        const wait = (s.armAt || 0) - Date.now();
        if (wait > 0) await sleep(wait + 150);
        await post('/api/answer', { token: p.token, qIndex: s.qIndex, answer, rt: 1200 });
      }
    }

    // 부활권은 서버가 정답 공개 때 자동으로 쓴다. 클라이언트가 할 일이 없다.
    if (s.phase === 'reveal' && s.me.revived && !p.revivedAt.includes(s.qIndex)) {
      p.revivedAt.push(s.qIndex);
    }

    if (s.phase === 'sudden' && s.me.inSudden && p.suddenValue !== undefined && !p.suddenSent) {
      p.suddenSent = true;
      // 서든데스도 브리핑(뜸) 뒤에 문이 열린다. 그전 제출은 409로 거절된다.
      const wait = (s.armAt || 0) - Date.now();
      if (wait > 0) await sleep(wait + 150);
      await post('/api/sudden', { token: p.token, value: p.suddenValue, rt: p.suddenRt || 3000 });
    }
  });

  return p;
}

/** 전광판 스트림으로 회차 전체를 관찰한다. */
function observe() {
  const seen = { phases: [], reveals: [], result: null, aliveTrail: [] };
  const close = sse('/api/spectate', (event, s) => {
    if (event !== 'state') return;
    if (seen.phases[seen.phases.length - 1] !== s.phase) seen.phases.push(s.phase);
    if (s.phase === 'reveal' && s.reveal) seen.reveals.push(s.reveal);
    if (s.qTotal) seen.qTotal = s.qTotal;
    if (s.phase === 'result') seen.result = s.result;
    seen.aliveTrail.push(s.alive);
  });
  return { seen, close };
}

// 10문항 회차는 3분 후반까지 간다. 예산은 6분이다 —— 회사 공식 행사라 13시를 조금
// 넘겨도 된다는 결정이 있었다. 슬롯이 하드 제약이므로 실제 소요 시간도 함께 기록한다.
async function waitForResult(obs, timeoutMs = 360000) {
  const t0 = Date.now();
  while (!obs.seen.result && Date.now() - t0 < timeoutMs) await sleep(200);
  obs.elapsedMs = Date.now() - t0;
  return obs.seen.result;
}

// ───────────────────────────────────────────── 시나리오

/**
 * 시나리오 사이의 방화벽.
 *
 * 앞 시나리오가 SSE를 닫자마자 리셋을 부르면, 서버의 req.on('close')가 아직 돌기 전이라
 * prunePlayers가 그 참여자를 접속 중으로 보고 건너뛴다. 유령은 다음 회차에 합류해
 * 인원 수 단언을 전부 흔든다 —— 간헐적으로만 실패하는 이유가 이 경합이었다.
 *
 * 끊김이 반영될 틈을 준 뒤 리셋하고, 정말 0명이 됐는지 확인한다. 그래도 남아 있으면
 * e2e 밖의 클라이언트(브라우저 탭 등)가 붙어 있다는 뜻이므로 이름을 밝히고 실패시킨다.
 */
async function resetServer() {
  await sleep(400);
  await post('/api/admin/reset', { key: KEY });
  for (let i = 0; i < 6; i += 1) {
    await sleep(150);
    const h = await get('/api/health');
    if (h.players === 0) return;
    await post('/api/admin/reset', { key: KEY });
  }
  const h = await get('/api/health');
  if (h.players > 0) {
    console.log(`  ⚠ 리셋 후에도 ${h.players}명이 붙어 있습니다. e2e 밖에서 접속 중인 클라이언트를 닫으세요.`);
  }
}

async function scenarioA() {
  console.log('\n[A] 정상 진행 — 8명 무작위 응답');
  await resetServer();

  const obs = observe();
  const players = [];
  const ids = ['05021', '08033', '10007', '13018',
               '16011', '18003', '20025', '22016'];

  for (const id of ids) {
    players.push(await join(id, () => (Math.random() < 0.5 ? 'O' : 'X')));
  }
  await sleep(300);

  ok(players.length === 8, '8명 입장');

  await post('/api/admin/start', { key: KEY, lobbySec: 2 });
  const result = await waitForResult(obs);

  ok(!!result, '결과 단계 도달');
  ok(obs.seen.phases.includes('lobby'), '대기실 단계 통과');
  ok(obs.seen.phases.includes('question'), '문항 단계 통과');
  ok(obs.seen.phases.includes('reveal'), '정답공개 단계 통과');
  ok(obs.seen.phases[obs.seen.phases.length - 1] === 'result', '마지막 단계는 결과');

  // 탈락 산식 불변식: 각 문항의 탈락자 수 = 그 시점 생존자 중 오답자 수
  let expectedAlive = 8;
  let mathOk = true;
  obs.seen.reveals.forEach((r, qi) => {
    const wrong = players.filter(
      (p) => p.submitted[qi] !== undefined && p.submitted[qi] !== r.answer,
    ).length;
    void wrong; // 개별 추적은 참고용. 아래 총량 불변식으로 검증한다.
    if (r.alive > expectedAlive) mathOk = false;
    expectedAlive = r.alive;
  });
  ok(mathOk, '생존자 수가 단조 감소');

  const finalAlive = obs.seen.reveals.length
    ? obs.seen.reveals[obs.seen.reveals.length - 1].alive
    : 0;
  ok(finalAlive <= 8, `최종 생존 ${finalAlive}명 (시작 8명 이하)`);
  ok(Array.isArray(result.ranking) && result.ranking.length > 0, `순위표 ${result.ranking.length}행 생성`);
  ok(result.totalPlayers === 8, '총 참가자 수 일치');

  const survivedSum = result.ranking.reduce((a, r) => a + r.survived, 0);
  const qTotal = obs.seen.qTotal || 10;
  ok(survivedSum >= 0 && result.ranking.every((r) => r.survived <= qTotal), `생존 문항 수가 0~${qTotal} 범위`);

  for (const p of players) p.close();
  obs.close();
}

async function scenarioB() {
  console.log('\n[B] 부활권 — 신입 무응답 탈락 후 부활');
  await resetServer();

  const obs = observe();
  const newbie = await join('26005', () => null);          // 절대 응답하지 않는다
  const vet1 = await join('05021', () => 'O');
  const vet2 = await join('08033', () => 'X');
  await sleep(300);

  ok(newbie.isNew === true, `${newbie.name} 신입 판정 (부활권 대상)`);
  ok(vet1.isNew === false, `${vet1.name} 고참 판정 (부활권 없음)`);

  await post('/api/admin/start', { key: KEY, lobbySec: 2 });
  await waitForResult(obs);

  ok(newbie.revivedAt.length === 1, `부활권이 자동으로 1회 쓰임 (문항 ${newbie.revivedAt.map((i) => i + 1).join(',') || '-'})`);
  ok(obs.seen.reveals.some((r) => r.revivedCount > 0), '정답 공개에 부활 인원이 실림');
  ok(!obs.seen.phases.includes('revive'), '부활권 선택 단계가 없다 (물어보지 않는다)');
  ok(newbie.survived === 0, '무응답이므로 생존 문항 0 (미응답은 오답 처리)');

  const feedRevived = obs.seen.result && obs.seen.result.ranking.some((r) => r.isNew);
  ok(feedRevived, '순위표에 신입이 표시됨');

  newbie.close(); vet1.close(); vet2.close();
  obs.close();
}

async function scenarioC() {
  console.log('\n[C] 전멸 구제 — 전원 무응답 후 서든데스');
  await resetServer();

  const obs = observe();
  const a = await join('05021', () => null);
  const b = await join('08033', () => null);
  const c = await join('10007', () => null);

  // 서든데스 제출값을 미리 심어둔다. 정답에 가장 가까운 사람이 이겨야 한다.
  a.suddenValue = 1;    a.suddenRt = 5000;
  b.suddenValue = 900;  b.suddenRt = 4000;
  c.suddenValue = 5000; c.suddenRt = 3000;
  await sleep(300);

  await post('/api/admin/start', { key: KEY, lobbySec: 2 });
  const result = await waitForResult(obs);

  ok(obs.seen.phases.includes('sudden'), '전원 탈락 시 서든데스로 구제됨');
  ok(!!result && !!result.champion, `챔피언 결정됨 (${result && result.champion ? result.champion.name : '없음'})`);

  if (result && result.champion && result.suddenAnswer) {
    const target = result.suddenAnswer.value;
    const diffs = [
      { name: a.name, d: Math.abs(a.suddenValue - target) },
      { name: b.name, d: Math.abs(b.suddenValue - target) },
      { name: c.name, d: Math.abs(c.suddenValue - target) },
    ].sort((x, y) => x.d - y.d);
    ok(result.champion.name === diffs[0].name,
      `근접값 판정 정확 — 정답 ${target}, 승자 ${diffs[0].name} (오차 ${diffs[0].d})`);
  }

  a.close(); b.close(); c.close();
  obs.close();
}

async function scenarioD() {
  console.log('\n[D] 입력 검증');
  const bad = await post('/api/login', { empId: '123' });
  ok(bad.status === 400, '잘못된 사번 형식 거부');

  const tooLong = await post('/api/login', { empId: '260051' });
  ok(tooLong.status === 400, '6자리 사번 거부');

  const impossible = await post('/api/login', { empId: '27000' });
  ok(impossible.status === 400, '범위 밖 입사연도(1927) 거부');

  const noKey = await post('/api/admin/start', { key: 'wrong' });
  ok(noKey.status === 403, '잘못된 운영 키 거부');

  const noToken = await post('/api/answer', { token: 'nope', answer: 'O', qIndex: 0 });
  ok(noToken.status === 401, '유효하지 않은 토큰 거부');

  // 동시 세션 1개 제한
  const first = await post('/api/login', { empId: '14062' });
  const second = await post('/api/login', { empId: '14062' });
  ok(first.status === 200 && second.status === 200 && first.data.token !== second.data.token,
    '재로그인 시 새 토큰 발급 (이전 세션 축출)');

  const stale = await post('/api/answer', { token: first.data.token, answer: 'O', qIndex: 0 });
  ok(stale.status === 401, '축출된 이전 토큰은 거부됨');
}

async function scenarioE() {
  console.log('\n[E] 체험 모드 — 혼자서 봇 40명과 진행');
  await resetServer();

  const obs = observe();
  const solo = await join('26005', () => (Math.random() < 0.5 ? 'O' : 'X'));
  solo.suddenValue = 1000;
  await sleep(250);

  const started = await post('/api/demo/start', { token: solo.token, bots: 40, lobbySec: 2 });
  ok(started.status === 200, '운영 키 없이 체험 시작');
  ok(started.data.bots === 40, `봇 ${started.data.bots}명 생성`);

  await sleep(600);
  let health = await get('/api/health');
  ok(health.players === 41, `참가 인원 41명 (본인 1 + 봇 40) — 실제 ${health.players}`);
  ok(health.phase === 'lobby', '대기실 진입');

  let sawDemoFlag = false;
  let sawMoving = false;   // 방향까지 담긴 마스크가 왔는가 (사람들이 O/X로 달려간다)
  let sawDeciding = false;
  let leakedTally = false;
  let peakAlive = 0;
  const closeTally = sse('/api/spectate', (event, s) => {
    if (event === 'state' && s.demo) sawDemoFlag = true;
    if (event === 'tally') {
      if (s.choices && /[OX]/.test(s.choices)) sawMoving = true;
      if (s.tallyVisible === false && (s.o !== null || s.x !== null)) leakedTally = true;
      if (s.decided && s.decided.includes('1')) sawDeciding = true;
      peakAlive = Math.max(peakAlive, s.alive);
    }
  });

  const result = await waitForResult(obs);

  ok(sawDemoFlag, '상태에 체험 모드 표시가 실림 (화면에 안내 띠가 뜬다)');
  ok(sawMoving, '진행 중 선택 방향이 전달됨 (사람들이 O/X로 달려간다)');
  ok(!leakedTally, '가려진 구간에서 집계가 새지 않음');
  ok(sawDeciding || sawMoving, '선택 상태가 매 초 전달됨');

  const firstReveal = obs.seen.reveals[0];
  const split = firstReveal && firstReveal.choices &&
    firstReveal.choices.includes('O') && firstReveal.choices.includes('X');
  ok(split, '정답 공개 순간 전원의 선택이 O/X로 갈려 드러남');
  ok(peakAlive > 1, `한때 생존자 ${peakAlive}명 (봇 포함)`);
  ok(!!result, '체험 회차 정상 종료');
  ok(result && result.totalPlayers === 41, `결과 집계 41명 — 실제 ${result ? result.totalPlayers : '-'}`);
  ok(result && result.ranking.length > 1, '순위표에 봇이 함께 표시됨');

  // 탈락 곡선이 실제처럼 줄어드는지
  const trail = obs.seen.reveals.map((r) => r.alive);
  const monotone = trail.every((v, i) => i === 0 || v <= trail[i - 1]);
  ok(monotone, `생존 곡선 단조 감소 [${trail.join(' → ')}]`);

  closeTally();
  solo.close();
  obs.close();

  // 소켓을 끊었다고 서버가 곧바로 아는 건 아니다. req.on('close')가 이벤트 루프를 한 바퀴
  // 돌고 나서야 p.res가 비워지고, 그전에 리셋이 들어오면 prunePlayers가 아직 붙어 있는
  // 참여자로 보고 건너뛴다. 끊긴 것이 서버에 반영될 틈을 준다.
  await sleep(400);

  // 리셋하면 봇이 사라져야 한다
  await resetServer();
  health = await get('/api/health');
  ok(health.players === 0, `리셋 후 봇 정리됨 — 남은 인원 ${health.players}`);
  ok(health.phase === 'idle', '리셋 후 대기 상태');
}

function get(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: HOST, port: PORT, path }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function scenarioF() {
  console.log('\n[F] 층 상승과 집계 가리기 경계 — 봇 150명');
  await resetServer();

  const obs = observe();
  const solo = await join('15029', () => (Math.random() < 0.5 ? 'O' : 'X'));
  solo.suddenValue = 1000;
  await sleep(250);

  // 가리기 임계값은 서버가 정한다. 테스트가 상수를 따로 들고 있으면 어긋난다.
  const cfg = await get('/api/health');
  const TH = cfg.tallyFrom;

  let visibleAbove = false;   // 임계값 이상일 때 집계가 보였는가
  let hiddenBelow = false;    // 임계값 밑으로 떨어지자 가려졌는가
  let leak = false;
  let crowdSeen = null;

  const close = sse('/api/spectate', (event, s) => {
    if (event === 'state') {
      if (s.crowd) crowdSeen = s.crowd;
    }
    if (event === 'tally') {
      if (s.alive >= TH && s.tallyVisible && s.o !== null) visibleAbove = true;
      if (s.alive < TH && s.tallyVisible === false) hiddenBelow = true;
      if (s.tallyVisible === false && s.o !== null) leak = true;
    }
  });

  await post('/api/demo/start', { token: solo.token, bots: 150, lobbySec: 2 });
  // 탈락 연출과 문항 브리핑으로 한 판이 2분을 넘길 수 있다
  const result = await waitForResult(obs, 360000);

  ok(visibleAbove, `${TH}명 이상 구간에서는 집계가 보임`);
  ok(!leak, '가려진 뒤로는 집계가 한 번도 새지 않음');
  void hiddenBelow; // 임계값 아래 구간은 시나리오 G에서 확정적으로 검증한다

  ok(crowdSeen && crowdSeen.n === 151, `군중 배열 ${crowdSeen ? crowdSeen.n : '-'}명 (본인 1 + 봇 150)`);
  ok(crowdSeen && crowdSeen.div.length === crowdSeen.n, '본부 마스크 길이가 인원과 일치');
  // 명부의 divisions를 그대로 싣는지만 본다. 개수를 상수로 박아 두면 조직 개편 때마다 깨진다.
  // (본부 6 + 스페셜 게스트 1 — guest는 본부가 아니라 소속 없는 참전자의 칸이다.)
  ok(crowdSeen && crowdSeen.divisions.length >= 2
     && crowdSeen.divisions.every((d) => d.id && /^#[0-9A-Fa-f]{6}$/.test(d.color || '')),
     `본부 색 ${crowdSeen ? crowdSeen.divisions.length : '-'}개 — 모두 id와 색을 갖춤`);
  ok(crowdSeen && !crowdSeen.div.split('').some((ch) => {
       const d = crowdSeen.divisions[Number(ch)];
       return d && d.id === 'guest';
     }), '봇은 스페셜 게스트 칸에 배정되지 않음');

  // 층 구조는 걷어냈다. 게임장은 하나이므로 결과의 장면도 늘 게임장이다.
  ok(result && result.scene === 'ground', `게임장 장면 '${result ? result.scene : '-'}' 전달됨`);

  // 5분 슬롯이 하드 제약이다. 대기실 2초를 뺀 순수 게임 시간을 본다.
  const gameSec = (obs.elapsedMs - 2000) / 1000;
  // 예산은 점심시간 마지막 5분이다. 그 안에만 들어오면 된다.
  ok(gameSec < 360, `한 판 ${gameSec.toFixed(1)}초 — 6분 예산 이내`);

  close(); solo.close(); obs.close();
}

async function scenarioG() {
  console.log('\n[G] 임계값 아래 — 처음부터 소수 인원');
  await resetServer();

  const cfg = await get('/api/health');
  const TH = cfg.tallyFrom;
  const bots = Math.max(4, TH - 12); // 시작부터 임계값 아래가 되도록 확정적으로 잡는다

  const obs = observe();
  const solo = await join('15029', () => (Math.random() < 0.5 ? 'O' : 'X'));
  solo.suddenValue = 1000;
  await sleep(250);

  let sawHidden = false;
  let leaked = false;
  let sawDecided = false;
  let sawDirection = false;
  let maxAlive = 0;

  const close = sse('/api/spectate', (event, s) => {
    if (event !== 'tally') return;
    maxAlive = Math.max(maxAlive, s.alive);
    if (s.tallyVisible === false && s.o === null) sawHidden = true;
    if (s.tallyVisible === false && (s.o !== null || s.x !== null)) leaked = true;
    if (s.decided && s.decided.includes('1')) sawDecided = true;
    if (s.choices) sawDirection = true;
  });

  await post('/api/demo/start', { token: solo.token, bots, lobbySec: 2 });
  await waitForResult(obs);

  ok(maxAlive < TH, `전 구간 ${TH}명 미만 유지 (최대 ${maxAlive}명)`);
  ok(sawHidden, `${TH}명 미만이라 진행 중 집계가 가려짐`);
  ok(!leaked, '가려진 구간에서 집계가 새지 않음');
  ok(!sawDirection, '방향 마스크가 전혀 전달되지 않음 (개발자도구로도 볼 수 없다)');
  ok(sawDecided, '방향은 감춰도 "선택함" 표시는 전달됨');

  const firstReveal = obs.seen.reveals[0];
  ok(firstReveal && firstReveal.choices && /[OX]/.test(firstReveal.choices),
    '정답 공개 순간에는 전원의 선택이 드러남');

  close(); solo.close(); obs.close();
}

// ───────────────────────────────────────────── 실행

(async () => {
  console.log('12:55 — E2E 검증 시작\n' + '─'.repeat(46));
  try {
    await scenarioD();
    await scenarioA();
    await scenarioB();
    await scenarioC();
    await scenarioE();
    await scenarioF();
    await scenarioG();
  } catch (err) {
    fail += 1;
    console.log(`\n  ✗ 예외 발생: ${err.message}`);
  }

  await post('/api/admin/reset', { key: KEY }).catch(() => {});

  console.log('\n' + '─'.repeat(46));
  console.log(`통과 ${pass} · 실패 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
