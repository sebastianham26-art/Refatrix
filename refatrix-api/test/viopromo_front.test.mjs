// =====================================================================
// VIO 제품찾기·프로모션 화면 (jsdom · build vf16y · 2026-10-22) — 운영 HTML 을 그대로 띄우고 fetch·canvas 만 스텁
//   대기열(VIO 순 · 재고 품목 수) · 품목 넣기/빼기(재고 자동 + 손) · 이미지 뱅크 저장 · WhatsApp 발송 본문 · 예전 차종별 부품 주소
//   실행: node --test test/viopromo_front.test.mjs   (jsdom 필요)
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..', '..');
const HTML = resolve(ROOT, 'refatrix-viofinder.html');
const COVER = resolve(ROOT, 'mx_parts_coverage_dashboard.html');
let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* skip */ }
const SKIP = !JSDOM || !existsSync(HTML) || !existsSync(COVER);
const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch {} await tick(40); } return false; }

const LP = { CB0336: 291, CE0536L: 448, CE0536R: 448, CQ0280L: 1333, CQ0280R: 1333, CL0477: 343, PL0477: 1898.88 };   // GV1043 = 가격 없음
const it = (ctr, name, stock, year = '2012-2019') => ({ ctr, syd: ['1' + ctr.slice(-4)], name, year, stock, sold: 3, sold_by: [], lp_syd: 500, lp: LP[ctr] ?? null });
function byModel(q) {
  const term = q.split('||')[0]; const vk = term;
  const versa = /versa/i.test(term);
  const cats = [
    ['rotula', [it('CB0336', 'RÓTULA', 12)]],
    ['terminal_ext', [it('CE0536L', 'TERMINAL EXTERIOR', 8), it('CE0536R', 'TERMINAL EXTERIOR', 0)]],
    ['horquilla', [it('CQ0280L', 'HORQUILLA IZQ', 6), it('CQ0280R', 'HORQUILLA DER', 6)]],
    ['tornillo', [it('CL0477', 'TORNILLO ESTABILIZADOR', 4), it('PL0477', 'HYBRID STABILIZER LINK', 0)]],
    ['buje', [it('GV1043', 'BUJE', 2, '2020-2024')]],
  ].slice(0, versa ? 5 : 2);   // Versa 만 5품목, 나머지는 2품목(후보 기준 3 미만)
  return { query: term, variants: [{ key: vk, model: vk, years: '2012-2024' }], categories: cats.map(([key, v]) => ({ key, es: key, ko: '', cells: { [vk]: v } })), total: 8, price_included: true };
}

function canvasStub(w) {
  const grad = { addColorStop() {} };
  const ctx = new Proxy({}, { get(t, k) {
    if (k in t) return t[k];
    if (k === 'measureText') return (s) => ({ width: String(s).length * 12 });
    if (k === 'getImageData') return (x, y, a, b) => ({ data: new Uint8ClampedArray(Math.max(4, a * b * 4)) });
    if (/^create(Linear|Radial)Gradient$/.test(k)) return () => grad;
    return () => {};
  }, set(t, k, v) { t[k] = v; return true; } });
  w.HTMLCanvasElement.prototype.getContext = function () { return ctx; };
  w.HTMLCanvasElement.prototype.toBlob = function (cb, type) { cb(new w.Blob(['jpegdata'], { type: type || 'image/png' })); };
  w.HTMLCanvasElement.prototype.toDataURL = function () { return 'data:image/png;base64,AA=='; };
}

function boot(url = 'https://example.test/refatrix-viofinder.html') {
  const calls = [];
  const dom = new JSDOM(readFileSync(HTML, 'utf-8'), {
    runScripts: 'dangerously', url, pretendToBeVisual: true,
    beforeParse(w) {
      w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 'T', api: 'https://api.test', user: { name: 'U', role: 'director' } }));
      w.alert = () => {}; w.confirm = () => true; w.scrollTo = () => {}; w.open = () => null;
      w.URL.createObjectURL = () => 'blob:x';
      canvasStub(w);
      // 이미지는 바로 「불러옴」
      Object.defineProperty(w.HTMLImageElement.prototype, 'src', { set(v) { this._src = v; setTimeout(() => { Object.defineProperty(this, 'naturalWidth', { value: 600, configurable: true }); Object.defineProperty(this, 'naturalHeight', { value: 400, configurable: true }); this.onload && this.onload(); }, 0); }, get() { return this._src; }, configurable: true });
      w.fetch = async (u0, opt = {}) => {
        const u = String(u0); const method = opt.method || 'GET'; const body = opt.body ? JSON.parse(opt.body) : null;
        calls.push({ u, method, body });
        const json = (d, s = 200) => ({ ok: s < 400, status: s, json: async () => d, text: async () => JSON.stringify(d), blob: async () => new w.Blob(['img'], { type: 'image/png' }) });
        if (u.startsWith('mx_parts_coverage_dashboard.html')) return { ok: true, status: 200, text: async () => readFileSync(COVER, 'utf-8') };
        const p = new URL(u, 'https://example.test/');
        if (p.pathname === '/api/products/by-model') return json(byModel(p.searchParams.get('q') || ''));
        if (p.pathname === '/api/vio-promos' && method === 'POST') {
          const items = body.items.map((x, i) => ({ line_no: i + 1, ctr_code: x.code, qty: x.qty, product_id: 100 + i, stock: 5, list_price: LP[x.code] ?? null }));
          const tl = Math.round(items.reduce((a, x) => a + (x.list_price || 0) * x.qty, 0) * 100) / 100;
          return json({ id: 7, promo_no: 'K0007', ...body, items, total_list: tl, total_promo: Math.round(tl * (1 - body.discount_pct / 100) * 100) / 100, kit_code: null, kit_name: 'KIT T VERSA', price_included: true, buildable: 2, created_by_name: 'U', created_at: '2026-10-22T20:00:00Z' });
        }
        if (/^\/api\/vio-promos\/\d+$/.test(p.pathname) && method === 'PATCH') return json({ id: 7, promo_no: 'K0007', ...body, items: (body.items || []).map((x) => ({ ctr_code: x.code, qty: x.qty })), price_included: true });
        if (p.pathname === '/api/vio-promos' && method === 'GET') return json({ ready: true, items: [
          { id: 3, promo_no: 'K0003', model_key: 'versa', title: 'NISSAN Versa', years: '2012-2019', discount_pct: 10, show_totals: true, kit_code: null, kit_name: 'KIT T VERSA 2012-2019_CB0336_CQ0280Lx2', price_included: true, total_list: 2957, total_promo: 2661.3, buildable: 3, created_by_name: 'Ana', created_at: '2026-10-21T10:00:00Z',
            items: [{ ctr_code: 'CB0336', qty: 1 }, { ctr_code: 'CQ0280L', qty: 2 }] },
          { id: 2, promo_no: 'K0002', model_key: 'versa', title: 'NISSAN Versa', years: '2012-2019', discount_pct: 0, show_totals: false, kit_code: 'K0002', kit_name: 'KIT T VERSA 2012-2019_CB0336', kit_list_price: 291, price_included: true, total_list: 291, total_promo: 291, buildable: 12, items: [{ ctr_code: 'CB0336', qty: 1 }] }] });
        if (/^\/api\/vio-promos\/\d+$/.test(p.pathname) && method === 'DELETE') return json({ ok: true, id: Number(p.pathname.split('/').pop()) });
        if (/^\/api\/vio-promos\/\d+\/kit$/.test(p.pathname)) return json({ ok: true, product_id: 900, code: 'K0003', name: body.name, list_price: 2957, promo: { id: 3, promo_no: 'K0003', model_key: 'versa', discount_pct: 10, show_totals: true, total_list: 2957, total_promo: 2661.3, title: 'NISSAN Versa', years: '2012-2019', kit_code: 'K0003', kit_name: body.name, kit_list_price: 2957, price_included: true, items: [{ ctr_code: 'CB0336', qty: 1 }, { ctr_code: 'CQ0280L', qty: 2 }], buildable: 3 } });
        if (p.pathname === '/api/products/positions/lookup') {
          const R = (block, level, side, model, y_from, y_to) => ({ block, level, side, model, y_from, y_to });
          const all = {
            CQ0280L: { blocks: ['front'], levels: ['lower'], sides: ['lh'], ko: '앞·하·좌', rows: [R('front', 'lower', 'lh', 'Versa', 2012, 2019)] },
            CB0336: { blocks: ['front', 'rear'], levels: ['lower'], sides: [], ko: '앞/뒤·하', rows: [R('front', 'lower', null, 'Versa', 2012, 2019), R('rear', 'lower', null, 'Sentra', 2013, 2018)] },
            CL0477: { blocks: ['rear'], levels: [], sides: ['lh', 'rh'], ko: '뒤·좌/우', rows: [R('rear', null, 'lh', 'Tiida', 2007, 2012)] },
          };
          const items = {}; for (const c of body.codes) if (all[c]) items[c] = all[c];
          return json({ items });
        }
        if (p.pathname === '/api/products/applied-models') return json({ items: [] });
        if (p.pathname === '/api/products/syd-baseline') return json({ found: true, list_price_syd: 500 });
        if (p.pathname === '/api/promo-img/marks') return json({ marks: [{ x: 0.4, y: 0.5, w: 0.1, h: 0.08, kind: 'emblem' }] });
        if (p.pathname === '/api/promo-img') return /GV1043/.test(p.searchParams.get('u')) ? json({ error: 'not_found' }, 404) : json({});
        if (p.pathname === '/api/wa-promo/images' && method === 'GET') return json({ items: [{ id: 9, memo: 'vio:aveo | CB0166', uses: 1, created_mx: '2026-10-15T10:00', last_used_mx: '2026-10-16T09:00' }] });
        if (p.pathname === '/api/wa-promo/images' && method === 'POST') return json({ id: 41, duplicate: false });
        if (/^\/api\/wa-promo\/images\/\d+$/.test(p.pathname)) return json({ ok: true });
        if (p.pathname === '/api/wa-promo/audience') return json({ n: 57 });
        if (p.pathname === '/api/wa-promo/contacts') return json({ items: [{ id: 3, consent: 'yes' }, { id: 4, consent: 'yes' }] });
        if (p.pathname === '/api/wa-promo/groups') return json({ items: [{ id: 11, name: 'Talleres MTY', yes: 40 }] });
        if (p.pathname === '/api/wa-promo/contacts/bulk') {
          const rows = body.rows.map((r, i) => { const d = String(r.phone).replace(/\D/g, ''); const ph = d.length === 10 ? '52' + d : (d.length === 13 && d.startsWith('521') ? '52' + d.slice(3) : d);
            if (ph.length < 11 || ph.length > 15) return { i, status: 'bad_phone', raw_phone: r.phone, name: r.name };
            return ph === '528111111111' ? { i, status: 'exists', phone: ph, name: r.name, existing: { id: 7, name: 'Ana' } } : { i, status: 'new', phone: ph, name: r.name, id: body.dry_run === false ? 100 + i : undefined }; });
          const summary = { new: rows.filter((x) => x.status === 'new').length, exists: rows.filter((x) => x.status === 'exists').length, bad_phone: rows.filter((x) => x.status === 'bad_phone').length };
          return json({ dry_run: body.dry_run !== false, rows, summary });
        }
        if (p.pathname === '/api/wa-promo/consent/ask') return json({ queued: body.ids.length - 1, remaining_today: 130 });
        if (p.pathname === '/api/wa-promo/campaigns' && method === 'POST' && body.contact_ids && body.contact_ids.includes(7)) return json({ id: 90, audience: 1, picked: { selected: body.contact_ids.length, yes: 1, unknown: body.contact_ids.length - 1, asked: 0, no: 0 }, remaining_today: 139 });
        if (p.pathname === '/api/wa-promo/campaigns' && method === 'POST') return body.contact_ids && !body.contact_ids.length ? json({ error: 'no_contacts' }, 400) : json({ id: 88, audience: 2, remaining_today: 140 });
        if (/wikipedia\.org/.test(u)) return /summary/.test(u) ? json({ originalimage: { source: 'https://upload.wikimedia.org/x/car.jpg' } }) : json({ query: { pages: {} } });
        return json({ error: 'stub' }, 404);
      };
    },
  });
  return { dom, w: dom.window, d: dom.window.document, calls };
}

test('대기열: VIO 순 20차종 훑기 · 재고 품목 수 · 후보 · 발송 표시', { skip: SKIP }, async () => {
  const { w, d } = boot();
  assert.ok(await until(() => w.VP && w.VP._q.rows.length === 20 && !w.VP._q.running, 15000), '대기열이 끝나지 않음');
  assert.match(d.title, /vf17d/);
  const q = w.VP._q;
  const versa = q.rows.find((r) => /versa/i.test(r.m.modelo));
  assert.equal(versa.m.rank, 1);
  assert.equal(versa.st.cards, 5, 'Versa: 재고 있는 품목 5(RÓTULA·TERMINAL EXTERIOR·HORQUILLA·TORNILLO ESTABILIZADOR·BUJE) — HYBRID STABILIZER LINK 은 재고 0');
  // 후보만(기본 3개 이상): Versa 만
  assert.equal(d.querySelectorAll('#vpQueue tbody tr').length, 1);
  d.getElementById('vpQshow').value = 'all'; d.getElementById('vpQshow').dispatchEvent(new w.Event('change'));
  assert.equal(d.querySelectorAll('#vpQueue tbody tr').length, 20);
  assert.equal(d.querySelectorAll('#vpQueue .vpTag.sent').length, 1, 'Aveo 발송 표시');
  // 최소 재고 5 → Versa 품목 수 감소(Bieleta 4, Buje 2 빠짐)
  d.getElementById('vpQstock').value = '5'; d.getElementById('vpQstock').dispatchEvent(new w.Event('change'));
  assert.equal(versa.st.cards, 3);
});

test('프로모션 만들기: 재고 기준 자동 · 손으로 넣고 빼기 · 설정 기억', { skip: SKIP }, async () => {
  const { w, d } = boot();
  assert.ok(await until(() => d.querySelector('#vpQueue [data-qrank="1"]')));
  d.querySelector('#vpQueue [data-qrank="1"]').click();
  assert.ok(await until(() => d.querySelectorAll('#vpParts input[data-code]').length > 0));
  // vf16x · 전체 연식 + 재고 없는 코드도 보기 → 8개 전부
  d.querySelector('#vpGens [data-gen="-1"]').click();
  d.getElementById('vpShowZero').checked = true; d.getElementById('vpShowZero').dispatchEvent(new w.Event('change'));
  assert.ok(await until(() => d.querySelectorAll('#vpParts input[data-code]').length > 0));
  assert.ok(d.getElementById('vpOverlay').classList.contains('open'));
  const checked = () => [...d.querySelectorAll('#vpParts input[data-code]:checked')].map((x) => x.dataset.code).sort();
  assert.deepEqual(checked(), ['CB0336', 'CE0536L', 'CL0477', 'CQ0280L', 'CQ0280R', 'GV1043'], '재고 0(CE0536R · PL0477)은 자동 제외');
  // 손으로 빼기 · 넣기
  const cb = (code) => d.querySelector('#vpParts input[data-code="' + code + '"]');
  cb('CB0336').checked = false; cb('CB0336').dispatchEvent(new w.Event('change', { bubbles: true }));
  cb('PL0477').checked = true; cb('PL0477').dispatchEvent(new w.Event('change', { bubbles: true }));
  const cards = w.VP._cardsOf(w.VP._itemsOf(w.VP._st.d), w.VP._isInc);
  assert.ok(!cards.some((c) => c.label === 'RÓTULA'));
  assert.ok(cards.some((c) => c.label === 'HYBRID STABILIZER LINK' && c.codes[0] === 'PL0477'));
  // vf16w · 카탈로그 명칭(IZQ/DER 는 한 카드) · Brazo de control 없음 · 코드 옆 List price
  assert.ok(cards.some((c) => c.label === 'HORQUILLA' && c.codes.join() === 'CQ0280L,CQ0280R'));
  const heads = [...d.querySelectorAll('#vpParts .vpGrpH')].map((x) => x.textContent);
  assert.ok(heads.some((h) => h.startsWith('HORQUILLA')) && !heads.some((h) => /Brazo de control|Bieleta/.test(h)), heads.join('|'));
  const lp = (code) => d.querySelector('#vpParts input[data-code="' + code + '"]').closest('.vpCode').querySelector('.lp').textContent;
  assert.equal(lp('CQ0280L'), 'List$1,333.00'); assert.equal(lp('PL0477'), 'List$1,898.88'); assert.equal(lp('GV1043'), 'List—');
  const row = d.querySelector('#vpParts input[data-code="CQ0280L"]').closest('.vpCode');
  assert.equal(row.querySelector('.cd').nextElementSibling.className, 'lp', 'List price 는 코드 바로 옆');
  assert.equal(d.querySelectorAll('#vpParts .man').length, 2);
  assert.match(d.getElementById('vpSum').textContent, /손으로 바꾼 것 2/);
  // 최소 재고 7 → CQ0280L/R(6) 자동 제외, 손으로 넣은 PL0477 유지
  d.getElementById('vpMinStock').value = '7'; d.getElementById('vpMinStock').dispatchEvent(new w.Event('change'));
  assert.ok(!checked().includes('CQ0280L') && checked().includes('PL0477'));
  // 자동으로 되돌리기
  d.getElementById('vpAuto').click();
  assert.equal(d.querySelectorAll('#vpParts .man').length, 0);
  // 템플릿 B + 할인 → 저장
  d.querySelector('#vpTpl [data-tpl="B"]').click();
  d.getElementById('vpDiscOn').checked = true; d.getElementById('vpDiscOn').dispatchEvent(new w.Event('change'));
  const key = Object.keys(w.localStorage).find((k) => k.startsWith('vp_cfg_'));
  const cfg = JSON.parse(w.localStorage.getItem(key));
  assert.equal(cfg.tpl, 'B'); assert.equal(cfg.discOn, true); assert.equal(cfg.minStock, 7);
  assert.equal(w.VP._pairText(['CQ0280L', 'CQ0280R', 'CE0536L']).join(','), 'CQ0280 L/R,CE0536L');
});

test('이미지 뱅크 저장 → WhatsApp 발송(관심 차종 고객 · 지금 / 그룹 · 예약)', { skip: SKIP }, async () => {
  const { w, d, calls } = boot();
  assert.ok(await until(() => d.querySelector('#vpQueue [data-qrank="1"]')));
  d.querySelector('#vpQueue [data-qrank="1"]').click();
  assert.ok(await until(() => d.querySelectorAll('#vpParts input[data-code]').length > 0));
  calls.length = 0;
  d.getElementById('vpBank').click();
  assert.ok(await until(() => /이미지 뱅크/.test(d.getElementById('vpMsg').textContent)), d.getElementById('vpMsg').textContent);
  const post = calls.find((c) => c.u.endsWith('/api/wa-promo/images') && c.method === 'POST');
  assert.equal(post.body.folder, 'VIO 프로모션'); assert.equal(post.body.width, 1080); assert.equal(post.body.height, 1350);
  assert.match(post.body.name, /^VIO 01 · /); assert.match(post.body.image_b64, /^data:image\/jpeg/);
  const patch = calls.find((c) => /\/api\/wa-promo\/images\/41$/.test(c.u));
  assert.match(patch.body.memo, /^vio:nissan versa|^vio:versa/);
  // 발송 — 관심 차종 고객, 지금
  calls.length = 0;
  d.getElementById('vpWa').click();
  assert.ok(await until(() => /2명/.test((d.getElementById('vpAudVeh') || {}).textContent || '')));
  assert.ok(calls.some((c) => /\/api\/wa-promo\/contacts\?consent=yes&limit=2000&veh=Versa/.test(c.u)));
  d.querySelector('input[name=vpAud][value=veh]').checked = true;
  d.getElementById('vpDoSend').click();
  assert.ok(await until(() => /발송 #88/.test(d.getElementById('vpMsg').textContent)), d.getElementById('vpMsg').textContent);
  let camp = calls.filter((c) => c.u.endsWith('/api/wa-promo/campaigns') && c.method === 'POST').pop();
  assert.equal(camp.body.image_id, 41); assert.deepEqual(camp.body.contact_ids, [3, 4]); assert.equal(camp.body.send_now, true);
  assert.match(camp.body.caption, /^Refacciones CTR para /);
  // 그룹 · 예약
  calls.length = 0;
  d.getElementById('vpWa').click();
  assert.ok(await until(() => d.querySelector('#vpGrpList input[data-grp="11"]')));
  d.querySelector('input[name=vpAud][value=grp]').checked = true; d.querySelector('#vpGrpList input[data-grp="11"]').checked = true;
  d.querySelector('input[name=vpWhen][value=at]').checked = true; d.getElementById('vpAt').value = '2026-10-20T09:00';
  d.getElementById('vpDoSend').click();
  assert.ok(await until(() => /예약했습니다/.test(d.getElementById('vpMsg').textContent)));
  camp = calls.filter((c) => c.u.endsWith('/api/wa-promo/campaigns') && c.method === 'POST').pop();
  assert.deepEqual(camp.body.target_groups, [11]); assert.equal(camp.body.send_at, '2026-10-20T09:00'); assert.equal(camp.body.send_now, undefined);
  // 그룹을 안 고르면 막음(서버에 안 감)
  calls.length = 0; d.getElementById('vpWa').click();
  assert.ok(await until(() => d.querySelector('#vpGrpList input[data-grp="11"]')));
  d.querySelector('input[name=vpAud][value=grp]').checked = true;
  d.getElementById('vpDoSend').click(); await tick(150);
  assert.match(d.getElementById('vpMsg').textContent, /그룹을 하나 이상/);
  assert.ok(!calls.some((c) => c.u.endsWith('/api/wa-promo/campaigns')));
});

test('찾기 탭: 차량 줄 ★ 프로모션은 펼치지 않고 창을 연다 · 인라인 onclick 없음', { skip: SKIP }, async () => {
  const { w, d } = boot('https://example.test/refatrix-viofinder.html#tab=find');
  assert.ok(await until(() => d.querySelectorAll('#list .vpOpen').length >= 10));
  assert.equal(d.getElementById('findPane').style.display, '');
  d.querySelector('#list .veh-h[data-rank="1"] .vpOpen').click();
  await tick(100);
  assert.ok(d.getElementById('vpOverlay').classList.contains('open'));
  assert.equal(d.getElementById('vbr1').style.display, 'none');
  d.getElementById('vpClose').click();
  d.querySelector('#list .veh-h[data-rank="1"] .name').click(); await tick(100);
  assert.equal(d.getElementById('vbr1').style.display, 'block');
  assert.ok(!/\sonclick=/.test(readFileSync(HTML, 'utf-8')));
});

test('예전 「차종별 부품」 주소는 새 화면 찾기 탭으로 · 메뉴는 하나', { skip: !existsSync(resolve(ROOT, 'refatrix-vehicleparts.html')) }, () => {
  const vp = readFileSync(resolve(ROOT, 'refatrix-vehicleparts.html'), 'utf-8');
  assert.match(vp, /location\.replace\('refatrix-viofinder\.html#'\+h\)/);
  const nav = readFileSync(resolve(ROOT, 'refatrix-nav.js'), 'utf-8');
  const pm = nav.match(/\{key:'pm'[^}]*\}/)[0];
  assert.ok(pm.includes("'viofinder'") && !pm.includes("'vehicleparts'"));
  assert.match(nav, /viofinder:\{file:'refatrix-viofinder\.html',name:'VIO 제품찾기·프로모션'/);
});

test('CTR 정식 로고 · OE 마크: 파일 + 화면 안에 넣어 항상 반영 (vf16t)', () => {
  for (const f of ['ctr-logo.png', 'ctr-logo-white.png', 'oe-badge.png', 'oe-badge-white.png']) {
    const p = resolve(ROOT, 'img', 'promo', f);
    assert.ok(existsSync(p), f + ' 없음');
    assert.equal(readFileSync(p).subarray(1, 4).toString(), 'PNG', f + ' PNG 아님');
  }
  const html = readFileSync(HTML, 'utf-8');
  // vf16t · 화면 안에 넣음(서버 파일 404 여도 항상) · 끄는 체크·로고 바꾸기 없음
  const m = html.match(/window\.VP_BRAND=(\{.*?\});<\/script>/);
  assert.ok(m, 'VP_BRAND 없음');
  const B = JSON.parse(m[1]);
  for (const k of ['red', 'white', 'oe', 'oeW']) assert.match(B[k], /^data:image\/png;base64,iVBOR/, k);
  assert.ok(!/id="vpOeOn"/.test(html) && !/id="vpLogoFile"/.test(html));
});

test('전화번호 직접 입력: 여러 개 · 이름 붙여도 됨 · 새 번호 등록 → 동의자만 발송 + 미동의엔 동의 요청', { skip: SKIP }, async () => {
  const { w, d, calls } = boot();
  assert.ok(await until(() => d.querySelector('#vpQueue [data-qrank="1"]')));
  d.querySelector('#vpQueue [data-qrank="1"]').click();
  assert.ok(await until(() => d.querySelectorAll('#vpParts input[data-code]').length > 0));
  d.getElementById('vpWa').click();
  assert.ok(await until(() => d.getElementById('vpPhones')));
  const ta = d.getElementById('vpPhones');
  ta.value = '81 1111 1111\nJuan Pérez 8187654321, +52 1 81 5555 0000; 123';
  ta.dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.ok(await until(() => /번호 4개/.test(d.getElementById('vpPhChk').textContent)), d.getElementById('vpPhChk').textContent);
  assert.match(d.getElementById('vpPhChk').textContent, /이미 등록 1 · 새 번호 2/);
  assert.match(d.getElementById('vpPhChk').textContent, /형식 오류 1/);
  assert.ok(d.querySelector('input[name=vpAud][value=man]').checked, '입력하면 「직접 입력」이 선택됨');
  const dry = calls.filter((c) => c.u.endsWith('/contacts/bulk')).pop();
  assert.equal(dry.body.dry_run, true);
  assert.deepEqual(dry.body.rows.map((r) => r.name), ['Manual 1111', 'Juan Pérez', 'Manual 0000', 'Manual 123']);
  calls.length = 0;
  d.getElementById('vpDoSend').click();
  assert.ok(await until(() => /발송 #90/.test(d.getElementById('vpMsg').textContent)), d.getElementById('vpMsg').textContent);
  const reg = calls.find((c) => c.u.endsWith('/contacts/bulk'));
  assert.equal(reg.body.dry_run, false);
  const camp = calls.find((c) => c.u.endsWith('/api/wa-promo/campaigns') && c.method === 'POST');
  assert.deepEqual(camp.body.contact_ids, [7, 101, 102]);
  const ask = calls.find((c) => c.u.endsWith('/consent/ask'));
  assert.deepEqual(ask.body.ids, [7, 101, 102]);
  assert.match(d.getElementById('vpMsg').textContent, /✅ 1/); assert.match(d.getElementById('vpMsg').textContent, /동의 요청 2명/);
  // 입력한 번호는 다음에도 남아 있음
  assert.match(w.localStorage.getItem('vp_global'), /8187654321/);
});

test('자동차 로고 가리기: 자동 찾기 없음(서버 호출 안 함) · 직접 가리기만', { skip: SKIP }, async () => {
  const { w, d, calls } = boot();
  assert.ok(await until(() => d.querySelector('#vpQueue [data-qrank="1"]')));
  d.querySelector('#vpQueue [data-qrank="1"]').click();
  assert.ok(await until(() => w.VP._st.veh.img));
  await tick(300);
  assert.ok(!calls.some((c) => c.u.includes('/api/promo-img/marks')), '자동 찾기를 부르면 안 됨');
  assert.equal(w.VP._st.veh.marks.length, 0);
  assert.match(d.getElementById('vpMarkInfo').textContent, /아직 가린 곳 없음/);
  assert.ok(!d.getElementById('vpMarkAgain'));
  // 직접 가리기 → 1곳
  const v = w.VP._st.veh; v.rect = { dx: 100, dy: 800, dw: 880, dh: 400 };
  d.getElementById('vpMarkMode').click();
  const cv = d.getElementById('vpCanvas'); cv.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1080, height: 1350 });
  cv.dispatchEvent(new w.MouseEvent('click', { clientX: 540, clientY: 1000, bubbles: true }));
  assert.equal(v.man.length, 1); assert.ok(v.clean);
  assert.match(d.getElementById('vpMarkInfo').textContent, /1곳 가림/);
  d.getElementById('vpMarkUndo').click(); assert.equal(v.man.length, 0);
});

test('누끼(배경 지우기) · 이미지 List price 칸이 있다 (vf16w)', { skip: SKIP }, () => {
  const html = readFileSync(HTML, 'utf-8');
  for (const id of ['vpCutOnUp', 'vpCutNow', 'vpCutUndo', 'vpCutInfo', 'vpPriceOn']) assert.match(html, new RegExp('id="' + id + '"'), id);
  assert.match(html, /onnxruntime-web@1\.20\.1\/dist\//); assert.match(html, /isnet-general-use-q8\.onnx/);
  assert.match(html, /ort\.env\.wasm\.proxy=true/, '웹 워커로 돌려 화면이 멈추지 않게');
  assert.ok(!/Brazo de control|Bieleta híbrida/.test(html.replace(/\/\/.*$/gm, '')), '옛 번역 이름이 남아 있으면 안 됨');
});

test('연식 = VIO 세대: 기본은 재고 품목이 가장 많은 세대 · 세대 밖·재고 없는 코드는 목록에서 숨김 (vf16x)', { skip: SKIP }, async () => {
  const { w, d } = boot();
  assert.ok(await until(() => d.querySelector('#vpQueue [data-qrank="1"]')));
  d.querySelector('#vpQueue [data-qrank="1"]').click();
  assert.ok(await until(() => d.querySelectorAll('#vpParts input[data-code]').length > 0));
  const codes = () => [...d.querySelectorAll('#vpParts input[data-code]')].map((x) => x.dataset.code).sort();
  // Versa VIO 세대 = 2012-2019 · 2020-2025 → 기본 2012-2019 (재고 품목 4 > 0)
  const on = d.querySelector('#vpGens .vpChip.on');
  assert.match(on.textContent, /^2012-2019 · /); assert.match(on.textContent, /재고 4품목/);
  assert.equal(d.getElementById('vpYears').value, '2012-2019');
  assert.ok(!d.querySelector('#vpGens [data-var]') && !d.getElementById('vpYearFilter'), '예전 차종명 체크박스 없음');
  assert.deepEqual(codes(), ['CB0336', 'CE0536L', 'CL0477', 'CQ0280L', 'CQ0280R'], 'GV1043(2020-2024)·재고 0 코드 숨김');
  assert.match(d.getElementById('vpSum').textContent, /연식 2012-2019 밖 1개 숨김/);
  assert.match(d.getElementById('vpSum').textContent, /재고 없는 2개 숨김/);
  // 2020-2025 세대 → GV1043 만, 연식 칸 바뀜 · 저장
  d.querySelector('#vpGens [data-gen="1"]').click();
  assert.deepEqual(codes(), ['GV1043']);
  assert.equal(d.getElementById('vpYears').value, '2020-2025');
  const key = Object.keys(w.localStorage).find((k) => k.startsWith('vp_cfg_'));
  assert.equal(JSON.parse(w.localStorage.getItem(key)).gen, '2020-2025');
  const cards = w.VP._cardsOf(w.VP._itemsOf(w.VP._st.d, null, 'versa').filter((it) => it.rng.some((r) => r[0] <= 2025 && r[1] >= 2020)), w.VP._isInc);
  assert.equal(JSON.stringify([...cards].map((c) => c.label)), '["BUJE"]');
});

test('차종 선택: 누르면 VIO 순 목록 · 입력하면 찾기(연식 포함) · 키보드/클릭으로 프로모션 열기 (vf16y)', { skip: SKIP }, async () => {
  const { w, d } = boot();
  assert.ok(await until(() => d.querySelector('#vpQueue [data-qrank="1"]')));
  const inp = d.getElementById('vpPick'), list = d.getElementById('vpPickList');
  const items = () => [...list.querySelectorAll('.vpPi')];
  inp.dispatchEvent(new w.Event('focus'));
  assert.ok(await until(() => items().length === 150), 'VIO 상위 150');
  assert.match(items()[0].textContent, /^1위NISSAN VERSA/);
  assert.match(items()[0].textContent, /재고 \d+품목/, '대기열에서 훑은 차종은 재고 표시');
  assert.match(list.textContent, /더 아래 순위는 이름으로 찾으세요/);
  // 찾기
  inp.value = 'sportage'; inp.dispatchEvent(new w.Event('input'));
  assert.ok(items().length >= 1 && /SPORTAGE/.test(items()[0].textContent), list.textContent.slice(0, 200));
  // 연식으로 좁히기: 범위 밖 연식이면 빠짐
  inp.value = 'versa 2015'; inp.dispatchEvent(new w.Event('input'));
  assert.ok(items().some((x) => /NISSAN VERSA/.test(x.textContent)));
  inp.value = 'versa 1980'; inp.dispatchEvent(new w.Event('input'));
  assert.ok(!items().some((x) => /NISSAN VERSA/.test(x.textContent)));
  inp.value = 'zzqqxx'; inp.dispatchEvent(new w.Event('input'));
  assert.match(list.textContent, /맞는 차종이 없습니다/);
  // 키보드: 찾고 ↓ Enter → 두 번째 결과로 열림
  inp.value = 'nissan'; inp.dispatchEvent(new w.Event('input'));
  const second = items()[1].querySelector('.nm').firstChild.textContent;
  inp.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  inp.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.ok(await until(() => d.getElementById('vpOverlay').classList.contains('open')));
  assert.equal(d.getElementById('vpHead').querySelector('b').textContent, second);
  assert.ok(!list.classList.contains('open'), '고르면 목록 닫힘');
  d.getElementById('vpClose').click();
  // 클릭: 대기열(Top 20) 밖 차종도 열림
  inp.dispatchEvent(new w.Event('focus')); inp.value = 'sportage'; inp.dispatchEvent(new w.Event('input'));
  items()[0].dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
  assert.ok(await until(() => /SPORTAGE/.test(d.getElementById('vpHead').textContent)));
  assert.ok(w.VP._st.m.rank > 20, 'Top 20 밖');
});

test('장착 위치 배지: 이 차종·세대 줄이 있으면 그것 · 없으면 코드 전체(점선) · 자료 없으면 — (vf16z)', { skip: SKIP }, async () => {
  const { w, d, calls } = boot();
  assert.ok(await until(() => d.querySelector('#vpQueue [data-qrank="1"]')));
  d.querySelector('#vpQueue [data-qrank="1"]').click();
  assert.ok(await until(() => d.querySelectorAll('#vpParts .vpCode .pos:not(.none)').length >= 3), d.getElementById('vpParts').innerHTML.slice(0, 300));
  const lk = calls.find((c) => /positions\/lookup/.test(c.u));
  assert.equal(lk.body.detail, true); assert.ok(lk.body.codes.includes('CQ0280L'));
  const pos = (c) => d.querySelector('#vpParts input[data-code="' + c + '"]').closest('.vpCode').querySelector('.pos');
  assert.equal(pos('CQ0280L').textContent, '앞·하·좌'); assert.ok(pos('CQ0280L').classList.contains('f'));
  assert.ok(!pos('CQ0280L').classList.contains('gen'), 'Versa 2012-2019 줄 = 이 차종');
  assert.equal(pos('CB0336').textContent, '앞·하', 'Versa 줄만 → 앞(뒤는 Sentra)');
  assert.equal(pos('CL0477').textContent, '뒤·좌/우'); assert.ok(pos('CL0477').classList.contains('gen'), 'Tiida 뿐 → 코드 전체(점선)');
  assert.ok(pos('CL0477').classList.contains('r'));
  assert.equal(pos('CE0536L').textContent, '—'); assert.ok(pos('CE0536L').classList.contains('none'));
});

test('수량 · 정가 합계 · 할인 금액 · 이미지에 넣을지 · 저장(K번호) · 목록 · 열기 · 키트 제품 (vf17b)', { skip: SKIP }, async () => {
  const { w, d, calls } = boot();
  assert.ok(await until(() => d.querySelector('#vpQueue [data-qrank="1"]')));
  d.querySelector('#vpQueue [data-qrank="1"]').click();
  assert.ok(await until(() => d.querySelectorAll('#vpParts input[data-qty]').length > 0));
  const tot = () => d.getElementById('vpTot').textContent;
  // 기본: 재고 있는 것 · 2012-2019 → CB0336 · CE0536L · CL0477 · CQ0280L · CQ0280R
  const qIn = (c) => d.querySelector('#vpParts input[data-qty="' + c + '"]');
  assert.equal(qIn('CQ0280L').value, '1'); assert.equal(qIn('CQ0280L').disabled, false);
  const base = 291 + 448 + 343 + 1333 + 1333;
  assert.match(tot(), new RegExp('정가 합계 \\(List × 수량\\)\\$' + base.toLocaleString('en-US') + '\\.00'));
  // 수량 2 → 합계 · 카드 ×2(L/R 같을 때)
  qIn('CQ0280L').value = '2'; qIn('CQ0280L').dispatchEvent(new w.Event('input', { bubbles: true }));
  qIn('CQ0280R').value = '2'; qIn('CQ0280R').dispatchEvent(new w.Event('input', { bubbles: true }));
  const t2 = base + 1333 * 2;
  assert.match(tot(), new RegExp('\\$' + t2.toLocaleString('en-US') + '\\.00'));
  assert.match(tot(), /7개/);
  assert.equal(w.VP._st.qty.CQ0280L, 2);
  // 할인 10% → 할인 적용 금액
  d.getElementById('vpTotDiscOn').checked = true; d.getElementById('vpTotDiscOn').dispatchEvent(new w.Event('change', { bubbles: true }));
  const di = d.getElementById('vpTotDisc'); di.value = '10'; di.dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.equal(d.getElementById('vpDisc').value, '10', '할인 배지와 같은 값');
  assert.match(tot(), new RegExp('할인 적용 금액\\$' + (t2 * 0.9).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })));
  // 이미지에 넣을지 묻기 → 넣기
  assert.match(tot(), /이 금액을 이미지\(디자인\)에 넣을까요\?/);
  d.querySelector('input[name=vpTotOn][value="1"]').checked = true; d.querySelector('input[name=vpTotOn][value="1"]').dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.equal(w.VP._st.totOn, true);
  // 저장 → K번호
  d.getElementById('vpPromoSave').click();
  assert.ok(await until(() => /K0007/.test(tot())), tot());
  const post = calls.find((c) => c.u.endsWith('/api/vio-promos') && c.method === 'POST');
  assert.equal(post.body.discount_pct, 10); assert.equal(post.body.show_totals, true); assert.equal(post.body.model, 'Versa');
  assert.deepEqual(post.body.items.find((x) => x.code === 'CQ0280L'), { code: 'CQ0280L', qty: 2 });
  assert.ok(!d.getElementById('vpPromoSave'), '바뀐 것 없으면 저장 버튼 없음');
  // vf17c · 이미지에 번호 — 저장 뒤 바뀐 것 없을 때만
  assert.match(tot(), /이미지에 「Producto promoción: K0007」 표시 중/);
  const texts = []; const cv = d.createElement('canvas'); cv.width = 1080; cv.height = 1350;
  const ctx = cv.getContext('2d'); ctx.fillText = (t) => texts.push(String(t));
  await w.VP._render(cv);
  assert.ok(texts.includes('Producto promoción:') && texts.includes('K0007'), texts.join('|').slice(0, 300));
  // 바꾸면 「다시 저장」 → PATCH
  qIn('CB0336').value = '3'; qIn('CB0336').dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.match(tot(), /바뀐 내용 있음/);
  { const t2 = []; const cv2 = d.createElement('canvas'); cv2.width = 1080; cv2.height = 1350; const c2 = cv2.getContext('2d'); c2.fillText = (t) => t2.push(String(t));
    await w.VP._render(cv2); assert.ok(!t2.includes('K0007'), '바뀌면 번호 뺌'); }
  d.getElementById('vpPromoSave').click();
  assert.ok(await until(() => calls.some((c) => /\/api\/vio-promos\/7$/.test(c.u) && c.method === 'PATCH')));
  // 목록 탭
  d.getElementById('vpClose').click();
  d.querySelector('#vpTabs [data-tab="plist"]').click();
  assert.ok(await until(() => d.querySelectorAll('#vpPlist tbody tr').length === 2));
  const t = d.getElementById('vpPlist').textContent;
  assert.match(t, /K0003/); assert.match(t, /CQ0280L×2/); assert.match(t, /\$2,661\.30/); assert.match(t, /K0002 등록됨/);
  // 키트 제품 만들기(디렉터): 이름 고쳐서 등록
  d.querySelector('[data-kit="3"]').click();
  const kn = d.getElementById('vpKitName'); assert.equal(kn.value, 'KIT T VERSA 2012-2019_CB0336_CQ0280Lx2');
  kn.value = 'KIT T VERSA 2012-2019_CB0336_CQ0280Lx2 '; d.querySelector('[data-kitgo="3"]').click();
  assert.ok(await until(() => /제품 마스터에 K0003/.test(d.getElementById('vpPlMsg').textContent)));
  assert.equal(calls.find((c) => /\/kit$/.test(c.u)).body.name, 'KIT T VERSA 2012-2019_CB0336_CQ0280Lx2');
  // 열기 → 그 구성·수량
  // 삭제: 키트 제품 있는 K0002 는 버튼 없음 · K0003 은 키트 만든 뒤라 버튼 없음 → 목록 다시 불러 K0003(키트 전) 삭제
  assert.ok(!d.querySelector('[data-pdel="2"]'), '카탈로그에 등록된 키트는 삭제 버튼 없음');
  assert.ok(!d.querySelector('[data-pdel="3"]'), '방금 키트를 만든 K0003 도 삭제 버튼 없음');
  d.getElementById('vpPlReload').click();
  assert.ok(await until(() => d.querySelector('[data-pdel="3"]')));
  d.querySelector('[data-pdel="3"]').click();
  assert.ok(await until(() => /K0003 을\(를\) 삭제했습니다/.test(d.getElementById('vpPlMsg').textContent)));
  assert.ok(calls.some((c) => /\/api\/vio-promos\/3$/.test(c.u) && c.method === 'DELETE'));
  assert.equal(d.querySelectorAll('#vpPlist tbody tr').length, 1);
  d.getElementById('vpPlReload').click();
  assert.ok(await until(() => d.querySelector('[data-popen="3"]')));
  d.querySelector('[data-popen="3"]').click();
  assert.ok(await until(() => d.getElementById('vpOverlay').classList.contains('open') && d.querySelectorAll('#vpParts input[data-qty]').length > 0));
  assert.ok(await until(() => /K0003/.test(tot())));
  const on = [...d.querySelectorAll('#vpParts input[data-code]')].filter((x) => x.checked).map((x) => x.dataset.code).sort();
  assert.deepEqual(on, ['CB0336', 'CQ0280L']);
  assert.equal(qIn('CQ0280L').value, '2');
  assert.equal(w.VP._st.discOn, true); assert.equal(w.VP._st.disc, 10); assert.equal(w.VP._st.totOn, true);
});
