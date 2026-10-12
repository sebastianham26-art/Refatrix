// =====================================================================
// 0269 · 실사 랙 업로드 · 위치수정 · 피킹 기록 — 화면(jsdom) 검증  2026-10-12
//   ① 업로드 파서: conteos 가로형(코드 · UBICACIÓN/QTY ×N · QTY CONTADA …) / 세로형 / 머리글 오류
//   ② 재고실사 📍 랙별 재고: 업로드 미리보기 표·칩 → 디렉터 저장 POST · 위치수정 POST(옮길 수 있는 수량 한도)
//   ③ 창고 포장: 랙위치·수량(전체 랙) 열 · [지시서대로] · [다른 랙] 모달 → 기록 POST
//   ④ 포장작업지시서 인쇄: 「Existencia por rack」 + 「Rack real」 칸
//   실행: node --test test/rack_edit_pick_front.test.mjs   (jsdom 필요)
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
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function bootStock(role, handler) {
  const calls = [];
  const dom = new JSDOM(read('refatrix-stockcount.html'), { runScripts: 'dangerously', url: 'https://example.test/refatrix-stockcount.html',
    beforeParse(win) {
      win.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 't', api: 'https://api.test', user: { name: 'u', role } }));
      win.confirm = () => true; win.alert = () => {};
      win.fetch = async (url, init) => {
        const u = String(url); const body = init && init.body ? JSON.parse(init.body) : null;
        calls.push({ u, method: (init && init.method) || 'GET', body });
        const json = (o, st = 200) => ({ ok: st < 400, status: st, json: async () => o });
        const h = handler && handler(u, body, json);
        if (h) return h;
        if (/\/api\/rack-stock\/racks/.test(u)) return json({ racks: [{ rack: 'AE1-1', skus: 1, qty: 10, kind: 'carton' }, { rack: 'FM-01', skus: 1, qty: 9, kind: 'fast' }] });
        if (/\/api\/rack-stock\/imports/.test(u)) return json({ items: [] });
        if (/\/api\/rack-stock\?/.test(u)) return json({ total: 0, items: [] });
        return json({ items: [] });
      };
    } });
  await new Promise((r) => dom.window.addEventListener('load', r));
  dom.__calls = calls;
  return dom;
}

test('① 업로드 파서 — conteos 가로형 · 중복 줄 서명 · 빈칸 · 세로형 · 머리글 없음', opts, async () => {
  const dom = await bootStock('director');
  const P0 = dom.window.parseRackSheet;
  const P = (aoa) => JSON.parse(JSON.stringify(P0(aoa)));   // jsdom 쪽 배열 → 이 쪽 배열(deepEqual 용)
  const wide = [
    ['CODIGO CTR', 'UBICACIÓN', 'QTY', 'UBICACIÓN', 'QTY', 'UBICACIÓN', 'QTY', 'QTY CONTADA', 'QTY SISTEMA ERP', 'DIFERENCIA'],
    ['CB0011', 'AD1-1', 8, 'AE1-2', 30, 'D1-3', 8, 46, 46, 0],
    ['CQ0172L', 'AD6-1', 4, null, null, null, null, 4, 4, 0],
    ['CQ0172L', 'AD6-1', 4, null, null, null, null, 4, 4, 0],
    [null, null, null, null, null, null, null, null, null, null],
    ['GV0780', "E2'3", 5, 'AD5-2', 12, null, null, 18, 19, -1],    // 스캐너 아포스트로피 → 하이픈 · 합계 ≠ CONTADA
    ['CX0001', 'AA1-1', null, null, null, null, null, null, 1, null], // 수량 빈칸 → 서버가 오류
  ];
  const p = P(wide);
  assert.equal(p.pairs, 3);
  assert.equal(p.lines, 5);
  assert.deepEqual(p.rows.filter((r) => r.code === 'CB0011').map((r) => [r.rack, r.qty]), [['AD1-1', 8], ['AE1-2', 30], ['D1-3', 8]]);
  const dup = p.rows.filter((r) => r.code === 'CQ0172L');
  assert.equal(dup.length, 2); assert.equal(dup[0].sig, dup[1].sig, '같은 내용의 줄은 서명이 같다(서버가 한 번만 셈)');
  assert.equal(p.rows.find((r) => r.code === 'GV0780').rack, 'E2-3');
  assert.deepEqual(p.sumWarn, [6], 'QTY CONTADA 와 다른 줄 번호');
  assert.equal(p.rows.find((r) => r.code === 'CX0001').qty, null);
  const long = P([['Código', 'Rack', 'Cantidad'], ['CB0001', 'A1-1', 3]]);
  assert.deepEqual(long.rows.map((r) => [r.code, r.rack, r.qty]), [['CB0001', 'A1-1', 3]]);
  assert.ok(P([['foo', 'bar'], [1, 2]]).error);
  dom.window.close();
});

test('② 업로드 미리보기 → 칩·표 → 디렉터 저장', opts, async () => {
  const preview = { ok: true, counts: { rows: 4, skus: 3, ok: 1, under: 1, over: 1, unchanged: 0, unknown: 1, errors: 0, dup_lines: 0 },
    skus: [
      { product_id: 1, code: 'CB0011', stock: 46, total: 46, diff: 0, status: 'ok', racks: [{ rack: 'AD1-1', qty: 8 }, { rack: 'AE1-2', qty: 38 }], current: [], unchanged: false, dup_lines: 0, holds: null },
      { product_id: 2, code: 'CE0088L', stock: 0, total: 2, diff: 2, status: 'over', racks: [{ rack: 'AD2-3', qty: 2 }], current: [], unchanged: false, dup_lines: 0, holds: null },
      { product_id: 3, code: 'GV0780', stock: 19, total: 17, diff: -2, status: 'under', racks: [{ rack: 'E2-3', qty: 5 }], current: [{ rack: 'X1-1', qty: 19 }], unchanged: false, dup_lines: 0, holds: { qty: 4, quotes: 'SQ-1' } },
    ], unknown: [{ code: 'NOPE', lines: [9] }], errors: [] };
  const dom = await bootStock('director', (u, b, json) => {
    if (/import\/preview/.test(u)) return json(preview);
    if (/\/api\/rack-stock\/import$/.test(u)) return json({ ok: true, id: 7, skus: 2, changed: 3, blocked: [{ code: 'CE0088L', reason: 'over' }], held: [{ code: 'GV0780', racks: ['X1-1(SQ-1 4)'] }], unknown: [], errors: [] });
    return null;
  });
  const w = dom.window, $ = (id) => w.document.getElementById(id);
  $('rsOpenBtn').click(); await tick();
  await w.rackUploadAoa([['CODIGO CTR', 'UBICACIÓN', 'QTY'], ['CB0011', 'AD1-1', 8]], 'conteos.xlsx');
  assert.ok(!$('rsUpRes').classList.contains('hidden'));
  assert.match($('rsUpChips').innerHTML, /초과\(저장 안 함\)/);
  // 기본 필터 = 문제 항목(일치 제외)
  assert.doesNotMatch($('rsUpBody').innerHTML, /CB0011/);
  assert.match($('rsUpBody').innerHTML, /CE0088L[\s\S]*초과 → 저장 안 함/);
  assert.match($('rsUpBody').innerHTML, /GV0780[\s\S]*지시서 SQ-1 가 4개 잡음/);
  assert.match($('rsUpApply').textContent, /2 SKU/, '초과 제외 2 SKU 저장 예정');
  $('rsUpApply').click(); await tick();
  const c = dom.__calls.find((x) => /\/api\/rack-stock\/import$/.test(x.u));
  assert.equal(c.method, 'POST'); assert.equal(c.body.file_name, 'conteos.xlsx'); assert.equal(c.body.rows.length, 1);
  assert.match($('rsUpMsg').textContent, /업로드 #7 · 2 SKU 저장 · 저장 안 함 1 SKU: CE0088L\(재고 초과\) · ⚠ 지시서 위치가 줄어든 SKU: GV0780 X1-1\(SQ-1 4\)/);
  w.close();
});

test('③ 창고담당 — 저장 버튼 숨김 · 상세에서 위치수정(옮길 수 있는 수량 한도) POST', opts, async () => {
  const detail = { product: { id: 11, code: 'CB0257', name: 'Rótula', stock_qty: 19, master_rack: '' },
    racks: [{ rack: 'FM-01', qty: 9, kind: 'fast', held: 5, held_quotes: ['SQ-9'], movable: 4 }, { rack: 'AE1-1', qty: 8, kind: 'carton', held: 0, held_quotes: [], movable: 8 }],
    located: 17, unassigned: 2, moves: [{ id: 1, rack: 'AE1-1', delta: -2, qty_after: 8, reason: 'transfer', note: 'AE1-1 → FM-01', created_at: '2026-10-12T19:00:00Z', by_name: 'Luis' }], edit_ready: true };
  const dom = await bootStock('warehouse', (u, b, json) => {
    if (/\/api\/rack-stock\/product\/11/.test(u)) return json(detail);
    if (/\/api\/rack-stock\/transfer/.test(u)) return json({ ok: true });
    if (/\/api\/rack-stock\?/.test(u)) return json({ total: 1, items: [{ product_id: 11, code: 'CB0257', name: 'Rótula', stock_qty: 19, master_rack: '', racks: detail.racks, located: 17, unassigned: 2, over: 0 }] });
    return null;
  });
  const w = dom.window, $ = (id) => w.document.getElementById(id);
  $('rsOpenBtn').click(); await tick();
  assert.ok($('rsUpApply').classList.contains('hidden'), '업로드 저장은 디렉터만');
  $('rsBody').querySelector('tr[data-pid="11"]').dispatchEvent(new w.Event('click')); await tick();
  assert.ok(!$('rsTr').classList.contains('hidden'), '위치수정 칸이 보인다');
  assert.ok($('rsDtEdit').classList.contains('hidden'), '디렉터 수동조정 칸은 숨김');
  assert.match($('rsDtRacks').innerHTML, /FM-01[\s\S]*SQ-9[\s\S]*<td class="num">4<\/td>/);
  assert.match($('rsDtMoves').innerHTML, /위치수정/);
  const from = $('rsTrFrom');
  assert.deepEqual([...from.options].map((o) => [o.value, o.getAttribute('data-max')]), [['FM-01', '4'], ['AE1-1', '8'], ['', '2']]);
  // 한도 초과 → 서버 호출 없이 막는다
  $('rsTrTo').value = 'AE2-2'; $('rsTrQty').value = '5';
  $('rsTrGo').click(); await tick();
  assert.match($('rsTrMsg').textContent, /4개/);
  assert.ok(!dom.__calls.some((c) => /transfer/.test(c.u)));
  $('rsTrQty').value = '4'; $('rsTrTo').value = "ae2'2";
  $('rsTrGo').click(); await tick();
  const t = dom.__calls.find((c) => /transfer/.test(c.u));
  assert.deepEqual([t.body.product_id, t.body.from, t.body.to, t.body.qty], [11, 'FM-01', 'AE2-2', 4]);
  // 위치 미지정 → 랙
  from.value = ''; from.dispatchEvent(new w.Event('change'));
  assert.equal($('rsTrQty').max, '2');
  w.close();
});

test('④ 창고 포장 — 랙위치·수량(전체 랙) · 지시서대로 · 다른 랙 모달 기록', opts, async () => {
  const calls = [];
  let picked = false;
  const pack = () => ({ quote_id: 5, quote_no: 'SQ-5', customer: 'Cliente', elapsed_biz_sec: 0, required_total: 5, scanned_total: 0, all_done: false, photos_ok: false, boxes: [],
    items: [{ product_id: 11, ctr_code: 'CB0257', syd_code: '', ean: '1', required: 5, scanned: 0, remaining: 5, box_nos: [], rack_location: 'FM-01 ×5',
      rack_picks: 'FM-01 ×5', picks: [{ rack: 'FM-01', qty: 5, kind: 'fast', picked }], picked, picked_by_name: picked ? 'Luis' : '',
      racks_all: [{ rack: 'FM-01', qty: 9, kind: 'fast' }, { rack: 'AE1-1', qty: 8, kind: 'carton' }] }] });
  const dom = new JSDOM(read('refatrix-warehouse.html'), { runScripts: 'dangerously', url: 'https://example.test/refatrix-warehouse.html',
    beforeParse(win) {
      win.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 't', api: 'https://api.test', user: { name: 'u', role: 'warehouse' } }));
      win.localStorage.setItem('wh_lang', 'ko');   // 창고 계정 기본은 스페인어 — 이 시험은 한국어 문구로 본다
      win.HTMLMediaElement && (win.HTMLMediaElement.prototype.play = () => Promise.resolve());
      win.AudioContext = undefined; win.webkitAudioContext = undefined;
      win.fetch = async (url, init) => {
        const u = String(url); const body = init && init.body ? JSON.parse(init.body) : null;
        calls.push({ u, method: (init && init.method) || 'GET', body });
        const json = (o, st = 200) => ({ ok: st < 400, status: st, json: async () => o });
        if (/\/pick-options/.test(u)) return json({ product_id: 11, ctr_code: 'CB0257', required: 5, stock: 19, located: 17, unassigned: 2,
          racks: [{ rack: 'FM-01', qty: 9, kind: 'fast', held_other: 0, held_quotes: [], max: 9 }, { rack: 'AE1-1', qty: 8, kind: 'carton', held_other: 3, held_quotes: ['SQ-2'], max: 5 }], current: [{ rack: 'FM-01', qty: 5 }] });
        if (/\/packing\/5\/pick$/.test(u)) { picked = true; return json({ ok: true, picks: (body.picks || [{ rack: 'FM-01', qty: 5 }]).map((k) => ({ ...k, picked: true })) }); }
        if (/\/packing\/5\/photos/.test(u)) return json({ photos: [] });
        if (/\/packing\/5$/.test(u)) return json(pack());
        if (/packing-queue$/.test(u)) return json({ count: 1, in_business: false, items: [{ quote_id: 5, quote_no: 'SQ-5', customer: 'Cliente', printed_at: '2026-10-12T15:00:00Z', elapsed_biz_sec: 0, total_qty: 5, packed_qty: 0 }] });
        if (/ship-queue/.test(u)) return json({ items: [] });
        return json({});
      };
    } });
  await new Promise((r) => dom.window.addEventListener('load', r));
  const w = dom.window, $ = (id) => w.document.getElementById(id);
  await tick(80);
  $('queue').querySelector('.qcard[data-id="5"]').click(); await tick(80);
  const body = $('remBody').innerHTML;
  assert.match(body, /FM-01<span class="fm">FM<\/span> ×5/);
  assert.match(body, /전체 랙: FM-01 9 · AE1-1 8/, '이 SKU 가 놓인 모든 랙 × 수량');
  assert.match(body, /지시서대로/);
  $('remBody').querySelector('[data-pk="plan"]').click(); await tick(60);
  const c1 = calls.find((c) => /\/pick$/.test(c.u));
  assert.deepEqual(c1.body, { product_id: 11, as_planned: true });
  assert.match($('remBody').innerHTML, /✓ 기록됨<small>Luis<\/small>/);
  // 변경 → 모달
  $('remBody').querySelector('[data-pk="edit"]').click(); await tick(60);
  assert.ok($('pickModal').classList.contains('on'));
  assert.match($("pmBody").innerHTML, /다른 지시서 SQ-2 계획 3개/);
  assert.match($('pmBody').innerHTML, /위치 미지정/);
  const ins = [...$('pmBody').querySelectorAll('input')];
  assert.equal(ins[0].value, '5', '현재 기록이 미리 채워진다');
  ins[0].value = '1'; ins[1].value = '6'; ins[1].dispatchEvent(new w.Event('input'));
  assert.ok($('pmSave').disabled, 'AE1-1 은 5개까지 — 넘으면 저장 불가');
  ins[1].value = '3'; ins[2].value = '1'; ins[2].dispatchEvent(new w.Event('input'));
  assert.ok(!$('pmSave').disabled);
  assert.match($('pmSum').textContent, /합계 5 \/ 5/);
  $('pmSave').click(); await tick(60);
  const c2 = calls.filter((c) => /\/pick$/.test(c.u))[1];
  assert.deepEqual(c2.body, { product_id: 11, picks: [{ rack: 'FM-01', qty: 1 }, { rack: 'AE1-1', qty: 3 }, { rack: null, qty: 1 }] });
  assert.ok(!$('pickModal').classList.contains('on'));
  w.close();
});

test('⑤ 포장작업지시서 인쇄 — Existencia por rack · Rack real 칸', opts, async () => {
  const printed = [];
  const inStock = [{ product_id: 11, ctr_code: 'CB0257', product_name: 'Rótula', qty: 6, avail: 6, rack_location: '',
    picks: [{ rack: 'FM-01', qty: 4, kind: 'fast' }, { rack: 'AE1-3', qty: 2, kind: 'carton' }] }];
  const dom = new JSDOM(read('refatrix-quotelist.html'), { runScripts: 'dangerously', url: 'https://example.test/refatrix-quotelist.html',
    beforeParse(win) {
      win.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 't', api: 'https://api.test', user: { name: 'dir', role: 'director' } }));
      win.alert = () => {}; win.confirm = () => true;
      win.open = () => { const buf = []; return { document: { open() {}, write(h) { buf.push(h); }, close() { printed.push(buf.join('')); } } }; };
      win.fetch = async (url) => {
        const u = String(url); const json = (o) => ({ ok: true, status: 200, json: async () => o });
        if (/\/convert-preview/.test(u)) return json({ rack_stock_ready: true, counts: { in_stock: 1, shortage: 0, new_dev: 0 }, in_stock: inStock, shortage: [], new_dev: [] });
        if (/\/packing-printed$/.test(u)) return json({ packing_printed_at: '2026-10-12T15:00:00Z', packing_due_at: '2026-10-12T21:00:00Z',
          picks: { 11: inStock[0].picks }, racks_all: { 11: [{ rack: 'FM-01', qty: 9, kind: 'fast' }, { rack: 'AE1-3', qty: 15, kind: 'carton' }, { rack: 'B2-2', qty: 3, kind: 'carton' }] } });
        if (/\/api\/quotes\/\d+$/.test(u)) return json({ quote: { id: 7 }, lines: [] });
        if (/\/api\/quotes\?/.test(u)) return json({ items: [], summary: {} });
        if (/\/api\/company/.test(u)) return json({ emisor: 'Refatrix' });
        return json({});
      };
    } });
  await new Promise((r) => dom.window.addEventListener('load', r));
  const w = dom.window;
  w.session = { token: 't', user: { name: 'dir', role: 'director' }, api: 'https://api.test' };
  await w.openConvert(7, false, 'Cliente X');
  await w.printPickList();
  const doc = printed.find((x) => typeof x === 'string');
  assert.match(doc, /<th class="c-real">Rack real/);
  const allr = doc.match(/Existencia por rack: [^<]*/g) || [];
  assert.equal(allr.length, 1, '나뉜 줄 중 첫 줄에만');
  assert.equal(allr[0], 'Existencia por rack: FM-01 9 · AE1-3 15 · B2-2 3');
  assert.equal((doc.match(/<td class="c-real"><\/td>/g) || []).length, 2);
  w.close();
});
