// =====================================================================
// 현장조사 소진분석 (영업 > 현장조사 소진분석) — 실 PostgreSQL 종단 검증
//   · 실행 조건: TEST_PG_URL 환경변수(실 Postgres + 전체 마이그레이션 적용 DB).
//     없으면 skip — CI/로컬에서 무해하게 통과.
//   · 검증 대상: GET /api/field-surveys/history · GET /api/field-surveys/consumption
//     핵심 등식 = 누적구매(A) − 현장잔량(B) = 소진량, 그리고 그 경계 케이스들.
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL;
const SKIP = !PG;
if (SKIP) console.log('[skip] TEST_PG_URL 없음 — 실 Postgres 검증 생략');
if (PG) process.env.DATABASE_URL = PG;

let query, fieldSurveyRoutes, Fastify, jwt, app, tok = {};
const IDS = {};

async function boot() {
  ({ query } = await import('../src/db.js'));
  fieldSurveyRoutes = (await import('../src/routes/fieldSurveyRoutes.js')).default;
  Fastify = (await import('fastify')).default;
  jwt = (await import('@fastify/jwt')).default;

  // ── 픽스처 (스키마는 건드리지 않고 행만 넣는다) ──────────────────
  await query(`DELETE FROM field_survey_lines WHERE survey_id IN (SELECT id FROM field_surveys WHERE note = 'FSTEST')`);
  await query(`DELETE FROM field_surveys WHERE note = 'FSTEST'`);
  await query(`DELETE FROM sales_invoice_lines WHERE invoice_id IN (SELECT id FROM sales_invoices WHERE memo = 'FSTEST')`);
  await query(`DELETE FROM sales_invoices WHERE memo = 'FSTEST'`);
  await query(`DELETE FROM products WHERE code LIKE 'FST%'`);
  await query(`DELETE FROM customers WHERE code LIKE 'FSTC%'`);
  await query(`DELETE FROM user_page_access WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'fstest%')`);
  await query(`DELETE FROM users WHERE login_id LIKE 'fstest%'`);

  const team = (await query(`SELECT id FROM sales_teams WHERE name = 'FSTEST팀'`)).rows[0]
    || (await query(`INSERT INTO sales_teams (name) VALUES ('FSTEST팀') RETURNING id`)).rows[0];
  IDS.team = Number(team.id);

  const dir = (await query(
    `INSERT INTO users (name, role, pin_hash, login_id, team_id) VALUES ('테스트디렉터','director','x','fstest_dir',$1) RETURNING id`,
    [IDS.team])).rows[0];
  const sal = (await query(
    `INSERT INTO users (name, role, pin_hash, login_id, team_id) VALUES ('테스트영업','sales','x','fstest_sal',$1) RETURNING id`,
    [IDS.team])).rows[0];
  const oth = (await query(
    `INSERT INTO users (name, role, pin_hash, login_id, team_id) VALUES ('타영업','sales','x','fstest_oth',$1) RETURNING id`,
    [IDS.team])).rows[0];
  IDS.dir = Number(dir.id); IDS.sal = Number(sal.id); IDS.oth = Number(oth.id);
  // 영업 계정에 현장조사/견적 열람 권한 부여(엔드포인트는 authGuard 만 쓰지만 실제 계정 형태를 맞춘다)
  for (const pk of ['quote', 'customers']) {
    await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access)
                 VALUES ($1,$2,'anywhere','edit') ON CONFLICT DO NOTHING`, [IDS.sal, pk]);
  }

  const cust = (await query(
    `INSERT INTO customers (code, name, discount, team_id) VALUES ('FSTC1','현장테스트고객',10,$1) RETURNING id`,
    [IDS.team])).rows[0];
  IDS.cust = Number(cust.id);

  // 제품 5종
  //  A 구매100 잔량 0  → 완전소진(계수됨)      소진 100
  //  B 구매 80 잔량20  → 부분소진             소진  60
  //  C 구매 50 잔량50  → 미소진(kept)         소진   0
  //  D 구매 40 (조사에 없음) → 전량소진 가정   소진  40
  //  E 구매  0 잔량 12 → 구매이력 없음(타 경로) 소진 계산 제외
  //  F 구매 30 잔량45  → 이상(B>A)            소진 0, anomaly
  //  G 구매 25 잔량 0  → 완전소진이지만 비활성 SKU (오퍼 차단 대상)
  const P = {};
  for (const [k, price, active] of [['A', 100, true], ['B', 200, true], ['C', 50, true],
    ['D', 300, true], ['E', 10, true], ['F', 70, true], ['G', 90, false]]) {
    const r = (await query(
      `INSERT INTO products (code, name, app, list_price, stock_qty, is_active)
       VALUES ($1,$2,'적용차종',$3,500,$4) RETURNING id`, [`FST${k}`, `제품${k}`, price, active])).rows[0];
    P[k] = Number(r.id);
  }
  IDS.P = P;

  async function invoice(dateStr, lines) {
    const inv = (await query(
      `INSERT INTO sales_invoices (customer_id, inv_date, status, memo, owner_id)
       VALUES ($1,$2,'posted','FSTEST',$3) RETURNING id`, [IDS.cust, dateStr, IDS.sal])).rows[0];
    for (const [pid, qty] of lines) {
      await query(
        `INSERT INTO sales_invoice_lines (invoice_id, product_id, qty, list_price, discount_rate, unit_price, line_amount_mxn)
         VALUES ($1,$2,$3,100,0,100,$4)`, [inv.id, pid, qty, 100 * qty]);
    }
    return Number(inv.id);
  }
  // 두 번에 나눠 사서 「누적」이 합산되는지도 같이 본다
  await invoice('2026-01-10', [[P.A, 60], [P.B, 80], [P.C, 50], [P.D, 40], [P.F, 30], [P.G, 25]]);
  await invoice('2026-05-20', [[P.A, 40]]);
  // 삭제/미게시 인보이스는 누적에 들어가면 안 된다
  const bad = (await query(
    `INSERT INTO sales_invoices (customer_id, inv_date, status, memo) VALUES ($1,'2026-06-01','deleted','FSTEST') RETURNING id`,
    [IDS.cust])).rows[0];
  await query(`INSERT INTO sales_invoice_lines (invoice_id, product_id, qty, list_price, discount_rate, unit_price, line_amount_mxn)
               VALUES ($1,$2,999,100,0,100,99900)`, [bad.id, P.A]);

  // 조사 2건 — 오래된 것(참고용) + 최신(기준)
  const old = (await query(
    `INSERT INTO field_surveys (customer_id, customer_name, survey_date, status, note, created_by, geo_lat, geo_lng)
     VALUES ($1,'현장테스트고객','2026-03-01','completed','FSTEST',$2,19.4,-99.1) RETURNING id`,
    [IDS.cust, IDS.sal])).rows[0];
  const cur = (await query(
    `INSERT INTO field_surveys (customer_id, customer_name, survey_date, status, note, created_by, geo_lat, geo_lng)
     VALUES ($1,'현장테스트고객','2026-08-15','completed','FSTEST',$2,19.4,-99.1) RETURNING id`,
    [IDS.cust, IDS.sal])).rows[0];
  IDS.oldSurvey = Number(old.id); IDS.survey = Number(cur.id);

  async function line(sid, no, code, pid, obs, cls) {
    await query(
      `INSERT INTO field_survey_lines (survey_id, line_no, input_code, product_id, ctr_code, product_name, match_source, observed_qty, classification)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [sid, no, code, pid, pid ? code : null, pid ? code : null, pid ? 'ctr' : 'none', obs, cls]);
  }
  // 오래된 조사(잔량이 다름 — 최신 조사만 기준이 되는지 확인용)
  await line(IDS.oldSurvey, 1, 'FSTA', P.A, 55, 'imm');
  // 기준 조사
  await line(IDS.survey, 1, 'FSTA', P.A, 0, 'imm');
  await line(IDS.survey, 2, 'FSTB', P.B, 12, 'imm');
  await line(IDS.survey, 3, 'FSTB', P.B, 8, 'imm');   // 같은 제품 두 줄 → 합산 20 이어야 함
  await line(IDS.survey, 4, 'FSTC', P.C, 50, 'imm');
  await line(IDS.survey, 5, 'FSTE', P.E, 12, 'imm');
  await line(IDS.survey, 6, 'FSTF', P.F, 45, 'imm');
  await line(IDS.survey, 7, 'FSTG', P.G, 0, 'imm');
  await line(IDS.survey, 8, 'TRW-9911', null, 3, 'dev');   // 경쟁사 코드
  await line(IDS.survey, 9, 'MOOG-77', null, 5, 'dev');

  // 타인 조사(권한 격리 확인)
  const foreign = (await query(
    `INSERT INTO field_surveys (customer_id, customer_name, survey_date, status, note, created_by)
     VALUES ($1,'현장테스트고객','2026-08-18','completed','FSTEST',$2) RETURNING id`,
    [IDS.cust, IDS.oth])).rows[0];
  IDS.foreign = Number(foreign.id);
  await line(IDS.foreign, 1, 'FSTA', P.A, 99, 'imm');

  // ── 앱 부팅 ──────────────────────────────────────────────────────
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret' });
  await app.register(fieldSurveyRoutes);
  await app.ready();
  tok.dir = app.jwt.sign({ sub: IDS.dir });
  tok.sal = app.jwt.sign({ sub: IDS.sal });
  tok.oth = app.jwt.sign({ sub: IDS.oth });
}

async function get(path, who = 'sal') {
  const res = await app.inject({ method: 'GET', url: path, headers: { authorization: 'Bearer ' + tok[who] } });
  return { code: res.statusCode, body: JSON.parse(res.body || '{}') };
}
const byCode = (items, c) => items.find((i) => i.ctr_code === c);

test('현장조사 소진분석 — 실 Postgres 종단', { skip: SKIP }, async (t) => {
  await boot();

  await t.test('① 조사 이력: 날짜 최신순 + 계수 SKU/수량 요약', async () => {
    const { code, body } = await get('/api/field-surveys/history?customer_id=' + IDS.cust);
    assert.equal(code, 200);
    const mine = body.items.filter((s) => s.id === IDS.survey || s.id === IDS.oldSurvey || s.id === IDS.foreign);
    // 영업 계정 → 본인 조사만(타인 조사 제외)
    assert.ok(!mine.some((s) => s.id === IDS.foreign), '타인 조사가 보이면 안 됨');
    assert.equal(body.items[0].id, IDS.survey, '최신 조사가 맨 위');
    const cur = byId(body.items, IDS.survey);
    assert.equal(cur.survey_date, '2026-08-15');
    assert.equal(cur.sku_count, 6, '매칭 SKU 종수 = A,B,C,E,F,G');
    assert.equal(cur.obs_qty, 0 + 12 + 8 + 50 + 12 + 45 + 0, '관측수량 합');
    assert.equal(cur.counts.dev, 2, '경쟁사 코드 2건');
    assert.equal(cur.creator_name, '테스트영업');
  });

  await t.test('② 디렉터는 전체 조사 열람', async () => {
    const { body } = await get('/api/field-surveys/history?customer_id=' + IDS.cust, 'dir');
    assert.ok(body.items.some((s) => s.id === IDS.foreign), '디렉터에게는 타인 조사도 보여야 함');
  });

  await t.test('③ 기준 조사 = 고객별 최신 조사 자동', async () => {
    const { code, body } = await get('/api/field-surveys/consumption?customer_id=' + IDS.cust);
    assert.equal(code, 200);
    assert.equal(body.survey.id, IDS.survey, '2026-08-15 조사가 기준');
    assert.equal(body.customer.discount, 10);
    assert.equal(body.surveys.length, 2, '본인 조사 이력 2건');
  });

  await t.test('④ 핵심 등식: 누적구매 − 현장잔량 = 소진량', async () => {
    const { body } = await get('/api/field-surveys/consumption?customer_id=' + IDS.cust);
    const A = byCode(body.items, 'FSTA');
    assert.equal(A.purchased_qty, 100, '두 인보이스 60+40 누적 (삭제 인보이스 999 제외)');
    assert.equal(A.onhand_qty, 0);
    assert.equal(A.consumed_qty, 100);
    assert.equal(A.consumed_pct, 100);
    assert.equal(A.status, 'gone');

    const B = byCode(body.items, 'FSTB');
    assert.equal(B.onhand_qty, 20, '같은 제품 두 줄(12+8) 합산');
    assert.equal(B.purchased_qty, 80);
    assert.equal(B.consumed_qty, 60);
    assert.equal(B.consumed_pct, 75);
    assert.equal(B.status, 'partial');

    const C = byCode(body.items, 'FSTC');
    assert.equal(C.consumed_qty, 0);
    assert.equal(C.status, 'kept');
  });

  await t.test('⑤ 조사에 없는 구매 SKU = 전량 소진 + counted:false 로 구분', async () => {
    const { body } = await get('/api/field-surveys/consumption?customer_id=' + IDS.cust);
    const D = byCode(body.items, 'FSTD');
    assert.equal(D.counted, false);
    assert.equal(D.onhand_qty, 0);
    assert.equal(D.consumed_qty, 40);
    assert.equal(D.status, 'gone_uncounted', '계수 안 된 완전소진은 따로 표시');
  });

  await t.test('⑥ 구매이력 없는 창고 재고 = no_purchase (소진 합계에서 제외)', async () => {
    const { body } = await get('/api/field-surveys/consumption?customer_id=' + IDS.cust);
    const E = byCode(body.items, 'FSTE');
    assert.equal(E.purchased_qty, 0);
    assert.equal(E.onhand_qty, 12);
    assert.equal(E.consumed_qty, 0);
    assert.equal(E.status, 'no_purchase');
  });

  await t.test('⑦ 잔량 > 누적구매 = anomaly (소진 0, 음수 금지)', async () => {
    const { body } = await get('/api/field-surveys/consumption?customer_id=' + IDS.cust);
    const F = byCode(body.items, 'FSTF');
    assert.equal(F.purchased_qty, 30);
    assert.equal(F.onhand_qty, 45);
    assert.equal(F.consumed_qty, 0, '음수가 나오면 안 됨');
    assert.equal(F.status, 'anomaly');
  });

  await t.test('⑧ 합계: 전체 구매 − 남아있는 것', async () => {
    const { body } = await get('/api/field-surveys/consumption?customer_id=' + IDS.cust);
    const t2 = body.totals;
    assert.equal(t2.purchased_sku, 6, 'A,B,C,D,F,G');
    assert.equal(t2.purchased_qty, 100 + 80 + 50 + 40 + 30 + 25);
    assert.equal(t2.onhand_qty, 0 + 20 + 50 + 12 + 45 + 0, '조사 관측 총량(E 포함)');
    assert.equal(t2.consumed_qty, 100 + 60 + 0 + 40 + 0 + 25);
    assert.equal(t2.consumed_sku, 4, 'A,B,D,G');
    assert.equal(t2.uncounted_sku, 1, 'D');
    assert.equal(t2.no_purchase, 1, 'E');
    assert.equal(t2.anomaly, 1, 'F');
    assert.equal(t2.unmatched, 2);
    assert.equal(t2.unmatched_qty, 8);
    assert.equal(t2.inactive_sku, 1, 'G — 비활성이라 견적에 담기면 409');
    // 소진율 = 소진 ÷ 누적구매
    assert.equal(t2.consumed_pct, Math.round((225 / 325) * 1000) / 10);
  });

  await t.test('⑨ 정렬 = 소진수량 내림차순', async () => {
    const { body } = await get('/api/field-surveys/consumption?customer_id=' + IDS.cust);
    const q = body.items.map((i) => i.consumed_qty);
    for (let i = 1; i < q.length; i++) assert.ok(q[i - 1] >= q[i], '소진수량 내림차순');
    assert.equal(body.items[0].ctr_code, 'FSTA');
  });

  await t.test('⑩ 경쟁사 코드는 별도 섹션 (소진 계산 대상 아님)', async () => {
    const { body } = await get('/api/field-surveys/consumption?customer_id=' + IDS.cust);
    assert.equal(body.unmatched.length, 2);
    assert.deepEqual(body.unmatched.map((u) => u.input_code).sort(), ['MOOG-77', 'TRW-9911']);
    assert.ok(!body.items.some((i) => i.ctr_code === null), '미매칭 코드가 소진표에 섞이면 안 됨');
  });

  await t.test('⑪ survey_id 지정 시 그 조사가 기준 (과거 조사 재분석)', async () => {
    const { body } = await get('/api/field-surveys/consumption?survey_id=' + IDS.oldSurvey);
    assert.equal(body.survey.id, IDS.oldSurvey);
    const A = byCode(body.items, 'FSTA');
    assert.equal(A.onhand_qty, 55);
    assert.equal(A.consumed_qty, 45, '100 − 55');
  });

  await t.test('⑫ 권한: 남의 조사는 403, 팀 밖 고객은 차단', async () => {
    const r1 = await get('/api/field-surveys/consumption?survey_id=' + IDS.foreign, 'sal');
    assert.equal(r1.code, 403);
    const r2 = await get('/api/field-surveys/consumption?survey_id=' + IDS.foreign, 'dir');
    assert.equal(r2.code, 200, '디렉터는 열람 가능');
  });

  await t.test('⑬ 미등록(게스트) 고객 조사는 400 안내', async () => {
    const g = (await query(
      `INSERT INTO field_surveys (customer_name, discount_rate, survey_date, status, note, created_by)
       VALUES ('미등록가게',5,'2026-08-16','completed','FSTEST',$1) RETURNING id`, [IDS.sal])).rows[0];
    const { code, body } = await get('/api/field-surveys/consumption?survey_id=' + g.id);
    assert.equal(code, 400);
    assert.equal(body.error, 'guest_customer');
  });

  await t.test('⑭ 조사가 없는 고객은 404 no_survey', async () => {
    const c2 = (await query(
      `INSERT INTO customers (code, name, discount, team_id) VALUES ('FSTC2','조사없는고객',0,$1) RETURNING id`,
      [IDS.team])).rows[0];
    const { code, body } = await get('/api/field-surveys/consumption?customer_id=' + c2.id);
    assert.equal(code, 404);
    assert.equal(body.error, 'no_survey');
  });

  await t.test('⑮ 기존 조사 조회(회귀) — 기존 엔드포인트 정상', async () => {
    const { code, body } = await get('/api/field-surveys/' + IDS.survey);
    assert.equal(code, 200);
    assert.equal(body.lines.length, 9);
    assert.equal(body.summary.counts.dev, 2);
  });

  await app.close();
  const { pool } = await import('../src/db.js');
  await pool.end();
});

function byId(items, id) { return items.find((i) => i.id === id); }
