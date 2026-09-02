'use strict';

/**
 * 12:55 — 소리
 *
 * 모든 소리를 런타임에 합성한다. 음원 파일도 네트워크 요청도 없다.
 * 브라우저는 사용자가 한 번 누르기 전에는 소리를 내지 못하므로 unlock()을 먼저 호출해야 한다.
 * 참여자 폰은 로그인 버튼에서 자연히 풀리고, 전광판은 준비 화면의 버튼이 그 역할을 한다.
 *
 * 나레이션은 브라우저 내장 음성 합성을 쓴다. 기계적인 톤이 이 게임에 오히려 맞고,
 * 파일도 네트워크도 필요 없다.
 */

(function (global) {
  const Sfx = {
    ctx: null,
    noiseBuf: null,
    muted: false,

    unlock() {
      if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return true; }
      const AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC();
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return true;
    },

    /**
     * 출력단 리미터.
     * 효과음이 겹치면 피크가 붙어 찢어진다. 모든 소리를 컴프레서로 보내 겹쳐도 깨지지 않게 한다.
     */
    get master() {
      if (this._master && this._masterCtx === this.ctx) return this._master;
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.setValueAtTime(-8, this.ctx.currentTime);
      comp.knee.setValueAtTime(12, this.ctx.currentTime);
      comp.ratio.setValueAtTime(6, this.ctx.currentTime);
      comp.attack.setValueAtTime(0.004, this.ctx.currentTime);
      comp.release.setValueAtTime(0.25, this.ctx.currentTime);
      comp.connect(this.ctx.destination);
      this._master = comp;
      this._masterCtx = this.ctx;
      return comp;
    },

    /** 단순 음. 짧은 신호음에 쓴다. */
    tone({ freq, to, dur = 0.12, type = 'sine', gain = 0.14, delay = 0 }) {
      if (!this.ctx || this.muted) return;
      const t0 = this.ctx.currentTime + delay;
      const osc = this.ctx.createOscillator();
      const amp = this.ctx.createGain();

      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);

      amp.gain.setValueAtTime(0.0001, t0);
      amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
      amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

      osc.connect(amp).connect(this.master);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
      osc.onended = () => { osc.disconnect(); amp.disconnect(); };
    },

    // ── 게임 신호음
    select()   { this.tone({ freq: 520, to: 780, dur: 0.07, type: 'triangle', gain: 0.11 }); },
    tick()     { this.tone({ freq: 880, dur: 0.04, type: 'square', gain: 0.07 }); },
    countTick(n) { this.tone({ freq: 440 + (3 - n) * 110, dur: 0.09, type: 'square', gain: 0.1 }); },
    warn()     { this.tone({ freq: 300, to: 420, dur: 0.16, type: 'square', gain: 0.1 }); },
    correct()  { this.tone({ freq: 660, dur: 0.1, type: 'triangle', gain: 0.13 });
                 this.tone({ freq: 990, dur: 0.18, type: 'triangle', gain: 0.12, delay: 0.1 }); },
    dead()     { this.tone({ freq: 220, to: 55, dur: 0.6, type: 'sawtooth', gain: 0.13 }); },
    champ()    { [523, 659, 784, 1047].forEach((f, i) =>
                   this.tone({ freq: f, dur: 0.22, type: 'triangle', gain: 0.12, delay: i * 0.11 })); },

    /** 층이 올라가는 소리 — 낮은 데서 높은 데로 미끄러진다 */
    rise()     { this.tone({ freq: 180, to: 520, dur: 0.9, type: 'triangle', gain: 0.1 });
                 this.tone({ freq: 90, to: 260, dur: 1.1, type: 'sine', gain: 0.08 }); },

    // ── 나레이션
    //
    // 음성 합성은 함정이 많다.
    //   · getVoices()가 첫 호출에서 빈 배열을 돌려준다 (비동기 로드)
    //   · utterance를 붙잡아두지 않으면 말하는 도중 GC되어 잘린다
    //   · Chrome은 긴 문장에서 15초쯤 뒤 스스로 멈춘다 (pause/resume으로 되살린다)
    //   · 앞 문장이 끝나기 전에 speak하면 큐에 쌓여 한참 뒤에 나온다
    voice: null,
    voicesReady: false,
    _queue: [],
    _held: [],
    narrationOn: true,

    _loadVoices() {
      if (!('speechSynthesis' in global)) return false;
      const all = global.speechSynthesis.getVoices();
      if (!all.length) return false;
      this.voicesReady = true;
      this.voice =
        all.find((v) => v.lang && v.lang.toLowerCase().startsWith('ko')) ||
        all.find((v) => /korean|한국/i.test(v.name)) ||
        null;
      return true;
    },

    /** 대기 중이던 문장을 음성 목록이 준비된 뒤 밀어낸다. */
    _flush() {
      if (!this.voicesReady && !this._loadVoices()) return;
      const q = this._queue.splice(0);
      for (const item of q) this._speak(item.text, item.opts);
    },

    _speak(text, { rate = 1, pitch = 0.95, volume = 1 } = {}) {
      const synth = global.speechSynthesis;
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ko-KR';
      u.rate = rate;
      u.pitch = pitch;
      u.volume = volume;
      if (this.voice) u.voice = this.voice;

      // GC 방지 — 참조를 들고 있다가 끝나면 놓는다
      this._held.push(u);
      // 말하는 동안 음악을 눌러 둔다. 마지막 문항은 우승곡 위에서 진행되므로
      // 더킹이 없으면 중계가 곡에 통째로 묻힌다.
      let ducked = false;
      const duck = (on) => {
        if (on === ducked || !global.Music || !global.Music.duck) return;
        ducked = on;
        global.Music.duck(on);
      };
      u.onstart = () => duck(true);
      const release = () => {
        duck(false);
        const i = this._held.indexOf(u);
        if (i >= 0) this._held.splice(i, 1);
        clearInterval(keepAlive);
      };
      u.onend = release;
      u.onerror = release;

      // onstart가 오지 않는 브라우저가 있다. 안전망으로 조금 뒤 스스로 잠근다.
      setTimeout(() => { if (this._held.indexOf(u) >= 0) duck(true); }, 120);
      // 그리고 어떤 경우에도 영원히 눌려 있지 않게 한다 —— 읽는 시간 + 여유.
      setTimeout(release, this.estimate(text) + 4000);

      // Chrome이 스스로 멈추는 것을 되살린다
      const keepAlive = setInterval(() => {
        if (!synth.speaking) { clearInterval(keepAlive); return; }
        synth.pause();
        synth.resume();
      }, 5000);

      synth.speak(u);
    },

    /**
     * 사번처럼 숫자를 하나씩 읽어야 하는 곳에 쓴다. "직원 26008" → "직원 2 6 0 0 8".
     * 그대로 두면 한국어 TTS가 "이만육천팔"처럼 하나의 수로 읽는다. 문장 전체가 아니라
     * 이름 조각에만 써야 한다 — "12시 55분" 같은 진짜 숫자까지 자릿수로 쪼개면 안 된다.
     */
    spokenDigits(str) {
      return String(str ?? '').replace(/\d{2,}/g, (run) => run.split('').join(' '));
    },

    say(text, opts = {}) {
      if (!('speechSynthesis' in global) || this.muted || !this.narrationOn || !text) return;
      if (opts.force) global.speechSynthesis.cancel();

      // 큐가 밀리면 진행보다 멘트가 늦어진다. 두 문장 이상 밀렸으면 오래된 것을 버린다.
      if (this._queue.length > 2) this._queue.splice(0, this._queue.length - 2);

      if (this.voicesReady || this._loadVoices()) this._speak(text, opts);
      else this._queue.push({ text, opts });
    },

    /**
     * 이 문장을 읽는 데 걸리는 대략의 시간(ms).
     *
     * 자막 간격을 고정값으로 두면 짧은 문장에서는 뜨고 긴 문장에서는 밀린다.
     * 한국어 TTS는 rate 1에서 초당 대여섯 자쯤 읽고, 문장부호에서 한 박자 쉰다.
     * 음성이 꺼져 있어도 같은 값을 쓴다 —— 자막만 봐도 호흡이 같아야 한다.
     */
    estimate(text) {
      if (!text) return 0;
      const str = String(text);
      const pauses = (str.match(/[.,!?·]/g) || []).length;
      return Math.min(9000, Math.round(str.length * 165 + pauses * 180 + 400));
    },

    silence() {
      this._queue.length = 0;
      if ('speechSynthesis' in global) global.speechSynthesis.cancel();
      // cancel()은 onend를 안 주는 브라우저가 있다. 음악이 눌린 채 남지 않게 직접 푼다.
      if (global.Music && global.Music.unduck) global.Music.unduck();
    },

    /** 실제로 소리가 나는지 확인용. 준비 상태를 돌려준다. */
    voiceStatus() {
      const supported = 'speechSynthesis' in global;
      const all = supported ? global.speechSynthesis.getVoices() : [];
      return {
        supported,
        ready: this.voicesReady,
        total: all.length,
        picked: this.voice ? `${this.voice.name} (${this.voice.lang})` : null,
        korean: all.filter((v) => v.lang && v.lang.toLowerCase().startsWith('ko')).map((v) => v.name),
      };
    },
  };

  if ('speechSynthesis' in global) {
    global.speechSynthesis.addEventListener('voiceschanged', () => {
      Sfx.voicesReady = false;
      Sfx._flush();
    });
    // 목록이 늦게 채워지는 브라우저를 위해 몇 번 더 시도한다
    let tries = 0;
    const poll = setInterval(() => {
      if (Sfx._loadVoices() || (tries += 1) > 20) { clearInterval(poll); Sfx._flush(); }
    }, 250);
  }

  global.Sfx = Sfx;
})(window);
