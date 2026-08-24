'use strict';
// Headless CLI: node run.js [days]
// Groupware is included only if GW_ID and GW_PW environment variables are set.
//   GW_ID=12345 GW_PW=secret node run.js 8

const { run } = require('./core');

async function main() {
  const days = Number(process.argv[2]) || 8;
  const groupware =
    process.env.GW_ID && process.env.GW_PW
      ? { id: process.env.GW_ID, password: process.env.GW_PW }
      : null;

  if (!groupware) console.log('그룹웨어 로그인 정보(GW_ID/GW_PW) 없음 — 뉴스 소스만 수집합니다.');

  const result = await run({
    days,
    groupware,
    log: (line) => console.log('  ' + line),
  });

  console.log('\n=== 수집 완료 ===');
  console.log(`기간: 최근 ${days}일 (${result.meta.windowFrom} ~ ${result.meta.windowTo})`);
  for (const [src, n] of Object.entries(result.meta.counts)) console.log(`  ${src}: ${n}건`);
  console.log(`  합계: ${result.meta.total}건`);
  if (result.meta.errors.length) {
    console.log('\n오류:');
    for (const e of result.meta.errors) console.log('  - ' + e);
  }
  console.log('\n생성 파일:');
  console.log('  ' + result.files.json);
  console.log('  ' + result.files.md);
  console.log('  ' + result.files.candidates + ` (문제 후보 ${result.files.candidateCount}건)`);
  if (result.quiz && (result.quiz.pool.length || result.quiz.sudden.length)) {
    console.log(`  ${result.files.quiz} (OX ${result.quiz.pool.length}문항 · 서든데스 ${result.quiz.sudden.length}문항, 엔진 ${result.quiz.engine})`);
    console.log('\n검수·게임 반영은 버튼 UI에서: node server.js → http://127.0.0.1:8899/');
  }
}

main().catch((e) => {
  console.error('실패:', e);
  process.exit(1);
});
