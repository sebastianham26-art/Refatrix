// =====================================================================
// VIO 제품찾기·프로모션 화면 (jsdom · build vf16s · 2026-10-19) — 운영 HTML 을 그대로 띄우고 fetch·canvas 만 스텁
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

const it = (ctr, name, stock, year = '2012-2019') => ({ ctr, syd: ['1' + ctr.slice(-4)], name, year, stock, sold: 3, sold_by: [], lp_syd: 500 });
function byModel(q) {
  const term = q.split('||')[0]; const vk = term;
  const versa = /versa/i.test(term);
  const cats = [
    ['rotula', [it('CB0336', 'ROTULA INFERIOR', 12)]],
    ['terminal_ext', [it('CE0536L', 'TERMINAL EXTERIOR IZQ', 8), it('CE0536R', 'TERMINAL EXTERIOR DER', 0)]],
    ['horquilla', [it('CQ0280L', 'HORQUILLA IZQ', 6), it('CQ0280R', 'HORQUILLA DER', 6)]],
    ['tornillo', [it('CL0477', 'TORNILLO ESTABILIZADOR', 4), it('PL0477', 'TORNILLO ESTABILIZADOR HIBRIDO', 0)]],
    ['buje', [it('GV1043', 'BUJE BARRA', 2, '2020-2024')]],
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
        if (p.pathname === '/api/products/applied-models') return json({ items: [] });
        if (p.pathname === '/api/products/syd-baseline') return json({ found: true, list_price_syd: 500 });
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
  assert.match(d.title, /vf16s/);
  const q = w.VP._q;
  const versa = q.rows.find((r) => /versa/i.test(r.m.modelo));
  assert.equal(versa.m.rank, 1);
  assert.equal(versa.st.cards, 5, 'Versa: 재고 있는 품목 5(Rótula·Terminal ext·Brazo·Bieleta·Buje) — Bieleta híbrida 는 재고 0');
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
  assert.ok(await until(() => d.querySelectorAll('#vpParts input[data-code]').length === 8));
  assert.ok(d.getElementById('vpOverlay').classList.contains('open'));
  const checked = () => [...d.querySelectorAll('#vpParts input[data-code]:checked')].map((x) => x.dataset.code).sort();
  assert.deepEqual(checked(), ['CB0336', 'CE0536L', 'CL0477', 'CQ0280L', 'CQ0280R', 'GV1043'], '재고 0(CE0536R · PL0477)은 자동 제외');
  // 손으로 빼기 · 넣기
  const cb = (code) => d.querySelector('#vpParts input[data-code="' + code + '"]');
  cb('CB0336').checked = false; cb('CB0336').dispatchEvent(new w.Event('change', { bubbles: true }));
  cb('PL0477').checked = true; cb('PL0477').dispatchEvent(new w.Event('change', { bubbles: true }));
  const cards = w.VP._cardsOf(w.VP._itemsOf(w.VP._st.d), w.VP._isInc);
  assert.ok(!cards.some((c) => c.label === 'Rótula'));
  assert.ok(cards.some((c) => c.label === 'Bieleta híbrida' && c.codes[0] === 'PL0477'));
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
  assert.ok(await until(() => d.querySelectorAll('#vpParts input[data-code]').length === 8));
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

test('CTR 정식 로고 · OE 마크 파일이 있고 화면이 쓴다 (vf16q)', () => {
  for (const f of ['ctr-logo.png', 'ctr-logo-white.png', 'oe-badge.png', 'oe-badge-white.png']) {
    const p = resolve(ROOT, 'img', 'promo', f);
    assert.ok(existsSync(p), f + ' 없음');
    assert.equal(readFileSync(p).subarray(1, 4).toString(), 'PNG', f + ' PNG 아님');
  }
  const html = readFileSync(HTML, 'utf-8');
  assert.match(html, /img\/promo\/ctr-logo\.png/); assert.match(html, /img\/promo\/oe-badge-white\.png/);
  assert.match(html, /id="vpOeOn"/);
});

test('전화번호 직접 입력: 여러 개 · 이름 붙여도 됨 · 새 번호 등록 → 동의자만 발송 + 미동의엔 동의 요청', { skip: SKIP }, async () => {
  const { w, d, calls } = boot();
  assert.ok(await until(() => d.querySelector('#vpQueue [data-qrank="1"]')));
  d.querySelector('#vpQueue [data-qrank="1"]').click();
  assert.ok(await until(() => d.querySelectorAll('#vpParts input[data-code]').length === 8));
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
