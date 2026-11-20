// =====================================================================
// meta_reply_front.test.mjs — 0331 · 화면(jsdom): 「💬 답장 필요」 · 「●」 새 메시지 — 문의 목록 · 내 할당 · 탭 숫자
//   실행: node --test test/meta_reply_front.test.mjs
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const MTL = resolve(here, '..', '..', 'refatrix-metaleads.html');
let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* skip */ }
const SKIP = !JSDOM || !existsSync(MTL);
const tick = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const NOW = new Date().toISOString();
const AGO = new Date(Date.now() - 2 * 3600000).toISOString();

function boot(route, { role = 'director' } = {}) {
  const calls = [];
  const dom = new JSDOM(readFileSync(MTL, 'utf-8').replace(/<script src="https:\/\/cdn[^>]+><\/script>/, ''), {
    runScripts: 'dangerously', url: 'https://example.test/refatrix-metaleads.html',
    beforeParse(w) {
      w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 'T', api: 'https://api.test', user: { id: role === 'director' ? 1 : 7, name: 'U', role } }));
      w.alert = () => {}; w.confirm = () => true; w.prompt = () => 'No contesta'; w.scrollTo = () => {};
      w.XLSX = { utils: { aoa_to_sheet: (a) => ({ a }), book_new: () => ({}), book_append_sheet: () => {} }, writeFile: (wb, name) => calls.push({ u: 'XLSX:' + name, method: 'FILE' }) };
      w.fetch = async (u0, opt = {}) => {
        const u = String(u0); const method = opt.method || 'GET'; const body = opt.body ? JSON.parse(opt.body) : null;
        calls.push({ u, method, body });
        const json = (d, s = 200) => ({ ok: s < 400, status: s, json: async () => d });
        const r = route(u, method, body, json); if (r) return r;
        if (u.includes('/api/meta-leads/status')) return json({ configured: true, migrated: true, page_id: '1', page: { name: 'CTR' }, counts: { total: 2 }, ai: {}, match: {}, states: ['Nuevo León'] });
        if (u.includes('/api/meta-leads/list')) return json({ items: [{ id: 5, platform: 'whatsapp', name: 'Taller Garza', status: 'nuevo', last_mx: '2026-11-19 09:00', assigned_to: 7, assigned_name: 'Ana' }], stock: {} });
        return json({});
      };
    },
  });
  const w = dom.window;
  return { w, d: w.document, calls, close: () => w.close(), ready: new Promise((r) => { if (w.document.readyState === 'complete') r(); else w.addEventListener('load', r); }) };
}

const LIST = [{ id: 5, platform: 'messenger', name: 'Quetzalcoatl', status: 'contactado', last_mx: '2026-11-19 21:00', need_reply: true, reply_pending_n: 2, reply_last_in: AGO, unread: true, assigned_to: 7, assigned_name: 'Ana' },
  { id: 6, platform: 'whatsapp', name: 'Lupita', status: 'nuevo', last_mx: '2026-11-19 20:00', need_reply: false }];
test('답장 필요 · 새 메시지 (jsdom)', { skip: SKIP && 'jsdom 또는 HTML 없음' }, async (t) => {
  const route = (u, method, body, json) => {
    if (u.endsWith('/api/meta-assign/config')) return json({ ready: true, is_admin: false, settings: { auto: true }, me: { user_id: 7, member: true, name: 'Ana', daily_target: 10, active: true, today_assigned: 4, today_done: 3, open_n: 1, need_n: 3, unread_n: 1 } });
    if (u.includes('/api/meta-assign/mine')) return json({ user_id: 7, scope: 'need', me: { user_id: 7, name: 'Ana', daily_target: 10, active: true, today_assigned: 4, today_done: 3, open_n: 1 },
      items: [{ id: 5, how: 'auto', assigned_at: AGO, platform: 'messenger', name: 'Quetzalcoatl', status: 'contactado', done_at: AGO, done_how: 'reply', need_reply: true, reply_pending_n: 2, reply_last_in: AGO, unread: true, notes_n: 0 }] });
    if (u.includes('/api/meta-leads/list')) return json({ items: LIST, stock: {} });
    if (u.endsWith('/api/meta-leads/5')) return json({ id: 5, platform: 'messenger', name: 'Quetzalcoatl', status: 'contactado', messages: [{ at: AGO, me: false, text: '¿y el precio?' }], items: [], portal: null, assign: null });
    return null;
  };
  await t.test('목록 표시 · 필터 · 열면 ● 지움 · 탭 숫자 · 내 할당 답장 필요', async () => {
    const c = boot(route, { role: 'sales' }); t.after(() => c.close()); await c.ready; await tick(700);
    const tr = c.d.querySelector('#lTable tr[data-id="5"]');
    assert.ok(tr.classList.contains('needrow')); assert.match(tr.textContent, /💬 답장 필요 2 · 2시간 전/); assert.ok(tr.querySelector('.udot'));
    assert.ok(!c.d.querySelector('#lTable tr[data-id="6"]').classList.contains('needrow'));
    assert.equal(c.d.getElementById('mineN').textContent, '💬 3'); assert.ok(c.d.getElementById('mineN').classList.contains('needtab'));
    c.d.getElementById('fNeed').checked = true; c.d.getElementById('fNeed').dispatchEvent(new c.w.Event('change')); await tick();
    assert.ok(c.calls.some((x) => x.u.includes('/api/meta-leads/list?') && x.u.includes('need=1')));
    c.d.querySelector('#lTable tr[data-id="5"]').dispatchEvent(new c.w.MouseEvent('click', { bubbles: true })); await tick(300);
    assert.equal(c.d.querySelector('#lTable tr[data-id="5"] .udot'), null, '열면 ● 지움');
    c.d.querySelector('[data-close="mOne"]').click();
    c.d.getElementById('tMine').click(); await tick(300);
    c.d.querySelector('#mScope button[data-s="need"]').click(); await tick(300);
    assert.ok(c.calls.some((x) => x.u.includes('/api/meta-assign/mine?scope=need')));
    assert.match(c.d.getElementById('mList').textContent, /💬 답장 필요 2/);
    assert.match(c.d.getElementById('mKpis').textContent, /답장 필요\(지금 내 문의\)3/);
  });
});
