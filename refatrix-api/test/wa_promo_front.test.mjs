// =====================================================================
// WhatsApp 마케팅 화면 (jsdom, 0260 · 0261 고른 사람에게 보내기 · wap-1008s) — 운영 HTML 을 그대로 띄우고 fetch 만 스텁
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

const CONTACTS = [
  { id: 1, name: 'Juan Pérez', phone: '528110000001', phone_masked: '528****0001', memo: 'Expo', consent: 'yes', consent_via: 'button', consent_at: '2026-10-08T15:00:00Z', lead: false, last_in_at: '2026-10-08T15:00:00Z' },
  { id: 2, name: 'María', phone: '528110000002', phone_masked: '528****0002', memo: '', consent: 'unknown', ask_queued: false },
  { id: 3, name: 'Pedro', phone: '528110000003', phone_masked: '528****0003', memo: '', consent: 'asked', asked_at: '2026-10-08T15:00:00Z' },
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
        if (u.includes('/api/wa-promo/contacts') && method === 'GET') return json({ items: CONTACTS, counts: { total: 3, yes: 1, asked: 1, unknown: 1, no: 0, queued: 0, inbox_open: 2 } });
        if (u.includes('/api/wa-promo/contacts') && method === 'POST') return body.phone ? json({ id: 9 }) : json({ error: 'bad_phone' }, 400);
        if (u.includes('/api/wa-promo/consent/ask')) return json({ queued: body.ids ? body.ids.length : 1, remaining_today: 140, cap: 150 });
        if (u.match(/\/api\/wa-promo\/contacts\/\d+/)) return json({ ...CONTACTS[1], ...body });
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
const click = (c, id) => c.d.getElementById(id).click();
const tab = async (c, p) => { c.d.querySelector(`#tabs .tab[data-p="${p}"]`).click(); await tick(); };

test('WhatsApp 마케팅 화면 (jsdom)', { skip: SKIP && 'jsdom 또는 HTML 없음' }, async (t) => {
  await t.test('① 연락처 — 숫자 · 상태 · 버튼 · 추가 · 동의 요청 · 영업 확인 · 엑셀 미리보기→저장', async () => {
    const c = boot(); await c.ready; await tick(400);
    assert.match(c.d.title, /wap-1008s/);
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
    c.w.eval("S.weekStart='2026-10-12'"); click(c, 'wkToday'); c.w.eval("S.weekStart='2026-10-12'"); c.w.eval('loadCamps()'); await tick();
    assert.match(c.d.getElementById('cal').textContent, /✓ 2\/2 도착/);
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

  await t.test('⑥ 메뉴 등록 · 인라인 onclick 없음', () => {
    const nav = readFileSync(NAV, 'utf-8');
    assert.match(nav, /wapromo:\{file:'refatrix-wapromo\.html'/);
    assert.match(nav, /wapromo:'marketing'/);
    assert.match(nav, /'survey','wapromo'/);
    assert.ok(!/onclick=/.test(readFileSync(HTML, 'utf-8')));
  });
});
