// =====================================================================
// 2026-11-05 avl · Q-2026-0354 — 화면(jsdom) 검증
//   ① 견적목록 › 매출전환 › 포장작업지시서: 부분 확보 줄(GV 5/8)이 「PARCIAL」 로 확보분만 찍힌다 + KIT INCOMPLETO
//   ② 구버전 서버 응답(pick_items 없음) — 종전처럼 in_stock 만
//   ③ 견적 작성: 가용 칸에 「재고 7 − 타 견적 예약 2 (Q-…)」, 저장 직후 「재고 확보 부족」 안내
//   실행: node --test test/quote_avail_partial_front.test.mjs   (jsdom 필요)
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
const DOMS = [];
after(() => { DOMS.forEach((d) => { try { d.window.close(); } catch (_) {} }); });
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

const CB = { product_id: 1, ctr_code: 'CB0455L', product_name: 'RÓTULA', qty: 2, avail: 2, rack_location: 'A-1-1', kit_no: 'K0034' };
const GVp = { product_id: 2, ctr_code: 'GV0803', product_name: 'BUJE', qty: 5, requested: 8, short: 3, partial: true, avail: 5, rack_location: 'B-2-2', kit_no: 'K0034' };
const PV_NEW = {
  is_guest: false, already: false, counts: { in_stock: 1, shortage: 1, new_dev: 0, partial: 1 },
  in_stock: [CB], shortage: [{ product_id: 2, ctr_code: 'GV0803', product_name: 'BUJE', qty: 8, avail: 5, fulfill: 5, short: 3, kit_no: 'K0034' }],
  new_dev: [], pick_items: [CB, GVp],
  kits: [{ kit_no: 'K0034', title: 'Volkswagen Jetta', years: '1998-2015', sets: 2, consistent: true, items: [{ ctr_code: 'CB0455L', qty: 1 }, { ctr_code: 'GV0803', qty: 4 }] }],
};

async function bootList(pv) {
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
        if (/\/convert-preview/.test(u)) return json(pv);
        if (/\/packing-doc$/.test(u)) return json({ has: false });
        if (/\/packing-printed$/.test(u)) return json({ packing_printed_at: '2026-11-04T22:26:59Z', packing_due_at: '2026-11-05T15:00:00Z' });
        if (/\/api\/quotes\/\d+$/.test(u)) return json({ quote: { id: 7 }, lines: [] });
        if (/\/api\/quotes\?/.test(u)) return json({ items: [], summary: {} });
        if (/\/api\/quotes\/counts/.test(u)) return json({ open: 0, guest_pending: 0, delete_pending: 0 });
        if (/\/api\/company/.test(u)) return json({ emisor: 'Refatrix' });
        if (/\/api\/auth\/(login|me)/.test(u)) return json({ token: 't', user: { name: 'dir', role: 'director' }, perm: {} });
        return json({});
      };
    },
  });
  DOMS.push(dom);
  await new Promise((r) => dom.window.addEventListener('load', r));
  const w = dom.window;
  w.session = { token: 't', user: { name: 'dir', role: 'director' }, api: 'https://api.test' };
  w.isDirector = true;
  await w.openConvert(7, false, 'ALCALA');
  dom.__printed = printed;
  return dom;
}
const skus = (doc) => [...doc.matchAll(/<td class="c-sku">([\s\S]*?)<\/td>[\s\S]*?<td class="c-qty">([\s\S]*?)<\/td>/g)].map((m) => `${m[1]}:${m[2]}`);

test('① 포장작업지시서 — 부분 확보 GV0803 이 5개 · PARCIAL · KIT INCOMPLETO', opts, async () => {
  const dom = await bootList(PV_NEW);
  assert.match(dom.window.document.title, /ql-1105avl/);
  const pvHtml = dom.window.document.getElementById('cvPreview').innerHTML;
  assert.match(pvHtml, /지시서에 5개 포함/, '전환 미리보기에도 포함 표시');
  assert.match(pvHtml, /부분 출고 1개 SKU/);
  await dom.window.printPickList();
  const doc = dom.__printed.find((x) => typeof x === 'string');
  assert.ok(doc, JSON.stringify(dom.__printed));
  assert.deepEqual(skus(doc).sort(), ['CB0455L:2', 'GV0803:5']);
  assert.match(doc, /PARCIAL · surtir sólo 5 · faltan 3/);
  assert.match(doc, /KIT INCOMPLETO — falta: GV0803 3/);
  assert.match(doc, /Piezas totales<\/span><span class="v">7</);
});

test('② 구버전 응답(pick_items 없음) — 종전처럼 in_stock 만', opts, async () => {
  const old = { ...PV_NEW, pick_items: undefined, counts: { in_stock: 1, shortage: 1, new_dev: 0 } };
  delete old.pick_items;
  const dom = await bootList(old);
  await dom.window.printPickList();
  const doc = dom.__printed.find((x) => typeof x === 'string');
  assert.deepEqual(skus(doc), ['CB0455L:2']);
  assert.doesNotMatch(doc, /PARCIAL/);
});

test('③ 견적 작성 — 가용 칸 근거 · 저장 직후 확보 부족 안내', opts, async () => {
  const html = read('refatrix-quote.html');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.test/refatrix-quote.html' });
  DOMS.push(dom);
  // availCell 만 꺼내 실행(운영 파일의 함수 그대로)
  const src = html.match(/const fmtq=[^\n]*\n[\s\S]*?function availCell\(l\)\{[\s\S]*?\n  \}\n/)[0];
  dom.window.eval('function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",\'"\':"&quot;"}[c]));}\n' + src + '\nwindow.availCell=availCell;');
  const cell = dom.window.availCell({ qty: 8, avail_stock: 5, stock_flag: 'low_stock', cur_stock: 7, reserved_other: 2,
    reserved_holders: [{ quote_no: 'Q-2026-0353', qty: 2 }], used_in_quote: 0, incoming_qty: 204, backorder_qty: 192 });
  assert.match(cell, /^5</);
  assert.match(cell, /부족 3/);
  assert.match(cell, /재고 7 − 타 견적 예약 2 \(Q-2026-0353 2\)/);
  const plain = dom.window.availCell({ qty: 2, avail_stock: 30, stock_flag: 'ok', cur_stock: 30, reserved_other: 0, used_in_quote: 0 });
  assert.doesNotMatch(plain, /타 견적/, '예약 없으면 근거 줄 없음');
  assert.match(html, /재고 확보 부족 '\+shl\.length\+'개 SKU/, '저장 메시지');
  assert.match(html, /<title>[^<]*qt-1105avl<\/title>/);
});
