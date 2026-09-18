// 판매중단(비활성) SKU 견적요청 — 접수 · 확정 잠금 · 수요 집계 (0224)
//
//   왜 이 시험이 있나
//     0179 는 비활성 SKU 가 담긴 새 견적을 409 로 거절했다. 거절은 **아무 기록도
//     남기지 않는다** — 고객이 단종 부품을 계속 찾고 있다는 사실이 ERP 에서 사라져
//     판매재개를 감으로 판단해야 했다. 디렉터 지시(2026-09-18):
//     「다음 단계로 넘어가지 않아도, 견적이 들어왔다는 기록은 있어야 한다.」
//
//   그래서 여기서 잠그는 것은 셋이다.
//     ① 비활성 SKU 가 있어도 **저장된다**(요청이 사라지지 않는다)
//     ② 그래도 **확정은 못 한다**(0원/단종 줄이 고객에게 나가지 않는다)
//     ③ 중단 **이후** 요청만 수요로 센다(과거 판매이력을 수요로 착각하지 않는다)
//
//   실행: TEST_PG_URL=postgres://... node --test test/inactive_demand.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;

// ── ① 소스 수준 잠금(DB 없이도 돈다) ────────────────────────────
test('매출등록은 여전히 비활성 SKU 를 막는다', () => {
  // 수요 기록은 「견적」에만 해당한다. 직접 매출등록은 실제 판매이므로 그대로 막혀야 한다.
  const s = readFileSync(new URL('../src/routes/salesRoutes.js', import.meta.url), 'utf8');
  assert.ok(/NOT is_active/.test(s) && /inactive_product/.test(s),
    '매출등록의 비활성 차단이 사라지면 단종품이 그대로 팔린다');
});

test('견적 저장 경로에서 409 거절이 사라졌다', () => {
  const q = readFileSync(new URL('../src/routes/quoteRoutes.js', import.meta.url), 'utf8');
  assert.equal(/error: 'inactive_product'/.test(q), false,
    '거절하면 요청 기록이 다시 사라진다');
  assert.ok(/screenIssue/.test(q), '대신 줄에 표시를 남겨 확정을 잠근다');
});

test('화면 경로는 inactive 만 저장한다', async () => {
  const { screenIssue } = await import('../src/quoteBuild.js');
  assert.equal(screenIssue('inactive'), 'inactive');
  // not_found·multi_match 까지 저장하면 이번 요구와 무관한 동작(코드 못 찾은 견적의 확정)이
  // 조용히 바뀐다. 포털 수신 창구만 그 둘을 저장한다.
  assert.equal(screenIssue('not_found'), null);
  assert.equal(screenIssue('multi_match'), null);
  assert.equal(screenIssue(null), null);
});

// ── ② 실 DB 종단 ───────────────────────────────────────────────
const dbTest = PG ? test : test.skip;

dbTest('접수 · 확정 잠금 · 수요 집계 (실 DB)', async (t) => {
  const { query } = await import('../src/db.js');
  const Fastify = (await import('fastify')).default;
  const fastifyJwt = (await import('@fastify/jwt')).default;
  const quoteRoutes = (await import('../src/routes/quoteRoutes.js')).default;
  const productRoutes = (await import('../src/routes/productRoutes.js')).default;
  const { demandSummary, demandRows } = await import('../src/inactiveDemand.js');
  const { productOpenItems } = await import('../src/productStatus.js');

  // 찌꺼기 청소 — 몇 번을 돌려도 같은 결과여야 한다.
  const wipe = async () => {
    await query(`DELETE FROM quote_lines WHERE quote_id IN (SELECT id FROM quotes WHERE memo LIKE 'IDTEST%')`);
    await query(`DELETE FROM quotes WHERE memo LIKE 'IDTEST%'`);
    await query(`DELETE FROM product_status_log WHERE product_id IN (SELECT id FROM products WHERE code IN ('IDT-OFF','IDT-ON'))`);
    await query(`DELETE FROM product_change_log WHERE product_id IN (SELECT id FROM products WHERE code IN ('IDT-OFF','IDT-ON'))`);
    await query(`DELETE FROM products WHERE code IN ('IDT-OFF','IDT-ON')`);
    // autoStage 가 미팅·단계 이력을 만든다 — 고객을 지우기 전에 딸린 것부터 치운다.
    for (const tbl of ['customer_meetings', 'customer_stage_history', 'stage_log',
      'customer_rfc_claims', 'customer_registration_events', 'customer_terms_history']) {
      try { await query(`DELETE FROM ${tbl} WHERE customer_id IN (SELECT id FROM customers WHERE code IN ('T-ID01','T-ID02'))`); }
      catch (_) { /* 그런 테이블이 없으면 넘어간다 */ }
    }
    await query(`DELETE FROM customers WHERE code IN ('T-ID01','T-ID02')`);
    try {
      await query(`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE login_id='t_id_dir')`);
      await query(`DELETE FROM users WHERE login_id='t_id_dir'`);
    } catch (_) { await query(`UPDATE users SET login_id='t_id_dir_'||id WHERE login_id='t_id_dir'`); }
  };
  await wipe();
  t.after(wipe);

  const cust = async (code, name, rfc) => Number((await query(
    `INSERT INTO customers (code, name, rfc, discount, credit_days, approval_status)
     VALUES ($1,$2,$3,10,30,'approved') RETURNING id`, [code, name, rfc])).rows[0].id);
  const c1 = await cust('T-ID01', 'CLIENTE DEMANDA UNO', 'IDT010203AA1');
  const c2 = await cust('T-ID02', 'CLIENTE DEMANDA DOS', 'IDT010203BB2');

  const prod = async (code, name) => Number((await query(
    `INSERT INTO products (code, name, list_price, stock_qty, is_active)
     VALUES ($1,$2,100,50,true) RETURNING id`, [code, name])).rows[0].id);
  const pOff = await prod('IDT-OFF', 'SKU QUE SE DESCONTINUA');
  const pOn = await prod('IDT-ON', 'SKU NORMAL');

  const dirId = Number((await query(
    `INSERT INTO users (login_id, name, role, pin_hash) VALUES ($1,$2,'director','x') RETURNING id`,
    ['t_id_dir', '수요시험 디렉터'])).rows[0].id);

  const app = Fastify();
  await app.register(fastifyJwt, { secret: 'test-secret-0224' });
  await app.register(quoteRoutes);
  await app.register(productRoutes);
  await app.ready();
  t.after(() => app.close());
  const tok = app.jwt.sign({ sub: dirId });
  const call = (method, url, payload) => app.inject({ method, url, payload,
    headers: { authorization: 'Bearer ' + tok } });

  // ── ⓐ 중단 **전**에 만든 견적 — 나중에 수요로 잡히면 안 된다.
  const before = await call('POST', '/api/quotes',
    { customer_id: c1, memo: 'IDTEST-before', lines: [{ product_id: pOff, qty: 3 }] });
  assert.equal(before.statusCode, 200, '활성 SKU 견적은 예전 그대로');
  const beforeId = before.json().id;
  assert.equal((before.json().inactive_lines || []).length, 0);

  // ── ⓑ 판매중단 전환(화면과 같은 경로 — 이력이 남아야 since 가 생긴다)
  const off = await call('PATCH', `/api/products/${pOff}/active`, { active: false, reason: '단종 — 공장 생산중단' });
  assert.equal(off.statusCode, 200);
  const sinceRow = (await query(
    `SELECT changed_at FROM product_status_log WHERE product_id=$1 AND action='deactivate'
      ORDER BY changed_at DESC LIMIT 1`, [pOff])).rows[0];
  assert.ok(sinceRow, '판매중단 이력이 남아야 수요 기준 시각이 생긴다');

  // ── ⓒ 중단 **후** 견적 — 거절되지 않고 접수된다 (이번 요구의 핵심)
  const after = await call('POST', '/api/quotes',
    { customer_id: c1, memo: 'IDTEST-after', lines: [{ product_id: pOff, qty: 5 }, { product_id: pOn, qty: 2 }] });
  assert.equal(after.statusCode, 200, '거절하면 요청 기록이 사라진다');
  const qAfter = after.json();
  assert.equal(qAfter.inactive_lines.length, 1, '어느 줄이 문제인지 화면에 돌려준다');
  assert.equal(qAfter.inactive_lines[0].code, 'IDT-OFF');
  assert.match(qAfter.inactive_note, /확정할 수 없습니다/);
  const linesAfter = (await query(
    `SELECT product_id, issue FROM quote_lines WHERE quote_id=$1 ORDER BY line_no`, [qAfter.id])).rows;
  assert.equal(linesAfter[0].issue, 'inactive', '비활성 줄만 표시');
  assert.equal(linesAfter[1].issue, null, '정상 줄은 깨끗하게');

  // ── ⓓ 그래도 확정은 못 한다
  const conf = await call('POST', `/api/quotes/${qAfter.id}/status`, { status: 'confirmed' });
  assert.equal(conf.statusCode, 409);
  assert.equal(conf.json().error, 'quote_has_issues');
  assert.equal(conf.json().inactive_count, 1);
  assert.match(conf.json().note, /판매중단/);
  assert.match(conf.json().note, /요청 기록은 그대로 남습니다/);

  // ── ⓔ 문제 줄을 지우면 확정된다
  const fix = await call('PUT', `/api/quotes/${qAfter.id}`,
    { customer_id: c1, memo: 'IDTEST-after', lines: [{ product_id: pOn, qty: 2 }] });
  assert.equal(fix.statusCode, 200);
  assert.equal((fix.json().inactive_lines || []).length, 0);
  const conf2 = await call('POST', `/api/quotes/${qAfter.id}/status`, { status: 'confirmed' });
  assert.equal(conf2.statusCode, 200, '고치면 넘어간다');
  // 되돌려 놓는다(아래 수요 집계가 이 견적을 세야 한다)
  await call('PUT', `/api/quotes/${qAfter.id}`,
    { customer_id: c1, memo: 'IDTEST-after', lines: [{ product_id: pOff, qty: 5 }, { product_id: pOn, qty: 2 }] });
  const reflag = (await query(
    `SELECT issue FROM quote_lines WHERE quote_id=$1 AND product_id=$2`, [qAfter.id, pOff])).rows[0];
  assert.equal(reflag.issue, 'inactive', '중단 후 만들어진 견적은 수정해도 잠금이 풀리지 않는다');

  // ── ⓕ 중단 **전**에 만든 견적은 수정해도 표시가 붙지 않는다 (예전 오더를 계속 정리할 수 있어야 한다)
  const editOld = await call('PUT', `/api/quotes/${beforeId}`,
    { customer_id: c1, memo: 'IDTEST-before', lines: [{ product_id: pOff, qty: 4 }] });
  assert.equal(editOld.statusCode, 200);
  assert.equal((editOld.json().inactive_lines || []).length, 0, '중단 전 견적은 예전처럼 동작');
  const oldLine = (await query(`SELECT issue FROM quote_lines WHERE quote_id=$1`, [beforeId])).rows[0];
  assert.equal(oldLine.issue, null);
  const confOld = await call('POST', `/api/quotes/${beforeId}/status`, { status: 'confirmed' });
  assert.equal(confOld.statusCode, 200, '중단 전 확정된 오더의 인보이스 발행 경로가 막히면 안 된다');

  // ── ⓖ 복제도 같은 규칙 — 막지 않고 표시한다
  const clone = await call('POST', `/api/quotes/${beforeId}/clone`);
  assert.equal(clone.statusCode, 200, '복제를 막으면 만료 견적 회생이 끊긴다');
  assert.equal(clone.json().inactive_lines.length, 1, '새 견적이므로 표시는 붙는다');
  await query(`UPDATE quotes SET memo='IDTEST-clone' WHERE id=$1`, [clone.json().id]);

  // ── ⓖ-2 다음 단계(포장·매출 전환)도 막힌다 — 「확정」은 화면에 버튼이 없으므로
  //      실제로 흐름을 세우는 지점은 여기다. 여기를 안 막으면 확정 잠금은 형식일 뿐이다.
  const pack = await call('POST', `/api/quotes/${qAfter.id}/packing-printed`);
  assert.equal(pack.statusCode, 409);
  assert.equal(pack.json().error, 'inactive_product_lines');
  assert.match(pack.json().note, /포장/);
  assert.equal(pack.json().items[0].code, 'IDT-OFF');
  const conv = await call('POST', `/api/quotes/${qAfter.id}/convert`, {});
  assert.equal(conv.statusCode, 409);
  assert.equal(conv.json().error, 'inactive_product_lines');
  assert.match(conv.json().note, /매출 전환/);

  // 중단 **전**에 만든 견적은 그대로 포장으로 넘어간다(예전 오더의 흐름을 막지 않는다).
  const packOld = await call('POST', `/api/quotes/${beforeId}/packing-printed`);
  assert.equal(packOld.statusCode, 200, '비활성 전 오더의 포장·인보이스 경로는 열려 있어야 한다');

  // ── ⓖ-3 견적 목록에도 「판매중단 N줄」이 실린다 — 왜 안 넘어가는지 목록에서 보여야 한다.
  const list = await call('GET', '/api/quotes?open=1');
  assert.equal(list.statusCode, 200, '목록 쿼리가 깨지면 견적 화면 전체가 죽는다');
  const rowAfter = (list.json().items || []).find((x) => Number(x.id) === Number(qAfter.id));
  assert.ok(rowAfter, '수신 견적이 목록에 있다');
  assert.equal(rowAfter.inactive_cnt, 1);
  const rowBefore = (list.json().items || []).find((x) => Number(x.id) === Number(beforeId));
  assert.equal(rowBefore.inactive_cnt, 0, '중단 전 오더에는 표시가 없다');

  // ── ⓗ 두 번째 고객의 요청 — 고객 수가 2 가 돼야 한다
  const other = await call('POST', '/api/quotes',
    { customer_id: c2, memo: 'IDTEST-c2', lines: [{ product_id: pOff, qty: 7 }] });
  assert.equal(other.statusCode, 200);

  // ── ⓘ 취소한 견적은 수요에서 빠진다 (요청을 거둬들인 것)
  const cancelled = await call('POST', '/api/quotes',
    { customer_id: c2, memo: 'IDTEST-cancel', lines: [{ product_id: pOff, qty: 99 }] });
  await call('POST', `/api/quotes/${cancelled.json().id}/status`, { status: 'cancelled' });

  // ── ⓙ 수요 집계
  const sum = await demandSummary({ productIds: [pOff, pOn] });
  assert.equal(sum.length, 1, '활성 SKU 는 수요 대상이 아니다');
  const d = sum[0];
  assert.equal(d.product_id, pOff);
  // after(5) + clone(4) + c2(7) = 16 · 견적 3건 · 고객 2곳.
  // before 견적(중단 전 생성)과 취소 견적은 빠진다.
  assert.equal(d.req_n, 3, `중단 후 요청만 센다 (got ${d.req_n})`);
  assert.equal(Number(d.req_qty), 16, `수량 합 (got ${d.req_qty})`);
  assert.equal(d.cust_n, 2);
  assert.ok(d.since_at, '기준 시각이 실려야 판단이 된다');

  // ── ⓚ 드릴다운 내역
  const det = await demandRows(pOff);
  assert.equal(det.items.length, 3);
  assert.ok(det.items.every((x) => x.origin === 'erp'), '화면에서 만든 요청');
  assert.ok(det.items.every((x) => x.customer), '고객이 붙어 있어야 판단에 쓸 수 있다');

  // ── ⓛ API 로도 같은 숫자가 나온다
  const apiSum = await call('GET', `/api/products/inactive-demand?ids=${pOff},${pOn}`);
  assert.equal(apiSum.statusCode, 200);
  assert.equal(apiSum.json().items.length, 1);
  assert.equal(apiSum.json().items[0].req_n, 3);
  const apiDet = await call('GET', `/api/products/${pOff}/inactive-demand`);
  assert.equal(apiDet.statusCode, 200);
  assert.equal(apiDet.json().items.length, 3);

  // ── ⓜ 판매재개 판단 화면(점검)에도 수요가 실린다 — 미결 건수는 안 올린다
  const pipe = await productOpenItems(pOff);
  assert.equal(pipe.summary.demand.n, 3, '판매재개 검토에서 바로 보여야 한다');
  assert.equal(pipe.summary.demand.info, true);
  const openRows = pipe.rows.filter((r) => r.bucket === 'demand');
  assert.ok(openRows.every((r) => r.info === true), '수요는 미결이 아니다');
  assert.equal(pipe.open_total, pipe.rows.filter((r) => !r.info).length,
    '수요가 미결 건수를 부풀리면 판단이 흐려진다');

  // ── ⓝ 활성 SKU 에는 수요 버킷이 비어 있다
  const pipeOn = await productOpenItems(pOn);
  assert.equal(pipeOn.summary.demand.n, 0);

  // ── ⓞ 판매재개하면 수요 대상에서 빠진다(다시 정상 판매)
  await call('PATCH', `/api/products/${pOff}/active`, { active: true, reason: '재개' });
  assert.equal((await demandSummary({ productIds: [pOff] })).length, 0);
});
