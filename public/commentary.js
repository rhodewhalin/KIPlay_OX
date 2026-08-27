'use strict';

/**
 * 12:55 — 중계
 *
 * 상태 변화를 읽어 이번에 할 말을 만든다. 화면에 자막으로 띄우고 동시에 읽는다.
 * 소리가 안 나오는 환경에서도 진행이 끊기지 않아야 하므로 텍스트가 먼저고 음성이 나중이다.
 *
 * 급하게 몰아붙이지 않는 것이 목적이다. 숫자만 읽어주는 게 아니라
 * 룰이 바뀌는 지점, 본부별 판세, 결승 진입 같은 "지금 무슨 상황인지"를 말해준다.
 */

(function (global) {
  const DIFF_KO = { easy: '쉬움', medium: '보통', hard: '어려움' };
  const SPOKEN = { O: '오', X: '엑스' };

  /**
   * 서수. "2번 문항"이라고 쓰면 TTS가 "이번 문항"으로 읽는다 —— '이번(this)'과
   * 구분이 안 되는 진짜 오독이다. "두 번째 문항"으로 읽게 한다.
   */
  const ORDINAL = ['첫', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉', '열'];
  const ordinal = (i) => (ORDINAL[i] ? `${ORDINAL[i]} 번째` : `${i + 1}번째`);

  /** 본부별 생존자를 많은 순으로 정리한다. */
  function divisionRank(s) {
    const counts = s.divAlive || {};
    const names = new Map((s.divisionNames || []).map((d) => [d.id, d]));
    return Object.entries(counts)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([id, n]) => ({ id, n, name: (names.get(id) || {}).name || id, short: (names.get(id) || {}).short || id }));
  }

  class Commentary {
    constructor() { this.reset(0); }

    reset(round) {
      this.round = round;
      this.lastPhase = null;
      this.lastQIndex = -1;
      this.saidThreshold = false;
      this.sawTally = false;
      this.saidFinal = false;
      this.saidVipOut = false;
      this.lastFloor = 1;
    }

    /**
     * 이번 상태에서 새로 할 말을 배열로 돌려준다.
     * 각 항목은 { text, say, tone } — text는 자막, say는 읽을 문장(없으면 text를 읽는다).
     */
    update(s) {
      if (!s) return [];
      if (s.round !== this.round) this.reset(s.round);

      const out = [];
      const phaseChanged = s.phase !== this.lastPhase;
      const alive = s.alive || 0;
      const threshold = s.tallyFrom || 30;

      if (phaseChanged && s.phase === 'lobby') {
        out.push({ text: `잠시 후 시작합니다. 지금까지 ${s.joined}명이 입장했습니다.`, tone: 'calm' });
      }

      if (s.phase === 'question' && s.qIndex !== this.lastQIndex) {
        this.lastQIndex = s.qIndex;
        const d = s.question && s.question.difficulty;
        const first = s.qIndex === 0;
        out.push({
          text: first
            ? `첫 번째 문항입니다. 난이도는 ${DIFF_KO[d] || '쉬움'}입니다.`
            : `${ordinal(s.qIndex)} 문항입니다. 난이도는 ${DIFF_KO[d] || '보통'}입니다.`,
          tone: 'cue',
        });
        if (!first && alive > 0 && alive <= 10) {
          out.push({ text: `${alive}명 남았습니다.`, tone: 'calm' });
        }
      }

      if (phaseChanged && s.phase === 'reveal' && s.reveal) {
        const r = s.reveal;
        out.push({
          text: `정답은 ${r.answer}입니다.`,
          say: `정답은 ${SPOKEN[r.answer] || r.answer}입니다.`,
          tone: r.answer === 'O' ? 'good' : 'good',
        });

        if (r.alive === 0) {
          out.push({ text: '전원 탈락입니다.', tone: 'bad' });
        } else if (r.eliminatedCount === 0) {
          out.push({ text: `전원 정답입니다. ${r.alive}명 모두 살아남았습니다.`, tone: 'good' });
        } else {
          out.push({
            text: `${r.eliminatedCount}명이 탈락해 ${r.alive}명이 남았습니다.`,
            tone: 'bad',
          });
        }
      }

      // ── 룰이 바뀌는 지점. 이건 반드시 알려야 한다.
      //
      // 다만 '바뀌는' 지점일 때만이다. 예전에는 idle이 아니기만 하면 읽었기 때문에,
      // 20명짜리 체험처럼 처음부터 임계값 아래인 회차에서는 대기실에서 대뜸
      // "이제부터는 보이지 않습니다"가 나왔다 —— 보인 적이 없는데 안 보이게 된 것이다.
      // 집계가 실제로 보이던 회차가, 문항 중에 끊길 때만 알린다.
      if (s.tallyVisible === true) this.sawTally = true;
      if (!this.saidThreshold && this.sawTally && alive > 0 && alive < threshold
          && (s.phase === 'question' || s.phase === 'reveal')) {
        this.saidThreshold = true;
        out.push({
          text: '이제부터는 다른 사람의 선택이 보이지 않습니다. 혼자 판단하셔야 합니다.',
          tone: 'rule',
        });
      }

      // ── 10명 이하가 되면 본부별 판세를 읽어준다.
      if (phaseChanged && s.phase === 'reveal' && alive > 1 && alive <= 10) {
        const rank = divisionRank(s);
        if (rank.length) {
          const breakdown = rank.map((d) => `${d.short} ${d.n}명`).join(', ');
          const lead = rank.length > 1 && rank[0].n === rank[1].n
            ? `${rank[0].n}명씩 팽팽합니다.`
            : `${rank[0].name}이 ${rank[0].n}명으로 가장 많습니다.`;
          out.push({ text: `${breakdown}. ${lead}`, tone: 'calm' });
        }
      }

      // ── VIP 탈락
      if (!this.saidVipOut && s.vip && s.vip.alive === false && s.phase !== 'idle') {
        this.saidVipOut = true;
        out.push({ text: `${s.vip.title || 'VIP'} ${s.vip.name}님이 탈락하셨습니다.`, tone: 'bad' });
      }

      // ── 결승
      if (!this.saidFinal && alive === 2 && (s.phase === 'reveal' || s.phase === 'question')) {
        this.saidFinal = true;
        out.push({ text: '결승입니다. 이제 두 명 남았습니다.', tone: 'cue' });
      }

      if (phaseChanged && s.phase === 'sudden') {
        out.push({ text: '서든데스입니다. 정답에 가장 가까운 숫자를 낸 사람이 이깁니다.', tone: 'cue' });
      }

      if (phaseChanged && s.phase === 'result' && s.result) {
        const r = s.result;
        out.push(
          r.champion
            ? { text: `오늘의 챔피언은 ${r.champion.dept} ${r.champion.name}님입니다.`, tone: 'good' }
            : { text: '전원 탈락으로 이번 회차의 챔피언은 없습니다.', tone: 'bad' },
        );
      }

      this.lastPhase = s.phase;
      return out;
    }
  }

  global.Commentary = Commentary;
  global.divisionRank = divisionRank;
})(window);
