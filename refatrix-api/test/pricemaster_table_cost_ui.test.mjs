// 2026-11-23 · 가격표 화면 — FOB MXN · Total Cost MXN 열 · 📥 엑셀 다운로드 (jsdom)
//   실행: node test/pricemaster_table_cost_ui.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
const html = readFileSync(new URL('../../refatrix-pricemaster.html', import.meta.url), 'utf8');
const ROWS = [
  { id: 1, code: 'AAA1', name: 'HORQUILLA', origin: 'KR', is_active: true, fob_usd: 10, list_price: 900, list_price_syd: 700, fob_mxn: 183.5, total_cost_mxn: 220, cost_basis: 'import', cost_batches: 2, cost_qty: 150, sold_qty: 42, sales_mxn: 12600, gross_profit_mxn: 3360, gross_margin: 0.2667, sold_inv_n: 2, last_sale: '2026-11-15', mult: 4.9, ratio: 1.29, last_change: '2026-11-01' },
  { id: 2, code: 'BBB1', name: 'RÓTULA', origin: 'CN', is_active: true, fob_usd: 5, list_price: 400, list_price_syd: null, fob_mxn: 91.75, total_cost_mxn: 150.46, cost_basis: 'stored', cost_batches: 0, cost_qty: 0, sold_qty: 4, sales_mxn: 1200, gross_profit_mxn: -50, gross_margin: -0.0417, sold_inv_n: 1, last_sale: '2026-11-01', mult: 4.36, ratio: null, last_change: null },
  { id: 3, code: 'CCC1', name: 'BUJE', origin: 'TR', is_active: true, fob_usd: null, list_price: 300, list_price_syd: null, fob_mxn: null, total_cost_mxn: null, cost_basis: null, cost_batches: 0, cost_qty: 0, sold_qty: 0, sales_mxn: 0, gross_profit_mxn: null, gross_margin: null, sold_inv_n: 0, last_sale: null, mult: null, ratio: null, last_change: null },
];
const calls = []; let saved = null;
const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://erp.refatrix.com/refatrix-pricemaster.html',
  beforeParse(w) {
    w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 't', api: 'https://api', user: { name: 'Seb', role: 'director' } }));
    w.fetch = async (url) => { calls.push(String(url)); const u = new URL(url);
      const body = u.pathname === '/api/price-master/facets' ? { ready: true, today: '2026-11-23', fx: { rate: 18.35, date: '2026-11-23' }, origin: [], cat: [], maker: [], material: [], can_edit: true }
        : u.pathname === '/api/price-master/table' ? { fx: { rate: 18.35, date: '2026-11-23' }, kpi: { total: 3, fob: 2, list: 3, mult_avg: 4.6, ratio_avg: 1.29, sales_mxn: 13800, gross_profit_mxn: 3310, gross_margin: 0.2399, sales_nocost_mxn: 0 }, rows: ROWS } : {};
      return { ok: true, status: 200, json: async () => body }; };
    w.HTMLCanvasElement.prototype.getContext = () => null;
    w.XLSX = { utils: { aoa_to_sheet: (a) => ({ a }), book_new: () => ({}), book_append_sheet: () => {} }, writeFile: (wb, name) => { saved = { ...(saved || {}), name }; } };
    const orig = w.Node.prototype.appendChild;
    w.Node.prototype.appendChild = function (el) { if (el && el.tagName === 'SCRIPT' && el.src && el.src.includes('xlsx')) { setTimeout(() => el.onload && el.onload(), 0); return el; } return orig.call(this, el); };
    const origS = w.XLSX.utils.aoa_to_sheet; w.XLSX.utils.aoa_to_sheet = (a) => { saved = { ...(saved || {}), aoa: a }; return origS(a); };
  } });
const w = dom.window; const $ = (id) => w.document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 40 && !$('ttb').querySelector('tr td'); i++) await sleep(50);
let pass = 0;
const ok = (n, f) => { f(); pass++; console.log('  ✔', n); };
ok('빌드 토큰 pm-1125sp (탭 제목)', () => assert.match(w.document.title, /pm-1125sp/));
ok('머리글: FOB (USD) → FOB MXN (오늘) → Total Cost MXN → List', () => {
  const h = [...$('tth').querySelectorAll('th')].map((x) => x.textContent.replace(/[▲▼↕\s]+$/g, '').trim());
  const i = h.findIndex((x) => x.startsWith('FOB (USD)'));
  assert.ok(h[i + 1].startsWith('FOB MXN'), h.join('|')); assert.ok(h[i + 2].startsWith('Total Cost MXN')); assert.ok(h[i + 7].startsWith('List'));
  assert.ok(h[i + 3].startsWith('판매 누적')); assert.ok(h[i + 4].startsWith('총 매출액')); assert.ok(h[i + 5].startsWith('매출이익액')); assert.ok(h[i + 6].startsWith('매출이익률')); assert.equal(h.length, 15);
});
ok('값: 183.50 · 220.00(수입 2회 툴팁) · 150.46* (저장 원가) · 없음 —', () => {
  const tr = [...$('ttb').querySelectorAll('tr')]; const cell = (r, c) => tr[r].children[c];
  assert.equal(cell(0, 4).textContent, '183.50'); assert.equal(cell(0, 5).textContent, '220.00'); assert.match(cell(0, 5).title, /수입 2회 · 누적 150개/);
  assert.equal(cell(1, 5).textContent, '150.46*'); assert.match(cell(1, 5).title, /저장된 평균원가/);
  assert.equal(cell(2, 4).textContent, '—'); assert.equal(cell(2, 5).textContent, '—');
  assert.equal(tr[0].children.length, 15);
  assert.equal(cell(0, 7).textContent, '12,600.00'); assert.equal(cell(0, 8).textContent, '3,360.00'); assert.equal(cell(0, 9).textContent, '26.7%');
  assert.ok(cell(1, 8).classList.contains('up')); assert.equal(cell(1, 9).textContent, '-4.2%'); assert.equal(cell(2, 8).textContent, '—'); assert.equal(cell(2, 9).textContent, '—');
  assert.equal(cell(0, 6).textContent, '42'); assert.match(cell(0, 6).title, /인보이스 2건 · 마지막 판매 2026-11-15/); assert.equal(cell(2, 6).textContent, '0');
});
ok('카드: 환율 바로 뒤에 누적 매출액 → 매출총이익률 → 매출이익금액', () => {
  const k = [...$('tkpis').querySelectorAll('.kpi')].map((x) => [x.querySelector('span').textContent, x.querySelector('b').textContent]);
  const i = k.findIndex((x) => x[0].startsWith('환율'));
  assert.deepEqual(k.slice(i + 1).map((x) => x[0]), ['누적 매출액 (MXN)', '매출총이익률', '매출이익금액 (MXN)']);
  assert.deepEqual(k.slice(i + 1).map((x) => x[1]), ['$ 13,800.00', '24.0%', '$ 3,310.00']);
});
ok('Total Cost 제목 정렬 → sort=cost 로 서버 재조회', () => {
  const th = [...$('tth').querySelectorAll('th')].find((x) => x.textContent.startsWith('Total Cost')); th.click();
});
await sleep(100);
ok('… 요청에 sort=cost', () => assert.ok(calls.some((u) => /sort=cost/.test(u)), calls.join('\n')));
assert.equal($('btnTExport').textContent, '📥 엑셀 다운로드');
$('btnTExport').click(); for (let i = 0; i < 40 && !(saved && saved.name); i++) await sleep(50);
ok('엑셀 다운로드: 전체(limit=20000) · 19열 · FOB MXN(TC) · Total Cost MXN · 원가 기준', () => {
  assert.ok(calls.some((u) => /limit=20000/.test(u)));
  assert.match(saved.name, /^Refatrix_precios_2026-11-23\.xlsx$/);
  const [h, r1, r2, r3] = JSON.parse(JSON.stringify(saved.aoa));
  assert.deepEqual(h.slice(0, 15), ['Clave CTR', 'Producto', 'Origen', 'FOB USD', 'FOB MXN (TC 18.3500 · 2026-11-23)', 'Total Cost MXN', 'Base costo', 'Importaciones', 'Vendido acumulado', 'Facturas', 'Ultima venta', 'Ventas totales MXN', 'Utilidad bruta MXN', 'Margen bruto %', 'List Price MXN']);
  assert.deepEqual(r1.slice(3, 15), [10, 183.5, 220, 'Promedio importaciones', 2, 42, 2, '2026-11-15', 12600, 3360, 26.7, 900]);
  assert.deepEqual(r3.slice(8, 14), [0, 0, '', 0, null, null]);
  assert.deepEqual(r2.slice(5, 8), [150.46, 'Costo promedio guardado', null]);
  assert.deepEqual(r3.slice(4, 7), [null, null, '']);
});
// 받은 파일을 그대로 다시 올릴 때 FOB MXN 열이 FOB USD 로 잡히지 않아야 한다
ok('다시 올리기: 머리글 인식 FOB=FOB USD(3) · List=List Price MXN(14)', () => {
  const src = html.match(/fob:c=>([^,]+),\s*list:c=>([^}]+)\}/);
  const fobT = new Function('c', 'return ' + src[1]); const listT = new Function('c', 'return ' + src[2]);
  const h = saved.aoa[0]; assert.equal(h.findIndex(fobT), 3); assert.equal(h.findIndex(listT), 14);
});
console.log(`\n${pass} passed`);
process.exit(0);
