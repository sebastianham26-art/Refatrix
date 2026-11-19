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
  assert.match(w.document.title, /ql-1119sh/);
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
        const m = u.match(/\/api\/products\/(dims|boxes)\/(preview|apply)$/);
        if (m) {
          const body = JSON.parse(o.body); posts.push({ u, body });
          const p = tableToRows(body.table, m[1] === 'boxes' ? 'box' : 'product');
          if (m[2] === 'apply') return json(m[1] === 'boxes' ? { ok: true, boxes: p.rows.length, created: 1, fields: 3, errors: p.errors }
            : { ok: true, products: p.rows.length, fields: 2, unknown: [], new_boxes: ['CAJA 3'], errors: p.errors });
          const items = p.rows.filter((r) => r.code !== 'NOPE1').map((r, i) => ({ code: r.code, name: 'X', is_new: m[1] === 'boxes' && i === 0, products: 2,
            changes: Object.entries(r.set).map(([f, v]) => ({ field: f, old: null, new: v })) }));
          return json({ ok: true, headerless: p.headerless, columns: p.columns, rows: p.rows.length, table_rows: body.table.length, dup: p.dup, errors: p.errors, same: 0,
            unknown: m[1] === 'dims' ? [{ row: 3, code: 'NOPE1' }] : undefined, items,
            new_boxes: m[1] === 'dims' ? ['CAJA 3'] : undefined, nosize_boxes: [],
            box_sizes: m[1] === 'dims' && p.box_sizes.length ? { boxes: p.box_sizes.length, changed: p.box_sizes.length, created: 0, same: 0, items: [],
              conflicts: p.box_sizes.filter((b) => b.variants.length > 1).map((b) => ({ code: b.code, used: { l: b.l, w: b.w, h: b.h }, rows: b.rows, variants: b.variants })) } : null,
            warnings: p.warnings, warning_count: p.warnings.length });
        }
        if (/\/api\/products\/dims$/.test(u)) return json({ items: [{ code: 'CB0458', name: 'Rotula', is_active: true, weight_kg: 0.85, box_code: 'CAJA 3', box_l_cm: 32, box_w_cm: 12, box_h_cm: 9, caja_l_cm: 32, caja_w_cm: 12, caja_h_cm: 9, used: 'caja', updated_at: '2026-11-18 10:00' }], stat: { total: 1, weight: 1, box: 1, own: 0, sized: 1 } });
        if (/\/api\/products\/boxes$/.test(u)) return json({ items: [
          { code: 'CAJA 3', description: 'chica', box_l_cm: 32, box_w_cm: 12, box_h_cm: 9, products: 5, in_master: true, updated_at: null },
          { code: 'LARGA', description: '', box_l_cm: null, box_w_cm: null, box_h_cm: null, products: 2, in_master: false, updated_at: null }],
          stat: { total: 2, sized: 1, nosize: 1, nosize_products: 2 } });
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
const sheet = (f) => XLSX.utils.sheet_to_json(f.wb.Sheets[f.wb.SheetNames[0]], { header: 1 });

test('③ 제품 무게 · 박스 코드 — 양식 · 현재값 · 미리보기(새 박스 안내) · 반영', opts, async () => {
  const { w, files, posts } = await bootProducts();
  const d = w.document;
  assert.match(d.title, /ps-1119sh/);
  const blk = d.getElementById('dmBlock');
  assert.ok(blk && d.getElementById('upCard').contains(blk));
  assert.equal(blk.querySelectorAll('[onclick]').length, 0);
  d.getElementById('dmTpl').click();
  assert.equal(files[0].name, 'Refatrix_Peso_Caja_Plantilla.xlsx');
  assert.deepEqual(files[0].wb.SheetNames, ['Peso y caja', '작성방법']);
  assert.deepEqual(sheet(files[0]), [['Clave CTR', 'Peso (kg)', 'Caja', 'Largo (cm)', 'Ancho (cm)', 'Alto (cm)']]);
  assert.deepEqual(tableToRows([sheet(files[0])[0], ['CB0458', 1, 'caja 1', 3, 2, 1]]).rows[0].set, { weight_kg: 1, box_code: 'CAJA 1', box_l_cm: 3, box_w_cm: 2, box_h_cm: 1 });
  d.getElementById('dmExport').click(); await new Promise((r) => setTimeout(r, 20));
  assert.match(files[1].name, /^Refatrix_Peso_Caja_\d{8}\.xlsx$/);
  const ex = sheet(files[1]);
  assert.deepEqual(ex[0], ['Clave CTR', 'Peso (kg)', 'Caja', 'Largo (cm)', 'Ancho (cm)', 'Alto (cm)', 'Producto', 'Ref. caja maestro (cm)', 'Origen medidas', 'Activo', 'Actualizado']);
  assert.deepEqual(ex[1].slice(0, 9), ['CB0458', 0.85, 'CAJA 3', 32, 12, 9, 'Rotula', '32x12x9', 'caja']);
  assert.deepEqual(tableToRows(ex).rows[0].set, { weight_kg: 0.85, box_code: 'CAJA 3', box_l_cm: 32, box_w_cm: 12, box_h_cm: 9 });   // 참고 열은 무시
  w.eval(`dmState.dm.table=[['Clave CTR','Peso (kg)','Caja'],['CB0458',0.9,'CAJA 3'],['NOPE1',1,'X'],['BAD',-1,'X']]; dmState.dm.name='t.xlsx';`);
  await w.dmPreview('dm');
  const pv = d.getElementById('dmPrev').textContent;
  assert.match(pv, /CB0458/); assert.match(pv, /NOPE1/); assert.match(pv, /BAD/);
  assert.match(pv, /박스 마스터에 아직 없는 박스 코드 1개/);
  assert.match(pv, /반영하기 \(1개 제품\)/);
  d.getElementById('dmApply').click(); await new Promise((r) => setTimeout(r, 20));
  assert.equal(posts.filter((p) => /dims\/apply$/.test(p.u)).length, 1);
  assert.match(d.getElementById('dmMsg').textContent, /반영 완료 — .*새 박스 1개 등록/);
});

test('④ 포장 박스 마스터 — 양식 · 목록(사이즈 없는 박스 맨 위 SIN MEDIDAS) · 미리보기 · 반영', opts, async () => {
  const { w, files, posts } = await bootProducts();
  const d = w.document;
  d.getElementById('bxTpl').click();
  assert.equal(files[0].name, 'Refatrix_Cajas_Plantilla.xlsx');
  assert.deepEqual(sheet(files[0]), [['Código caja', 'Largo (cm)', 'Ancho (cm)', 'Alto (cm)', 'Descripción']]);
  d.getElementById('bxExport').click(); await new Promise((r) => setTimeout(r, 20));
  const ex = sheet(files[1]);
  assert.match(files[1].name, /^Refatrix_Cajas_\d{8}\.xlsx$/);
  assert.deepEqual(ex[0], ['Código caja', 'Largo (cm)', 'Ancho (cm)', 'Alto (cm)', 'Descripción', 'Productos', 'Estado', 'Actualizado']);
  assert.equal(ex[1][0], 'LARGA'); assert.equal(ex[1][6], 'SIN MEDIDAS');
  assert.equal(ex[2][0], 'CAJA 3');
  // 목록 파일에 사이즈를 채워 그대로 올리면 읽힘
  ex[1][1] = 70; ex[1][2] = 12; ex[1][3] = 12;
  const back = tableToRows(ex, 'box');
  assert.deepEqual(back.rows[0], { row: 2, code: 'LARGA', set: { box_l_cm: 70, box_w_cm: 12, box_h_cm: 12 } });
  w.eval(`dmState.bx.table=${JSON.stringify(ex)}; dmState.bx.name='cajas.xlsx';`);
  await w.dmPreview('bx');
  const pv = d.getElementById('bxPrev').textContent;
  assert.match(pv, /LARGA/); assert.match(pv, /신규 박스/); assert.match(pv, /반영하기 \(2개 박스\)/);
  d.getElementById('bxApply').click(); await new Promise((r) => setTimeout(r, 20));
  assert.equal(posts.filter((p) => /boxes\/apply$/.test(p.u)).length, 1);
  assert.match(d.getElementById('bxMsg').textContent, /반영 완료 — 박스 2개\(신규 1\)/);
  await w.dmLoadStat();
  assert.match(d.getElementById('bxStat').textContent, /사이즈 없음 1개 \(제품 2개\)/);
});

test('⑤ 견적 툴팁 — 박스 코드 없음 · 박스 사이즈 미입력(박스 이름) 구분', opts, async () => {
  const w = await bootList();
  const t = w.shipTitle({ ...SHIP, d_miss: 3, d_nobox: 1, d_nobox_qty: 5, d_nosize: 2, d_nosize_qty: 4, nosize_boxes: ['LARGA', 'NUEVA'] });
  assert.match(t, /박스 코드 없음 1줄\(5개\)/);
  assert.match(t, /박스 사이즈 미입력 2줄\(4개\) — LARGA, NUEVA/);
});

const REAL = '/mnt/user-data/uploads/c97dcb48-master_peso_y_dimension.xlsx';
test('⑥ 공장 마스터 파일(실제 업로드 파일) — 미리보기: 박스 사이즈 다른 박스 목록 · 일부 사이즈 경고 · 반영', { ...opts, skip: opts.skip || (!fs.existsSync(REAL) && '실제 파일 없음') }, async () => {
  const { w, posts } = await bootProducts();
  const d = w.document;
  const buf = fs.readFileSync(REAL);
  const file = { name: 'master_peso_y_dimension.xlsx', arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  await w.dmReadFile('dm', file);
  const sent = posts.find((p) => /dims\/preview$/.test(p.u)).body.table;
  assert.equal(sent.length, 51439);
  assert.deepEqual(sent[0], ['NEW', 'Weight(g)', 'Inner Box 1', 'L(cm)', 'W(cm)', 'H(cm)']);
  assert.ok(JSON.stringify({ table: sent }).length < 12 * 1024 * 1024);   // 서버 bodyLimit 12MB 안
  const pv = d.getElementById('dmPrev').textContent;
  assert.match(pv, /읽은 열: 무게\(kg\) · 박스 코드 · 가로\(cm\) · 세로\(cm\) · 높이\(cm\)/);
  assert.match(pv, /파일 51439줄/);
  assert.match(pv, /박스 마스터에 함께 반영 — 파일의 박스 128개/);
  assert.match(pv, /줄마다 사이즈가 다른 박스 47개/);
  assert.match(pv, /A2 → 22\.7×17×8\.2/);
  assert.match(pv, /확인 63줄/);
  d.getElementById('dmApply').click(); await new Promise((r) => setTimeout(r, 30));
  assert.match(d.getElementById('dmMsg').textContent, /반영 완료/);
});

test('⑦ 제품찾기 목록 — 「무게 · 박스」 열 · 박스 마스터 표시 · 키트 1세트 무게', opts, async () => {
  const { w } = await bootProducts();
  const d = w.document;
  const items = [
    { id: 1, code: 'CA0005', name: 'Rotula', stock_qty: 3, is_active: true, dims: { weight_kg: 1.63, box_code: 'A2', l: 22.7, w: 17, h: 8.2, src: 'producto' } },
    { id: 2, code: 'CB0692', name: 'X', stock_qty: 1, is_active: true, dims: { weight_kg: null, box_code: 'B2', l: 15, w: 9, h: 7, src: 'caja' } },
    { id: 3, code: 'CB0700', name: 'Y', stock_qty: 1, is_active: true, dims: { weight_kg: 0.4, box_code: 'NUEVA', l: null, w: null, h: null, src: null } },
    { id: 4, code: 'CC0001', name: 'Z', stock_qty: 1, is_active: true },
    { id: 5, code: 'K0009', name: 'Kit', is_active: true, kit: { promo_no: 'K0009', buildable: 2, items: [
      { id: 1, code: 'CA0005', kit_qty: 2, stock_qty: 3, dims: { weight_kg: 1.63, box_code: 'A2', l: 22.7, w: 17, h: 8.2, src: 'producto' } },
      { id: 6, code: 'CE0001', kit_qty: 1, stock_qty: 3, dims: { weight_kg: 0.5 } }] } },
  ];
  w.fetch = async (url) => ({ ok: true, status: 200, json: async () => (/\/api\/products\?/.test(String(url)) ? { items, total: items.length, limit: 200, offset: 0 } : {}) });
  w.eval(`session.user={name:'dir',role:'director'};`);
  await w.loadProducts();
  const tb = d.querySelector('#prodList table') || [...d.querySelectorAll('table')].find((t) => /무게 · 박스/.test(t.textContent));
  assert.ok(tb, 'table');
  const heads = [...tb.querySelectorAll('thead th')].map((t) => t.textContent.replace(/[▲▼]/g, '').trim());
  const ci = heads.indexOf('무게 · 박스');
  assert.ok(ci > heads.indexOf('소재') && ci < heads.indexOf('재고'), heads.join('|'));
  const rows = [...tb.querySelectorAll('tbody tr.prow')];
  const cell = (i) => rows[i].querySelectorAll('td')[ci].textContent;
  assert.match(cell(0), /1\.63 kg/); assert.match(cell(0), /A2 · 22\.7×17×8\.2 cm/);
  assert.match(cell(1), /무게 —/); assert.match(cell(1), /B2 · 15×9×7 cm/);
  assert.ok(rows[1].querySelectorAll('td')[ci].querySelector('[title="박스 마스터 사이즈"]'));
  assert.match(cell(2), /NUEVA · 사이즈 미입력/);
  assert.equal(cell(3).trim(), '—');
  assert.match(cell(4), /≈ 3\.76 kg/); assert.match(cell(4), /1세트 · 구성품 2종/);   // 1.63×2 + 0.5
  const sub = [...tb.querySelectorAll('tbody tr.kitsub')];
  assert.equal(sub.length, 2);
  assert.equal(sub[0].querySelectorAll('td').length, rows[4].querySelectorAll('td').length - 1);   // 구성품 줄은 제품명이 2칸(colspan) — 칸 수가 본 줄과 맞음
  assert.match(sub[0].textContent, /1\.63 kg/);
});

test('⑧ 견적 입력 — 📦 대략 무게 · 사이즈(현실 적재 · 묶음 · 빠진 줄)', opts, async () => {
  const dom = new JSDOM(read('refatrix-quote.html'), {
    runScripts: 'dangerously', url: 'https://example.test/refatrix-quote.html',
    beforeParse(win) {
      win.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 't', api: 'https://api.test', user: { name: 'dir', role: 'director' } }));
      win.alert = () => {}; win.confirm = () => true;
      win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
    },
  });
  await new Promise((r) => dom.window.addEventListener('load', r));
  const w = dom.window;
  assert.match(w.document.title, /qt-1119sh/);
  const one = w.qtShipHtml({ weight_kg: 16.3, dims: { l: 46, w: 34, h: 25 }, vol_m3: 0.039, vol_weight_kg: 7.8,
    pack: { method: 'stack', boxes: 10, layers: 3, fill: 0.809, stacks: 1 }, wt_miss: 1, wt_miss_qty: 2, d_nobox: 0, d_nosize: 1, d_nosize_qty: 3, nosize_boxes: ['NUEVA'], unreg: 1 });
  const t1 = new w.DOMParser().parseFromString(one, 'text/html').body.textContent;
  assert.match(t1, /총무게 ≈ 16\.3 kg/);
  assert.match(t1, /가로 46 × 세로 34 × 높이 25 cm/);
  assert.match(t1, /박스 10개를 눕혀 3층으로 쌓은 배치 · 적재율 81%/);
  assert.match(t1, /박스 사이즈 미입력 1줄\(3개\) — NUEVA/);
  assert.match(t1, /미등록 코드 1줄/);
  const multi = w.qtShipHtml({ weight_kg: 900, dims: { l: 108, w: 84, h: 164 }, vol_m3: 7.4, vol_weight_kg: 1488,
    pack: { method: 'stack', boxes: 300, layers: 38, fill: 0.98, stacks: 2, stack_list: [{ l: 108, w: 84, h: 164 }, { l: 108, w: 84, h: 82 }] } });
  assert.match(new w.DOMParser().parseFromString(multi, 'text/html').body.textContent, /2묶음\(팔레트\) · 108×84×164 \+ 108×84×82 cm/);
  assert.equal(w.qtShipHtml(null), '');
  // 미리보기 응답에 ship 이 있으면 품목 표 아래에 표시
  w.renderLines({ lines: [{ matched: true, product_id: 1, ctr_code: 'CA0005', qty: 10, list_price: 10, discount_rate: 0, final_price: 10, line_subtotal: 100, line_iva: 16, line_total: 116, stock_flag: 'ok', avail_stock: 20, cur_stock: 20 }],
    totals: { skuCount: 1, totalQty: 10, subtotal: 100, iva: 16, total: 116 },
    ship: { weight_kg: 16.3, dims: { l: 46, w: 34, h: 25 }, vol_m3: 0.039, vol_weight_kg: 7.8, pack: { method: 'stack', boxes: 10, layers: 3, fill: 0.81, stacks: 1 } } });
  assert.ok(w.document.getElementById('qtShip'));
  assert.match(w.document.getElementById('linesWrap').textContent, /총사이즈 가로 46 × 세로 34 × 높이 25 cm/);
});

test('⑨ 견적 목록 — 묶음(팔레트) 여러 개 · 쌓은 방식 툴팁', opts, async () => {
  const w = await bootList();
  const sh = { ...SHIP, dims: { l: 108, w: 84, h: 164 }, pack: { method: 'stack', boxes: 300, layers: 38, fill: 0.98, stacks: 2, stack_list: [{ l: 108, w: 84, h: 164 }, { l: 108, w: 84, h: 82 }] } };
  const cell = w.shipCellHtml(sh);
  assert.match(cell, /2묶음 · 108×84×164 \+ 108×84×82 cm/);
  assert.match(w.shipTitle(sh), /박스 300개를 눕혀 38층으로 쌓은 배치 · 적재율 98% · 팔레트/);
  const single = w.shipCellHtml({ ...SHIP, pack: { method: 'stack', boxes: 12, layers: 3, fill: 0.9, stacks: 1 } });
  assert.match(single, /49×49×49 cm/);
});
