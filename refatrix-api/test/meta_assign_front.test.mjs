// =====================================================================
// meta_assign_front.test.mjs — 0329 · 화면(jsdom) · Meta 광고 문의 › 🙋 내 할당 · 🎯 배분 · 실적 · 상세 담당 · 고객별 메모
//   실행: node --test test/meta_assign_front.test.mjs
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
const NOW = new Date().toISOString();
const USERS = [{ id: 1, name: 'Sebastian', role: 'director', page_ok: true }, { id: 7, name: 'Ana', role: 'sales', page_ok: true }, { id: 8, name: 'Beto', role: 'sales', page_ok: true }, { id: 9, name: 'Ciro', role: 'sales', page_ok: false }];
const CFG_ADMIN = { ready: true, is_admin: true, settings: { auto: true, default_target: 20, pool_days: 7, work_start: 8, work_end: 19 }, me: { user_id: 1, member: false },
  members: [{ user_id: 7, name: 'Ana', daily_target: 15, active: true, today_assigned: 12, today_done: 9, open_n: 3 }], users: USERS, pool: { n: 40, waiting: 25 }, unassigned_open: 300 };
const PERF = { from: '2026-11-19', to: '2026-11-19', days: 1, daily: [{ day: '2026-11-19', assigned: 12, done: 9 }],
  people: [{ user_id: 7, name: 'Ana', member: true, daily_target: 15, target: 15, assigned: 12, done: 9, pending: 3, moved: 1, by_reply: 6, by_status: 2, by_call: 1, derivado: 1, venta: 2, avg_min: 34, rate: 75, target_rate: 60 }],
  team: { assigned: 12, done: 9, pending: 3, moved: 1, by_reply: 6, by_status: 2, by_call: 1, derivado: 1, venta: 2, target: 15, rate: 75, target_rate: 60 } };
const LEAD = (assign) => ({ id: 5, platform: 'whatsapp', thread_id: 'wa:528112345601', name: 'Taller Garza', status: 'nuevo', messages: [{ at: NOW, me: false, text: 'Precio horquilla' }], items: [], portal: null, assign });
const ASSIGN = { assigned_to: 7, assigned_name: 'Ana', assigned_at: NOW, current: { id: 3, user_id: 7, how: 'auto', done_at: null }, notes: [{ id: 1, user_id: 7, user_name: 'Ana', text: 'Quiere 4 piezas', at: NOW }] };

test('🎯 배분 · 실적 (디렉터)', { skip: SKIP && 'jsdom 또는 HTML 없음' }, async (t) => {
  const route = (u, method, body, json) => {
    if (u.endsWith('/api/meta-assign/config') && method === 'GET') return json(CFG_ADMIN);
    if (u.endsWith('/api/meta-assign/config') && method === 'PUT') return json({ ok: true });
    if (u.endsWith('/api/meta-assign/run')) return json({ ok: true, assigned: 3, by_user: { 7: 2, 8: 1 } });
    if (u.includes('/api/meta-assign/perf')) return json(PERF);
    if (u.includes('/api/meta-assign/mine')) return json({ user_id: 7, scope: 'today', me: CFG_ADMIN.members[0], items: [{ id: 5, assign_id: 3, how: 'auto', assigned_at: NOW, platform: 'whatsapp', name: 'Taller Garza', phone: '8112345601', status: 'nuevo', summary: 'Busca horquilla', last_note: 'Quiere 4 piezas', notes_n: 1 }] });
    if (u.endsWith('/api/meta-leads/5/assign')) return json({ ok: true, assign: { ...ASSIGN, assigned_to: body.user_id, assigned_name: 'Beto' } });
    if (u.endsWith('/api/meta-leads/5/notes') && method === 'POST') return json({ ok: true, items: ASSIGN.notes.concat([{ id: 2, user_id: 1, user_name: 'Sebastian', text: body.text, at: NOW }]) });
    if (u.endsWith('/api/meta-leads/5')) return json(LEAD(ASSIGN));
    return null;
  };
  await t.test('대상자 클릭 · 목표 · 저장 · 지금 분배 · 실적 표 · 엑셀 · 사람 행 → 그 사람 할당', async () => {
    const c = boot(route); await c.ready; await tick(700);
    assert.match(c.d.title, /mtl-1119f/);
    assert.ok(!c.d.getElementById('tAsg').classList.contains('hidden'), '디렉터 = 배분 탭');
    c.d.getElementById('tAsg').click(); await tick();
    const chips = c.d.querySelectorAll('#aPeople [data-uid]'); assert.equal(chips.length, 4);
    assert.ok(c.d.querySelector('#aPeople [data-uid="7"]').classList.contains('on'));
    assert.ok(c.d.querySelector('#aPeople [data-uid="9"]').classList.contains('noacc'), '권한 없는 사람 표시');
    assert.ok(c.d.getElementById('aDirty').classList.contains('hidden'));
    c.d.querySelector('#aPeople [data-uid="8"]').click(); await tick(50);
    assert.ok(!c.d.getElementById('aDirty').classList.contains('hidden'), '저장 안 된 변경 표시'); assert.match(c.d.getElementById('asgSave').textContent, /변경 있음/);
    const inp = c.d.querySelector('#aTargets [data-tgt="8"]'); assert.equal(inp.value, '20', '새로 고른 사람 = 기본 목표');
    inp.value = '10'; inp.dispatchEvent(new c.w.Event('input', { bubbles: true }));
    c.d.querySelector('#aPeople [data-uid="7"]').click(); c.d.querySelector('#aPeople [data-uid="7"]').click();   // 빼고 다시 넣기
    c.d.getElementById('asgSave').click(); await tick();
    const put = c.calls.find((x) => x.method === 'PUT');
    assert.deepEqual(put.body.members.sort((a, b) => a.user_id - b.user_id), [{ user_id: 7, daily_target: 15, share_pct: 0, active: true }, { user_id: 8, daily_target: 10, share_pct: 0, active: true }]);
    assert.equal(put.body.auto, true); assert.equal(put.body.pool_days, 7); assert.equal(put.body.mode, 'target');
    assert.ok(c.d.getElementById('aDirty').classList.contains('hidden'), '저장하면 표시 사라짐');
    assert.match(c.d.getElementById('aPool').textContent, /40건/);
    c.d.getElementById('aRun').click(); await tick();
    assert.match(c.d.getElementById('asgMsg').textContent, /3건 나눴습니다 — Ana 2 · Beto 1/);
    const tb = c.d.getElementById('pTable');
    assert.match(tb.textContent, /Ana/); assert.match(tb.textContent, /팀 전체/); assert.match(tb.textContent, /75%/); assert.match(tb.textContent, /60%/);
    c.d.getElementById('pXls').click(); assert.ok(c.calls.some((x) => /XLSX:refatrix_meta_asignacion_/.test(x.u)));
    c.d.querySelector('#pRange button[data-r="month"]').click(); await tick();
    assert.ok(c.calls.some((x) => x.u.includes('/perf?from=') && /from=\d{4}-\d{2}-01/.test(x.u)));
    tb.querySelector('tr[data-puid="7"]').click(); await tick(400);
    assert.ok(c.d.getElementById('p-mine').classList.contains('on'));
    assert.ok(c.calls.some((x) => x.u.includes('/api/meta-assign/mine?') && x.u.includes('user=7')));
    assert.match(c.d.getElementById('mList').textContent, /Taller Garza/);
    c.close();
  });
  await t.test('1119c · 고르고 저장 안 하고 「지금 자동 분배」 → 먼저 저장 후 분배', async () => {
    const c = boot(route); await c.ready; await tick(700);
    c.d.getElementById('tAsg').click(); await tick();
    c.d.querySelector('#aPeople [data-uid="8"]').click(); await tick(50);
    c.d.getElementById('aRun').click(); await tick(400);
    const iPut = c.calls.findIndex((x) => x.method === 'PUT'); const iRun = c.calls.findIndex((x) => x.u.endsWith('/api/meta-assign/run'));
    assert.ok(iPut >= 0 && iRun > iPut, '저장 → 분배 순서');
    assert.ok(c.calls[iPut].body.members.some((m) => m.user_id === 8));
    c.close();
  });
  await t.test('0330 · 비율(%) 방식 — 전환 · 똑같이 · 합계 · 저장 본문', async () => {
    const c = boot(route); await c.ready; await tick(700);
    c.d.getElementById('tAsg').click(); await tick();
    c.d.querySelector('#aPeople [data-uid="8"]').click(); c.d.querySelector('#aPeople [data-uid="1"]').click(); await tick(50);
    c.d.querySelector('#aMode button[data-m="share"]').click(); await tick(50);
    const pcts = [...c.d.querySelectorAll('#aTargets [data-pct]')].map((i) => Number(i.value));
    assert.equal(pcts.length, 3); assert.equal(pcts.reduce((a, b) => a + b, 0), 100, '똑같이 = 34/33/33');
    assert.match(c.d.getElementById('aTargets').textContent, /합계100%/);
    assert.match(c.d.getElementById('aPool').textContent, /40건 모두/);
    const i8 = c.d.querySelector('#aTargets [data-pct="8"]'); i8.value = '50'; i8.dispatchEvent(new c.w.Event('input', { bubbles: true })); i8.dispatchEvent(new c.w.Event('change', { bubbles: true })); await tick(50);
    assert.match(c.d.getElementById('aTargets').textContent, /100% 가 아니면/);
    c.d.getElementById('aEqual').click(); await tick(50);
    c.d.getElementById('asgSave').click(); await tick();
    const put = c.calls.filter((x) => x.method === 'PUT').pop();
    assert.equal(put.body.mode, 'share');
    assert.deepEqual(put.body.members.map((m) => m.share_pct).sort(), [33, 33, 34]);
    c.close();
  });
  await t.test('1119c · 0건이면 빨간 안내(사라지지 않음)', async () => {
    const r0 = (u, method, body, json) => u.endsWith('/api/meta-assign/run') ? json({ ok: true, assigned: 0, skipped: 'no_members' }) : route(u, method, body, json);
    const c = boot(r0); await c.ready; await tick(700);
    c.d.getElementById('tAsg').click(); await tick();
    c.d.getElementById('aRun').click(); await tick(300);
    assert.match(c.d.getElementById('asgMsg').className, /err/); assert.match(c.d.getElementById('asgMsg').textContent, /대화할 영업사원이 없습니다/);
    c.close();
  });
  await t.test('상세 — 담당 바꾸기 · 메모 추가 · 목록 담당 표시', async () => {
    const c = boot(route); await c.ready; await tick(700);
    assert.match(c.d.getElementById('lTable').textContent, /🙋 Ana/);
    c.d.querySelector('#lTable tr[data-id="5"]').dispatchEvent(new c.w.MouseEvent('click', { bubbles: true })); await tick(300);
    assert.match(c.d.getElementById('oAssign').textContent, /담당/); assert.match(c.d.getElementById('oAssign').textContent, /대화 전/);
    assert.match(c.d.getElementById('oNotes').textContent, /Quiere 4 piezas/);
    const sel = c.d.getElementById('oAsgSel'); sel.value = '8'; sel.dispatchEvent(new c.w.Event('change', { bubbles: true })); await tick();
    assert.deepEqual(c.calls.find((x) => x.u.endsWith('/5/assign')).body, { user_id: 8 });
    c.d.getElementById('oNoteText').value = 'Llamar a las 4'; c.d.getElementById('oNoteAdd').click(); await tick();
    assert.match(c.d.getElementById('oNotes').textContent, /Llamar a las 4/);
    c.close();
  });
});

test('🙋 내 할당 (영업사원)', { skip: SKIP && 'jsdom 또는 HTML 없음' }, async (t) => {
  const route = (u, method, body, json) => {
    if (u.endsWith('/api/meta-assign/config')) return json({ ready: true, is_admin: false, settings: { auto: true }, me: { user_id: 7, member: true, name: 'Ana', daily_target: 15, active: true, today_assigned: 12, today_done: 9, open_n: 3 } });
    if (u.includes('/api/meta-assign/mine')) return json({ user_id: 7, scope: 'today', me: { user_id: 7, name: 'Ana', daily_target: 15, active: true, today_assigned: 12, today_done: 9, open_n: 3 },
      items: [{ id: 5, how: 'auto', assigned_at: NOW, platform: 'whatsapp', name: 'Taller Garza', phone: '8112345601', status: 'nuevo', summary: 'Busca horquilla', notes_n: 0 },
        { id: 6, how: 'manual', assigned_at: NOW, platform: 'messenger', name: 'Lupita', status: 'contactado', done_at: NOW, done_how: 'reply', notes_n: 0 }] });
    if (u.endsWith('/api/meta-leads/5/called')) return json({ ok: true, marked: true, assign: { ...ASSIGN, current: { ...ASSIGN.current, done_at: NOW, done_how: 'call' } } });
    if (u.endsWith('/api/meta-leads/5') && method === 'PATCH') return Object.keys(body).length > 2 ? json({ error: 'read_only' }, 403) : json({ id: 5 });
    if (u.endsWith('/api/meta-leads/5')) return json(LEAD(ASSIGN));
    return null;
  };
  await t.test('탭 · 목표 · 대화 전/대화함 · 📞 전화함 · 읽기 권한 담당자 저장', async () => {
    const c = boot(route, { role: 'sales' }); await c.ready; await tick(700);
    assert.ok(c.d.getElementById('tAsg').classList.contains('hidden'), '영업 = 배분 탭 없음');
    assert.equal(c.d.getElementById('mineN').textContent, '9/12');
    c.d.getElementById('tMine').click(); await tick(300);
    assert.match(c.d.getElementById('mKpis').textContent, /하루 목표15/);
    const ls = c.d.getElementById('mList');
    assert.match(ls.textContent, /⏳ 대화 전/); assert.match(ls.textContent, /✅ 💬 답장/);
    assert.equal(ls.querySelectorAll('button[data-call]').length, 1, '대화 전 것만 📞');
    ls.querySelector('button[data-call]').click(); await tick();
    assert.deepEqual(c.calls.find((x) => x.u.endsWith('/5/called')).body, { note: 'No contesta' });
    ls.querySelector('tr[data-mid="5"]').click(); await tick(300);
    assert.ok(c.d.getElementById('oCall'), '상세에도 📞');
    assert.equal(c.d.getElementById('oAsgSel'), null, '영업은 담당을 못 바꿈');
    c.d.getElementById('eStatus').value = 'contactado'; c.d.getElementById('eSave').click(); await tick(300);
    const p = c.calls.filter((x) => x.method === 'PATCH');
    assert.equal(p.length, 2); assert.deepEqual(Object.keys(p[1].body).sort(), ['note', 'status']);
    assert.match(c.d.getElementById('eMsg').textContent, /상태 · 메모를 저장했습니다/);
    c.close();
  });
});

// 1119e · 같은 id 가 두 번 있으면 버튼이 다른 화면 것에 붙는다(배분 「저장」이 광고 등록 버튼에 붙어 비율 저장이 안 되던 것)
test('화면 id 중복 없음(Meta 광고 문의 · 영업 할당 · 실적 · WhatsApp 마케팅)', { skip: SKIP && 'HTML 없음' }, () => {
  for (const f of ['refatrix-metaleads.html', 'refatrix-leadassign.html', 'refatrix-wapromo.html']) {
    const h = readFileSync(resolve(here, '..', '..', f), 'utf-8').replace(/<script[\s\S]*?<\/script>/g, '');
    const ids = [...h.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
    assert.deepEqual(dup, [], f + ' 중복 id: ' + dup.join(', '));
  }
});
