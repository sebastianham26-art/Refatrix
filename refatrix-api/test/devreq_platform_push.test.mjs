// devreq_platform_push.test.mjs — 개발요청 → REFATRIX Platform 0순위 「고객요청 개발필요」 (2026-11-09)
//
//   잠그는 것
//     ① 묶음 규칙: 미완료만 · 검토 SYD 우선 · 여러 코드 칸 분리 · 대소문자/기호 무시 · 수량 합계(미입력=1)
//     ② 첫 전송 = replace(전체) → 이후는 바뀐 코드만 upsert · 빠진 코드만 delete
//     ③ 실패하면 다음 점검이 같은 차이를 다시 보낸다 · 키가 없으면 아무 호출도 안 한다
//     ④ 이벤트 지점: 견적 저장(recordQuoteDevDemand) · 수동 접수 · 취소 · 개발완료 · 자동 매칭
//     ⑤ 플랫폼 보조 조회 GET /api/pf-catalog/dev-requests (pf 토큰만 · 가격·고객명 없음)
//     ⑥ 견적 흐름은 막지 않는다(플랫폼이 죽어도 견적 저장 성공)
//
//   실행: TEST_PG_URL=postgres://... node --test --test-concurrency=1 test/devreq_platform_push.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;

const P = await import('../src/devReqPush.js');

test('순수: 코드 묶음 규칙', () => {
  assert.deepEqual(P.devReqCodes({ input_code: ' 1f2z-3068 ' }), ['1F2Z-3068']);
  assert.deepEqual(P.devReqCodes({ input_code: 'BAW-1', review_syd_code: 'k-7001' }), ['K-7001'], '검토 SYD 우선');
  assert.deepEqual(P.devReqCodes({ input_code: 'AB12-3 / R / CD34-5' }), ['AB12-3', 'CD34-5'], '여러 코드 · 4자 미만 꼬리표 버림');
  assert.deepEqual(P.devReqCodes({ input_code: '' }), []);

  const m = P.buildDevReqItems([
    { id: 1, input_code: '1F2Z-3068', requested_qty: 3, requested_at: '2026-11-01', customer_id: 10, status: 'received' },
    { id: 2, input_code: '1f2z3068', requested_qty: null, requested_at: '2026-11-09', customer_id: 11, status: 'reviewed' },
    { id: 3, input_code: '1F2Z-3068', requested_qty: 2, requested_at: '2026-11-05', customer_id: null, status: 'factory_requested' },
    { id: 4, input_code: '1F2Z-3068', requested_qty: 99, requested_at: '2026-11-05', customer_id: 12, status: 'developed' },
    { id: 5, input_code: '1F2Z-3068', requested_qty: 99, requested_at: '2026-11-05', customer_id: 12, status: 'cancelled' },
    { id: 6, input_code: 'ZZ99', requested_qty: 1, requested_at: '2026-11-02', customer_id: 10, status: 'received', deleted_at: '2026-11-03' },
  ]);
  assert.equal(m.size, 1, '완료 · 취소 · 삭제 제외 / 정규화로 한 묶음');
  const it = m.get('1F2Z3068');
  assert.equal(it.syd, '1F2Z-3068', '가장 많이 쓴 표기');
  assert.equal(it.qty, 6, '3 + (미입력=1) + 2');
  assert.equal(it.first_at, '2026-11-01T06:00:00Z', '멕시코 00:00 = UTC 06:00');
  assert.equal(it.last_at, '2026-11-10T05:59:59Z', '마지막 요청일 하루 끝');
  assert.equal(it.note, '요청 3건 · 고객 2곳 (불특정 1건)');
  assert.equal(it.customer, undefined, '고객명은 보내지 않는다');
  assert.equal(Object.keys(it).some((k) => /price|amount|precio/i.test(k)), false, '가격 없음');

  const a = new Map([['X1', { syd: 'X-1', qty: 1 }], ['Y1', { syd: 'Y-1', qty: 1 }], ['Z1', { syd: 'Z-1', qty: 1 }]]);
  const b = new Map([['X1', { syd: 'X-1', qty: 1 }], ['Y1', { syd: 'Y-1', qty: 2 }], ['W1', { syd: 'W-1', qty: 1 }], ['Z1', { syd: 'Z1', qty: 1 }]]);
  const d = P.diffDevReq(a, b);
  assert.deepEqual(d.upserts.map((x) => x.syd).sort(), ['W-1', 'Y-1', 'Z1']);
  assert.deepEqual(d.deletes.map((x) => x.syd).sort(), ['Z-1'], '표기 변경 → 옛 표기 해제');
});

test('소스: 이벤트 지점이 전부 연결돼 있다', () => {
  const rd = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
  assert.match(rd('quoteDevDemand.js'), /if \(out\.created\.length \|\| out\.updated\) scheduleDevReqPush\(\)/);
  assert.match(rd('devMatchSweep.js'), /if \(items\.length\) scheduleDevReqPush\(\)/);
  const r = rd('routes/devRequestRoutes.js');
  assert.ok((r.match(/scheduleDevReqPush\(\)/g) || []).length >= 5, '접수 · 검토 · 개발완료 · 나누기 · 취소');
  assert.match(r, /startDevReqPushWorker\(\)/);
  assert.match(rd('routes/pfCatalogRoutes.js'), /\/api\/pf-catalog\/dev-requests/);
  assert.match(rd('secrets.js'), /REFATRIX_DEVREQ_KEY/);
  assert.equal(/sb_secret|service_role/.test(rd('devReqPush.js')), false, '비밀키 하드코딩 없음');
  assert.equal(/REFATRIX_DEVREQ_KEY\s*=\s*['"]/.test(rd('devReqPush.js')), false);
});

const dbTest = PG ? test : test.skip;

dbTest('실 DB: replace → diff → 실패 재시도 → 이벤트 지점 · 보조 조회', async (t) => {
  const { query, withTx } = await import('../src/db.js');
  const Fastify = (await import('fastify')).default;
  const fastifyJwt = (await import('@fastify/jwt')).default;
  const devRequestRoutes = (await import('../src/routes/devRequestRoutes.js')).default;
  const pfCatalogRoutes = (await import('../src/routes/pfCatalogRoutes.js')).default;
  const quoteRoutes = (await import('../src/routes/quoteRoutes.js')).default;

  // 가짜 플랫폼
  const calls = [];
  let fail = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opt) => {
    if (!String(url).includes('/rpc/app_devreq_push')) return realFetch(url, opt);
    const body = JSON.parse(opt.body);
    calls.push({ url: String(url), headers: opt.headers, ...body });
    if (fail) return new Response('{"code":"P0001","message":"boom"}', { status: 500 });
    return new Response(JSON.stringify({ ok: true, mode: body.p_mode, n: body.p_items.length, ver: calls.length, total: 0 }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const wipe = async () => {
    await query(`DELETE FROM product_dev_requests WHERE customer_id IN (SELECT id FROM customers WHERE code LIKE 'T-DRP%')`);
    await query(`DELETE FROM product_dev_requests WHERE input_code LIKE 'DRP%' OR review_syd_code LIKE 'DRP%' OR source_quote_id IN (SELECT id FROM quotes WHERE memo LIKE 'DRPTEST%')`);
    await query(`DELETE FROM quote_lines WHERE quote_id IN (SELECT id FROM quotes WHERE memo LIKE 'DRPTEST%')`);
    await query(`DELETE FROM quotes WHERE memo LIKE 'DRPTEST%'`);
    await query(`DELETE FROM stock_shortages WHERE product_id IN (SELECT id FROM products WHERE code LIKE 'DRP-%')`);
    await query(`DELETE FROM offer_sheet_items WHERE product_id IN (SELECT id FROM products WHERE code LIKE 'DRP-%')`).catch(() => {});
    await query(`DELETE FROM product_syd_codes WHERE product_id IN (SELECT id FROM products WHERE code LIKE 'DRP-%')`);
    await query(`DELETE FROM todos WHERE title LIKE '%DRP%' OR assignee_id IN (SELECT id FROM users WHERE login_id='t_drp_dir') OR created_by IN (SELECT id FROM users WHERE login_id='t_drp_dir')`);
    await query(`DELETE FROM products WHERE code LIKE 'DRP-%'`);
    for (const tbl of ['customer_meetings', 'customer_stage_history', 'stage_log', 'customer_rfc_claims',
      'customer_registration_events', 'customer_terms_history']) {
      try { await query(`DELETE FROM ${tbl} WHERE customer_id IN (SELECT id FROM customers WHERE code LIKE 'T-DRP%')`); } catch (_) { /* */ }
    }
    await query(`DELETE FROM customers WHERE code LIKE 'T-DRP%'`);
    await query(`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE login_id='t_drp_dir')`);
    await query(`DELETE FROM users WHERE login_id='t_drp_dir'`);
  };
  await wipe();
  t.after(async () => { await wipe(); const { pool } = await import('../src/db.js'); await pool.end().catch(() => {}); setTimeout(() => process.exit(process.exitCode || 0), 300); });
  // 다른 시험 데이터가 섞이지 않게 — 이 DB 의 미완료 요청은 이 시험 것만
  const others = Number((await query(`SELECT count(*) n FROM product_dev_requests WHERE deleted_at IS NULL AND status IN ('received','reviewed','factory_requested')`)).rows[0].n);
  assert.equal(others, 0, '시험 DB 는 비어 있어야 한다');

  const c1 = Number((await query(`INSERT INTO customers (code,name,rfc,discount,credit_days,approval_status) VALUES ('T-DRP1','CLIENTE UNO','DRP010203AA1',10,30,'approved') RETURNING id`)).rows[0].id);
  const c2 = Number((await query(`INSERT INTO customers (code,name,rfc,discount,credit_days,approval_status) VALUES ('T-DRP2','CLIENTE DOS','DRP010203AA2',10,30,'approved') RETURNING id`)).rows[0].id);
  const dirId = Number((await query(`INSERT INTO users (login_id,name,role,pin_hash) VALUES ('t_drp_dir','DRP 디렉터','director','x') RETURNING id`)).rows[0].id);
  const ins = async (code, cust, qty, d, status = 'received', syd = null) => Number((await query(
    `INSERT INTO product_dev_requests (input_code, review_syd_code, customer_id, requested_qty, requested_at, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [code, syd, cust, qty, d, status, dirId])).rows[0].id);

  const r1 = await ins('DRP-1001', c1, 3, '2026-11-01');
  await ins('drp1001', c2, null, '2026-11-08');
  const r3 = await ins('BAW-XX', c1, 2, '2026-11-03', 'reviewed', 'DRP-2002');
  await ins('DRP-3003', c1, 5, '2026-11-02', 'developed');

  // ── 키 없음 → 아무 호출도 없다
  delete process.env.REFATRIX_DEVREQ_KEY;
  P._resetDevReqPush();
  const nk = await P.syncDevReq();
  assert.equal(nk.skipped, 'no_key');
  assert.equal(calls.length, 0);

  process.env.REFATRIX_DEVREQ_KEY = 'k'.repeat(64);

  // ── ② 첫 전송 = replace
  const s1 = await P.syncDevReq();
  assert.equal(s1.ok, true); assert.equal(s1.mode, 'replace');
  assert.equal(calls.length, 1);
  const c0 = calls[0];
  assert.match(c0.url, /hvwteeecvukddmurzlfm\.supabase\.co\/rest\/v1\/rpc\/app_devreq_push$/);
  assert.equal(c0.headers.apikey, 'sb_publishable_-hlx1MHlTNEwyif6nePYHA_ue_r8mV0');
  assert.equal(c0.headers.Authorization, 'Bearer sb_publishable_-hlx1MHlTNEwyif6nePYHA_ue_r8mV0');
  assert.equal(c0.p_key, 'k'.repeat(64));
  assert.equal(c0.p_mode, 'replace');
  const bySyd = Object.fromEntries(c0.p_items.map((x) => [x.syd, x]));
  assert.deepEqual(Object.keys(bySyd).sort(), ['DRP-1001', 'DRP-2002'], '개발완료 제외 · 검토 SYD 로 요약');
  assert.equal(bySyd['DRP-1001'].qty, 4, '3 + 미입력 1');
  assert.equal(bySyd['DRP-1001'].note, '요청 2건 · 고객 2곳');
  assert.equal(bySyd['DRP-1001'].first_at, '2026-11-01T06:00:00Z');

  // 변화 없음 → 호출 없음
  await P.syncDevReq();
  assert.equal(calls.length, 1, '바뀐 게 없으면 안 보낸다');

  // ── 바뀐 코드만 upsert · 빠진 코드만 delete
  await query(`UPDATE product_dev_requests SET status='cancelled' WHERE id=$1`, [r3]);
  await ins('DRP-4004', c2, 1, '2026-11-09');
  await P.syncDevReq();
  assert.equal(calls.length, 3);
  assert.equal(calls[1].p_mode, 'delete'); assert.deepEqual(calls[1].p_items, [{ syd: 'DRP-2002' }]);
  assert.equal(calls[2].p_mode, 'upsert'); assert.deepEqual(calls[2].p_items.map((x) => x.syd), ['DRP-4004']);

  // ── ③ 실패 → 다음 점검이 같은 차이를 다시 보낸다
  fail = true;
  await query(`UPDATE product_dev_requests SET requested_qty=10 WHERE id=$1`, [r1]);
  const sf = await P.syncDevReq();
  assert.equal(sf.ok, false);
  fail = false;
  const sr = await P.syncDevReq();
  assert.equal(sr.ok, true);
  const last = calls[calls.length - 1];
  assert.equal(last.p_mode, 'upsert'); assert.equal(last.p_items[0].syd, 'DRP-1001'); assert.equal(last.p_items[0].qty, 11);
  assert.equal(P.devReqPushState().log[0].ok, true);

  // ── ④ 이벤트 지점 — 라우트
  const app = Fastify();
  await app.register(fastifyJwt, { secret: 'test-secret-drp' });
  await app.register(devRequestRoutes);
  await app.register(pfCatalogRoutes);
  await app.register(quoteRoutes);
  await app.ready();
  t.after(() => app.close());
  const tok = app.jwt.sign({ sub: dirId });
  const call = (method, url, payload, tk = tok) => app.inject({ method, url, payload, headers: { authorization: 'Bearer ' + tk } });

  // 수동 접수 → 5초 뒤 upsert
  let n0 = calls.length;
  const cr = await call('POST', '/api/dev-requests', { input_code: 'DRP-5005', customer_id: c1, requested_qty: 2 });
  assert.equal(cr.statusCode, 200);
  await sleep(6500);
  let ev = calls.slice(n0);
  assert.ok(ev.some((x) => x.p_mode === 'upsert' && x.p_items.some((i) => i.syd === 'DRP-5005')), '접수 → upsert');

  // 취소 → delete
  n0 = calls.length;
  const id5 = Number(cr.json().id);
  assert.equal((await call('PUT', `/api/dev-requests/${id5}/cancel`)).statusCode, 200);
  await sleep(6500);
  ev = calls.slice(n0);
  assert.ok(ev.some((x) => x.p_mode === 'delete' && x.p_items.some((i) => i.syd === 'DRP-5005')), '취소 → delete');

  // 견적 저장(미등록 코드) → upsert · ⑥ 플랫폼이 죽어 있어도 견적은 저장된다
  fail = true;
  n0 = calls.length;
  const qr = await call('POST', '/api/quotes', { customer_id: c2, memo: 'DRPTEST-1', quote_date: '2026-11-09', lines: [{ code: 'DRP-6006', qty: 4 }] });
  assert.equal(qr.statusCode, 200, '플랫폼 실패와 무관하게 견적 저장');
  await sleep(6500);
  assert.ok(calls.slice(n0).some((x) => x.p_items.some((i) => i.syd === 'DRP-6006')), '견적 저장 → 전송 시도');
  fail = false;
  n0 = calls.length;
  await P.syncDevReq();   // 10분 점검이 줍는다
  assert.ok(calls.slice(n0).some((x) => x.p_mode === 'upsert' && x.p_items.some((i) => i.syd === 'DRP-6006' && i.qty === 4)), '실패분 재전송');

  // 자동 매칭 개발완료 → delete
  const pid = Number((await query(`INSERT INTO products (code,name,list_price,stock_qty,is_active) VALUES ('DRP-P1','ROTULA DRP',100,0,true) RETURNING id`)).rows[0].id);
  await query(`INSERT INTO product_syd_codes (product_id, syd_code) VALUES ($1,'DRP-4004')`, [pid]);
  n0 = calls.length;
  const sw = await call('POST', '/api/dev-requests/match-sweep');
  assert.equal(sw.statusCode, 200);
  assert.ok(sw.json().matched >= 1);
  await sleep(6500);
  assert.ok(calls.slice(n0).some((x) => x.p_mode === 'delete' && x.p_items.some((i) => i.syd === 'DRP-4004')), '자동 개발완료 → delete');

  // 디렉터 수동 전체 동기화
  n0 = calls.length;
  const mp = await call('POST', '/api/dev-requests/platform-push', {});
  assert.equal(mp.statusCode, 200);
  assert.equal(calls[n0].p_mode, 'replace');
  assert.deepEqual(calls[n0].p_items.map((x) => x.syd).sort(), ['DRP-1001', 'DRP-6006']);
  assert.equal((await call('GET', '/api/dev-requests/platform-push')).json().enabled, true);

  // ⑤ 보조 조회 — pf 토큰만
  assert.equal((await call('GET', '/api/pf-catalog/dev-requests')).statusCode, 401, 'ERP 토큰으로는 못 연다');
  const pfTok = app.jwt.sign({ sub: 'pfcat', typ: 'pf_cat', uk: 'u1', name: 'PF' });
  const gr = await call('GET', '/api/pf-catalog/dev-requests', null, pfTok);
  assert.equal(gr.statusCode, 200, gr.body);
  assert.deepEqual(gr.json().items.map((x) => x.syd), ['DRP-1001', 'DRP-6006'], '수량 큰 순');
  assert.equal(/CLIENTE/.test(gr.body), false, '고객명 없음');
});
