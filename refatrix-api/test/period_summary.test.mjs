// =====================================================================
// 「오늘 요약」 확장 검증 — ① 나의 기록(calendar_journal) 반영 ② 기간 묶음 요약
//   · dayDigest.js 는 순수 함수 → 직접 호출 검증
//   · 라우트 SQL 은 pg-mem(실 SQL 엔진)에 0189 를 적용해 왕복 검증
// 실행: node --test test/period_summary.test.mjs
// =====================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { readFileSync } from 'node:fs';
import {
  condenseDigest, buildDailyPrompt, buildPeriodPrompt,
  condensePeriodParts, periodLabel, digestStats,
} from '../src/dayDigest.js';

const JOURNAL = '오전에 CTR 라벨 NOM 건으로 CAM 과 통화. 오후 물류창고 랙 재배치 확인.\n내일 Adrian 과 포털 3단계 일정 확정할 것.';
const dgSample = () => ({
  date: '2026-08-27',
  journal: [{ author: 'Sebastian', content: JOURNAL }],
  schedule: [{ time: '09:30', content: '창고 점검', scope: 'company', owner: 'Karina', created_by: 'Karina', targets: [], memo_count: 1 }],
  todos: { created: [{ title: '견적 회신', assignees: ['Leo'], level: 'assigned', created_by: 'Sebastian' }], due: [], done: [], memos: [] },
  quotes: { count: 2, total_mxn: 48000, sku_count: 12, total_qty: 40, items: [] },
  invoices: { count: 1, total_mxn: 31000, items: [] },
  transactions: { in_mxn: 12000, out_mxn: 3000, in_count: 1, out_count: 1, items: [] },
  activity: { total: 42, users: [] },
});

// ── ① 나의 기록 반영 ────────────────────────────────────────────────
test('condenseDigest: 나의 기록이 맨 앞에 원문 그대로 들어간다', () => {
  const t = condenseDigest('2026-08-27', dgSample());
  assert.ok(t.includes('[나의 기록] 1건'), '기록 섹션 존재');
  assert.ok(t.includes('CAM 과 통화'), '일지 본문 보존');
  assert.ok(t.includes('Adrian'), '일지 뒷부분까지 보존');
  assert.ok(t.indexOf('[나의 기록]') < t.indexOf('[일정]'), '일정보다 앞에 위치');
  assert.ok(t.includes('Sebastian 작성'), '작성자 표기');
});

test('condenseDigest: 기록이 없으면 "없음"으로 표기(빈 섹션 누락 아님)', () => {
  const dg = dgSample(); dg.journal = [];
  assert.ok(condenseDigest('2026-08-27', dg).includes('[나의 기록] 없음'));
});

test('condenseDigest: 긴 다른 섹션에 잘려도 일지 원문은 살아남는다', () => {
  const dg = dgSample();
  dg.schedule = Array.from({ length: 400 }, (_, i) => ({
    time: '10:00', content: '아주 긴 일정 내용 '.repeat(20) + i, scope: 'team', owner: '직원' + i, created_by: '직원' + i, targets: [], memo_count: 0,
  }));
  const t = condenseDigest('2026-08-27', dg);
  assert.ok(t.length <= 13100, '상한 적용');
  assert.ok(t.includes('CAM 과 통화'), '일지는 잘리지 않음');
});

test('condenseDigest: 여러 명의 기록은 3건까지 + 나머지 건수 표기', () => {
  const dg = dgSample();
  dg.journal = [1, 2, 3, 4, 5].map((i) => ({ author: 'D' + i, content: '기록본문' + i }));
  const t = condenseDigest('2026-08-27', dg);
  assert.ok(t.includes('[나의 기록] 5건'));
  assert.ok(t.includes('기록본문3') && !t.includes('기록본문4'));
  assert.ok(t.includes('(외 2건)'));
});

test('condenseDigest: 일지 1건은 2500자까지 보존하고 넘으면 말줄임', () => {
  const dg = dgSample();
  dg.journal = [{ author: 'S', content: '가'.repeat(4000) }];
  const t = condenseDigest('2026-08-27', dg);
  assert.ok(t.includes('가'.repeat(2500)), '2500자까지 보존');
  assert.ok(!t.includes('가'.repeat(2501)), '2500자 초과분은 잘림');
});

test('buildDailyPrompt: 6섹션 유지 + 기록을 섹션에 녹이라는 규칙 + 불릿 지시', () => {
  const p = buildDailyPrompt('2026-08-27', dgSample());
  for (const s of ['### 오늘 한눈에', '### 일정·할일 활동', '### 영업 활동', '### 매출·자금', '### 마케팅·기타 기록', '### 특이사항·팔로업 제안']) {
    assert.ok(p.includes(s), s + ' 유지');
  }
  assert.ok(p.includes('불릿(- )'), '불릿 정리 지시');
  assert.ok(p.includes('별도 섹션을 만들지 말고'), '기록 전용 섹션을 만들지 않도록 지시');
  assert.ok(p.includes('지어내지 말 것'), '환각 금지 규칙 유지');
  assert.ok(p.includes('CAM 과 통화'), '일지 원문이 프롬프트에 포함');
});

test('digestStats: journal 건수를 헤드라인에 포함', () => {
  assert.equal(digestStats(dgSample()).journal, 1);
  assert.equal(digestStats({}).journal, 0);
  assert.equal(digestStats(dgSample()).schedule, 1, '기존 수치 회귀 없음');
});

// ── ② 기간 묶음 요약 ────────────────────────────────────────────────
const parts = [
  { date: '2026-08-25', content_md: '### 오늘 한눈에\n- 견적 3건', journal: [{ author: 'S', content: '월요일 기록: 랙 재배치 시작' }] },
  { date: '2026-08-26', content_md: '### 오늘 한눈에\n- 입금 12,000', journal: [] },
  { date: '2026-08-27', content_md: '### 오늘 한눈에\n- 인보이스 1건', journal: [{ author: 'S', content: '수요일 기록: 재배치 완료' }] },
];

test('periodLabel: 연속 날짜는 기간, 비연속은 날짜 나열', () => {
  assert.ok(periodLabel(['2026-08-25', '2026-08-26', '2026-08-27']).includes('~'));
  assert.ok(periodLabel(['2026-08-25', '2026-08-26', '2026-08-27']).includes('(3일)'));
  const gap = periodLabel(['2026-08-25', '2026-08-28']);
  assert.ok(gap.includes('선택 날짜'), '비연속은 나열형');
  assert.equal(periodLabel([]), '');
  assert.ok(periodLabel(['2026-08-27']).includes('2026년 8월 27일'));
});

test('periodLabel: 월을 넘는 연속 구간도 연속으로 인식', () => {
  assert.ok(periodLabel(['2026-08-30', '2026-08-31', '2026-09-01']).includes('~'));
});

test('condensePeriodParts: 날짜 순서대로, 일지 원문 + 일일 요약이 함께 들어간다', () => {
  const t = condensePeriodParts(parts);
  assert.ok(t.indexOf('2026년 8월 25일') < t.indexOf('2026년 8월 27일'), '시간순');
  assert.ok(t.includes('랙 재배치 시작') && t.includes('재배치 완료'), '일지 원문 포함');
  assert.ok(t.includes('견적 3건') && t.includes('인보이스 1건'), '일일 요약 본문 포함');
  assert.ok(t.includes('[이 날 나의 기록 원문]'));
});

test('condensePeriodParts: 날짜가 많아도 전체 길이 상한을 지킨다', () => {
  const many = Array.from({ length: 31 }, (_, i) => ({
    date: '2026-08-' + String(i + 1).padStart(2, '0'),
    content_md: '긴 요약 본문 '.repeat(2000),
    journal: [{ author: 'S', content: '긴 일지 '.repeat(2000) }],
  }));
  const t = condensePeriodParts(many);
  assert.ok(t.length <= 60100, '상한 60,000자 + 말줄임');
});

test('buildPeriodPrompt: 하나의 스토리 + 6섹션 + 불릿 + 경과 표기 규칙', () => {
  const p = buildPeriodPrompt(['2026-08-25', '2026-08-26', '2026-08-27'], parts);
  assert.ok(p.includes('하나로 이어지는 기간 스토리'));
  for (const s of ['### 기간 한눈에', '### 일정·할일 활동', '### 영업 활동', '### 매출·자금', '### 마케팅·기타 기록', '### 특이사항·팔로업 제안']) {
    assert.ok(p.includes(s), s);
  }
  assert.ok(p.includes('불릿(- )'), '불릿 지시');
  assert.ok(p.includes('한 문단'), '도입 스토리 문단 지시');
  assert.ok(p.includes('경과를 표기'), '여러 날 걸친 사안 합치기 규칙');
  assert.ok(p.includes('지어내지 말 것'), '환각 금지');
  assert.ok(p.includes('랙 재배치 시작'), '일지 원문이 재료로 들어감');
});

// ── ③ 라우트 SQL 왕복 (pg-mem · 0189 적용) ─────────────────────────
function seed() {
  const db = newDb();
  db.public.none(`
    CREATE TABLE users(id INT PRIMARY KEY, name TEXT, dept TEXT);
    INSERT INTO users VALUES (1,'Sebastian','경영'),(2,'Karina','영업');
    CREATE TABLE calendar_journal(
      id SERIAL PRIMARY KEY, user_id INT NOT NULL, entry_date DATE NOT NULL,
      content TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE daily_summaries(
      id SERIAL PRIMARY KEY, summary_date DATE UNIQUE, content_md TEXT, digest TEXT,
      model TEXT, memo TEXT, created_by INT, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
  `);
  db.public.none(readFileSync(new URL('../migrations/0189_period_summaries.sql', import.meta.url), 'utf8'));
  return db.public;
}

// 실제 PostgreSQL 에서의 재적용 멱등성은 period_summary_api.test.mjs 에서 검증한다.
// 여기서는 마이그레이션의 모든 DDL 이 IF NOT EXISTS 를 쓰는지 구조만 확인.
test('0189: 모든 DDL 이 IF NOT EXISTS (재실행 안전)', () => {
  const sql = readFileSync(new URL('../migrations/0189_period_summaries.sql', import.meta.url), 'utf8');
  const bare = sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  const ddl = bare.split(';').map((s) => s.trim()).filter((s) => /^CREATE/i.test(s));
  assert.equal(ddl.length, 3, 'CREATE TABLE 1 + CREATE INDEX 2');
  for (const st of ddl) assert.match(st, /IF NOT EXISTS/i, st.slice(0, 50));
  const pub = seed();
  assert.equal(pub.many(`SELECT count(*)::int AS c FROM period_summaries`)[0].c, 0);
});

test('일지 수집 SQL: 그날 기록만, 빈 내용 제외, 작성자 이름 조인', () => {
  const pub = seed();
  pub.none(`INSERT INTO calendar_journal(user_id,entry_date,content) VALUES
    (1,'2026-08-27','수요일 기록'),(2,'2026-08-27',''),(1,'2026-08-26','화요일 기록')`);
  const rows = pub.many(
    `SELECT j.content, j.updated_at, u.name AS author
       FROM calendar_journal j
       LEFT JOIN users u ON u.id = j.user_id
      WHERE j.entry_date = '2026-08-27' AND COALESCE(j.content,'') <> ''
      ORDER BY j.user_id`);
  assert.equal(rows.length, 1, '빈 내용·다른 날짜 제외');
  assert.equal(rows[0].content, '수요일 기록');
  assert.equal(rows[0].author, 'Sebastian');
});

test('묶음 재료 조회: 선택 날짜의 일자별 요약만 날짜 오름차순으로', () => {
  const pub = seed();
  pub.none(`INSERT INTO daily_summaries(summary_date,content_md,digest) VALUES
    ('2026-08-27','수 요약','{"journal":[{"author":"S","content":"수 기록"}]}'),
    ('2026-08-25','월 요약','{}'),
    ('2026-08-24','제외될 요약','{}')`);
  const rows = pub.many(
    `SELECT summary_date, content_md, digest FROM daily_summaries
      WHERE summary_date IN ('2026-08-25','2026-08-27') ORDER BY summary_date`);
  assert.deepEqual(rows.map((r) => r.content_md), ['월 요약', '수 요약']);
  assert.equal(JSON.parse(rows[1].digest).journal[0].content, '수 기록', 'digest 에서 일지 재사용 가능');
});

test('period_summaries: 신규 저장 → 같은 날짜 조합 재생성은 갱신(행 1개 유지)', () => {
  const pub = seed();
  const key = '2026-08-25,2026-08-26,2026-08-27';
  pub.none(
    `INSERT INTO period_summaries (title, date_from, date_to, day_count, dates_key, content_md, stats, model, created_by)
       VALUES ('8월 4주','2026-08-25','2026-08-27',3,'${key}','첫 본문','{"journal":2}','m',1)`);
  const upd = pub.many(
    `UPDATE period_summaries
        SET title='8월 4주 v2', content_md='갱신 본문', stats='{"journal":3}', model='m', created_by=1,
            date_from='2026-08-25', date_to='2026-08-27', day_count=3, updated_at=now()
      WHERE dates_key='${key}'
      RETURNING id`);
  assert.equal(upd.length, 1, '기존 행 갱신');
  const all = pub.many(`SELECT title, content_md, day_count FROM period_summaries`);
  assert.equal(all.length, 1, '중복 행이 생기지 않음');
  assert.equal(all[0].content_md, '갱신 본문');
  assert.equal(all[0].title, '8월 4주 v2');
});

test('period_summaries: 다른 날짜 조합은 별도 행 + 목록은 최근 기간 우선', () => {
  const pub = seed();
  pub.none(`INSERT INTO period_summaries (title,date_from,date_to,day_count,dates_key,content_md,model,created_by) VALUES
    ('3주','2026-08-18','2026-08-20',3,'2026-08-18,2026-08-19,2026-08-20','a','m',1),
    ('4주','2026-08-25','2026-08-27',3,'2026-08-25,2026-08-26,2026-08-27','b','m',1)`);
  const rows = pub.many(
    `SELECT p.id, p.title, p.dates_key, u.name AS created_by_name
       FROM period_summaries p LEFT JOIN users u ON u.id = p.created_by
      ORDER BY p.date_to DESC, p.date_from DESC, p.id DESC LIMIT 100`);
  assert.deepEqual(rows.map((r) => r.title), ['4주', '3주'], '최근 기간이 위');
  assert.equal(rows[0].created_by_name, 'Sebastian');
  assert.equal(rows[0].dates_key.split(',').length, 3, 'dates_key 로 날짜 목록 복원 가능');
});

test('period_summaries: 메모 저장 · 삭제 SQL', () => {
  const pub = seed();
  pub.none(`INSERT INTO period_summaries (id,title,date_from,date_to,day_count,dates_key,content_md,model,created_by)
            VALUES (9,'t','2026-08-25','2026-08-27',3,'k','b','m',1)`);
  const m = pub.many(`UPDATE period_summaries SET memo='확인 필요', updated_at=now() WHERE id=9 RETURNING id`);
  assert.equal(m.length, 1);
  assert.equal(pub.many(`SELECT memo FROM period_summaries WHERE id=9`)[0].memo, '확인 필요');
  const d = pub.many(`DELETE FROM period_summaries WHERE id=9 RETURNING id, date_from, date_to`);
  assert.equal(d.length, 1);
  assert.equal(pub.many(`SELECT count(*)::int AS c FROM period_summaries`)[0].c, 0);
});
