'use strict';

/**
 * 12:55 — 군중 무대 렌더러
 *
 * 구도
 *   게임장 하나가 도면 한 장이다. O와 X 두 구역 상자가 위쪽 절반을 차지하고,
 *   아직 답하지 않은 사람들은 아래 대기 구역에 모여 있다. 문제가 뜨면 각자
 *   구역 상자 안으로 달려 들어간다. 앞사람이 어디로 뛰는지가 그대로 보인다.
 *   인원이 많으면 뒷줄은 화면 아래로 넘쳐 흐른다. 400명을 다 보여줄 필요가 없다.
 *
 * 정답 공개
 *   맞은 구역에는 등록 도장이 찍히고 틀린 구역은 사선으로 지워진다. 살아남은
 *   사람들은 대기 구역으로 내려와 같은 자리에서 다음 문항을 기다린다.
 *   층 상승 구조는 걷어냈다 —— 게임장은 하나다.
 *
 * 이 파일은 그리기만 한다. 탈락 판정은 서버가 이미 끝냈고 여기서는 확정된 사실을
 * 렌더링할 뿐이다. 프레임이 밀려도 게임 결과는 흔들리지 않는다.
 */

(function (global) {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  // ── 구도 비율 (화면 기준)
  //
  // 게임장 하나가 도면 한 장이다. O와 X 두 구역 상자가 지면의 위쪽 절반을 차지하고,
  // 아직 답하지 않은 사람들은 아래 대기 구역에 모여 있다. 참여자 화면에서는 이 두 상자
  // 위에 투명 버튼이 겹쳐서, 구역 자체가 곧 버튼이 된다.
  /* 도면부호가 캡션 아래 띠를 쓰던 시절에는 상자를 0.165까지 내려야 했다. 이제 부호는
   * 아래(또는 오른쪽 단)의 「부호의 설명」에서 출발하므로 위에 자리를 비워 둘 이유가 없다.
   * 그 공백을 전부 상자와 출발선 사이로 옮긴다 —— 달려가는 거리가 이 그림의 내용이다.
   * BOX 값은 CSS .choice-o/.choice-x가 아니라 zoneRects()가 읽는다. */
  const BOX = {
    top: 0.075,   // 구역 상자 윗변
    bot: 0.50,    // 아랫변
    oL: 0.035, oR: 0.485,   // O 구역 좌우
    xL: 0.515, xR: 0.965,   // X 구역 좌우
  };
  const START_Y = 0.68;     // 출발선 —— 여기서 출발해 구역 상자로 달려간다
  const HOME_Y = 0.78;      // 출발선 뒤 첫 줄
  const HOME_W = 0.46;      // 대기 구역 폭

  // ── 옥상 구도 (우승 장면 전용)
  //
  // 카메라는 챔피언의 등 뒤, 옥상 바닥 높이에 있다. 그래서 도시는 눈높이 아래에 깔리고
  // 챔피언의 상반신만 그 위로 솟는다. 아래 네 값이 그 구도를 잡는다.
  const ROOF_SKY = 0.26;    // 지평선 — 이 위는 하늘, 아래는 내려다보는 도시
  const ROOF_EDGE = 0.70;   // 난간 윗면 — 여기서 도시가 끝나고 옥상이 시작된다
  const ROOF_DECK = 0.78;   // 발을 딛는 바닥
  const ROOF_STAND = 0.87;  // 챔피언이 서는 자리
  const ROOF_R = 0.16;      // 챔피언 크기. 머리와 어깨가 난간선 위로 나오는 값이다.

  /** 프레임마다 같은 스카이라인이 나와야 한다. 시드 고정 난수. */
  function seeded(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let x = Math.imul(a ^ (a >>> 15), 1 | a);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * 인원이 줄수록 사람이 커진다. 화면 높이에 대한 비율로 잡아 어떤 크기에서도 같게 보인다.
   *
   * 하한이 중요하다. 사람을 무한정 줄여 400명을 다 담으려 하면 격자처럼 보이고 군중이 아니게 된다.
   * 앞줄 100명 남짓만 보이고 나머지는 화면 아래로 넘치는 편이 훨씬 군중답다.
   */
  function radiusFor(alive, H, minRatio = 0.020) {
    const k = Math.pow(120 / Math.max(1, alive), 0.35);
    return H * clamp(0.020 * k, minRatio, 0.085);
  }

  function tierFor(alive) {
    if (alive > 300) return 0;
    if (alive > 100) return 1;
    if (alive > 30) return 2;
    if (alive > 10) return 3;
    if (alive > 2) return 4;
    return 5;
  }

  /* ── 공보 팔레트 ────────────────────────────────────────────
   *
   * 등록특허공보는 먹과 종이다. 색은 정보가 아니라 방해다.
   *
   * 단 하나의 강조색만 쓴다 —— 인주 빨강. 그것도 도장을 찍을 때만.
   * 정답이 공개되는 순간에만 화면에 빨강이 등장하므로, 그 색이 곧 판정이 된다.
   * 소속색은 윤곽선 안쪽을 아주 옅게 채우는 데만 쓴다. 주인공은 어디까지나 선이다.
   */
  const P = {
    paper:  '#FAF7F0',   // 공보 용지
    paper2: '#F2EEE4',   // 접힌 면, 표 바탕
    ink:    '#141414',
    mid:    '#5A5A5A',
    light:  '#9A9A9A',
    rule:   '#C8C2B6',   // 괘선
    seal:   '#B03A2E',   // 인주. 판정과 '본인' 표시에만 쓴다.
    sprout: '#2E7D32',   // 신입 새싹. 잎이 녹색이라야 새싹으로 읽힌다.
    sproutFill: '#A7D3A2',
  };

  /**
   * 소속색.
   *
   * 처음에는 채도를 눌러 선 아래에 깔았는데, 그 결과 여섯 본부가 전부 같은 회갈색으로
   * 보여 "우리 본부가 몇 명 남았나"를 눈으로 셀 수 없었다. 색이 정보를 나르는 유일한
   * 자리이므로 채도를 올린다. 대신 인주(#B03A2E) 계열 —— 빨강·주황 —— 은 비워 둔다.
   * 그 색은 판정에만 등장해야 하고, 본부색이 그 자리를 넘보면 도장이 안 보인다.
   * 원본은 data/employees.json의 divisions.color다. 여기 배열은 그걸 못 받았을 때의 대비책.
   */
  const DIV_TINT = ['#1F5FA8', '#0E8F72', '#6B3FA0', '#A8730A', '#A81E7A', '#4C5A63', '#141414'];

  /** 몸통을 채우는 진하기. 선이 색에 먹히지 않는 선에서 최대한 올린다. */
  const TINT_ALPHA = 0.62;

  const px = (v) => Math.round(v) + 0.5;   // 선을 픽셀 격자에 앉혀 흐려지지 않게 한다

  /**
   * 사선 해칭. 도면에서 면을 채우는 유일한 방법이다.
   * 명암을 쓰지 않고 선 간격만으로 농도를 만든다 —— 인쇄를 전제한 그림의 문법이다.
   */
  function hatch(c, x0, y0, w, h, gap, alpha, dir) {
    if (w <= 0 || h <= 0) return;
    c.save();
    c.beginPath();
    c.rect(x0, y0, w, h);
    c.clip();
    c.strokeStyle = `rgba(20,20,20,${alpha})`;
    c.lineWidth = 0.6;
    c.beginPath();
    if (dir === -1) {
      for (let i = -h; i < w + h; i += gap) {
        c.moveTo(x0 + i, y0);
        c.lineTo(x0 + i + h, y0 + h);
      }
    } else {
      for (let i = -h; i < w + h; i += gap) {
        c.moveTo(x0 + i, y0 + h);
        c.lineTo(x0 + i + h, y0);
      }
    }
    c.stroke();
    c.restore();
  }

  /**
   * 인출선과 부호. 도면의 문법 그 자체다.
   * 가리키는 점에 작은 원, 거기서 뻗은 선, 끝에 숫자.
   */
  function callout(c, num, tx, ty, lx, ly, size, bold) {
    c.strokeStyle = P.ink;
    c.lineWidth = bold ? 1.4 : 0.8;
    c.beginPath();
    c.moveTo(px(tx), px(ty));
    c.lineTo(px(lx), px(ly));
    c.stroke();
    c.fillStyle = P.ink;
    c.beginPath();
    c.arc(tx, ty, Math.max(bold ? 2 : 1.2, size * (bold ? 0.22 : 0.16)), 0, 6.283);
    c.fill();

    // 도면부호는 종이 위에 앉는다. 뒤에 해칭이나 사람이 있으면 글자가 무늬에 먹히므로
    // 부호 자리만큼 용지를 깔아 준다 —— 실제 공보에서도 부호 주변은 늘 비어 있다.
    c.font = `${bold ? 700 : 500} ${size}px ui-monospace, monospace`;
    const right = lx > tx;
    const tw = c.measureText(num).width;
    const bx = right ? lx + size * 0.4 : lx - size * 0.4 - tw;
    if (bold) {
      c.fillStyle = P.paper;
      c.fillRect(bx - size * 0.28, ly - size * 0.72, tw + size * 0.56, size * 1.44);
      c.fillStyle = P.ink;
    }
    c.textAlign = 'left';
    c.textBaseline = 'middle';
    c.fillText(num, bx, ly);
  }

  /**
   * 별. 본인의 든 손에 하나 찍힌다.
   *
   * 예전에는 인주색 원으로 사람을 통째로 둘렀는데, 그 원이 커서 정답 공개 때
   * 찍히는 등록 도장과 자주 겹쳤다 —— 판정의 빨강과 위치의 빨강이 한 화면에서
   * 섞이면 둘 다 안 읽힌다. 표식을 손끝의 작은 별 하나로 줄인 이유다.
   */
  function star(c, cx, cy, r, color) {
    c.beginPath();
    for (let i = 0; i < 10; i += 1) {
      const rad = i % 2 ? r * 0.44 : r;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const sx = cx + Math.cos(a) * rad;
      const sy = cy + Math.sin(a) * rad;
      if (i) c.lineTo(sx, sy); else c.moveTo(sx, sy);
    }
    c.closePath();
    c.fillStyle = color;
    c.fill();
  }

  /**
   * 도장. 등록이면 원, 거절이면 사선.
   *
   * 이 게임에서 색이 등장하는 유일한 순간이다. 정답이 공개될 때만 인주가 찍힌다.
   */
  function seal(c, cx, cy, r, text, t) {
    // 찍히는 순간 살짝 커졌다 제자리로 —— 도장은 눌렸다 떨어진다
    const pop = t === undefined ? 1 : 1 + 0.12 * Math.exp(-t / 160);
    const rr = r * pop;
    c.save();
    c.translate(cx, cy);
    c.rotate(-0.12);
    c.strokeStyle = P.seal;
    c.lineWidth = Math.max(1.5, r * 0.11);
    c.beginPath();
    c.arc(0, 0, rr, 0, 6.283);
    c.stroke();
    c.beginPath();
    c.arc(0, 0, rr * 0.82, 0, 6.283);
    c.lineWidth = Math.max(1, r * 0.05);
    c.stroke();
    c.fillStyle = P.seal;
    c.font = `700 ${Math.round(rr * 0.52)}px "Nanum Myeongjo", Batang, 바탕, serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(text, 0, rr * 0.04);
    c.restore();
  }

  // ── 장면은 둘뿐이다. 게임장(도 1)과, 우승 연출 전용의 옥상(도 2).
  const SCENES = {
    ground:  { no: 1, label: '게임장', caption: 'O·X 게임장',        draw: drawGround },
    rooftop: { no: 2, label: '옥상',   caption: '우승자 옥상 사시도', draw: drawRooftop },
  };

  /**
   * 게임장 — 【도 1】.
   *
   * 층 상승 구조는 걷어냈다. 운동장이든 강당이든, 살아남은 사람들이 같은 자리에서
   * 계속 겨룬다. 여기서는 구역 상자 아래의 바닥과 소실선만 그린다. 상자와 글자,
   * 도면부호는 drawZones와 drawSheetFurniture가 그린다 —— 상자 위에 사람이 서야
   * 하므로 그리는 순서가 나뉘어 있을 뿐이다.
   */
  function drawGround(c, w, h, t, stage) {
    // 출발선. 육상 트랙처럼 굵은 실선 하나에 짧은 눈금을 세워 '선'임을 분명히 한다.
    const fy = Math.round(h * ((stage && stage.startY) || START_Y));
    c.strokeStyle = P.ink;
    c.lineWidth = 2.2;
    c.beginPath();
    c.moveTo(px(0), px(fy));
    c.lineTo(px(w), px(fy));
    c.stroke();

    c.lineWidth = 1;
    c.beginPath();
    const tick = Math.max(3, h * 0.012);
    for (let x = w * 0.02; x < w; x += Math.max(10, w * 0.045)) {
      c.moveTo(px(x), px(fy));
      c.lineTo(px(x), px(fy - tick));
    }
    c.stroke();

    // 소실점으로 모이는 바닥선. 이게 있어야 아래 무리가 평면 위에 서 있는 것으로 읽힌다.
    c.strokeStyle = 'rgba(20,20,20,.14)';
    c.lineWidth = 0.6;
    c.beginPath();
    for (let i = 0; i <= 10; i += 1) {
      const bx = (w * i) / 10;
      c.moveTo(px(lerp(w / 2, bx, 0.30)), px(fy));
      c.lineTo(px(bx), px(h));
    }
    c.stroke();
  }

  /**
   * 사진 위에 얹는 생기.
   *
   * 정지 사진은 4주만 지나도 닳는다. 창 몇 개가 아주 느리게 켜지고 꺼지는 것만으로
   * 도시가 살아 있게 보인다. 사진에 이미 디테일이 있으니 여기서는 세게 넣지 않는다.
   */
  function drawRoofLife(c, w, h, t) {
    const top = h * ROOF_SKY;
    const span = h * (ROOF_EDGE - ROOF_SKY);
    let seed = 20250819;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    c.fillStyle = P.ink;
    for (let i = 0; i < 26; i += 1) {
      const x = rnd() * w;
      // 아래쪽(가까운 건물)에 더 많이 몰리게 한다
      const y = top + span * Math.pow(rnd(), 0.6);
      const ph = rnd() * 6.283;
      if ((Math.sin(t / 1100 + ph) + 1) / 2 < 0.55) continue;
      c.fillRect(Math.round(x), Math.round(y), Math.max(1, w * 0.0022), Math.max(1, h * 0.006));
    }

    // 항공장애등. 도면에서 유일하게 인주가 찍히는 자리다.
    if (Math.sin(t / 620) > 0) {
      c.fillStyle = P.seal;
      c.beginPath();
      c.arc(w * 0.085, h * (ROOF_EDGE - 0.16), Math.max(1.5, h * 0.007), 0, 6.283);
      c.fill();
    }
  }

  /**
   * 옥상 — 우승 장면.
   *
   * 이 그림에서 유일하게 중요한 건 시점이다. 도시를 눈높이에 두면 길에 서 있는 그림이 되고,
   * 눈높이 아래로 내려야 비로소 내려다보는 그림이 된다. 그래서 지평선을 화면 위쪽(ROOF_SKY)에
   * 붙이고, 건물은 전부 그 아래에 깔되 앞으로 올수록 크고 어둡게 그린다. 난간(ROOF_EDGE)이
   * 도시와 옥상을 가르고, 그 아래가 챔피언이 딛고 선 바닥이다.
   */
  function drawRooftop(c, w, h, t, stage) {
    // 사진 배경이 준비돼 있으면 그것이 하늘·도시·난간·바닥을 전부 대신한다.
    // 없으면 아래의 절차적 옥상이 그대로 그려진다. 이미지는 선택이지 전제가 아니다.
    const bd = stage && stage.backdrop;
    if (bd && bd.ready() && bd.build(w, h, ROOF_EDGE)) {
      bd.draw(c, w, h);
      if (bd.life) drawRoofLife(c, w, h, t);
      return;
    }

    const horizon = h * ROOF_SKY;
    const edge = h * ROOF_EDGE;
    const deck = h * ROOF_DECK;
    const sunX = w * 0.68;

    // ── 해. 도면에서 광원은 동심원 몇 개로 표시한다.
    c.strokeStyle = P.light;
    c.lineWidth = 0.7;
    for (let i = 1; i <= 4; i += 1) {
      c.beginPath();
      c.arc(sunX, horizon - h * 0.02, h * 0.045 + i * h * 0.028, Math.PI, 0);
      c.stroke();
    }
    c.strokeStyle = P.ink;
    c.lineWidth = 1;
    c.beginPath();
    c.arc(sunX, horizon - h * 0.02, h * 0.045, 0, 6.283);
    c.stroke();

    /**
     * 건물 한 띠. 선화라 채우지 않고 윤곽만 그린다.
     * 거리는 명암이 아니라 선 굵기와 해칭 밀도로 만든다 —— 흑백 인쇄의 원근법이다.
     */
    const band = (seed, base, minH, maxH, minW, maxW, lw, hatchA, win) => {
      const rnd = seeded(seed);
      let x = -maxW * rnd();
      c.lineWidth = lw;
      c.strokeStyle = P.ink;
      while (x < w) {
        const bw = Math.max(3, minW + (maxW - minW) * rnd());
        const bh = Math.max(3, minH + (maxH - minH) * rnd());
        const top = base - bh;
        c.fillStyle = P.paper;
        c.fillRect(px(x), px(top), Math.round(bw), Math.round(base - top));
        c.strokeRect(px(x), px(top), Math.round(bw), Math.round(base - top));

        // 옥탑의 물탱크나 계단실
        if (rnd() > 0.62 && bw > 8) {
          const cw = bw * 0.3;
          const ch = bh * 0.16;
          c.fillStyle = P.paper;
          c.fillRect(px(x + bw * 0.25), px(top - ch), Math.round(cw), Math.round(ch));
          c.strokeRect(px(x + bw * 0.25), px(top - ch), Math.round(cw), Math.round(ch));
        }
        if (hatchA > 0) hatch(c, x + 1, top + 1, bw - 2, bh - 2, 6, hatchA, 1);

        // 창. 도면에서는 작은 사각형 격자다.
        if (win && bw > 14) {
          c.lineWidth = 0.5;
          for (let i = 4; i < bw - 5; i += 7) {
            for (let j = 5; j < bh - 4; j += 9) {
              if (rnd() > 0.5) continue;
              c.strokeRect(px(x + i), px(top + j), 3, 4);
            }
          }
          c.lineWidth = lw;
        }
        x += bw + 2 + rnd() * (maxW * 0.28);
      }
    };

    // ── 먼 스카이라인 → 중간 블록 → 발밑의 도시. 앞으로 올수록 굵고 진하다.
    band(11, horizon + h * 0.10, h * 0.03, h * 0.09, w * 0.010, w * 0.030, 0.5, 0, false);
    band(29, horizon + h * 0.24, h * 0.05, h * 0.14, w * 0.016, w * 0.045, 0.75, 0.10, false);
    band(47, edge, h * 0.08, h * 0.20, w * 0.028, w * 0.075, 1.1, 0.18, true);

    // ── 난간. 이 선이 도시와 옥상을 가른다.
    c.fillStyle = P.paper;
    c.fillRect(0, Math.round(edge), w, Math.round(h - edge));
    c.strokeStyle = P.ink;
    c.lineWidth = 1.8;
    c.beginPath();
    c.moveTo(px(0), px(edge));
    c.lineTo(px(w), px(edge));
    c.stroke();
    c.lineWidth = 0.9;
    c.beginPath();
    c.moveTo(px(0), px(deck));
    c.lineTo(px(w), px(deck));
    c.stroke();
    // 난간 안쪽 면 —— 해칭으로 '세워진 면'임을 표시한다
    hatch(c, 0, edge + 1, w, deck - edge - 1, 7, 0.30, 1);

    // 옥상 바닥. 원근선이 소실점으로 모인다.
    c.strokeStyle = 'rgba(20,20,20,.16)';
    c.lineWidth = 0.6;
    c.beginPath();
    for (let i = 0; i <= 10; i += 1) {
      const bx = (w * i) / 10;
      c.moveTo(px(lerp(w / 2, bx, 0.35)), px(deck));
      c.lineTo(px(bx), px(h));
    }
    c.stroke();

    // 환기구와 안테나. 여기가 '건물 옥상'이지 그냥 바닥이 아니라는 표시.
    c.strokeStyle = P.ink;
    c.lineWidth = 1;
    const vw = Math.max(6, w * 0.05);
    const vh = Math.max(6, (h - edge) * 0.34);
    c.fillStyle = P.paper;
    c.fillRect(px(w * 0.06), px(edge - vh), Math.round(vw), Math.round(vh));
    c.strokeRect(px(w * 0.06), px(edge - vh), Math.round(vw), Math.round(vh));
    hatch(c, w * 0.06 + 1, edge - vh + 1, vw - 2, vh - 2, 5, 0.22, -1);
    c.fillRect(px(w * 0.885), px(edge - vh * 0.7), Math.round(vw * 0.7), Math.round(vh * 0.7));
    c.strokeRect(px(w * 0.885), px(edge - vh * 0.7), Math.round(vw * 0.7), Math.round(vh * 0.7));
    c.beginPath();
    c.moveTo(px(w * 0.085), px(edge - vh));
    c.lineTo(px(w * 0.085), px(edge - vh * 2.1));
    c.stroke();
    // 항공장애등. 도면에서 유일하게 인주가 찍히는 자리다.
    if (Math.sin(t / 620) > 0) {
      c.fillStyle = P.seal;
      c.beginPath();
      c.arc(w * 0.085, edge - vh * 2.1, Math.max(1.5, h * 0.009), 0, 6.283);
      c.fill();
    }
  }

  // ═══════════════════════════════════════════════════════════════

  class CrowdStage {
    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      // 캔버스를 불투명(alpha:false)으로 잡으면 크롬이 글자에 LCD 서브픽셀 안티앨리어싱을
      // 쓴다. 그러면 검은 글자 가장자리에 주황·보라 색테가 생긴다. 컬러 화면에서는 안 보이지만
      // 먹과 종이만 쓰는 도면에서는 그 색테가 그대로 눈에 띈다. alpha:true면 회색조로 떨어진다.
      this.ctx = canvas.getContext('2d', { alpha: true });
      this.compact = !!opts.compact;
      this.showZones = opts.zones !== false;

      this.people = [];
      this.divisions = [];
      this.n = 0;

      this.phase = 'idle';
      this.scene = 'ground';
      this.prevScene = null;
      this.sceneT = 1;
      this.backdrop = null;        // 옥상 배경 사진. 없으면 절차적으로 그린다.
      this.roofStand = ROOF_STAND; // 사진이 난간선을 다르게 선언하면 여기가 따라 움직인다.
      this.alive = 0;
      this.named = null;
      this.myIndex = null;
      this.myName = null;

      this.revealSide = null;
      this.sealAt = null;          // 도장이 찍힌 시각. 눌렸다 떨어지는 맛을 위해 잰다.
      this.championIndex = null;   // 우승 장면 — 이 사람만 옥상에 크게 남는다
      this.t0 = performance.now();
      this.raf = null;
      this.dpr = 1;
      this.w = 1; this.h = 1;

      this._onResize = () => this.resize();
      window.addEventListener('resize', this._onResize);
      if ('ResizeObserver' in window) {
        this._ro = new ResizeObserver(() => this.resize());
        this._ro.observe(canvas);
      }
      this.resize();
    }

    /**
     * 도면 가구(캡션·부호의 설명·쪽번호)를 담는 오른쪽 단의 폭.
     *
     * 폰은 세로로 길어 아래에 한 줄을 붙이는 편이 낫지만, PC는 가로가 남고 세로가
     * 모자란다. 남는 가로를 가구에 내주고 그만큼 사람이 뛰는 세로를 벌어 준다.
     * 게임장에서만 쓴다 —— 옥상은 화면을 꽉 채워야 하는 그림이다.
     */
    notesWidth(W, H) {
      if (!this.showZones || this.championIndex !== null) return 0;
      // 문턱은 페이지 CSS의 2단 전환(가로가 세로보다 길 때)과 맞춘다.
      if (this.scene !== 'ground' || W / Math.max(1, H) < 1.02) return 0;
      return clamp(W * 0.24, 132, 260);
    }

    /** 사람과 상자가 실제로 쓰는 폭. 오른쪽 단을 뺀 나머지다. */
    get dw() { return Math.max(40, this.w - this.notesWidth(this.w, this.h)); }

    /**
     * 구역 상자의 아랫변.
     *
     * 세로 화면에서는 아래 한 줄을 부호의 설명에 내줘야 하므로 0.60에서 멈춘다.
     * 가로 화면에서는 그 줄이 오른쪽 단으로 옮겨 가 바닥이 통째로 비므로, 상자와
     * 대기 구역을 그만큼 아래로 늘린다 —— 사람이 뛰는 거리가 곧 이 그림의 내용이다.
     */
    /**
     * 구역 상자의 윗변.
     *
     * BOX.top은 하한일 뿐이다. 【도 N】 캡션의 글자 크기는 화면에 따라 커지므로,
     * 비율을 그대로 쓰면 큰 화면에서 상자가 캡션을 밟는다 —— 실제로 그랬다.
     * 캡션이 실제로 차지한 높이를 재서 그 아래로 한 뼘 띄운다.
     */
    get boxTop() {
      const H = this.h;
      const cap = Math.max(7, Math.round(Math.min(this.dw, H) * 0.045));
      const m = Math.max(5, Math.round(Math.min(this.w, H) * 0.022));
      return Math.max(BOX.top, (m + cap * 1.35 + H * 0.03) / Math.max(1, H));
    }

    get boxBot() { return this.notesWidth(this.w, this.h) > 0 ? 0.58 : BOX.bot; }
    /** 출발선. 대기 구역의 윗변이자, 사람들이 달려 나가는 기준선이다. */
    get startY() { return this.notesWidth(this.w, this.h) > 0 ? 0.74 : START_Y; }
    get homeY() { return this.notesWidth(this.w, this.h) > 0 ? 0.83 : HOME_Y; }

    /**
     * O·X 구역 상자의 화면 좌표(CSS px). 참여자 화면의 투명 버튼이 이 값을 그대로 쓴다.
     *
     * 예전에는 CSS가 같은 비율을 따로 적어 두었는데, 도면 쪽 BOX를 고칠 때마다
     * 버튼이 어긋났다. 좌표의 원본을 한 곳으로 모은다.
     */
    /** 바깥이 알아야 하는 것 전부 —— 버튼 좌표와, 도면 가구가 오른쪽 단을 쓰는지. */
    geometry() {
      return { ...this.zoneRects(), side: this.notesWidth(this.w, this.h) > 0 };
    }

    zoneRects() {
      const DW = this.dw;
      const H = this.h;
      const top = H * this.boxTop;
      const height = H * (this.boxBot - this.boxTop);
      return {
        O: { left: DW * BOX.oL, top, width: DW * (BOX.oR - BOX.oL), height },
        X: { left: DW * BOX.xL, top, width: DW * (BOX.xR - BOX.xL), height },
      };
    }

    destroy() {
      this.stop();
      window.removeEventListener('resize', this._onResize);
      if (this._ro) { this._ro.disconnect(); this._ro = null; }
    }

    /**
     * 선화는 저해상도 버퍼를 쓰지 않는다.
     *
     * 픽셀아트였을 때는 일부러 해상도를 낮추고 정수배로 확대했지만, 도면은 정반대다.
     * 가는 선 한 줄이 정확히 1px로 앉아야 인쇄물처럼 보인다. 그래서 화면 해상도 그대로
     * 그리고, 좌표는 px() 로 반 픽셀 격자에 맞춘다.
     */
    resize() {
      const r = this.canvas.getBoundingClientRect();
      this.dpr = Math.min(2, window.devicePixelRatio || 1);
      this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
      this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
      this.w = r.width;
      this.h = r.height;

      // 비율이 바뀌면 다른 원본이 필요할 수 있다. 세로 화면에 가로 사진을 쓰면
      // 도시가 다 잘려나간다.
      if (this.backdrop) this.pickBackdropSource();
      this.layout();
      // 아직 군중이 없으면 layout()이 그냥 돌아온다. 그래도 상자 좌표는 정해졌으므로
      // 버튼은 지금 맞춰 둔다 —— 대기실에서 문항으로 넘어가는 첫 프레임을 위해서다.
      if (this.onGeometry) this.onGeometry(this.geometry());
    }

    pickBackdropSource() {
      const bd = this.backdrop;
      bd.load(this.w / Math.max(1, this.h)).then((ok) => {
        if (!ok || this.backdrop !== bd) return;
        const stand = bd.stand();
        if (typeof stand === 'number') this.roofStand = stand;
        this.layout();
      });
    }

    // ── 데이터 ────────────────────────────────────────────────

    setCrowd(crowd) {
      if (!crowd || !crowd.n) return;
      this.divisions = crowd.divisions || [];
      this.n = crowd.n;
      this.people = new Array(crowd.n);
      for (let i = 0; i < crowd.n; i += 1) {
        this.people[i] = {
          i,
          div: Number(crowd.div[i]) || 0,
          flag: crowd.flags[i] || '.',
          alive: true,
          choice: null,
          decided: false,
          x: 0, y: 0, tx: 0, ty: 0,
          fade: 1,
          seed: ((i * 2654435761) % 997) / 997,
        };
      }
      this.layout(true);
    }

    setState(s) {
      this.phase = s.phase;
      this.alive = s.alive ?? this.alive;
      this.named = s.named || null;

      // ?scene= 픽스처로 장면을 고정한 상태면 서버 값으로 덮어쓰지 않는다.
      // 우승 장면이 떠 있는 동안에는 서버가 보내는 게임장 배경으로 되돌리지 않는다.
      if (!this.sceneLocked && s.scene && this.championIndex === null) this.toScene(s.scene);
      if (s.aliveMask) this.applyAlive(s.aliveMask);

      // 새 문항이 시작되면 살아남은 사람들이 다시 아래 중앙으로 모인다.
      // 서든데스도 마찬가지다 —— 직전 정답 공개의 도장·사선이 남아 있으면 안 된다.
      if (s.phase === 'question' || s.phase === 'sudden') {
        this.revealSide = null;
        for (const p of this.people) { p.choice = null; p.decided = false; }
      }
      this.layout();
    }

    setMyIndex(i) { this.myIndex = i; }

    /** 이름표에 쓸 내 이름. 없으면 그냥 '나'로 적는다. */
    setMyName(name) { this.myName = name || null; }

    /**
     * 옥상 배경 사진을 건다. 없으면 절차적 옥상이 그대로 쓰인다.
     * 원본이 선언한 난간선(edge)에 맞춰 우승자가 설 자리도 따라 움직인다.
     */
    setBackdrop(cfg) {
      if (!global.RoofBackdrop || !cfg || cfg.enabled === false) return;
      this.backdrop = new global.RoofBackdrop(cfg);
      this.pickBackdropSource();
    }

    /** 장면 전환. 넘어오는 동안만 이전 장면이 남고, 끝나면 새 장면만 그린다. */
    toScene(name) {
      if (!name || !SCENES[name] || name === this.scene) return;
      this.prevScene = this.scene;
      this.scene = name;
      this.sceneT = 0;
    }

    /**
     * 우승 장면. 챔피언 혼자 옥상에 서서 도시를 내려다본다.
     * 몇 층에서 이겼든 마지막은 옥상이다.
     *
     * 결과 단계 내내 매 틱 불릴 수 있으므로 같은 값이면 아무것도 하지 않는다.
     * 그러지 않으면 전환이 계속 처음부터 다시 시작돼 장면이 영영 도착하지 못한다.
     */
    setChampion(ci) {
      const next = typeof ci === 'number' ? ci : null;
      if (next === this.championIndex) return;
      this.championIndex = next;
      if (next !== null && !this.sceneLocked) this.toScene('rooftop');
      this.layout();
    }

    clearChampion() {
      if (this.championIndex === null) return;
      this.championIndex = null;
      // 다음 회차는 옥상에서 시작하지 않는다. 게임장으로 돌려놓는다.
      if (!this.sceneLocked && this.scene === 'rooftop') this.toScene('ground');
      this.layout();
    }

    applyAlive(mask) {
      for (let i = 0; i < this.people.length && i < mask.length; i += 1) {
        this.people[i].alive = mask[i] === '1';
      }
    }

    applyChoices(mask) {
      if (!mask) return;
      for (let i = 0; i < this.people.length && i < mask.length; i += 1) {
        const ch = mask[i];
        const p = this.people[i];
        p.choice = ch === 'O' || ch === 'X' ? ch : null;
        p.decided = !!p.choice;
      }
      this.layout();
    }

    applyDecided(mask) {
      if (!mask) return;
      for (let i = 0; i < this.people.length && i < mask.length; i += 1) {
        this.people[i].decided = mask[i] === '1';
      }
    }

    applyReveal(reveal) {
      if (!reveal) return;
      this.revealSide = reveal.answer;
      if (reveal.choices) {
        for (let i = 0; i < this.people.length && i < reveal.choices.length; i += 1) {
          const ch = reveal.choices[i];
          if (ch === 'O' || ch === 'X') { this.people[i].choice = ch; this.people[i].decided = true; }
        }
      }
      this.layout();
    }

    // ── 배치 ──────────────────────────────────────────────────
    //
    // 화면 좌표로 직접 잡는다. 아래 중앙이 집이고, 위쪽 두 발판이 목적지다.
    // 뒷줄은 화면 밖 아래로 넘쳐도 상관없다.

    layout(snap = false) {
      const W = this.dw;   // 오른쪽 가구 단을 뺀 도면 폭
      const H = this.h;
      if (W < 8 || H < 8 || !this.people.length) return;

      // 폰은 화면이 작으니 사람을 더 크게 잡고 그만큼 더 많이 화면 밖으로 넘긴다
      const r = radiusFor(this.alive || this.n, H, this.compact ? 0.032 : 0.020);
      const gap = r * 2.7;

      // 우승 장면 — 챔피언만 옥상 바닥에 서고 나머지는 아래로 물러난다.
      // 발은 난간 안쪽(ROOF_STAND)에 두되 상반신은 난간선 위로 올라가야 한다.
      // 그래야 도시를 등지고 내려다보는 그림이 된다.
      if (this.championIndex !== null) {
        for (const p of this.people) {
          if (p.i === this.championIndex) {
            p.tx = W / 2;
            p.ty = this.scene === 'rooftop' ? H * this.roofStand : H * 0.72;
          } else {
            p.ty = H * 1.4;
            p.alive = false;
          }
        }
        this.r = r;
        return;
      }

      const zones = { O: [], X: [], home: [] };
      const gone = [];
      for (const p of this.people) {
        if (!p.alive) { gone.push(p); continue; }
        // 정답 공개 뒤에는 살아남은 사람이 대기 구역으로 내려온다
        if (this.revealSide) zones.home.push(p);
        else if (p.choice === 'O') zones.O.push(p);
        else if (p.choice === 'X') zones.X.push(p);
        else zones.home.push(p);
      }

      const place = (list, cx, topY, width, tight = 1) => {
        const g = gap * tight;
        const cols = Math.max(1, Math.floor((W * width) / g));
        list.forEach((p, idx) => {
          const col = idx % cols;
          const row = Math.floor(idx / cols);
          const rowCount = Math.min(cols, list.length - row * cols);
          const rowW = (rowCount - 1) * g;
          // 줄마다 살짝 어긋나게 두면 격자처럼 보이지 않는다
          const jitter = (p.seed - 0.5) * g * 0.35;
          p.tx = cx - rowW / 2 + col * g + jitter;
          p.ty = topY + row * g * 0.72 + (p.seed - 0.5) * g * 0.18;
        });
      };

      /**
       * 구역 상자 안에 줄지어 세운다.
       *
       * 첫 줄이 윗변에 너무 붙으면 머리와 왕관·새싹이 상자 밖으로 삐져나가, 지시선이
       * 물고 있는 그 변을 사람이 지워 버린다. 도면부호가 어느 상자를 가리키는지가
       * 안 보이게 되므로 한 줄 몫을 더 내려 세운다.
       */
      const placeBox = (list, L, R, topY) => {
        const g = gap * 0.8;
        const cols = Math.max(1, Math.floor((R - L - g) / g));
        list.forEach((p, idx) => {
          const col = idx % cols;
          const row = Math.floor(idx / cols);
          const rowCount = Math.min(cols, list.length - row * cols);
          const rowW = (rowCount - 1) * g;
          const jitter = (p.seed - 0.5) * g * 0.35;
          p.tx = (L + R) / 2 - rowW / 2 + col * g + jitter;
          p.ty = topY + gap * 2.0 + row * g * 0.8 + (p.seed - 0.5) * g * 0.18;
        });
      };
      place(zones.home, W / 2, H * this.homeY, HOME_W);
      placeBox(zones.O, W * BOX.oL, W * BOX.oR, H * this.boxTop);
      placeBox(zones.X, W * BOX.xL, W * BOX.xR, H * this.boxTop);

      // 남겨진 사람들은 아래로 흘러 사라진다
      for (const p of gone) { p.ty = Math.max(p.ty, H * 0.95) + H * 0.5; }

      if (snap) for (const p of this.people) { p.x = p.tx; p.y = p.ty; }
      this.r = r;
      if (this.onGeometry) this.onGeometry(this.geometry());
    }

    // ── 루프 ──────────────────────────────────────────────────

    start() { if (!this.raf) this.raf = requestAnimationFrame(this.frame.bind(this)); }
    stop() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = null; }

    frame(now) {
      this.raf = requestAnimationFrame(this.frame.bind(this));
      this.update();
      this.draw(now);
    }

    update() {
      if (this.sceneT < 1) {
        this.sceneT = Math.min(1, this.sceneT + 0.02);
        if (this.sceneT >= 1) this.prevScene = null;   // 다 넘어왔으면 이전 장면은 버린다
      }

      for (const p of this.people) {
        // 달려가는 속도. 멀수록 빨리 움직여 모두 비슷한 시간에 도착한다.
        const k = p.alive ? 0.11 : 0.06;
        p.x = lerp(p.x, p.tx, k);
        p.y = lerp(p.y, p.ty, k);
        p.fade = lerp(p.fade, p.alive ? 1 : 0, p.alive ? 0.12 : 0.05);
      }
    }

    draw(now) {
      const t = now - this.t0;
      const W = this.w;
      const H = this.h;
      if (W < 8 || H < 8) return;

      const c = this.ctx;
      c.save();
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

      const sc = SCENES[this.scene] || SCENES.lobby;
      const from = this.sceneT < 1 ? SCENES[this.prevScene] : null;

      // 배경 — 넘어오는 동안에만 이전 장면을 깔고 그 위로 새 장면을 띄운다.
      // 바닥에 깔아야 하는 건 어디까지나 '지금' 장면이다.
      if (from) {
        this.paintScene(c, from, W, H, t);
        c.globalAlpha = this.sceneT;
        this.paintScene(c, sc, W, H, t);
        c.globalAlpha = 1;
      } else {
        this.paintScene(c, sc, W, H, t);
      }

      // 우승 장면에는 O·X 발판이 없다. 게임은 이미 끝났다.
      const champScene = this.championIndex !== null;
      const DW = this.dw;
      if (this.showZones && !champScene) this.drawZones(c, DW, H, sc);
      this.drawPeople(c, t);
      if (this.showZones) this.drawSheetFurniture(c, W, DW, H, sc, champScene);

      c.restore();
    }

    /** 도면 한 장. 용지를 깔고 테두리를 두른 뒤 그림을 그린다. */
    paintScene(c, sc, W, H, t) {
      c.fillStyle = P.paper;
      c.fillRect(0, 0, W, H);

      // 도면 테두리 두 겹. 바깥은 옅고 안쪽이 실선이다.
      const m = Math.max(5, Math.round(Math.min(W, H) * 0.022));
      c.strokeStyle = P.rule;
      c.lineWidth = 1;
      c.strokeRect(px(m * 0.55), px(m * 0.55), Math.round(W - m * 1.1), Math.round(H - m * 1.1));
      c.strokeStyle = P.ink;
      c.lineWidth = 0.9;
      c.strokeRect(px(m), px(m), Math.round(W - m * 2), Math.round(H - m * 2));

      // 게임장 그림은 도면 폭 안에서 끝난다. 옥상은 화면을 꽉 채운다.
      sc.draw(c, sc === SCENES.ground ? this.dw : W, H, t, this);
    }

    /**
     * O / X 구역 — 게임장의 두 상자.
     *
     * 참여자 화면에서는 이 상자 위에 투명 버튼이 겹친다. 구역이 곧 버튼이다.
     * 정답이 공개되면 색이 아니라 판정이 찍힌다 —— 맞은 구역에는 등록 도장,
     * 틀린 구역은 사선으로 지워진다. 인주가 등장하는 유일한 순간이고, 그 색이 곧 결과다.
     */
    drawZones(c, W, H, sc) {
      // 서든데스는 O·X가 아니라 숫자 입력이다. 구역 상자는 윤곽만 남기고,
      // 무엇을 해야 하는지를 인주색으로 크게 적는다. 판정의 색이 곧 지시가 된다.
      /* 서든데스는 O·X가 아니라 숫자 입력이다.
       *
       * 두 구역을 하나로 합쳐 입력 칸의 자리를 만든다 —— 판을 치우지 않는 것이 요점이다.
       * 마지막 문항에서 게임장이 사라지면 그 순간만 다른 게임처럼 보인다. 여기 그려진
       * 상자 위에 실제 입력 칸이 그대로 얹힌다(app.js가 zoneRects로 자리를 맞춘다). */
      if (this.phase === 'sudden') {
        const T = H * this.boxTop;
        const B = H * this.boxBot;
        const L = W * BOX.oL;
        const R = W * BOX.xR;
        c.fillStyle = P.paper;
        c.fillRect(Math.round(L), Math.round(T), Math.round(R - L), Math.round(B - T));
        hatch(c, L + 1, T + 1, R - L - 2, B - T - 2, 9, 0.07, 1);
        c.strokeStyle = P.ink;
        c.lineWidth = 1.6;
        c.strokeRect(px(L), px(T), Math.round(R - L), Math.round(B - T));

        // 라벨은 상자 '안'의 윗머리에 둔다. 밖에 두면 【도 N】 캡션과 같은 줄에서 겹친다.
        // 가운데는 입력 칸이 차지하므로 .sudden-pad가 그만큼 위를 비워 둔다.
        c.fillStyle = P.seal;
        c.textAlign = 'center';
        c.textBaseline = 'top';
        c.font = `700 ${Math.round(clamp(H * 0.042, 11, 26))}px "Nanum Myeongjo", Batang, 바탕, serif`;
        c.fillText('숫 자  입 력', (L + R) / 2, T + H * 0.018);
        return;
      }

      // 도장이 언제 찍혔는지 —— 눌렸다 떨어지는 맛을 주려고 잰다
      if (this.revealSide && this.sealAt === null) this.sealAt = performance.now();
      if (!this.revealSide) this.sealAt = null;
      const since = this.sealAt === null ? undefined : performance.now() - this.sealAt;

      for (const side of ['O', 'X']) {
        const L = W * (side === 'O' ? BOX.oL : BOX.xL);
        const R = W * (side === 'O' ? BOX.oR : BOX.xR);
        const T = H * this.boxTop;
        const B = H * this.boxBot;
        const hit = this.revealSide === side;
        const miss = this.revealSide && !hit;
        const cx = (L + R) / 2;

        // 상자. 면은 해칭, 윤곽은 실선 —— 도면의 문법 그대로.
        // 해칭 방향을 좌우 반대로 두면 두 구역이 같은 무늬로 붙어 보이지 않는다.
        c.fillStyle = P.paper;
        c.fillRect(Math.round(L), Math.round(T), Math.round(R - L), Math.round(B - T));
        hatch(c, L + 1, T + 1, R - L - 2, B - T - 2, 9, miss ? 0.05 : 0.11, side === 'O' ? 1 : -1);
        c.strokeStyle = P.ink;
        c.lineWidth = hit ? 2.4 : 1.2;
        c.strokeRect(px(L), px(T), Math.round(R - L), Math.round(B - T));

        // 글자는 상자 가운데 크게, 옅게. 사람들이 그 위에 서므로 바닥 무늬처럼 깔린다.
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.font = `400 ${Math.round(clamp((B - T) * 0.55, 22, 220))}px "Nanum Myeongjo", Batang, 바탕, serif`;
        c.fillStyle = miss ? 'rgba(20,20,20,.08)' : 'rgba(20,20,20,.20)';
        c.fillText(side, cx, (T + B) / 2 + (B - T) * 0.03);

        if (miss) {
          // 거절 —— 상자를 사선으로 지운다
          c.strokeStyle = P.seal;
          c.lineWidth = Math.max(1.5, H * 0.006);
          c.beginPath();
          c.moveTo(px(L + (R - L) * 0.05), px(B - (B - T) * 0.07));
          c.lineTo(px(R - (R - L) * 0.05), px(T + (B - T) * 0.07));
          c.stroke();
        } else if (hit) {
          seal(c, R - (R - L) * 0.15, T + (B - T) * 0.22, Math.max(10, H * 0.055), '登', since);
        }
      }
    }

    drawPeople(c, t) {
      const tier = tierFor(this.alive || this.n);
      const pendingLabels = [];
      const baseR = this.r || radiusFor(this.alive || this.n, this.h, this.compact ? 0.032 : 0.020);
      const namedMap = this.named ? new Map(this.named.map((x) => [x.i, x])) : null;

      const champ = this.championIndex;

      for (const p of this.people) {
        if (champ !== null && p.i !== champ) continue;
        if (p.fade < 0.03) continue;
        if (p.y > this.h * 1.15 && !p.alive) continue;
        // 점 대신 사람을 그리게 되면서 한 명당 비용이 올랐다. 화면 아래로 넘친 뒷줄은
        // 어차피 보이지 않으므로 그리지 않는다 —— 400명 회차의 프레임을 지키는 값이다.
        if (p.y - baseR * 4.5 > this.h) continue;

        const isChamp = p.i === champ;
        const onRoof = isChamp && this.scene === 'rooftop';
        const r = isChamp ? Math.max(baseR, this.h * (onRoof ? ROOF_R : 0.105)) : baseR;
        // 소속색은 서버 명부(data/employees.json)가 원본이다. DIV_TINT는 못 받았을 때의 대비책.
        const tint = (this.divisions[p.div] && this.divisions[p.div].color) || DIV_TINT[p.div % DIV_TINT.length];
        c.globalAlpha = isChamp ? 1 : p.fade;

        const X = p.x;
        const Y = p.y;

        // 발밑 접지선. 도면에서 사람이 바닥에 닿아 있다는 표시는 짧은 가로선 하나면 된다.
        if (isChamp) {
          c.strokeStyle = P.ink;
          c.lineWidth = 1;
          c.beginPath();
          c.moveTo(px(X - r * 1.1), px(Y));
          c.lineTo(px(X + r * 1.1), px(Y));
          c.stroke();
          hatch(c, X - r * 1.1, Y, r * 2.2, r * 0.22, 4, 0.28, 1);
        }

        const running = Math.abs(p.y - p.ty) > r * 0.6;
        const bob = running ? Math.abs(Math.sin(t / 90 + p.seed * 6.3)) * r * 0.28 : 0;

        // 인원이 많을 때도 사람은 사람으로 그린다.
        // 예전에는 색점으로 찍었는데, 400명이 모이는 바로 그 장면에서 군중이
        // 그래프의 산점도처럼 보였다. 같은 기호를 조금 작게 그리는 편이 낫다.
        const drawR = tier <= 1 && !isChamp ? r * 0.85 : r;
        const isMe = this.myIndex === p.i && p.alive;
        this.drawPerson(c, X, Y - bob, drawR, tint, running, isMe);

        // 왕관·새싹은 머리 위에 얹는다. 옆에 두면 옆 사람 것과 헷갈린다.
        if (p.alive && drawR >= 4) {
          if (p.flag === 'v') this.drawCrown(c, X, Y - drawR * 3.5 - bob, drawR);
          else if (p.flag === 'n') this.drawSprout(c, X, Y - drawR * 3.55 - bob, drawR * 0.85);
        }

        // 방향을 감춘 구간에서는 "정했다"는 표시만 남는다. 배지보다 위로 비킨다.
        if (p.decided && !p.choice && p.alive) {
          c.strokeStyle = P.ink;
          c.lineWidth = 1;
          c.beginPath();
          c.arc(X, Y - drawR * 4.25 - bob, Math.max(1.5, drawR * 0.26), 0, 6.283);
          c.stroke();
        }

        // 본인 표시 —— 든 손끝에 붉은 별 하나.
        //
        // 사람을 통째로 두르던 인주 원은 등록 도장과 겹쳐 판정을 흐렸다.
        // 표식이 작아진 대신 자세가 다르므로(혼자 손을 들고 있다) 오히려 더 빨리 찾힌다.
        if (isMe) {
          c.globalAlpha = 1;
          const hx = X + drawR * 0.78;
          const hy = Y - drawR * 3.52 - bob;
          star(c, hx, hy, Math.max(2.4, drawR * 0.52), P.seal);
          // 한자 '本人'은 도면 관례로는 맞지만 읽는 데 한 박자가 걸렸다. 내 이름을 적는다.
          // bold —— 이름표 뒤에 용지를 깔아 준다. 군중 한가운데라 그러지 않으면 사람에 먹힌다.
          callout(c, this.myName ? `나(${this.myName})` : '나', hx + drawR * 0.35, hy,
            X + drawR * 3.2, hy - drawR * 0.5, Math.max(7, drawR * 0.85), true);
        }

        if (tier >= 3 && p.alive && namedMap) {
          const info = namedMap.get(p.i);
          if (info) pendingLabels.push({ x: X, y: Y - r * 1.9, name: tier >= 4 ? info.name : info.empId });
        }
      }
      c.globalAlpha = 1;

      /**
       * 이름표는 도면부호처럼 지시선으로 뺀다.
       *
       * 머리 위에 그대로 얹으면 대기 구역에서 서로 겹쳐 아무것도 읽을 수 없다 ——
       * 실제로 그랬다. 왼쪽 절반은 왼쪽 여백에, 오른쪽 절반은 오른쪽 여백에
       * 사다리처럼 쌓고, 각자에게서 지시선을 뻗는다. 세로 순서를 y로 맞춰
       * 지시선이 서로 교차하지 않게 한다.
       */
      if (pendingLabels.length) {
        const fs = Math.max(7, Math.min(10, baseR * 0.62));
        const step = fs * 1.7;
        const top = this.h * 0.585;
        pendingLabels.sort((a, b) => a.x - b.x);
        const halfN = Math.ceil(pendingLabels.length / 2);
        const leftG = pendingLabels.slice(0, halfN).sort((a, b) => a.y - b.y);
        const rightG = pendingLabels.slice(halfN).sort((a, b) => a.y - b.y);
        const DW = this.dw;
        leftG.forEach((L, i) => callout(c, L.name, L.x - baseR * 0.5, L.y, DW * 0.155, top + i * step, fs));
        rightG.forEach((L, i) => callout(c, L.name, L.x + baseR * 0.5, L.y, DW * 0.845, top + i * step, fs));
      }
    }

    /**
     * 인물 기호.
     *
     * 도면 속 사람은 사진이 아니라 기호다. 윤곽선으로 형태를 정하고 안쪽을 소속색으로
     * 아주 옅게만 채운다. 색이 선을 이기면 그 순간 도면이 아니라 삽화가 된다.
     */
    drawPerson(c, x, y, r, tint, running, raise) {
      c.lineWidth = Math.max(0.7, r * 0.11);
      c.strokeStyle = P.ink;
      c.lineJoin = 'round';
      c.lineCap = 'round';

      const HIP = y - r * 1.15;
      const SHO = y - r * 2.12;   // 어깨선
      const NECK = y - r * 2.28;

      // ── 다리. 허벅지에서 무릎을 한 번 꺾는다. 곧은 작대기 두 개보다 훨씬 사람이다.
      c.beginPath();
      if (running) {
        c.moveTo(x - r * 0.10, HIP); c.lineTo(x - r * 0.40, y - r * 0.62); c.lineTo(x - r * 0.58, y);
        c.moveTo(x + r * 0.10, HIP); c.lineTo(x + r * 0.42, y - r * 0.66); c.lineTo(x + r * 0.30, y - r * 0.24);
      } else {
        c.moveTo(x - r * 0.12, HIP); c.lineTo(x - r * 0.24, y - r * 0.58); c.lineTo(x - r * 0.28, y);
        c.moveTo(x + r * 0.12, HIP); c.lineTo(x + r * 0.24, y - r * 0.58); c.lineTo(x + r * 0.28, y);
      }
      c.stroke();

      // ── 팔. 어깨에서 팔꿈치를 지나 손까지. 팔이 없으면 사람이 아니라 표지판이다.
      c.beginPath();
      if (raise) {
        // 오른팔을 곧게 든다. 손끝이 머리보다 위로 올라가야 '들었다'로 읽힌다.
        c.moveTo(x - r * 0.50, SHO + r * 0.06); c.lineTo(x - r * 0.64, y - r * 1.70); c.lineTo(x - r * 0.60, y - r * 1.22);
        c.moveTo(x + r * 0.48, SHO + r * 0.04); c.lineTo(x + r * 0.80, y - r * 2.62); c.lineTo(x + r * 0.78, y - r * 3.42);
      } else if (running) {
        c.moveTo(x - r * 0.48, SHO + r * 0.06); c.lineTo(x - r * 0.74, y - r * 1.72); c.lineTo(x - r * 0.60, y - r * 1.22);
        c.moveTo(x + r * 0.48, SHO + r * 0.06); c.lineTo(x + r * 0.70, y - r * 1.86); c.lineTo(x + r * 0.86, y - r * 2.34);
      } else {
        c.moveTo(x - r * 0.50, SHO + r * 0.06); c.lineTo(x - r * 0.64, y - r * 1.70); c.lineTo(x - r * 0.60, y - r * 1.22);
        c.moveTo(x + r * 0.50, SHO + r * 0.06); c.lineTo(x + r * 0.64, y - r * 1.70); c.lineTo(x + r * 0.60, y - r * 1.22);
      }
      c.stroke();

      // ── 몸통. 어깨가 넓고 허리가 잘록하다 —— 사다리꼴 상자와 사람을 가르는 것이 이 곡선이다.
      const WAIST = y - r * 1.58;
      c.beginPath();
      c.moveTo(x - r * 0.46, HIP);
      c.bezierCurveTo(x - r * 0.40, WAIST, x - r * 0.50, SHO + r * 0.16, x - r * 0.46, SHO);
      c.quadraticCurveTo(x, SHO - r * 0.16, x + r * 0.46, SHO);          // 어깨선은 살짝 솟는다
      c.bezierCurveTo(x + r * 0.50, SHO + r * 0.16, x + r * 0.40, WAIST, x + r * 0.46, HIP);
      c.closePath();
      c.fillStyle = tint;
      const a0 = c.globalAlpha;
      c.globalAlpha = a0 * TINT_ALPHA;
      c.fill();
      c.globalAlpha = a0;
      c.stroke();

      // ── 목
      c.beginPath();
      c.moveTo(x, SHO); c.lineTo(x, NECK);
      c.stroke();

      // ── 머리. 살짝 세로로 긴 타원 —— 정원은 사람보다 기호에 가깝다.
      // 얼굴은 여전히 그리지 않는다. 도면의 인물에게 표정은 없다.
      c.beginPath();
      c.ellipse(x, y - r * 2.66, r * 0.44, r * 0.52, 0, 0, 6.283);
      c.fillStyle = P.paper;
      c.fill();
      c.stroke();
    }

    /** VIP 왕관 */
    drawCrown(c, x, y, r) {
      c.strokeStyle = P.ink;
      c.lineWidth = Math.max(0.7, r * 0.1);
      c.beginPath();
      c.moveTo(x - r * 0.6, y + r * 0.3);
      c.lineTo(x - r * 0.6, y - r * 0.35);
      c.lineTo(x - r * 0.25, y + r * 0.02);
      c.lineTo(x, y - r * 0.5);
      c.lineTo(x + r * 0.25, y + r * 0.02);
      c.lineTo(x + r * 0.6, y - r * 0.35);
      c.lineTo(x + r * 0.6, y + r * 0.3);
      c.closePath();
      c.stroke();
    }

    /**
     * 신입 새싹.
     *
     * 예전에는 줄기에서 직선 두 개가 뻗은 모양이었는데, 머리에 나뭇가지를 꽂은 것처럼 보였다.
     * 잎은 직선이 아니라 두 개의 곡선이 만나 감기는 면이다 —— 잎맥까지 그어야 싹으로 읽힌다.
     */
    drawSprout(c, x, y, r) {
      const w = Math.max(0.6, r * 0.09);
      c.strokeStyle = P.sprout;
      c.lineWidth = w;
      c.lineJoin = 'round';
      c.lineCap = 'round';

      // 줄기 — 곧게 서지 않고 살짝 휜다
      c.beginPath();
      c.moveTo(x, y + r * 0.58);
      c.quadraticCurveTo(x - r * 0.06, y + r * 0.05, x, y - r * 0.34);
      c.stroke();

      // 잎 두 장. 밑동에서 나와 바깥으로 감겨 올라간다.
      const leaf = (dir) => {
        c.beginPath();
        c.moveTo(x, y - r * 0.06);
        c.bezierCurveTo(
          x + dir * r * 0.30, y - r * 0.52,
          x + dir * r * 0.62, y - r * 0.44,
          x + dir * r * 0.56, y - r * 0.12,
        );
        c.bezierCurveTo(
          x + dir * r * 0.44, y + r * 0.06,
          x + dir * r * 0.18, y + r * 0.06,
          x, y - r * 0.06,
        );
        c.closePath();
        // 잎은 옅은 녹색으로 채운다. 윤곽만 녹색이면 작은 크기에서 색이 안 보인다.
        c.fillStyle = P.sproutFill;
        c.fill();
        c.stroke();
        // 잎맥 — 이 한 줄이 잎과 물방울을 가른다
        if (r >= 7) {
          c.beginPath();
          c.moveTo(x + dir * r * 0.06, y - r * 0.06);
          c.quadraticCurveTo(x + dir * r * 0.32, y - r * 0.26, x + dir * r * 0.50, y - r * 0.18);
          c.lineWidth = w * 0.7;
          c.stroke();
          c.lineWidth = w;
        }
      };
      leaf(-1);
      leaf(1);
    }

    /**
     * 범례 —— 「부호의 설명」 바로 아래에 잇는다.
     *
     * 표식은 글로 적지 않고 화면에 그려지는 그 기호를 그대로 축소해 찍는다.
     * 왕관·새싹·별을 말로 설명하면 눈이 한 번 더 왕복해야 한다.
     * 본부색은 사람 몸통에 칠해지는 색을 그대로 네모로 낸다.
     */
    drawLegend(c, x, w, y0, cs) {
      if (!y0 || y0 > this.h - cs * 3) return;
      // 글자를 단 폭에 맞춘다. 「2년차 미만 · 부활권」이 제일 길어서, 고정 크기로 두면
      // 그 줄만 도면 밖으로 흘러 잘렸다 —— 실제로 그랬다. 가장 긴 줄을 재서 맞춘다.
      const LINES = [
        ['crown', '스페셜 게스트'],
        ['sprout', '2년차 미만 · 부활권'],
        ['star', '나 (본인)'],
      ];
      let fs = Math.max(7, cs * 0.78);
      c.font = `${fs}px ui-monospace, monospace`;
      const longest = Math.max(...LINES.map(([, t]) => c.measureText(t).width));
      const avail = w - fs * 1.8;
      if (longest > avail) fs = Math.max(6, fs * (avail / longest));

      const row = fs * 1.85;
      const ic = fs * 0.62;          // 기호를 그릴 때 쓰는 반지름
      let y = y0;

      c.strokeStyle = P.rule;
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(px(x), px(y - fs * 0.9));
      c.lineTo(px(x + w), px(y - fs * 0.9));
      c.stroke();

      c.textAlign = 'left';
      c.textBaseline = 'middle';

      const line = (glyph, text) => {
        if (y > this.h - cs * 1.2) return;
        glyph(x + ic * 1.2, y);
        c.fillStyle = P.ink;
        c.font = `${fs}px ui-monospace, monospace`;
        c.fillText(text, x + ic * 2.9, y);
        y += row;
      };

      const GLYPH = {
        crown: (gx, gy) => this.drawCrown(c, gx, gy, ic),
        sprout: (gx, gy) => this.drawSprout(c, gx, gy, ic),
        star: (gx, gy) => star(c, gx, gy, ic * 0.8, P.seal),
      };
      for (const [g, text] of LINES) line(GLYPH[g], text);

      // 본부색 —— 게스트는 본부가 아니므로 뺀다. 그 표식은 위의 왕관이다.
      const divs = (this.divisions || []).filter((d) => d.id !== 'guest' && d.color);
      if (!divs.length) return;
      y += fs * 0.35;
      const sw = fs * 0.95;
      const colW = w / 2;
      divs.forEach((d, i) => {
        const cx = x + (i % 2) * colW;
        const cy = y + Math.floor(i / 2) * (fs * 1.55);
        if (cy > this.h - cs * 1.1) return;
        c.fillStyle = d.color;
        c.fillRect(Math.round(cx), Math.round(cy - sw / 2), Math.round(sw), Math.round(sw));
        c.strokeStyle = P.ink;
        c.lineWidth = 0.8;
        c.strokeRect(px(cx), px(cy - sw / 2), Math.round(sw), Math.round(sw));
        c.fillStyle = P.mid;
        c.font = `${fs * 0.92}px ui-monospace, monospace`;
        c.fillText(d.short || d.name, cx + sw * 1.5, cy);
      });
    }

    /**
     * 도면 가구 — 캡션, 부호의 설명, 지시선, 쪽번호.
     *
     * 상자와 사람만 있으면 그냥 다이어그램이다. 【도 N】 캡션과 숫자 부호,
     * 지시선, 부호의 설명이 붙어야 명세서의 도면이 된다.
     *
     * 부호는 허공에 떠 있지 않다. 「10 : O 구역」이라고 적힌 바로 그 숫자에서
     * 선이 뻗어 나가 실제 구역을 문다 —— 읽는 줄과 가리키는 자리가 한 몸이라야
     * 도면을 처음 보는 사람도 어느 것이 무엇인지 되짚을 필요가 없다.
     *
     * W는 캔버스 전체 폭, DW는 그림이 쓰는 폭이다. 둘이 다르면 그 사이가
     * 가구를 담는 오른쪽 단이 된다(PC 가로 화면).
     */
    drawSheetFurniture(c, W, DW, H, sc, champScene) {
      const s = Math.max(7, Math.round(Math.min(DW, H) * 0.045));
      const m = Math.max(5, Math.round(Math.min(W, H) * 0.022));
      const side = W - DW > 8;          // 오른쪽 단을 쓰는가
      const colL = DW + m * 0.6;        // 그 단의 왼쪽 끝

      // 캡션은 언제나 도면 왼쪽 위다. 공보의 도면은 예외 없이 거기서 시작한다 ——
      // 오른쪽 단으로 옮겨 봤더니 그림이 어디서 시작하는지가 흐려졌다.
      c.textAlign = 'left';
      c.textBaseline = 'top';
      c.fillStyle = P.ink;
      c.font = `500 ${s}px "Nanum Myeongjo", Batang, 바탕, serif`;
      const capX = m + s * 0.5;
      const head = `【도 ${sc.no}】`;
      c.fillText(head, capX, m + s * 0.35);
      c.fillText(sc.caption, capX + c.measureText(head).width + s * 0.55, m + s * 0.35);

      if (side) {
        // 단을 그림에서 갈라 주는 세로 괘선. 공보의 단 구분선과 같은 굵기다.
        c.strokeStyle = P.rule;
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(px(DW), px(m));
        c.lineTo(px(DW), px(H - m));
        c.stroke();
      }

      // 쪽번호 — 공보는 늘 아래에 - N - 이 있다
      c.textAlign = side ? 'left' : 'center';
      c.textBaseline = 'bottom';
      c.fillStyle = P.mid;
      c.font = `${Math.max(6, s * 0.75)}px ui-monospace, monospace`;
      c.fillText(`- ${sc.no} -`, side ? colL : DW / 2, H - m - 2);

      if (champScene || this.scene !== 'ground') return;

      /* 부호의 설명. 여기 적힌 숫자가 곧 지시선의 출발점이다.
       *
       * 세로 화면에서는 도면 아래 한 줄로 눕고, 가로 화면에서는 오른쪽 단에
       * 한 항목씩 쌓인다. 어느 쪽이든 숫자의 위치를 재서 그 자리에서 선을 뻗는다. */
      const cs = Math.max(8, Math.round(Math.min(DW, H) * (side ? 0.038 : 0.042)));
      const B = H * this.boxBot;

      // 뒤에서 후반부에는 개인 이름표 지시선이 대기 구역 옆을 쓴다. 그때는 30을 접는다.
      const showHome = tierFor(this.alive || this.n) < 3;
      /* 목표점은 왼쪽에서 오른쪽으로 흐르게 잡는다.
       *
       * 부호의 설명은 10·20·30 차례로 적히므로 출발점도 그 순서로 놓인다. 목표가
       * 그 순서를 거스르면 지시선끼리 X자로 엇갈려 어느 선이 어디로 가는지 못 읽는다.
       * 30이 대기 구역의 오른쪽을 무는 것은 그래서다 —— 구역 어디를 물어도 뜻은 같다. */
      // 서든데스에는 O·X 구역이 없다. 그 자리를 덮은 입력 칸 하나만 가리킨다.
      const marks = this.phase === 'sudden'
        ? [{ no: '10', name: '숫자 입력 칸', tx: DW * (BOX.oL + 0.10), ty: B }]
        : [
          { no: '10', name: 'O 구역', tx: DW * (BOX.oL + 0.10), ty: B },
          { no: '20', name: 'X 구역', tx: DW * (BOX.xR - 0.10), ty: B },
        ];
      if (showHome) marks.push({ no: '30', name: '출발선', tx: DW * 0.86, ty: H * this.startY });

      c.font = `700 ${cs}px ui-monospace, monospace`;
      const numW = c.measureText('00').width;
      const anchors = [];
      let legendTop = 0;

      if (side) {
        // 오른쪽 단 — 한 줄에 한 항목. 숫자 왼쪽 변에서 선이 나간다.
        let y = m + s * 1.2;
        for (const mk of marks) {
          c.textAlign = 'left';
          c.textBaseline = 'middle';
          c.fillStyle = P.ink;
          c.font = `700 ${cs}px ui-monospace, monospace`;
          c.fillText(mk.no, colL, y);
          c.font = `${Math.max(7, cs * 0.86)}px ui-monospace, monospace`;
          c.fillStyle = P.mid;
          c.fillText(`: ${mk.name}`, colL + numW * 1.35, y);
          anchors.push({ mk, x: colL - cs * 0.28, y });
          y += cs * 1.9;
        }
        legendTop = y + cs * 1.1;
      } else {
        // 세로 화면 — 도면 아래 한 줄. 쪽번호와 겹치지 않게 한 줄 위에 앉힌다.
        const ms = Math.max(7, cs * 0.8);
        const baseY = H - m - 2 - ms * 1.6;
        let x = m + s * 0.5;
        for (const mk of marks) {
          c.textAlign = 'left';
          c.textBaseline = 'alphabetic';
          c.fillStyle = P.ink;
          c.font = `700 ${ms}px ui-monospace, monospace`;
          c.fillText(mk.no, x, baseY);
          const nw = c.measureText(mk.no).width;
          anchors.push({ mk, x: x + nw / 2, y: baseY - ms * 1.05 });
          c.font = `${ms}px ui-monospace, monospace`;
          c.fillStyle = P.mid;
          const tail = ` : ${mk.name}`;
          c.fillText(tail, x + nw, baseY);
          x += nw + c.measureText(tail).width + ms * 1.1;
        }
      }

      // 부호의 설명 바로 아래가 범례의 자리다. 오른쪽 단이 있을 때만 —— 세로 화면에서는
      // 화면 위쪽의 HTML 범례가 그 몫을 한다(app.js가 어느 쪽인지 알려 준다).
      if (side) this.drawLegend(c, colL, W - colL - m * 0.6, legendTop, cs);

      // 지시선 —— 적힌 숫자에서 가리키는 자리까지. 끝에 점을 찍는다.
      for (const a of anchors) {
        c.strokeStyle = P.ink;
        c.lineWidth = 1.3;
        c.beginPath();
        c.moveTo(px(a.x), px(a.y));
        c.lineTo(px(a.mk.tx), px(a.mk.ty));
        c.stroke();
        c.fillStyle = P.ink;
        c.beginPath();
        c.arc(a.mk.tx, a.mk.ty, Math.max(2, cs * 0.2), 0, 6.283);
        c.fill();
      }
    }
  }

  global.CrowdStage = CrowdStage;
  global.CROWD_SCENES = SCENES;
  global.CROWD_PALETTE = P;
  global.crowdHatch = hatch;
  global.crowdSeal = seal;
  global.crowdCallout = callout;
  // 인물 기호. drawPerson은 this를 쓰지 않으므로 그대로 떼어 쓴다.
  global.crowdDrawPerson = CrowdStage.prototype.drawPerson;
  global.CROWD_DIV_TINT = DIV_TINT;

  /** 엔딩 카드가 같은 옥상을 그리려고 쓴다. 두 곳에 같은 그림을 두지 않으려는 것. */
  global.paintCrowdScene = (c, name, W, H, t, stage) => {
    const sc = SCENES[name] || SCENES.lobby;
    c.fillStyle = P.paper;
    c.fillRect(0, 0, W, H);
    sc.draw(c, W, H, t, stage);
  };
  // 옥상 구도. roof-lab.html이 사진의 난간선을 여기에 맞추려고 읽는다.
  global.ROOF_GEOMETRY = { sky: ROOF_SKY, edge: ROOF_EDGE, deck: ROOF_DECK, stand: ROOF_STAND };
})(window);
