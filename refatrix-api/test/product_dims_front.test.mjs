// =====================================================================
// 0327 · 무게 · 박스 사이즈 — 화면 시험 (jsdom · xlsx)
//   ① 견적 목록 「무게 · 사이즈(약)」 칸 · 상세 요약 · 옛 서버(ship 없음)
//   ② 제품마스터 업로드 탭 — 양식 · 현재값 다운로드 · 미리보기 · 반영
//   실행: node --test test/product_dims_front.test.mjs
// =====================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { tableToRows } from '../src/productDims.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8').replace(/<script src="[^"]+"><\/script>/g, '');
let JSDOM; try { ({ JSDOM } = await import('jsdom')); } catch {}
let XLSX; try { XLSX = createRequire(import.meta.url)('xlsx'); } catch {}
const opts = JSDOM && XLSX ? {} : { skip: 'jsdom / xlsx 미설치' };

const SHIP = { weight_kg: 24.6, dims: { l: 49, w: 49, h: 49 }, vol_m3: 0.118, net_m3: 0.1, vol_weight_kg: 23.5,
  pcs: 12, wt_pcs: 10, d_pcs: 12, wt_miss: 1, wt_miss_qty: 2, d_miss: 0, d_miss_qty: 0, unreg: 1, unreg_qty: 3 };
const QUOTE = { id: 7, quote_no: 'Q-2026-0500', status: 'draft', quote_date: '2026-11-18', party_name: 'Taller', is_guest: false,
  subtotal_mxn: 100, iva_mxn: 16, total_mxn: 116, total_qty: 12, sku_count: 2, open: true,
  reserve_expires_at: new Date(Date.now() + 6 * 3600e3).toISOString(), packing_printed_at: null, cls: { ok: 2 }, ship: SHIP };
const LINE = { id: 1, line_no: 1, product_id: 1, ctr_code: 'CB0458', product_name: 'ROTULA', qty: 12, reserved_qty: 12, cur_stock: 20,
  live_avail: 20, live_flag: 'ok', stock_flag: 'ok', list_price: 10, discount_rate: 0, final_price: 10, line_subtotal: 120, line_iva: 19.2, line_total: 139.2 };

async function bootList(quote = QUOTE) {
  const dom = new JSDOM(read('refatrix-quotelist.html'), {
    runScripts: 'dangerously', url: 'https://example.test/refatrix-quotelist.html',
    beforeParse(win) {
      win.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 't', api: 'https://api.test', user: { name: 'dir', role: 'director' } }));
      win.alert = () => {}; win.confirm = () => true;
      win.fetch = async (url) => {
        const u = String(url); const json = (o) => ({ ok: true, status: 200, json: async () => o });
        if (/\/api\/quotes\/\d+$/.test(u)) return json({ quote, lines: [LINE], kits: [] });
        if (/\/api\/quotes\?/.test(u)) return json({ items: [] });
        return json({});
      };
    },
  });
  await new Promise((r) => dom.window.addEventListener('load', r));
  const w = dom.window;
  w.session = { token: 't', user: { name: 'dir', role: 'director' }, api: 'https://api.test' };
  return w;
}

test('① 견적 목록 — 무게 · 사이즈(약) 칸 · 자료 없는 줄 표시 · 옛 서버/가격표는 —', opts, async () => {
  const w = await bootList();
  assert.match(w.document.title, /ql-1118dm/);
  w.render([
    { ...QUOTE, id: 1, quote_no: 'Q1' },
    { ...QUOTE, id: 2, quote_no: 'Q2', ship: undefined },                      // 0327 전 서버
    { ...QUOTE, id: 3, quote_no: 'Q3', ship: { ...SHIP, wt_miss: 0, unreg: 0 } },
    { ...QUOTE, id: 4, quote_no: 'Q4', ship: { pcs: 2, nodata: true, wt_miss: 1, wt_miss_qty: 2, d_miss: 1, d_miss_qty: 2, unreg: 0 } },
    { ...QUOTE, id: 5, quote_no: 'Q5', status: 'pricelist', ship: SHIP },
  ]);
  const tb = w.document.querySelector('#listWrap table');
  const heads = [...tb.querySelectorAll('thead th')].map((t) => t.textContent);
  const ci = heads.indexOf('무게 · 사이즈(약)');
  assert.ok(ci > heads.indexOf('총수량') && ci < heads.indexOf('수주현황'));
  const cell = (n) => tb.querySelectorAll('tbody tr')[n].querySelectorAll('td')[ci];
  assert.match(cell(0).textContent, /≈ 24\.6 kg/);
  assert.match(cell(0).textContent, /49×49×49 cm/);
  assert.match(cell(0).textContent, /자료 없는 줄 2/);
  assert.match(cell(0).querySelector('span').getAttribute('title'), /무게 자료 없음 1줄\(2개\)[\s\S]*미등록 코드 1줄\(3개\)/);
  assert.equal(cell(1).textContent.trim(), '—');
  assert.doesNotMatch(cell(2).textContent, /자료 없는/);
  assert.match(cell(3).textContent, /자료 없음/);
  assert.equal(cell(4).textContent.trim(), '—');
});

test('② 견적 상세 — 📦 대략 무게 · 사이즈 요약 (가로 × 세로 × 높이)', opts, async () => {
  const w = await bootList();
  await w.openDetail(7);
  const t = w.document.getElementById('dtBody').textContent;
  assert.match(t, /📦 대략 무게 · 사이즈/);
  assert.match(t, /총무게 ≈ 24\.6 kg/);
  assert.match(t, /가로 49 × 세로 49 × 높이 49 cm/);
  assert.match(t, /부피무게 23\.5 kg/);
  const w2 = await bootList({ ...QUOTE, ship: undefined });
  await w2.openDetail(7);
  assert.doesNotMatch(w2.document.getElementById('dtBody').textContent, /대략 무게/);
});

async function bootProducts() {
  const files = []; const posts = [];
  const dom = new JSDOM(read('refatrix-products.html'), {
    runScripts: 'dangerously', url: 'https://example.test/refatrix-products.html',
    beforeParse(win) {
      win.alert = () => {}; win.confirm = () => true;
      win.fetch = async (url, o = {}) => {
        const u = String(url); const json = (b, st = 200) => ({ ok: st < 400, status: st, json: async () => b });
        if (/\/api\/products\/dims\/preview$/.test(u) || /\/api\/products\/dims\/apply$/.test(u)) {
          const body = JSON.parse(o.body); posts.push({ u, body });
          const p = tableToRows(body.table);
          if (/apply$/.test(u)) return json({ ok: true, products: p.rows.length, fields: 4, unknown: [], errors: p.errors });
          return json({ ok: true, headerless: p.headerless, columns: p.columns, rows: p.rows.length, dup: p.dup, errors: p.errors, same: 0,
            unknown: [{ row: 3, code: 'NOPE1' }],
            items: p.rows.filter((r) => r.code !== 'NOPE1').map((r) => ({ code: r.code, name: 'X', changes: Object.entries(r.set).map(([f, v]) => ({ field: f, old: null, new: v })) })) });
        }
        if (/\/api\/products\/dims$/.test(u)) return json({ items: [{ code: 'CB0458', name: 'Rotula', is_active: true, weight_kg: 0.85, box_l_cm: 32, box_w_cm: 12, box_h_cm: 9, updated_at: '2026-11-18 10:00' }], stat: { total: 1, weight: 1, dims: 1, both: 1 } });
        return json({});
      };
    },
  });
  await new Promise((r) => dom.window.addEventListener('load', r));
  const w = dom.window;
  w.eval(`session={token:'t',user:{name:'dir',role:'director'},api:'https://api.test'};`);
  w.XLSX = Object.assign({}, XLSX, { writeFile: (wb, name) => files.push({ name, wb }) });
  return { w, files, posts };
}

test('③ 제품마스터 업로드 — 📦 블록 · 양식 · 현재값 다운로드 · 미리보기 · 반영', opts, async () => {
  const { w, files, posts } = await bootProducts();
  const d = w.document;
  assert.match(d.title, /ps-1118dm/);
  const blk = d.getElementById('dmBlock');
  assert.ok(blk && d.getElementById('upCard').contains(blk));
  assert.equal(blk.querySelectorAll('[onclick]').length, 0);
  // 양식
  d.getElementById('dmTpl').click();
  assert.equal(files[0].name, 'Refatrix_Peso_Medidas_Plantilla.xlsx');
  assert.deepEqual(files[0].wb.SheetNames, ['Peso y medidas', '작성방법']);
  const head = XLSX.utils.sheet_to_json(files[0].wb.Sheets['Peso y medidas'], { header: 1 });
  assert.deepEqual(head, [['Clave CTR', 'Peso (kg)', 'Largo (cm)', 'Ancho (cm)', 'Alto (cm)']]);
  // 양식 머리글을 서버 파서가 그대로 알아듣는다
  const tp = tableToRows([head[0], ['CB0458', 1, 2, 3, 4]]);
  assert.equal(tp.headerless, false); assert.deepEqual(tp.rows[0].set, { weight_kg: 1, box_l_cm: 2, box_w_cm: 3, box_h_cm: 4 });
  // 현재값 다운로드 → 그대로 다시 올려도 읽힘(Producto · Activo 열 무시)
  await w.dmExport();
  assert.match(files[1].name, /^Refatrix_Peso_Medidas_\d{8}\.xlsx$/);
  const ex = XLSX.utils.sheet_to_json(files[1].wb.Sheets['Peso y medidas'], { header: 1 });
  assert.deepEqual(ex[1].slice(0, 5), ['CB0458', 0.85, 32, 12, 9]);
  assert.deepEqual(tableToRows(ex).rows[0].set, { weight_kg: 0.85, box_l_cm: 32, box_w_cm: 12, box_h_cm: 9 });
  // 미리보기 → 반영
  w.eval(`dmTable=[['Clave CTR','Peso (kg)','Largo (cm)','Ancho (cm)','Alto (cm)'],['CB0458',0.9,32,12,9],['NOPE1',1,1,1,1],['BAD',-1,1,1,1]]; dmName='t.xlsx';`);
  await w.dmPreview();
  const pv = d.getElementById('dmPrev').textContent;
  assert.match(pv, /CB0458/); assert.match(pv, /NOPE1/); assert.match(pv, /BAD/);
  assert.match(pv, /반영하기 \(1개 제품\)/);
  d.getElementById('dmApply').click();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(posts.filter((p) => /apply$/.test(p.u)).length, 1);
  assert.match(d.getElementById('dmMsg').textContent, /반영 완료/);
  assert.equal(d.getElementById('dmPrev').innerHTML, '');
});
