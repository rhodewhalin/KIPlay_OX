'use strict';

/**
 * 12:55 — 전광판
 *
 * 군중 무대(crowd.js)를 띄우고 서버 이벤트를 그 위에 얹는다.
 * 인증 없이 /api/spectate 만 구독하며, 하루 종일 켜둘 수 있어야 하므로
 * 화면이 가려지면 루프를 멈추고 복귀 시 서버 시계로 다시 맞춘다.
 */

const $ = (id) => document.getElementById(id);

let snap = null;
let clockOffset = 0;
let rafId = null;
let feedSeen = 0;
let dropTimer = null;
let stage = null;
let audioReady = false;
let lastPhase = null;
let lastQIndex = -1;
let countdownAt = null;
let sceneLocked = false;
let suddenArmTimer = null;

const now = () => Date.now() + clockOffset;
const pad2 = (n) => String(n).padStart(2, '0');

function fmtClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
}

// ─────────────────────────────────────────── 엔딩 카드
//
// 전광판이 진짜 쇼다. 참여자 화면보다 오래 머문다.

let endingCard = null;
let endingDone = false;

/**
 * 공보 서지사항을 만든다.
 *
 * 등록번호는 회차와 이름에서 뽑아 매주 다르되 같은 회차에서는 늘 같게 나온다.
 * 자리수는 실제 최근 등록번호(10-30xxxxx)에 맞췄다.
 */
function buildGazette(s, r) {
  const ch = r.champion;
  let hash = 0;
  const seedStr = `${ch.name}${ch.dept}${r.totalPlayers}${(s.crowd && s.crowd.round) || 1}`;
  for (let i = 0; i < seedStr.length; i += 1) hash = (hash * 31 + seedStr.charCodeAt(i)) >>> 0;

  const d = new Date(s.serverNow || Date.now());
  const yy = d.getFullYear();
  const pubDate = `${yy}년${String(d.getMonth() + 1).padStart(2, '0')}월${String(d.getDate()).padStart(2, '0')}일`;
  const runnerUp = (r.ranking && r.ranking[1] && r.ranking[1].name) || '심사부';

  return {
    regNo: `10-30${String(hash % 100000).padStart(5, '0')}`,
    appNo: `10-${yy}-0${String(hash % 1000000).padStart(6, '0')}`,
    pubDate,
    examiner: runnerUp,
    round: (s.crowd && s.crowd.round) || 1,
  };
}

function playEnding(s) {
  const r = s.result;
  if (!r || !r.champion || endingDone) return;
  if (!window.EndingCard || !$('ending')) return;
  endingDone = true;
  if (!endingCard) endingCard = new window.EndingCard($('ending'));
  Music.crown();   // 우승 확정 즉시. 곡의 좋은 부분을 기다리게 하지 않는다.
  endingCard.show(Object.assign({
    name: r.champion.name,
    dept: r.champion.dept,
    survived: r.champion.survived,
    isNew: r.champion.isNew,
    totalPlayers: r.totalPlayers,
  }, buildGazette(s, r)));
}

// ─────────────────────────────────────────── 무대

function initStage() {
  stage = new CrowdStage($('stage-canvas'), { zones: true });
  stage.setBackdrop(window.ROOF_BACKDROP_CONFIG);
  stage.start();

  // 장면 확인용 픽스처. 서버 없이 바로 볼 수 있다.
  //   /board.html?scene=ground   ground | rooftop
  const forced = new URLSearchParams(location.search).get('scene');
  if (forced && CROWD_SCENES[forced]) {
    stage.scene = forced;
    stage.sceneT = 1;
    stage.sceneLocked = true;   // 서버 상태가 덮어쓰지 못하게 잠근다
    sceneLocked = true;
  }
}


// ─────────────────────────────────────────── 타이머 루프

function loop() {
  rafId = requestAnimationFrame(loop);
  if (!snap || !snap.phaseEndsAt) return;

  const remain = snap.phaseEndsAt - now();

  if (snap.phase === 'question' || snap.phase === 'sudden') {
    const total = snap.phase === 'sudden' ? (snap.suddenMs || 20000) : (snap.questionMs || 10000);
    $('b-timer-fill').style.transform = `scaleX(${Math.max(0, Math.min(1, remain / total))})`;
    $('b-timer').classList.toggle('urgent', remain <= 3000);
  } else if (snap.phase === 'lobby') {
    $('b-center-big').textContent = fmtClock(remain);
  }

  // 다음 문항 3초 전 카운트다운. 대기실과 정답 공개의 꼬리를 그대로 쓴다.
  if (audioReady && (snap.phase === 'lobby' || snap.phase === 'reveal')) {
    const sec = Math.ceil(remain / 1000);
    if (remain > 0 && sec <= 3 && sec !== countdownAt) {
      countdownAt = sec;
      Sfx.countTick(sec);
    }
    if (remain > 3200) countdownAt = null;
  }
}

function startLoop() { if (!rafId) rafId = requestAnimationFrame(loop); }
function stopLoop() { if (rafId) cancelAnimationFrame(rafId); rafId = null; }

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { stopLoop(); if (stage) stage.stop(); Music.stopAll(); }
  else { startLoop(); if (stage) stage.start(); }
});

// ─────────────────────────────────────────── 렌더

function renderSplit(s) {
  const box = $('b-split');
  const hidden = s.tallyVisible === false;
  box.classList.toggle('hidden', hidden);

  if (hidden) {
    $('b-num-o').textContent = 'O ?';
    $('b-num-x').textContent = '? X';
    $('b-fill-o').style.width = '50%';
    $('b-fill-x').style.width = '50%';
    return;
  }
  const o = s.o || 0;
  const x = s.x || 0;
  const total = Math.max(1, o + x);
  $('b-fill-o').style.width = `${(o / total) * 100}%`;
  $('b-fill-x').style.width = `${(x / total) * 100}%`;
  $('b-num-o').textContent = `O ${o}`;
  $('b-num-x').textContent = `${x} X`;
}

let divColors = new Map();

/** 본부별 잔여 현황. 어느 본부가 버티고 있는지가 부서 대항의 서사다. */
function renderDivStanding(s) {
  const box = $('b-divstand');
  const counts = s.divAlive || {};
  const names = new Map((s.divisionNames || []).map((d) => [d.id, d]));
  const rows = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);

  if (!rows.length) { box.innerHTML = ''; return; }
  const top = rows[0][1];

  box.innerHTML = '';
  for (const [id, n] of rows) {
    const info = names.get(id) || {};
    const el = document.createElement('div');
    el.className = 'row' + (n === top ? ' lead' : '');
    el.innerHTML =
      `<i style="background:${divColors.get(id) || '#8B93B0'}"></i>` +
      `<span>${info.short || info.name || id}</span>` +
      `<span class="n">${n}</span>`;
    box.appendChild(el);
  }
}

// ── 중계
const commentary = new Commentary();
const captionQueue = [];
let lastSpokenPhase = null;
const GAP_MS = 600;   // 문장 사이 한 박자
let captionTimer = null;

/**
 * 자막 한 줄을 띄우고 읽는다.
 *
 * 위상이 바뀌면 하던 말을 끊는다. 대기실 인사를 다 읽느라 첫 문항 소개가 뒤로 밀리면
 * 화면은 이미 문제를 보여주는데 귀에서는 아직 대기실 이야기가 나온다. 그게 어긋남의 정체였다.
 */
function showCaption(line) {
  const el = $('b-caption');
  el.textContent = line.text;
  el.dataset.tone = line.tone || '';
  clearTimeout(captionTimer);
  captionTimer = setTimeout(() => { el.textContent = ''; el.dataset.tone = ''; }, 8000);
  const turn = line.phase && line.phase !== lastSpokenPhase;
  lastSpokenPhase = line.phase || lastSpokenPhase;
  if (audioReady) Sfx.say(line.say || line.text, { force: turn });
}

/**
 * 자막을 한 줄씩 흘린다.
 *
 * 예전에는 고정 간격이었다. 그런데 한국어 한 문장은 3~4초가 걸리는데 간격이 2.8초라,
 * 다음 줄이 앞줄을 밟고 올라서면서 중계가 계속 뒤로 밀렸다. 첫 문항이 뜰 때쯤이면
 * 이미 몇 초가 밀려 있었다. 읽는 데 걸리는 시간만큼 기다린다.
 *
 * 위상이 지나간 대사는 버린다. 늦은 중계는 없느니만 못하다.
 */
function drainCaptions() {
  const line = captionQueue.shift();
  if (!line) return;
  if (line.phase && snap && snap.phase !== line.phase) {
    drainCaptions();   // 이미 지난 이야기다
    return;
  }
  showCaption(line);
  if (captionQueue.length) {
    setTimeout(drainCaptions, Sfx.estimate(line.say || line.text) + GAP_MS);
  }
}

/** 여러 줄이 한꺼번에 나오면 읽히지 않는다. 간격을 두고 하나씩 흘린다. */
function runCommentary(s) {
  const lines = commentary.update(s);
  if (!lines.length) return;
  for (const line of lines) captionQueue.push(Object.assign({ phase: s.phase }, line));
  if (captionQueue.length === lines.length) drainCaptions();
}

function renderFeed(feed) {
  const box = $('b-feed');
  if (feed.length < feedSeen) { box.innerHTML = ''; feedSeen = 0; }
  for (let i = feedSeen; i < feed.length; i += 1) {
    const f = feed[i];
    const el = document.createElement('div');
    el.className = 'feed-item' + (f.revived ? ' revived' : '') + (f.vip ? ' vip' : '');
    el.innerHTML =
      `<span class="nm">${f.name}${f.vip ? ' 👑' : ''}</span>` +
      `<span class="dp">${f.dept}</span>` +
      `<span class="q mono">${f.revived ? '부활' : `Q${f.q}`}</span>`;
    box.prepend(el);
  }
  feedSeen = feed.length;
  while (box.children.length > 14) box.lastChild.remove();
}

function showCenter(on) { $('b-center').hidden = !on; }

function render(s) {
  snap = s;
  clockOffset = s.serverNow - Date.now();

  if (s.crowd) {
    stage.setCrowd(s.crowd);
    divColors = new Map((s.crowd.divisions || []).map((d) => [d.id, d.color]));
  }
  stage.setState(s);
  renderDivStanding(s);
  runCommentary(s);

  $('b-round').textContent = s.round ? pad2(s.round) : '—';
  $('b-joined').textContent = s.joined;
  $('b-q').textContent = s.qIndex >= 0 ? `${pad2(s.qIndex + 1)} / ${pad2(s.qTotal)}` : '— / —';
  $('b-alive').textContent = s.alive;

  if (s.vip) {
    $('b-vip').hidden = false;
    $('b-vip').dataset.alive = String(s.vip.alive);
    $('b-vip-text').textContent = s.vip.alive
      ? `${s.vip.title || 'VIP'} ${s.vip.name} 생존 중`
      : `${s.vip.title || 'VIP'} ${s.vip.name} 탈락`;
  } else {
    $('b-vip').hidden = true;
  }

  renderFeed(s.feed || []);

  const phaseChanged = s.phase !== lastPhase;
  lastPhase = s.phase;

  switch (s.phase) {
    case 'idle':
      showCenter(true);
      $('b-center').classList.remove('on-rooftop');
      stage.clearChampion();
      $('b-center-label').textContent = '대기 중';
      $('b-center-big').textContent = '12:55';
      $('b-center-big').className = 'huge mono';
      $('b-center-sub').textContent = '매주 월요일 점심시간 마지막 5분';
      $('b-center-list').hidden = true;
      lastQIndex = -1;
      Music.stopCrown();
      break;

    case 'lobby':
      showCenter(true);
      $('b-center').classList.remove('on-rooftop');
      stage.clearChampion();
      $('b-center-label').textContent = '시작까지';
      $('b-center-big').className = 'huge mono';
      $('b-center-big').textContent = fmtClock(s.phaseEndsAt - now());
      $('b-center-sub').textContent = `${s.joined}명 입장`;
      $('b-center-list').hidden = true;
      endingDone = false;   // 다음 회차의 엔딩을 위해 되돌린다
      if (endingCard) endingCard.finish();
      Music.stopCrown();
      break;

    case 'question':
      showCenter(false);
      $('b-split').hidden = false;
      $('b-question').textContent = s.question ? s.question.text : '';
      $('b-drop').textContent = '';
      renderSplit(s);
      if (s.qIndex !== lastQIndex) {
        lastQIndex = s.qIndex;
        if (audioReady) Sfx.gong();
      }
      break;

    case 'reveal': {
      showCenter(false);
      const r = s.reveal;
      if (r && phaseChanged) {
        stage.applyReveal(r);
        renderSplit({ ...s, o: r.o, x: r.x, tallyVisible: true });
        if (r.eliminatedCount > 0) {
          $('b-drop').textContent = `−${r.eliminatedCount}`;
          clearTimeout(dropTimer);
          dropTimer = setTimeout(() => { $('b-drop').textContent = ''; }, 3200);
        }
        if (audioReady) {
          Sfx.correct();
          if (r.alive > 0) setTimeout(() => Sfx.rise(), 400);
        }
      }
      break;
    }

    case 'revive':
      showCenter(false);
      break;

    case 'sudden':
      showCenter(false);
      $('b-drop').textContent = 'SUDDEN DEATH';
      $('b-split').hidden = true; // 서든데스는 O/X가 아니라 숫자 입력이다
      if (phaseChanged) {
        // 뜸을 살짝 들인다. armAt에 우승곡이 흐르면서 최종 문제가 공개되고,
        // 20초 뒤 우승이 확정되는 순간이 곡의 클라이맥스와 겹친다.
        $('b-question').textContent = '';
        if (audioReady) Sfx.gong({ freq: 74, gain: 0.55 });
        clearTimeout(suddenArmTimer);
        suddenArmTimer = setTimeout(() => {
          if (!snap || snap.phase !== 'sudden') return;
          Music.crown();
          $('b-question').textContent = s.sudden ? s.sudden.text : '';
        }, Math.max(0, (s.armAt || 0) - now()));
      }
      break;

    case 'result': {
      showCenter(true);
      const r = s.result;
      $('b-center-label').textContent = r && r.champion ? '이주의 챔피언' : '전멸';
      $('b-center-big').className = 'champ-name';
      $('b-center-big').textContent = r && r.champion ? r.champion.name : '챔피언 없음';

      if (r && r.champion) {
        $('b-center-sub').textContent = `${r.champion.dept} · ${r.champion.survived}문항 생존 · 총 ${r.totalPlayers}명 참가`;
      } else {
        $('b-center-sub').textContent = '아무도 끝까지 살아남지 못했습니다.';
      }

      // 승자는 층과 무관하게 옥상으로 올라가 도시를 내려다본다.
      // 오버레이가 화면을 덮으면 그 장면이 안 보이므로 위쪽만 어둡게 한다.
      const hasChamp = !!(r && r.champion);
      $('b-center').classList.toggle('on-rooftop', hasChamp);
      if (hasChamp) stage.setChampion(r.champion.ci);
      playEnding(s);

      const list = $('b-center-list');
      list.hidden = false;
      list.innerHTML = '';
      for (const row of (r ? r.ranking : []).slice(0, 6)) {
        const el = document.createElement('div');
        el.className = 'row';
        el.innerHTML =
          `<span class="r">${pad2(row.rank)}</span>` +
          `<span>${row.name}${row.vip ? ' 👑' : ''}${row.isNew ? ' 🌱' : ''} <span class="s">${row.dept}</span></span>` +
          `<span class="s">${row.survived}문항 · ${row.points}점</span>`;
        list.appendChild(el);
      }

      if (phaseChanged && audioReady) Sfx.champ();
      break;
    }
  }

  startLoop();
}

// ─────────────────────────────────────────── 연결

function connect() {
  const es = new EventSource('/api/spectate');

  es.addEventListener('state', (e) => render(JSON.parse(e.data)));

  // 프리쇼(월 12:50~12:55) — 서버 큐에 맞춰 폰들과 같은 순간에 로고송
  es.addEventListener('jingle', () => Music.jingle());

  es.addEventListener('tally', (e) => {
    const t = JSON.parse(e.data);
    if (!snap || snap.phase !== 'question') return;
    Object.assign(snap, t);
    renderSplit(snap);
    $('b-alive').textContent = t.alive;
    $('b-joined').textContent = t.joined;
    stage.alive = t.alive;
    if (t.choices) stage.applyChoices(t.choices);
    else if (t.decided) stage.applyDecided(t.decided);
  });

  es.onerror = () => {
    es.close();
    setTimeout(connect, 500 + Math.random() * 2500);
  };
}

// ─────────────────────────────────────────── 부팅

// 전광판도 접속 1초 뒤 로고송을 시도한다. 키오스크처럼 자동재생이 허용된 환경이면
// 게이트를 누르기 전부터 개장 분위기가 잡힌다. 막히면 게이트 클릭이 받는다.
Music.autoJingle(1000);

$('audio-go').addEventListener('click', () => {
  audioReady = Sfx.unlock();
  Music.enable();
  // 접속 1회 원칙 — 준비 완료 순간에 개장 로고송을 한 차례. 이후는 서버 큐가 튼다.
  if (snap && (snap.phase === 'idle' || snap.phase === 'lobby')) Music.jingle();
  Sfx.gong({ gain: 0.35 });
  setTimeout(() => Sfx.say('전광판 준비 완료.'), 700);
  $('audio-gate').hidden = true;
});

initStage();
connect();
startLoop();
