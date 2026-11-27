// =====================================================================
// quote_vehicle_pick_front.test.mjs — 2026-11-27f · 견적 › 「차종으로 찾기」 차량 도면에서 골라 담기 (jsdom)
//   ① 고객 미선택이면 토글 비활성 · 고객을 고르면 켜짐 · 고객을 비우면 코드 입력으로 돌아감
//   ② CTR 부품 담기 → 견적 줄 {code, product_id, qty} · 미리보기 요청 · 같은 제품 다시 담으면 수량 합산 · 「견적 N」 배지
//   ③ 창고 0 CTR → 재고부족분 안내 · 비활성 제품 → 기존 비활성 경고
//   ④ CTR 없는(경쟁사만) 부품 → 코드 고르기(SYD/BAW) → 미매칭 줄 {code, brand, qty} (저장 시 개발요청 — 기존 흐름)
//   ⑤ 저장 본문에 그대로 실린다
//   실행: node --test test/quote_vehicle_pick_front.test.mjs   (jsdom 필요)
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(here, '..', '..', f), 'utf8');
let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* skip */ }
const SKIP = !JSDOM && 'jsdom 미설치';
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

const P = (b, l, s) => ({ blocks: b, levels: l, sides: s, src: 'erp' });
const VM = {
  vehicle: { maker: 'NISSAN', model: 'Versa', year: 2015 },
  items: [
    { id: 11, code: 'CB0165', name: 'ROTULA INFERIOR', cat: 'ball', syd: ['2609165'], baw: [], oe: [], pos: P(['front'], ['lower'], []), stock_qty: 12, transit_qty: 0, backorder_qty: 0, sold_qty: 5, racks: [], is_active: true },
    { id: 12, code: 'CE0121R', name: 'TERMINAL EXTERIOR', cat: 'tie', syd: [], baw: [], oe: [], pos: P(['front'], [], ['rh']), stock_qty: 0, transit_qty: 0, backorder_qty: 40, sold_qty: 1, racks: [], is_active: true },
    { id: 13, code: 'CL0999', name: 'TORNILLO ESTABILIZADOR', cat: 'link', syd: [], baw: [], oe: [], pos: P(['front'], [], []), stock_qty: 3, transit_qty: 0, backorder_qty: 0, sold_qty: 0, racks: [], is_active: false },
  ],
  competitors: [{ row_no: 9, cat: 'arm', descripcion: 'HORQUILLA TRASERA', syd: ['SYD9'], baw: ['BW9'], pos: P(['rear'], [], []), aplicacion: 'Versa 12-19', year_known: true }],
  counts: { ctr: 3, ctr_in_stock: 2, competitors: 1 },
};

function boot() {
  const calls = { preview: [], save: [], alerts: [], app: [] };
  const dom = new JSDOM(read('refatrix-quote.html'), {
    runScripts: 'dangerously', url: 'https://example.test/refatrix-quote.html', pretendToBeVisual: true,
    beforeParse(w) {
      w.eval(read('refatrix-vehiclemap.js'));   // jsdom 은 외부 script 를 읽지 않으므로 공용 모듈을 직접 넣는다
      w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 't', api: 'https://api.test', user: { name: 'dir', role: 'director' } }));
      w.alert = (m) => { calls.alerts.push(String(m)); }; w.confirm = () => true; w.prompt = () => '';
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
      w.HTMLElement.prototype.scrollIntoView = function () {};
      w.fetch = async (url, o = {}) => {
        const u = String(url);
        const json = (d) => ({ ok: true, status: 200, json: async () => d });
        if (u.includes('/api/customers')) return json({ items: [{ id: 1, code: 'C001', name: 'REFACCIONARIA NORTE', discount: 30 }] });
        if (u.includes('/api/products/app-')) calls.app.push(u.replace('https://api.test/api/products/', ''));
        if (u.includes('/api/products/app-makers')) return json({ items: ['NISSAN'], groups: [] });
        if (u.includes('/api/products/app-models')) return json({ items: u.includes('year=2021') ? ['Kicks', 'Versa'] : (u.includes('year=2010') ? ['Tiida'] : ['Kicks', 'Tiida', 'Versa']), groups: [] });
        if (u.includes('/api/products/app-years')) return json({ items: [2021, 2015, 2010] });
        if (u.includes('/api/products/vehicle-map')) return json(VM);
        if (u.includes('/api/quotes/preview')) {
          const b = JSON.parse(o.body); calls.preview.push(b);
          return json({ lines: b.lines.map((l) => ({ matched: !!l.product_id, input_code: l.code, ctr_code: l.product_id ? l.code : null, qty: l.qty,
            stock_flag: l.product_id ? 'ok' : 'not_found', list_price: 100, discount_rate: 30, final_price: 70, line_iva: 11.2, line_total: 81.2 })),
            totals: { subtotal: 0, iva: 0, total: 0, totalQty: 0, skuCount: 0 } });
        }
        if (u.endsWith('/api/quotes') && o.method === 'POST') { calls.save.push(JSON.parse(o.body)); return json({ id: 9, quote_no: 'Q-2026-0900' }); }
        return json({ items: [] });
      };
    },
  });
  return { w: dom.window, d: dom.window.document, calls };
}

async function openMap(c) {
  const { w, d } = c;
  d.getElementById('custSel').value = '1'; w.onCustChange(); await tick(80);
  d.getElementById('qmVeh').click(); await tick(80);
  d.getElementById('q-veh-maker').innerHTML = '<option value="NISSAN">NISSAN</option>';
  d.getElementById('q-veh-model').innerHTML = '<option value="Versa">Versa</option>';
  d.getElementById('q-veh-year').innerHTML = '<option value="2015">2015</option>';
  d.getElementById('qVehBtn').click(); await tick(100);
}
const row = (d, txt) => [...d.querySelectorAll('#qVehResult .vm-row')].find((r) => r.textContent.includes(txt));

test('① 고객을 골라야 「차종으로 찾기」가 켜진다', { skip: SKIP }, async () => {
  const { w, d } = boot(); await tick(250);
  assert.match(d.title, /qt-1127vo/);
  assert.equal(d.getElementById('qmVeh').disabled, true, '고객 전 비활성');
  d.getElementById('custSel').value = '1'; w.onCustChange(); await tick(50);
  assert.equal(d.getElementById('qmVeh').disabled, false);
  d.getElementById('qmVeh').click(); await tick(50);
  assert.ok(d.getElementById('qCodeWrap').classList.contains('hidden'), '코드 입력 숨김');
  assert.ok(!d.getElementById('qVehPanel').classList.contains('hidden'), '차종 패널');
  d.getElementById('custSel').value = ''; w.onCustChange(); await tick(50);
  assert.equal(d.getElementById('qmVeh').disabled, true);
  assert.ok(!d.getElementById('qCodeWrap').classList.contains('hidden'), '고객을 비우면 코드 입력으로');
  w.close();
});

test('② CTR 부품 담기 · 같은 제품 합산 · 배지 · ⑤ 저장 본문', { skip: SKIP }, async () => {
  const c = boot(); const { w, d, calls } = c; await tick(250);
  await openMap(c);
  row(d, 'ROTULA INFERIOR').click(); await tick(30);
  d.getElementById('vmPickQty').value = '3';
  d.getElementById('vmPickBtn').click(); await tick(150);
  const last = calls.preview.at(-1);
  assert.deepEqual(last.lines, [{ code: 'CB0165', product_id: 11, qty: 3 }]);
  assert.equal(last.customer_id, 1);
  assert.match(d.getElementById('vmPickMsg').textContent, /CTR CB0165 3개를 견적에 담았습니다/);
  assert.match(d.getElementById('linesWrap').textContent, /CB0165/, '아래 견적 줄 표에 보임');
  row(d, 'ROTULA INFERIOR').querySelector('.vm-add').click(); await tick(150);
  assert.deepEqual(calls.preview.at(-1).lines, [{ code: 'CB0165', product_id: 11, qty: 4 }], '같은 제품은 수량 합산');
  assert.match(row(d, 'ROTULA INFERIOR').textContent, /견적 4/, '도면 목록에 「견적 4」');
  w.saveQuote(); await tick(200);
  assert.equal(calls.save.at(-1).lines[0].product_id, 11);
  assert.equal(calls.save.at(-1).lines[0].qty, 4);
  w.close();
});

test('③ 창고 0 · 비활성 안내', { skip: SKIP }, async () => {
  const c = boot(); const { w, d, calls } = c; await tick(250);
  await openMap(c);
  row(d, 'TERMINAL EXTERIOR').click(); await tick(30);
  assert.match(d.querySelector('#qVehResult .vm-pnote').textContent, /재고부족분으로 기록/);
  d.getElementById('vmPickBtn').click(); await tick(150);
  assert.deepEqual(calls.preview.at(-1).lines, [{ code: 'CE0121R', product_id: 12, qty: 1 }]);
  assert.match(d.getElementById('lineMsg').textContent, /창고 0: 재고부족분으로 기록됩니다/);
  row(d, 'TORNILLO ESTABILIZADOR').click(); await tick(30);
  assert.match(d.querySelector('#qVehResult .vm-pnote').textContent, /비활성/);
  w.close();
});

test('④ CTR 없는 부품 → SYD/BAW 코드로 미매칭 줄(개발요청 흐름)', { skip: SKIP }, async () => {
  const c = boot(); const { w, d, calls } = c; await tick(250);
  await openMap(c);
  row(d, 'HORQUILLA TRASERA').click(); await tick(30);
  assert.match(d.querySelector('#qVehResult .vm-pnote').textContent, /개발요청으로 기록/);
  const sel = d.getElementById('vmPickCode');
  assert.deepEqual([...sel.options].map((o) => o.textContent), ['SYD SYD9', 'BAW BW9']);
  sel.value = '1'; d.getElementById('vmPickQty').value = '2';
  d.getElementById('vmPickBtn').click(); await tick(150);
  assert.deepEqual(calls.preview.at(-1).lines, [{ code: 'BW9', qty: 2, brand: 'BAW' }]);
  row(d, 'HORQUILLA TRASERA').querySelector('.vm-add').click(); await tick(150);
  assert.deepEqual(calls.preview.at(-1).lines, [{ code: 'BW9', qty: 2, brand: 'BAW' }, { code: 'SYD9', qty: 1, brand: 'SYD' }], '빠른 담기 = 첫 코드(SYD)');
  w.saveQuote(); await tick(200);
  assert.deepEqual(calls.save.at(-1).lines.map((l) => [l.code, l.brand || '', l.product_id || null]), [['BW9', 'BAW', null], ['SYD9', 'SYD', null]]);
  w.close();
});

test('⑥ 11-27g · 메이커 → 연식 → 모델 — 연식을 고르면 그 연식 모델만', { skip: SKIP }, async () => {
  const c = boot(); const { w, d, calls } = c; await tick(250);
  d.getElementById('custSel').value = '1'; w.onCustChange(); await tick(50);
  d.getElementById('qmVeh').click(); await tick(150);
  const ids = [...d.querySelectorAll('#qVehPanel .vm-sel select')].map((x) => x.id);
  assert.deepEqual(ids, ['q-veh-maker', 'q-veh-year', 'q-veh-model'], '화면 순서');
  const mk = d.getElementById('q-veh-maker'); mk.value = 'NISSAN'; calls.app.length = 0;
  mk.dispatchEvent(new w.Event('change')); await tick(120);
  assert.deepEqual(calls.app, ['app-years?maker=NISSAN', 'app-models?maker=NISSAN'], '메이커 → 연식 목록 → (연식 없이) 모델 전체');
  const opts = (id) => [...d.getElementById(id).options].map((o) => o.value).filter(Boolean);
  assert.deepEqual(opts('q-veh-year'), ['2021', '2015', '2010']);
  assert.deepEqual(opts('q-veh-model'), ['Kicks', 'Tiida', 'Versa']);
  d.getElementById('q-veh-model').value = 'Versa';
  const yr = d.getElementById('q-veh-year'); yr.value = '2021'; calls.app.length = 0;
  yr.dispatchEvent(new w.Event('change')); await tick(120);
  assert.deepEqual(calls.app, ['app-models?maker=NISSAN&year=2021']);
  assert.deepEqual(opts('q-veh-model'), ['Kicks', 'Versa'], '2021 모델만');
  assert.equal(d.getElementById('q-veh-model').value, 'Versa', '고른 모델이 새 목록에 있으면 유지');
  yr.value = '2010'; yr.dispatchEvent(new w.Event('change')); await tick(120);
  assert.deepEqual(opts('q-veh-model'), ['Tiida']);
  assert.equal(d.getElementById('q-veh-model').value, '', '없으면 비움');
  w.close();
});
