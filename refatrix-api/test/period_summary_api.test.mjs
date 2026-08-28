// =====================================================================
// 기간 묶음 요약 + 나의 기록 반영 — 실제 라우트 핸들러 × 실제 PostgreSQL 통합 테스트
//   dailySummaryRoutes.js 를 그대로 로드해 핸들러를 꺼내 호출한다.
//   Anthropic 호출만 fetch 스텁으로 대체(실제 과금·네트워크 없음).
//
// 실행 전제: DATABASE_URL 이 테스트용 PostgreSQL 을 가리킬 것.
//   예) DATABASE_URL=postgres://postgres@/refatrix_test?host=/tmp&port=5433 \
//       ANTHROPIC_API_KEY=test node --test test/period_summary_api.test.mjs
// =====================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { query, pool } from '../src/db.js';
import { requireDirector } from '../src/middleware/authGuard.js';

// 백그라운드 WhatsApp 스케줄러가 뜨지 않게(테스트가 끝나도 안 죽는 것 방지)
globalThis.__refatrixDailyWaScheduler = true;
const routes = (await import('../src/routes/dailySummaryRoutes.js')).default;

// ── 라우트 수집 ──
const R = {};
const app = {};
for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
  app[m] = (path, opts, handler) => { R[`${m.toUpperCase()} ${path}`] = { opts, handler }; };
}
await routes(app);

function mkReply() {
  const rep = { statusCode: 200, payload: null };
  rep.code = (c) => { rep.statusCode = c; return rep; };
  rep.send = (p) => { rep.payload = p; return rep; };
  return rep;
}
const call = async (key, { user = 1, params = {}, q = {}, body = null } = {}) => {
  const rep = mkReply();
  const out = await R[key].handler(
    { ctx: { perm: { userId: user, role: 'director' }, deviceId: null }, params, query: q, body, log: { error() {} } },
    rep);
  return { out: out === rep ? null : out, rep };
};

// ── Anthropic 호출 스텁 ──
const aiCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('api.anthropic.com')) {
    const body = JSON.parse(opts.body);
    aiCalls.push(body);
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: '### 기간 한눈에\n- 스텁 요약' }] }) };
  }
  return realFetch(url, opts);
};

// ── 스키마 ──
async function resetSchema() {
  await query(`DROP TABLE IF EXISTS period_summaries, daily_summaries, calendar_journal, audit_log, users CASCADE`);
  await query(`
    CREATE TABLE users(id BIGSERIAL PRIMARY KEY, name TEXT, dept TEXT);
    CREATE TABLE audit_log(id BIGSERIAL PRIMARY KEY, user_id BIGINT, device_id TEXT, action TEXT,
                           target TEXT, detail JSONB, result TEXT, occurred_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE daily_summaries(
      id BIGSERIAL PRIMARY KEY, summary_date DATE UNIQUE NOT NULL, content_md TEXT NOT NULL,
      digest JSONB, model TEXT, memo TEXT, created_by BIGINT,
      wa_sent_at TIMESTAMPTZ, wa_status TEXT, wa_error TEXT, wa_attempts INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
  `);
  await query(readFileSync(new URL('../migrations/0182_calendar_journal.sql', import.meta.url), 'utf8'));
  await query(readFileSync(new URL('../migrations/0189_period_summaries.sql', import.meta.url), 'utf8'));
  await query(`INSERT INTO users (id,name,dept) VALUES (1,'Sebastian','경영'),(2,'Karina','영업')`);
}

async function seedDaily() {
  const rows = [
    ['2026-08-25', '### 오늘 한눈에\n- 월요일: 견적 3건', { journal: [{ author: 'Sebastian', content: '월: 랙 재배치 시작' }], quotes: { count: 3 }, schedule: [1, 2] }],
    ['2026-08-26', '### 오늘 한눈에\n- 화요일: 입금 12,000', { journal: [], transactions: { in_mxn: 12000 }, schedule: [1] }],
    ['2026-08-27', '### 오늘 한눈에\n- 수요일: 인보이스 1건', { journal: [{ author: 'Sebastian', content: '수: 재배치 완료' }], invoices: { count: 1 }, schedule: [1, 2, 3] }],
  ];
  for (const [d, md, dg] of rows) {
    await query(`INSERT INTO daily_summaries (summary_date, content_md, digest, model, created_by)
                 VALUES ($1,$2,$3,'m',1)`, [d, md, JSON.stringify(dg)]);
  }
}

test.before(async () => { await resetSchema(); });
test.after(async () => { globalThis.fetch = realFetch; await pool.end(); });

// ── 0189 마이그레이션 ──
test('0189: 실제 PostgreSQL 에 2회 적용해도 안전(멱등)', async () => {
  const sql = readFileSync(new URL('../migrations/0189_period_summaries.sql', import.meta.url), 'utf8');
  await query(sql);
  await query(sql);
  const c = (await query(`SELECT count(*)::int AS c FROM period_summaries`)).rows[0].c;
  assert.equal(c, 0);
});

test('0189: dates_key 유니크 제약이 실제로 걸린다', async () => {
  await query(`DELETE FROM period_summaries`);
  const ins = `INSERT INTO period_summaries (title,date_from,date_to,day_count,dates_key,content_md,model,created_by)
               VALUES ('t','2026-08-25','2026-08-27',3,'K','b','m',1)`;
  await query(ins);
  await assert.rejects(() => query(ins), /duplicate key|unique/i);
});

// ── 권한 ──
test('묶음 라우트 5개가 모두 디렉터 전용으로 등록된다', () => {
  for (const k of ['POST /api/period-summary/generate', 'GET /api/period-summary/list',
    'GET /api/period-summary/:id', 'PUT /api/period-summary/:id/memo', 'DELETE /api/period-summary/:id']) {
    assert.ok(R[k], k + ' 등록됨');
    assert.ok(R[k].opts.preHandler.includes(requireDirector), k + ' 디렉터 전용');
  }
});

test('requireDirector: 영업 계정은 403', () => {
  const rep = mkReply();
  requireDirector({ ctx: { perm: { userId: 3, role: 'sales' } } }, rep, () => assert.fail('통과하면 안 됨'));
  assert.equal(rep.statusCode, 403);
});

// ── 입력 검증 ──
test('날짜 1개 이하면 400 need_two_dates', async () => {
  const r = await call('POST /api/period-summary/generate', { body: { dates: ['2026-08-25'] } });
  assert.equal(r.rep.statusCode, 400);
  assert.equal(r.rep.payload.error, 'need_two_dates');
});

test('31일 초과면 400 too_many_dates', async () => {
  const dates = Array.from({ length: 32 }, (_, i) => '2026-07-' + String(i + 1).padStart(2, '0'));
  const r = await call('POST /api/period-summary/generate', { body: { dates } });
  assert.equal(r.rep.statusCode, 400);
  assert.equal(r.rep.payload.error, 'too_many_dates');
  assert.equal(r.rep.payload.max, 31);
});

test('형식이 잘못된 날짜(SQL 인젝션 문자열 포함)는 걸러진다', async () => {
  const r = await call('POST /api/period-summary/generate', {
    body: { dates: ["2026-08-25'; DROP TABLE users; --", 'not-a-date'] } });
  assert.equal(r.rep.statusCode, 400);
  assert.equal(r.rep.payload.error, 'need_two_dates');
  assert.equal((await query(`SELECT count(*)::int AS c FROM users`)).rows[0].c, 2, 'users 테이블 무사');
});

test('일자별 요약이 없는 날짜가 있으면 400 missing_dates 로 알려준다(AI 호출 없음)', async () => {
  await query(`DELETE FROM daily_summaries`);
  await seedDaily();
  const before = aiCalls.length;
  const r = await call('POST /api/period-summary/generate', { body: { dates: ['2026-08-25', '2026-08-27', '2026-08-31'] } });
  assert.equal(r.rep.statusCode, 400);
  assert.equal(r.rep.payload.error, 'missing_dates');
  assert.deepEqual(r.rep.payload.missing, ['2026-08-31']);
  assert.equal(aiCalls.length, before, 'AI 를 부르지 않음(토큰 낭비 방지)');
});

test('본문이 빈 일자별 요약도 missing 으로 취급', async () => {
  await query(`INSERT INTO daily_summaries (summary_date, content_md, digest, model, created_by)
               VALUES ('2026-08-28','   ','{}','m',1)`);
  const r = await call('POST /api/period-summary/generate', { body: { dates: ['2026-08-27', '2026-08-28'] } });
  assert.equal(r.rep.payload.error, 'missing_dates');
  assert.deepEqual(r.rep.payload.missing, ['2026-08-28']);
  await query(`DELETE FROM daily_summaries WHERE summary_date='2026-08-28'`);
});

// ── 생성 ──
test('생성: 일자별 요약 + 나의 기록이 시간순으로 프롬프트에 들어가고 1건 저장된다', async () => {
  await query(`DELETE FROM period_summaries`);
  aiCalls.length = 0;
  const r = await call('POST /api/period-summary/generate', {
    body: { dates: ['2026-08-27', '2026-08-25', '2026-08-26', '2026-08-25'], title: '  8월 4주차  ' } });
  assert.equal(r.rep.statusCode, 200);
  assert.equal(r.out.ok, true);
  assert.equal(r.out.regenerated, false);
  assert.equal(r.out.title, '8월 4주차', '제목 앞뒤 공백 제거');

  assert.equal(aiCalls.length, 1, 'AI 는 1회만(2차 요약)');
  const prompt = aiCalls[0].messages[0].content;
  assert.ok(prompt.indexOf('2026년 8월 25일') < prompt.indexOf('2026년 8월 27일'), '중복 제거 + 오름차순');
  assert.ok(prompt.includes('랙 재배치 시작') && prompt.includes('재배치 완료'), '나의 기록 원문 포함');
  assert.ok(prompt.includes('하나로 이어지는 기간 스토리'));
  assert.equal(aiCalls[0].max_tokens, 4000, '묶음은 출력 토큰 상향');

  const row = (await query(`SELECT * FROM period_summaries`)).rows;
  assert.equal(row.length, 1);
  assert.equal(row[0].dates_key, '2026-08-25,2026-08-26,2026-08-27');
  assert.equal(Number(row[0].day_count), 3);
  assert.equal(new Date(row[0].date_from).toISOString().slice(0, 10), '2026-08-25');
  assert.equal(row[0].content_md, '### 기간 한눈에\n- 스텁 요약');
});

test('생성: 기간 합계 stats 가 일자별 헤드라인의 합으로 저장된다', async () => {
  const st = (await query(`SELECT stats FROM period_summaries`)).rows[0].stats;
  assert.equal(st.journal, 2, '기록 2건(25·27일)');
  assert.equal(st.schedule, 6, '일정 2+1+3');
  assert.equal(st.quotes, 3);
  assert.equal(st.invoices, 1);
  assert.equal(st.txn_in, 12000);
});

test('생성: 같은 날짜 조합을 다시 묶으면 새 행이 아니라 갱신', async () => {
  const r = await call('POST /api/period-summary/generate', {
    body: { dates: ['2026-08-25', '2026-08-26', '2026-08-27'], title: '' } });
  assert.equal(r.out.regenerated, true);
  const rows = (await query(`SELECT title FROM period_summaries`)).rows;
  assert.equal(rows.length, 1, '중복 행 없음');
  assert.ok(rows[0].title.includes('~'), '제목을 비우면 기간 라벨이 제목이 됨');
});

test('생성: 날짜 조합이 다르면 별도 건', async () => {
  await call('POST /api/period-summary/generate', { body: { dates: ['2026-08-25', '2026-08-26'] } });
  assert.equal((await query(`SELECT count(*)::int AS c FROM period_summaries`)).rows[0].c, 2);
});

test('생성: 감사로그에 표준 액션(create)으로 남는다', async () => {
  const rows = (await query(`SELECT action, target FROM audit_log WHERE target LIKE 'period_summary:%' ORDER BY id`)).rows;
  assert.ok(rows.length >= 1);
  assert.equal(rows[0].action, 'create', '0057 CHECK 를 통과하는 표준 액션');
});

test('생성: AI 가 빈 응답이면 502, 저장하지 않는다', async () => {
  const before = (await query(`SELECT count(*)::int AS c FROM period_summaries`)).rows[0].c;
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ content: [] }) });
  const r = await call('POST /api/period-summary/generate', { body: { dates: ['2026-08-26', '2026-08-27'] } });
  globalThis.fetch = saved;
  assert.equal(r.rep.statusCode, 502);
  assert.equal(r.rep.payload.error, 'ai_empty');
  assert.equal((await query(`SELECT count(*)::int AS c FROM period_summaries`)).rows[0].c, before);
});

test('생성: AI 오류는 502 ai_failed 로 전달', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'rate_limited' } }) });
  const r = await call('POST /api/period-summary/generate', { body: { dates: ['2026-08-26', '2026-08-27'] } });
  globalThis.fetch = saved;
  assert.equal(r.rep.statusCode, 502);
  assert.equal(r.rep.payload.error, 'ai_failed');
  assert.equal(r.rep.payload.detail, 'rate_limited');
});

// ── 목록 · 단건 · 메모 · 삭제 ──
test('목록: 최근 기간이 위, 라벨·합계·작성자 포함', async () => {
  const r = await call('GET /api/period-summary/list');
  assert.ok(r.out.items.length >= 2);
  assert.ok(r.out.items[0].date_to >= r.out.items[1].date_to);
  const it = r.out.items.find((x) => x.day_count === 3);
  assert.ok(it.label.includes('~') && it.label.includes('(3일)'));
  assert.deepEqual(it.dates, ['2026-08-25', '2026-08-26', '2026-08-27']);
  assert.equal(it.created_by_name, 'Sebastian');
  assert.equal(it.stats.journal, 2);
  assert.equal(it.has_memo, false);
});

test('단건: 본문 + 날짜 목록 + 라벨', async () => {
  const id = (await query(`SELECT id FROM period_summaries WHERE day_count=3`)).rows[0].id;
  const r = await call('GET /api/period-summary/:id', { params: { id: String(id) } });
  assert.equal(r.out.content_md, '### 기간 한눈에\n- 스텁 요약');
  assert.equal(r.out.day_count, 3);
  assert.equal(r.out.memo, '');
});

test('단건: 잘못된 id 는 400, 없는 id 는 404', async () => {
  assert.equal((await call('GET /api/period-summary/:id', { params: { id: 'abc' } })).rep.statusCode, 400);
  assert.equal((await call('GET /api/period-summary/:id', { params: { id: '999999' } })).rep.statusCode, 404);
});

test('메모: 저장 → 재조회 시 유지 → 공백만 넣으면 비움', async () => {
  const id = String((await query(`SELECT id FROM period_summaries WHERE day_count=3`)).rows[0].id);
  await call('PUT /api/period-summary/:id/memo', { params: { id }, body: { memo: '다음 주 랙 2차 점검' } });
  let r = await call('GET /api/period-summary/:id', { params: { id } });
  assert.equal(r.out.memo, '다음 주 랙 2차 점검');
  const list = await call('GET /api/period-summary/list');
  assert.equal(list.out.items.find((x) => String(x.id) === id).has_memo, true);
  await call('PUT /api/period-summary/:id/memo', { params: { id }, body: { memo: '   ' } });
  r = await call('GET /api/period-summary/:id', { params: { id } });
  assert.equal(r.out.memo, '');
});

test('메모: 20,000자 초과는 413', async () => {
  const id = String((await query(`SELECT id FROM period_summaries WHERE day_count=3`)).rows[0].id);
  const r = await call('PUT /api/period-summary/:id/memo', { params: { id }, body: { memo: 'x'.repeat(20001) } });
  assert.equal(r.rep.statusCode, 413);
});

test('삭제: 목록에서 사라지고, 일자별 요약은 그대로 남는다', async () => {
  const id = String((await query(`SELECT id FROM period_summaries WHERE day_count=3`)).rows[0].id);
  const r = await call('DELETE /api/period-summary/:id', { params: { id } });
  assert.equal(r.out.ok, true);
  const left = (await query(`SELECT count(*)::int AS c FROM period_summaries WHERE id=$1`, [id])).rows[0].c;
  assert.equal(left, 0);
  assert.equal((await query(`SELECT count(*)::int AS c FROM daily_summaries`)).rows[0].c, 3, '일자별 요약 무회귀');
});

test('삭제: 없는 id 는 404', async () => {
  assert.equal((await call('DELETE /api/period-summary/:id', { params: { id: '999999' } })).rep.statusCode, 404);
});

// ── 기존 일자별 라우트 무회귀 ──
test('기존 일자별 라우트가 그대로 남아 있다', () => {
  for (const k of ['POST /api/daily-summary/generate', 'GET /api/daily-summary/list',
    'GET /api/daily-summary/:date', 'PUT /api/daily-summary/:date/memo', 'DELETE /api/daily-summary/:date',
    'GET /api/daily-summary/wa/status', 'POST /api/daily-summary/wa/send']) {
    assert.ok(R[k], k);
  }
});

test('일자별 목록: stats 에 journal 이 추가돼도 기존 필드 유지', async () => {
  const r = await call('GET /api/daily-summary/list');
  const it = r.out.items.find((x) => x.summary_date === '2026-08-25');
  assert.equal(it.stats.journal, 1);
  assert.equal(it.stats.quotes, 3);
});

// ── 나의 기록 수집(collectDayDigest) ──
test('collectDayDigest: 그날의 나의 기록을 작성자와 함께 수집한다', async () => {
  const { collectDayDigest } = await import('../src/routes/dailySummaryRoutes.js');
  await query(`INSERT INTO calendar_journal (user_id, entry_date, content) VALUES
    (1,'2026-08-27','수요일 일지 본문'),(2,'2026-08-27',''),(1,'2026-08-26','화요일 일지')`);
  const dg = await collectDayDigest('2026-08-27');
  assert.equal(dg.journal.length, 1, '빈 내용 제외 · 다른 날짜 제외');
  assert.equal(dg.journal[0].content, '수요일 일지 본문');
  assert.equal(dg.journal[0].author, 'Sebastian');
  assert.ok(!dg.errors.includes('journal'), '수집 오류 없음');
});

test('collectDayDigest: DAILY_SUMMARY_JOURNAL=0 이면 기록을 읽지 않는다', async () => {
  const { collectDayDigest } = await import('../src/routes/dailySummaryRoutes.js');
  process.env.DAILY_SUMMARY_JOURNAL = '0';
  const dg = await collectDayDigest('2026-08-27');
  delete process.env.DAILY_SUMMARY_JOURNAL;
  assert.deepEqual(dg.journal, []);
});

test('collectDayDigest: calendar_journal 테이블이 없어도 나머지 수집은 계속된다', async () => {
  const { collectDayDigest } = await import('../src/routes/dailySummaryRoutes.js');
  await query(`ALTER TABLE calendar_journal RENAME TO calendar_journal_bak`);
  const dg = await collectDayDigest('2026-08-27');
  await query(`ALTER TABLE calendar_journal_bak RENAME TO calendar_journal`);
  assert.deepEqual(dg.journal, []);
  assert.ok(dg.errors.includes('journal'), '해당 섹션만 오류로 표시');
  assert.ok(Array.isArray(dg.schedule), '다른 섹션은 계속 수집');
});
