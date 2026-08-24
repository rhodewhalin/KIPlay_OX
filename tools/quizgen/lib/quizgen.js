'use strict';
// OX 퀴즈 문항 생성기 — 하이브리드.
//   1) ANTHROPIC_API_KEY(또는 UI 입력 키)가 있으면 Claude API(claude-opus-5)로 생성
//   2) 키가 없거나 호출 실패 시 규칙 기반 엔진으로 폴백
//
// 두 경로 모두 공통 검증을 통과해야 한다:
//   - evidence는 수집된 원문에 실제로 존재하는 문장이어야 한다 (할루시네이션 차단, PRD 11.1)
//   - answer는 O/X, difficulty는 easy/medium/hard, category는 게임 스키마의 enum
//   - 서든데스 answer 숫자는 원문에 실제로 등장해야 한다

const { request } = require('./http');
const { sentences } = require('./html');

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-opus-5';
const CATEGORIES = ['patent-law', 'ip-news', 'trivia', 'office'];

// ---------------------------------------------------------------- utilities

function norm(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

// evidence가 해당 재료의 본문(또는 제목)에 실제로 존재하는가.
function evidenceInMaterial(evidence, item) {
  const ev = norm(evidence);
  if (ev.length < 10) return false;
  const hay = norm((item.title || '') + ' ' + (item.body || ''));
  return hay.includes(ev);
}

function numberInMaterial(n, item) {
  const hay = ((item.title || '') + ' ' + (item.body || '')).replace(/,/g, '');
  return hay.includes(String(n));
}

function defaultCategory(item) {
  return item.sourceType === 'groupware' ? 'office' : 'ip-news';
}

// ------------------------------------------------------------- 규칙 기반 엔진

// 순번 접미사가 붙은 id를 만든다.
function makeIds(prefix, start) {
  let n = start;
  return () => `${prefix}-${String(++n).padStart(2, '0')}`;
}

// "숫자+단위" 토큰 (서든데스·X문항 변형용). 연도·날짜류(년/월/일/시)는
// 변형하면 어색하거나 무의미해서 제외한다.
const NUM_UNIT_RE = /([\d][\d,.]*)\s*(건|명|개|위|%|퍼센트|억|만|배|개월|회|층|점)/g;

// 인사말·안내 상용구 등 문항 재료가 못 되는 문장.
const BAD_SENT =
  /^안녕|^-|^\[|안내\s?드립니다|안내\s?드립|문의\s*[:：]|주시기\s*바랍니다|바랍니다\.$|바로\s?가기|첨부\s?(파일|와)|아래와 같이|참조하?시|드리오니|기자\s*\||입력\s*[:：]/;

/**
 * 화면에 혼자 떠도 판정 가능한 "진술문"인가.
 *
 * 예전에는 길이와 상용구만 봐서 "□ 육아휴직(최초 1년 또는…)" 같은 불릿 조각과
 * 명사로 끝나는 헤드라인이 그대로 문항이 됐다 —— 실제로 게임에 들어가 손으로 걷어냈다.
 * 도장은 문장에만 찍는다: 불릿 표식이 없고, "…다."로 끝나는 평서문만 통과시킨다.
 */
function usableSentence(s) {
  const t = norm(s);
  if (t.length < 22 || t.length > 180) return false;
  if (BAD_SENT.test(t)) return false;
  if (/[…]|\.\.\./.test(t)) return false;
  if (/^[□■○●◎〇◦▶▷•*·>※☆★—-]|^[0-9]+[.)]\s/.test(t)) return false;   // 목록 불릿
  if (!/(다|이다|한다|된다|있다|없다|였다|않는다|합니다|입니다)\.?$/.test(t.replace(/\.$/, '.'))) return false; // 평서문 종결
  return /(다|니다)\.$/.test(t) || /(다|니다)$/.test(t);
}

function pickFactSentences(item, max) {
  const seen = new Set();
  const out = [];
  const cands = (item.evidence && item.evidence.length ? item.evidence : []).concat(sentences(item.body));
  for (const s of cands) {
    const key = norm(s);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!usableSentence(s)) continue;
    if (!evidenceInMaterial(s, item)) continue;
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function difficultyOf(sentence) {
  const nums = (sentence.match(/\d[\d,.]*/g) || []).length;
  if (nums >= 2) return 'hard';
  if (nums === 1) return 'medium';
  return 'easy';
}

// 문장 속 "숫자+단위" 후보를 찾는다. 연도(1900~2100)는 후보에서 뺀다.
function findNumUnit(str) {
  NUM_UNIT_RE.lastIndex = 0;
  let m;
  while ((m = NUM_UNIT_RE.exec(str)) !== null) {
    const val = parseFloat(m[1].replace(/,/g, ''));
    if (isNaN(val)) continue;
    if (val >= 1900 && val <= 2100) continue; // 연도로 보이는 값
    return { token: m[0], numStr: m[1], unit: m[2], val };
  }
  return null;
}

// 숫자 하나를 그럴듯하게 틀린 값으로 바꾼다.
function mutateNumber(str) {
  const f = findNumUnit(str);
  if (!f) return null;
  let wrong;
  if (f.unit === '위') wrong = f.val === 1 ? 2 : f.val - 1 || f.val + 1; // 순위 한 칸
  else if (f.val <= 3) wrong = f.val + 1;
  // 2배는 한눈에 잡힌다. 원문을 읽었는지가 갈리는 30~50% 폭이 적당하다.
  else if (Number.isInteger(f.val)) wrong = Math.max(f.val + 1, Math.round(f.val * (f.val > 100 ? 1.3 : 1.5)));
  else wrong = Math.round(f.val * 1.5 * 10) / 10;
  if (!wrong || wrong === f.val) return null;
  const wrongStr = Number.isInteger(wrong) ? String(wrong) : wrong.toFixed(1);
  return { text: str.replace(f.numStr, wrongStr), original: f.val, mutated: wrong };
}

function rulesGenerate(items, stamp) {
  const pool = [];
  const sudden = [];
  const qid = makeIds(`q-gen-${stamp}`, 0);
  const sid = makeIds(`sd-gen-${stamp}`, 0);

  for (const item of items) {
    const facts = pickFactSentences(item, 3);
    const category = defaultCategory(item);
    for (const s of facts) {
      if (pool.filter((q) => q._itemNum === item.num).length >= 2) break;
      const mut = mutateNumber(s);
      if (mut && mut.text !== s && pool.filter((q) => q.answer === 'X').length <= pool.length / 2) {
        // 숫자를 틀리게 바꾼 X 문항
        pool.push({
          id: qid(),
          text: mut.text,
          answer: 'X',
          difficulty: difficultyOf(s),
          category,
          source: { title: item.title, url: item.url || null },
          evidence: s,
          _engine: 'rules',
          _itemNum: item.num,
          _note: `원문 숫자 ${mut.original} → ${mut.mutated}(오답)로 변형`,
        });
      } else {
        // 원문 문장 그대로의 O 문항
        pool.push({
          id: qid(),
          text: s,
          answer: 'O',
          difficulty: difficultyOf(s),
          category,
          source: { title: item.title, url: item.url || null },
          evidence: s,
          _engine: 'rules',
          _itemNum: item.num,
        });
      }
    }
    // 서든데스: 숫자+단위가 뚜렷한 문장 1개 → 빈칸 맞히기 형태
    if (sudden.length < 3) {
      for (const s of facts) {
        const f = findNumUnit(s);
        if (!f || f.val < 2 || !Number.isInteger(f.val)) continue;
        const blanked = s.replace(f.token, `◯◯${f.unit}`);
        sudden.push({
          id: sid(),
          text: `"${blanked}" — ◯◯에 들어갈 숫자는?`,
          answer: f.val,
          unit: f.unit,
          source: { title: item.title, url: item.url || null },
          evidence: s,
          _engine: 'rules',
          _itemNum: item.num,
        });
        break;
      }
    }
  }
  return { pool, sudden, engine: 'rules' };
}

// ------------------------------------------------------------ Claude API 엔진

function buildPrompt(items, stamp) {
  const materials = items
    .map((it, i) => {
      const body = norm(it.body).slice(0, 1600);
      return `[기사 ${i + 1}] (id: ${it.num})\n소스: ${it.source}\n제목: ${it.title}\n날짜: ${it.date}\nURL: ${it.url || '없음'}\n본문:\n${body}`;
    })
    .join('\n\n---\n\n');

  return `너는 사내 실시간 OX 서바이벌 게임 "12:55"의 출제 담당이다. 아래 수집된 기사·공지를 재료로 OX 문항과 서든데스 문항을 만들어라.

## 출력 형식 (JSON만 출력, 다른 텍스트 금지)
{
  "pool": [
    {"id": "q-gen-${stamp}-01", "text": "문항 본문 (…다. 로 끝나는 평서문)", "answer": "O 또는 X", "difficulty": "easy|medium|hard", "category": "patent-law|ip-news|trivia|office", "source": {"title": "기사 제목", "url": "기사 URL"}, "evidence": "근거가 되는 원문 문장 (아래 규칙 참고)", "materialId": "기사 id"}
  ],
  "sudden": [
    {"id": "sd-gen-${stamp}-01", "text": "숫자 근접값 질문 (…몇 건일까? 형태)", "answer": 숫자, "unit": "건/명/위 등", "source": {"title": "...", "url": "..."}, "evidence": "근거 원문 문장", "materialId": "기사 id"}
  ]
}

## 절대 규칙
1. **evidence는 반드시 해당 기사 본문에 있는 문장을 글자 그대로(토씨 하나 바꾸지 말고) 복사**한다. 프로그램이 원문 대조 검증을 하며, 일치하지 않는 문항은 자동 폐기된다.
2. 문항의 사실은 제공된 기사에만 근거한다. 외부 지식으로 지어내지 않는다.
3. answer가 X인 문항은 기사 속 사실을 **그럴듯하게 하나만 비틀어서** 만든다 (숫자·순위·기관명·국가·기간 등). evidence는 그 사실의 원문 문장이다.
4. O와 X 비율은 대략 반반.
5. 난이도 배분 (게임의 목표 정답률): easy(85%: 기사 핵심·제목 수준 사실) / medium(55%: 본문을 읽어야 아는 사실) / hard(30~40%: 구체적 숫자·기관·조건). 세 난이도가 고루 나오게 한다.
6. category: 특허법·제도 내용이면 patent-law, 지식재산 뉴스면 ip-news, 사내 공지·행사면 office, 그 외 상식이면 trivia.
7. **개인정보 금지**: 인사발령·승진 등 개인 실명이 드러나는 문항은 만들지 않는다. 기관·제도·행사 수준의 사실만 쓴다.
8. 서든데스는 기사에 **명시된 숫자**로만 만든다 (answer는 정수, 본문의 숫자와 정확히 일치).
9. 분량: pool 문항 12~20개, sudden 2~4개. 재료가 빈약한 기사는 건너뛴다.
10. 문체는 간결한 평서문. 예: "중국은 첨단기술 분야 특허 우선심사의 첫 심사 기한을 45일로 단축했다."

## 수집된 재료
${materials}`;
}

// 응답 텍스트에서 첫 번째 균형 잡힌 JSON 오브젝트를 추출한다.
function extractJson(text) {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('응답에 JSON이 없음');
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error('JSON이 닫히지 않음');
}

async function callClaude(apiKey, prompt, log) {
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: 16000,
    // Claude Opus 5는 thinking 기본 adaptive. 안전 분류기 거절 시 대체 모델로
    // 자동 재시도되도록 서버측 폴백을 기본 활성화한다.
    fallbacks: 'default',
    messages: [{ role: 'user', content: prompt }],
  });
  const res = await request('POST', API_URL, {
    body,
    timeout: 600000,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    },
  });
  const data = JSON.parse(res.decode('utf-8'));
  if (res.status !== 200) {
    const msg = (data.error && data.error.message) || `HTTP ${res.status}`;
    throw new Error(`Claude API 오류: ${msg}`);
  }
  if (data.stop_reason === 'refusal') {
    throw new Error('Claude API가 요청을 거절함 (refusal)');
  }
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  if (data.usage) {
    log(`  Claude 응답 수신 (입력 ${data.usage.input_tokens}tok / 출력 ${data.usage.output_tokens}tok, 모델 ${data.model})`);
  }
  return extractJson(text);
}

async function claudeGenerate(items, stamp, apiKey, log) {
  const prompt = buildPrompt(items, stamp);
  let parsed;
  try {
    parsed = await callClaude(apiKey, prompt, log);
  } catch (e) {
    if (/JSON/.test(e.message)) {
      log('  JSON 파싱 실패 — 1회 재시도…');
      parsed = await callClaude(apiKey, prompt + '\n\n반드시 유효한 JSON 오브젝트 하나만 출력하라.', log);
    } else {
      throw e;
    }
  }
  const byNum = new Map(items.map((it) => [String(it.num), it]));
  return {
    engine: 'claude',
    pool: (parsed.pool || []).map((q) => ({ ...q, _engine: 'claude', _itemNum: String(q.materialId || '') })),
    sudden: (parsed.sudden || []).map((q) => ({ ...q, _engine: 'claude', _itemNum: String(q.materialId || '') })),
    _byNum: byNum,
  };
}

// ------------------------------------------------------------------ 공통 검증

function validate(result, items, log) {
  const byNum = new Map(items.map((it) => [String(it.num), it]));
  const findItem = (q) => byNum.get(String(q._itemNum)) || items.find((it) => evidenceInMaterial(q.evidence, it));

  const pool = [];
  const dropped = [];
  for (const q of result.pool || []) {
    const item = findItem(q);
    const reasons = [];
    if (!q.text || norm(q.text).length < 10) reasons.push('본문 없음');
    if (q.answer !== 'O' && q.answer !== 'X') reasons.push('answer가 O/X 아님');
    if (!['easy', 'medium', 'hard'].includes(q.difficulty)) reasons.push('difficulty 오류');
    if (!CATEGORIES.includes(q.category)) q.category = item ? defaultCategory(item) : 'ip-news';
    if (!item) reasons.push('출처 기사를 못 찾음');
    else if (!evidenceInMaterial(q.evidence, item)) reasons.push('evidence가 원문에 없음');
    // O 문항인데 본문이 원문 어디에도 없다면 생성기가 의역한 것이다. 의역 자체는
    // 조각문을 진술문으로 만들 때 필요하지만, 의미가 뒤틀렸을 수 있으니 사람 검수를
    // 강제한다 —— 자동 폐기도, 무사통과도 아니다.
    if (q.answer === 'O' && item && !evidenceInMaterial(q.text, item)) {
      q._warn = '의역된 O 문항 — 원문과 대조해 검수하세요';
    }
    if (reasons.length) dropped.push({ id: q.id, reasons });
    else pool.push(q);
  }

  const sudden = [];
  for (const q of result.sudden || []) {
    const item = findItem(q);
    const reasons = [];
    const n = Number(q.answer);
    if (!q.text || !/[?？]\s*$/.test(q.text)) reasons.push('질문형 아님');
    if (!Number.isFinite(n)) reasons.push('answer가 숫자 아님');
    if (!item) reasons.push('출처 기사를 못 찾음');
    else {
      if (!evidenceInMaterial(q.evidence, item)) reasons.push('evidence가 원문에 없음');
      if (Number.isFinite(n) && !numberInMaterial(n, item)) reasons.push('숫자가 원문에 없음');
    }
    if (reasons.length) dropped.push({ id: q.id, reasons });
    else sudden.push({ ...q, answer: Math.round(n) });
  }

  if (dropped.length) {
    log(`  검증 탈락 ${dropped.length}건: ${dropped.map((d) => `${d.id}(${d.reasons.join(',')})`).join(' / ')}`);
  }
  return { pool, sudden, dropped };
}

// _접두 필드(_warn, _engine, _itemNum)는 검수 화면까지 살아간다.
// 게임 파일로 들어갈 때 applyToGame의 strip이 걷어낸다.

// ------------------------------------------------------------------- 진입점

// opts: { apiKey, stamp, log }
async function generate(items, opts) {
  const log = opts.log || (() => {});
  const stamp = opts.stamp;
  // 개인 신상이 드러나는 공지(발령·부고·경조 등)는 출제 재료에서 제외한다 (PRD 11.1 개인정보 필터링).
  const PRIVACY_RE = /\[발령\]|인사발령|의원면직|부고|경조|조의|결혼|장례/;
  const usable = items.filter(
    (it) => (it.body || '').length >= 80 && !PRIVACY_RE.test(it.title || '')
  );
  if (!usable.length) {
    log('퀴즈 생성: 사용할 재료가 없음');
    return { engine: 'none', pool: [], sudden: [], dropped: [] };
  }

  // 같은 날 두 번 돌리면 id가 겹쳐 "이미 반영됨"으로 오인된다. 시각을 붙여 가른다.
  const d = new Date();
  const stampT = `${stamp}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;

  const apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY || '';
  let raw;
  if (apiKey) {
    log(`퀴즈 생성: Claude API(${MODEL}) 호출 — 재료 ${usable.length}건…`);
    try {
      raw = await claudeGenerate(usable, stampT, apiKey, log);
    } catch (e) {
      log(`⚠ Claude 생성 실패(${e.message}) — 규칙 기반으로 폴백`);
      raw = rulesGenerate(usable, stampT);
    }
  } else {
    log('퀴즈 생성: API 키 없음 — 규칙 기반 엔진 사용');
    raw = rulesGenerate(usable, stampT);
  }

  const { pool, sudden, dropped } = validate(raw, usable, log);
  log(`퀴즈 생성 완료: OX ${pool.length}문항, 서든데스 ${sudden.length}문항 (엔진: ${raw.engine})`);
  return { engine: raw.engine, pool, sudden, dropped };
}

module.exports = { generate };
