// =====================================================================
// 1108 · 장착 위치 — CTR 확인값(products.mount_pos · 0323) 우선 · 제품 찾기 두 화면이 같은 위치
//   A. 라우트(실 PostgreSQL): /api/products/positions/lookup — CTR 확인값 → 업로드 요약 순
//   B. 화면(jsdom): 「차종으로 제품 찾기」 결과 · 「제품 검색」 결과 — 목록 배지와 드릴다운이 같은 값
//   실행: DATABASE_URL=... node --import ./test/helpers/stub-auth.mjs --test test/product_positions_ctr.test.mjs
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const P_HTML = resolve(here, '..', '..', 'refatrix-products.html');
let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* 미설치 → skip */ }
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

test('A. lookup — CTR 확인값 우선 · 업로드는 참고 · 확인값만 있는 코드도 나온다', { skip: !process.env.DATABASE_URL }, async () => {
  const Fastify = (await import('fastify')).default;
  const { query } = await import('../src/db.js');
  const { default: positionRoutes } = await import('../src/routes/positionRoutes.js');
  const T = String(Date.now()).slice(-5);
  const A = 'CQ' + T + 'A', B = 'CQ' + T + 'B', C = 'CQ' + T + 'C';
  await query(`INSERT INTO products (code, name, mount_pos) VALUES ($1,'HORQUILLA','Delantera Inferior Izquierda/Derecha'),($2,'ROTULA',NULL),($3,'TERMINAL','Trasera')`, [A, B, C]);
  await query(`INSERT INTO product_positions (ctr_code, block, level, side, model) VALUES ($1,'front','lower','lh','Versa'),($2,'front','upper','rh','Versa')`, [A, B]);
  const app = Fastify(); await app.register(positionRoutes); await app.ready();
  try {
    const r = await app.inject({ method: 'POST', url: '/api/products/positions/lookup', headers: { 'x-test-user': '5:sales' }, payload: { codes: [A, B, C], detail: true } });
    assert.equal(r.statusCode, 200, r.body);
    const it = r.json().items;
    assert.equal(it[A].src, 'erp'); assert.equal(it[A].ko, '앞·하·좌/우'); assert.equal(it[A].es, 'Delantera Inferior Izquierda/Derecha');
    assert.equal(it[A].upload.ko, '앞·하·좌', '업로드 원본은 참고로'); assert.equal(it[A].rows.length, 1);
    assert.equal(it[B].src, 'upload'); assert.equal(it[B].ko, '앞·상·우'); assert.equal(it[B].es, 'Delantera Superior Derecha');
    assert.equal(it[C].src, 'erp'); assert.equal(it[C].ko, '뒤'); assert.equal(it[C].upload, null); assert.deepEqual(it[C].rows, [], '업로드 없이 확인값만');
    const r2 = await app.inject({ method: 'POST', url: '/api/products/positions/lookup', headers: { 'x-test-user': '5:sales' }, payload: { codes: [A] } });
    assert.equal(r2.json().items[A].rows, undefined, 'detail 없으면 요약만(기존과 같음)');
  } finally {
    await app.close();
    await query(`DELETE FROM product_positions WHERE ctr_code = ANY($1)`, [[A, B, C]]);
    await query(`DELETE FROM products WHERE code = ANY($1)`, [[A, B, C]]);
  }
});

// ───────────── 화면 ─────────────
const POS = {
  CQ0001L: { blocks: ['front'], levels: ['lower'], sides: ['lh', 'rh'], ko: '앞·하·좌/우', es: 'Delantera Inferior Izquierda/Derecha', src: 'erp',
    upload: { blocks: ['front'], levels: ['lower'], sides: ['lh'], ko: '앞·하·좌' }, rows: [{ block: 'front', level: 'lower', side: 'lh' }] },
  CB0002: { blocks: ['rear'], levels: [], sides: [], ko: '뒤', es: 'Trasera', src: 'upload', upload: { ko: '뒤' }, rows: [{ block: 'rear', level: null, side: null }] },
};
const PROD = (id, code) => ({ id, code, name: 'PIEZA ' + code, scode: '1111', app: 'NISSAN Versa 2012-2019', stock_qty: 3, is_active: true });
const ROUTES = {
  '/api/products/positions/lookup': (u, o, body) => ({ items: Object.fromEntries((body.codes || []).filter((c) => POS[c]).map((c) => [c, POS[c]])) }),
  '/api/products/\\d+/drilldown': { product: { id: 1, code: 'X', is_active: true }, sales: [], total_sold: 0, customer_count: 0, can_manage_status: false, oe: [] },
  '/api/products/by-vehicle': { items: [{ ...PROD(1, 'CQ0001L'), app_text: 'NISSAN Versa 2012-2019' }, { ...PROD(2, 'CB0002'), app_text: 'NISSAN Versa 2012-2019' }] },
  '/api/products\\?': { items: [PROD(1, 'CQ0001L'), PROD(2, 'CB0002')], total: 2 },
};
async function boot() {
  const dom = new JSDOM(readFileSync(P_HTML, 'utf-8'), {
    runScripts: 'dangerously', url: 'https://example.test/refatrix-products.html#tab=search',
    beforeParse(w) {
      w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 'T', api: 'https://api.test', user: { name: 'D', role: 'director' } }));
      w.alert = () => {}; w.confirm = () => true;
      w.fetch = async (url, o = {}) => {
        const u = String(url); const body = o.body ? JSON.parse(o.body) : null;
        const json = (d) => ({ ok: true, status: 200, json: async () => d });
        for (const [re, fn] of Object.entries(ROUTES)) if (new RegExp(re).test(u)) return json(typeof fn === 'function' ? fn(u, o, body) : fn);
        return json({ items: [], total: 0 });
      };
    },
  });
  const w = dom.window;
  await new Promise((r) => { if (w.document.readyState === 'complete') r(); else w.addEventListener('load', r); });
  await tick(100);
  return { w, d: w.document };
}
// 한 화면의 목록 배지 + 드릴다운 글자
async function readScreen(c, root, rowSel) {
  const badge = (code) => (root.querySelector(`${rowSel}[data-code="${code}"] .posb`) || {}).textContent || '';
  const out = {};
  for (const code of ['CQ0001L', 'CB0002']) {
    const tr = root.querySelector(`${rowSel}[data-code="${code}"]`);
    tr.dispatchEvent(new c.w.Event('click')); await tick(120);
    const sec = tr.nextElementSibling.querySelector('.possec');
    out[code] = { badge: badge(code), drill: sec.querySelector('.dh .posb').textContent, text: sec.textContent };
    tr.dispatchEvent(new c.w.Event('click')); await tick(30);   // 접기
  }
  return out;
}

test('B. 제품 찾기 — 차종 검색 결과와 제품 검색 결과가 같은 장착 위치', { skip: !JSDOM || !existsSync(P_HTML) }, async () => {
  const c = await boot();
  assert.match(c.d.title, /ps-1108pos/);
  // ① 차종으로 제품 찾기
  const mk = c.d.getElementById('veh-maker'); mk.innerHTML = '<option value="NISSAN">NISSAN</option>'; mk.value = 'NISSAN';
  c.d.getElementById('vehBtn').dispatchEvent(new c.w.Event('click')); await tick(150);
  const veh = await readScreen(c, c.d.getElementById('vehResult'), 'tr.vrow');
  // ② 제품 검색
  c.d.getElementById('q').value = 'C'; c.w.doSearch(); await tick(150);
  const srch = await readScreen(c, c.d, 'tr.prow:not(.vrow)');

  assert.deepEqual(veh.CQ0001L.badge, '앞·하·좌/우', '차종 검색 목록에도 배지');
  for (const code of ['CQ0001L', 'CB0002']) {
    assert.equal(veh[code].badge, srch[code].badge, code + ' 목록 배지 같음');
    assert.equal(veh[code].drill, srch[code].drill, code + ' 드릴다운 같음');
    assert.equal(veh[code].badge, veh[code].drill, code + ' 목록 = 드릴다운');
  }
  assert.match(srch.CQ0001L.text, /CTR 확인/); assert.match(srch.CQ0001L.text, /업로드 원본\(참고\): 앞·하·좌/);
  assert.match(srch.CQ0001L.text, /Delantera Inferior Izquierda\/Derecha/);
  assert.doesNotMatch(srch.CB0002.text, /CTR 확인/, '업로드 값은 표시 그대로');
  assert.match(srch.CB0002.text, /뒤/);
});
