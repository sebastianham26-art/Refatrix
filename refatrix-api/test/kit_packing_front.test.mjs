// =====================================================================
// 0306 · 키트 묶음 — 화면(jsdom) 검증  2026-10-28
//   ① 창고 포장지시: 키트 머리줄(키트 번호·세트·진행·안내 — 차종 이름 없음, 키트 번호 순) → 구성품 → 「단품」, 진행 칩, 박스 카드 KIT 표시, 스캔 안내
//   ② 스페인어(창고 계정 기본): 머리줄·단품 문구가 스페인어로
//   ③ 키트 없는 오더 — 종전 표 그대로(머리줄 없음)
//   ④ Lista de empaque: 「Kits incluidos」 + 박스 안 KIT 머리줄 · Piezas sueltas
//   ⑤ 포장작업지시서(PDF, 견적목록): 「Kits en este pedido」 + 줄마다 KIT 표시 · 랙 경로 순서 유지
//   ⑥ 견적목록 편집: kit_no 유지, 코드를 바꾼 줄은 키트에서 뺀다
//   실행: node --test test/kit_packing_front.test.mjs   (jsdom 필요)
// =====================================================================
import test, { after } from 'node:test';
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
const DOMS = [];   // 화면 타이머가 남아 프로세스가 끝나지 않으므로 마지막에 닫는다
after(() => { DOMS.forEach((d) => { try { d.window.close(); } catch (_) {} }); });

const it = (pid, code, req, sc, kit, rack) => ({ product_id: pid, ctr_code: code, syd_code: 'S' + pid, ean: 'E' + pid, required: req, scanned: sc, remaining: Math.max(0, req - sc),
  box_nos: sc ? [1] : [], rack_location: rack + ' ×' + req, rack_picks: rack + ' ×' + req, picks: [{ rack, qty: req, kind: 'carton' }], picked: false, picked_by_name: '',
  racks_all: [{ rack, qty: 20, kind: 'carton' }], line_no: pid, kit_no: kit });
const KITS = [
  { kit_no: 'K0009', title: 'Nissan Versa', years: '2012-2019', sets: 1, consistent: true, sku: 4, pieces: 5, partial: false },
  { kit_no: 'K0012', title: 'Nissan Sentra', years: '2013-2019', sets: 1, consistent: false, sku: 2, pieces: 2, partial: false },
];
const PACK = (withKits = true) => ({ quote_id: 358, quote_no: 'Q-2026-0339', customer: 'Dante Fernandez', elapsed_biz_sec: 0, required_total: 14, scanned_total: 2, all_done: false, photos_ok: false,
  boxes: [{ box_id: 1, box_no: 1, sealed: false, photo_count: 0, lines: [{ product_id: 219, ctr_code: 'CE0536L', syd_code: '', ean: '', qty: 1 }, { product_id: 220, ctr_code: 'CE0536R', syd_code: '', ean: '', qty: 1 }] }],
  items: [
    it(1697, 'PRO002', 5, 0, null, 'E3-1'),
    it(219, 'CE0536L', 1, 1, withKits ? 'K0009' : null, 'C2-4'), it(220, 'CE0536R', 1, 1, withKits ? 'K0009' : null, 'C2-4'),
    it(702, 'CR0490', 2, 0, withKits ? 'K0009' : null, 'AD4-2'), it(396, 'CL0477', 1, 0, withKits ? 'K0009' : null, 'C2-2'),
    it(506, 'CQ0285L', 1, 0, withKits ? 'K0012' : null, 'AD6-2'), it(507, 'CQ0285R', 1, 0, withKits ? 'K0012' : null, 'AD6-2'),
    it(1707, 'PRO012', 2, 0, null, 'E3-1')],
  kits: withKits ? KITS : [] });

async function bootWh(lang, pack, extra) {
  const printed = []; const calls = [];
  const dom = new JSDOM(read('refatrix-warehouse.html'), { runScripts: 'dangerously', url: 'https://example.test/refatrix-warehouse.html',
    beforeParse(win) {
      win.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 't', api: 'https://api.test', user: { name: 'u', role: 'warehouse' } }));
      win.localStorage.setItem('wh_lang', lang);
      win.HTMLMediaElement && (win.HTMLMediaElement.prototype.play = () => Promise.resolve());
      win.AudioContext = undefined; win.webkitAudioContext = undefined;
      win.alert = (m) => printed.push({ alert: String(m) });
      win.open = () => { const buf = []; return { document: { open() {}, write(h) { buf.push(h); }, close() { printed.push(buf.join('')); } }, focus() {}, print() {} }; };
      win.fetch = async (url, init) => {
        const u = String(url); const body = init && init.body ? JSON.parse(init.body) : null;
        calls.push({ u, body });
        const json = (o, st = 200) => ({ ok: st < 400, status: st, json: async () => o });
        const h = extra && extra(u, body, json); if (h) return h;
        if (/\/packing\/358\/photos/.test(u)) return json({ photos: [] });
        if (/\/packing\/358$/.test(u)) return json(pack);
        if (/packing-queue$/.test(u)) return json({ count: 1, in_business: false, items: [{ quote_id: 358, quote_no: 'Q-2026-0339', customer: 'Dante Fernandez', printed_at: '2026-10-28T21:04:00Z', elapsed_biz_sec: 0, total_qty: 14, packed_qty: 2 }] });
        if (/ship-queue/.test(u)) return json({ count: 1, items: [{ quote_id: 358, quote_no: 'Q-2026-0339', customer: 'Dante Fernandez', sat_no: 'A1', has_sat: true, box_count: 1, total_qty: 9, sku_count: 5, inv_date: '2026-10-29' }] });
        if (/\/api\/company/.test(u)) return json({ emisor: 'Refatrix' });
        return json({});
      };
    } });
  DOMS.push(dom);
  await new Promise((r) => dom.window.addEventListener('load', r));
  await tick(80);
  dom.__printed = printed; dom.__calls = calls;
  return dom;
}
const open358 = async (dom) => { dom.window.document.getElementById('queue').querySelector('.qcard[data-id="358"]').click(); await tick(100); };
const text = (el) => el.textContent.replace(/\s+/g, ' ').trim();

test('① 포장지시 — 키트 머리줄 → 구성품 → 단품, 진행 칩 · 박스 카드 · 스캔 안내', opts, async () => {
  const dom = await bootWh('ko', PACK(), (u, b, json) => (/\/scan$/.test(u)
    ? json({ result: 'ok', product_id: 702, ctr_code: 'CR0490', box_no: 1, remaining: 1, scanned_total: 3, required_total: 14, all_done: false }) : null));
  await open358(dom);
  const w = dom.window, $ = (id) => w.document.getElementById(id);
  const rows = [...$('remBody').querySelectorAll('tr')];
  const shape = rows.map((r) => (r.classList.contains('kith') ? 'H:' + r.querySelector('.kno').textContent : r.classList.contains('singh') ? 'S' : (r.classList.contains('kitr') ? 'k:' : 'r:') + r.cells[0].textContent));
  assert.deepEqual(shape, ['H:KIT K0009', 'k:CE0536L', 'k:CE0536R', 'k:CL0477', 'k:CR0490', 'H:KIT K0012', 'k:CQ0285L', 'k:CQ0285R', 'S', 'r:PRO002', 'r:PRO012']);
  const h1 = text(rows[0]);
  assert.match(h1, /2 \/ 5/, '진행 = 포장한/포장할(키트 줄만)');
  assert.match(h1, /KIT K0009 1세트 · 4 SKU 5개/);
  assert.ok(!/Nissan|Versa/.test(text(w.document.getElementById('remBody'))), '차종 이름으로 묶지 않는다');
  assert.match(h1, /한 봉투에 함께 담고 같은 박스에/);
  assert.match(text(rows[5]), /구성 수량이 키트와 다릅니다/, 'consistent=false → 경고');
  assert.match(text(rows[8]), /단품 · 2 SKU 7개/);
  // 모든 열(9칸) 그대로 — 지시서대로 버튼도 각 줄에
  assert.equal(rows[1].cells.length, 9);
  assert.ok(rows[1].querySelector('[data-pk="plan"]'));
  // 진행 칩
  assert.deepEqual([...$('pProg').querySelectorAll('.kitchip')].map(text), ['🧰 K0009 2/5', '🧰 K0012 0/2']);
  // 박스 카드: 키트 부품에 KIT 태그
  assert.match($('boxGrid').innerHTML, /CE0536L<span class="kittag">🧰 K0009<\/span>/);
  // 정렬을 바꿔도 묶음은 유지(묶음 안에서만 정렬)
  $('itemsHead').querySelector('th[data-k="required"]').click(); await tick(20);
  const after = [...$('remBody').querySelectorAll('tr')].map((r) => r.classList.contains('kith') ? 'H' : r.classList.contains('singh') ? 'S' : r.cells[0].textContent);
  assert.deepEqual(after.slice(0, 1).concat(after.slice(5, 6), after.slice(8, 9)), ['H', 'H', 'S']);
  // 스캔 안내에 KIT 표시
  const inp = $('eanInput'); inp.value = '8806199141829';
  inp.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick(80);
  const fb = text(w.document.body);
  assert.match(fb, /✓ CR0490 · 🧰 KIT K0009 → Box 1/);
});

test('② 스페인어 — 머리줄·단품 문구', opts, async () => {
  const dom = await bootWh('es', PACK());
  await open358(dom);
  const $ = (id) => dom.window.document.getElementById(id);
  const rows = [...$('remBody').querySelectorAll('tr')];
  assert.match(text(rows[0]), /KIT K0009 1 juego · 4 SKU · 5 pzs/);
  assert.match(text(rows[0]), /Empacar juntas en una bolsa · misma caja/);
  assert.match(text(rows[5]), /Cantidades distintas a la composición del kit/);
  assert.match(text(rows[8]), /Piezas sueltas · 2 SKU · 7 pzs/);
});

test('③ 키트 없는 오더 — 머리줄 없이 종전 표', opts, async () => {
  const dom = await bootWh('ko', PACK(false));
  await open358(dom);
  const $ = (id) => dom.window.document.getElementById(id);
  const rows = [...$('remBody').querySelectorAll('tr')];
  assert.equal(rows.length, 8);
  assert.ok(rows.every((r) => !r.classList.contains('kith') && !r.classList.contains('kitr') && !r.classList.contains('singh')));
  assert.equal($('pProg').querySelector('.kitbar'), null);
});

test('④ Lista de empaque — Kits incluidos + 박스 안 KIT 머리줄 · Piezas sueltas', opts, async () => {
  const ship = { quote_id: 358, quote_no: 'Q-2026-0339', customer: 'Dante Fernandez', sat_no: 'A1', has_sat: true, packed_at: '2026-10-29T15:00:00Z', box_count: 1, total_qty: 10, sku_count: 5,
    boxes: [{ box_id: 1, box_no: 1, box_qty: 10, box_sku: 5, lines: [
      { ctr_code: 'PRO002', syd_code: '', ean: '', qty: 5, kit_no: null },
      { ctr_code: 'CE0536L', syd_code: '1116025', ean: '', qty: 1, kit_no: 'K0009' }, { ctr_code: 'CE0536R', syd_code: '', ean: '', qty: 1, kit_no: 'K0009' },
      { ctr_code: 'CR0490', syd_code: '', ean: '', qty: 2, kit_no: 'K0009' }, { ctr_code: 'CL0477', syd_code: '', ean: '', qty: 1, kit_no: 'K0009' }] }],
    kits: [{ kit_no: 'K0009', title: 'Nissan Versa', years: '2012-2019', sets: 1, consistent: true, items: [{ ctr_code: 'CE0536L', qty: 1 }, { ctr_code: 'CE0536R', qty: 1 }, { ctr_code: 'CR0490', qty: 2 }, { ctr_code: 'CL0477', qty: 1 }] }] };
  const dom = await bootWh('ko', PACK(), (u, b, json) => (/\/ship\/358$/.test(u) ? json(ship) : null));
  const btn = dom.window.document.querySelector('.scard .pk[data-id="358"]');
  assert.ok(btn, '출고 대기 카드의 패킹리스트 버튼');
  btn.click(); await tick(120);
  const doc = dom.__printed.find((x) => typeof x === 'string');
  assert.ok(doc, JSON.stringify(dom.__printed));
  assert.match(doc, /Kits incluidos \(1\)/);
  assert.match(doc, /<td><b>K0009<\/b><\/td><td class="q">1<\/td><td>CE0536L, CE0536R, CR0490 ×2, CL0477<\/td>/);
  assert.ok(!/Nissan|Versa/.test(doc), '차종 이름 없음');
  const box = doc.slice(doc.indexOf('Caja 1'), doc.indexOf('</table>', doc.indexOf('Caja 1')));
  const order = [...box.matchAll(/<tr( class="(kh|kl|sh)")?><td[^>]*>([^<]*)/g)].map((m) => (m[2] || 'r') + ':' + m[3]);
  assert.deepEqual(order, ['kh:KIT K0009 · 1 juego · 5 pzas', 'kl:1', 'kl:2', 'kl:3', 'kl:4', 'sh:Piezas sueltas', 'r:5']);
  assert.equal((doc.match(/LISTA DE EMPAQUE/g) || []).length, 2, '원본·사본 두 장 그대로');
});

// ---------- 견적목록(포장작업지시서 PDF · 편집) ----------
async function bootQl(inStock, kits, lines) {
  const printed = []; const calls = [];
  const dom = new JSDOM(read('refatrix-quotelist.html'), { runScripts: 'dangerously', url: 'https://example.test/refatrix-quotelist.html',
    beforeParse(win) {
      win.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 't', api: 'https://api.test', user: { name: 'dir', role: 'director' } }));
      win.alert = (m) => printed.push({ alert: String(m) }); win.confirm = () => true;
      win.open = () => { const buf = []; return { document: { open() {}, write(h) { buf.push(h); }, close() { printed.push(buf.join('')); } } }; };
      win.fetch = async (url, init) => {
        const u = String(url); calls.push({ u, method: (init && init.method) || 'GET', body: init && init.body ? JSON.parse(init.body) : null });
        const json = (o) => ({ ok: true, status: 200, json: async () => o });
        if (/\/convert-preview/.test(u)) return json({ is_guest: false, already: false, counts: { in_stock: inStock.length, shortage: 0, new_dev: 0 }, in_stock: inStock, shortage: [], new_dev: [], kits });
        if (/\/packing-doc$/.test(u)) return json({ has: false });
        if (/\/packing-printed$/.test(u)) return json({ packing_printed_at: '2026-10-28T21:04:00Z', packing_due_at: '2026-10-29T17:34:00Z' });
        if (/\/api\/quotes\/\d+$/.test(u) && (!init || !init.method || init.method === 'GET')) return json({ quote: { id: 358, customer_id: 141, quote_no: 'Q-2026-0339', status: 'draft' }, lines: lines || inStock.map((x) => ({ ctr_code: x.ctr_code, syd_codes: '' })) });
        if (/\/api\/quotes\/\d+$/.test(u)) return json({ ok: true });
        if (/\/api\/quotes\?/.test(u)) return json({ items: [], summary: {} });
        if (/\/api\/quotes\/counts/.test(u)) return json({ open: 0, guest_pending: 0, delete_pending: 0 });
        if (/\/api\/company/.test(u)) return json({ emisor: 'Refatrix' });
        if (/\/api\/auth\/(login|me)/.test(u)) return json({ token: 't', user: { name: 'dir', role: 'director' }, perm: {} });
        return json({});
      };
    } });
  DOMS.push(dom);
  await new Promise((r) => dom.window.addEventListener('load', r));
  const w = dom.window;
  w.session = { token: 't', user: { name: 'dir', role: 'director' }, api: 'https://api.test' };
  w.isDirector = true;
  dom.__printed = printed; dom.__calls = calls;
  return dom;
}
const S = (pid, code, rack, qty, kit) => ({ product_id: pid, ctr_code: code, product_name: 'Prod ' + code, qty, avail: qty, rack_location: rack,
  picks: [{ rack, qty, kind: 'carton' }], racks_all: [{ rack, qty: 20 }], kit_no: kit || null });

test('⑤ 포장작업지시서(PDF) — Kits en este pedido + 줄마다 KIT, 랙 경로 순서는 그대로', opts, async () => {
  const inStock = [S(219, 'CE0536L', 'C2-4', 1, 'K0009'), S(702, 'CR0490', 'AD4-2', 2, 'K0009'), S(1697, 'PRO002', 'E3-1', 5)];
  const kits = [{ kit_no: 'K0009', title: 'Nissan Versa', years: '2012-2019', sets: 1, consistent: true, items: [{ ctr_code: 'CE0536L', qty: 1 }, { ctr_code: 'CR0490', qty: 2 }] }];
  const dom = await bootQl(inStock, kits);
  await dom.window.openConvert(358, false, 'Dante Fernandez');
  dom.__printed.length = 0;
  await dom.window.printPickList();
  const doc = dom.__printed.find((x) => typeof x === 'string');
  assert.ok(doc, JSON.stringify(dom.__printed));
  assert.match(doc, /Kits en este pedido \(1\) — empacar juntas las piezas de cada kit: misma bolsa, misma caja/);
  assert.match(doc, /<td><b>K0009<\/b><\/td><td style="text-align:center">1<\/td><td>CE0536L, CR0490 ×2<\/td>/);
  assert.ok(!/Nissan|Versa/.test(doc), '차종 이름 없음');
  const skus = [...doc.matchAll(/<td class="c-sku">([^<]*)<\/td>/g)].map((m) => m[1]);
  assert.deepEqual(skus, ['CR0490', 'CE0536L', 'PRO002'], '랙 순서(AD4-2 → C2-4 → E3-1) 유지');
  assert.match(doc, /<td class="c-name"><span class="kit">KIT K0009<\/span>Prod CR0490/);
  assert.match(doc, /<td class="c-name">Prod PRO002/, '단품은 표시 없음');
  // 키트 없는 오더는 블록 자체가 없다
  const dom2 = await bootQl([S(1697, 'PRO002', 'E3-1', 5)], []);
  await dom2.window.openConvert(358, false, 'X'); dom2.__printed.length = 0;
  await dom2.window.printPickList();
  const doc2 = dom2.__printed.find((x) => typeof x === 'string');
  assert.ok(!/Kits en este pedido/.test(doc2) && !/class="kit"/.test(doc2));
});

test('⑤-2 포장작업지시서 — 줄 높이 어림으로 나누고, 새 창에서 넘치는 줄은 다음 장으로(아래 잘림 없음)', opts, async () => {
  // (a) 짧은 줄 30개 + 키트 1개 → 1장 19줄(22 − 2.2 − 0.65) · 2장 11줄, 번호 이어짐
  const inStock = Array.from({ length: 30 }, (_, i) => S(100 + i, 'P' + String(i).padStart(2, '0'), 'A' + String(i).padStart(2, '0'), 1, i < 2 ? 'K0001' : null));
  const kits = [{ kit_no: 'K0001', sets: 1, consistent: true, items: [{ ctr_code: 'P00', qty: 1 }, { ctr_code: 'P01', qty: 1 }] }];
  const dom = await bootQl(inStock, kits);
  await dom.window.openConvert(358, false, 'X'); dom.__printed.length = 0;
  await dom.window.printPickList();
  const doc = dom.__printed.find((x) => typeof x === 'string');
  const pages = doc.split('<div class="page">').slice(1);
  assert.equal(pages.length, 2);
  assert.equal((pages[0].match(/<td class="c-sku">/g) || []).length, 19);
  assert.equal((pages[1].match(/<td class="c-sku">/g) || []).length, 11);
  assert.match(pages[1], /<td class="c-no">20<\/td>/, '번호는 이어서');
  assert.match(pages[0], /Página <b>1<\/b> de 2/);
  assert.match(doc, /\.page\{width:210mm;height:296mm;[^}]*overflow:hidden/, '장 높이 고정(넘치면 다음 장으로)');
  assert.ok(!/min-height:auto/.test(doc), '인쇄 때 높이를 풀지 않는다(풀면 아래가 잘린다)');
  // (b) 긴 품명 + 랙별 재고 줄이 붙은 행은 더 높게 센다 → 같은 18줄이라도 2장
  const tall = Array.from({ length: 18 }, (_, i) => Object.assign(S(200 + i, 'T' + i, 'B' + String(i).padStart(2, '0'), 1),
    { product_name: 'material promocion_ETIQUETA_CTR (HIZO EN CASA MATRIZ) ' + i, racks_all: [{ rack: 'B01', qty: 5 }, { rack: 'AE3-1', qty: 12 }, { rack: 'AD6-5', qty: 24 }] }));
  const dom2 = await bootQl(tall, []);
  await dom2.window.openConvert(358, false, 'X'); dom2.__printed.length = 0;
  await dom2.window.printPickList();
  const doc2 = dom2.__printed.find((x) => typeof x === 'string');
  assert.ok(doc2.split('<div class="page">').length - 1 >= 2, '높은 줄 18개는 한 장에 넣지 않는다');
  // (c) 새 창 스크립트: 실제 높이가 넘치면 마지막 줄을 다음 장으로 밀고 장 번호를 다시 매긴다
  const pdom = new JSDOM(doc, { runScripts: 'dangerously', beforeParse(win) {
    Object.defineProperty(win.HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return this.classList && this.classList.contains('pk-body') ? this.querySelectorAll('tbody tr').length * 30 : 0; } });
    Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return this.classList && this.classList.contains('pk-body') ? 300 : 0; } });
  } });
  DOMS.push(pdom);
  await tick(30);
  const pg = [...pdom.window.document.querySelectorAll('.page')];
  assert.deepEqual(pg.map((p) => p.querySelectorAll('.pk-tbl tbody tr').length), [10, 10, 10], '장마다 들어가는 만큼만');
  assert.equal(pg[2].querySelector('.pk-kits'), null, '키트 표는 1장에만');
  assert.match(pg[2].querySelector('.pk-pg').textContent, /Página 3 de 3/);
  assert.equal(pdom.window.document.getElementById('pgCount').textContent, '3');
  const seqs = pg.flatMap((p) => [...p.querySelectorAll('td.c-no')].map((td) => Number(td.textContent)));
  assert.deepEqual(seqs, Array.from({ length: 30 }, (_, i) => i + 1), '순서 그대로');
  // (d) 어림이 보수적이어서 남는 자리는 다음 장 줄로 채운다(장 수 최소) — 한 장에 25줄 들어가는 경우 19+11 → 25+5
  const cdom = new JSDOM(doc, { runScripts: 'dangerously', beforeParse(win) {
    Object.defineProperty(win.HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return this.classList && this.classList.contains('pk-body') ? this.querySelectorAll('tbody tr').length * 12 : 0; } });
    Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return this.classList && this.classList.contains('pk-body') ? 300 : 0; } });
  } });
  DOMS.push(cdom);
  await tick(30);
  const cp = [...cdom.window.document.querySelectorAll('.page')];
  assert.deepEqual(cp.map((p) => p.querySelectorAll('.pk-tbl tbody tr').length), [25, 5]);
  assert.match(cp[1].querySelector('.pk-pg').textContent, /Página 2 de 2/);
  // (e) 다 들어가면 2장째는 지운다
  const edom = new JSDOM(doc, { runScripts: 'dangerously', beforeParse(win) {
    Object.defineProperty(win.HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return this.classList && this.classList.contains('pk-body') ? this.querySelectorAll('tbody tr').length * 5 : 0; } });
    Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return this.classList && this.classList.contains('pk-body') ? 300 : 0; } });
  } });
  DOMS.push(edom);
  await tick(30);
  assert.equal(edom.window.document.querySelectorAll('.page').length, 1);
  assert.match(edom.window.document.querySelector('.pk-pg').textContent, /Página 1 de 1/);
  assert.equal(edom.window.document.getElementById('pgCount').textContent, '1');
});

test('⑥ 견적목록 편집 — kit_no 유지, 코드를 바꾼 줄은 키트에서 뺀다', opts, async () => {
  const lines = [
    { ctr_code: 'CE0536L', input_code: 'CE0536L', qty: 1, product_name: 'T', kit_no: 'K0009' },
    { ctr_code: 'CR0490', input_code: 'CR0490', qty: 2, product_name: 'T', kit_no: 'K0009' },
    { ctr_code: 'PRO002', input_code: 'PRO002', qty: 5, product_name: 'P', kit_no: null }];
  const dom = await bootQl([], [], lines);
  const w = dom.window;
  // 상세 → 편집 상태를 화면 함수로 만든다
  w.eval(`dtId=358; dtData=${JSON.stringify({ quote: { id: 358, customer_id: 141, memo: null }, lines })}; dtEdit=true;`);
  try { w.renderDetail && w.renderDetail(); } catch (_) {}
  w.eval('if(!dtData._edit){ dtData._edit=null; }');
  try { w.renderEdit(); } catch (_) {}
  assert.deepEqual(w.eval('JSON.stringify(dtData._edit.map(e=>e.kit_no))'), JSON.stringify(['K0009', 'K0009', null]));
  w.edSet(1, 'input_code', 'CR0491');
  w.edSet(0, 'qty', '2');
  await w.saveEdit(); await tick(30);
  const put = dom.__calls.find((c) => c.method === 'PUT');
  assert.ok(put, 'PUT 호출');
  assert.deepEqual(put.body.lines, [{ code: 'CE0536L', qty: 2, kit_no: 'K0009' }, { code: 'CR0491', qty: 2 }, { code: 'PRO002', qty: 5 }]);
});
