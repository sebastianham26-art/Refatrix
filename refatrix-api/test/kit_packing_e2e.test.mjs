// =====================================================================
// 0306 · 키트 묶음 — 견적 줄 kit_no 저장 → 포장지시 · 포장작업지시서 · Lista de empaque  (실 PostgreSQL)  2026-10-28
//   디렉터 지시: 키트로 구성된 오더(Q-2026-0339)는 창고가 포장할 때 키트 구성품을 키트 단위로 알아보고
//   포장할 수 있도록 포장지시서에 별도 표시.
//   실행: TEST_PG_URL=postgres://... node --test test/kit_packing_e2e.test.mjs
// =====================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PG = process.env.TEST_PG_URL;
const SKIP = !PG;
if (SKIP) console.log('[skip] TEST_PG_URL 없음 — 실 Postgres 검증 생략');
if (PG) process.env.DATABASE_URL = PG;

let query, app, vp;
const tok = {};
const ID = {};
const TAG = 'KITPK';
const K1 = 'K9901', K2 = 'K9902', K3 = 'K9903';

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
async function cleanup() {
  const P = `SELECT id FROM products WHERE code LIKE '${TAG}%' OR code IN ('${K1}','${K2}','${K3}')`;
  const qids = (await query(`SELECT q.id FROM quotes q JOIN customers c ON c.id=q.customer_id WHERE c.name LIKE '${TAG}%'
                             UNION SELECT id FROM quotes WHERE quote_no='Q-2026-0339'`)).rows.map((r) => Number(r.id));
  await purgeRefs('quotes', qids);
  await query(`DELETE FROM quote_lines WHERE quote_id = ANY($1::bigint[])`, [qids]);
  await query(`DELETE FROM quotes WHERE id = ANY($1::bigint[])`, [qids]);
  await query(`DELETE FROM vio_promos WHERE promo_no IN ('${K1}','${K2}','${K3}')`);
  const pids = (await query(P)).rows.map((r) => Number(r.id));
  await query(`DELETE FROM stock_shortages WHERE product_id = ANY($1::bigint[])`, [pids]).catch(() => {});
  await purgeRefs('products', pids);
  await query(`DELETE FROM products WHERE id = ANY($1::bigint[])`, [pids]);
  const cids = (await query(`SELECT id FROM customers WHERE name LIKE '${TAG}%'`)).rows.map((r) => Number(r.id));
  await purgeRefs('customers', cids);
  await query(`DELETE FROM customers WHERE id = ANY($1::bigint[])`, [cids]);
  const uids = (await query(`SELECT id FROM users WHERE login_id LIKE 'kitpk%'`)).rows.map((r) => Number(r.id));
  await query(`DELETE FROM audit_log WHERE user_id = ANY($1::bigint[])`, [uids]).catch(() => {});
  await purgeRefs('users', uids);
  await query(`DELETE FROM users WHERE id = ANY($1::bigint[])`, [uids]);
}

async function boot() {
  ({ query } = await import('../src/db.js'));
  vp = await import('../src/vioPromos.js');
  const { hashPin } = await import('../src/auth.js');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await cleanup();
  const mkU = async (login, role) => Number((await query(
    `INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,$3,$4) RETURNING id`, [`${TAG}${login}`, role, hashPin('4321'), login])).rows[0].id);
  ID.dir = await mkU('kitpk_dir', 'director');
  ID.wh = await mkU('kitpk_wh', 'warehouse');
  await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access) VALUES ($1,'warehouse','anywhere','edit')`, [ID.wh]);
  const mkP = async (code, stock, price = 500) => Number((await query(
    `INSERT INTO products (code, name, stock_qty, avg_cost, list_price, ean) VALUES ($1,$2,$3,100,$4,$5) RETURNING id`,
    [code, code + ' 부품', stock, price, '77' + String(Math.floor(Math.random() * 1e10)).padStart(11, '0')])).rows[0].id);
  ID.l = await mkP(`${TAG}-TEL`, 20);   // 터미널 L
  ID.r = await mkP(`${TAG}-TER`, 20);   // 터미널 R
  ID.i = await mkP(`${TAG}-TI`, 20);    // 터미널 내측 ×2
  ID.hl = await mkP(`${TAG}-HL`, 20);   // 컨트롤암 L
  ID.hr = await mkP(`${TAG}-HR`, 20);
  ID.pro = await mkP(`${TAG}-PRO`, 50, 10);   // 판촉물(단품)
  ID.k1 = await mkP(K1, 0, 2000);
  ID.k2 = await mkP(K2, 0, 3000);
  ID.k3 = await mkP(K3, 0, 1000);
  const mkPromo = async (no, title, years, kitPid, items) => {
    const id = Number((await query(
      `INSERT INTO vio_promos (promo_no, title, years, kit_name, product_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [no, title, years, `KIT T ${title}`, kitPid])).rows[0].id);
    let n = 0;
    for (const [pid, code, qty] of items) {
      await query(`INSERT INTO vio_promo_items (promo_id, line_no, product_id, ctr_code, qty, list_price) VALUES ($1,$2,$3,$4,$5,500)`, [id, ++n, pid, code, qty]);
    }
    return id;
  };
  await mkPromo(K1, 'Nissan Versa', '2012-2019', ID.k1, [[ID.l, `${TAG}-TEL`, 1], [ID.r, `${TAG}-TER`, 1], [ID.i, `${TAG}-TI`, 2]]);
  await mkPromo(K2, 'Nissan Sentra', '2013-2019', ID.k2, [[ID.hl, `${TAG}-HL`, 1], [ID.hr, `${TAG}-HR`, 1]]);
  await mkPromo(K3, 'Nissan March', '2011-2025', ID.k3, [[ID.l, `${TAG}-TEL`, 1], [ID.pro, `${TAG}-PRO`, 2]]);
  ID.cust = Number((await query(
    `INSERT INTO customers (name, code, credit_days, rfc, owner_id, created_by) VALUES ($1,$2,30,'XAXX010101000',$3,$3) RETURNING id`,
    [`${TAG}고객`, `${TAG}-C`, ID.dir])).rows[0].id);

  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret' });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (r, body, done) => {
    if (!body || !String(body).trim()) return done(null, {});
    try { done(null, JSON.parse(body)); } catch (e) { e.statusCode = 400; done(e); }
  });
  for (const f of ['quoteRoutes', 'warehouseRoutes']) await app.register((await import(`../src/routes/${f}.js`)).default);
  await app.ready();
  tok.dir = app.jwt.sign({ sub: ID.dir });
  tok.wh = app.jwt.sign({ sub: ID.wh });
}
const H = (who = 'dir') => ({ authorization: 'Bearer ' + tok[who] });
const get = (url, who) => app.inject({ method: 'GET', url, headers: H(who) });
const post = (url, body, who) => app.inject({ method: 'POST', url, payload: body || {}, headers: H(who) });
const put = (url, body, who) => app.inject({ method: 'PUT', url, payload: body || {}, headers: H(who) });
const kitCol = async (qid) => (await query(`SELECT ctr_code, qty::int AS qty, kit_no FROM quote_lines WHERE quote_id=$1 ORDER BY line_no`, [qid])).rows
  .map((r) => `${r.ctr_code}:${r.qty}:${r.kit_no || '-'}`).join(' ');

test('boot', { skip: SKIP }, async () => { await boot(); assert.equal(await vp.kitColReady(), true); });

test('① 순수 함수 — 키트 번호 표기 · 세트 수 판정', { skip: SKIP }, () => {
  assert.equal(vp.normKitNo(' k0009 '), 'K0009');
  assert.equal(vp.normKitNo('KIT'), null);
  assert.equal(vp.normKitNo(null), null);
  const comp = [{ product_id: 1, qty: 1 }, { product_id: 2, qty: 2 }];
  assert.deepEqual(vp.kitSetCount(comp, [{ product_id: 1, qty: 2 }, { product_id: 2, qty: 4 }]), { sets: 2, consistent: true });
  assert.deepEqual(vp.kitSetCount(comp, [{ product_id: 1, qty: 1 }, { product_id: 2, qty: 3 }]), { sets: 1, consistent: false });
  assert.deepEqual(vp.kitSetCount(comp, [{ product_id: 1, qty: 1 }, { product_id: 2, qty: 2 }, { product_id: 9, qty: 1 }]), { sets: 1, consistent: false });
  assert.deepEqual(vp.kitSetCount(null, [{ product_id: 1, qty: 1 }]), { sets: null, consistent: false });
});

test('② 견적 저장 — 키트가 구성 부품 줄로 풀리고 줄마다 kit_no 가 남는다', { skip: SKIP }, async () => {
  const r = await post('/api/quotes', { customer_id: ID.cust, lines: [
    { code: K1, qty: 1 }, { code: K2, qty: 2 }, { product_id: ID.pro, qty: 5 }] });
  assert.equal(r.statusCode, 200, r.body);
  ID.q = Number(r.json().id);
  assert.equal(await kitCol(ID.q),
    `${TAG}-TEL:1:${K1} ${TAG}-TER:1:${K1} ${TAG}-TI:2:${K1} ${TAG}-HL:2:${K2} ${TAG}-HR:2:${K2} ${TAG}-PRO:5:-`);
  const d = (await get(`/api/quotes/${ID.q}`)).json();
  assert.deepEqual(d.lines.map((l) => l.kit_no || null), [K1, K1, K1, K2, K2, null], '견적 상세에도 kit_no');
});

test('③ 포장작업지시서용 convert-preview — in_stock 줄 kit_no · kits(세트 수)', { skip: SKIP }, async () => {
  const cv = (await get(`/api/quotes/${ID.q}/convert-preview`)).json();
  assert.equal(cv.in_stock.filter((x) => x.kit_no === K1).length, 3);
  assert.deepEqual(cv.kits.map((k) => [k.kit_no, k.title, k.years, k.sets, k.consistent, k.pieces]),
    [[K1, 'Nissan Versa', '2012-2019', 1, true, 4], [K2, 'Nissan Sentra', '2013-2019', 2, true, 4]]);
  assert.deepEqual(cv.kits[0].items.map((x) => `${x.ctr_code}x${x.qty}`), [`${TAG}-TELx1`,`${TAG}-TERx1`, `${TAG}-TIx2`]);
});

test('④ 창고 포장지시 — 줄마다 kit_no, kits 목록(진행은 화면이 계산)', { skip: SKIP }, async () => {
  await post(`/api/quotes/${ID.q}/packing-printed`);
  const r = await get(`/api/warehouse/packing/${ID.q}`, 'wh');
  assert.equal(r.statusCode, 200, r.body);
  const pk = r.json();
  assert.deepEqual(pk.items.map((it) => it.kit_no), [K1, K1, K1, K2, K2, null]);
  assert.deepEqual(pk.kits.map((k) => [k.kit_no, k.sets, k.consistent, k.partial]), [[K1, 1, true, false], [K2, 2, true, false]]);
  assert.equal(pk.required_total, 13);
});

test('⑤ 견적목록 편집(PUT) — kit_no 를 넘기면 유지, 수량이 구성과 어긋나면 consistent=false', { skip: SKIP }, async () => {
  const lines = [
    { code: `${TAG}-TEL`, qty: 1, kit_no: K1 }, { code: `${TAG}-TER`, qty: 1, kit_no: K1 }, { code: `${TAG}-TI`, qty: 3, kit_no: K1 },
    { code: `${TAG}-HL`, qty: 2, kit_no: K2 }, { code: `${TAG}-HR`, qty: 2, kit_no: K2 }, { code: `${TAG}-PRO`, qty: 5 }];
  const r = await put(`/api/quotes/${ID.q}`, { customer_id: ID.cust, lines });
  assert.ok(r.statusCode === 200, r.body);
  assert.equal(await kitCol(ID.q),
    `${TAG}-TEL:1:${K1} ${TAG}-TER:1:${K1} ${TAG}-TI:3:${K1} ${TAG}-HL:2:${K2} ${TAG}-HR:2:${K2} ${TAG}-PRO:5:-`);
  const pk = (await get(`/api/warehouse/packing/${ID.q}`, 'wh')).json();
  const k1 = pk.kits.find((k) => k.kit_no === K1);
  assert.equal(k1.sets, 1); assert.equal(k1.consistent, false, 'TI 3개 ≠ 키트 2개');
  // 아무 글자나 kit_no 로 저장되지 않는다
  await put(`/api/quotes/${ID.q}`, { customer_id: ID.cust, lines: [{ code: `${TAG}-PRO`, qty: 1, kit_no: 'X; DROP' }] });
  assert.equal(await kitCol(ID.q), `${TAG}-PRO:1:-`);
  // 원래대로
  await put(`/api/quotes/${ID.q}`, { customer_id: ID.cust, lines: [{ code: K1, qty: 1 }, { code: K2, qty: 2 }, { code: `${TAG}-PRO`, qty: 5 }] });
});

test('⑥ 복제 — 키트 번호도 복제본으로', { skip: SKIP }, async () => {
  const r = await post(`/api/quotes/${ID.q}/clone`);
  assert.equal(r.statusCode, 200, r.body);
  const nq = Number(r.json().id);
  assert.equal(await kitCol(nq), await kitCol(ID.q));
});

test('⑦ 재고 부족으로 빠진 키트 부품 → partial 표시', { skip: SKIP }, async () => {
  await query(`UPDATE quote_lines SET reserved_qty=0 WHERE quote_id=$1 AND product_id=$2`, [ID.q, ID.hr]);
  const pk = (await get(`/api/warehouse/packing/${ID.q}`, 'wh')).json();
  const k2 = pk.kits.find((k) => k.kit_no === K2);
  assert.equal(k2.partial, true);
  assert.equal(pk.items.filter((it) => it.kit_no === K2).length, 1);
  await query(`UPDATE quote_lines SET reserved_qty=qty WHERE quote_id=$1 AND product_id=$2`, [ID.q, ID.hr]);
});

test('⑧ Lista de empaque(출고 출력) — 박스 줄 kit_no + kits 구성', { skip: SKIP }, async () => {
  const box = Number((await query(`INSERT INTO packing_box (quote_id, box_no) VALUES ($1,1) RETURNING id`, [ID.q])).rows[0].id);
  for (const [pid, q] of [[ID.l, 1], [ID.r, 1], [ID.i, 2], [ID.pro, 5]]) {
    await query(`INSERT INTO packing_box_line (box_id, quote_id, product_id, qty) VALUES ($1,$2,$3,$4)`, [box, ID.q, pid, q]);
  }
  await query(`UPDATE quotes SET packed_at=now() WHERE id=$1`, [ID.q]);
  const r = await get(`/api/warehouse/ship/${ID.q}`, 'wh');
  assert.equal(r.statusCode, 200, r.body);
  const d = r.json();
  assert.deepEqual(d.boxes[0].lines.map((l) => [l.ctr_code, l.kit_no]),
    [[`${TAG}-PRO`, null], [`${TAG}-TEL`, K1], [`${TAG}-TER`, K1], [`${TAG}-TI`, K1]]);
  assert.deepEqual(d.kits.map((k) => [k.kit_no, k.sets]), [[K1, 1], [K2, 2]]);
});

test('⑨ 0306 백필 — Q-2026-0339 의 빈 줄만 채운다(이미 있는 값·다른 견적은 그대로)', { skip: SKIP }, async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '0306_quote_line_kit_no.sql'), 'utf8');
  const upd = sql.slice(sql.indexOf('UPDATE quote_lines'));
  const q = Number((await query(`INSERT INTO quotes (quote_no, customer_id, status, created_by) VALUES ('Q-2026-0339',$1,'draft',$2) RETURNING id`, [ID.cust, ID.dir])).rows[0].id);
  const codes = ['CE0536L', 'CE0536R', 'CR0490', 'CL0477', 'CQ0166L', 'CQ0166R', 'CQ0285L', 'CQ0285R', 'PRO002'];
  let n = 0;
  for (const c of codes) await query(`INSERT INTO quote_lines (quote_id, line_no, ctr_code, qty, kit_no) VALUES ($1,$2,$3,1,$4)`, [q, ++n, c, c === 'CQ0285R' ? 'K0099' : null]);
  await query(upd);
  await query(upd);   // 두 번 돌려도 같다
  const got = (await query(`SELECT ctr_code, kit_no FROM quote_lines WHERE quote_id=$1 ORDER BY line_no`, [q])).rows.map((r) => `${r.ctr_code}=${r.kit_no || '-'}`).join(' ');
  assert.equal(got, 'CE0536L=K0009 CE0536R=K0009 CR0490=K0009 CL0477=K0009 CQ0166L=K0016 CQ0166R=K0016 CQ0285L=K0012 CQ0285R=K0099 PRO002=-');
  assert.equal(await kitCol(ID.q), `${TAG}-TEL:1:${K1} ${TAG}-TER:1:${K1} ${TAG}-TI:2:${K1} ${TAG}-HL:2:${K2} ${TAG}-HR:2:${K2} ${TAG}-PRO:5:-`, '다른 견적 영향 없음');
});

test('⑩ 같은 SKU 가 두 키트에 — 포장 목록은 한 줄(합계) · 키트 번호 순 · 스캔은 합계까지', { skip: SKIP }, async () => {
  const r = await post('/api/quotes', { customer_id: ID.cust, lines: [{ code: K3, qty: 1 }, { code: K1, qty: 1 }] });
  assert.equal(r.statusCode, 200, r.body);
  const q = Number(r.json().id);
  await post(`/api/quotes/${q}/packing-printed`);
  const pk = (await get(`/api/warehouse/packing/${q}`, 'wh')).json();
  const tel = pk.items.filter((it) => it.product_id === ID.l);
  assert.equal(tel.length, 1, 'TEL 한 줄');
  assert.equal(tel[0].required, 2);
  assert.equal(tel[0].kit_no, K1, '대표 키트 = 번호가 앞선 것');
  assert.deepEqual(tel[0].kit_parts.slice().sort((a, b) => (a.kit_no < b.kit_no ? -1 : 1)), [{ kit_no: K1, qty: 1 }, { kit_no: K3, qty: 1 }]);
  assert.deepEqual(pk.kits.map((k) => k.kit_no), [K1, K3], '키트 번호 순(차종 이름 아님)');
  const box = (await post(`/api/warehouse/packing/${q}/box`, {}, 'wh')).json();
  const ean = (await query(`SELECT ean FROM products WHERE id=$1`, [ID.l])).rows[0].ean;
  const s1 = (await post(`/api/warehouse/packing/${q}/scan`, { box_id: box.box_id, ean }, 'wh')).json();
  const s2 = (await post(`/api/warehouse/packing/${q}/scan`, { box_id: box.box_id, ean }, 'wh')).json();
  const s3 = (await post(`/api/warehouse/packing/${q}/scan`, { box_id: box.box_id, ean }, 'wh')).json();
  assert.deepEqual([s1.result, s2.result, s3.result], ['ok', 'ok', 'excess']);
  assert.equal(s2.remaining, 0);
});

after(async () => {
  if (SKIP) return;
  try { await cleanup(); } catch (e) { console.error('cleanup', e.message); }
  try { await app.close(); } catch (_) {}
  const { pool } = await import('../src/db.js');
  await pool.end();
});
