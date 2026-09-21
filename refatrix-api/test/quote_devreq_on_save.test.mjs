// 견적의 카탈로그 미등록 코드 → 저장 즉시 개발요청 대장 (2026-09-21)
//
//   왜 이 시험이 있나
//     CQ0988L 을 견적에 넣었는데 「개발 요청」에 안 보였다. 예전 코드는 매출 전환 · 24시간 만료
//     때만 적었고, 포장지시서를 출력한 견적은 만료 처리에서 빠져 **끝내 안 적혔다.**
//     여기서 잠그는 것:
//       ① 저장 · 수정 · 복제 · 포털 수신 순간 적힌다
//       ② 같은 견적 · 같은 코드(대소문자 무시)는 몇 번을 거쳐도 한 줄
//       ③ 카탈로그에 있는 코드(SYD 다중매칭 포함)는 적지 않는다
//       ④ 포장 후 전환해도 중복이 생기지 않는다 · 만료 안전망도 중복 없음
//       ⑤ 사람이 지운 요청은 되살리지 않는다 · 취소 견적은 새로 적지 않는다
//       ⑥ 0226 소급 적재가 빠진 것만 채운다(두 번 돌려도 같다)
//
//   실행: TEST_PG_URL=postgres://... node --test test/quote_devreq_on_save.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;

test('소스: 저장 경로 전부가 같은 도우미를 부른다', () => {
  const q = readFileSync(new URL('../src/routes/quoteRoutes.js', import.meta.url), 'utf8');
  const n = (q.match(/recordQuoteDevDemand\(c,/g) || []).length;
  assert.equal(n, 5, '저장 · 수정 · 복제 · 만료 · 전환 = 5곳');
  const crm = readFileSync(new URL('../src/routes/crmQuoteRoutes.js', import.meta.url), 'utf8');
  assert.ok(/recordQuoteDevDemand\(c,/.test(crm), '포털 수신도 같은 규칙');
  assert.equal(/INSERT INTO product_dev_requests/.test(q), false, '대장 쓰기는 quoteDevDemand.js 한 곳에서만');
});

const dbTest = PG ? test : test.skip;

dbTest('저장 즉시 기록 · 중복 없음 · 소급 (실 DB)', async (t) => {
  const { query, withTx } = await import('../src/db.js');
  const Fastify = (await import('fastify')).default;
  const fastifyJwt = (await import('@fastify/jwt')).default;
  const quoteRoutes = (await import('../src/routes/quoteRoutes.js')).default;
  const salesRoutes = (await import('../src/routes/salesRoutes.js')).default;
  const { recordQuoteDevDemand } = await import('../src/quoteDevDemand.js');

  const wipe = async () => {
    await query(`DELETE FROM product_dev_requests WHERE source_quote_id IN (SELECT id FROM quotes WHERE memo LIKE 'DVTEST%')`);
    await query(`DELETE FROM stock_shortages WHERE source_quote_id IN (SELECT id FROM quotes WHERE memo LIKE 'DVTEST%')`);
    // 전환으로 생긴 매출 — 딸린 행부터 치운다(몇 번 돌려도 같은 결과)
    const inv = (await query(`SELECT id FROM sales_invoices WHERE customer_id IN (SELECT id FROM customers WHERE code='T-DV01')`)).rows.map((r) => r.id);
    if (inv.length) {
      await query(`UPDATE quotes SET invoice_id=NULL WHERE invoice_id = ANY($1::bigint[])`, [inv]);
      await query(`UPDATE sales_invoices SET txn_id=NULL WHERE id = ANY($1::bigint[])`, [inv]);
      for (const [tbl, col] of [['stock_movements', 'sales_invoice_id'], ['stock_shortage_resolutions', 'sales_invoice_id'],
        ['stock_shortages', 'sales_invoice_id'], ['transactions', 'sales_invoice_id'], ['cogs_adjustments', 'sales_invoice_id'],
        ['sales_sku_pending', 'sales_invoice_id'], ['sales_payment_allocations', 'invoice_id'], ['sales_change_requests', 'invoice_id'],
        ['commission_payment_allocations', 'invoice_id'], ['commission_payouts', 'invoice_id'], ['sales_invoice_lines', 'invoice_id']]) {
        await query(`DELETE FROM ${tbl} WHERE ${col} = ANY($1::bigint[])`, [inv]);
      }
      await query(`DELETE FROM sales_invoices WHERE id = ANY($1::bigint[])`, [inv]);
    }
    await query(`DELETE FROM stock_movements WHERE product_id IN (SELECT id FROM products WHERE code LIKE 'DVT-%')`);
    await query(`DELETE FROM quote_packing_docs WHERE quote_id IN (SELECT id FROM quotes WHERE memo LIKE 'DVTEST%')`).catch(() => {});
    await query(`DELETE FROM quote_lines WHERE quote_id IN (SELECT id FROM quotes WHERE memo LIKE 'DVTEST%')`);
    await query(`DELETE FROM quotes WHERE memo LIKE 'DVTEST%'`);
    await query(`DELETE FROM product_syd_codes WHERE product_id IN (SELECT id FROM products WHERE code LIKE 'DVT-%')`);
    await query(`DELETE FROM products WHERE code LIKE 'DVT-%'`);
    for (const tbl of ['customer_meetings', 'customer_stage_history', 'stage_log',
      'customer_rfc_claims', 'customer_registration_events', 'customer_terms_history']) {
      try { await query(`DELETE FROM ${tbl} WHERE customer_id IN (SELECT id FROM customers WHERE code='T-DV01')`); } catch (_) { /* */ }
    }
    await query(`DELETE FROM customers WHERE code='T-DV01'`);
    try {
      await query(`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE login_id='t_dv_dir')`);
      await query(`DELETE FROM users WHERE login_id='t_dv_dir'`);
    } catch (_) { await query(`UPDATE users SET login_id='t_dv_dir_'||id WHERE login_id='t_dv_dir'`); }
  };
  await wipe();
  t.after(wipe);

  const c1 = Number((await query(
    `INSERT INTO customers (code, name, rfc, discount, credit_days, approval_status)
     VALUES ('T-DV01','CLIENTE DESARROLLO','DVT010203AA1',10,30,'approved') RETURNING id`)).rows[0].id);
  const prod = async (code) => Number((await query(
    `INSERT INTO products (code, name, list_price, stock_qty, is_active) VALUES ($1,$2,100,50,true) RETURNING id`,
    [code, 'ROTULA ' + code])).rows[0].id);
  const pA = await prod('DVT-A');
  const pB = await prod('DVT-B');
  const pC = await prod('DVT-C');
  // 같은 SYD 코드가 두 제품에 걸림 → multi_match(존재하는 코드) — 개발 대상 아님
  await query(`INSERT INTO product_syd_codes (product_id, syd_code) VALUES ($1,'DVT-SYD-X'),($2,'DVT-SYD-X')`, [pA, pB]);

  const dirId = Number((await query(
    `INSERT INTO users (login_id, name, role, pin_hash) VALUES ('t_dv_dir','개발요청시험 디렉터','director','x') RETURNING id`)).rows[0].id);
  const app = Fastify();
  await app.register(fastifyJwt, { secret: 'test-secret-0921dv' });
  await app.register(quoteRoutes);
  await app.register(salesRoutes);   // 전환이 내부에서 POST /api/sales 를 부른다
  await app.ready();
  t.after(() => app.close());
  const tok = app.jwt.sign({ sub: dirId });
  const call = (method, url, payload) => app.inject({ method, url, payload,
    headers: { authorization: 'Bearer ' + tok } });
  const devOf = async (qid, all = false) => (await query(
    `SELECT id, input_code, requested_qty, status, customer_id, to_char(requested_at,'YYYY-MM-DD') AS d, deleted_at
       FROM product_dev_requests WHERE source_quote_id=$1 ${all ? '' : 'AND deleted_at IS NULL'} ORDER BY id`, [qid])).rows;

  // ── ① 저장 순간 기록 (CQ0988L 사례 그대로 — 소문자 섞어 입력)
  const r1 = await call('POST', '/api/quotes', { customer_id: c1, memo: 'DVTEST-1', quote_date: '2026-09-21',
    lines: [{ product_id: pC, qty: 2 }, { code: 'cq0988L', qty: 4 }, { code: 'DVT-SYD-X', qty: 1 }, { code: 'CQ-0988L', qty: 1 }] });
  assert.equal(r1.statusCode, 200, JSON.stringify(r1.json()));
  const q1 = r1.json();
  let d1 = await devOf(q1.id);
  assert.equal(d1.length, 1, '미등록 코드 1개 → 대장 1줄 (같은 코드 두 줄은 합친다, SYD 다중매칭은 제외)');
  assert.equal(d1[0].input_code, 'cq0988L', '입력한 그대로 남긴다');
  assert.equal(Number(d1[0].requested_qty), 5, '같은 코드 두 줄(4+1)의 합');
  assert.equal(d1[0].status, 'received');
  assert.equal(Number(d1[0].customer_id), c1);
  assert.equal(d1[0].d, '2026-09-21', '요청일 = 견적일');
  assert.equal(q1.dev_lines.length, 1, '저장 응답에 돌려준다');
  assert.match(q1.dev_note, /solicitud de desarrollo/, '스페인어 안내');

  // ── ② 수정: 대소문자 바꿔도 새 줄 안 생김 · 수량 따라감 · 새 코드는 추가
  const r2 = await call('PUT', `/api/quotes/${q1.id}`, { customer_id: c1, memo: 'DVTEST-1',
    lines: [{ product_id: pC, qty: 2 }, { code: 'CQ0988L', qty: 7 }, { code: 'ZZ-NEW-01', qty: 3 }] });
  assert.equal(r2.statusCode, 200);
  d1 = await devOf(q1.id);
  assert.equal(d1.length, 2, 'CQ0988L 은 그대로 1줄 + ZZ-NEW-01 추가');
  assert.equal(Number(d1[0].requested_qty), 7, '접수 상태면 수량을 따라간다');
  assert.equal(r2.json().dev_lines.length, 2);

  // 검토가 시작되면 수량은 더 이상 안 바뀐다
  await query(`UPDATE product_dev_requests SET status='reviewed' WHERE id=$1`, [d1[0].id]);
  await call('PUT', `/api/quotes/${q1.id}`, { customer_id: c1, memo: 'DVTEST-1',
    lines: [{ product_id: pC, qty: 2 }, { code: 'CQ0988L', qty: 9 }, { code: 'ZZ-NEW-01', qty: 3 }] });
  d1 = await devOf(q1.id);
  assert.equal(Number(d1[0].requested_qty), 7, '검토 중인 건은 건드리지 않는다');

  // ── ⑤ 사람이 지운 요청은 되살리지 않는다
  await query(`UPDATE product_dev_requests SET deleted_at=now() WHERE id=$1`, [d1[1].id]);
  await call('PUT', `/api/quotes/${q1.id}`, { customer_id: c1, memo: 'DVTEST-1',
    lines: [{ product_id: pC, qty: 2 }, { code: 'CQ0988L', qty: 9 }, { code: 'ZZ-NEW-01', qty: 3 }] });
  assert.equal((await devOf(q1.id)).length, 1, '지운 ZZ-NEW-01 이 수정 한 번에 되살아나면 안 된다');
  assert.equal((await devOf(q1.id, true)).length, 2);

  // ── ④ 포장 → 전환: 중복 없음 (예전 누락 경로)
  const pk = await call('POST', `/api/quotes/${q1.id}/packing-printed`);
  assert.equal(pk.statusCode, 200, pk.body);
  await query(`INSERT INTO quote_packing_docs (quote_id, file_name, mime_type, file_data) VALUES ($1,'x.pdf','application/pdf','eA==')`, [q1.id]);
  const cv = await call('POST', `/api/quotes/${q1.id}/convert`, {});
  assert.equal(cv.statusCode, 200, cv.body);
  assert.equal(cv.json().dev_requests, 0, '이미 저장 때 적혀 있으므로 전환이 새로 만들 것이 없다');
  assert.equal((await devOf(q1.id, true)).length, 2, '전환이 중복을 만들지 않는다');

  // ── 복제 = 새 견적 → 새 견적 번호로 따로 적힌다(고객이 다시 찾았다는 뜻)
  const src = await call('POST', '/api/quotes', { customer_id: c1, memo: 'DVTEST-2',
    lines: [{ code: 'QQ-CLONE-9', qty: 2 }] });
  const cl = await call('POST', `/api/quotes/${src.json().id}/clone`);
  assert.equal(cl.statusCode, 200, cl.body);
  await query(`UPDATE quotes SET memo='DVTEST-2c' WHERE id=$1`, [cl.json().id]);
  assert.equal((await devOf(cl.json().id)).length, 1, '복제 견적도 즉시 기록');
  assert.equal(cl.json().dev_lines[0].code, 'QQ-CLONE-9');

  // ── 만료 안전망: 도우미를 다시 불러도 중복 없음
  const again = await withTx((c) => recordQuoteDevDemand(c, src.json().id, {}));
  assert.equal(again.created.length, 0, '만료·전환 안전망은 중복을 만들지 않는다');

  // ── 만료 스위퍼(실제 경로): 기한 지난 견적이 expired 로 바뀌고, 대장은 여전히 한 줄.
  //    스위퍼는 오류를 삼키므로(재시도) 여기서 깨지면 견적이 **영영 만료되지 않는다** — 반드시 확인한다.
  await query(`UPDATE quotes SET reserve_expires_at = now() - interval '1 minute' WHERE id=$1`, [src.json().id]);
  clearInterval(globalThis.__refatrixExpirySweeper); delete globalThis.__refatrixExpirySweeper;
  const app2 = Fastify(); await app2.register(fastifyJwt, { secret: 'x' }); await app2.register(quoteRoutes); await app2.ready();
  t.after(() => { clearInterval(globalThis.__refatrixExpirySweeper); return app2.close(); });
  let st = null;
  for (let k = 0; k < 40 && st !== 'expired'; k++) {
    await new Promise((r) => setTimeout(r, 100));
    st = (await query(`SELECT status FROM quotes WHERE id=$1`, [src.json().id])).rows[0].status;
  }
  assert.equal(st, 'expired', '스위퍼가 도우미 때문에 실패하면 만료가 멈춘다');
  assert.equal((await devOf(src.json().id)).length, 1, '만료가 중복을 만들지 않는다');

  // ── 취소 견적은 새로 적지 않는다
  const r3 = await call('POST', '/api/quotes', { customer_id: c1, memo: 'DVTEST-3', lines: [{ product_id: pC, qty: 1 }] });
  await query(`UPDATE quotes SET status='cancelled' WHERE id=$1`, [r3.json().id]);
  await query(`INSERT INTO quote_lines (quote_id, line_no, product_id, input_code, qty, list_price, discount_rate, final_price,
                 line_subtotal, line_iva, line_total, stock_flag) VALUES ($1,9,NULL,'CANCEL-1',1,0,0,0,0,0,0,'not_found')`, [r3.json().id]);
  const rc = await withTx((c) => recordQuoteDevDemand(c, r3.json().id, {}));
  assert.equal(rc.created.length, 0, '취소 견적은 수요가 아니다');

  // ── ⑥ 0226 소급: 예전 방식으로 저장돼 대장에 없던 줄만 채운다
  const r4 = await call('POST', '/api/quotes', { customer_id: c1, memo: 'DVTEST-4', lines: [{ product_id: pC, qty: 1 }] });
  const q4 = r4.json().id;
  await query(`INSERT INTO quote_lines (quote_id, line_no, product_id, input_code, qty, list_price, discount_rate, final_price,
                 line_subtotal, line_iva, line_total, stock_flag)
               VALUES ($1,2,NULL,'old-miss-1',3,0,0,0,0,0,0,'not_found'),
                      ($1,3,NULL,'DVT-SYD-X',1,0,0,0,0,0,0,'not_found'),
                      ($1,4,NULL,'DVT-A',1,0,0,0,0,0,0,'not_found')`, [q4]);
  await query(`UPDATE quotes SET packing_printed_at=now() WHERE id=$1`, [q4]);   // 예전 누락 경로
  const sql = readFileSync(new URL('../migrations/0226_quote_devreq_backfill.sql', import.meta.url), 'utf8');
  await query(sql);
  await query(sql);   // 두 번 돌려도 같다
  const d4 = await devOf(q4);
  assert.deepEqual(d4.map((x) => x.input_code), ['old-miss-1'], '카탈로그에 있는 코드(CTR·SYD)는 소급에서도 제외');
  assert.equal(Number(d4[0].requested_qty), 3);
  assert.equal((await devOf(q1.id, true)).length, 2, '이미 있는 요청(지운 것 포함)은 소급이 건드리지 않는다');
  assert.equal((await devOf(r3.json().id)).length, 0, '취소 견적은 소급 대상이 아니다');
});
