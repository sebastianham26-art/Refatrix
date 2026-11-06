// =====================================================================
// 2026-11-05 avl · Q-2026-0354 재현 — 견적 화면 가용 = 저장 예약 · 부분 확보분도 포장지시서·포장에  (실 PostgreSQL)
//   사례: GV0803 현재고 7. 같은 고객 견적 Q-2026-0353(키트 K0019, GV0803 ×2)이 2분 먼저 2개를 예약.
//         Q-2026-0354(키트 K0034 ×2세트, GV0803 ×4/세트 = 8) → 화면은 「가용 7」, 저장 예약은 5, 매출 5.
//         포장작업지시서에는 GV0803 이 아예 빠졌는데 인보이스에는 5개가 들어갔다.
//   실행: TEST_PG_URL=postgres://... node --test test/quote_avail_partial_e2e.test.mjs
// =====================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL;
const SKIP = !PG;
if (SKIP) console.log('[skip] TEST_PG_URL 없음 — 실 Postgres 검증 생략');
if (PG) process.env.DATABASE_URL = PG;

let query, app;
const tok = {};
const ID = {};
const RUN = String(Date.now() % 900 + 100);   // 실행마다 다른 코드 — 매출이 남아 지울 수 없는 행과 부딪치지 않게
const TAG = 'AVLX' + RUN;
const KA = 'K9' + RUN, KB = 'K8' + RUN;

async function purgeRefs(table, ids) {
  if (!ids.length) return;
  const fks = (await query(
    `SELECT c.conrelid::regclass::text AS t, a.attname AS col
       FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum = ANY(c.conkey)
      WHERE c.confrelid = $1::regclass AND c.contype='f'`, [table])).rows;
  for (let pass = 0; pass < 3; pass++) {
    for (const f of fks) { if (f.t === table) continue; await query(`DELETE FROM ${f.t} WHERE ${f.col} = ANY($1::bigint[])`, [ids]).catch(() => {}); }
  }
}
async function cleanup() { try { await cleanupInner(); } catch (e) { console.log('# cleanup(무시)', e.message); } }
async function cleanupInner() {
  const cids = (await query(`SELECT id FROM customers WHERE name LIKE '${TAG}%'`)).rows.map((r) => Number(r.id));
  const qids = (await query(`SELECT id FROM quotes WHERE customer_id = ANY($1::bigint[])`, [cids])).rows.map((r) => Number(r.id));
  const sids = (await query(`SELECT id FROM sales_invoices WHERE customer_id = ANY($1::bigint[])`, [cids]).catch(() => ({ rows: [] }))).rows.map((r) => Number(r.id));
  const tids = (await query(`SELECT id FROM transactions WHERE sales_invoice_id = ANY($1::bigint[])`, [sids]).catch(() => ({ rows: [] }))).rows.map((r) => Number(r.id));
  await purgeRefs('transactions', tids);
  await query(`DELETE FROM transactions WHERE id = ANY($1::bigint[])`, [tids]).catch(() => {});
  await purgeRefs('sales_invoices', sids);
  await query(`DELETE FROM sales_invoices WHERE id = ANY($1::bigint[])`, [sids]).catch(() => {});
  await purgeRefs('quotes', qids);
  await query(`DELETE FROM quote_lines WHERE quote_id = ANY($1::bigint[])`, [qids]);
  await query(`DELETE FROM quotes WHERE id = ANY($1::bigint[])`, [qids]);
  await query(`DELETE FROM vio_promos WHERE promo_no IN ('${KA}','${KB}')`);
  const pids = (await query(`SELECT id FROM products WHERE code LIKE '${TAG}%' OR code IN ('${KA}','${KB}')`)).rows.map((r) => Number(r.id));
  await query(`DELETE FROM stock_shortages WHERE product_id = ANY($1::bigint[])`, [pids]).catch(() => {});
  await purgeRefs('products', pids);
  await query(`DELETE FROM products WHERE id = ANY($1::bigint[])`, [pids]);
  await purgeRefs('customers', cids);
  await query(`DELETE FROM customers WHERE id = ANY($1::bigint[])`, [cids]);
  const uids = (await query(`SELECT id FROM users WHERE login_id LIKE 'avlx%${RUN}'`)).rows.map((r) => Number(r.id));
  await query(`DELETE FROM audit_log WHERE user_id = ANY($1::bigint[])`, [uids]).catch(() => {});
  await purgeRefs('users', uids);
  await query(`DELETE FROM users WHERE id = ANY($1::bigint[])`, [uids]);
}

async function boot() {
  ({ query } = await import('../src/db.js'));
  const { hashPin } = await import('../src/auth.js');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await cleanup();
  const mkU = async (login, role) => Number((await query(
    `INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,$3,$4) RETURNING id`, [`${TAG}${login}`, role, hashPin('4321'), login])).rows[0].id);
  ID.dir = await mkU('avlx_dir' + RUN, 'director');
  ID.wh = await mkU('avlx_wh' + RUN, 'warehouse');
  await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access) VALUES ($1,'warehouse','anywhere','edit')`, [ID.wh]);
  const mkP = async (code, stock, price = 100) => Number((await query(
    `INSERT INTO products (code, name, stock_qty, avg_cost, list_price, ean) VALUES ($1,$2,$3,30,$4,$5) RETURNING id`,
    [code, code + ' 부품', stock, price, '78' + String(Math.floor(Math.random() * 1e10)).padStart(11, '0')])).rows[0].id);
  ID.gv = await mkP(`${TAG}-GV`, 7);     // GV0803 역할
  ID.cr = await mkP(`${TAG}-CR`, 2);     // CR0387 역할
  ID.cb = await mkP(`${TAG}-CB`, 30);    // 충분한 구성품
  ID.ka = await mkP(KA, 0, 500);
  ID.kb = await mkP(KB, 0, 900);
  const mkPromo = async (no, kitPid, items) => {
    const id = Number((await query(
      `INSERT INTO vio_promos (promo_no, title, years, kit_name, product_id) VALUES ($1,'Test','2010-2015',$2,$3) RETURNING id`,
      [no, `KIT ${no}`, kitPid])).rows[0].id);
    let n = 0;
    for (const [pid, code, qty] of items) {
      await query(`INSERT INTO vio_promo_items (promo_id, line_no, product_id, ctr_code, qty, list_price) VALUES ($1,$2,$3,$4,$5,100)`, [id, ++n, pid, code, qty]);
    }
  };
  await mkPromo(KA, ID.ka, [[ID.gv, `${TAG}-GV`, 1], [ID.cb, `${TAG}-CB`, 2]]);           // K0019 역할
  await mkPromo(KB, ID.kb, [[ID.gv, `${TAG}-GV`, 4], [ID.cr, `${TAG}-CR`, 2], [ID.cb, `${TAG}-CB`, 1]]);   // K0034+K0032 역할
  ID.cust = Number((await query(
    `INSERT INTO customers (name, code, credit_days, rfc, owner_id, created_by) VALUES ($1,$2,30,'AVL0101'||$4,$3,$3) RETURNING id`,
    [`${TAG}고객`, `${TAG}-C`, ID.dir, RUN + 'A1'])).rows[0].id);

  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret' });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (r, body, done) => {
    if (!body || !String(body).trim()) return done(null, {});
    try { done(null, JSON.parse(body)); } catch (e) { e.statusCode = 400; done(e); }
  });
  for (const f of ['quoteRoutes', 'warehouseRoutes', 'salesRoutes']) await app.register((await import(`../src/routes/${f}.js`)).default);
  await app.ready();
  tok.dir = app.jwt.sign({ sub: ID.dir });
  tok.wh = app.jwt.sign({ sub: ID.wh });
}
const H = (who = 'dir') => ({ authorization: 'Bearer ' + tok[who] });
const get = (url, who) => app.inject({ method: 'GET', url, headers: H(who) });
const post = (url, body, who) => app.inject({ method: 'POST', url, payload: body || {}, headers: H(who) });
const line = (d, pid) => d.lines.filter((l) => Number(l.product_id) === pid);

test('boot', { skip: SKIP }, async () => { await boot(); });

test('① 앞선 견적(Q-0353 역할)이 GV 2개를 예약', { skip: SKIP }, async () => {
  const r = await post('/api/quotes', { customer_id: ID.cust, lines: [{ code: KA, qty: 2 }] });
  assert.equal(r.statusCode, 200, r.body);
  ID.qa = Number(r.json().id);
  const res = (await query(`SELECT reserved_qty::int AS r FROM quote_lines WHERE quote_id=$1 AND product_id=$2`, [ID.qa, ID.gv])).rows[0];
  assert.equal(res.r, 2);
  assert.deepEqual(r.json().short_lines, [], '앞선 견적은 부족 없음');
});

test('② 미리보기 가용 = 현재고 7 − 타 견적 예약 2 = 5 (예전: 7)', { skip: SKIP }, async () => {
  const d = (await post('/api/quotes/preview', { customer_id: ID.cust, lines: [{ code: KB, qty: 2 }] })).json();
  const gv = line(d, ID.gv)[0];
  assert.equal(gv.qty, 8);
  assert.equal(gv.cur_stock, 7);
  assert.equal(gv.reserved_other, 2);
  assert.equal(gv.avail_stock, 5, '저장 예약과 같은 값');
  assert.equal(gv.stock_flag, 'low_stock');
  assert.equal(gv.reserved_holders.length, 1);
  assert.equal(gv.reserved_holders[0].qty, 2);
  const cr = line(d, ID.cr)[0];
  assert.deepEqual([cr.qty, cr.avail_stock, cr.stock_flag], [4, 2, 'low_stock']);
});

test('③ 한 견적에 같은 부품을 쓰는 키트 둘 — 앞줄 사용분을 빼고 보여준다', { skip: SKIP }, async () => {
  const d = (await post('/api/quotes/preview', { customer_id: ID.cust, lines: [{ code: KA, qty: 1 }, { code: KB, qty: 2 }] })).json();
  const gvs = line(d, ID.gv);
  assert.equal(gvs.length, 2);
  assert.deepEqual(gvs.map((l) => [l.qty, l.avail_stock, l.used_in_quote, l.stock_flag]), [[1, 5, 0, 'ok'], [8, 4, 1, 'low_stock']]);
});

test('④ 편집 미리보기 — exclude_quote_id 면 자기 예약은 빼지 않는다', { skip: SKIP }, async () => {
  const d = (await post('/api/quotes/preview', { customer_id: ID.cust, exclude_quote_id: ID.qa, lines: [{ code: KA, qty: 2 }] })).json();
  const gv = line(d, ID.gv)[0];
  assert.deepEqual([gv.reserved_other, gv.avail_stock, gv.stock_flag], [0, 7, 'ok']);
});

test('⑤ 저장 — 실제 확보가 요청보다 적은 줄을 바로 돌려준다', { skip: SKIP }, async () => {
  const r = await post('/api/quotes', { customer_id: ID.cust, lines: [{ code: KB, qty: 2 }] });
  assert.equal(r.statusCode, 200, r.body);
  ID.qb = Number(r.json().id);
  const sl = r.json().short_lines.map((x) => `${x.code}:${x.reserved}/${x.qty}:${x.kit_no}`).sort();
  assert.deepEqual(sl, [`${TAG}-CR:2/4:${KB}`, `${TAG}-GV:5/8:${KB}`]);
  const pv = (await post('/api/quotes/preview', { customer_id: ID.cust, lines: [{ code: KB, qty: 2 }] })).json();
  assert.equal(line(pv, ID.gv)[0].avail_stock, 0, '두 견적이 7개를 다 잡았다');
});

test('⑥ 전환 미리보기 — 부분 확보분도 포장 대상(pick_items)', { skip: SKIP }, async () => {
  const cv = (await get(`/api/quotes/${ID.qb}/convert-preview`)).json();
  assert.equal(cv.in_stock.length, 1, 'CB 만 전량');
  assert.deepEqual(cv.shortage.map((x) => [x.ctr_code, x.qty, x.fulfill, x.short]).sort(),
    [[`${TAG}-CR`, 4, 2, 2], [`${TAG}-GV`, 8, 5, 3]]);
  const pk = cv.pick_items.map((x) => `${x.ctr_code}:${x.qty}:${x.partial ? 'P' : 'F'}`).sort();
  assert.deepEqual(pk, [`${TAG}-CB:2:F`, `${TAG}-CR:2:P`, `${TAG}-GV:5:P`]);
  assert.equal(cv.counts.partial, 2);
});

test('⑦ 창고 포장 화면 — 부분 확보 줄 required = 확보분, 키트는 partial', { skip: SKIP }, async () => {
  const pp = await post(`/api/quotes/${ID.qb}/packing-printed`);
  assert.equal(pp.statusCode, 200, pp.body);
  const pk = (await get(`/api/warehouse/packing/${ID.qb}`, 'wh')).json();
  const by = Object.fromEntries(pk.items.map((it) => [it.ctr_code, [it.required, !!it.partial, it.short || 0]]));
  assert.deepEqual(by[`${TAG}-GV`], [5, true, 3]);
  assert.deepEqual(by[`${TAG}-CR`], [2, true, 2]);
  assert.deepEqual(by[`${TAG}-CB`], [2, false, 0]);
  assert.equal(pk.required_total, 9);
  assert.equal(pk.kits.find((k) => k.kit_no === KB).partial, true);
});

test('⑧ 매출 전환 — 인보이스 수량 = 포장 대상 수량(GV 5 · CR 2 · CB 2)', { skip: SKIP }, async () => {
  await post(`/api/quotes/${ID.qb}/packing-doc`, { data: 'data:image/png;base64,iVBORw0KGgo=', file_name: 's.png', mime_type: 'image/png' });
  const r = await post(`/api/quotes/${ID.qb}/convert`, { seller_id: ID.dir });
  assert.equal(r.statusCode, 200, r.body);
  const inv = Number(r.json().invoice_id);
  const rows = (await query(
    `SELECT p.code, SUM(l.qty)::int AS q FROM sales_invoice_lines l JOIN products p ON p.id=l.product_id
      WHERE l.invoice_id=$1 GROUP BY p.code ORDER BY p.code`, [inv])).rows.map((x) => `${x.code}:${x.q}`);
  assert.deepEqual(rows, [`${TAG}-CB:2`, `${TAG}-CR:2`, `${TAG}-GV:5`]);
  assert.deepEqual(r.json().shortages.map((s) => [s.requested, s.fulfilled, s.shortage]).sort(), [[4, 2, 2], [8, 5, 3]]);
});

after(async () => {
  if (SKIP) return;
  try { await cleanup(); } catch (e) { console.error('cleanup', e.message); }
  try { await app.close(); } catch (_) {}
  const { pool } = await import('../src/db.js');
  await pool.end();
});
