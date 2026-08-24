'use strict';
// Orchestrates all sources for a single scrape run.

const groupware = require('./sources/groupware');
const kipo = require('./sources/kipo');
const kipi = require('./sources/kipi');
const patentnews = require('./sources/patentnews');
const { writeMaterial, writeQuiz } = require('./lib/output');
const { generate } = require('./lib/quizgen');
const { cutoffFor, isoLocal, stamp } = require('./lib/dates');

const NEWS_SOURCES = [kipo, kipi, patentnews];

// opts: { days, groupware: {id, password} | null, log, now }
async function run(opts) {
  const days = opts.days || 8;
  const now = opts.now || new Date();
  const log = opts.log || (() => {});
  const errors = [];
  let items = [];

  // Groupware (optional — needs credentials).
  if (opts.groupware && opts.groupware.id && opts.groupware.password) {
    try {
      const gw = await groupware.scrape({
        id: opts.groupware.id,
        password: opts.groupware.password,
        days,
        now,
        log,
      });
      items = items.concat(gw);
      log(`그룹웨어 완료: ${gw.length}건`);
    } catch (e) {
      errors.push(`그룹웨어: ${e.message}`);
      log(`⚠ 그룹웨어 오류: ${e.message}`);
    }
  } else {
    log('그룹웨어: 로그인 정보 미입력 — 건너뜀');
  }

  // News sources.
  for (const src of NEWS_SOURCES) {
    try {
      log(`${src.label} 수집…`);
      const got = await src.scrape({ days, now, log });
      items = items.concat(got);
      log(`${src.label} 완료: ${got.length}건`);
    } catch (e) {
      errors.push(`${src.label}: ${e.message}`);
      log(`⚠ ${src.label} 오류: ${e.message}`);
    }
  }

  // Keep only clean declarative sentences as evidence: drop titles, subtitles,
  // breadcrumbs, bracket/dash headers, and lead fragments ending in an ellipsis.
  const norm = (x) => x.replace(/[''""‘’“”]/g, "'").replace(/\s+/g, '');
  for (const it of items) {
    const title = (it.title || '').trim();
    const nTitle = norm(title);
    it.evidence = (it.evidence || [])
      .map((s) => s.trim())
      .filter(
        (s) =>
          s.length >= 15 &&
          norm(s) !== nTitle &&
          !nTitle.includes(norm(s)) && // drop title/subtitle echoes (quote-insensitive)
          !/[>›]/.test(s) && // breadcrumb
          !/^[-\[(].*[-\])]$/.test(s) && // -header- or [header]
          /(?:다\.|[.!?。])[)"'”’」』]?$/.test(s) && // ends like a full sentence
          !/(?:\.\.\.|…)$/.test(s) // not a trailing-ellipsis lead fragment
      )
      .slice(0, 5);
  }

  items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const meta = {
    collectedAt: isoLocal(now),
    days,
    windowFrom: isoLocal(cutoffFor(days, now)),
    windowTo: isoLocal(now),
    total: items.length,
    stamp: stamp(now),
    errors,
    counts: countBySource(items),
  };

  const files = writeMaterial(items, meta);

  // 수집이 끝나면 바로 이어서 OX 문항을 생성한다.
  let quiz = { engine: 'none', pool: [], sudden: [], dropped: [] };
  try {
    quiz = await generate(items, { apiKey: opts.apiKey, stamp: meta.stamp, log });
    if (quiz.pool.length || quiz.sudden.length) {
      files.quiz = writeQuiz(quiz, meta);
    }
  } catch (e) {
    errors.push(`퀴즈 생성: ${e.message}`);
    log(`⚠ 퀴즈 생성 오류: ${e.message}`);
  }

  return { meta, files, items, quiz };
}

function countBySource(items) {
  const c = {};
  for (const it of items) c[it.source] = (c[it.source] || 0) + 1;
  return c;
}

module.exports = { run, NEWS_SOURCES };
