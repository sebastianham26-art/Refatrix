// =====================================================================
// 랙별 재고(0245) — 화면(jsdom) 검증
//   ① 포장작업지시서: 서버가 저장한 피킹 위치(picks)로 SKU × 랙 × 수량 줄을 나눠 찍는다.
//      fast moving 랙 먼저, FM 표시, 나뉜 줄은 「1/2 · Total SKU」, SKU 수·총수량은 그대로.
//   ② 제품찾기: 랙 열에 랙 × 수량(피킹 순서) + 위치 미지정.
//   ③ 재고실사: 📍 랙별 재고 화면이 열리고 목록이 그려진다.
//   실행: node --test test/rack_stock_front.test.mjs   (jsdom 필요)
// =====================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');

let JSDOM;
try { ({ JSDOM } = await import('jsdom')); } catch { /* skip */ }
const opts = JSDOM ? {} : { skip: 'jsdom 미설치 — skip (npm i -D jsdom)' };

// ---------------- ① 포장작업지시서 ----------------
async function bootQuote(inStock, picks) {
  const printed = [];
  const dom = new JSDOM(read('refatrix-quotelist.html'), {
    runScripts: 'dangerously', url: 'https://example.test/refatrix-quotelist.html',
    beforeParse(win) {
      win.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 't', api: 'https://api.test', user: { name: 'dir', role: 'director' } }));
      win.alert = (m) => { printed.push({ alert: String(m) }); };
      win.confirm = () => true;
      win.open = () => { const buf = []; return { document: { open() {}, write(h) { buf.push(h); }, close() { printed.push(buf.join('')); } } }; };
      win.fetch = async (url) => {
        const u = String(url);
        const json = (o) => ({ ok: true, status: 200, json: async () => o });
        if (/\/convert-preview/.test(u)) return json({ rack_stock_ready: true, is_guest: false, already: false, counts: { in_stock: inStock.length, shortage: 0, new_dev: 0 }, in_stock: inStock, shortage: [], new_dev: [] });
        if (/\/packing-doc$/.test(u)) return json({ has: false });
        if (/\/packing-printed$/.test(u)) return json({ packing_printed_at: '2026-10-01T15:00:00Z', packing_due_at: '2026-10-01T21:00:00Z', picks });
        if (/\/api\/quotes\/\d+$/.test(u)) return json({ quote: { id: 7 }, lines: inStock.map((x) => ({ ctr_code: x.ctr_code, syd_codes: 'SYD-' + x.ctr_code })) });
        if (/\/api\/quotes\?/.test(u)) return json({ items: [], summary: {} });
        if (/\/api\/quotes\/counts/.test(u)) return json({ open: 0, guest_pending: 0, delete_pending: 0 });
        if (/\/api\/company/.test(u)) return json({ emisor: 'Refatrix' });
        if (/\/api\/auth\/(login|me)/.test(u)) return json({ token: 't', user: { name: 'dir', role: 'director' }, perm: {} });
        return json({});
      };
    },
  });
  await new Promise((r) => dom.window.addEventListener('load', r));
  const w = dom.window;
  w.session = { token: 't', user: { name: 'dir', role: 'director' }, api: 'https://api.test' };
  dom.__printed = printed;
  await w.openConvert(7, false, 'Cliente X');
  return dom;
}
const rowsOf = (doc) => {
  const out = []; const re = /<td class="c-sku">([\s\S]*?)<\/td>[\s\S]*?<td class="c-name">([\s\S]*?)<\/td><td class="c-qty">([\s\S]*?)<\/td><td class="c-rack">([\s\S]*?)<\/td>/g;
  let m; while ((m = re.exec(doc))) out.push({ sku: m[1], name: m[2], qty: m[3], rack: m[4] }); return out;
};
async function printOf(dom) {
  dom.__printed.length = 0;
  await dom.window.printPickList();
  const doc = dom.__printed.find((x) => typeof x === 'string');
  assert.ok(doc, '인쇄 HTML 이 생성되어야 한다 ' + JSON.stringify(dom.__printed));
  return doc;
}

test('① 지시서 — SKU 를 랙별 줄로 나누고 fast moving 랙이 맨 앞', opts, async () => {
  const inStock = [
    { product_id: 11, ctr_code: 'CB0257', product_name: 'Rótula', qty: 6, avail: 6, rack_location: 'AE1-3, AE1-1',
      picks: [{ rack: 'FM-01', qty: 4, kind: 'fast' }, { rack: 'AE1-3', qty: 2, kind: 'carton' }] },
    { product_id: 12, ctr_code: 'CE0100', product_name: 'Terminal', qty: 3, avail: 3, rack_location: 'A-01-01',
      picks: [{ rack: 'A-01-01', qty: 3, kind: 'carton' }] },
  ];
  const saved = { 11: [{ rack: 'FM-01', qty: 4, kind: 'fast' }, { rack: 'AE1-3', qty: 2, kind: 'carton' }], 12: [{ rack: 'A-01-01', qty: 3, kind: 'carton' }] };
  const dom = await bootQuote(inStock, saved);
  // 미리보기에도 위치가 보인다
  assert.match(dom.window.document.getElementById('cvPreview').innerHTML, /📍 FM-01 ×4 · AE1-3 ×2/);
  const doc = await printOf(dom);
  const rows = rowsOf(doc);
  // fast(FM-01) 먼저 → 나머지는 랙 번호 자연정렬(A-01-01 < AE1-3)
  assert.deepEqual(rows.map((r) => [r.sku, r.qty]), [['CB0257', '4'], ['CE0100', '3'], ['CB0257', '2']]);
  assert.match(rows[0].rack, /^FM-01 <span class="fm">FM<\/span>$/, 'fast 랙이 첫 줄 + FM 표시');
  assert.equal(rows[1].rack, 'A-01-01');
  assert.equal(rows[2].rack, 'AE1-3');
  assert.match(rows[0].name, /1\/2 · Total SKU 6/);
  assert.match(rows[2].name, /2\/2 · Total SKU 6/);
  assert.doesNotMatch(rows[1].name, /Total SKU/, '한 랙이면 표시 없음');
  assert.match(doc, /No\. de SKU<\/span><span class="v">2</, 'SKU 수는 줄 수가 아니라 SKU 2개');
  assert.match(doc, /Piezas totales<\/span><span class="v">9</);
  assert.match(doc, /3 ubicaciones/);
});

test('② 지시서 — 랙재고로 다 못 채운 분량은 제품마스터 위치(ubic. maestro), 그것도 없으면 SIN UBICACIÓN', opts, async () => {
  const inStock = [
    { product_id: 21, ctr_code: 'CE0001', product_name: 'X', qty: 5, avail: 5, rack_location: 'B-02-01',
      picks: [{ rack: 'B-09-09', qty: 3, kind: 'carton' }, { rack: null, qty: 2, kind: null }] },
    { product_id: 22, ctr_code: 'CE0002', product_name: 'Y', qty: 1, avail: 1, rack_location: '',
      picks: [{ rack: null, qty: 1, kind: null }] },
  ];
  const dom = await bootQuote(inStock, null);   // 구버전 서버(picks 없음) → 미리보기 picks 사용
  const rows = rowsOf(await printOf(dom));
  assert.deepEqual(rows.map((r) => [r.sku, r.qty]), [['CE0001', '2'], ['CE0001', '3'], ['CE0002', '1']]);
  assert.match(rows[0].rack, /^B-02-01<span class="mst">ubic\. maestro<\/span>$/);
  assert.equal(rows[1].rack, 'B-09-09');
  assert.match(rows[2].rack, /SIN UBICACIÓN/);
  const pv = dom.window.document.getElementById('cvPreview').innerHTML;
  assert.match(pv, /랙 위치가 없는 SKU 1개/, 'CE0002 만 경고(CE0001 은 마스터 위치가 있음)');
});

test('③ 지시서 — picks 가 아예 없는 구버전 응답도 종전처럼 동작', opts, async () => {
  const inStock = [{ ctr_code: 'CE0010', product_name: 'Z', qty: 2, avail: 2, rack_location: 'A-1-10' },
                   { ctr_code: 'CE0009', product_name: 'W', qty: 1, avail: 1, rack_location: 'A-1-9' }];
  const dom = await bootQuote(inStock, undefined);
  const rows = rowsOf(await printOf(dom));
  assert.deepEqual(rows.map((r) => r.rack), ['A-1-9', 'A-1-10']);
  assert.deepEqual(rows.map((r) => r.qty), ['1', '2']);
});

// ---------------- ② 제품찾기 ----------------
test('④ 제품찾기 — 랙 열에 랙 × 수량(fast 먼저) + 위치 미지정', opts, async () => {
  const dom = new JSDOM(read('refatrix-products.html'), { runScripts: 'dangerously', url: 'https://example.test/refatrix-products.html',
    beforeParse(win) { win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) }); } });
  await new Promise((r) => dom.window.addEventListener('load', r));
  const f = dom.window.rackCellHtml;
  assert.equal(typeof f, 'function');
  const h = f({ stock_qty: 25, rack_location: 'X', rack_stock: [{ rack: 'FM-01', qty: 4, kind: 'fast' }, { rack: 'AE1-3', qty: 15, kind: 'carton' }] });
  assert.match(h, /<b>FM-01<\/b><span class="q">4<\/span><span class="fm">FM<\/span>.*<b>AE1-3<\/b><span class="q">15<\/span>/);
  assert.match(h, /위치 미지정 <span class="q">6<\/span>/);
  const legacy = f({ stock_qty: 3, rack_location: 'B-1', rack_stock: [] });
  assert.match(legacy, /B-1/);
  assert.doesNotMatch(legacy, /위치 미지정/);
  assert.equal(f({ stock_qty: 0, rack_location: '' }), '');
});

// ---------------- ③ 재고실사 · 랙별 재고 화면 ----------------
test('⑤ 재고실사 — 📍 랙별 재고 버튼 → 목록·랙칩·상세(디렉터 수정칸)', opts, async () => {
  const calls = [];
  const dom = new JSDOM(read('refatrix-stockcount.html'), { runScripts: 'dangerously', url: 'https://example.test/refatrix-stockcount.html',
    beforeParse(win) {
      win.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 't', api: 'https://api.test', user: { name: 'dir', role: 'director' } }));
      win.confirm = () => true; win.alert = () => {};
      win.fetch = async (url, init) => {
        const u = String(url); calls.push([u, init && init.method]);
        const json = (o) => ({ ok: true, status: 200, json: async () => o });
        if (/\/api\/rack-stock\/racks/.test(u)) return json({ racks: [{ rack: 'AE1-3', skus: 2, qty: 30, kind: 'carton' }, { rack: 'FM-01', skus: 1, qty: 4, kind: 'fast' }] });
        if (/\/api\/rack-stock\/product\/11/.test(u)) return json({ product: { id: 11, code: 'CB0257', name: 'Rótula', stock_qty: 19, master_rack: 'AE1-3' }, racks: [{ rack: 'FM-01', qty: 4, kind: 'fast' }], located: 4, unassigned: 15,
          moves: [{ id: 1, rack: 'FM-01', delta: 4, qty_after: 4, reason: 'count', ref: 'count:26', created_at: '2026-10-01T20:00:00Z', by_name: 'Sebastian' }] });
        if (/\/api\/rack-stock\/set/.test(u)) return json({ ok: true, delta: 2 });
        if (/\/api\/rack-stock\?/.test(u)) return json({ total: 1, items: [{ product_id: 11, code: 'CB0257', name: 'Rótula', stock_qty: 19, master_rack: 'AE1-3',
          racks: [{ rack: 'FM-01', qty: 4, kind: 'fast' }, { rack: 'AE1-3', qty: 15, kind: 'carton' }], located: 19, unassigned: 0, over: 0 }] });
        if (/\/api\/stock-counts$/.test(u)) return json({ items: [{ id: 26, code: 'SC-2026-0013', status: 'reconciled', mode: 'full', scope_note: 'CONTEO DE RACK AD' }] });
        return json({ items: [] });
      };
    } });
  await new Promise((r) => dom.window.addEventListener('load', r));
  const w = dom.window, $ = (id) => w.document.getElementById(id);
  $('rsOpenBtn').click();
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(!$('rackStockView').classList.contains('hidden'), '랙별 재고 화면이 열린다');
  assert.ok($('homeView').classList.contains('hidden'));
  assert.match($('rsRacks').innerHTML, /AE1-3.*<b>2<\/b>.*FM-01 ⚡/s);
  assert.match($('rsBody').innerHTML, /CB0257[\s\S]*<b>FM-01<\/b> 4[\s\S]*FM[\s\S]*<b>AE1-3<\/b> 15/);
  assert.match($('rsImpSel').innerHTML, /SC-2026-0013/, '디렉터: 과거 실사 가져오기 목록');
  $('rsBody').querySelector('tr[data-pid="11"]').dispatchEvent(new w.Event('click'));
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(!$('rsDetail').classList.contains('hidden'));
  assert.match($('rsDtMoves').innerHTML, /재고실사/);
  assert.ok(!$('rsDtEdit').classList.contains('hidden'), '디렉터는 수동 조정 칸이 보인다');
  $('rsEdRack').value = 'ae9-9'; $('rsEdQty').value = '2';
  $('rsEdSave').click();
  await new Promise((r) => setTimeout(r, 30));
  const set = calls.find((c) => /rack-stock\/set/.test(c[0]));
  assert.ok(set && set[1] === 'POST', '수동 조정 POST');
  assert.match(w.document.title, /sc1001rs1/);
});
