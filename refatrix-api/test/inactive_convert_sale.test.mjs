// 판매중단(비활성) SKU 가 담긴 견적의 **매출확정(전환)** — 0224c (2026-09-21)
//
//   왜 이 시험이 있나
//     디렉터 지시(2026-09-18): 「inactivo 지정 이후 들어온 오더는 기록하고 볼 수 있게 하되,
//     그 오더가 포함된 견적은 **매출확정**을 할 수 있게 하라.」
//     0224b 는 견적 쪽 차단만 풀었다. 그런데 전환은 인보이스를 만들 때 POST /api/sales 를
//     내부 호출하고, 거기 0179 의 판매중단 차단이 그대로 있었다 →
//     판매중단 SKU 에 **재고가 남아 있으면** 전환 전체가 sale_failed(inactive_product) 로 멈췄다.
//     0224b 시험은 salesRoutes 를 등록하지 않고 「inactive_product_lines 가 아니다」만 봐서
//     이 실패를 놓쳤다. 여기서는 **실제 인보이스가 만들어지는지**까지 본다.
//
//   실행: TEST_PG_URL=postgres://... node --test test/inactive_convert_sale.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;

// ── 소스 수준 잠금(DB 없이도 돈다) ──────────────────────────────
test('전환은 /api/sales 를 내부 표식과 견적 id 로 부른다', () => {
  const q = readFileSync(new URL('../src/routes/quoteRoutes.js', import.meta.url), 'utf8');
  assert.ok(/source_quote_id:\s*id/.test(q), '견적 id 가 빠지면 판매중단 줄이 다시 막힌다');
  assert.ok(/\.\.\.internalHeaders\(\)/.test(q), '내부 표식이 빠지면 판매중단 줄이 다시 막힌다');
  const s = readFileSync(new URL('../src/routes/salesRoutes.js', import.meta.url), 'utf8');
  assert.ok(/isInternalCall\(req\)/.test(s), '예외는 내부 호출에만 준다');
  assert.ok(/NOT is_active/.test(s) && /inactive_product/.test(s), '직접 매출등록 차단은 남는다');
});

test('내부 표식은 흉내 낼 수 없다', async () => {
  const { isInternalCall, internalHeaders, INTERNAL_HEADER } = await import('../src/internalCall.js');
  assert.equal(isInternalCall({ headers: internalHeaders() }), true);
  assert.equal(isInternalCall({ headers: {} }), false);
  assert.equal(isInternalCall({ headers: { [INTERNAL_HEADER]: '1' } }), false);
  assert.equal(isInternalCall({ headers: { [INTERNAL_HEADER]: 'x'.repeat(48) } }), false);
  assert.equal(isInternalCall(null), false);
});

// ── 실 DB 종단 ─────────────────────────────────────────────────
const dbTest = PG ? test : test.skip;

dbTest('판매중단 SKU 가 담긴 견적도 매출확정된다 · 직접 매출등록은 여전히 막힌다 (실 DB)', async (t) => {
  const { query } = await import('../src/db.js');
  const Fastify = (await import('fastify')).default;
  const fastifyJwt = (await import('@fastify/jwt')).default;
  const quoteRoutes = (await import('../src/routes/quoteRoutes.js')).default;
  const productRoutes = (await import('../src/routes/productRoutes.js')).default;
  const salesRoutes = (await import('../src/routes/salesRoutes.js')).default;
  const { demandSummary } = await import('../src/inactiveDemand.js');
  const { INTERNAL_HEADER } = await import('../src/internalCall.js');

  // 실행마다 다른 코드 — 인보이스에는 거래·원가·커미션이 줄줄이 붙어 완전 청소가 어렵다.
  //   청소는 최선 노력이고, 남은 찌꺼기가 다음 실행을 깨지 않게 이름을 매번 새로 만든다.
  const SFX = Date.now().toString(36).slice(-5).toUpperCase();
  const CUST = 'T-ICS' + SFX;
  const RFC = 'ICS' + String(100000 + Math.floor(Math.random() * 899999)) + SFX.slice(-3).padStart(3, 'A');
  const CODES = ['ICS-OFF-' + SFX, 'ICS-ON-' + SFX, 'ICS-LOW-' + SFX];
  const wipe = async () => {
    const tryq = async (sql, a) => { try { await query(sql, a); } catch (_) { /* 없는 테이블은 넘어간다 */ } };
    const inv = `SELECT id FROM sales_invoices WHERE customer_id IN (SELECT id FROM customers WHERE code='${CUST}')`;
    await tryq(`DELETE FROM stock_shortages WHERE customer_id IN (SELECT id FROM customers WHERE code='${CUST}')`);
    for (const tbl of ['inventory_movements', 'stock_movements']) {
      await tryq(`DELETE FROM ${tbl} WHERE product_id IN (SELECT id FROM products WHERE code = ANY($1))`, [CODES]);
    }
    // 인보이스에 딸린 것(라인·거래·배분·파일…)을 FK 목록에서 찾아 먼저 지운다.
    try {
      const refs = (await query(
        `SELECT cl.relname AS t, a.attname AS col
           FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
          WHERE c.contype = 'f' AND c.confrelid = 'sales_invoices'::regclass`)).rows;
      for (const r of refs) {
        if (r.t === 'quotes') continue;
        await tryq(`DELETE FROM ${r.t} WHERE ${r.col} IN (${inv})`);
      }
    } catch (_) { /* 스키마 조회 실패 시 아래 개별 삭제로 */ }
    await tryq(`DELETE FROM sales_invoice_lines WHERE invoice_id IN (${inv})`);
    await tryq(`UPDATE quotes SET invoice_id=NULL WHERE memo LIKE 'ICSTEST%'`);
    await tryq(`DELETE FROM sales_invoices WHERE id IN (${inv})`);
    await tryq(`DELETE FROM quote_lines WHERE quote_id IN (SELECT id FROM quotes WHERE memo LIKE 'ICSTEST%')`);
    await tryq(`DELETE FROM quotes WHERE memo LIKE 'ICSTEST%'`);
    await tryq(`DELETE FROM product_status_log WHERE product_id IN (SELECT id FROM products WHERE code = ANY($1))`, [CODES]);
    await tryq(`DELETE FROM product_change_log WHERE product_id IN (SELECT id FROM products WHERE code = ANY($1))`, [CODES]);
    await tryq(`DELETE FROM products WHERE code = ANY($1)`, [CODES]);
    for (const tbl of ['customer_meetings', 'customer_stage_history', 'stage_log',
      'customer_rfc_claims', 'customer_registration_events', 'customer_terms_history']) {
      await tryq(`DELETE FROM ${tbl} WHERE customer_id IN (SELECT id FROM customers WHERE code='${CUST}')`);
    }
    await tryq(`DELETE FROM customers WHERE code='${CUST}'`);
    await tryq(`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE login_id='t_ics_dir_${SFX}')`);
    await tryq(`DELETE FROM users WHERE login_id='t_ics_dir_${SFX}'`);
  };
  await wipe();
  t.after(wipe);

  const custId = Number((await query(
    `INSERT INTO customers (code, name, rfc, discount, credit_days, approval_status)
     VALUES ($1,'CLIENTE CONVERSION',$2,10,30,'approved') RETURNING id`, [CUST, RFC])).rows[0].id);
  const prod = async (code, stock) => Number((await query(
    `INSERT INTO products (code, name, list_price, stock_qty, is_active)
     VALUES ($1,$1,100,$2,true) RETURNING id`, [code, stock])).rows[0].id);
  const pOff = await prod(CODES[0], 10);   // 판매중단 · 재고 남음 ← 이번 버그의 조건
  const pOn = await prod(CODES[1], 10);
  const pLow = await prod(CODES[2], 2);    // 판매중단 · 재고 일부만
  const dirId = Number((await query(
    `INSERT INTO users (login_id, name, role, pin_hash) VALUES ($1,'전환시험 디렉터','director','x') RETURNING id`, ['t_ics_dir_' + SFX])).rows[0].id);

  const app = Fastify();
  await app.register(fastifyJwt, { secret: 'test-secret-0224c' });
  await app.register(quoteRoutes);
  await app.register(productRoutes);
  await app.register(salesRoutes);          // 0224b 시험에 없던 것 — 전환이 실제로 타는 경로
  await app.ready();
  t.after(() => app.close());
  const tok = app.jwt.sign({ sub: dirId });
  const call = (method, url, payload, extra = {}) => app.inject({ method, url, payload,
    headers: { authorization: 'Bearer ' + tok, ...extra } });

  for (const pid of [pOff, pLow]) {
    const r = await call('PATCH', `/api/products/${pid}/active`, { active: false, reason: '단종' });
    assert.equal(r.statusCode, 200);
  }

  // ── ① 판매중단 후 견적 — 접수 + 표시
  const mk = await call('POST', '/api/quotes', { customer_id: custId, memo: 'ICSTEST-1-' + SFX,
    lines: [{ product_id: pOff, qty: 4 }, { product_id: pOn, qty: 2 }, { product_id: pLow, qty: 5 }] });
  assert.equal(mk.statusCode, 200, JSON.stringify(mk.json()));
  const qid = mk.json().id;
  const issues = (await query(`SELECT product_id, issue FROM quote_lines WHERE quote_id=$1`, [qid])).rows;
  assert.equal(issues.filter((r) => r.issue === 'inactive').length, 2, '판매중단 두 줄에 표시');

  // ── ② 포장 → 서명본 → **매출확정**
  const pk = await call('POST', `/api/quotes/${qid}/packing-printed`);
  assert.equal(pk.statusCode, 200);
  await query(`INSERT INTO quote_packing_docs (quote_id, file_name, mime_type, file_data, uploaded_by)
               VALUES ($1,'s.jpg','image/jpeg','eA==',$2)`, [qid, dirId]);
  const conv = await call('POST', `/api/quotes/${qid}/convert`, {});
  assert.equal(conv.statusCode, 200, '판매중단 SKU 때문에 매출확정이 막히면 안 된다: ' + JSON.stringify(conv.json()));
  const cj = conv.json();
  assert.ok(cj.invoice_id, '인보이스가 실제로 만들어진다');

  const il = (await query(`SELECT product_id, qty FROM sales_invoice_lines WHERE invoice_id=$1`, [cj.invoice_id])).rows;
  const qtyOf = (pid) => Number(il.find((r) => Number(r.product_id) === pid)?.qty || 0);
  assert.equal(qtyOf(pOn), 2, '정상 SKU 매출');
  assert.equal(qtyOf(pOff), 4, '판매중단 SKU 도 남은 재고로 매출확정');
  assert.equal(qtyOf(pLow), 2, '재고만큼만 매출');
  const sh = (cj.shortages || []).find((s) => Number(s.product_id) === pLow);
  assert.ok(sh && Number(sh.shortage) === 3, '나머지 3개는 부족분으로 기록');
  const st = Object.fromEntries((await query(`SELECT id, stock_qty FROM products WHERE id = ANY($1)`, [[pOff, pOn, pLow]]))
    .rows.map((r) => [Number(r.id), Number(r.stock_qty)]));
  assert.deepEqual([st[pOff], st[pOn], st[pLow]], [6, 8, 0], '재고 차감');
  const qs = (await query(`SELECT status FROM quotes WHERE id=$1`, [qid])).rows[0];
  assert.equal(qs.status, 'converted');

  // ── ③ **기록은 남는다** — 전환 후에도 줄 표시·수요 집계 유지
  const after = (await query(`SELECT count(*)::int n FROM quote_lines WHERE quote_id=$1 AND issue='inactive'`, [qid])).rows[0];
  assert.equal(after.n, 2, '매출확정 후에도 판매중단 표시가 남는다');
  const dem = await demandSummary({ productIds: [pOff, pLow] });
  assert.equal(dem.find((d) => d.product_id === pOff)?.req_n, 1, '수요 기록 유지(OFF)');
  assert.equal(dem.find((d) => d.product_id === pLow)?.req_n, 1, '수요 기록 유지(LOW)');

  // ── ④ 직접 매출등록은 **여전히** 막힌다
  const direct = await call('POST', '/api/sales',
    { customer_id: custId, inv_date: '2026-09-21', lines: [{ product_id: pOff, qty: 1 }] });
  assert.equal(direct.statusCode, 409);
  assert.equal(direct.json().error, 'inactive_product');

  // ── ⑤ 견적 id 를 붙여도, 표식을 흉내 내도 직접 호출은 막힌다
  const mk2 = await call('POST', '/api/quotes', { customer_id: custId, memo: 'ICSTEST-2-' + SFX,
    lines: [{ product_id: pOff, qty: 1 }] });
  assert.equal(mk2.statusCode, 200);
  const q2 = mk2.json().id;
  const spoofA = await call('POST', '/api/sales',
    { customer_id: custId, inv_date: '2026-09-21', source_quote_id: q2, lines: [{ product_id: pOff, qty: 1 }] });
  assert.equal(spoofA.statusCode, 409, 'body 값만으로는 통과 못 한다');
  const spoofB = await call('POST', '/api/sales',
    { customer_id: custId, inv_date: '2026-09-21', source_quote_id: q2, lines: [{ product_id: pOff, qty: 1 }] },
    { [INTERNAL_HEADER]: 'f'.repeat(48) });
  assert.equal(spoofB.statusCode, 409, '가짜 표식은 통과 못 한다');

  // ── ⑥ 이미 전환된 견적 id 로는 예외가 안 선다(재사용 방지) — 전환 경로가 already_converted 로 먼저 막는다
  const again = await call('POST', `/api/quotes/${qid}/convert`, {});
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error, 'already_converted');
});
