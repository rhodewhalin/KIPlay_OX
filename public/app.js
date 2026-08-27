'use strict';

/**
 * 12:55 — 참여자 클라이언트
 *
 * 원칙
 *   · 서버가 권위를 가진다. 클라이언트는 절대 스스로 탈락을 판정하지 않고,
 *     해결된 이벤트를 렌더링만 한다.
 *   · 타이머는 매 프레임 서버 시계 기준으로 다시 계산한다. 프레임 누적을 쓰지 않으므로
 *     탭이 백그라운드에 갔다 와도 시간이 어긋나지 않는다.
 *   · 모든 소리는 런타임에 합성한다. 오디오 파일도, 네트워크 요청도 없다.
 */

const $ = (id) => document.getElementById(id);
const body = document.body;

const state = {
  token: sessionStorage.getItem('t1255') || null,
  clockOffset: 0,     // serverNow - clientNow
  snap: null,
  screen: 'login',
  answered: null,
  arming: null,       // 브리핑 중인지. 바뀔 때만 버튼 상태를 손댄다.
  lastTickSec: null,
  es: null,
  retry: 0,
};

// 소리는 sfx.js가 제공한다 (전광판과 공유). 첫 사용자 제스처에서 unlock() 해야 울린다.

// ═══════════════════════════════════════════════ 군중 무대
//
// 폰에서는 O/X 버튼이 최우선이라 군중은 상단에 작게 둔다. compact 모드로 카메라를
// 조금 더 당겨 인원이 많아도 사람이 보이게 한다. 진짜 쇼는 전광판이 담당한다.

const stages = { question: null, watch: null, sudden: null, result: null };

function initStages() {
  if (stages.question) return;
  stages.question = new CrowdStage($('crowd-canvas'), { compact: true, zones: true });

  /**
   * O·X 투명 버튼을 캔버스가 실제로 그린 상자에 맞춘다.
   *
   * 예전에는 CSS가 같은 비율(top 16.5% 따위)을 따로 적어 두었다. 도면 쪽 BOX를
   * 고칠 때마다 버튼이 소리 없이 어긋났고, PC에서 도면 가구를 오른쪽 단으로 빼면
   * 그 비율 자체가 성립하지 않는다. 좌표의 원본을 렌더러 하나로 모은다.
   */
  stages.question.onGeometry = (g) => {
    for (const [side, id] of [['O', 'btn-o'], ['X', 'btn-x']]) {
      const r = g[side];
      const el = $(id);
      el.style.left = `${r.left}px`;
      el.style.top = `${r.top}px`;
      el.style.width = `${r.width}px`;
      el.style.height = `${r.height}px`;
    }
    // 도면이 오른쪽 단에 범례를 직접 그렸으면 HTML 범례는 물러난다.
    // 판단 기준이 캔버스 비율이므로 CSS 미디어쿼리가 아니라 렌더러가 알려 준다.
    body.dataset.sideNotes = g.side ? '1' : '0';
  };
  stages.watch = new CrowdStage($('watch-canvas'), { compact: true, zones: true });

  // 서든데스도 같은 게임장이다. O·X 두 구역이 있던 자리를 숫자 입력 칸 하나가 덮는다.
  stages.sudden = new CrowdStage($('sudden-canvas'), { compact: true, zones: true });
  stages.sudden.onGeometry = (g) => {
    const el = $('sudden-form');
    el.style.left = `${g.O.left}px`;
    el.style.top = `${g.O.top}px`;
    el.style.width = `${g.X.left + g.X.width - g.O.left}px`;
    el.style.height = `${g.O.height}px`;
  };
  // 결과 화면의 옥상. O·X 발판은 필요 없다.
  stages.result = new CrowdStage($('result-canvas'), { compact: true, zones: false });
  // 옥상 배경 사진. roofimage.js에서 켜기 전까지는 절차적 옥상이 쓰인다.
  stages.result.setBackdrop(window.ROOF_BACKDROP_CONFIG);
  for (const s of Object.values(stages)) s.start();
}

const eachStage = (fn) => { for (const s of Object.values(stages)) if (s) fn(s); };

// ═══════════════════════════════════════════════ 엔딩 카드
//
// 우승 장면은 결과 화면 안에 끼워 넣지 않고 화면을 통째로 덮었다가 걷힌다.

let endingCard = null;
let endingDone = false;

function championColor(s, champ) {
  const divs = (s.crowd && s.crowd.divisions) || (stages.result && stages.result.divisions) || [];
  const byId = divs.find((d) => d.id === champ.div);
  if (byId) return byId.color;
  const st = stages.result;
  const person = st && st.people && st.people[champ.ci];
  if (person && divs[person.div]) return divs[person.div].color;
  return null;
}

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
  if (s.demo) Music.crown();   // 우승 확정 즉시. 실전은 전광판이 튼다.
  endingCard.show(Object.assign({
    name: r.champion.name,
    dept: r.champion.dept,
    survived: r.champion.survived,
    isNew: r.champion.isNew,
    totalPlayers: r.totalPlayers,
  }, buildGazette(s, r)));
}

// ═══════════════════════════════════════════════ 중계

const commentary = new Commentary();
let captionTimer = null;
const captionQueue = [];
let lastSpokenPhase = null;
const GAP_MS = 500;   // 문장 사이 한 박자

/**
 * 자막 한 줄을 띄우고 읽는다.
 *
 * 위상이 바뀌면 하던 말을 끊는다. 대기실 인사를 다 읽느라 첫 문항 소개가 뒤로 밀리면
 * 화면은 이미 문제를 보여주는데 귀에서는 아직 대기실 이야기가 나온다. 그게 어긋남의 정체였다.
 */
/**
 * 중계 자막.
 *
 * 예전에는 한 줄만 띄우고 7초 뒤 지웠다. 폰에서는 그걸로 충분했지만 PC에서는
 * 오른쪽 단이 대부분 빈 채로 남았고, 잠깐 눈을 뗀 사이의 멘트는 흔적도 없이 사라졌다.
 * 지나간 몇 줄을 흐리게 남겨 둔다 —— 방송 자막이 그렇듯 직전 맥락이 같이 보여야 한다.
 * 좁은 화면에서는 CSS가 마지막 한 줄만 보여 준다.
 */
const CAPTION_KEEP = 5;

function showCaption(line) {
  const el = $('caption');
  const row = document.createElement('p');
  row.className = 'cap-line';
  row.dataset.tone = line.tone || '';
  row.textContent = line.text;
  el.appendChild(row);
  while (el.children.length > CAPTION_KEEP) el.removeChild(el.firstChild);

  clearTimeout(captionTimer);
  captionTimer = setTimeout(() => { el.textContent = ''; }, 14000);
  const turn = line.phase && line.phase !== lastSpokenPhase;
  lastSpokenPhase = line.phase || lastSpokenPhase;
  Sfx.say(line.say || line.text, { force: turn });
}

/** 여러 줄이 한꺼번에 나오면 읽히지 않는다. 간격을 두고 하나씩 흘린다. */
function runCommentary(s) {
  const lines = commentary.update(s);
  if (!lines.length) return;
  for (const line of lines) captionQueue.push(Object.assign({ phase: s.phase }, line));
  if (captionQueue.length === lines.length) drainCaptions();
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
  if (line.phase && state.snap && state.snap.phase !== line.phase) {
    drainCaptions();   // 이미 지난 이야기다
    return;
  }
  showCaption(line);
  if (captionQueue.length) {
    setTimeout(drainCaptions, Sfx.estimate(line.say || line.text) + GAP_MS);
  }
}

/**
 * 본부 범례.
 *
 * 게임장에서 사람 몸통에 칠해지는 색이 곧 본부다. 그런데 그 대응표가 어디에도 없어서
 * "저 파란 무리가 누구냐"를 물어볼 수밖에 없었다. 도면의 「부호의 설명」과 같은 자리에
 * 색 견본을 깔아 둔다. 색은 서버 명부(data/employees.json)가 원본이다.
 *
 * 스페셜 게스트는 본부가 아니다 —— 소속 없이 참전하는 자리이므로 범례에서는 뺀다.
 * 그 사람의 표식은 색이 아니라 왕관이고, 그건 윗줄에 이미 적혀 있다.
 */
let divLegendKey = '';

function renderDivLegend(s) {
  const el = $('legend-div');
  if (!el) return;
  // divisionNames는 매 틱 온다. crowd는 회차당 한 번뿐이라 그것만 보면 두 번째 문항부터
  // 색표가 통째로 지워졌다 —— 실제로 그랬다. 없으면 지우지 말고 그대로 둔다.
  const divs = s.divisionNames || (s.crowd && s.crowd.divisions) || [];
  const shown = divs.filter((d) => d.id !== 'guest' && d.color);
  if (!shown.length) return;
  const key = shown.map((d) => `${d.id}${d.color}`).join('|');
  if (key === divLegendKey) return;   // 회차 내내 같은 표다. 매 틱 다시 그리지 않는다.
  divLegendKey = key;
  el.innerHTML = shown
    .map((d) => `<span class="lg-div"><i class="sw" style="color:${d.color}"></i>${d.short || d.name}</span>`)
    .join('');
}

/**
 * 선택 가리기 안내.
 *
 * 이 문구는 집계 바 바로 아래에 붙는다 —— 즉 집계를 보려다 못 보는 순간에만 뜻이 있다.
 * 예전에는 idle·lobby만 빼고 다 띄웠기 때문에 정답 공개, 부활권, 서든데스, 결과까지
 * 따라다녔다. 서든데스에는 O·X 집계 자체가 없고 결과 화면에는 감출 것이 없다.
 * 응답을 받는 동안에만 남긴다.
 */
function renderBlindNote(s) {
  const el = $('blind-note');
  const hidden = s.tallyVisible === false && s.phase === 'question';
  el.hidden = !hidden;
  if (hidden) el.textContent = `${s.tallyFrom || 30}명 미만부터는 다른 사람이 무엇을 골랐는지 보이지 않습니다`;
}

// ═══════════════════════════════════════════════ 유틸

const now = () => Date.now() + state.clockOffset;
const pad2 = (n) => String(n).padStart(2, '0');

function fmtClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
}

/** 문항 텍스트를 단어 단위 마스크 리빌로 세팅한다. 글자 단위로 쪼개지 않는다. */
function splitWords(el, text) {
  el.setAttribute('aria-label', text);
  el.textContent = '';
  let i = 0;
  for (const chunk of text.split(/(\s+)/)) {
    if (!chunk) continue;
    if (/^\s+$/.test(chunk)) { el.appendChild(document.createTextNode(' ')); continue; }
    const mask = document.createElement('span');
    mask.className = 'wmask';
    mask.setAttribute('aria-hidden', 'true');
    const word = document.createElement('span');
    word.className = 'word';
    word.style.setProperty('--i', i++);
    word.textContent = chunk;
    mask.appendChild(word);
    el.appendChild(mask);
  }
  el.classList.remove('is-revealed');
  void el.offsetWidth;
  el.classList.add('is-revealed');
}

function setScreen(name) {
  if (state.screen === name) return;
  state.screen = name;
  body.dataset.screen = name;
}

const DIFF_KO = { easy: '쉬움', medium: '보통', hard: '어려움' };

// ═══════════════════════════════════════════════ 타이머 루프

let rafId = null;

function startTimerLoop() {
  if (rafId) return;
  const step = () => {
    rafId = requestAnimationFrame(step);
    const s = state.snap;
    if (!s || !s.phaseEndsAt) return;

    const remain = s.phaseEndsAt - now();

    if (s.phase === 'question') {
      // 브리핑 구간에는 시계가 가득 찬 채 멈춰 있다. 중계가 문항을 소개하는 동안이다.
      const arming = s.armAt && now() < s.armAt;
      const ratio = arming ? 1 : Math.max(0, Math.min(1, remain / (s.questionMs || 10000)));
      $('q-timer-fill').style.transform = `scaleX(${ratio})`;
      $('q-timer').classList.toggle('urgent', !arming && remain <= 3000);
      $('q-timer').classList.toggle('arming', !!arming);

      // 브리핑이 끝나는 순간 버튼이 열린다
      if (state.arming !== !!arming) {
        state.arming = !!arming;
        applyArmed(s);
      }

      const sec = Math.ceil(remain / 1000);
      if (!arming && remain > 0 && remain <= 3000 && sec !== state.lastTickSec) {
        state.lastTickSec = sec;
        Sfx.tick();
      }
    } else if (s.phase === 'sudden') {
      const ratio = Math.max(0, Math.min(1, remain / (s.suddenMs || 20000)));
      $('sd-timer-fill').style.transform = `scaleX(${ratio})`;
      $('sd-timer').classList.toggle('urgent', remain <= 4000);
    } else if (s.phase === 'lobby') {
      $('lobby-countdown').textContent = fmtClock(remain);
    }
  };
  rafId = requestAnimationFrame(step);
}

function stopTimerLoop() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { stopTimerLoop(); Music.stopAll(); }
  else startTimerLoop();
});

// ═══════════════════════════════════════════════ 렌더

let lastQIndex = -1;
let lastPhase = null;

function render(s) {
  state.snap = s;
  state.clockOffset = s.serverNow - Date.now();
  const me = s.me;
  if (!me) return;

  initStages();
  if (s.crowd) eachStage((st) => st.setCrowd(s.crowd));
  eachStage((st) => { st.setState(s); st.setMyName(me.name); if (me.ci !== null) st.setMyIndex(me.ci); });

  // ── 개인 카드
  $('me-name').textContent = me.name;
  $('me-dept').textContent = me.dept;
  $('me-badges').innerHTML = '';
  if (me.isNew) $('me-badges').insertAdjacentHTML('beforeend', '<span class="badge badge-new">새싹</span>');
  if (me.isVip) $('me-badges').insertAdjacentHTML('beforeend', '<span class="badge badge-vip">👑 스페셜 게스트</span>');

  $('lobby-joined').textContent = s.joined;
  $('lobby-questions').textContent = s.qTotal || 10;
  $('lobby-revives').textContent = me.revives;

  body.dataset.demo = s.demo ? '1' : '0';
  $('lobby-demo').hidden = s.phase !== 'idle';   // 진행 중에는 새 체험을 열지 않는다
  $('rs-replay').hidden = !s.demo;

  renderBlindNote(s);
  renderDivLegend(s);
  runCommentary(s);

  const phaseChanged = s.phase !== lastPhase;
  lastPhase = s.phase;
  applyArmed(s);

  renderNextGame(s);

  switch (s.phase) {
    case 'idle':
      setScreen('lobby');
      $('lobby-countdown').textContent = '--:--';
      break;

    case 'lobby':
      setScreen('lobby');
      if (s.demo) Music.stopCrown();
      $('lobby-countdown').textContent = fmtClock(s.phaseEndsAt - now());
      lastQIndex = -1;
      endingDone = false;   // 다음 회차의 엔딩을 위해 되돌린다
      if (endingCard) endingCard.finish();
      eachStage((st) => st.clearChampion());
      break;

    case 'question': {
      renderTally(s);
      $('q-index').textContent = pad2(s.qIndex + 1);
      $('q-total').textContent = pad2(s.qTotal);
      $('q-alive').textContent = s.alive;
      $('w-index').textContent = pad2(s.qIndex + 1);
      $('w-total').textContent = pad2(s.qTotal);
      $('w-alive').textContent = s.alive;
      $('w-survived').textContent = me.survived;

      if (s.question && s.qIndex !== lastQIndex) {
        lastQIndex = s.qIndex;
        state.answered = null;
        state.lastTickSec = null;
        splitWords($('q-text'), s.question.text);
        // 관전자도 같은 문제를 본다. 탈락했다고 문제가 안 보이면 구경할 이유가 없다.
        splitWords($('w-text'), s.question.text);
        const d = s.question.difficulty || 'easy';
        $('q-diff').dataset.d = d;
        $('q-diff-text').textContent = DIFF_KO[d] || d;
        resetChoices();
        setSendState('', '');
        state.arming = null;   // 새 문항이면 다시 판정한다
        applyArmed(s);
      }
      setScreen(me.alive ? 'question' : 'watch');
      break;
    }

    case 'reveal': {
      const r = s.reveal;
      if (r && phaseChanged) {
        eachStage((st) => st.applyReveal(r));
        $('rv-answer').textContent = r.answer;
        $('rv-answer').className = 'verdict-glyph mono ' + (r.answer === 'O' ? 'verdict-ok' : 'verdict-no');
        $('rv-evidence').textContent = r.evidence || '';
        $('rv-source').textContent = r.source && r.source.title ? `근거 · ${r.source.title}` : '';
        $('rv-cull').textContent = r.revivedCount
          ? `${r.eliminatedCount}명 탈락 · ${r.alive}명 생존 · 부활권 ${r.revivedCount}명`
          : `${r.eliminatedCount}명 탈락 · ${r.alive}명 생존`;

        // 부활권은 이제 서버가 자동으로 쓴다. 물어보지 않으므로 결과만 알린다.
        if (me.revived) {
          $('rv-line').innerHTML =
            '오답입니다.<br><b>부활권이 자동으로 사용되어 살아남았습니다.</b>';
          $('rv-line').className = 'verdict-line verdict-ok';
          Sfx.rise();
        } else if (me.correct === true) {
          $('rv-line').textContent = '정답입니다. 살아남았어요.';
          $('rv-line').className = 'verdict-line verdict-ok';
          Sfx.correct();
        } else if (me.correct === false) {
          $('rv-line').textContent = '오답입니다.';
          $('rv-line').className = 'verdict-line verdict-no';
          Sfx.dead();
        } else {
          $('rv-line').textContent = '관전 중입니다.';
          $('rv-line').className = 'verdict-line';
        }
        markChoiceResult(r.answer);
      }
      setScreen('reveal');
      break;
    }

    case 'sudden': {
      $('sd-alive').textContent = s.alive;
      if (s.sudden && phaseChanged) {
        // 뜸을 살짝 들인다. armAt에 우승곡이 흐르면서 최종 문제가 공개되고,
        // 20초 뒤 우승이 확정되는 순간이 곡의 클라이맥스와 겹친다.
        $('sd-text').textContent = '';
        $('sd-note').textContent = '최종 문제를 준비하고 있습니다…';
        $('sd-value').value = '';
        $('sd-submit').disabled = true;
        $('w-text').textContent = '';
        clearTimeout(suddenArmTimer);
        suddenArmTimer = setTimeout(() => {
          if (!state.snap || state.snap.phase !== 'sudden') return;   // 이미 지나간 회차다
          if (s.demo) Music.crown();   // 우승곡과 함께 출제. 실전은 전광판이 튼다.
          splitWords($('sd-text'), s.sudden.text);
          splitWords($('w-text'), s.sudden.text);
          $('sd-note').textContent = s.sudden.unit
            ? `단위: ${s.sudden.unit} · 동점이면 더 빨리 낸 사람이 이깁니다.`
            : '동점이면 더 빨리 낸 사람이 이깁니다.';
          $('sd-submit').disabled = false;
          Sfx.warn();
        }, Math.max(0, (s.armAt || 0) - now()));
      }
      setScreen(me.inSudden ? 'sudden' : 'watch');
      break;
    }

    case 'result': {
      if (phaseChanged) renderResult(s, me);
      // 챔피언은 몇 층에서 이겼든 마지막은 옥상이다.
      // 결과 단계 내내 걸어둔다 — 중간에 새로고침하거나 늦게 붙은 사람도 그 장면을 봐야 한다.
      const champ = s.result && s.result.champion;
      if (champ && champ.ci !== null && champ.ci !== undefined) stages.result.setChampion(champ.ci);
      else stages.result.clearChampion();
      setScreen('result');
      playEnding(s);
      break;
    }
  }

  // 관전 화면 공통값
  $('w-alive').textContent = s.alive;
  $('w-survived').textContent = me.survived;
  startTimerLoop();
}

function renderTally(s) {
  // 생존자가 100명 밑으로 떨어지면 서버가 집계를 보내지 않는다.
  // 초반엔 군중을 보고 눈치를 보지만 후반은 혼자 판단해야 한다.
  const hidden = s.tallyVisible === false || s.o === null || s.o === undefined;
  const o = hidden ? 1 : s.o;
  const x = hidden ? 1 : s.x;
  const total = Math.max(1, o + x);

  for (const id of ['bar-o', 'w-bar-o']) $(id).style.flexGrow = String(o / total);
  for (const id of ['bar-x', 'w-bar-x']) $(id).style.flexGrow = String(x / total);
  for (const id of ['num-o', 'w-num-o']) $(id).textContent = hidden ? '?' : o;
  for (const id of ['num-x', 'w-num-x']) $(id).textContent = hidden ? '?' : x;
}

/**
 * 브리핑 중에는 O·X를 누를 수 없다.
 *
 * 서버도 armAt 전에는 접수하지 않으므로 여기서 막는 건 화면을 서버와 맞추는 일이다.
 * 막아두지 않으면 눌러도 409만 돌아와서 먹통처럼 보인다.
 */
let armTimer = null;
let suddenArmTimer = null;

function applyArmed(s) {
  const arming = !!(s && s.phase === 'question' && s.armAt && now() < s.armAt);
  state.arming = arming;
  const hint = $('q-arm-note');
  if (hint) hint.hidden = !arming;

  if (!state.answered) {
    for (const b of [$('btn-o'), $('btn-x')]) {
      b.disabled = arming;
      b.classList.toggle('arming', arming);
    }
  }

  // 여는 시각을 시계로 예약한다.
  //
  // 문항이 진행되는 동안 서버는 집계만 보내고 전체 상태를 다시 보내지 않는다. 그래서
  // render()가 다시 불리지 않고, rAF 루프에만 맡기면 탭이 배경에 있는 사이 브리핑이
  // 끝나도 버튼이 잠긴 채로 남는다. 실제로 그렇게 잠겨 있었다.
  clearTimeout(armTimer);
  armTimer = null;
  if (arming) armTimer = setTimeout(() => applyArmed(state.snap), Math.max(0, s.armAt - now()) + 30);
}

function resetChoices() {
  for (const b of [$('btn-o'), $('btn-x')]) {
    b.setAttribute('aria-pressed', 'false');
    b.classList.remove('burst', 'correct', 'wrong');
    b.disabled = false;
  }
}

function markChoiceResult(answer) {
  const ok = answer === 'O' ? $('btn-o') : $('btn-x');
  const no = answer === 'O' ? $('btn-x') : $('btn-o');
  ok.classList.add('correct');
  no.classList.add('wrong');
}


/**
 * 문항 복기.
 *
 * 회차가 끝난 뒤 무엇이 나왔고 답이 무엇이며 왜 그런지 돌아볼 수 있어야 한다.
 * 점심 대화는 여기서 나온다 —— "그거 답이 X였어?"
 */
function renderReview(r) {
  const box = $('rs-review');
  if (!box) return;
  box.innerHTML = '';
  for (const q of r.review || []) {
    const el = document.createElement('details');
    el.className = 'review-item';
    el.innerHTML =
      `<summary><span class="rv-n mono">문 ${q.n}</span>` +
      `<span class="rv-a ${q.answer === 'O' ? 'rv-o' : 'rv-x'}">${q.answer}</span>` +
      `<span class="rv-t">${q.text}</span></summary>` +
      `<div class="rv-body"><p>${q.evidence || '—'}</p>` +
      (q.source ? `<span class="src mono">근거 · ${q.source}</span>` : '') +
      `</div>`;
    box.appendChild(el);
  }
  if (r.suddenAnswer && r.suddenAnswer.text) {
    const sd = r.suddenAnswer;
    const el = document.createElement('details');
    el.className = 'review-item';
    el.innerHTML =
      `<summary><span class="rv-n mono">서든</span>` +
      `<span class="rv-a rv-o">${sd.value}${sd.unit || ''}</span>` +
      `<span class="rv-t">${sd.text}</span></summary>` +
      `<div class="rv-body"><p>${sd.evidence || '—'}</p></div>`;
    box.appendChild(el);
  }
}

function renderResult(s, me) {
  const r = s.result;
  if (!r) return;

  renderReview(r);

  if (r.champion) {
    $('rs-crown').textContent = '👑';
    $('rs-label').textContent = '이주의 챔피언';
    $('rs-name').textContent = r.champion.name;
    $('rs-dept').textContent = `${r.champion.dept}${r.champion.isNew ? ' · 새싹' : ''} · ${r.champion.survived}문항 생존`;
    Sfx.champ();
  } else {
    $('rs-crown').textContent = '—';
    $('rs-label').textContent = '전멸';
    $('rs-name').textContent = '챔피언 없음';
    $('rs-dept').textContent = '아무도 끝까지 살아남지 못했습니다.';
  }

  if (r.suddenAnswer) {
    $('rs-sudden-answer').hidden = false;
    $('rs-sudden-text').textContent =
      `서든데스 정답은 ${r.suddenAnswer.value}${r.suddenAnswer.unit || ''}입니다. ${r.suddenAnswer.evidence || ''}`;
    $('rs-sudden-src').textContent = r.sudden && r.sudden.length
      ? r.sudden.map((e) => `${e.name} ${e.value} (오차 ${e.diff})`).join('  ·  ')
      : '';
  } else {
    $('rs-sudden-answer').hidden = true;
  }

  if (r.vip) {
    $('rs-vip').hidden = false;
    // 격파 이벤트는 걷어냈다. 어디까지 갔는지만 적는다 —— 순위표에서는 소속 없이 왕관만 붙는다.
    $('rs-vip-text').textContent =
      `${r.vip.title || '스페셜 게스트'} ${r.vip.name}님은 ${r.vip.survived}문항을 생존했습니다.`;
  } else {
    $('rs-vip').hidden = true;
  }

  const list = $('rs-ranking');
  list.innerHTML = '';
  for (const row of r.ranking) {
    const el = document.createElement('div');
    el.className = 'rank-row' + (row.name === me.name && row.dept === me.dept ? ' me' : '');
    el.innerHTML =
      `<span class="r">${pad2(row.rank)}</span>` +
      `<span>${row.name}${row.vip ? ' 👑' : ''}${row.isNew ? ' 🌱' : ''}` +
      `<span class="s" style="margin-left:8px">${row.dept}</span></span>` +
      `<span class="s">${row.survived}문항 · ${row.points}점</span>`;
    list.appendChild(el);
  }
}

// ═══════════════════════════════════════════════ 통신

/** 세션이 죽었으면 토큰을 버리고 로그인으로 돌려보낸다. */
function dropSession(reason) {
  if (state.es) { state.es.close(); state.es = null; }
  state.token = null;
  sessionStorage.removeItem('t1255');
  $('login-error').textContent = reason || '세션이 만료되었습니다. 다시 입장해 주세요.';
  setScreen('login');
}

async function post(path, payload) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  // 서버 재시작 등으로 토큰이 무효가 되면 조용히 실패하지 않고 즉시 알린다
  if (res.status === 401 && path !== '/api/login') {
    dropSession('서버가 다시 시작되었습니다. 사번을 다시 입력해 주세요.');
  }
  return { ok: res.ok, data };
}

function connect() {
  if (state.es) state.es.close();
  const es = new EventSource(`/api/stream?token=${encodeURIComponent(state.token)}`);
  state.es = es;

  es.addEventListener('state', (e) => { state.retry = 0; render(JSON.parse(e.data)); });

  es.addEventListener('tally', (e) => {
    const t = JSON.parse(e.data);
    if (!state.snap) return;
    Object.assign(state.snap, t);
    renderTally(state.snap);
    $('q-alive').textContent = t.alive;
    $('w-alive').textContent = t.alive;
    eachStage((st) => {
      st.alive = t.alive;
      if (t.choices) st.applyChoices(t.choices);
      else if (t.decided) st.applyDecided(t.decided);
    });
  });


  // 프리쇼(월 12:50~12:55) — 서버 큐에 맞춰 전원이 같은 순간에 로고송을 튼다
  es.addEventListener('jingle', () => Music.jingle());

  es.addEventListener('kicked', (e) => {
    es.close();
    state.es = null;
    sessionStorage.removeItem('t1255');
    $('login-error').textContent = JSON.parse(e.data).reason || '연결이 종료되었습니다.';
    setScreen('login');
  });

  // 재접속은 0~3초 무작위 지연을 둔다. 450명이 동시에 몰리는 것을 막기 위함이다.
  es.onerror = () => {
    es.close();
    state.es = null;
    const delay = 500 + Math.random() * 2500;
    state.retry += 1;
    if (state.retry < 40) setTimeout(connect, delay);
  };
}

// ═══════════════════════════════════════════════ 입력

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  Sfx.unlock();                       // 오디오는 첫 사용자 제스처에서 해제한다
  Music.enable();
  $('login-error').textContent = '';
  $('join-btn').disabled = true;

  const { ok, data } = await post('/api/login', { empId: $('empId').value.trim() });
  $('join-btn').disabled = false;

  if (!ok) { $('login-error').textContent = data.error || '입장할 수 없습니다.'; return; }

  state.token = data.token;
  sessionStorage.setItem('t1255', data.token);
  Sfx.select();
  greet(data.user.name);
  connect();
});

/**
 * 입장 인사. 사번을 넣고 들어온 사람에게 한마디 건넨다.
 *
 * 열 가지를 돌리는 이유는 매주 오는 게임이라서다. 매번 같은 인사면 3주차부터
 * 아무도 읽지 않는다. 자막으로 띄우고 같은 문장을 읽어준다.
 */
const GREETINGS = [
  (n) => `안녕하세요, ${n}님! 맛점 하셨나요? 화이팅!!`,
  (n) => `${n}님, 어서 오세요. 오늘의 챔피언 자리가 비어 있습니다.`,
  (n) => `${n}님 입장! 점심시간 마지막 5분, 준비되셨죠?`,
  (n) => `반갑습니다 ${n}님. 오늘은 왠지 느낌이 좋은데요?`,
  (n) => `${n}님, 커피 한 잔 들고 오셨나요? 곧 시작합니다.`,
  (n) => `어서 오세요 ${n}님! 지난주의 아쉬움, 오늘 갚아주세요.`,
  (n) => `${n}님 등장! 다들 긴장하세요.`,
  (n) => `${n}님, 딱 다섯 문제입니다. 끝까지 살아남아 보세요.`,
  (n) => `환영합니다 ${n}님. 소문난 실력, 오늘 보여주시죠.`,
  (n) => `${n}님! 12시 55분의 주인공이 되실 준비 되셨나요?`,
];

/**
 * 다음 정기 회차 안내. 대기 화면에 "다음 게임은 8월 31일 (월) 12:55에 시작됩니다"를 띄운다.
 * 서버가 준 nextGameAt(KST 매주 월 12:55)을 그대로 렌더링만 한다. 체험 중에는 숨긴다.
 */
function renderNextGame(s) {
  const el = $('next-game');
  if (!el) return;
  const show = !s.demo && (s.phase === 'idle' || s.phase === 'lobby') && s.nextGameAt;
  if (!show) { el.hidden = true; return; }
  const d = new Date(s.nextGameAt);
  const date = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', weekday: 'short',
  }).format(d);
  const time = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
  el.textContent = `다음 게임은 ${date} ${time}에 시작됩니다. 늦지 않게 입장해 주세요.`;
  el.hidden = false;
}

function greet(name) {
  const line = GREETINGS[Math.floor(Math.random() * GREETINGS.length)](name);
  const el = $('lobby-greet');
  if (el) el.textContent = line;
  Sfx.say(line);
}

function setSendState(s, text) {
  const el = $('send-state');
  el.dataset.s = s;
  el.textContent = text;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 답안을 확실히 도달시킨다.
 *
 * 네트워크 순간 장애로 답안이 유실되면 그 사람은 틀려서가 아니라 회선 때문에 탈락한다.
 * 이 게임에서 가장 나쁜 버그이므로, 응답 창이 열려 있는 동안 재시도한다.
 * 사용자가 답을 바꾸거나 문항이 넘어가면 즉시 중단한다.
 */
async function submitAnswer(qIndex, answer) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const s = state.snap;
    if (!s || s.qIndex !== qIndex || state.answered !== answer) return; // 낡은 시도
    if (s.phase !== 'question' || now() > s.phaseEndsAt) {
      setSendState('fail', '시간 초과 — 전송되지 않았습니다');
      return;
    }

    const rt = Math.max(0, (s.questionMs || 10000) - (s.phaseEndsAt - now()));
    try {
      const { ok, data } = await post('/api/answer', { token: state.token, qIndex, answer, rt });
      if (ok) { setSendState('ok', `${answer} 전송됨`); return; }
      // 서버가 명시적으로 거절한 경우는 재시도해도 결과가 같다
      if (data && /stale|not accepting|eliminated|invalid/.test(data.error || '')) {
        setSendState('fail', '접수되지 않았습니다');
        return;
      }
    } catch (_) { /* 네트워크 오류 — 재시도한다 */ }

    setSendState('pending', '전송 중…');
    await sleep(120 * (attempt + 1) + Math.random() * 80);
  }
  setSendState('fail', '전송 실패 — 다시 눌러주세요');
}

function choose(answer, btn) {
  const s = state.snap;
  if (!s || s.phase !== 'question' || !s.me.alive) return;

  state.answered = answer;
  $('btn-o').setAttribute('aria-pressed', String(answer === 'O'));
  $('btn-x').setAttribute('aria-pressed', String(answer === 'X'));

  btn.classList.remove('burst');
  void btn.offsetWidth;
  btn.classList.add('burst');
  Sfx.select();

  setSendState('pending', '전송 중…');
  submitAnswer(s.qIndex, answer);
}

$('btn-o').addEventListener('click', (e) => choose('O', e.currentTarget));
$('btn-x').addEventListener('click', (e) => choose('X', e.currentTarget));

$('sudden-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const s = state.snap;
  const v = Number($('sd-value').value);
  if (!Number.isFinite(v)) return;
  $('sd-submit').disabled = true;
  $('sd-submit').textContent = '제출됨';
  Sfx.select();
  const rt = Math.max(0, (s.suddenMs || 20000) - (s.phaseEndsAt - now()));
  post('/api/sudden', { token: state.token, value: v, rt });
});

$('rs-again').addEventListener('click', () => setScreen('lobby'));

// ═══════════════════════════════════════════════ 체험 모드

const demoOpts = { role: 'new', bots: 80 };

/** 역할별 시연용 사번 (5자리). 명부에 등록된 사번을 그대로 쓴다. */
function demoEmpId(role) {
  if (role === 'vip') return '95001';     // 스페셜 게스트
  if (role === 'normal') return '15029';  // 임특허 · 11년차
  return '26005';                         // 조새싹 · 0년차 · 부활권 대상
}

function bindChips(attr, key) {
  for (const chip of document.querySelectorAll(`[data-${attr}]`)) {
    chip.addEventListener('click', () => {
      for (const sib of chip.parentElement.children) sib.setAttribute('aria-pressed', 'false');
      chip.setAttribute('aria-pressed', 'true');
      const raw = chip.dataset[attr];
      demoOpts[key] = attr === 'role' ? raw : Number(raw);
    });
  }
}

bindChips('role', 'role');
bindChips('bots', 'bots');
bindChips('lobby', 'lobby');

/**
 * 게임 설명 — 등록특허공보 양식의 이용안내를 창으로 띄운다.
 *
 * 경로를 상대로 둔다. 절대 주소(localhost:12055)로 박아두면 사내망이나 배포 환경에서 깨진다.
 * 팝업 차단은 흔한 일이므로 막히면 같은 창에서 새 탭으로 연다.
 */
function openSpec() {
  // 화면 크기를 못 읽는 환경이 있다. 그때 음수 좌표가 나오면 창이 화면 밖에서 열린다.
  const sw = window.screen && window.screen.availWidth ? window.screen.availWidth : 1280;
  const sh = window.screen && window.screen.availHeight ? window.screen.availHeight : 900;
  // 명세서는 창에 맞춰 배율이 잡히므로, 창을 1.5배 키우는 것이 곧 지면을 150%로 보는 것이다.
  // 화면보다 커질 수는 없으니 화면 크기에서 잘린다.
  const w = Math.min(sw - 16, Math.max(360, Math.round(sw * 0.62 * 1.5)), 1460);
  const h = Math.min(sh - 16, Math.max(480, Math.round(sh * 0.88 * 1.5)), 1560);
  const left = Math.max(0, Math.round((sw - w) / 2));
  const top = Math.max(0, Math.round((sh - h) / 2));
  const win = window.open(
    'spec.html', 'kipi1255spec',
    `width=${w},height=${h},left=${left},top=${top},resizable=yes,scrollbars=yes`,
  );
  if (win) win.focus();
  else window.open('spec.html', '_blank', 'noopener');   // 팝업이 막힌 경우
}

$('spec-open').addEventListener('click', openSpec);

$('demo-open').addEventListener('click', () => {
  Sfx.unlock();
  Music.enable();
  $('opt-role').hidden = !!state.token; // 이미 입장했다면 지금 신분을 그대로 쓴다
  $('demo-error').textContent = '';
  setScreen('demo');
});

$('demo-back').addEventListener('click', () => setScreen(state.token ? 'lobby' : 'login'));

$('lobby-demo').addEventListener('click', () => {
  Sfx.unlock();
  Music.enable();
  $('opt-role').hidden = true;
  $('demo-error').textContent = '';
  setScreen('demo');
});

async function startDemo() {
  $('demo-start').disabled = true;
  $('demo-error').textContent = '';

  // 체험 대기실 = 로고송의 남은 시간. 곡이 끝나는 순간 1번 문항이 나간다.
  // 옵션 화면부터 흐르던 곡이면 그대로 타고, 이미 끝났으면 처음부터 다시 튼다.
  // 재생 자체가 막히면(자동재생 차단 등) 침묵 19초를 세우지 말고 3초로 바로 간다.
  let lobbySec = Music.jingleRemaining();
  if (lobbySec == null) lobbySec = await Music.jingleStart();
  if (lobbySec == null) lobbySec = 3;
  lobbySec = Math.max(2, Math.ceil(lobbySec));

  try {
    // 아직 입장하지 않았다면 고른 역할로 먼저 입장한다
    if (!state.token) {
      const { ok, data } = await post('/api/login', { empId: demoEmpId(demoOpts.role) });
      if (!ok) throw new Error(data.error || '입장에 실패했습니다.');
      state.token = data.token;
      sessionStorage.setItem('t1255', data.token);
      connect();
      await sleep(250); // 스트림이 열릴 때까지 잠깐 기다린다
    }

    const { ok, data } = await post('/api/demo/start', {
      token: state.token, bots: demoOpts.bots, lobbySec,
    });
    if (!ok) throw new Error(data.error || '시작할 수 없습니다.');
    Sfx.select();
  } catch (err) {
    $('demo-error').textContent = err.message;
  } finally {
    $('demo-start').disabled = false;
  }
}

$('demo-start').addEventListener('click', startDemo);
$('rs-replay').addEventListener('click', startDemo);

$('narration-toggle').addEventListener('click', (e) => {
  Sfx.narrationOn = !Sfx.narrationOn;
  if (!Sfx.narrationOn) Sfx.silence();
  else Sfx.say('나레이션을 켰습니다.');
  e.currentTarget.setAttribute('aria-pressed', String(Sfx.narrationOn));
  e.currentTarget.textContent = Sfx.narrationOn ? '나레이션 켜짐' : '나레이션 꺼짐';
});

// 키보드 지원 (데스크톱 관전자·운영자 테스트용)
document.addEventListener('keydown', (e) => {
  if (state.screen !== 'question') return;
  if (e.key === 'o' || e.key === 'O' || e.key === 'ArrowLeft') $('btn-o').click();
  if (e.key === 'x' || e.key === 'X' || e.key === 'ArrowRight') $('btn-x').click();
});

// ═══════════════════════════════════════════════ 부팅

const fixtureName = new URLSearchParams(location.search).get('screen');

// 링크를 열면 1초 뒤 개장 로고송을 시도한다. 픽스처 화면은 개발용이라 조용히 둔다.
if (!fixtureName) Music.autoJingle(1000);

// 저장된 토큰이 아직 살아 있는지 먼저 확인한다.
// 죽은 토큰으로 스트림을 열면 계속 재접속만 시도하며 화면이 멈춘 것처럼 보인다.
// 픽스처로 화면만 보는 중이면 건드리지 않는다.
(async () => {
  if (!state.token || fixtureName) return;
  const { ok } = await post('/api/session', { token: state.token });
  if (ok) connect();
})();

startTimerLoop();

// ── 화면별 픽스처. 서버 없이 각 화면을 바로 확인할 수 있다.
//    예) /?screen=reveal   /?screen=suddendeath   /?screen=champion
const fixture = fixtureName;
if (fixture) {
  const demo = {
    phase: 'idle', serverNow: Date.now(), phaseEndsAt: 0, joined: 312, alive: 37,
    qIndex: 2, qTotal: 10, o: 214, x: 98, feed: [], result: null,
    question: { text: 'PCT 국제출원을 하면 지정한 모든 국가에 자동으로 특허가 등록된다.', difficulty: 'hard' },
    sudden: { text: '발명왕 에디슨이 생전에 취득한 미국 특허는 모두 몇 건일까?', unit: '건' },
    reveal: { answer: 'X', evidence: 'PCT는 국제출원 절차일 뿐이며, 각 지정국의 국내단계 진입과 개별 심사가 필요하다.',
              source: { title: '특허협력조약(PCT) 제도 안내' }, o: 214, x: 98, eliminatedCount: 214, alive: 37 },
    me: { name: '조새싹', dept: '정보서비스실', years: 0, isNew: true, isVip: false,
          alive: true, revives: 1, survived: 2, correct: false, revived: true, inSudden: true, points: 25 },
  };
  const map = {
    lobby: 'lobby', question: 'question', reveal: 'reveal',
    eliminated: 'question', suddendeath: 'sudden', champion: 'result',
  };
  demo.phase = { lobby: 'lobby', question: 'question', reveal: 'reveal',
                 eliminated: 'question', suddendeath: 'sudden', champion: 'result' }[fixture] || 'lobby';
  if (fixture === 'eliminated') demo.me.alive = false;

  // 게임장이 나오는 픽스처에는 군중을 실어 준다. 이게 없으면 캔버스가 텅 비어
  // 인물 기호도, 본부 범례도, 도면부호 지시선도 확인할 수 없다.
  if (['question', 'eliminated', 'reveal', 'suddendeath'].includes(fixture)) {
    const N = 37;
    demo.crowd = {
      round: 1, n: N,
      divisions: [
        { id: 'mgmt', short: '경영', color: '#1F5FA8' }, { id: 'util', short: '활용', color: '#0E8F72' },
        { id: 'sys', short: '시스템', color: '#6B3FA0' }, { id: 'ai', short: '지능', color: '#A8730A' },
        { id: 'plat', short: '분석', color: '#A81E7A' }, { id: 'etc', short: '감사', color: '#4C5A63' },
        { id: 'guest', short: '게스트', color: '#141414' },
      ],
      div: Array.from({ length: N }, (_, i) => i % 6).join(''),
      flags: Array.from({ length: N }, (_, i) => (i === 3 ? 'v' : i % 7 === 0 ? 'n' : '.')).join(''),
    };
    demo.alive = N;
    demo.aliveMask = '1'.repeat(N);
    demo.me.ci = 11;
  }
  if (fixture === 'champion') {
    demo.crowd = {
      round: 1, n: 12,
      divisions: [
        { id: 'mgmt', short: '경영', color: '#1F5FA8' }, { id: 'util', short: '활용', color: '#0E8F72' },
        { id: 'sys', short: '시스템', color: '#6B3FA0' }, { id: 'ai', short: '지능', color: '#A8730A' },
        { id: 'plat', short: '분석', color: '#A81E7A' }, { id: 'etc', short: '감사', color: '#4C5A63' },
        { id: 'guest', short: '게스트', color: '#141414' },
      ],
      div: '012345012345', flags: 'v...n....n..',
    };
    demo.result = {
      scene: 'rooftop',
      champion: { name: '조새싹', dept: '정보서비스실', div: 'sys', ci: 4, isNew: true, survived: 5 },
      ranking: [
        { rank: 1, name: '조새싹', dept: '정보서비스실', survived: 5, points: 105, isNew: true, vip: false },
        { rank: 2, name: '김원장', dept: '스페셜 게스트', survived: 4, points: 45, isNew: false, vip: true },
        { rank: 3, name: '한분석', dept: '데이터실', survived: 4, points: 45, isNew: false, vip: false },
      ],
      sudden: [{ name: '조새싹', value: 1100, diff: 7, rt: 4210 }],
      suddenAnswer: { text: '발명왕 에디슨이 생전에 취득한 미국 특허는 모두 몇 건일까?', value: 1093, unit: '건', evidence: '토머스 에디슨은 미국에서 1,093건의 특허를 취득했다.' },
      review: [
        { n: 1, text: '특허권의 존속기간은 출원일부터 20년이다.', answer: 'O', difficulty: 'easy', evidence: '특허법 제88조. 존속기간은 설정등록일부터 출원일 후 20년까지다.', source: '특허법 제88조' },
        { n: 2, text: '코카콜라의 제조법은 특허로 등록되어 있다.', answer: 'X', difficulty: 'medium', evidence: '영업비밀로 관리한다. 특허로 공개하면 20년 뒤 누구나 쓸 수 있다.', source: '영업비밀 제도 안내' },
      ],
      vip: { name: '김원장', title: '스페셜 게스트', survived: 4 },
      totalPlayers: 312,
    };
  }
  demo.phaseEndsAt = Date.now() + (demo.phase === 'sudden' ? 15000 : 7000);
  lastPhase = null;
  render(demo);

  // 선택 방향은 상태가 아니라 별도의 tally 이벤트로 온다. 픽스처에는 그 통로가 없으므로
  // 직접 먹인다 —— 사람들이 두 구역으로 흩어져야 게임장이 게임장처럼 보인다.
  // 서든데스는 O·X로 갈리지 않는다 —— 전원이 출발선에 남아 숫자를 적는다.
  if (demo.crowd && fixture !== 'suddendeath') {
    const mask = Array.from({ length: demo.crowd.n }, (_, i) => (i % 3 ? 'O' : 'X')).join('');
    eachStage((st) => st.applyChoices(mask));
  }
  void map;
}
