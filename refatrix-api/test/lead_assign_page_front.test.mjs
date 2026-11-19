// =====================================================================
// lead_assign_page_front.test.mjs — 1119b · 「영업 할당 · 실적」 화면(refatrix-leadassign.html, jsdom)
//   KPI · 사람별 실적 · 날짜×사람 표 · 할당 목록 필터(사람 · 대화 상태 · 검색) · 행 → Meta 광고 문의 열기 · 엑셀 · 메뉴 등록 · 영업 계정 안내
//   실행: node --test test/lead_assign_page_front.test.mjs
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const HTML = resolve(here, '..', '..', 'refatrix-leadassign.html');
const NAV = resolve(here, '..', '..', 'refatrix-nav.js');
let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* skip */ }
const SKIP = !JSDOM || !existsSync(HTML);
const tick = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const NOW = new Date().toISOString();

const CFG = { ready: true, is_admin: true, settings: { auto: true, work_start: 8, work_end: 19 }, pool: { n: 12 },
  members: [{ user_id: 7, name: 'María', daily_target: 25, active: true }, { user_id: 8, name: 'Clarisa', daily_target: 20, active: true }] };
const PERF = { from: '2026-11-18', to: '2026-11-19', days: 2, daily: [],
  people: [{ user_id: 8, name: 'Clarisa', member: true, daily_target: 20, target: 40, assigned: 3, done: 1, pending: 1, moved: 1, by_reply: 1, by_status: 0, by_call: 0, derivado: 0, venta: 0, avg_min: 30, rate: 33.3, target_rate: 2.5 },
    { user_id: 7, name: 'María', member: true, daily_target: 25, target: 50, assigned: 2, done: 2, pending: 0, moved: 0, by_reply: 1, by_status: 0, by_call: 1, derivado: 1, venta: 1, avg_min: 12, rate: 100, target_rate: 4 }],
  team: { assigned: 5, done: 3, pending: 1, moved: 1, by_reply: 2, by_status: 0, by_call: 1, derivado: 1, venta: 1, target: 90, rate: 60, target_rate: 3.3 } };
const IT = (id, uid, uname, day, extra) => ({ id, assign_id: id, user_id: uid, user_name: uname, day, how: 'auto', assigned_at: NOW, platform: 'messenger', name: 'Cliente ' + id, phone: '81000000' + id, status: 'nuevo', summary: 'Busca horquilla', ...extra });
const LIST = { items: [IT(1, 7, 'María', '2026-11-19', { done_at: NOW, done_how: 'call', mins: 12, last_note: 'Llamé' }), IT(2, 7, 'María', '2026-11-18', { done_at: NOW, done_how: 'reply', mins: 5 }),
  IT(3, 8, 'Clarisa', '2026-11-19', { name: 'Taller Altima' }), IT(4, 8, 'Clarisa', '2026-11-18', { done_at: NOW, done_how: 'reply', mins: 30 }),
  IT(5, 8, 'Clarisa', '2026-11-19', { ended_at: NOW, now_name: 'María' })] };

function boot(cfg) {
  const calls = [];
  const dom = new JSDOM(readFileSync(HTML, 'utf-8').replace(/<script src="https:\/\/cdn[^>]+><\/script>/, '').replace(/<script src="refatrix-nav[^>]+><\/script>/, ''), {
    runScripts: 'dangerously', url: 'https://example.test/refatrix-leadassign.html',
    beforeParse(w) {
      w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 'T', api: 'https://api.test', user: { id: 1, name: 'Sebastian', role: 'director' } }));
      w.open = (u) => { calls.push({ u: 'OPEN:' + u }); return null; }; w.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
      w.XLSX = { utils: { aoa_to_sheet: (a) => ({ a }), book_new: () => ({ s: [] }), book_append_sheet: (wb, ws, n) => wb.s.push([n, ws.a.length]) }, writeFile: (wb, name) => calls.push({ u: 'XLSX:' + name, sheets: wb.s }) };
      w.fetch = async (u0) => { const u = String(u0); calls.push({ u });
        const json = (d, s = 200) => ({ ok: s < 400, status: s, json: async () => d });
        if (u.includes('/api/meta-assign/config')) return json(cfg);
        if (u.includes('/api/meta-assign/perf')) return json(PERF);
        if (u.includes('/api/meta-assign/list')) return json(LIST);
        return json({}); };
    },
  });
  const w = dom.window;
  return { w, d: w.document, calls, close: () => w.close(), ready: new Promise((r) => { if (w.document.readyState === 'complete') r(); else w.addEventListener('load', r); }) };
}

test('영업 할당 · 실적 화면', { skip: SKIP && 'jsdom 또는 HTML 없음' }, async (t) => {
  await t.test('KPI · 사람별 · 날짜×사람 · 목록 필터 · 열기 · 엑셀', async () => {
    const c = boot(CFG); await c.ready; await tick(600);
    assert.match(c.d.title, /la-1119c/);
    assert.match(c.d.getElementById('kpis').textContent, /할당5/); assert.match(c.d.getElementById('kpis').textContent, /60%/);
    assert.match(c.d.getElementById('cfgLine').textContent, /대상 2명/);
    const ppl = c.d.getElementById('people'); assert.match(ppl.textContent, /Clarisa/); assert.match(ppl.textContent, /팀 전체/);
    const mx = c.d.getElementById('mx'); assert.match(mx.textContent, /11-18/); assert.match(mx.textContent, /11-19/);
    assert.match(mx.querySelector('tbody tr').textContent, /Clarisa/, '넘김은 빼고 셈');
    const list = () => c.d.getElementById('list');
    assert.equal(list().querySelectorAll('tr[data-open]').length, 5);
    assert.match(list().textContent, /→ 지금 María/);
    ppl.querySelector('tr[data-uid="7"]').click(); await tick(50);
    assert.equal(list().querySelectorAll('tr[data-open]').length, 2, '사람 행 → 그 사람만');
    ppl.querySelector('tr[data-uid="7"]').click(); await tick(50);
    c.d.querySelector('#fState [data-s="open"]').click(); await tick(50);
    assert.deepEqual([...list().querySelectorAll('tr[data-open]')].map((r) => r.dataset.open), ['3']);
    c.d.querySelector('#fState [data-s="moved"]').click(); await tick(50);
    assert.deepEqual([...list().querySelectorAll('tr[data-open]')].map((r) => r.dataset.open), ['5']);
    c.d.querySelector('#fState [data-s=""]').click(); c.d.getElementById('fQ').value = 'altima'; c.d.getElementById('fGo').click(); await tick(50);
    assert.deepEqual([...list().querySelectorAll('tr[data-open]')].map((r) => r.dataset.open), ['3']);
    list().querySelector('tr[data-open="3"]').click();
    assert.ok(c.calls.some((x) => x.u === 'OPEN:refatrix-metaleads.html#open=3'));
    c.d.getElementById('xls').click();
    const x = c.calls.find((y) => /^XLSX:refatrix_asignacion_/.test(y.u)); assert.ok(x); assert.deepEqual(x.sheets.map((s) => s[0]), ['사람별', '할당 목록']);
    c.d.querySelector('#rng button[data-r="month"]').click(); await tick();
    assert.ok(c.calls.some((y) => /\/perf\?from=\d{4}-\d{2}-01&/.test(y.u)) && c.calls.some((y) => /\/list\?from=\d{4}-\d{2}-01&/.test(y.u)));
    c.close();
  });
  await t.test('1119c · 대상자 없음 = 큰 안내 · 할당 있으면 안내 숨김', async () => {
    const c = boot({ ...CFG, members: [], pool: { n: 223 } }); await c.ready; await tick(600);
    const e = c.d.getElementById('empty');
    assert.ok(!e.classList.contains('hidden')); assert.match(e.textContent, /아직 대화할 영업사원을 고르지 않았습니다/); assert.match(e.textContent, /223건/);
    assert.equal(e.querySelector('a').getAttribute('href'), 'refatrix-metaleads.html#tab=asg');
    c.close();
    const c2 = boot(CFG); await c2.ready; await tick(600);
    assert.ok(c2.d.getElementById('empty').classList.contains('hidden'));
    c2.close();
  });
  await t.test('영업 계정 — 디렉터 전용 안내 · 내 할당 링크', async () => {
    const c = boot({ ready: true, is_admin: false, me: { user_id: 7 } }); await c.ready; await tick(500);
    assert.match(c.d.getElementById('msg').textContent, /디렉터 · 소시오만/);
    assert.equal(c.d.getElementById('toCfg').getAttribute('href'), 'refatrix-metaleads.html#tab=mine');
    assert.ok(!c.calls.some((y) => y.u.includes('/perf')));
    c.close();
  });
  await t.test('메뉴 등록(디렉터 · 소시오) · 인라인 onclick 없음', () => {
    const nav = readFileSync(NAV, 'utf-8');
    assert.match(nav, /leadassign:\{file:'refatrix-leadassign\.html'/); assert.match(nav, /leadassign:'__dirsocio__'/); assert.match(nav, /'metaleads','leadassign'/);
    assert.ok(!/onclick=/.test(readFileSync(HTML, 'utf-8')));
  });
});
