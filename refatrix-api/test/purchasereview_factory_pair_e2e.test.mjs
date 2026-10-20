// =====================================================================
// 구매검토 · 공장 SKU 정보 업로드 · L/R 짝맞춤 · 발주서 초안 · SYD(카탈로그) · 견적 짝 안내
//   (pr-1020lr · qt-1020lr) — 실 PostgreSQL 종단 검증 · 2026-10-20
//   실행: TEST_PG_URL=postgres://... node --test test/purchasereview_factory_pair_e2e.test.mjs
// =====================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL;
const SKIP = !PG;
if (SKIP) console.log('[skip] TEST_PG_URL 없음 — 실 Postgres 검증 생략');
if (PG) process.env.DATABASE_URL = PG;

let query, app;
const ID = {};
const tok = {};
const P = 'ZX9';          // 짝 규칙(영문 2자 + 숫자 + L/R)에 맞는 시험용 코드
const TAG = 'PRFP';

async function cleanup() {
  const pids = (await query(`SELECT id FROM products WHERE code LIKE '${P}%' OR code = 'PROZX91'`)).rows.map((r) => Number(r.id));
  const cids = (await query(`SELECT id FROM customers WHERE name LIKE '${TAG}%'`)).rows.map((r) => Number(r.id));
  await query(`DELETE FROM product_factory_log WHERE product_id = ANY($1::bigint[])`, [pids]);
  await query(`DELETE FROM product_price_history WHERE product_id = ANY($1::bigint[])`, [pids]);
  await query(`DELETE FROM product_xref_codes WHERE product_id = ANY($1::bigint[])`, [pids]);
  await query(`DELETE FROM product_syd_codes WHERE product_id = ANY($1::bigint[])`, [pids]);
  await query(`DELETE FROM stock_shortages WHERE product_id = ANY($1::bigint[])`, [pids]);
  await query(`DELETE FROM quotes WHERE customer_id = ANY($1::bigint[])`, [cids]);
  await query(`DELETE FROM products WHERE id = ANY($1::bigint[])`, [pids]);
  await query(`DELETE FROM customers WHERE id = ANY($1::bigint[])`, [cids]);
  const uids = (await query(`SELECT id FROM users WHERE login_id LIKE 'prfp%'`)).rows.map((r) => Number(r.id));
  await query(`DELETE FROM audit_log WHERE user_id = ANY($1::bigint[])`, [uids]).catch(() => {});
  await query(`DELETE FROM user_page_access WHERE user_id = ANY($1::bigint[])`, [uids]).catch(() => {});
  await query(`DELETE FROM users WHERE id = ANY($1::bigint[])`, [uids]);
}
const H = (who = 'dir') => ({ authorization: 'Bearer ' + tok[who] });
const get = (url, who) => app.inject({ method: 'GET', url, headers: H(who) });
const post = (url, body, who) => app.inject({ method: 'POST', url, payload: body || {}, headers: H(who) });
const list = async (qs) => (await get(`/api/purchases/review?${qs}`)).json();
const row = async (code) => (await list(`q=${code}`)).items.find((x) => x.ctr === code);

test('boot', { skip: SKIP }, async () => {
  ({ query } = await import('../src/db.js'));
  const { hashPin } = await import('../src/auth.js');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await cleanup();
  ID.dir = Number((await query(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ('${TAG}디렉터','director',$1,'prfp_dir') RETURNING id`, [hashPin('4321')])).rows[0].id);
  ID.staff = Number((await query(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ('${TAG}직원','ops',$1,'prfp_staff') RETURNING id`, [hashPin('4321')])).rows[0].id);
  await query(`INSERT INTO user_page_access (user_id, page_key, device_req) VALUES ($1,'purchase','anywhere')`, [ID.staff]);   // 구매 화면은 열리지만 디렉터는 아님
  const mkP = async (code, stock, origin) => Number((await query(
    `INSERT INTO products (code, name, stock_qty, avg_cost, list_price, ean, is_active, origin)
     VALUES ($1,'RÓTULA',$2,100,500,$3,true,$4) RETURNING id`,
    [code, stock, '76' + String(Math.floor(Math.random() * 1e10)).padStart(11, '0'), origin])).rows[0].id);
  ID.aL = await mkP(`${P}001L`, 0, 'KR');   // L 만 수요 4
  ID.aR = await mkP(`${P}001R`, 1, 'KR');   // R 수요 없음, 재고 1
  ID.bL = await mkP(`${P}002L`, 0, 'China');
  ID.bR = await mkP(`${P}002R`, 0, 'China');
  ID.cL = await mkP(`${P}003L`, 0, 'KR');   // 나중에 단산
  ID.cR = await mkP(`${P}003R`, 0, 'KR');
  ID.single = await mkP(`${P}004`, 0, 'TR');
  ID.pro = await mkP('PROZX91', 0, 'CN');   // PRO(마케팅 판촉물) — 구매에서 제외
  // FOB: 001L 은 가격 마스터 이력(오늘 이전 유효) 2.50 이 products.fob_usd 1.00 보다 우선 · 001R 은 fob_usd 3 · 002L/R 1.2 · 004 없음
  await query(`UPDATE products SET fob_usd=1 WHERE id=$1`, [ID.aL]);
  await query(`UPDATE products SET fob_usd=3 WHERE id=$1`, [ID.aR]);
  await query(`UPDATE products SET fob_usd=1.2 WHERE id = ANY($1::bigint[])`, [[ID.bL, ID.bR]]);
  await query(`INSERT INTO product_price_history (product_id, price_type, effective_date, new_price, source) VALUES ($1,'fob',CURRENT_DATE - 10,2.5,'manual')`, [ID.aL]);
  ID.c = Number((await query(
    `INSERT INTO customers (name, code, credit_days, rfc, owner_id, created_by, discount) VALUES ($1,$2,30,$3,$4,$4,0) RETURNING id`,
    [`${TAG}고객`, `${TAG}-C`, `PFP${String(Date.now()).slice(-6)}AB1`, ID.dir])).rows[0].id);
  const mkS = (pid, qty) => query(
    `INSERT INTO stock_shortages (product_id, customer_id, requested_qty, fulfilled_qty, shortage_qty, shortage_amount_mxn, occurred_at, note)
     VALUES ($1,$2,$3,0,$3,0,CURRENT_DATE,'${TAG}')`, [pid, ID.c, qty]);
  await mkS(ID.aL, 4); await mkS(ID.bL, 3); await mkS(ID.cL, 5); await mkS(ID.single, 2); await mkS(ID.pro, 9);
  await query(`INSERT INTO product_syd_codes (product_id, syd_code) VALUES ($1,'1010101')`, [ID.aL]);
  await query(`INSERT INTO product_xref_codes (product_id, xref_code, norm_code, brand) VALUES ($1,'1010101','1010101','SYD1'),($1,'2020202','2020202','SYD1'),($1,'K-777','K777','MOOG')`, [ID.aL]);
  await query(`INSERT INTO product_xref_codes (product_id, xref_code, norm_code, brand) VALUES ($1,'3030303','3030303','SYD')`, [ID.aR]);

  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret' });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (r, body, done) => {
    if (!body || !String(body).trim()) return done(null, {});
    try { done(null, JSON.parse(body)); } catch (e) { e.statusCode = 400; done(e); }
  });
  for (const f of ['purchaseRoutes', 'quoteRoutes']) await app.register((await import(`../src/routes/${f}.js`)).default);
  await app.ready();
  tok.dir = app.jwt.sign({ sub: ID.dir });
  tok.staff = app.jwt.sign({ sub: ID.staff });
});

test('① L/R 짝 — L 만 수요 4 → R 도 짝 기준으로 추천(재고 1 빼고 3) · 나란히', { skip: SKIP }, async () => {
  const d = await list(`q=${P}001L`);
  assert.deepEqual(d.items.map((x) => x.ctr), [`${P}001L`, `${P}001R`], 'L 로 검색해도 R 이 같이 나온다');
  const [L, R] = d.items;
  assert.deepEqual([L.pair_code, L.rec_own_qty, L.rec_qty, L.pair_adjusted], [`${P}001R`, 4, 4, false]);
  assert.deepEqual([R.pair_code, R.rec_own_qty, R.pair_demand, R.rec_raw_qty, R.rec_qty, R.pair_adjusted], [`${P}001L`, 0, 4, 3, 3, true]);
});

test('② 「수요만」 — 수요 없는 R 도 짝에 수요가 있으면 같이 나온다 · 추천순 정렬에서도 짝이 붙어 있다', { skip: SKIP }, async () => {
  const d = await list(`q=${P}&demand=1&sort=rec&dir=desc&limit=50`);
  const codes = d.items.map((x) => x.ctr);
  assert.ok(codes.includes(`${P}001R`));
  for (const k of ['001', '002', '003']) {
    const i = codes.indexOf(`${P}${k}L`);
    assert.equal(codes[i + 1], `${P}${k}R`, `${k} 짝이 붙어 있어야: ${codes.join(',')}`);
  }
});

test('③ CN 짝 + MOQ — L 수요 3 → L·R 모두 MOQ 10', { skip: SKIP }, async () => {
  const d = await list(`q=${P}002`);
  assert.deepEqual(d.items.map((x) => [x.ctr, x.moq, x.moq_source, x.rec_raw_qty, x.rec_qty]),
    [[`${P}002L`, 10, 'origin', 3, 10], [`${P}002R`, 10, 'origin', 3, 10]]);
});

test('④ SYD — 제품마스터 SYD + 카탈로그(교차참조) SYD 브랜드, 중복 제거 · 다른 브랜드 제외', { skip: SKIP }, async () => {
  const L = await row(`${P}001L`);
  assert.deepEqual(L.syd, ['1010101', '2020202']);
  const R = await row(`${P}001R`);
  assert.deepEqual(R.syd, ['3030303']);
  const s = await list('q=3030303');
  assert.ok(s.items.some((x) => x.ctr === `${P}001R`), '카탈로그 SYD 로도 검색된다');
});

test('⑤ 공장 정보 미리보기 — 머리글·한국어 상태·「-」·오류·미등록·중복', { skip: SKIP }, async () => {
  const table = [
    ['CTR', '제품명', '원산지', 'MOQ', '생산 상태'],
    [`${P}001L`, '무시', 'Corea', '6', '생산중'],
    [`${P}003L`, '', '', '', '단산'],
    [`${P}004`, '', 'Turquía', 'abc', ''],
    ['NOPE999', '', 'CN', '10', ''],
    [`${P}002R`, '', '', '20', ''],
    [`${P}002R`, '', '', '-', ''],
  ];
  const r = await post('/api/purchases/factory-info/preview', { table });
  assert.equal(r.statusCode, 200, r.body);
  const d = r.json();
  assert.deepEqual([d.total, d.changed, d.error_count, d.not_found_count, d.dup], [6, 2, 1, 1, 1]);
  const by = Object.fromEntries(d.items.map((x) => [x.code, x.changes]));
  assert.deepEqual(by[`${P}001L`], { moq: { from: null, to: 6 }, factory_status: { from: null, to: 'production' } }, 'Corea=KR 그대로라 원산지는 안 바뀜');
  assert.deepEqual(by[`${P}003L`], { factory_status: { from: null, to: 'discontinued' } });
  assert.equal(by[`${P}002R`], undefined, '마지막 줄(-) = 지우기, 원래 없음 → 변경 없음');
  assert.match(d.errors[0].msg, /MOQ/);
});

test('⑥ 반영 — 디렉터만 · 이력 · SKU MOQ 우선 · 단산은 추천 0', { skip: SKIP }, async () => {
  const table = [['CTR', '원산지', 'MOQ', '생산 상태'], [`${P}001L`, 'KR', '6', '생산중'], [`${P}003L`, '', '', '단산']];
  const no = await post('/api/purchases/factory-info/apply', { table }, 'staff');
  assert.equal(no.statusCode, 403);
  const r = await post('/api/purchases/factory-info/apply', { table, source: 'paste' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().updated, 2);
  const log = (await query(`SELECT field, new_value, source FROM product_factory_log WHERE batch_id=$1 ORDER BY code, field`, [r.json().batch_id])).rows;
  assert.deepEqual(log.map((x) => [x.field, x.new_value, x.source]),
    [['factory_status', 'production', 'paste'], ['moq', '6', 'paste'], ['factory_status', 'discontinued', 'paste']]);
  const L = await row(`${P}001L`);
  assert.deepEqual([L.moq, L.moq_source, L.factory_status, L.rec_qty], [6, 'sku', 'production', 6], 'SKU MOQ 6 > 수요 4');
  const C = (await list(`q=${P}003`)).items;
  assert.deepEqual(C.map((x) => [x.ctr, x.blocked, x.rec_qty]), [[`${P}003L`, true, 0], [`${P}003R`, false, 0]],
    '단산 L 은 0, 짝 R 도 단산 쪽 수요를 따라가지 않는다');
  const cur = (await get('/api/purchases/factory-info')).json().items.find((x) => x.code === `${P}003L`);
  assert.equal(cur.factory_status, 'discontinued');
});

test('⑦ 발주서(Orden de Compra) — 원산지별 · CTR 알파벳순 · FOB 단가(가격 마스터 우선) · 소계 · 총계', { skip: SKIP }, async () => {
  const d = (await get('/api/purchases/review/po-draft')).json();
  assert.match(d.month, /^\d{4}-\d{2}$/);
  assert.deepEqual([d.currency, d.cost_visible], ['USD', true]);
  const g = Object.fromEntries(d.groups.map((x) => [x.origin, x]));
  const kr = g.KR.items.filter((x) => x.ctr.startsWith(P));
  assert.deepEqual(kr.map((x) => [x.ctr, x.rec_qty, x.fob_usd, x.amount_usd]), [[`${P}001L`, 6, 2.5, 15], [`${P}001R`, 3, 3, 9]]);
  assert.equal(g.KR.origin_es, 'Corea');
  assert.deepEqual(g.CN.items.filter((x) => x.ctr.startsWith(P)).map((x) => [x.ctr, x.amount_usd]), [[`${P}002L`, 12], [`${P}002R`, 12]]);
  const tr = g.TR.items.find((x) => x.ctr === `${P}004`);
  assert.deepEqual([tr.rec_qty, tr.fob_usd, tr.amount_usd, tr.no_fob], [40, null, null, true], 'FOB 없음 → 금액 없음, 합계 제외');
  for (const grp of d.groups) {
    const codes = grp.items.map((x) => x.ctr);
    assert.deepEqual(codes, [...codes].sort(), `${grp.origin} CTR 알파벳순`);
    const sum = Math.round(grp.items.reduce((a, x) => a + (x.amount_usd || 0), 0) * 100) / 100;
    assert.equal(grp.amount_usd, sum, `${grp.origin} 소계`);
  }
  assert.equal(d.total_amount_usd, Math.round(d.groups.reduce((a, x) => a + x.amount_usd, 0) * 100) / 100);
  assert.ok(!d.groups.some((x) => x.items.some((i) => i.ctr === `${P}003L` || i.ctr === `${P}003R`)), '추천 0 은 발주서에 없다');
  assert.ok(!d.groups.some((x) => x.items.some((i) => i.ctr.startsWith('PRO'))), 'PRO 제외');
  const staff = (await get('/api/purchases/review/po-draft', 'staff')).json();
  assert.equal(staff.cost_visible, false);
  assert.equal(staff.total_amount_usd, null);
  assert.ok(staff.groups.every((x) => x.items.every((i) => i.fob_usd == null && i.amount_usd == null)), '구매단가 권한 없으면 FOB 숨김');
});

test('⑦-b PRO 코드는 구매검토 목록·합계·공장 정보 양식에서 빠진다', { skip: SKIP }, async () => {
  const d = await list('q=PROZX91');
  assert.equal(d.total, 0);
  const cur = (await get('/api/purchases/factory-info')).json().items;
  assert.ok(!cur.some((x) => x.code.startsWith('PRO')));
});

test('⑧ 견적 미리보기 — L 만 넣으면 R 안내(재고 표시) · 짝 다 있으면 안내 없음 · 견적은 그대로 계산', { skip: SKIP }, async () => {
  const r = await post('/api/quotes/preview', { discount_rate: 0, lines: [{ product_id: ID.aL, qty: 2 }, { product_id: ID.single, qty: 1 }] });
  assert.equal(r.statusCode, 200, r.body);
  const d = r.json();
  assert.equal(d.lines.length, 2, '견적 줄은 막지 않는다');
  assert.deepEqual(d.pair_hints.map((h) => [h.code, h.partner, h.partner_stock, h.partner_avail, h.qty]), [[`${P}001L`, `${P}001R`, 1, 1, 2]]);
  const both = (await post('/api/quotes/preview', { discount_rate: 0, lines: [{ product_id: ID.aL, qty: 2 }, { product_id: ID.aR, qty: 2 }] })).json();
  assert.deepEqual(both.pair_hints, []);
});

after(async () => {
  if (SKIP) return;
  try { await cleanup(); } catch (_) {}
  if (app) await app.close();
  try { (await import('../src/db.js')).pool?.end?.(); } catch (_) {}
});
