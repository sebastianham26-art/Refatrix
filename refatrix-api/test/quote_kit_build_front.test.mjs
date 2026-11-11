// jsdom: 견적 작성 「🧰 Kit 구성 가능」 (qt-1111kb · 2026-11-11)
//   KIT T = Tornillo estabilizador + Terminal exterior + Terminal interior · KIT H = Horquilla + Rótula
//   최소단위: Horquilla L+R · 나머지 L+R 또는 공용 2개 · 키트 수 = 품목별 세트 수의 최소(Disponible)
// 실행: QUOTE_HTML=../refatrix-quote.html node --test test/quote_kit_build_front.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const XS = require('xlsx-js-style');
const HTML = fs.readFileSync(process.env.QUOTE_HTML || path.resolve('..', 'refatrix-quote.html'), 'utf8').replace(/<script src="[^"]+"><\/script>/g, '');

const V = 'NISSAN Versa 2012-2019', A = 'CHEVROLET, GMC Aveo 2008-2017';
const P = (code, name, app, avail, stock = avail, incoming = 0, lp = 100) => ({ ctr_code: code, name, syd_codes: 'S' + code, app, list_price: lp, stock_qty: stock, avail_qty: avail, incoming_qty: incoming });
const ITEMS = [
  // Versa — T: Tornillo L/R 7·8 → 7 · Ext 공용 9 → 4 · Int 공용 4 → 2  ⇒ T=2 (Int 가 막음)
  P('CL1L', 'TORNILLO ESTABILIZADOR', V, 7), P('CL1R', 'TORNILLO ESTABILIZADOR', V, 8),
  P('CE1', 'TERMINAL EXTERIOR', V, 9), P('CR1', 'TERMINAL INTERIOR', V, 4, 6, 10),
  //        H: Rótula 공용 10 → 5 · Rótula L/R 3·3 → 3(더 적어 안 고름) · Horquilla L/R 5·6 → 5  ⇒ H=5
  P('CB1', 'RÓTULA', V, 10), P('CB2L', 'RÓTULA', V, 3), P('CB2R', 'RÓTULA', V, 3),
  P('CQ1L', 'HORQUILLA', V, 5), P('CQ1R', 'HORQUILLA', V, 6),
  P('K0009', 'KIT T VERSA', V, 50),   // 키트 제품 자체는 계산에서 제외
  // Aveo — H: Horquilla 공용뿐(불가) ⇒ KIT H 없음 · T: Int 없음 ⇒ KIT T 없음 → 목록에 없음
  P('CQ9', 'HORQUILLA', A, 20), P('CB9', 'RÓTULA', A, 20), P('CL9', 'TORNILLO ESTABILIZADOR', A, 20), P('CE9', 'TERMINAL EXTERIOR', A, 20),
];

async function boot() {
  const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'https://example.test/refatrix-quote.html', pretendToBeVisual: true });
  const w = dom.window; const calls = [];
  w.fetch = async (u) => { u = String(u); calls.push(u);
    if (u.includes('/api/quotes/price-list')) return { ok: true, json: async () => ({ items: ITEMS, discountRate: 55 }) };
    return { ok: true, json: async () => ({}), text: async () => '' }; };
  w.alert = () => {};
  await new Promise((r) => setTimeout(r, 30));
  const files = [];
  w.XLSX = Object.assign({}, XS, { writeFile: (wb, name) => files.push({ name, wb }) });
  w.eval("session={token:'t',api:'https://api.test',user:{name:'d',role:'director'}}");
  const $ = (id) => w.document.getElementById(id);
  $('custSel').innerHTML = '<option value="">—</option><option value="__guest__">g</option>';
  $('custSel').value = '__guest__'; w.eval('onCustChange()'); $('guestName').value = 'Taller'; $('discShow').value = '55'; w.eval('onDiscInput()');
  return { w, $, calls, files };
}

test('① 버튼 · 전체 SKU 조회(kit 필터 무시) · 엑셀 2시트 · 파일명', async () => {
  const { w, $, calls, files } = await boot();
  assert.match(w.document.title, /qt-1111kb/);
  const r = w.document.querySelector('input[name=kitMode][value=excl]'); r.checked = true; r.dispatchEvent(new w.Event('change'));   // Kit 제외 상태여도
  $('btnKitBuild').click(); await new Promise((r) => setTimeout(r, 150));
  const u = calls.find((x) => x.includes('/api/quotes/price-list'));
  assert.ok(u.includes('all=1') && !u.includes('kit='), u);
  assert.equal(w.eval('kitMode()'), 'excl', '보기 선택은 되돌린다');
  assert.equal(files.length, 1);
  assert.match(files[0].name, /^kits_posibles_Taller_\d{4}-\d{2}-\d{2}\.xlsx$/);
  assert.deepEqual(files[0].wb.SheetNames, ['Kits por vehículo', 'Componentes']);
  assert.match($('lineMsg').textContent, /차종 1개 \(KIT T 1 · KIT H 1\)/);
});

test('② 키트 수 · 최소단위 · 고른 코드 · 막는 품목 · 가격', async () => {
  const { w, $, files } = await boot();
  $('btnKitBuild').click(); await new Promise((r) => setTimeout(r, 150));
  const ws = files[0].wb.Sheets['Kits por vehículo'];
  assert.equal(ws.A6.v, 'Nissan Versa 2012-2019');
  assert.ok(!ws.A7 || !ws.A7.v, 'Aveo(공용 Horquilla 뿐 · Int 없음)는 목록에 없음');
  // KIT T
  assert.equal(ws.C6.v, 2); assert.equal(ws.D6.v, 3, 'Existencia: Int 6 → 3'); assert.equal(ws.E6.v, 4, '운송중 포함: Tor 7 · Ext 4 · Int (4+10)/2=7 → 4');
  assert.equal(ws.F6.v, 'Terminal interior');
  assert.equal(ws.G6.v, 'CL1L×1 + CL1R×1  (7)'); assert.equal(ws.H6.v, 'CE1×2  (4)'); assert.equal(ws.I6.v, 'CR1×2  (2)');
  assert.equal(ws.J6.v, Math.round((100 + 100 + 200 + 200) * 0.45 * 100) / 100);
  // KIT H
  assert.equal(ws.K6.v, 5); assert.equal(ws.N6.v, 'Horquilla, Rótula');
  assert.equal(ws.O6.v, 'CQ1L×1 + CQ1R×1  (5)'); assert.equal(ws.P6.v, 'CB1×2  (5)');
  // 구성품 시트 — KIT T 3품목(4줄) + KIT H 2품목(3줄), 키트 제품(K0009) 없음
  const c = files[0].wb.Sheets['Componentes']; const rows = [];
  for (let r = 2; c['A' + r]; r++) rows.push([c['C' + r].v, c['F' + r].v, c['I' + r].v, c['D' + r].v]);
  assert.deepEqual(rows, [['KIT T', 'CL1L', 1, 2], ['KIT T', 'CL1R', 1, 2], ['KIT T', 'CE1', 2, 2], ['KIT T', 'CR1', 2, 2],
    ['KIT H', 'CQ1L', 1, 5], ['KIT H', 'CQ1R', 1, 5], ['KIT H', 'CB1', 2, 5]]);
});

test('③ 순수 계산 — Horquilla 공용 불가 · K코드 제외 · 품목 하나라도 없으면 그 키트 없음', async () => {
  const { w } = await boot();
  const R = w.eval('KITB').compute([
    { label: 'X 2010', vio: 5, region: 'AS', it: P('CQ5', 'HORQUILLA', '', 9) }, { label: 'X 2010', vio: 5, region: 'AS', it: P('CB5', 'RÓTULA', '', 9) },
    { label: 'Y 2010', vio: 1, region: 'AS', it: P('CQ6L', 'HORQUILLA', '', 3) }, { label: 'Y 2010', vio: 1, region: 'AS', it: P('CQ6R', 'HORQUILLA', '', 1) },
    { label: 'Y 2010', vio: 1, region: 'AS', it: P('CB6L', 'RÓTULA', '', 4) }, { label: 'Y 2010', vio: 1, region: 'AS', it: P('CB6R', 'RÓTULA', '', 4) },
    { label: 'Sin aplicación especificada', region: 'NA', it: P('CQ7L', 'HORQUILLA', '', 9) },
  ]);
  assert.equal(JSON.stringify(R.map((x) => [x.label, Object.keys(x.kits).join(), x.kits.H && x.kits.H.kav])), JSON.stringify([['Y 2010', 'H', 1]]));
});
