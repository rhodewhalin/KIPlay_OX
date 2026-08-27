'use strict';

/**
 * 12:55 — 배경음악
 *
 * 수노(Suno)에서 유료 제작한 두 곡을 튼다.
 *
 *   kipi-esports.wav (19초)   개장 로고송. 접속하면 한 차례 울린다.
 *                             매주 월요일 12:50~12:55 프리쇼에는 서버가 SSE로
 *                             큐를 쏘고, 접속한 모든 화면이 같은 순간에 튼다 ——
 *                             개별 반복이 아니라 회장 전체가 하나의 스피커다.
 *   crown-of-valor.wav (102초) 우승곡. 챔피언이 확정되는 순간 곧바로 튼다.
 *                             곡의 좋은 부분을 기다리게 하지 않는 것이 요점이다.
 *
 * 브라우저는 사용자 제스처 없이 소리를 못 낸다. enable()이 그 제스처 자리에서
 * 불려야 하고(전광판의 '준비 완료', 입장·체험 버튼), 그전의 재생 요청은 무시된다.
 * 재생 실패는 전부 조용히 삼킨다 —— 음악이 안 나와도 게임은 돌아가야 한다.
 */

(function (global) {
  const TRACKS = {
    lobby: { src: 'audio/kipi-esports.wav', volume: 0.6 },
    crown: { src: 'audio/crown-of-valor.wav', volume: 0.9 },
  };

  // 로고송 실제 길이. 메타데이터가 아직이면 이 값으로 계산한다 (체험 대기실 길이).
  const JINGLE_SEC = 19.4;

  const players = {};
  for (const [key, t] of Object.entries(TRACKS)) {
    const a = new Audio(t.src);
    a.preload = 'auto';
    a.volume = t.volume;
    players[key] = a;
  }

  let enabled = false;

  /* ── 더킹 ────────────────────────────────────────────────────
   *
   * 마지막 문항은 우승곡과 겹친다. 곡이 클라이맥스로 가는 그 위에 중계가 얹히면
   * 둘 다 안 들린다 —— 특히 폰 스피커에서는 음성이 곡에 완전히 묻힌다.
   * 나레이션이 열리면 음악을 DUCK 배까지 내리고, 말이 끝나면 되돌린다.
   *
   * 뚝 끊지 않고 램프로 오르내린다. 볼륨이 계단으로 뛰면 그 자체가 잡음으로 들린다.
   * speak가 겹칠 수 있으므로 열린 입의 수를 세고, 0이 될 때만 음악을 올린다.
   */
  const DUCK = 0.25;
  const RAMP_MS = 180;
  let mouths = 0;
  let level = 1;          // 지금 걸려 있는 배율
  let rampTimer = null;

  function applyLevel() {
    for (const [key, t] of Object.entries(TRACKS)) players[key].volume = t.volume * level;
  }

  function rampTo(target) {
    if (rampTimer) clearInterval(rampTimer);
    const step = 40;
    const delta = (target - level) / Math.max(1, RAMP_MS / step);
    rampTimer = setInterval(() => {
      level += delta;
      if ((delta >= 0 && level >= target) || (delta < 0 && level <= target)) {
        level = target;
        clearInterval(rampTimer);
        rampTimer = null;
      }
      applyLevel();
    }, step);
  }

  function playFromTop(key) {
    const a = players[key];
    try { a.currentTime = 0; } catch (e) { /* 아직 메타데이터 전이면 그냥 처음부터다 */ }
    a.play().catch(() => { /* 자동재생 차단 등 — 게임은 계속 간다 */ });
  }

  const Music = {
    /** 사용자 제스처 안에서 불러야 한다. 여기서 두 곡을 예열해 둔다. */
    enable() {
      if (enabled) return;
      enabled = true;
      for (const a of Object.values(players)) a.load();
    },

    /**
     * 접속 직후의 자동 재생 시도 — 접속하면 한 차례.
     *
     * 링크를 열고 게임 화면이 뜨면 잠깐 뒤 로고송이 울린다. 브라우저가 제스처 없는
     * 재생을 막으면(대부분의 폰이 그렇다) 조용히 물러났다가, 첫 터치·키 입력에서
     * 곧바로 이어서 튼다. 어느 쪽이든 게임은 멈추지 않는다.
     */
    autoJingle(delayMs) {
      setTimeout(() => {
        enabled = true;
        for (const a of Object.values(players)) a.load();
        const a = players.lobby;
        try { a.currentTime = 0; } catch (e) { /* 메타데이터 전이면 그냥 처음부터 */ }
        a.play().catch(() => {
          const once = () => {
            document.removeEventListener('pointerdown', once);
            document.removeEventListener('keydown', once);
            playFromTop('lobby');
          };
          document.addEventListener('pointerdown', once);
          document.addEventListener('keydown', once);
        });
      }, delayMs || 1000);
    },

    /** 로고송을 지금 즉시 한 번. 서버의 프리쇼 큐가 이걸 부른다. */
    jingle() {
      if (!enabled) return;
      playFromTop('lobby');
    },

    /** 로고송이 흐르는 중이면 남은 초, 아니면 null. */
    jingleRemaining() {
      const a = players.lobby;
      if (a.paused || a.ended) return null;
      const dur = isFinite(a.duration) && a.duration > 0 ? a.duration : JINGLE_SEC;
      return Math.max(0, dur - a.currentTime);
    },

    /**
     * 로고송을 처음부터 틀고 곡 길이(초)를 돌려준다.
     * 재생이 실제로 시작되지 못하면(자동재생 차단 등) null — 호출한 쪽이 폴백한다.
     */
    async jingleStart() {
      if (!enabled) return null;
      const a = players.lobby;
      try { a.currentTime = 0; } catch (e) { /* 메타데이터 전 */ }
      try { await a.play(); } catch (e) { return null; }
      return isFinite(a.duration) && a.duration > 0 ? a.duration : JINGLE_SEC;
    },

    /** 우승 확정 — 곧바로 처음부터. 이미 흐르는 중이면 그대로 둔다. */
    crown() {
      if (!enabled) return;
      if (!players.crown.paused) return;
      playFromTop('crown');
    },

    /** 다음 회차가 시작되면 우승곡을 걷는다. */
    stopCrown() {
      const a = players.crown;
      if (!a.paused) a.pause();
    },

    /**
     * 나레이션이 입을 열 때 duck(true), 끝나면 duck(false).
     * sfx.js의 _speak가 부른다. 겹쳐 불려도 안전하다.
     */
    duck(on) {
      mouths = Math.max(0, mouths + (on ? 1 : -1));
      rampTo(mouths > 0 ? DUCK : 1);
    },

    /** 말이 다 끝났다고 확신할 때 (silence 등) — 세던 것을 리셋하고 음악을 되돌린다. */
    unduck() {
      mouths = 0;
      rampTo(1);
    },

    /** 화면이 가려졌을 때 등 — 전부 멈춘다. */
    stopAll() {
      for (const a of Object.values(players)) if (!a.paused) a.pause();
    },
  };

  global.Music = Music;
})(window);
