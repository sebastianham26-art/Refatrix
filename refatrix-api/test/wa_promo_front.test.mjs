// =====================================================================
// WhatsApp 마케팅 화면 (jsdom, 0260 · 0261 고른 사람에게 보내기 · wap-1016so) — 운영 HTML 을 그대로 띄우고 fetch 만 스텁
//   실행: node --test test/wa_promo_front.test.mjs   (jsdom 필요)
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const HTML = resolve(here, '..', '..', 'refatrix-wapromo.html');
const NAV = resolve(here, '..', '..', 'refatrix-nav.js');
let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* skip */ }
const SKIP = !JSDOM || !existsSync(HTML);
const tick = (ms = 200) => new Promise((r) => setTimeout(r, ms));

const GROUPS = [{ id: 11, name: 'Talleres MTY', color: '#2a78d6', memo: 'Monterrey', n: 740, yes: 410 }, { id: 12, name: 'Flotillas', color: '#11743b', memo: null, n: 2, yes: 1 }];
const CONTACTS = [
  { id: 1, groups: [11, 12], tipo: 'Taller mecánico', vehiculo: 'Nissan Versa 2019; Nissan March 2017; Chevrolet Aveo 2018', piezas: 'Horquilla (brazo de control)', estado: 'Nuevo León', name: 'Juan Pérez', phone: '528110000001', phone_masked: '528****0001', memo: 'Expo', consent: 'yes', consent_via: 'button', consent_at: '2026-10-08T15:00:00Z', lead: false, last_in_at: '2026-10-08T15:00:00Z' },
  { id: 2, name: 'María', phone: '528110000002', phone_masked: '528****0002', memo: '', consent: 'unknown', ask_queued: false },
  { id: 3, name: 'Pedro', phone: '528110000003', phone_masked: '528****0003', memo: '', consent: 'asked', asked_at: '2026-10-08T15:00:00Z', ask_dlv: 'read', consent_reply: '¿Cuánto cuesta?' },
];
function boot() {
  const calls = [];
  const dom = new JSDOM(readFileSync(HTML, 'utf-8'), {
    runScripts: 'dangerously', url: 'https://example.test/refatrix-wapromo.html',
    beforeParse(w) {
      w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 'T', api: 'https://api.test', user: { name: 'U', role: 'director' } }));
      w.alert = () => {}; w.confirm = () => true; w.scrollTo = () => {}; w.open = () => null;
      w.URL.createObjectURL = () => 'blob:x';
      w.XLSX = { utils: { aoa_to_sheet: () => ({}), book_new: () => ({}), book_append_sheet: () => {}, encode_cell: () => 'A1', sheet_to_json: () => [['Nombre', 'Teléfono'], ['Ana', '8111111111'], ['Luis', '81 2222 2222']] },
        writeFile: (wb, name) => calls.push({ u: 'XLSX:' + name, method: 'FILE' }), read: () => ({ SheetNames: ['S'], Sheets: { S: {} } }) };
      w.fetch = async (url, opt = {}) => {
        const u = String(url); const method = opt.method || 'GET'; const body = opt.body ? JSON.parse(opt.body) : null;
        calls.push({ u, method, body });
        const json = (d, s = 200) => ({ ok: s < 400, status: s, json: async () => d, blob: async () => new w.Blob(['x']) });
        if (u.includes('/api/wa-promo/users')) return json({ items: [{ id: 5, name: 'Maria', role: 'sales_support' }] });
        if (u.includes('/api/wa-promo/contacts/bulk')) return json({ dry_run: body.dry_run !== false, added: 2, rows: body.rows.map((r, i) => ({ i, name: r.name, phone: '52' + r.phone.replace(/\D/g, ''), raw_phone: r.phone, status: 'new' })), summary: { total: 2, new: 2, exists: 0, dup_in_file: 0, bad_phone: 0, no_name: 0 } });
        // 0283 · 그룹
        if (u.endsWith('/api/wa-promo/groups') && method === 'GET') return json({ items: GROUPS, none: { n: 1, yes: 0 } });
        if (u.endsWith('/api/wa-promo/groups') && method === 'POST') return body.name === 'Talleres MTY' ? json({ error: 'group_exists', id: 11 }, 409) : json({ id: 13 });
        if (u.endsWith('/api/wa-promo/groups/assign')) return json({ group_id: body.group_id || 13, created: !body.group_id, action: body.action, matched: 2, changed: 2, unchanged: 0, unknown_phones: body.phones ? ['12'] : [], unknown_n: body.phones ? 1 : 0 });
        if (u.match(/\/api\/wa-promo\/groups\/\d+$/)) return json({ ok: true });
        if (u.includes('/api/wa-promo/audience')) return json({ n: 7 });
        // 0284 · 동의 기록
        if (u.match(/\/api\/wa-promo\/contacts\/\d+\/consent-log/)) return json({ contact: { ...CONTACTS[2], consent: 'asked' }, items: [
          { id: 1, kind: 'queued', at_mx: '2026-10-16T09:00:00', user_name: 'Sebastian' },
          { id: 2, kind: 'asked', via: 'template', message_id: 'wamid.A', at_mx: '2026-10-16T09:01:00', dlv: { status: 'failed', reason: '번호에 WhatsApp 없음' } },
          { id: 3, kind: 'retry', at_mx: '2026-10-16T12:00:00', user_name: 'Sebastian' },
          { id: 4, kind: 'asked', via: 'template', message_id: 'wamid.B', at_mx: '2026-10-16T12:01:00', dlv: { status: 'read', delivered_mx: '2026-10-16T12:01:30', read_mx: '2026-10-16T12:05:00' } },
          { id: 5, kind: 'reply', via: 'message', text: '¿Cuánto cuesta?', at_mx: '2026-10-16T12:06:00' }] });
        if (u.includes('/api/wa-promo/consent/export')) return json({ items: [{ name: 'Pedro', phone: '528110000003', consent: 'asked', asked_mx: '2026-10-16T12:01:00', dlv: 'read', read_mx: '2026-10-16T12:05:00', reply: '¿Cuánto cuesta?', groups: 'Talleres MTY' }] });
        if (u.includes('/api/wa-promo/consent/retry')) return json({ queued: 4, remaining_today: 140, cap: 150 });
        if (u.includes('/api/wa-promo/contacts') && method === 'GET') return json({ items: CONTACTS, counts: { total: 3, yes: 1, asked: 1, unknown: 1, no: 0, queued: 0, inbox_open: 2 }, matched: u.includes('group=11') ? 740 : 3,
          facets: { vehicles: [{ model: 'Nissan Versa', n: 132, yes: 40 }, { model: 'Nissan March', n: 21, yes: 5 }], tipos: [{ tipo: 'Particular', n: 29, yes: 9 }, { tipo: 'Taller mecánico', n: 2, yes: 1 }], no_veh: 70, no_tipo: 166 },
          askable: u.includes('group=11') ? 120 : 1, ask: { sent: 50, delivered: 44, read: 30, failed: 4, noreply: 20, yes: 22, no: 4, send_error: 0 } });
        if (u.includes('/api/wa-promo/contacts') && method === 'POST') return body.phone ? json({ id: 9 }) : json({ error: 'bad_phone' }, 400);
        if (u.includes('/api/wa-promo/consent/ask')) return json({ queued: body.ids ? body.ids.length : 1, remaining_today: 140, cap: 150 });
        if (u.match(/\/api\/wa-promo\/contacts\/\d+/)) return json({ ...CONTACTS[1], ...body });
        // 2026-10-16 · 이미지 뱅크
        if (u.match(/\/api\/wa-promo\/images\/\d+\/history/)) return json({ items: [{ id: 7, send_at_mx: '2026-10-14T10:00', caption: 'Amortiguadores', status: 'done', target_n: 2, image_id: 31, stats: { sent: 2, delivered: 2, read: 1, replied: 1 } }] });
        if (u.match(/\/api\/wa-promo\/images\/\d+\/(thumb|file)/)) return json({});
        if (u.includes('/api/wa-promo/images/bulk')) return json({ updated: body.ids.length });
        if (u.match(/\/api\/wa-promo\/images\/\d+$/)) return json({ ok: true });
        if (u.endsWith('/api/wa-promo/images') && method === 'POST') return json({ id: 40 + calls.filter((x) => x.u.endsWith('/api/wa-promo/images') && x.method === 'POST').length, duplicate: body.name === 'dup.png' });
        if (u.includes('/api/wa-promo/images')) return json({ items: BANK, folders: [{ folder: '2026-11 Versa', n: 1 }, { folder: null, n: 1 }] });
        if (u.includes('/api/wa-promo/campaigns?')) return json({ items: [{ id: 7, send_at_mx: '2026-10-14T10:00', caption: 'Amortiguadores', status: 'done', target_n: 2, stats: { sent: 2, delivered: 2, read: 1, replied: 1 }, image_name: 'a.png', image_bytes: 2048 }], audience_yes: 1 });
        if (u.includes('/api/wa-promo/campaigns/7/sends')) return json({ items: [{ name: 'Juan', phone_masked: '528****0001', status: 'sent_template', dlv_status: 'read', sent_at: '2026-10-14T16:00:00Z' }] });
        if (u.includes('/api/wa-promo/campaigns/7/image')) return json({});
        if (u.includes('/api/wa-promo/campaigns/7/test')) return json({ ok: true, kind: 'template' });
        if (u.includes('/api/wa-promo/campaigns/recent-images')) return json({ items: [{ id: 7, caption: 'Amortiguadores', image_name: 'a.png', send_at_mx: '2026-10-14T10:00' }] });
        if (u.endsWith('/api/wa-promo/campaigns') && method === 'POST') return json({ id: 8, past: !!body.send_now, audience: (body.contact_ids || [1]).length });
        if (u.includes('/api/wa-promo/conversations?')) return json({ items: [{ phone: '528110000002', phone_masked: '528****0002', contact_id: 2, name: 'María', inbox_state: 'open', lead: true, last: { direction: 'in', body: 'Quiero cotizar', at: '2026-10-14T16:20:00Z' }, window_open: true }] });
        if (u.includes('/api/wa-promo/conversations/528110000002/reply')) return json({ ok: true });
        if (u.includes('/api/wa-promo/conversations/528110000002')) return json({ phone: '528110000002', contact: { ...CONTACTS[1], inbox_state: 'open', assigned_to: null }, window: { open: true, last_in_at: new Date().toISOString() },
          items: [{ direction: 'out', source: 'campaign', body: 'Amortiguadores', at: '2026-10-14T16:00:00Z', ok: true, dlv_status: 'read' },
            { direction: 'in', kind: 'button', body: 'Quiero cotizar', at: '2026-10-14T16:20:00Z' },
            { direction: 'out', source: 'autoreply', body: '¡Gracias! Un asesor…', at: '2026-10-14T16:20:01Z', ok: true }] });
        if (u.includes('/api/wa-promo/messages/export')) return json({ items: [{ at_mx: '2026-10-14T10:00', direction: 'in', phone: '528110000002', body: 'hola' }] });
        if (u.includes('/api/wa-promo/autoreplies')) return json({ items: [{ id: 1, sort: 10, keywords: ['si quiero'], is_fallback: false, reply: 'Listo', buttons: [], action: 'consent_yes', active: true },
          { id: 9, sort: 900, keywords: [], is_fallback: true, reply: 'Gracias', buttons: ['Quiero cotizar'], action: 'none', active: true }] });
        if (u.includes('/api/wa-promo/status')) return json({ enabled: true, api_ready: true, cap: 150, sent_today: 12, remaining_today: 138, consent_template: 'promo_consentimiento', image_template: 'promo_imagen', template_lang: 'es_MX', webhook: true, meta: { quality_rating: 'GREEN', verified_name: 'Refatrix' } });
        return json({ items: [] });
      };
    },
  });
  const w = dom.window;
  return { w, d: w.document, calls, close: () => w.close(), ready: new Promise((r) => { if (w.document.readyState === 'complete') r(); else w.addEventListener('load', r); }) };
}
const BANK = [
  { id: 31, name: 'versa_horquilla.jpg', mime: 'image/jpeg', size: 204800, width: 1080, height: 1080, folder: '2026-11 Versa', created_mx: '2026-10-15T09:00', uses: 2, last_used_mx: '2026-10-14T10:00', created_by_name: 'Sebastian' },
  { id: 32, name: 'amortiguador_aveo.png', mime: 'image/png', size: 1048576, width: 1200, height: 628, folder: null, created_mx: '2026-10-16T08:00', uses: 0, last_used_mx: null, created_by_name: 'Maria' }];
const click = (c, id) => c.d.getElementById(id).click();
const tab = async (c, p) => { c.d.querySelector(`#tabs .tab[data-p="${p}"]`).click(); await tick(); };

test('WhatsApp 마케팅 화면 (jsdom)', { skip: SKIP && 'jsdom 또는 HTML 없음' }, async (t) => {
  await t.test('① 연락처 — 숫자 · 상태 · 버튼 · 추가 · 동의 요청 · 영업 확인 · 엑셀 미리보기→저장', async () => {
    const c = boot(); await c.ready; await tick(400);
    assert.match(c.d.title, /wap-1016so/);
    assert.match(c.d.getElementById('cKpis').textContent, /✅ 동의1/);
    assert.equal(c.d.getElementById('inboxN').textContent, '2');
    const tbl = c.d.getElementById('cList').textContent;
    assert.match(tbl, /Juan Pérez/); assert.match(tbl, /버튼/); assert.match(tbl, /⏳ 응답 대기/);
    assert.equal(c.d.querySelectorAll('#cList input[data-sel]').length, 3, '모든 행을 고를 수 있음');
    assert.ok(c.d.querySelector('tr[data-id="2"] button[data-act="ask"]'), '미확인 행: ✉ 동의 요청');
    assert.ok(c.d.querySelector('tr[data-id="1"] button[data-act="send"]'), '동의 행: 📣 보내기');
    assert.ok(!c.d.querySelector('tr[data-id="3"] button[data-act="ask"]') && !c.d.querySelector('tr[data-id="3"] button[data-act="send"]'), '응답 대기 행은 둘 다 없음');
    assert.ok(c.d.getElementById('cSelBar').classList.contains('hidden'), '고른 사람 없으면 선택 막대 숨김');
    c.d.getElementById('cName').value = 'Ana'; c.d.getElementById('cPhone').value = '8111111111'; click(c, 'cAdd'); await tick();
    assert.deepEqual(c.calls.find((x) => x.method === 'POST' && x.u.endsWith('/contacts')).body, { name: 'Ana', phone: '8111111111', memo: '' });
    click(c, 'cAskAll'); await tick();
    assert.deepEqual(c.calls.find((x) => x.u.includes('/consent/ask')).body, {});
    const all = c.d.getElementById('cAll'); all.checked = true; all.dispatchEvent(new c.w.Event('change', { bubbles: true }));
    assert.match(c.d.getElementById('cSelInfo').textContent, /3명 선택 · ✅ 동의 1 · ❓ 미확인 1 · 그 밖 1/);
    assert.match(c.d.getElementById('cSelAsk').textContent, /1명/); assert.match(c.d.getElementById('cSelSend').textContent, /1명/);
    click(c, 'cSelAsk'); await tick();
    assert.deepEqual(c.calls.filter((x) => x.u.includes('/consent/ask')).pop().body, { ids: [2] });
    c.d.querySelector('tr[data-id="2"] button[data-act="sales"]').click(); await tick();
    assert.deepEqual(c.calls.find((x) => x.method === 'PATCH').body, { consent: 'yes' });
    // 엑셀
    const f = c.d.getElementById('cFile');
    Object.defineProperty(f, 'files', { value: [{ name: 'c.xlsx', arrayBuffer: async () => new ArrayBuffer(4) }] });
    f.dispatchEvent(new c.w.Event('change')); await tick(300);
    const dry = c.calls.find((x) => x.u.includes('/contacts/bulk'));
    assert.equal(dry.body.dry_run, true); assert.deepEqual(dry.body.rows.map((r) => r.name), ['Ana', 'Luis']);
    assert.ok(c.d.getElementById('mImport').classList.contains('on'));
    assert.match(c.d.getElementById('mImpSave').textContent, /2명 저장/);
    click(c, 'mImpSave'); await tick();
    assert.equal(c.calls.filter((x) => x.u.includes('/contacts/bulk')).pop().body.dry_run, false);
    c.close();
  });

  await t.test('①-2 고른 사람에게 이미지 — 행의 📣 · 선택 막대 · 지난 이미지 다시 쓰기 · 지금/예약', async () => {
    const c = boot(); await c.ready; await tick(400);
    c.d.querySelector('tr[data-id="1"] button[data-act="send"]').click(); await tick(300);
    assert.ok(c.d.getElementById('mSend').classList.contains('on'));
    assert.match(c.d.getElementById('sdWho').textContent, /Juan Pérez/);
    assert.match(c.d.getElementById('sdCap0').textContent, /138 \/ 150/);
    assert.match(c.d.getElementById('sdGo').textContent, /1명에게 지금 보내기/);
    // 지난 이미지 고르기 → 문구가 비어 있으면 그 문구로
    c.d.querySelector('input[name="sdSrc"][value="old"]').checked = true;
    c.d.querySelector('input[name="sdSrc"][value="old"]').dispatchEvent(new c.w.Event('change', { bubbles: true }));
    assert.ok(!c.d.getElementById('sdOldWrap').classList.contains('hidden'));
    c.d.querySelector('#sdOld [data-old="7"]').click(); await tick();
    assert.equal(c.d.getElementById('sdCap').value, 'Amortiguadores');
    assert.match(c.d.getElementById('sdPhone').textContent, /Novedades de Refatrix: Amortiguadores/);
    click(c, 'sdGo'); await tick(300);
    const post = c.calls.filter((x) => x.method === 'POST' && x.u.endsWith('/api/wa-promo/campaigns')).pop();
    assert.deepEqual(post.body, { caption: 'Amortiguadores', contact_ids: [1], send_now: true, from_campaign_id: 7 });
    assert.ok(!c.d.getElementById('mSend').classList.contains('on'));
    assert.match(c.d.getElementById('msg').textContent, /1분 안에 발송을 시작합니다 — 대상 1명/);
    // 예약 + 새 이미지 없으면 막음
    c.d.querySelector('tr[data-id="1"] button[data-act="send"]').click(); await tick(300);
    c.d.querySelector('input[name="sdWhen"][value="at"]').checked = true;
    c.d.querySelector('input[name="sdWhen"][value="at"]').dispatchEvent(new c.w.Event('change', { bubbles: true }));
    assert.match(c.d.getElementById('sdGo').textContent, /1명에게 예약/);
    c.d.getElementById('sdCap').value = 'hola'; click(c, 'sdGo'); await tick();
    assert.match(c.d.getElementById('sdMsg').textContent, /이미지를 고르세요/);
    c.close();
  });

  await t.test('② 발송 일정 — 주간 달력 · 상세(도착·읽음) · 시험 발송 · 수정 칸 채움', async () => {
    const c = boot(); await c.ready; await tick(400);
    await tab(c, 'camps');
    // 그 주로 이동: 2026-10-14 가 있는 주
    // 스텁은 어느 주를 물어도 같은 발송을 돌려준다 — 10/14 가 들어 있는 주로 맞춘다
    // 2026-10-16 · 월간 달력 — 그달 1일이 든 주 월요일 ~ 말일이 든 주 일요일
    c.w.eval("S.month='2026-10'"); c.w.eval('loadCamps()'); await tick();
    assert.match(c.d.getElementById('cal').textContent, /✓ 2\/2 도착/);
    assert.match(c.d.getElementById('wkTitle').textContent, /2026년 10월/);
    const days = [...c.d.querySelectorAll('#cal [data-day]')].map((x) => x.dataset.day);
    assert.equal(days[0], '2026-09-28'); assert.equal(days[days.length - 1], '2026-11-01'); assert.equal(days.length, 35, '5주');
    assert.ok(c.d.querySelector('#cal [data-day="2026-09-30"]').classList.contains('out'), '다른 달은 흐리게');
    assert.match(c.d.getElementById('moSum').textContent, /완료 1/);
    const fc = c.calls.filter((x) => x.u.includes('/campaigns?from=')).pop().u; assert.match(fc, /from=2026-09-28&to=2026-11-01/);
    const css = readFileSync(HTML, 'utf-8'); assert.match(css, /\.cal\{grid-template-columns:repeat\(7,minmax\(0,1fr\)\)\}/, '이미지 크기에 안 밀리는 7칸');
    click(c, 'wkNext'); await tick(); assert.match(c.d.getElementById('wkTitle').textContent, /11월/); click(c, 'wkPrev'); await tick();
    c.d.querySelector('[data-camp="7"]').click(); await tick(300);
    assert.ok(c.d.getElementById('mCamp').classList.contains('on'));
    assert.match(c.d.getElementById('mcInfo').textContent, /읽음 1/);
    assert.match(c.d.getElementById('mcSends').textContent, /👁 읽음/);
    assert.match(c.d.getElementById('mcPhone').textContent, /Novedades de Refatrix: Amortiguadores/);
    c.d.getElementById('mcTestPhone').value = '8112223333'; click(c, 'mcTest'); await tick();
    assert.deepEqual(c.calls.find((x) => x.u.includes('/campaigns/7/test')).body, { phone: '8112223333' });
    assert.equal(c.d.getElementById('mcEdit').disabled, true, '끝난 발송은 수정 불가');
    c.close();
  });

  await t.test('③ 받은 메시지 — 목록 · 대화(정기 발송 · 버튼 · 자동응답) · 답장 · 처리 완료 · 엑셀', async () => {
    const c = boot(); await c.ready; await tick(400);
    await tab(c, 'inbox');
    assert.match(c.d.getElementById('iList').textContent, /María/);
    c.d.querySelector('#iList [data-phone]').click(); await tick(300);
    const chat = c.d.getElementById('vChat');
    assert.equal(chat.querySelectorAll('.b.camp').length, 1); assert.equal(chat.querySelectorAll('.b.bot').length, 1); assert.equal(chat.querySelectorAll('.b.in').length, 1);
    assert.match(chat.textContent, /👁 읽음/);
    c.d.getElementById('vText').value = 'Claro'; click(c, 'vSend'); await tick();
    assert.deepEqual(c.calls.find((x) => x.u.includes('/reply')).body, { text: 'Claro' });
    click(c, 'vDone'); await tick();
    assert.deepEqual(c.calls.filter((x) => x.method === 'PATCH').pop().body, { inbox_state: 'done', lead: false });
    click(c, 'xExport'); await tick();
    assert.ok(c.calls.some((x) => x.u.startsWith('XLSX:refatrix_whatsapp_mensajes_')));
    c.close();
  });

  await t.test('④ 자동응답 · ⑤ 설정 — 규칙 표 · 저장 · 상한/템플릿/품질', async () => {
    const c = boot(); await c.ready; await tick(400);
    await tab(c, 'rules');
    assert.match(c.d.getElementById('rList').textContent, /그 밖의 모든 말/);
    c.d.querySelector('tr[data-id="1"] button[data-act="save"]').click(); await tick();
    const pt = c.calls.find((x) => x.method === 'PATCH' && x.u.includes('/autoreplies/1'));
    assert.deepEqual(Object.keys(pt.body).sort(), ['action', 'active', 'buttons', 'keywords', 'reply', 'sort']);
    await tab(c, 'setup');
    const k = c.d.getElementById('sKpis').textContent;
    assert.match(k, /12 \/ 150/); assert.match(k, /promo_consentimiento/); assert.match(k, /높음/);
    c.close();
  });

  await t.test('⑦ 이미지 뱅크 — 목록(썸네일 · 이름) · 보기 크기 · 여러 장 올리기(중복) · 크게 보기 · 광고 이력 · 달력에 끌어다 놓기 · 뱅크 이미지로 예약', async () => {
    const c = boot(); await c.ready; await tick(400);
    await tab(c, 'bank');
    const grid = () => c.d.getElementById('bGrid');
    assert.equal(grid().querySelectorAll('[data-bid]').length, 2);
    assert.match(grid().textContent, /versa_horquilla\.jpg/); assert.match(grid().textContent, /사용 2회/);
    assert.ok(grid().querySelector('img[data-th="31"]'), '썸네일');
    c.d.querySelector('#bView button[data-v="s"]').click(); await tick(50); assert.ok(grid().querySelector('.bgrid.v-s'), '작은 아이콘');
    c.d.querySelector('#bView button[data-v="xl"]').click(); await tick(50); assert.ok(grid().querySelector('.bgrid.v-xl'), '아주 큰 아이콘');
    c.d.querySelector('#bView button[data-v="d"]').click(); await tick(50); assert.match(grid().textContent, /1080×1080/, '자세히 = 표(해상도)');
    c.d.getElementById('bSort').value = 'name'; c.d.getElementById('bSort').dispatchEvent(new c.w.Event('change')); await tick(50);
    assert.deepEqual([...grid().querySelectorAll('tr[data-bid]')].map((x) => x.dataset.bid), ['32', '31'], '이름순');
    c.d.getElementById('bFolder').value = '2026-11 Versa'; c.d.getElementById('bFolder').dispatchEvent(new c.w.Event('change')); await tick(50);
    assert.equal(grid().querySelectorAll('tr[data-bid]').length, 1, '폴더 거르기');
    c.d.getElementById('bFolder').value = ''; c.d.getElementById('bFolder').dispatchEvent(new c.w.Event('change')); await tick(50);
    // 여러 장 올리기 — 폴더 · 중복은 「이미 있음」 · JPG/PNG 아닌 것은 캔버스 없으면 실패로
    c.d.getElementById('bUpFolder').value = '2026-11 Versa';
    const F = (n, t) => new c.w.File(['abc'], n, { type: t });
    await c.w.eval('uploadFiles')([F('a.jpg', 'image/jpeg'), F('dup.png', 'image/png'), F('b.webp', 'image/webp')]); await tick();
    const ups = c.calls.filter((x) => x.u.endsWith('/api/wa-promo/images') && x.method === 'POST');
    assert.equal(ups.length, 2); assert.equal(ups[0].body.folder, '2026-11 Versa'); assert.ok(ups[0].body.image_b64); assert.equal(ups[0].body.mime, 'image/jpeg');
    assert.match(c.d.getElementById('bProgT').textContent, /저장 1장 · 이미 있던 같은 파일 1장 · 실패 1장/);
    // 크게 보기 + 광고 이력
    grid().querySelector('[data-bid="31"]').click(); await tick(200);
    assert.ok(c.d.getElementById('mImg').classList.contains('on'));
    assert.equal(c.d.getElementById('miName').value, 'versa_horquilla.jpg');
    assert.match(c.d.getElementById('miHist').textContent, /2026-10-14 10:00/); assert.match(c.d.getElementById('miHist').textContent, /✓ 2\/2 도착/);
    c.d.getElementById('miFolder').value = 'Promo'; click(c, 'miSave'); await tick();
    assert.deepEqual(c.calls.filter((x) => x.method === 'PATCH' && x.u.includes('/images/31')).pop().body, { name: 'versa_horquilla.jpg', folder: 'Promo', memo: '' });
    click(c, 'miUse'); await tick(200);
    assert.ok(c.d.getElementById('p-camps').classList.contains('on'), '발송 일정으로');
    assert.match(c.d.getElementById('kBankSel').textContent, /versa_horquilla\.jpg/);
    c.d.getElementById('kDate').value = '2099-01-05'; c.d.getElementById('kCap').value = 'Horquillas Versa'; click(c, 'kSave'); await tick();
    const cp = c.calls.filter((x) => x.u.endsWith('/api/wa-promo/campaigns') && x.method === 'POST').pop().body;
    assert.equal(cp.image_id, 31); assert.equal(cp.image_b64, undefined); assert.equal(cp.send_at, '2099-01-05T10:00');
    // 달력: 뱅크 띠의 그림을 날짜로 끌어다 놓기
    await tick(200);
    assert.ok(c.d.querySelector('#calStrip [data-bimg="32"]'), '달력 위 이미지 띠');
    c.w.eval("S.month='2099-01'"); c.w.eval('loadCamps()'); await tick();
    const day = c.d.querySelector('#cal [data-day="2099-01-12"]');
    const drop = new c.w.Event('drop', { bubbles: true, cancelable: true }); Object.defineProperty(drop, 'dataTransfer', { value: { getData: () => 'wa-image:32' } });
    day.dispatchEvent(drop); await tick(100);
    assert.equal(c.d.getElementById('kDate').value, '2099-01-12'); assert.match(c.d.getElementById('kBankSel').textContent, /amortiguador_aveo\.png/);
    // 누르고 → 날짜 누르기
    c.d.querySelector('#calStrip [data-bimg="31"]').click(); c.d.querySelector('#cal [data-day="2099-01-20"]').click(); await tick(100);
    assert.equal(c.d.getElementById('kDate').value, '2099-01-20'); assert.match(c.d.getElementById('kBankSel').textContent, /versa_horquilla/);
    // 고르기 창(뱅크에서)
    click(c, 'kBank'); await tick(100); assert.ok(c.d.getElementById('mPick').classList.contains('on'));
    c.d.querySelector('#pkGrid [data-pk="32"]').click(); await tick(100); assert.match(c.d.getElementById('kBankSel').textContent, /amortiguador_aveo/);
    // 📜 광고 이력 — 날짜별
    await tab(c, 'bank'); c.d.querySelector('#bMode button[data-m="hist"]').click(); await tick();
    assert.match(c.d.getElementById('hList').textContent, /2026-10-14 \(수\)/); assert.match(c.d.getElementById('hList').textContent, /Amortiguadores/);
    assert.match(c.calls.filter((x) => x.u.includes('/campaigns?from=')).pop().u, /cancelled=1/);
    // 여러 장 골라 지우기
    c.d.querySelector('#bMode button[data-m="imgs"]').click(); await tick();
    c.d.querySelector('#bView button[data-v="m"]').click(); await tick(50);
    grid().querySelector('[data-ck="31"]').click(); grid().querySelector('[data-ck="32"]').click(); await tick(50);
    assert.match(c.d.getElementById('bSelN').textContent, /2장 선택/);
    click(c, 'bDel'); await tick();
    assert.deepEqual(c.calls.filter((x) => x.u.includes('/images/bulk')).pop().body, { ids: [31, 32], action: 'delete' });
    c.close();
  });

  await t.test('⑧ 0283 연락처 그룹 — 칩 · 표 · 거르기 · 일괄 구분(고른 사람/조건 전체/번호) · 관리 · 엑셀 저장 때 그룹 · 그룹 대상 예약', async () => {
    const c = boot(); await c.ready; await tick(400);
    const bar = c.d.getElementById('cGroups');
    assert.match(bar.textContent, /전체 3/); assert.match(bar.textContent, /Talleres MTY 740 · ✅410/); assert.match(bar.textContent, /그룹 없음 1/);
    assert.equal(c.d.querySelectorAll('tr[data-id="1"] .gtag').length, 2, '표에 그룹 태그');
    // 칩으로 거르기 → 서버에 group=11 · 500명 넘으면 안내
    bar.querySelector('[data-g="11"]').click(); await tick(300);
    assert.ok(c.calls.some((x) => x.u.includes('/api/wa-promo/contacts?group=11')));
    assert.ok(bar.querySelector('[data-g="11"]').classList.contains('on'));
    assert.match(c.d.getElementById('cList').textContent, /조건에 맞는 740명 중 최근 3명만/);
    // 조건 전체 → 다른 그룹에 넣기
    click(c, 'cGroupBulk'); await tick();
    assert.ok(c.d.getElementById('mGAssign').classList.contains('on'));
    assert.match(c.d.getElementById('gaFilterL').textContent, /740명/); assert.match(c.d.getElementById('gaFilterL').textContent, /그룹 「Talleres MTY」/);
    assert.ok(c.d.querySelector('input[name="gaMode"][value="sel"]').disabled, '고른 사람 없으면 막힘');
    assert.ok(c.d.querySelector('input[name="gaMode"][value="filter"]').checked);
    c.d.getElementById('gaGroup').value = '12'; click(c, 'gaAdd'); await tick(300);
    assert.deepEqual(c.calls.filter((x) => x.u.endsWith('/groups/assign')).pop().body, { action: 'add', group_id: 12, filter: { group: '11' } });
    assert.ok(!c.d.getElementById('mGAssign').classList.contains('on'));
    // 고른 사람 → 새 그룹 이름으로
    bar.querySelector('[data-g=""]').click(); await tick(300);
    const ck = c.d.querySelector('tr[data-id="2"] input[data-sel]'); ck.checked = true; ck.dispatchEvent(new c.w.Event('change', { bubbles: true }));
    click(c, 'cSelGroup'); await tick();
    assert.ok(c.d.querySelector('input[name="gaMode"][value="sel"]').checked); assert.match(c.d.getElementById('gaSelL').textContent, /1명/);
    const gs = c.d.getElementById('gaGroup'); gs.value = '__new'; gs.dispatchEvent(new c.w.Event('change'));
    assert.ok(!c.d.getElementById('gaNewWrap').classList.contains('hidden'));
    c.d.getElementById('gaNew').value = 'Expo 2026'; click(c, 'gaAdd'); await tick(300);
    assert.deepEqual(c.calls.filter((x) => x.u.endsWith('/groups/assign')).pop().body, { action: 'add', group_name: 'Expo 2026', ids: [2] });
    // 번호 붙여넣기 · 모르는 번호는 창에 남겨 보여줌 · 빼기
    click(c, 'cGroupBulk'); await tick();
    const ph = c.d.querySelector('input[name="gaMode"][value="phones"]'); ph.checked = true; ph.dispatchEvent(new c.w.Event('change', { bubbles: true }));
    assert.ok(!c.d.getElementById('gaPhones').classList.contains('hidden'));
    c.d.getElementById('gaPhones').value = '8110000001\n12'; c.d.getElementById('gaGroup').value = '11'; click(c, 'gaRemove'); await tick(300);
    assert.deepEqual(c.calls.filter((x) => x.u.endsWith('/groups/assign')).pop().body, { action: 'remove', group_id: 11, phones: '8110000001\n12' });
    assert.ok(c.d.getElementById('mGAssign').classList.contains('on'), '모르는 번호가 있으면 창 유지');
    assert.match(c.d.getElementById('gaMsg').textContent, /연락처에 없는 번호 1개: 12/);
    // 관리 — 만들기 · 저장 · 삭제
    bar.querySelector('[data-gmgr]').click(); await tick();
    assert.ok(c.d.getElementById('mGroups').classList.contains('on'));
    assert.equal(c.d.querySelectorAll('#gList tr[data-gid]').length, 2);
    c.d.getElementById('gNewName').value = 'Refacc Mérida'; click(c, 'gCreate'); await tick(300);
    assert.equal(c.calls.filter((x) => x.method === 'POST' && x.u.endsWith('/api/wa-promo/groups')).pop().body.name, 'Refacc Mérida');
    const row = c.d.querySelector('#gList tr[data-gid="12"]'); row.querySelector('[data-gf="name"]').value = 'Flotas'; row.querySelector('[data-gsave]').click(); await tick(300);
    assert.deepEqual(c.calls.filter((x) => x.method === 'PATCH' && x.u.endsWith('/groups/12')).pop().body, { name: 'Flotas', color: '#11743b', memo: '' });
    c.d.querySelector('#gList tr[data-gid="12"] [data-gdel]').click(); await tick(300);
    assert.ok(c.calls.some((x) => x.method === 'DELETE' && x.u.endsWith('/groups/12')));
    c.d.getElementById('mGroups').classList.remove('on');
    // 엑셀 저장 때 그룹 — 새 그룹 이름이 이미 있으면 그 그룹으로
    const f = c.d.getElementById('cFile');
    Object.defineProperty(f, 'files', { value: [{ name: 'c.xlsx', arrayBuffer: async () => new ArrayBuffer(4) }] });
    f.dispatchEvent(new c.w.Event('change')); await tick(300);
    const ig = c.d.getElementById('mImpGroup'); assert.match(ig.options[0].textContent, /넣지 않음/);
    ig.value = '__new'; ig.dispatchEvent(new c.w.Event('change'));
    assert.match(c.d.getElementById('mImpSave').textContent, /저장 \+ 그룹에 넣기/);
    c.d.getElementById('mImpNewG').value = 'Talleres MTY'; click(c, 'mImpSave'); await tick(300);
    const sv = c.calls.filter((x) => x.u.includes('/contacts/bulk')).pop().body; assert.equal(sv.dry_run, false); assert.equal(sv.group_id, 11);
    // 그룹 대상 예약 — 대상 수 미리보기 · target_groups
    await tab(c, 'camps'); await tick(300);
    const aud = c.d.getElementById('kAud'); aud.value = 'group'; aud.dispatchEvent(new c.w.Event('change'));
    assert.ok(!c.d.getElementById('kGroupWrap').classList.contains('hidden'));
    assert.match(c.d.getElementById('kAudN').textContent, /하나 이상/);
    const k11 = c.d.querySelector('#kGroups input[value="11"]'); k11.checked = true; k11.dispatchEvent(new c.w.Event('change', { bubbles: true })); await tick(400);
    assert.ok(c.calls.some((x) => x.u.includes('/audience?groups=11')));
    assert.match(c.d.getElementById('kAudN').textContent, /✅ 동의 7명/);
    c.d.getElementById('kDate').value = '2099-01-05'; c.d.getElementById('kCap').value = 'Promo talleres';
    const img = c.d.getElementById('kImg'); Object.defineProperty(img, 'files', { value: [new c.w.File(['x'], 'a.png', { type: 'image/png' })] });
    click(c, 'kSave'); await tick(400);
    const cb = c.calls.filter((x) => x.method === 'POST' && x.u.endsWith('/api/wa-promo/campaigns')).pop().body;
    assert.deepEqual(cb.target_groups, [11]); assert.equal(cb.memo_filter, '');
    c.close();
  });

  await t.test('⑨ 0284 수신 동의 — 요청 현황 · 조건으로 요청 · 전달 상태 · 회신 원문 · 기록 창 · 실패 다시 요청 · 엑셀', async () => {
    const c = boot(); await c.ready; await tick(400);
    const fun = c.d.getElementById('cAskFun').textContent;
    assert.match(fun, /요청 보냄50/); assert.match(fun, /도착44/); assert.match(fun, /읽음30/); assert.match(fun, /회신 동의22/); assert.match(fun, /응답 없음20/); assert.match(fun, /전달 실패4/);
    assert.match(c.d.getElementById('cAskAll').textContent, /^✉ 미확인 1명에게/);
    const row = c.d.querySelector('tr[data-id="3"]').textContent;
    assert.match(row, /👁 읽음/); assert.match(row, /¿Cuánto cuesta\?/);
    // 그룹 조건 → 「지금 조건의 미확인 120명」 → 조건으로 요청
    c.d.querySelector('#cGroups [data-g="11"]').click(); await tick(300);
    assert.match(c.d.getElementById('cAskAll').textContent, /지금 조건의 미확인 120명/);
    click(c, 'cAskAll'); await tick();
    assert.deepEqual(c.calls.filter((x) => x.u.includes('/consent/ask')).pop().body, { filter: { group: '11' } });
    // 현황의 「전달 실패」 → 거르기
    c.d.querySelector('#cAskFun [data-ask="failed"]').click(); await tick(300);
    assert.equal(c.d.getElementById('cAsk').value, 'failed');
    assert.ok(c.calls.some((x) => x.u.includes('/api/wa-promo/contacts?') && x.u.includes('ask=failed')));
    // 실패 다시 요청
    click(c, 'cRetry'); await tick();
    assert.ok(c.calls.some((x) => x.method === 'POST' && x.u.endsWith('/consent/retry')));
    assert.match(c.d.getElementById('msg').textContent, /4명을 다시/);
    // 기록 창
    c.d.querySelector('tr[data-id="3"] button[data-act="clog"]').click(); await tick(300);
    assert.ok(c.d.getElementById('mCLog').classList.contains('on'));
    const lg = c.d.getElementById('clList').textContent;
    assert.match(lg, /요청 대기열에 넣음/); assert.match(lg, /Sebastian/); assert.match(lg, /전달 실패 — 번호에 WhatsApp 없음/);
    assert.match(lg, /다시 요청/); assert.match(lg, /👁 읽음 10-16 12:05/); assert.match(lg, /「¿Cuánto cuesta\?」/);
    assert.equal(c.d.querySelectorAll('#clList li').length, 5);
    // 엑셀 — 지금 조건
    click(c, 'cConsentXls'); await tick();
    assert.ok(c.calls.some((x) => x.u.includes('/consent/export?') && x.u.includes('group=11') && x.u.includes('ask=failed')));
    assert.ok(c.calls.some((x) => /XLSX:refatrix_whatsapp_consentimiento_/.test(x.u)));
    c.close();
  });

  await t.test('⑩ 0285 Meta 문의 엑셀 머리글 — Estado · Vehículo (año) · Piezas buscadas (Estatus 는 아님)', () => {
    const src = readFileSync(HTML, 'utf-8');
    const hdr = src.match(/const HDR=\{[\s\S]*?\};/)[0]; const fn = src.match(/function rowsFromSheet\(aoa\)\{[\s\S]*?\n  \}/)[0];
    const rowsFromSheet = new Function(hdr + fn + '; return rowsFromSheet;')();
    const aoa = [['Último mensaje', 'Nombre', 'Canal', 'Tipo de cliente', 'Estado', 'Ciudad', 'Teléfono', 'Vehículo (año)', 'Piezas buscadas', 'Estatus', 'Nota'],
      ['2026-10-15', 'Ismael', 'WhatsApp', 'Particular', 'Nuevo León', 'Monterrey', '7223451302', 'Nissan Versa 2024', 'Horquilla (brazo de control)', 'Nuevo', '']];
    assert.deepEqual(rowsFromSheet(aoa), [{ name: 'Ismael', phone: '7223451302', memo: '', estado: 'Nuevo León', vehiculo: 'Nissan Versa 2024', piezas: 'Horquilla (brazo de control)', tipo: 'Particular' }]);
    assert.deepEqual(rowsFromSheet([['Nombre', 'Teléfono'], ['Ana', '8111111111']]), [{ name: 'Ana', phone: '8111111111', memo: '', estado: '', vehiculo: '', piezas: '', tipo: '' }]);
  });

  await t.test('⑪ 0286 직업 · 관심 차종 — 표 칸 · 차종/직업 칩 거르기 · ✏ 고치기 · 표 넘침 방지', async () => {
    const c = boot(); await c.ready; await tick(400);
    const r1 = c.d.querySelector('tr[data-id="1"]');
    assert.equal(r1.querySelector('.ttag').textContent, 'Taller mecánico');
    const vc = [...r1.querySelectorAll('.vchip')].map((x) => x.textContent);
    assert.deepEqual(vc, ['🚗 Nissan Versa 2019', '🚗 Nissan March 2017', '+1'], '두 대 + 나머지 수');
    assert.match(r1.textContent, /🔧 Horquilla/); assert.match(r1.textContent, /📍 Nuevo León/);
    assert.ok(c.d.querySelector('#cList table.ctbl'), '칸 폭 고정 표'); assert.equal(c.d.querySelectorAll('#cList colgroup col').length, 8);
    assert.ok(r1.querySelector('button.ib[data-act="send"]') && r1.querySelector('button.ib[data-act="edit"]'), '아이콘 버튼');
    assert.ok(![...r1.querySelectorAll('td.acts button')].some((b) => b.textContent.length > 2), '동작 칸은 아이콘만(글자 없음)');
    const css = c.d.querySelector('style').textContent;
    assert.match(css, /#cList\{max-height:min\(66vh,760px\);overflow:auto/); assert.match(css, /position:sticky;top:0/);
    // 칩
    const vb = c.d.getElementById('cVehBar'); assert.match(vb.textContent, /Nissan Versa132/); assert.match(vb.textContent, /차종 없음70/);
    assert.match(c.d.getElementById('cTipoBar').textContent, /Particular29/);
    vb.querySelector('[data-v="Nissan Versa"]').click(); await tick(300);
    assert.ok(c.calls.some((x) => x.u.includes('/api/wa-promo/contacts?') && x.u.includes('veh=Nissan+Versa')));
    c.d.querySelector('#cTipoBar [data-v="Particular"]').click(); await tick(300);
    assert.ok(c.calls.some((x) => x.u.includes('veh=Nissan+Versa') && x.u.includes('tipo=Particular')));
    click(c, 'cGroupBulk'); await tick();
    assert.match(c.d.getElementById('gaFilterL').textContent, /🚗 Nissan Versa · 💼 Particular/);
    c.d.getElementById('mGAssign').classList.remove('on');
    // ✏ 고치기
    c.d.querySelector('tr[data-id="1"] button[data-act="edit"]').click(); await tick();
    assert.ok(c.d.getElementById('mCEdit').classList.contains('on'));
    assert.equal(c.d.getElementById('ceTipo').value, 'Taller mecánico'); assert.equal(c.d.getElementById('ceVeh').value, 'Nissan Versa 2019; Nissan March 2017; Chevrolet Aveo 2018');
    assert.ok(c.d.querySelectorAll('#ceEstadoList option').length >= 32);
    c.d.getElementById('ceTipo').value = 'Flotilla'; c.d.getElementById('ceVeh').value = 'Nissan Versa 2020'; click(c, 'ceSave'); await tick(300);
    const pb = c.calls.filter((x) => x.method === 'PATCH' && x.u.endsWith('/contacts/1')).pop().body;
    assert.deepEqual(pb, { name: 'Juan Pérez', tipo: 'Flotilla', vehiculo: 'Nissan Versa 2020', estado: 'Nuevo León', piezas: 'Horquilla (brazo de control)', memo: 'Expo' });
    assert.ok(!c.d.getElementById('mCEdit').classList.contains('on'));
    c.close();
  });

  await t.test('⑫ 표 제목 눌러 정렬 — 오름 → 내림 → 풀기 · 서버에 sort/dir · 표시 ▲▼', async () => {
    const c = boot(); await c.ready; await tick(400);
    const th = () => c.d.querySelector('#cList th[data-sort="tipo"]');
    assert.equal(c.d.querySelectorAll('#cList th[data-sort]').length, 6);
    const last = () => c.calls.filter((x) => x.u.includes('/api/wa-promo/contacts?') || x.u.endsWith('/api/wa-promo/contacts')).pop().u;
    th().click(); await tick(300);
    assert.match(last(), /sort=tipo&dir=asc/); assert.match(th().textContent, /▲/); assert.equal(th().getAttribute('aria-sort'), 'ascending');
    th().click(); await tick(300);
    assert.match(last(), /sort=tipo&dir=desc/); assert.match(th().textContent, /▼/);
    th().click(); await tick(300);
    assert.ok(!/sort=/.test(last()), '세 번째 = 기본'); assert.match(th().textContent, /↕/);
    c.d.querySelector('#cList th[data-sort="when"]').click(); await tick(300);
    assert.match(last(), /sort=when&dir=desc/, '날짜는 최근부터');
    // 그룹 일괄 구분 · 동의 요청 조건에는 정렬이 끼지 않음
    click(c, 'cConsentXls'); await tick();
    assert.ok(!/sort=/.test(c.calls.filter((x) => x.u.includes('/consent/export')).pop().u));
    c.close();
  });

  await t.test('⑥ 메뉴 등록 · 인라인 onclick 없음', () => {
    const nav = readFileSync(NAV, 'utf-8');
    assert.match(nav, /wapromo:\{file:'refatrix-wapromo\.html'/);
    assert.match(nav, /wapromo:'__socio_or__wapromo'/, '디렉터 · 소시오 항상 + 사용자별 wapromo');
    assert.match(readFileSync(resolve(here, '..', '..', 'refatrix-users.html'), 'utf-8'), /\['wapromo','WhatsApp 마케팅/, '관리자 화면 권한 목록');
    // canSee 실제 실행 — 마케팅(wapromo 없음) 숨김 · 있음 보임 · 소시오 항상
    const body = nav.match(/function canSee\(key\)\{[\s\S]*?\n  \}/)[0];
    const mk = (sum) => new Function('sum', 'PAGEKEY', 'ROLE_HIDE_SCREENS', body + '; return canSee;')(sum, { wapromo: '__socio_or__wapromo' }, {});
    assert.equal(mk({ role: 'marketing', pages: ['marketing'] })('wapromo'), false);
    assert.equal(mk({ role: 'marketing', pages: ['marketing', 'wapromo'] })('wapromo'), true);
    assert.equal(mk({ role: 'socio', pages: [] })('wapromo'), true);
    assert.equal(mk({ role: 'sales', pages: [] })('wapromo'), false);
    assert.match(nav, /'survey','wapromo'/);
    assert.ok(!/onclick=/.test(readFileSync(HTML, 'utf-8')));
  });
});
