// =====================================================================
// wa_erp_media_front.test.mjs — 1111 · 화면(jsdom): WhatsApp 마케팅 › 받은 메시지 · Meta 광고 문의
//   사진 · 음성 · PDF 말풍선 · 📎 보내기 · 창 닫힘 = 📞 전화하기 · 번호 복사 · 새 메시지 알림(탭 숫자 · 제목 (N)) · 바로 열기 링크
//   실행: node --test test/wa_erp_media_front.test.mjs
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const WAP = resolve(here, '..', '..', 'refatrix-wapromo.html');
const MTL = resolve(here, '..', '..', 'refatrix-metaleads.html');
let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* skip */ }
const SKIP = !JSDOM || !existsSync(WAP) || !existsSync(MTL);
const tick = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const NOW = () => new Date(Date.now() - 3600000).toISOString();

function boot(file, url, route) {
  const calls = [];
  const dom = new JSDOM(readFileSync(file, 'utf-8').replace(/<script src="https:\/\/cdn[^>]+><\/script>/, ''), {
    runScripts: 'dangerously', url,
    beforeParse(w) {
      w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 'T', api: 'https://api.test', user: { name: 'U', role: 'director' } }));
      w.alert = () => {}; w.confirm = () => true; w.scrollTo = () => {}; w.open = (u) => { calls.push({ u: 'OPEN:' + u, method: 'OPEN' }); return null; };
      w.URL.createObjectURL = () => 'blob:media';
      w.HTMLMediaElement.prototype.load = () => {};
      w.fetch = async (u0, opt = {}) => {
        const u = String(u0); const method = opt.method || 'GET'; const body = opt.body ? JSON.parse(opt.body) : null;
        calls.push({ u, method, body });
        const json = (d, s = 200) => ({ ok: s < 400, status: s, json: async () => d, blob: async () => new w.Blob(['x'], { type: 'image/jpeg' }) });
        const r = route(u, method, body, json); if (r) return r;
        return json({ items: [] });
      };
    },
  });
  const w = dom.window;
  return { w, d: w.document, calls, close: () => w.close(), ready: new Promise((r) => { if (w.document.readyState === 'complete') r(); else w.addEventListener('load', r); }) };
}

const CONV = (open) => ({ phone: '528112345601', contact: null, window: { open, last_in_at: open ? NOW() : '2026-11-08T15:00:00Z' },
  items: [
    { id: 1, direction: 'in', kind: 'text', body: 'Hola, busco amortiguadores', at: '2026-11-11T15:00:00Z', media: false },
    { id: 2, direction: 'in', kind: 'image', body: '[image]', at: '2026-11-11T15:01:00Z', media: true },
    { id: 3, direction: 'in', kind: 'audio', body: '[audio]', at: '2026-11-11T15:02:00Z', media: true },
    { id: 4, direction: 'in', kind: 'document', body: 'cotizacion.pdf', at: '2026-11-11T15:03:00Z', media: true },
    { id: 5, direction: 'in', kind: 'image', body: '[image]', at: '2026-11-11T15:04:00Z', media: true },
    { id: 6, direction: 'out', kind: 'image', body: 'Este es el kit', source: 'manual', ok: true, at: '2026-11-11T15:05:00Z', media: true }] });

test('WhatsApp 마케팅 › 받은 메시지 (jsdom)', { skip: SKIP && 'jsdom 또는 HTML 없음' }, async (t) => {
  let open = true; let pulseN = 0;
  const route = (u, method, body, json) => {
    if (u.includes('/api/wa-promo/inbox/pulse')) { pulseN++; return json(pulseN === 1 ? { last_id: 100, new: 0, waiting: 3, latest: [] }
      : { last_id: 102, new: 2, waiting: 4, latest: [{ id: 102, phone: '528112345601', name: 'Cliente', kind: 'text', body: 'hola?' }] }); }
    if (u.includes('/api/wa-promo/media/5')) return json({ error: 'media_expired' }, 410);
    if (u.includes('/api/wa-promo/conversations?')) return json({ items: [{ phone: '528112345601', phone_masked: '528****5601', contact_id: null, name: null, last: { direction: 'in', body: '[image]', at: NOW() }, window_open: open }] });
    if (u.includes('/media') && method === 'POST') return json({ ok: true, media_id: 'UP1' });
    if (u.includes('/api/wa-promo/conversations/528112345601')) return json(CONV(open));
    return null;
  };

  await t.test('사진 · 음성 · PDF 말풍선 · 지워진 파일 · 바로 열기(#tab=inbox&phone) · 📎 보내기', async () => {
    const c = boot(WAP, 'https://example.test/refatrix-wapromo.html#tab=inbox&phone=528112345601', route); await c.ready; await tick(600);
    assert.match(c.d.title, /wap-1111a/);
    const chat = c.d.getElementById('vChat'); assert.ok(chat, '링크로 대화가 바로 열림');
    assert.equal(chat.querySelectorAll('img.wm').length, 2, '받은 사진 1 + 보낸 사진 1(지워진 1 은 안내로)');
    assert.equal(chat.querySelector('img.wm').getAttribute('src'), 'blob:media');
    assert.equal(chat.querySelectorAll('audio.wm').length, 1);
    assert.match(chat.querySelector('a.wdoc').textContent, /cotizacion\.pdf/);
    assert.match(chat.textContent, /Meta 에서 지워짐/);
    assert.ok(!/\[image\]|\[audio\]/.test(chat.textContent), '[image] 같은 표시는 안 보임');
    assert.match(chat.textContent, /Este es el kit/);
    chat.querySelector('a.wdoc').click(); await tick();
    assert.ok(c.calls.some((x) => x.u === 'OPEN:blob:media'), 'PDF 열기');
    assert.ok(c.d.getElementById('vAttach'), '📎 버튼');
    // 파일 보내기
    const f = new c.w.File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'kit.png', { type: 'image/png' });
    c.d.getElementById('vText').value = 'Mire este kit';
    Object.defineProperty(c.d.getElementById('vFile'), 'files', { value: [f], configurable: true });
    c.d.getElementById('vFile').dispatchEvent(new c.w.Event('change')); await tick(400);
    const sent = c.calls.find((x) => x.method === 'POST' && x.u.endsWith('/conversations/528112345601/media'));
    assert.ok(sent, 'media 로 보냄'); assert.equal(sent.body.mime, 'image/png'); assert.equal(sent.body.caption, 'Mire este kit'); assert.equal(sent.body.name, 'kit.png'); assert.ok(sent.body.data_b64.length > 0);
    // 형식 거부
    const bad = new c.w.File(['x'], 'a.webp', { type: 'image/webp' });
    Object.defineProperty(c.d.getElementById('vFile'), 'files', { value: [bad], configurable: true });
    c.d.getElementById('vFile').dispatchEvent(new c.w.Event('change')); await tick();
    assert.match(c.d.getElementById('vMsg').textContent, /JPG · PNG 사진 또는 PDF/);
    c.close();
  });

  await t.test('창 닫힘 — 📞 전화하기(tel:) · 번호 복사 · 입력칸 없음', async () => {
    open = false;
    const c = boot(WAP, 'https://example.test/refatrix-wapromo.html#tab=inbox&phone=528112345601', route); await c.ready; await tick(600);
    const call = c.d.getElementById('vCall'); assert.ok(call);
    assert.equal(call.getAttribute('href'), 'tel:+528112345601');
    assert.match(c.d.getElementById('vCopy').textContent, /8112345601/);
    assert.equal(c.d.getElementById('vText'), null); assert.equal(c.d.getElementById('vSend'), null);
    open = true; c.close();
  });

  await t.test('새 메시지 알림 — 탭 숫자 = 답장 기다림 · 다른 탭이면 제목 (N)', async () => {
    pulseN = 0;
    const c = boot(WAP, 'https://example.test/refatrix-wapromo.html', route); await c.ready; await tick(500);
    assert.equal(c.d.getElementById('inboxN').textContent, '3');
    c.w.eval('pulse()'); await tick(300);
    assert.equal(c.d.getElementById('inboxN').textContent, '4');
    assert.match(c.d.title, /^\(2\) 💬 /);
    assert.ok(c.calls.some((x) => x.u.includes('/inbox/pulse?after=100')));
    c.d.querySelector('#tabs .tab[data-p="inbox"]').click(); await tick();
    assert.ok(!/^\(/.test(c.d.title), '받은 메시지를 열면 제목 숫자 지움');
    c.close();
  });
});

test('Meta 광고 문의 — ERP 번호 WhatsApp 대화 (jsdom)', { skip: SKIP && 'jsdom 또는 HTML 없음' }, async (t) => {
  let winOpen = true;
  const LEAD = () => ({ id: 77, platform: 'whatsapp', thread_id: 'wa:528112345601', name: 'Cliente', status: 'nuevo', messages: [
    { at: '2026-11-11T15:00:00Z', me: false, text: 'Hola' },
    { at: '2026-11-11T15:01:00Z', me: false, text: '(imagen)', mid: 11, mk: 'image' },
    { at: '2026-11-11T15:02:00Z', me: false, text: 'cotizacion.pdf', mid: 12, mk: 'document' }],
    wa: { reply_ready: true, window_open: winOpen, window_known: true, last_in_at: NOW(), phone: '528112345601' }, portal: null, items: [] });
  const route = (u, method, body, json) => {
    if (/\/api\/meta-leads\/77\/wa-media\/\d+/.test(u)) return json({});
    if (u.endsWith('/api/meta-leads/77/whatsapp') && method === 'POST') { const d = LEAD(); d.messages.push({ at: NOW(), me: true, text: body.text }); return json({ ok: true, messages: d.messages, wa: d.wa }); }
    if (u.endsWith('/api/meta-leads/77')) return json(LEAD());
    if (u.includes('/api/meta-leads/status')) return json({ configured: true, migrated: true, page_id: '1', page: { name: 'CTR' }, counts: { total: 1 }, ai: {}, match: {}, states: ['Nuevo León'] });
    if (u.includes('/api/meta-leads/list')) return json({ items: [{ id: 77, platform: 'whatsapp', name: 'Cliente', status: 'nuevo', last_mx: '2026-11-11 09:00', first_mx: '2026-11-11', phone: '8112345601' }], stock: {} });
    return json({});
  };
  await t.test('사진 · PDF · 답장 · 받은 메시지 링크 · 창 닫힘 = 전화', async () => {
    const c = boot(MTL, 'https://example.test/refatrix-metaleads.html', route); await c.ready; await tick(600);
    assert.match(c.d.title, /mtl-1111a/);
    c.d.querySelector('#lTable tr[data-id="77"]').dispatchEvent(new c.w.MouseEvent('click', { bubbles: true })); await tick(400);
    const chat = c.d.getElementById('oChat');
    assert.equal(chat.querySelector('img.wm').getAttribute('src'), 'blob:media');
    assert.ok(!/\(imagen\)/.test(chat.textContent));
    assert.match(chat.querySelector('a.wdoc').textContent, /cotizacion\.pdf/);
    const comp = c.d.getElementById('oComp');
    assert.ok(c.d.getElementById('oWaText') && c.d.getElementById('oWaAttach'));
    assert.match(comp.querySelector('a[href^="refatrix-wapromo.html#tab=inbox&phone="]').getAttribute('href'), /528112345601/);
    c.d.getElementById('oWaText').value = '¿Qué año?'; c.d.getElementById('oWaSend').click(); await tick(300);
    assert.deepEqual(c.calls.find((x) => x.u.endsWith('/77/whatsapp')).body, { text: '¿Qué año?' });
    assert.match(c.d.getElementById('oChat').textContent, /¿Qué año\?/);
    winOpen = false; c.d.querySelector('#lTable tr[data-id="77"]').dispatchEvent(new c.w.MouseEvent('click', { bubbles: true })); await tick(400);
    assert.equal(c.d.getElementById('oWaText'), null);
    assert.equal(c.d.querySelector('#oComp a[href^="tel:"]').getAttribute('href'), 'tel:+528112345601');
    assert.match(c.d.getElementById('oComp').textContent, /24시간 창 닫힘/);
    c.close();
  });
});
