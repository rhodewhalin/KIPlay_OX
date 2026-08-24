'use strict';
const fs = require('fs');
const path = require('path');
const { stamp } = require('./dates');

const OUT_DIR = path.join(__dirname, '..', 'output');

const CATEGORY = {
  '그룹웨어·공지사항': 'company-notice',
  '그룹웨어·뉴스&행사': 'company-news',
  '지식재산처': 'ip-policy',
  '한국특허정보원': 'kipi-news',
  '특허뉴스': 'ip-news',
};

const SLUG = {
  '그룹웨어·공지사항': 'gw-notice',
  '그룹웨어·뉴스&행사': 'gw-news',
  '지식재산처': 'kipo',
  '한국특허정보원': 'kipi',
  '특허뉴스': 'patentnews',
};

function ensureDir() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

function writeMaterial(items, meta) {
  ensureDir();
  const s = meta.stamp || stamp(new Date());
  const jsonPath = path.join(OUT_DIR, `material_${s}.json`);
  const mdPath = path.join(OUT_DIR, `material_${s}.md`);
  const qPath = path.join(OUT_DIR, `questions_candidates_${s}.json`);

  fs.writeFileSync(jsonPath, JSON.stringify({ meta, items }, null, 2), 'utf8');
  fs.writeFileSync(mdPath, renderMarkdown(items, meta), 'utf8');

  const candidates = buildCandidates(items, s);
  fs.writeFileSync(qPath, JSON.stringify(candidates, null, 2), 'utf8');

  return {
    json: jsonPath,
    md: mdPath,
    candidates: qPath,
    candidateCount: candidates.length,
  };
}

function buildCandidates(items, s) {
  const out = [];
  const counters = {};
  for (const it of items) {
    const ev = (it.evidence && it.evidence[0]) || '';
    if (!ev) continue; // no evidence sentence -> not usable by the pipeline
    const slug = SLUG[it.source] || 'src';
    counters[slug] = (counters[slug] || 0) + 1;
    const n = String(counters[slug]).padStart(2, '0');
    out.push({
      id: `q-${s}-${slug}-${n}`,
      text: '',
      answer: '',
      difficulty: '',
      category: CATEGORY[it.source] || 'ip-news',
      source: { title: it.title, url: it.url },
      evidence: ev,
      _material: {
        sourceName: it.source,
        date: it.date,
        title: it.title,
        author: it.author || '',
        evidence: it.evidence || [],
        bodyExcerpt: (it.body || '').slice(0, 700),
      },
      _needsGeneration: true,
    });
  }
  return out;
}

function renderMarkdown(items, meta) {
  const lines = [];
  lines.push('# 문제 재료 수집 결과');
  lines.push('');
  lines.push(`- 수집 일시: ${meta.collectedAt}`);
  lines.push(`- 수집 범위: 최근 ${meta.days}일 (${meta.windowFrom} ~ ${meta.windowTo})`);
  lines.push(`- 총 ${items.length}건`);
  const bySource = groupBy(items, (i) => i.source);
  lines.push('');
  lines.push('| 소스 | 건수 |');
  lines.push('|---|---|');
  for (const [src, arr] of bySource) lines.push(`| ${src} | ${arr.length} |`);
  if (meta.errors && meta.errors.length) {
    lines.push('');
    lines.push('> 수집 중 일부 소스 오류:');
    for (const e of meta.errors) lines.push(`> - ${e}`);
  }
  for (const [src, arr] of bySource) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(`## ${src} (${arr.length}건)`);
    for (const it of arr) {
      lines.push('');
      lines.push(`### ${it.title}`);
      lines.push('');
      const metaBits = [`작성일: ${it.date}`];
      if (it.author) metaBits.push(`작성자: ${it.author}`);
      lines.push(`- ${metaBits.join('  |  ')}`);
      if (it.url) lines.push(`- 링크: ${it.url}`);
      if (it.subtitle) lines.push(`- 부제: ${it.subtitle}`);
      if (it.attachments && it.attachments.length)
        lines.push(`- 첨부파일: ${it.attachments.join(', ')}`);
      if (it.embeddedImages) lines.push(`- 본문 내 이미지: ${it.embeddedImages}개`);
      lines.push('');
      lines.push(it.body ? it.body : '(본문 텍스트 없음 — 이미지/첨부 위주)');
    }
  }
  lines.push('');
  return lines.join('\n');
}

// 생성된 OX·서든데스 문항을 검수용 파일로 저장한다.
function writeQuiz(quiz, meta) {
  ensureDir();
  const s = meta.stamp || stamp(new Date());
  const p = path.join(OUT_DIR, `questions_generated_${s}.json`);
  fs.writeFileSync(
    p,
    JSON.stringify(
      {
        _note: `자동 생성 문항 (엔진: ${quiz.engine}, 생성: ${meta.collectedAt}). 검수 후 게임 questions.json에 반영할 것.`,
        engine: quiz.engine,
        generatedAt: meta.collectedAt,
        pool: quiz.pool,
        sudden: quiz.sudden,
        dropped: quiz.dropped,
      },
      null,
      2
    ),
    'utf8'
  );
  return p;
}

function groupBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

module.exports = { writeMaterial, writeQuiz, OUT_DIR };
