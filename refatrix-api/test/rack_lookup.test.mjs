// =====================================================================
// 창고 제품 위치 찾기 (2026-10-12) — 제품번호·바코드·SYD → 총 재고 + 랙 × 수량
//   API: 실 PostgreSQL (TEST_PG_URL) · 화면: jsdom
//   실행: TEST_PG_URL=postgres://... node --test test/rack_lookup.test.mjs
// =====================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');
let JSDOM;
try { ({ JSDOM } = await import('jsdom')); } catch { /* skip UI */ }
const PG = process.env.TEST_PG_URL;
if (PG) process.env.DATABASE_URL = PG;
const SKIP = !PG;
const TAG = 'LKTEST';
let query, app;
const ID = {}, tok = {};

async function cleanup() {
  const P = `SELECT id FROM products WHERE code LIKE '${TAG}%'`;
  await query(`DELETE FROM product_rack_moves WHERE product_id IN (${P})`);
  await query(`DELETE FROM product_rack_stock WHERE product_id IN (${P})`);
  await query(`DELETE FROM quote_pick_alloc WHERE product_id IN (${P})`);
  await query(`DELETE FROM quote_lines WHERE quote_id IN (SELECT id FROM quotes WHERE quote_no LIKE '${TAG}%')`);
  await query(`DELETE FROM quotes WHERE quote_no LIKE '${TAG}%'`);
  await query(`DELETE FROM product_syd_codes WHERE product_id IN (${P})`);
  await query(`DELETE FROM rack_kinds WHERE rack = 'LKFM-1'`);
  await query(`DELETE FROM products WHERE code LIKE '${TAG}%'`);
  await query(`DELETE FROM user_page_access WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'lktest%')`);
  await query(`DELETE FROM users WHERE login_id LIKE 'lktest%'`);
}

test('boot', { skip: SKIP }, async () => {
  ({ query } = await import('../src/db.js'));
  const { hashPin } = await import('../src/auth.js');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await cleanup();
  ID.wh = Number((await query(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ('${TAG}창고','warehouse',$1,'lktest_wh') RETURNING id`, [hashPin('1234')])).rows[0].id);
  await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access) VALUES ($1,'warehouse','anywhere','view')`, [ID.wh]);
  ID.sales = Number((await query(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ('${TAG}영업','sales',$1,'lktest_sa') RETURNING id`, [hashPin('1234')])).rows[0].id);
  const mk = async (code, stock, ean, scode) => Number((await query(
    `INSERT INTO products (code, name, stock_qty, list_price, ean, scode) VALUES ($1,$2,$3,10,$4,$5) RETURNING id`,
    [code, code + ' Rótula', stock, ean || null, scode || null])).rows[0].id);
  ID.p1 = await mk(`${TAG}-CB11`, 46, '0750000001111', 'SYDLK-1');
  ID.p2 = await mk(`${TAG}-CB12`, 5);
  ID.p3 = await mk(`${TAG}-CB13`, 0);
  await query(`INSERT INTO product_syd_codes (product_id, syd_code) VALUES ($1,'SYDLK-X')`, [ID.p2]);
  await query(`INSERT INTO rack_kinds (rack, kind) VALUES ('LKFM-1','fast')`);
  for (const [r, q] of [['AD1-1', 8], ['AE1-2', 30], ['LKFM-1', 4]]) await query(`INSERT INTO product_rack_stock (product_id, rack, qty) VALUES ($1,$2,$3)`, [ID.p1, r, q]);
  const qid = Number((await query(`INSERT INTO quotes (quote_no, status) VALUES ('${TAG}-Q1','confirmed') RETURNING id`)).rows[0].id);
  await query(`INSERT INTO quote_pick_alloc (quote_id, product_id, rack, qty, seq) VALUES ($1,$2,'LKFM-1',3,0)`, [qid, ID.p1]);
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret' });
  await app.register((await import('../src/routes/rackStockRoutes.js')).default);
  await app.ready();
  tok.wh = app.jwt.sign({ sub: ID.wh }); tok.sales = app.jwt.sign({ sub: ID.sales });
});
const get = (code, who = 'wh') => app.inject({ method: 'GET', url: '/api/rack-stock/lookup?code=' + encodeURIComponent(code), headers: { authorization: 'Bearer ' + tok[who] } });

test('① 제품번호 → 총 재고 · 랙 × 수량(fast 먼저) · 위치 미지정 · 지시서가 잡은 수량', { skip: SKIP }, async () => {
  const r = await get(`${TAG.toLowerCase()}-cb11 `);
  assert.equal(r.statusCode, 200, r.body);
  const j = r.json();
  assert.equal(j.match, 'one');
  const it = j.item;
  assert.equal(it.stock_qty, 46);
  assert.deepEqual(it.racks.map((x) => [x.rack, x.qty]), [['LKFM-1', 4], ['AE1-2', 30], ['AD1-1', 8]]);
  assert.equal(it.unassigned, 4);
  assert.equal(it.racks[0].held, 3); assert.deepEqual(it.racks[0].held_quotes, [`${TAG}-Q1`]);
  assert.equal(it.held_total, 3);
});

test('② 바코드(앞자리 0 빠져도) · SYD(제품마스터·교차표) · 스캐너 아포스트로피', { skip: SKIP }, async () => {
  assert.equal((await get('750000001111')).json().item.product_id, ID.p1);
  assert.equal((await get('0750000001111')).json().item.product_id, ID.p1);
  assert.equal((await get('sydlk-1')).json().item.product_id, ID.p1);
  assert.equal((await get('SYDLK-X')).json().item.product_id, ID.p2);
  assert.equal((await get(`${TAG}'CB12`)).json().item.product_id, ID.p2);
});

test('③ 일부만 입력 → 후보 · 없으면 none · 랙 기록 없는 재고 · 권한', { skip: SKIP }, async () => {
  const m = (await get(`${TAG}-CB1`)).json();
  assert.equal(m.match, 'many'); assert.equal(m.partial, true);
  assert.equal(m.candidates[0].code, `${TAG}-CB11`, '재고 많은 것 먼저');
  assert.equal((await get('ZZZ-NOPE-999')).json().match, 'none');
  const p2 = (await get(`${TAG}-CB12`)).json().item;
  assert.equal(p2.racks.length, 0); assert.equal(p2.unassigned, 5);
  assert.equal((await get(`${TAG}-CB11`, 'sales')).statusCode, 403, '창고·제품 화면 권한이 없으면 막힘');
  assert.equal((await get('')).statusCode, 400);
});

after(async () => {
  if (SKIP) return;
  try { await cleanup(); } catch (e) { console.error(e.message); }
  try { await app.close(); } catch (_) {}
  const { pool } = await import('../src/db.js'); await pool.end();
});

// ---------------- 화면 ----------------
async function bootUI(lang, handler) {
  const calls = [];
  const dom = new JSDOM(read('refatrix-warehouse.html'), { runScripts: 'dangerously', url: 'https://example.test/refatrix-warehouse.html',
    beforeParse(win) {
      win.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 't', api: 'https://api.test', user: { name: 'u', role: 'warehouse' } }));
      win.localStorage.setItem('wh_lang', lang);
      win.AudioContext = undefined; win.webkitAudioContext = undefined;
      win.fetch = async (url) => {
        const u = String(url); calls.push(u);
        const json = (o, st = 200) => ({ ok: st < 400, status: st, json: async () => o });
        const h = handler(u, json); if (h) return h;
        if (/packing-queue$/.test(u)) return json({ count: 0, items: [] });
        if (/ship-queue/.test(u)) return json({ items: [] });
        return json({});
      };
    } });
  await new Promise((r) => dom.window.addEventListener('load', r));
  dom.__calls = calls;
  return dom;
}
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const ONE = { match: 'one', item: { product_id: 1, code: 'CB0011', name: 'Rótula', ean: '7501', syd: 'S-11', stock_qty: 46,
  racks: [{ rack: 'FM-01', qty: 4, kind: 'fast', held: 3, held_quotes: ['SQ-9'] }, { rack: 'AE1-2', qty: 30, kind: 'carton' }, { rack: 'AD1-1', qty: 8, kind: 'carton' }],
  located: 42, unassigned: 4, over: 0, held_total: 3, held_quotes: ['SQ-9'], master_rack: '' } };

test('④ 화면 — 입력 후 Enter → 총 재고 크게 · 랙 × 수량 · 위치 미지정 · 지시서 수량', { skip: !JSDOM }, async () => {
  const dom = await bootUI('ko', (u, json) => (/\/lookup\?code=CB0011$/.test(u) ? json(ONE) : null));
  const w = dom.window, $ = (id) => w.document.getElementById(id);
  $('lkInput').value = 'cb0011';
  $('lkInput').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter' })); await tick();
  assert.ok(dom.__calls.some((u) => /lookup\?code=cb0011/.test(u)));
  w.close();
  const dom2 = await bootUI('ko', (u, json) => (/lookup/.test(u) ? json(ONE) : null));
  const $2 = (id) => dom2.window.document.getElementById(id);
  $2('lkInput').value = 'CB0011'; $2('lkGo').click(); await tick();
  const h = $2('lkRes').innerHTML;
  assert.match(h, /<span class="n">46<\/span><span class="l">총 재고/);
  assert.match(h, /📍 FM-01<span class="fm">FM<\/span><\/span><span class="q">4<small>개<\/small>[\s\S]*SQ-9[\s\S]*AE1-2[\s\S]*30[\s\S]*AD1-1[\s\S]*8/);
  assert.match(h, /위치 미지정[\s\S]*4<small>개/);
  $2('lkClr').click(); assert.equal($2('lkRes').innerHTML, '');
  dom2.window.close();
});

test('⑤ 화면 — 후보 선택 · 없음 · 스페인어', { skip: !JSDOM }, async () => {
  const dom = await bootUI('es', (u, json) => {
    if (/code=CB00$/.test(u)) return json({ match: 'many', partial: true, candidates: [ONE.item, { ...ONE.item, code: 'CB0012', stock_qty: 2, racks: [] }] });
    if (/code=CB0011$/.test(u)) return json(ONE);
    if (/code=NOPE$/.test(u)) return json({ match: 'none' });
    return null;
  });
  const w = dom.window, $ = (id) => w.document.getElementById(id);
  $('lkInput').value = 'CB00'; $('lkGo').click(); await tick(80);
  assert.match($('lkRes').innerHTML, /Productos parecidos/);
  $('lkRes').querySelector('[data-code="CB0011"]').click(); await tick(80);
  assert.match($('lkRes').innerHTML, /Existencia total/);
  assert.match($('lkRes').innerHTML, /<small>pzas<\/small>/);
  assert.match($('lkRes').innerHTML, /Sin ubicación/);
  $('lkInput').value = 'NOPE'; $('lkGo').click(); await tick(80);
  assert.match($('lkRes').innerHTML, /No se encontró el producto/);
  w.close();
});
