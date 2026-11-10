// =====================================================================
// pf_catalog_perf.test.mjs — 2026-11-10 · 플랫폼 「CTR 제품별 실적 수량」 GET /api/pf-catalog/perf
//   A. 순수 — months · codes 파싱
//   B. 실제 서버 + PostgreSQL(TEST_PG_URL):
//      견적(작성중·확정·만료 포함 / 전환·취소·삭제·pricelist·기간 밖 제외) · 매출(posted · 미삭제 · 기간) ·
//      운송(수입입고 incoming·receiving) · 백오더(부족분 open 잔량) · 실적 없는 코드 제외 · PRO·키트 제외 ·
//      ?codes · ?months=all · 10분 캐시 · fresh · 가격·고객명 없음 · ERP 토큰 401
//   실행: TEST_PG_URL=postgres://... node --test --test-concurrency=1 test/pf_catalog_perf.test.mjs
// =====================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-pf-catalog';
const P = await import('../src/pfPerf.js');

test('A. months · codes 파싱', () => {
  assert.equal(P.parseMonths(undefined), 12);
  assert.equal(P.parseMonths('6'), 6);
  assert.equal(P.parseMonths('all'), 0);
  assert.equal(P.parseMonths('0'), 0);
  assert.equal(P.parseMonths('999'), 12, '범위 밖 → 기본');
  assert.equal(P.parseMonths('abc'), 12);
  assert.equal(P.parseCodes(undefined), null);
  assert.equal(P.parseCodes(' , '), null);
  assert.deepEqual(P.parseCodes(' cq0500r,CB0001 ;cq0500r '), ['CQ0500R', 'CB0001']);
});

test('B. 실제 서버 + PostgreSQL — perf', { skip: !PG && 'TEST_PG_URL 없음' }, async (t) => {
  const { query, pool } = await import('../src/db.js');
  const MINE = `SELECT id FROM products WHERE code LIKE 'PFQ%' OR code IN ('PROPFQ1','K99001')`;
  async function cleanup() {
    await query(`DELETE FROM stock_shortages WHERE product_id IN (${MINE})`);
    const shIds = (await query(`SELECT DISTINCT shipment_id FROM inbound_pallets WHERE order_no='PFQ-TEST'`)).rows.map((x) => x.shipment_id);
    await query(`DELETE FROM inbound_pallet_items WHERE input_code LIKE 'PFQ%'`);
    await query(`DELETE FROM inbound_pallets WHERE order_no='PFQ-TEST'`);
    if (shIds.length) await query(`DELETE FROM inbound_shipments WHERE id = ANY($1)`, [shIds]);
    await query(`DELETE FROM sales_invoice_lines WHERE product_id IN (${MINE})`);
    await query(`DELETE FROM sales_invoices WHERE customer_id IN (SELECT id FROM customers WHERE code='PFQ-C')`);
    await query(`DELETE FROM quote_lines WHERE product_id IN (${MINE})`);
    await query(`DELETE FROM quotes WHERE quote_no LIKE 'PFQ-%'`);
    await query(`DELETE FROM customers WHERE code='PFQ-C'`);
    await query(`DELETE FROM products WHERE id IN (${MINE})`);
  }
  after(async () => { await cleanup().catch((e) => console.error('cleanup', e.message)); await pool.end().catch(() => {}); setTimeout(() => process.exit(process.exitCode || 0), 300); });

  const V = await import('../src/surveyViewer.js');
  const keepLog = V.platformApi.log;
  V.platformApi.log = async (tok) => (tok.startsWith('aaaaaaaa') ? { ok: true } : { ok: false, invalid: true });
  t.after(() => { V.platformApi.log = keepLog; });
  const { buildApp } = await import('../src/server.js');
  const app = buildApp(); await app.ready();
  t.after(() => app.close());
  const one = async (sql, a) => (await query(sql, a)).rows[0];

  await cleanup();
  const mk = (code) => one(`INSERT INTO products (code, name, list_price, stock_qty, is_active) VALUES ($1,'X',100,5,true) RETURNING id`, [code]).then((r) => Number(r.id));
  const A = await mk('PFQ001'); const B = await mk('PFQ002'); const Cn = await mk('PFQ003'); const D = await mk('PFQ004');
  const PRO = await mk('PROPFQ1'); const KIT = await mk('K99001');
  const cu = Number((await one(`INSERT INTO customers (code, name) VALUES ('PFQ-C','Cliente Secreto') RETURNING id`)).id);

  // ── 견적 ──
  let qn = 0;
  const quote = async (status, lines, { days = 3, deleted = false } = {}) => {
    const q = await one(`INSERT INTO quotes (quote_no, customer_id, status, quote_date, deleted_at)
                         VALUES ($1,$2,$3,(now() AT TIME ZONE 'America/Mexico_City')::date - $4::int, $5) RETURNING id`,
      ['PFQ-' + (++qn), cu, status, days, deleted ? new Date() : null]);
    for (const [pid, qty] of lines) await query(`INSERT INTO quote_lines (quote_id, product_id, qty) VALUES ($1,$2,$3)`, [q.id, pid, qty]);
    return Number(q.id);
  };
  await quote('draft', [[A, 4], [A, 1]]);          // 같은 견적 두 줄 → 5 · 1건
  await quote('confirmed', [[A, 3]]);              // +3 (open)
  await quote('expired', [[A, 4]]);                // +4 (만료 = 미전환)
  await quote('converted', [[A, 100]]);            // 제외
  await quote('cancelled', [[A, 100]]);            // 제외
  await quote('delete_pending', [[A, 100]]);       // 제외
  await quote('pricelist', [[A, 100]]);            // 제외
  await quote('draft', [[A, 100]], { deleted: true });   // 제외
  await quote('expired', [[A, 50]], { days: 400 });      // 12개월 밖 → months=all 에서만
  await quote('draft', [[PRO, 9], [KIT, 9]]);      // 대상 밖

  // ── 매출 ──
  const inv = async (status, pid, qty, { days = 5, deleted = false } = {}) => {
    const s = await one(`INSERT INTO sales_invoices (customer_id, inv_date, status, deleted_at)
                         VALUES ($1,(now() AT TIME ZONE 'America/Mexico_City')::date - $2::int,$3,$4) RETURNING id`,
      [cu, days, status, deleted ? new Date() : null]);
    await query(`INSERT INTO sales_invoice_lines (invoice_id, product_id, qty, list_price, unit_price, line_amount_mxn) VALUES ($1,$2,$3,100,90,$4)`,
      [s.id, pid, qty, qty * 90]);
  };
  await inv('posted', A, 20); await inv('posted', A, 10, { days: 40 });
  await inv('deleted', A, 999); await inv('posted', A, 999, { deleted: true });
  await inv('posted', A, 7, { days: 500 });        // 12개월 밖
  await inv('posted', B, 4);

  // ── 운송(수입입고) ──
  const sh = await one(`INSERT INTO inbound_shipments (status, eta) VALUES ('incoming', CURRENT_DATE + 20) RETURNING id`);
  const shC = await one(`INSERT INTO inbound_shipments (status, eta) VALUES ('closed', CURRENT_DATE) RETURNING id`);
  let pln = 0;
  for (const [s, pid, qty] of [[sh.id, A, 5], [shC.id, A, 500], [sh.id, Cn, 2]]) {
    const pl = await one(`INSERT INTO inbound_pallets (shipment_id, order_no, pl_no) VALUES ($1,'PFQ-TEST',$2) RETURNING id`, [s, ++pln]);
    await query(`INSERT INTO inbound_pallet_items (pallet_id, shipment_id, input_code, cartons, qty, product_id) VALUES ($1,$2,'PFQ',1,$3,$4)`, [pl.id, s, qty, pid]);
  }

  // ── 백오더(부족분) ──
  const short = (pid, qty, status, resolved = 0) => query(
    `INSERT INTO stock_shortages (product_id, customer_id, requested_qty, fulfilled_qty, shortage_qty, resolved_qty, status, occurred_at)
     VALUES ($1,$2,$3,0,$3,$4,$5,CURRENT_DATE)`, [pid, cu, qty, resolved, status]);
  await short(A, 3, 'open', 1);    // 잔량 2
  await short(A, 9, 'resolved');   // 제외
  await short(A, 9, 'cancelled');  // 제외
  await short(Cn, 1, 'open');

  // ── 인증 ──
  let r = await app.inject({ method: 'GET', url: '/api/pf-catalog/perf' });
  assert.equal(r.statusCode, 401);
  const erpTok = app.jwt.sign({ sub: 1, typ: 'erp' });
  r = await app.inject({ method: 'GET', url: '/api/pf-catalog/perf', headers: { authorization: 'Bearer ' + erpTok } });
  assert.equal(r.statusCode, 401, 'ERP 토큰은 안 된다');
  const lg = await app.inject({ method: 'POST', url: '/api/pf-catalog/login', payload: { token: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'Park CTR', user_key: '12' } });
  const H = { authorization: 'Bearer ' + lg.json().token };
  const get = async (qs = '') => { const x = await app.inject({ method: 'GET', url: '/api/pf-catalog/perf' + qs, headers: H }); assert.equal(x.statusCode, 200, x.body); return x.json(); };

  // ── 전체 ──
  let R = await get('?fresh=1');
  assert.equal(R.period.months, 12); assert.match(R.period.label, /최근 12개월/); assert.ok(R.updated_at);
  assert.ok(R.defs.quote && R.defs.backorder);
  const by = (res) => Object.fromEntries(res.items.map((x) => [x.code, x]));
  let M = by(R);
  assert.deepEqual(
    { q: M.PFQ001.quote_qty, qn: M.PFQ001.quote_n, qo: M.PFQ001.quote_open_qty, s: M.PFQ001.sold_qty, sn: M.PFQ001.sold_n, tr: M.PFQ001.transit_qty, bo: M.PFQ001.backorder_qty },
    { q: 12, qn: 3, qo: 8, s: 30, sn: 2, tr: 5, bo: 2 });
  assert.ok(M.PFQ001.transit_eta, 'ETA');
  assert.deepEqual([M.PFQ002.sold_qty, M.PFQ002.quote_qty, M.PFQ002.transit_qty, M.PFQ002.backorder_qty], [4, 0, 0, 0]);
  assert.deepEqual([M.PFQ003.transit_qty, M.PFQ003.backorder_qty], [2, 1]);
  // 실적 없는 코드도 나온다 — 구분 표시(has_perf · perf_status · perf_label) · 네 수량 0 · 선택 필드 없음
  assert.deepEqual(M.PFQ004, { code: 'PFQ004', quote_qty: 0, sold_qty: 0, transit_qty: 0, backorder_qty: 0,
    has_perf: false, perf_status: 'none', perf_label: '실적 없음' });
  assert.equal(M.PFQ001.has_perf, true); assert.equal(M.PFQ001.perf_status, 'ok'); assert.equal(M.PFQ001.perf_label, undefined);
  assert.equal(M.PFQ002.has_perf, true, '매출만 있어도 실적 있음');
  assert.ok(R.count_none >= 1 && R.count_perf >= 3 && R.count === R.count_perf + R.count_none);
  assert.equal(R.none_label, '실적 없음');
  // ?only=perf → 예전처럼 실적 있는 코드만
  const Rp = await get('?only=perf&fresh=1');
  assert.equal(by(Rp).PFQ004, undefined); assert.ok(by(Rp).PFQ001); assert.equal(Rp.count_none, 0); assert.equal(Rp.only_perf, true);
  assert.equal(M.PROPFQ1, undefined); assert.equal(M.K99001, undefined, 'PRO · 키트 제외');
  const txt = JSON.stringify(R);
  assert.ok(!/Cliente Secreto|list_price|unit_price|amount/i.test(txt), '고객명 · 가격 · 금액 없음');

  // ── 전체 누적 ──
  M = by(await get('?months=all&fresh=1'));
  assert.equal(M.PFQ001.quote_qty, 62); assert.equal(M.PFQ001.sold_qty, 37);

  // ── 일부 코드(소문자 · 공백) ──
  R = await get('?codes=pfq001, PFQ004');
  assert.deepEqual(R.items.map((x) => [x.code, x.has_perf]), [['PFQ001', true], ['PFQ004', false]]);
  assert.deepEqual((await get('?codes=PFQ004,NOPE999')).items.map((x) => x.code), ['PFQ004'], 'ERP 에 없는 코드는 나오지 않는다');

  // ── 캐시: 새 매출이 들어와도 10분 안에는 같은 값 · fresh=1 이면 새 값 ──
  await inv('posted', B, 6);
  assert.equal(by(await get('')).PFQ002.sold_qty, 4, '캐시');
  assert.equal(by(await get('?fresh=1')).PFQ002.sold_qty, 10, 'fresh');
  assert.equal(by(await get('?codes=PFQ002')).PFQ002.sold_n, 2, '코드 지정은 캐시를 안 탄다');
});
