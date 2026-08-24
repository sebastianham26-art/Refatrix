// =====================================================================
// 제품 이력 (제품·마케팅 > 제품 > 📜 제품 이력) — 실 PostgreSQL 종단 검증
//   · 실행 조건: TEST_PG_URL(실 Postgres + 전체 마이그레이션 적용 DB). 없으면 skip.
//   · 검증 대상: GET /api/products/history · GET /api/products/:id/movements
//     핵심: 두 로그(마스터 변경 · 판매상태 전환)의 통합/중복제거, 그 시점 Estado 산출,
//           변경 이후 movement 만 보이는지, 재고 역산, 팀 가시성, 가격 권한 마스킹.
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL;
const SKIP = !PG;
if (SKIP) console.log('[skip] TEST_PG_URL 없음 — 실 Postgres 검증 생략');
if (PG) process.env.DATABASE_URL = PG;

let query, productRoutes, Fastify, jwt, app;
const tok = {};
const ID = {};

const T = (s) => `2026-0${s}`;          // 편의: 날짜 문자열

async function boot() {
  ({ query } = await import('../src/db.js'));
  productRoutes = (await import('../src/routes/productRoutes.js')).default;
  Fastify = (await import('fastify')).default;
  jwt = (await import('@fastify/jwt')).default;

  // ── 정리(재실행 멱등) — FK 순서대로 ────────────────────────────────
  await query(`DELETE FROM product_change_log WHERE code LIKE 'PHT%'`);
  await query(`DELETE FROM product_status_log WHERE code LIKE 'PHT%'`);
  await query(`DELETE FROM stock_movements WHERE product_id IN (SELECT id FROM products WHERE code LIKE 'PHT%')`);
  await query(`DELETE FROM quote_lines WHERE quote_id IN (SELECT id FROM quotes WHERE memo='PHTEST')`);
  await query(`DELETE FROM quotes WHERE memo='PHTEST'`);
  await query(`DELETE FROM sales_invoice_lines WHERE invoice_id IN (SELECT id FROM sales_invoices WHERE memo='PHTEST')`);
  await query(`DELETE FROM sales_invoices WHERE memo='PHTEST'`);
  await query(`DELETE FROM product_syd_codes WHERE product_id IN (SELECT id FROM products WHERE code LIKE 'PHT%')`);
  await query(`DELETE FROM products WHERE code LIKE 'PHT%'`);
  await query(`DELETE FROM customers WHERE code LIKE 'PHTC%'`);
  await query(`DELETE FROM user_field_access WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'phtest%')`);
  await query(`DELETE FROM user_page_access  WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'phtest%')`);
  await query(`DELETE FROM users WHERE login_id LIKE 'phtest%'`);
  await query(`DELETE FROM sales_teams WHERE name LIKE 'PHTEST%'`);

  const t1 = (await query(`INSERT INTO sales_teams (name) VALUES ('PHTEST팀A') RETURNING id`)).rows[0];
  const t2 = (await query(`INSERT INTO sales_teams (name) VALUES ('PHTEST팀B') RETURNING id`)).rows[0];
  ID.teamA = Number(t1.id); ID.teamB = Number(t2.id);

  const mkUser = async (name, role, login, team) => Number((await query(
    `INSERT INTO users (name, role, pin_hash, login_id, team_id) VALUES ($1,$2,'x',$3,$4) RETURNING id`,
    [name, role, login, team])).rows[0].id);
  ID.dir = await mkUser('테스트디렉터', 'director', 'phtest_dir', ID.teamA);
  ID.sal = await mkUser('테스트영업', 'sales', 'phtest_sal', ID.teamA);      // 가격 권한 없음
  ID.salP = await mkUser('가격영업', 'sales', 'phtest_salp', ID.teamA);      // 가격 권한 있음
  for (const uid of [ID.sal, ID.salP]) {
    await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access)
                 VALUES ($1,'products','anywhere','view') ON CONFLICT DO NOTHING`, [uid]);
  }
  await query(`INSERT INTO user_field_access (user_id, field_key, visible) VALUES ($1,'sale_price',true)
               ON CONFLICT DO NOTHING`, [ID.salP]);

  const mkCust = async (code, name, team) => Number((await query(
    `INSERT INTO customers (code, name, team_id, discount, credit_days) VALUES ($1,$2,$3,10,30) RETURNING id`,
    [code, name, team])).rows[0].id);
  ID.custA = await mkCust('PHTC1', '내팀고객', ID.teamA);
  ID.custB = await mkCust('PHTC2', '타팀고객', ID.teamB);

  // 제품 2종 — P1 이 주인공(재고 현재 70), P2 는 필터 격리 확인용
  const mkProd = async (code, scode, stock, active) => Number((await query(
    `INSERT INTO products (code, name, scode, list_price, stock_qty, avg_cost, is_active)
     VALUES ($1,$1,$2,100,$3,40,$4) RETURNING id`, [code, scode, stock, active])).rows[0].id);
  ID.p1 = await mkProd('PHT-A', 'SYD-100 // SYD-101', 70, false);
  ID.p2 = await mkProd('PHT-B', 'SYD-200', 10, true);

  // ── 이력 픽스처 ────────────────────────────────────────────────────
  const chg = async (pid, code, action, source, changes, who, at) => query(
    `INSERT INTO product_change_log (product_id, code, action, source, changes, changed_by, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`, [pid, code, action, source, changes ? JSON.stringify(changes) : null, who, at]);
  const stat = async (pid, code, action, reason, who, at, checkId = null) => query(
    `INSERT INTO product_status_log (product_id, code, action, reason, check_id, changed_by, changed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`, [pid, code, action, reason, checkId, who, at]);

  // 시간순: 01-05 생성 → 02-10 가격수정 → 03-15 비활성 → 04-20 SyD 수정 → 05-25 활성 → 06-30 이름수정
  await chg(ID.p1, 'PHT-A', 'create', 'manual',
    { code: { from: null, to: 'PHT-A' }, name: { from: null, to: 'PHT-A' }, list_price: { from: null, to: 100 } },
    ID.dir, '2026-01-05T10:00:00Z');
  await chg(ID.p1, 'PHT-A', 'update', 'import',
    { list_price: { from: 100, to: 120 }, iva_rate: { from: 16, to: 8 } }, ID.dir, '2026-02-10T10:00:00Z');
  await stat(ID.p1, 'PHT-A', 'deactivate', '단종 — 공장 생산중단', ID.dir, '2026-03-15T10:00:00Z');
  // ⚠ 한 건씩 전환은 change_log 에도 source='status' 로 같이 남는다 → 통합 목록에서 중복이면 안 됨
  await chg(ID.p1, 'PHT-A', 'update', 'status',
    { is_active: { from: true, to: false }, reason: '단종 — 공장 생산중단' }, ID.dir, '2026-03-15T10:00:00Z');
  await chg(ID.p1, 'PHT-A', 'update', 'manual',
    { scode: { from: 'SYD-100', to: 'SYD-100 // SYD-101' }, _syd: { from: ['SYD-100'], to: ['SYD-100', 'SYD-101'] } },
    ID.sal, '2026-04-20T10:00:00Z');
  await stat(ID.p1, 'PHT-A', 'activate', '재고 소진용 판매재개', ID.dir, '2026-05-25T10:00:00Z');
  await chg(ID.p1, 'PHT-A', 'update', 'manual',
    { name: { from: 'PHT-A', to: 'PHT-A 개정' } }, ID.dir, '2026-06-30T10:00:00Z');
  // 마지막 상태: 다시 비활성(현재 products.is_active=false 와 일치)
  await stat(ID.p1, 'PHT-A', 'deactivate', '최종 단종', ID.dir, '2026-07-10T10:00:00Z');
  // 다른 제품 1건(필터 격리)
  await chg(ID.p2, 'PHT-B', 'create', 'manual', { code: { from: null, to: 'PHT-B' } }, ID.dir, '2026-02-01T10:00:00Z');

  // ── movement 픽스처 (기준 변경시각 = 2026-03-15) ────────────────────
  const mv = async (pid, type, qty, at, ref, source) => query(
    `INSERT INTO stock_movements (product_id, move_type, qty, ref, source, moved_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`, [pid, type, qty, ref, source, at, ID.dir]);
  await mv(ID.p1, 'in', 100, '2026-01-20T10:00:00Z', 'batch:before', 'import');   // 변경 전 — 보이면 안 됨
  await mv(ID.p1, 'out', 20, '2026-04-01T10:00:00Z', 'inv:after1', 'sale');       // 변경 후
  await mv(ID.p1, 'in', 5, '2026-05-01T10:00:00Z', 'batch:after2', 'import');     // 변경 후
  await mv(ID.p1, 'adjust', -15, '2026-06-01T10:00:00Z', '재고조정', 'manual');    // 변경 후(음수 조정)
  // 재고 역산: 현재 70 − (−20 +5 −15) = 70 − (−30) = 100 ← 변경 시점 재고

  const inv = async (cust, date, qty, createdAt, pid = ID.p1, status = 'posted') => {
    const i = (await query(
      `INSERT INTO sales_invoices (customer_id, inv_date, status, memo, created_at)
       VALUES ($1,$2,$4,'PHTEST',$3) RETURNING id`, [cust, date, createdAt, status])).rows[0];
    await query(
      `INSERT INTO sales_invoice_lines (invoice_id, product_id, qty, list_price, discount_rate, unit_price, line_amount_mxn)
       VALUES ($1,$2,$3,100,0,100,$4)`, [i.id, pid, qty, 100 * qty]);
    return Number(i.id);
  };
  ID.invBefore = await inv(ID.custA, '2026-02-01', 7, '2026-02-01T10:00:00Z');   // 변경 전
  ID.invAfterA = await inv(ID.custA, '2026-04-01', 20, '2026-04-01T10:00:00Z');  // 변경 후 · 내 팀
  ID.invAfterB = await inv(ID.custB, '2026-04-05', 30, '2026-04-05T10:00:00Z');  // 변경 후 · 타 팀
  // 매출일은 과거인데 ERP 입력은 나중 — created_at 으로 자르면 「변경 이후」에 잘못 끼던 케이스
  ID.invLateEntry = await inv(ID.custA, '2026-01-15', 4, '2026-06-20T10:00:00Z');
  // 승인 대기 — 매출 집계에서 빠지되 안내는 떠야 함
  ID.invPending = await inv(ID.custA, '2026-04-02', 9, '2026-04-02T10:00:00Z', ID.p1, 'edit_pending');
  // CE0536R 재현: 판매가 전부 「변경 이전」인 제품 — 구간 0 · 전체 5
  ID.invP2 = await inv(ID.custA, '2026-01-20', 5, '2026-01-20T10:00:00Z', ID.p2);

  const quo = async (cust, no, qty, createdAt) => {
    const q = (await query(
      `INSERT INTO quotes (quote_no, customer_id, quote_date, status, memo, created_at)
       VALUES ($1,$2,$3,'draft','PHTEST',$4) RETURNING id`, [no, cust, createdAt.slice(0, 10), createdAt])).rows[0];
    await query(
      `INSERT INTO quote_lines (quote_id, line_no, product_id, ctr_code, qty, list_price, final_price, line_subtotal)
       VALUES ($1,1,$2,'PHT-A',$3,100,90,$4)`, [q.id, ID.p1, qty, 90 * qty]);
    return Number(q.id);
  };
  ID.quoBefore = await quo(ID.custA, 'PHT-Q0', 3, '2026-02-05T10:00:00Z');
  ID.quoAfter = await quo(ID.custA, 'PHT-Q1', 12, '2026-04-10T10:00:00Z');
  ID.quoLate = await quo(ID.custA, 'PHT-Q2', 4, '2026-06-10T10:00:00Z');

  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret' });
  await app.register(productRoutes);
  await app.ready();
  tok.dir = app.jwt.sign({ sub: ID.dir });
  tok.sal = app.jwt.sign({ sub: ID.sal });
  tok.salP = app.jwt.sign({ sub: ID.salP });
}

async function get(path, who = 'dir') {
  const res = await app.inject({ method: 'GET', url: path, headers: { authorization: 'Bearer ' + tok[who] } });
  return { code: res.statusCode, body: JSON.parse(res.body || '{}') };
}
const mine = (items) => items.filter((r) => String(r.code || '').startsWith('PHT'));

test('제품 이력 — 실 Postgres 종단', { skip: SKIP }, async (t) => {
  await boot();

  await t.test('① 통합 피드: 마스터 변경 + 상태 전환이 한 표에 최신순', async () => {
    const { code, body } = await get(`/api/products/history?product_id=${ID.p1}&limit=50`);
    assert.equal(code, 200);
    const items = body.items;
    assert.equal(items.length, 7, '중복 제외 7건 (마스터 4 + 상태 3)');
    const ts = items.map((r) => new Date(r.changed_at).getTime());
    assert.deepEqual(ts, [...ts].sort((a, b) => b - a), '최신순 정렬');
    assert.equal(items[0].kind, 'status');
    assert.equal(items[0].action, 'deactivate');
    assert.equal(items[items.length - 1].action, 'create');
  });

  await t.test('② 중복 제거: source=status 인 change_log 는 상태 전환 줄과 겹치지 않는다', async () => {
    const { body } = await get(`/api/products/history?product_id=${ID.p1}&limit=50`);
    const at0315 = body.items.filter((r) => String(r.changed_at).startsWith('2026-03-15'));
    assert.equal(at0315.length, 1, '2026-03-15 전환은 한 줄만');
    assert.equal(at0315[0].kind, 'status');
    assert.equal(at0315[0].reason, '단종 — 공장 생산중단');
    assert.ok(!body.items.some((r) => r.kind === 'master' && r.source === 'status'),
      'change_log 의 source=status 잔재 없음(상태 전환은 status 피드에서만)');
  });

  await t.test('③ Estado — 그 변경 직후 상태를 표시', async () => {
    const { body } = await get(`/api/products/history?product_id=${ID.p1}&limit=50`);
    const at = (d) => body.items.find((r) => String(r.changed_at).startsWith(d));
    assert.equal(at('2026-01-05').estado_active, true, '생성 시점 = 활성(기본값)');
    assert.equal(at('2026-02-10').estado_active, true, '비활성 전 수정 = 활성');
    assert.equal(at('2026-03-15').estado_active, false, '비활성 전환');
    assert.equal(at('2026-04-20').estado_active, false, '비활성 기간 중 수정 = 비활성');
    assert.equal(at('2026-05-25').estado_active, true, '재활성');
    assert.equal(at('2026-06-30').estado_active, true, '재활성 이후 수정 = 활성');
    assert.equal(at('2026-07-10').estado_active, false, '최종 비활성');
    assert.equal(at('2026-07-10').current_active, false, '현재 마스터 상태도 비활성');
  });

  await t.test('④ SYD Code — 바꾼 줄은 바뀐 값, 아닌 줄은 현재 마스터 값', async () => {
    const { body } = await get(`/api/products/history?product_id=${ID.p1}&limit=50`);
    const at = (d) => body.items.find((r) => String(r.changed_at).startsWith(d));
    assert.equal(at('2026-04-20').syd_codes, 'SYD-100 // SYD-101', 'SyD 를 바꾼 줄');
    assert.equal(at('2026-01-05').syd_codes, 'SYD-100 // SYD-101', '건드리지 않은 줄은 현재 값');
  });

  await t.test('⑤ 변경내역 설명 문자열', async () => {
    const { body } = await get(`/api/products/history?product_id=${ID.p1}&limit=50`);
    const at = (d) => body.items.find((r) => String(r.changed_at).startsWith(d));
    assert.match(at('2026-02-10').desc, /List Price: 100 → 120/);
    assert.match(at('2026-02-10').desc, /IVA: 16 → 8/);
    assert.match(at('2026-03-15').desc, /판매 중단\(비활성화\) — 단종/);
    assert.match(at('2026-05-25').desc, /판매 재개\(활성화\)/);
    assert.match(at('2026-01-05').desc, /제품 신규 등록/);
    assert.equal(at('2026-06-30').parts.length, 1);
    assert.equal(at('2026-06-30').parts[0].label, 'Nombre del producto');
  });

  await t.test('⑥ 변경자 이름', async () => {
    const { body } = await get(`/api/products/history?product_id=${ID.p1}&limit=50`);
    const at = (d) => body.items.find((r) => String(r.changed_at).startsWith(d));
    assert.equal(at('2026-04-20').changed_by_name, '테스트영업');
    assert.equal(at('2026-03-15').changed_by_name, '테스트디렉터');
  });

  await t.test('⑦ 필터 — kind · estado · action · 날짜 · 검색어 · 제품격리', async () => {
    const only = async (qs) => (await get(`/api/products/history?product_id=${ID.p1}&limit=50&${qs}`)).body;
    assert.equal((await only('kind=status')).items.length, 3);
    assert.equal((await only('kind=master')).items.length, 4);
    assert.equal((await only('estado=0')).items.length, 3, '비활성 상태였던 줄 = 03-15, 04-20, 07-10');
    assert.equal((await only('estado=1')).items.length, 4);
    assert.equal((await only('action=deactivate')).items.length, 2);
    assert.equal((await only('from=2026-05-01')).items.length, 3);
    assert.equal((await only('to=2026-02-10')).items.length, 2, 'to 는 그 날 끝까지 포함');
    assert.equal((await only('source=import')).items.length, 1);

    const q = (await get('/api/products/history?q=PHT-B&limit=50')).body;
    assert.equal(mine(q.items).length, 1, '검색어로 다른 제품만');
    assert.equal(mine(q.items)[0].product_id, ID.p2);
  });

  await t.test('⑧ 페이징 total', async () => {
    const p1 = (await get(`/api/products/history?product_id=${ID.p1}&limit=3`)).body;
    assert.equal(p1.items.length, 3);
    assert.equal(p1.total, 7);
    const p2 = (await get(`/api/products/history?product_id=${ID.p1}&limit=3&offset=6`)).body;
    assert.equal(p2.items.length, 1);
    assert.equal(p2.items[0].action, 'create');
  });

  await t.test('⑨ 가격 권한 — 없으면 가격 변경 항목이 가려진다', async () => {
    const noP = (await get(`/api/products/history?product_id=${ID.p1}&limit=50`, 'sal')).body;
    assert.equal(noP.can_price, false);
    const row = noP.items.find((r) => String(r.changed_at).startsWith('2026-02-10'));
    assert.equal(row.hidden_price, 1, 'List Price 1건 가림');
    assert.ok(!row.parts.some((p) => p.field === 'list_price'), 'parts 에 가격 없음');
    assert.match(row.desc, /가격 항목 1건\(열람권한 없음\)/);
    assert.ok(row.parts.some((p) => p.field === 'iva_rate'), '비가격 항목은 그대로');

    const yesP = (await get(`/api/products/history?product_id=${ID.p1}&limit=50`, 'salP')).body;
    assert.equal(yesP.can_price, true);
    const row2 = yesP.items.find((r) => String(r.changed_at).startsWith('2026-02-10'));
    assert.ok(row2.parts.some((p) => p.field === 'list_price' && p.to === 120));
  });

  await t.test('⑩ movement — 변경 이후만, 재고 역산', async () => {
    const { code, body } = await get(`/api/products/${ID.p1}/movements?since=2026-03-15T10:00:00Z`);
    assert.equal(code, 200);
    assert.equal(body.stock.length, 3, '변경 전 입고 100 은 제외');
    assert.ok(!body.stock.some((m) => m.ref === 'batch:before'));
    assert.equal(body.stock_now, 70);
    assert.equal(body.stock_before, 100, '70 − (−20 + 5 − 15) = 100');
    assert.equal(body.totals.in_qty, 5);
    assert.equal(body.totals.out_qty, 20);
    assert.equal(body.totals.adjust_qty, -15);
    const adj = body.stock.find((m) => m.move_type === 'adjust');
    assert.equal(adj.signed_qty, -15, 'adjust 는 부호 그대로');
    assert.equal(body.stock.find((m) => m.ref === 'inv:after1').signed_qty, -20);
    assert.equal(body.stock[0].moved_at < body.stock[1].moved_at, true, '시간 오름차순');
  });

  await t.test('⑪ movement — 판매·견적도 변경 이후만', async () => {
    const { body } = await get(`/api/products/${ID.p1}/movements?since=2026-03-15T10:00:00Z`);
    assert.equal(body.totals.sales_count, 2, '내팀 + 타팀 (디렉터)');
    assert.equal(body.totals.sales_qty, 50);
    assert.equal(body.totals.sales_amount, 5000);
    assert.ok(!body.sales.some((s) => s.id === ID.invBefore), '변경 전 인보이스 제외');
    assert.equal(body.totals.quote_count, 2, 'Q1 · Q2');
    assert.equal(body.totals.quote_qty, 16);
    assert.ok(!body.quotes.some((q) => q.quote_no === 'PHT-Q0'));
  });

  await t.test('⑫ movement — until 로 다음 변경 시점까지만', async () => {
    const { body } = await get(
      `/api/products/${ID.p1}/movements?since=2026-03-15T10:00:00Z&until=2026-05-25T10:00:00Z`);
    assert.equal(body.stock.length, 2, '06-01 조정은 구간 밖');
    assert.equal(body.totals.quote_count, 1, 'Q2(06-10)는 구간 밖');
    assert.equal(body.stock_before, 100, 'until 이 있어도 변경 시점 재고 역산은 전체 원장 기준');
  });

  await t.test('⑬ movement — 팀 가시성 · 가격 마스킹', async () => {
    const { body } = await get(`/api/products/${ID.p1}/movements?since=2026-03-15T10:00:00Z`, 'sal');
    assert.equal(body.totals.sales_count, 1, '영업은 내 팀 고객 판매만');
    assert.equal(body.sales[0].customer_name, '내팀고객');
    assert.equal(body.can_price, false);
    assert.equal(body.sales[0].amount_mxn, null, '금액은 가려짐');
    assert.equal(body.sales[0].qty, 20, '수량은 보임');
    assert.equal(body.totals.sales_amount, null);
    // 재고 원장 자체는 팀 개념이 없으므로 그대로
    assert.equal(body.stock.length, 3);
  });

  await t.test('⑭ movement — 잘못된 요청', async () => {
    assert.equal((await get(`/api/products/${ID.p1}/movements`)).code, 400, 'since 필수');
    assert.equal((await get(`/api/products/${ID.p1}/movements?since=notadate`)).code, 400);
    assert.equal((await get('/api/products/99999999/movements?since=2026-03-15T10:00:00Z')).code, 404);
  });

  await t.test('⑮ 판매 기준일 = 매출일(inv_date) — 입력시각(created_at) 아님', async () => {
    const { body } = await get(`/api/products/${ID.p1}/movements?since=2026-03-15T10:00:00Z`);
    // 2026-01-15 매출인데 06-20 에 입력한 건: created_at 기준이면 잘못 끼고, inv_date 기준이면 빠진다
    assert.ok(!body.sales.some((s) => s.id === ID.invLateEntry), '늦게 입력한 과거 매출은 「변경 이후」가 아니다');
    assert.ok(body.sales.every((s) => s.inv_date >= '2026-03-15'), '모든 행이 매출일 기준 이후');
  });

  await t.test('⑯ 승인 대기 인보이스는 판매로 세지 않되 안내는 내려준다', async () => {
    const { body } = await get(`/api/products/${ID.p1}/movements?since=2026-03-15T10:00:00Z`);
    assert.ok(!body.sales.some((s) => s.id === ID.invPending), 'edit_pending 은 목록에서 제외');
    assert.equal(body.lifetime.pending_count, 1);
    assert.equal(body.lifetime.pending_qty, 9);
  });

  await t.test('⑰ 전체 기간 누계(lifetime) — 제품 드릴다운 매출총이익과 같은 기준', async () => {
    const { body } = await get(`/api/products/${ID.p1}/movements?since=2026-03-15T10:00:00Z`);
    assert.equal(body.lifetime.sales_count, 4, 'posted 인보이스 4건 (pending 제외)');
    assert.equal(body.lifetime.sales_qty, 7 + 20 + 30 + 4);
    assert.equal(body.lifetime.sales_amount, 6100);
    assert.equal(body.lifetime.first_sale_date, '2026-01-15');
    assert.equal(body.lifetime.last_sale_date, '2026-04-05');
    // 같은 기준의 제품 드릴다운과 숫자가 맞는지 교차 확인
    const dd = await get(`/api/products/${ID.p1}/drilldown`);
    assert.equal(dd.body.total_sold, body.lifetime.sales_qty, '드릴다운 총 판매수량과 일치');
  });

  await t.test('⑱ CE0536R 재현 — 변경 이후 0 인데 전체는 5개', async () => {
    // PHT-B: 판매는 2026-01-20(5개) 하나뿐, 마스터 변경은 2026-02-01
    const { body } = await get(`/api/products/${ID.p2}/movements?since=2026-02-01T10:00:00Z`);
    assert.equal(body.totals.sales_count, 0, '변경 이후 판매 없음 — 이건 정상');
    assert.equal(body.lifetime.sales_count, 1, '전체로는 1건');
    assert.equal(body.lifetime.sales_qty, 5, '전체 5개 — 화면이 이 숫자를 같이 보여준다');
    assert.equal(body.lifetime.last_sale_date, '2026-01-20');
  });

  await t.test('⑲ all=1 — 전체 기간 조회', async () => {
    const { body } = await get(`/api/products/${ID.p2}/movements?since=2026-02-01T10:00:00Z&all=1`);
    assert.equal(body.all, true);
    assert.equal(body.totals.sales_count, 1, '전체 기간이면 변경 이전 판매도 나온다');
    assert.equal(body.totals.sales_qty, 5);
    const p1 = (await get(`/api/products/${ID.p1}/movements?since=2026-03-15T10:00:00Z&all=1`)).body;
    assert.equal(p1.totals.sales_count, 4, 'p1 은 posted 4건 전부');
    assert.equal(p1.stock_before, 100, 'all 모드에서도 재고 역산 기준은 그 변경 시점');
    assert.equal(p1.stock.length, 4, '변경 전 입고 100 도 원장에 포함');
  });

  await t.test('⑳ 회귀 — 기존 /changelog 는 그대로(마스터 로그 전량, status 포함)', async () => {
    const { code, body } = await get(`/api/products/changelog?product_id=${ID.p1}&limit=50`);
    assert.equal(code, 200);
    assert.equal(body.items.length, 5, '기존 엔드포인트는 중복제거 없이 5건 그대로');
    assert.ok(body.items.some((r) => r.source === 'status'));
  });

  await t.test('㉑ 권한 — 제품 페이지 권한 없으면 차단', async () => {
    await query(`UPDATE user_page_access SET device_req='blocked' WHERE user_id=$1 AND page_key='products'`, [ID.sal]);
    const r = await get(`/api/products/history?product_id=${ID.p1}`, 'sal');
    assert.ok(r.code === 403 || r.code === 401, `차단되어야 함 — got ${r.code}`);
    await query(`UPDATE user_page_access SET device_req='anywhere' WHERE user_id=$1 AND page_key='products'`, [ID.sal]);
  });

  await app.close();
  const { pool } = await import('../src/db.js');
  await pool.end();
});
