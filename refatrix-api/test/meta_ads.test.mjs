// =====================================================================
// meta_ads.test.mjs — Meta 광고 문의를 광고별로 나누기 (0295 · 2026-10-23)
//   A. 웹훅 광고 출처 해석 — WhatsApp referral · Messenger/Instagram referral(본문 · 메시지 · postback) · 에코 제외
//   B. 실제 서버 + PostgreSQL(TEST_PG_URL): 서명 웹훅 → 기록 · 미등록 광고 · 등록(이름) · 광고별 목록 ·
//      구분 문구 · 사람 지정 우선 · 광고 외 · 수정 · 삭제 · 권한 · 페이지 웹훅 연결
//   C. 화면(jsdom): 광고 탭 · 등록 · 미등록에 이름 붙이기 · 광고 선택 → 문의 · 목록 광고 필터 · 한 건 광고 지정
//   실행: TEST_PG_URL=postgres://... node --test test/meta_ads.test.mjs
// =====================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-meta-ads';
const A = await import('../src/metaAds.js');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const AD1 = '120212345678900001', AD2 = '120212345678900002', AD3 = '120212345678900003';

test('A1. WhatsApp referral — 광고 ID · 번호 정리 · 광고가 아닌 출처는 버림', () => {
  const t = A.waReferralOf({ from: '5218112345678', id: 'wamid.X', timestamp: '1760000000', type: 'text',
    referral: { source_url: 'https://fb.me/x', source_id: AD1, source_type: 'ad', headline: 'Amortiguadores', ctwa_clid: 'CLID' } });
  assert.equal(t.platform, 'whatsapp'); assert.equal(t.user_id, '528112345678', '521 → 52'); assert.equal(t.ad_id, AD1);
  assert.equal(t.headline, 'Amortiguadores'); assert.equal(t.ctwa_clid, 'CLID'); assert.equal(t.event_key, 'wa:wamid.X');
  assert.equal(t.at.toISOString(), new Date(1760000000 * 1000).toISOString());
  assert.equal(A.waReferralOf({ from: '528112345678', referral: { source_id: '999', source_type: 'post' } }), null, '게시물 출처는 광고 아님');
  assert.equal(A.waReferralOf({ from: '528112345678', referral: { source_id: 'abc', source_type: 'ad' } }), null);
  assert.equal(A.waReferralOf({ from: '528112345678' }), null);
  assert.equal(A.cleanAdId(' 1202 1234 5678 '), '120212345678'); assert.equal(A.cleanAdId('12a'), null);
});

test('A2. Messenger · Instagram referral — 본문 · 메시지 · postback 안 · 에코 제외 · ms 시각', () => {
  const body = { object: 'page', entry: [{ id: 'PAGE', messaging: [
    { sender: { id: 'psid1' }, recipient: { id: 'PAGE' }, timestamp: 1760000000123, referral: { source: 'ADS', type: 'OPEN_THREAD', ad_id: AD1, ref: 'r1', ads_context_data: { ad_title: 'Horquillas' } } },
    { sender: { id: 'psid2' }, recipient: { id: 'PAGE' }, timestamp: 1760000001000, message: { mid: 'm.2', text: 'hola', referral: { source: 'ADS', ad_id: AD2 } } },
    { sender: { id: 'psid3' }, recipient: { id: 'PAGE' }, timestamp: 1760000002000, postback: { payload: 'GET_STARTED', referral: { source: 'ADS', ad_id: AD2 } } },
    { sender: { id: 'PAGE' }, recipient: { id: 'psid1' }, timestamp: 1760000003000, message: { is_echo: true, mid: 'm.4', referral: { ad_id: AD1 } } },
    { sender: { id: 'psid5' }, recipient: { id: 'PAGE' }, timestamp: 1760000004000, message: { mid: 'm.5', text: 'sin anuncio' } },
  ] }] };
  const r = A.pageReferralsOf(body);
  assert.equal(r.length, 3, '에코 · 광고 없는 메시지는 뺀다');
  assert.deepEqual(r.map((x) => [x.platform, x.user_id, x.ad_id]), [['messenger', 'psid1', AD1], ['messenger', 'psid2', AD2], ['messenger', 'psid3', AD2]]);
  assert.equal(r[0].headline, 'Horquillas'); assert.equal(r[0].ref, 'r1'); assert.equal(r[0].at.getTime(), 1760000000123);
  assert.equal(r[1].event_key, 'messenger:m.2');
  const ig = A.pageReferralsOf({ object: 'instagram', entry: [{ id: 'IG', messaging: [{ sender: { id: 'igsid1' }, timestamp: 1760000000000, message: { mid: 'i.1', referral: { ad_id: AD3 } } }] }] });
  assert.deepEqual(ig.map((x) => [x.platform, x.user_id, x.ad_id]), [['instagram', 'igsid1', AD3]]);
  assert.deepEqual(A.pageReferralsOf({ object: 'whatsapp_business_account', entry: [] }), []);
});

test('B. 실제 서버 + PostgreSQL', { skip: !PG && 'TEST_PG_URL 없음' }, async (t) => {
  const { query, pool } = await import('../src/db.js');
  after(async () => { await pool.end().catch(() => {}); setTimeout(() => process.exit(process.exitCode || 0), 300); });
  const SECRET = 'app-secret-meta-ads';
  process.env.WHATSAPP_APP_SECRET = SECRET; process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'vt';
  process.env.META_PAGE_TOKEN = 'SYS'; process.env.META_LEADS_AUTO = '0'; process.env.META_LEADS_WA_DELAY_MS = '30';
  const M = await import('../src/metaLeads.js');
  M.setMetaFetch(async (url) => { const u = new URL(url); if (u.pathname.endsWith('/1338649012669713')) return { ok: true, status: 200, json: { id: '1', name: 'CTR', access_token: 'PAGE_TOKEN' } }; return { ok: true, status: 200, json: { data: [] } }; });
  t.after(() => { M.setMetaFetch(null); A.setMetaAdsPost(null); });
  const { buildApp } = await import('../src/server.js');
  const app = buildApp(); await app.ready();
  t.after(() => app.close());
  const SFX = Date.now().toString(36).slice(-5);
  const one = async (sql, a) => (await query(sql, a)).rows[0];
  await query(`DELETE FROM meta_ad_touches; DELETE FROM meta_ads; DELETE FROM meta_threads; DELETE FROM wa_messages WHERE phone IN ('528112345678','523311112222','528188887777');`);
  const dir = await one(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,'director','x',$2) RETURNING id`, [`MA Dir ${SFX}`, `madir${SFX}`]);
  const rep = await one(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,'sales','x',$2) RETURNING id`, [`MA Rep ${SFX}`, `marep${SFX}`]);
  const pv = await one(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,'ops','x',$2) RETURNING id`, [`MA Prod ${SFX}`, `maprod${SFX}`]);
  await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access) VALUES ($1,'products','anywhere','view')`, [pv.id]);
  const D = { authorization: 'Bearer ' + app.jwt.sign({ sub: Number(dir.id), role: 'director' }) };
  const R = { authorization: 'Bearer ' + app.jwt.sign({ sub: Number(rep.id), role: 'sales' }) };
  const Pv = { authorization: 'Bearer ' + app.jwt.sign({ sub: Number(pv.id), role: 'ops' }) };
  const call = (h, method, url, payload) => app.inject({ method, url, payload, headers: h });
  const hook = (body) => { const raw = JSON.stringify(body); return app.inject({ method: 'POST', url: '/api/wa/webhook', payload: raw,
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex') } }); };
  const thread = (platform, tid, user, name, text, firstMin, msgs) => query(
    `INSERT INTO meta_threads (platform, thread_id, user_id, name, first_at, last_at, messages, customer_text, in_count, msg_count, a_phone)
     VALUES ($1,$2,$3,$4, now() - ($5 || ' minutes')::interval, now() - ($5 || ' minutes')::interval + interval '5 minutes', $6::jsonb, $7, 1, 2, $8) RETURNING id`,
    [platform, tid, user, name, String(firstMin), JSON.stringify(msgs || [{ at: new Date().toISOString(), me: false, text }, { at: new Date().toISOString(), me: true, text: 'Con gusto, ¿qué vehículo?' }]), text, platform === 'whatsapp' ? user.slice(-10) : null]);
  const T1 = (await thread('messenger', 't1', 'psid1', 'Antonio', 'tengo un versa 2018 horquillas', 300)).rows[0].id;
  const T2 = (await thread('whatsapp', 'wa:528112345678', '528112345678', 'Lupita', 'Soy Taller de MTY quiero catálogo', 200)).rows[0].id;
  const T3 = (await thread('messenger', 't3', 'psid3', 'Hugo', 'Hola, vi el anuncio A07 y quiero precios', 100)).rows[0].id;
  const T4 = (await thread('instagram', 't4', 'igsid4', 'Sin anuncio', 'precio rotulas', 50)).rows[0].id;

  await t.test('B1. 서명 웹훅 → 광고 출처 기록(WhatsApp · Messenger) · 재전송 중복 없음 · 잘못된 서명 거절', async () => {
    const wa = { object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp',
      contacts: [{ wa_id: '5218112345678', profile: { name: 'Lupita' } }],
      messages: [{ from: '5218112345678', id: 'wamid.AD1', timestamp: String(Math.floor(Date.now() / 1000) - 12000), type: 'text', text: { body: 'Soy Taller de MTY' },
        referral: { source_id: AD1, source_type: 'ad', headline: 'Taller MTY', ctwa_clid: 'c1' } }] } }] }] };
    let r = await hook(wa); assert.equal(r.statusCode, 200);
    r = await hook(wa); assert.equal(r.statusCode, 200);
    const pg = { object: 'page', entry: [{ id: 'PAGE', time: Date.now(), messaging: [
      { sender: { id: 'psid1' }, recipient: { id: 'PAGE' }, timestamp: Date.now() - 18000000, referral: { source: 'ADS', type: 'OPEN_THREAD', ad_id: AD1 } },
      { sender: { id: 'psid1' }, recipient: { id: 'PAGE' }, timestamp: Date.now() - 1000, referral: { source: 'ADS', type: 'OPEN_THREAD', ad_id: AD2 } },
      { sender: { id: 'psid9' }, recipient: { id: 'PAGE' }, timestamp: Date.now(), message: { mid: 'm.9', text: 'hola', referral: { source: 'ADS', ad_id: AD2, ads_context_data: { ad_title: 'Horquillas GDL' } } } }] }] };
    assert.equal((await hook(pg)).statusCode, 200);
    const raw = JSON.stringify(pg); const bad = await app.inject({ method: 'POST', url: '/api/wa/webhook', payload: raw, headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) } });
    assert.equal(bad.statusCode, 401);
    const n = (await query(`SELECT platform, user_id, ad_id FROM meta_ad_touches ORDER BY at`)).rows;
    assert.equal(n.length, 4, 'WhatsApp 재전송은 한 번만');
    assert.ok(n.some((x) => x.platform === 'whatsapp' && x.user_id === '528112345678' && x.ad_id === AD1));
  });

  await t.test('B2. 미등록 광고 → 이름 붙이기 → 광고별 목록 · 첫 광고 기준 · 광고 외', async () => {
    let a = (await call(D, 'GET', '/api/meta-leads/ads')).json();
    assert.equal(a.ads.length, 0); assert.equal(a.touches.n, 4);
    const u1 = a.unregistered.find((x) => x.ad_id === AD1); assert.equal(u1.n, 2, 'psid1(첫 광고 AD1) + WhatsApp'); assert.equal(u1.people, 2);
    const u2 = a.unregistered.find((x) => x.ad_id === AD2); assert.equal(u2.n, 0, '목록에 아직 없는 사람(psid9)만 — 문의 0'); assert.equal(u2.headline, 'Horquillas GDL');
    assert.equal(a.none.n, 2, 'T3 · T4 는 광고를 모름');
    let r = await call(D, 'POST', '/api/meta-leads/ads', { ad_id: ' 1202 1234 5678 900001 ', name: 'Amortiguadores MTY', memo: 'oct' });
    assert.equal(r.statusCode, 200); assert.equal(r.json().ad_id, AD1);
    assert.equal((await call(D, 'POST', '/api/meta-leads/ads', { ad_id: AD1, name: 'dup' })).json().error, 'ad_exists');
    assert.equal((await call(D, 'POST', '/api/meta-leads/ads', { ad_id: 'abc', name: 'x' })).json().error, 'bad_ad_id');
    assert.equal((await call(D, 'POST', '/api/meta-leads/ads', { ad_id: AD3, name: '  ' })).json().error, 'name_required');
    a = (await call(D, 'GET', '/api/meta-leads/ads')).json();
    const g = a.ads[0]; assert.equal(g.name, 'Amortiguadores MTY'); assert.equal(g.n, 2); assert.equal(g.messenger, 1); assert.equal(g.whatsapp, 1); assert.equal(g.by_meta, 2); assert.equal(g.phones, 1);
    assert.equal(g.headline, 'Taller MTY'); assert.ok(!a.unregistered.some((x) => x.ad_id === AD1));
    const l = (await call(D, 'GET', '/api/meta-leads/list?ad=' + AD1)).json().items;
    assert.deepEqual(l.map((x) => x.name).sort(), ['Antonio', 'Lupita']);
    const ant = l.find((x) => x.name === 'Antonio');
    assert.equal(ant.ad_id, AD1, '나중에 AD2 를 눌렀어도 첫 광고'); assert.equal(ant.ad_src, 'meta'); assert.equal(ant.ad_name, 'Amortiguadores MTY');
    assert.match(ant.first_mx_t, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/); assert.equal(ant.last_reply, 'Con gusto, ¿qué vehículo?');
    assert.deepEqual((await call(D, 'GET', '/api/meta-leads/list?ad=__none')).json().items.map((x) => x.name).sort(), ['Hugo', 'Sin anuncio']);
    assert.equal((await call(D, 'GET', '/api/meta-leads/list')).json().items.length, 4);
  });

  await t.test('B3. 구분 문구 · 사람 지정이 우선 · 빈 값이면 자동으로', async () => {
    assert.equal((await call(D, 'POST', '/api/meta-leads/ads', { ad_id: AD3, name: 'Promo A07', match_text: 'ab' })).json().error, 'match_text_short');
    assert.equal((await call(D, 'POST', '/api/meta-leads/ads', { ad_id: AD3, name: 'Promo A07', match_text: 'anuncio a07' })).statusCode, 200);
    let l = (await call(D, 'GET', '/api/meta-leads/list?ad=' + AD3)).json().items;
    assert.deepEqual(l.map((x) => [x.name, x.ad_src]), [['Hugo', 'texto']], '대소문자 무시');
    let p = await call(D, 'PATCH', '/api/meta-leads/' + T4, { ad_id: AD3 }); assert.equal(p.statusCode, 200); assert.equal(p.json().ad_id, AD3); assert.equal(p.json().ad_src, 'manual');
    p = await call(D, 'PATCH', '/api/meta-leads/' + T1, { ad_id: AD3 }); assert.equal(p.json().ad_src, 'manual', '사람이 고른 광고가 웹훅보다 우선');
    assert.equal((await call(D, 'GET', '/api/meta-leads/list?ad=' + AD3)).json().items.length, 3);
    p = await call(D, 'PATCH', '/api/meta-leads/' + T1, { ad_id: '' }); assert.equal(p.json().ad_id, AD1); assert.equal(p.json().ad_src, 'meta', '빈 값 = 자동');
    assert.equal((await call(D, 'PATCH', '/api/meta-leads/' + T1, { ad_id: 'x1' })).json().error, 'bad_ad_id');
    const d = (await call(D, 'GET', '/api/meta-leads/' + T4)).json(); assert.equal(d.ad_name, 'Promo A07');
    const a = (await call(D, 'GET', '/api/meta-leads/ads')).json(); const g = a.ads.find((x) => x.ad_id === AD3);
    assert.equal(g.n, 2); assert.equal(g.by_text, 1); assert.equal(g.by_manual, 1); assert.equal(a.none.n, 0);
    void T2;
  });

  await t.test('B4. 수정 · 삭제(웹훅 기록은 미등록으로 남음) · 권한 · 페이지 웹훅 연결', async () => {
    let r = await call(D, 'PATCH', '/api/meta-leads/ads/' + AD1, { name: 'Amort. MTY oct', active: false });
    assert.equal(r.json().name, 'Amort. MTY oct'); assert.equal(r.json().active, false);
    assert.equal((await call(D, 'PATCH', '/api/meta-leads/ads/' + AD2, { name: 'x' })).statusCode, 404);
    assert.equal((await call(Pv, 'GET', '/api/meta-leads/ads')).statusCode, 200, '보기 권한으로 광고 목록');
    assert.equal((await call(Pv, 'POST', '/api/meta-leads/ads', { ad_id: AD2, name: 'x' })).json().error, 'read_only');
    assert.equal((await call(R, 'GET', '/api/meta-leads/ads')).statusCode, 403);
    assert.equal((await call(D, 'DELETE', '/api/meta-leads/ads/' + AD1)).statusCode, 200);
    const a = (await call(D, 'GET', '/api/meta-leads/ads')).json();
    assert.ok(!a.ads.some((x) => x.ad_id === AD1)); assert.equal(a.unregistered.find((x) => x.ad_id === AD1).n, 2, '문의는 그대로 미등록 광고로');
    let seen = null; A.setMetaAdsPost(async (url) => { seen = url; return { ok: true, status: 200, json: { success: true } }; });
    r = await call(D, 'POST', '/api/meta-leads/ads/subscribe'); assert.equal(r.statusCode, 200);
    assert.match(seen, /\/1338649012669713\/subscribed_apps\?subscribed_fields=messages,messaging_referrals,messaging_postbacks,message_echoes&access_token=PAGE_TOKEN/);
    A.setMetaAdsPost(async () => ({ ok: false, status: 400, json: { error: { code: 200, message: 'Requires pages_manage_metadata' } } }));
    r = await call(D, 'POST', '/api/meta-leads/ads/subscribe'); assert.equal(r.json().error, 'subscribe_failed'); assert.match(r.json().detail, /#200/);
    await wait(10);
  });

  await t.test('B5. 실시간 접수 — ERP WhatsApp 번호로 온 문의가 가져오기 없이 바로 목록에 · 광고 · 우리 답장 · 사내 번호 제외', async () => {
    await call(D, 'POST', '/api/meta-leads/ads', { ad_id: AD2, name: 'Horquillas GDL' });
    const ts = Math.floor(Date.now() / 1000);
    const wa = (from, id, text, extra = {}) => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp',
      contacts: [{ wa_id: from, profile: { name: 'Don Pepe' } }], messages: [{ from, id, timestamp: String(ts), type: 'text', text: { body: text }, ...extra }] } }] }] });
    assert.equal((await hook(wa('5213311112222', 'wamid.L1', 'Hola, horquillas para Versa 2017', { referral: { source_id: AD2, source_type: 'ad', headline: 'Horquillas GDL' } }))).statusCode, 200);
    assert.equal((await hook(wa('5213311112222', 'wamid.L2', 'soy de Guadalajara'))).statusCode, 200);
    let row = null;
    for (let i = 0; i < 40 && !(row && /Guadalajara/.test(row.customer_text || '')); i++) { await wait(50); row = (await call(D, 'GET', '/api/meta-leads/list?ad=' + AD2)).json().items.find((x) => x.platform === 'whatsapp'); }
    assert.ok(row, '가져오기를 누르지 않아도 목록에 들어온다');
    assert.equal(row.name, 'Don Pepe'); assert.equal(row.phone, '3311112222'); assert.equal(row.ad_name, 'Horquillas GDL'); assert.equal(row.ad_src, 'meta');
    assert.match(row.customer_text, /Versa 2017[\s\S]*Guadalajara/, '두 메시지를 한 문의로');
    assert.equal((await query(`SELECT count(*)::int n FROM meta_threads WHERE thread_id = 'wa:523311112222'`)).rows[0].n, 1);
    // 우리 답장(ERP 에서 보낸 메시지) → 대응내용
    await query(`INSERT INTO wa_messages (direction, phone, kind, body, source, ok, at) VALUES ('out','523311112222','text','Con gusto, le paso precio','reply',true, now() + interval '1 second')`);
    await M.kickWaThread('523311112222');
    row = (await call(D, 'GET', '/api/meta-leads/list?ad=' + AD2)).json().items.find((x) => x.platform === 'whatsapp');
    assert.equal(row.last_reply, 'Con gusto, le paso precio');
    const s = (await call(D, 'GET', '/api/meta-leads/status')).json();
    assert.equal(s.wa.live, true); assert.ok(s.wa.live_at); assert.ok(s.wa.live_count >= 2);
    // 사내 번호(사용자 WhatsApp)는 문의가 아니다
    await query(`UPDATE users SET wa_phone = '528188887777' WHERE id = $1`, [dir.id]);
    await hook(wa('5218188887777', 'wamid.L3', 'reporte'));
    await wait(300);
    assert.equal((await query(`SELECT count(*)::int n FROM meta_threads WHERE thread_id = 'wa:528188887777'`)).rows[0].n, 0);
  });
});

// ── C. 화면 ──
let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* skip */ }
const HTML = path.join(ROOT, 'refatrix-metaleads.html');
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));
test('C. 화면 (jsdom) — 광고 탭', { skip: (!JSDOM || !existsSync(HTML)) && 'jsdom 또는 HTML 없음' }, async (t) => {
  const ITEMS = [
    { id: 1, platform: 'messenger', name: 'Antonio', status: 'nuevo', first_mx: '2026-10-20', first_mx_t: '2026-10-20 09:15', last_mx: '2026-10-21 10:00', first_at: '2026-10-20T15:15:00Z', phone: '7771234567', customer_text: 'versa 2018 horquillas', last_reply: 'Con gusto', ad_id: AD1, ad_src: 'meta', ad_name: 'Amortiguadores MTY' },
    { id: 2, platform: 'whatsapp', name: 'Lupita', status: 'contactado', first_mx: '2026-10-21', first_mx_t: '2026-10-21 11:00', last_mx: '2026-10-21 12:00', first_at: '2026-10-21T17:00:00Z', phone: '8112345678', customer_text: 'catálogo', ad_id: AD2, ad_src: 'meta', ad_name: null },
  ];
  const ADS = { ads: [{ ad_id: AD1, name: 'Amortiguadores MTY', memo: 'oct', match_text: null, active: true, n: 1, phones: 1, nuevo: 1, contactado: 0, derivado: 0, venta: 0, descartado: 0, messenger: 1, instagram: 0, whatsapp: 0, by_meta: 1, by_text: 0, by_manual: 0, last_at: '2026-10-21T16:00:00Z' }],
    unregistered: [{ ad_id: AD2, n: 1, phones: 1, nuevo: 0, contactado: 1, derivado: 0, venta: 0, descartado: 0, messenger: 0, instagram: 0, whatsapp: 1, by_meta: 1, by_text: 0, by_manual: 0, headline: 'Taller MTY', people: 1 }],
    none: { n: 3, phones: 0, nuevo: 3, contactado: 0, derivado: 0, venta: 0, descartado: 0, messenger: 3, instagram: 0, whatsapp: 0, by_meta: 0, by_text: 0, by_manual: 0 }, touches: { n: 2, last_at: '2026-10-21T17:00:00Z' } };
  const calls = [];
  const dom = new JSDOM(readFileSync(HTML, 'utf-8').replace(/<script src="https:\/\/cdn[^>]+><\/script>/, ''), {
    runScripts: 'dangerously', url: 'https://example.test/refatrix-metaleads.html',
    beforeParse(w) {
      w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 'T', api: 'https://api.test', user: { name: 'U', role: 'director' } }));
      w.confirm = () => true; w.alert = () => {};
      w.fetch = async (url, opt = {}) => {
        const u = String(url); const method = opt.method || 'GET'; const body = opt.body ? JSON.parse(opt.body) : null; calls.push({ u, method, body });
        const json = (d, s = 200) => ({ ok: s < 400, status: s, json: async () => d });
        if (u.includes('/api/meta-leads/status')) return json({ configured: true, migrated: true, page_id: '1', page: { name: 'CTR' }, counts: { total: 2 }, ai: {}, match: {}, states: ['Nuevo León'] });
        if (u.includes('/api/meta-leads/ads/subscribe')) return json({ ok: true });
        if (u.includes('/api/meta-leads/ads') && method === 'POST') return json({ ad_id: body.ad_id, name: body.name });
        if (u.includes('/api/meta-leads/ads') && method === 'GET') return json(ADS);
        if (u.includes('/api/meta-leads/list')) { const ad = new URL(u).searchParams.get('ad'); return json({ items: ad ? ITEMS.filter((x) => x.ad_id === ad) : ITEMS, stock: {} }); }
        if (/\/api\/meta-leads\/1$/.test(u) && method === 'GET') return json({ ...ITEMS[0], messages: [{ at: '2026-10-20T15:15:00Z', me: false, text: 'hola' }] });
        if (/\/api\/meta-leads\/1$/.test(u) && method === 'PATCH') return json({ ...ITEMS[0], ad_id: body.ad_id || AD1, ad_src: body.ad_id ? 'manual' : 'meta' });
        return json({});
      };
    },
  });
  const w = dom.window, d = w.document;
  await new Promise((r) => (d.readyState === 'complete' ? r() : w.addEventListener('load', r))); await tick(400);
  t.after(() => w.close());

  await t.test('C1. 빌드 · 목록 광고 열 · 광고 필터', async () => {
    assert.match(d.title, /mtl-1026lpe/);
    assert.match(d.querySelector('#lTable tr[data-id="1"]').textContent, /Amortiguadores MTY/);
    assert.match(d.querySelector('#lTable tr[data-id="2"]').textContent, /미등록/);
    const opts = [...d.querySelectorAll('#fAd option')].map((o) => o.value);
    assert.deepEqual(opts, ['', '__none', AD1, AD2]);
    d.getElementById('fAd').value = AD1; d.getElementById('fAd').dispatchEvent(new w.Event('change')); await tick();
    assert.ok(calls.some((c) => c.u.includes('/api/meta-leads/list?ad=' + AD1)));
    assert.equal(d.querySelectorAll('#lTable tbody tr').length, 1);
    d.getElementById('fAd').value = ''; d.getElementById('fAd').dispatchEvent(new w.Event('change')); await tick();
  });
  await t.test('C2. 광고 탭 — 등록 · 미등록에 이름 붙이기 · 광고 선택 → 문의 · 웹훅 연결', async () => {
    d.querySelector('#tabs .tab[data-p="ads"]').click(); await tick();
    assert.ok(d.getElementById('p-ads').classList.contains('on'));
    const rows = d.querySelectorAll('#aTable tr[data-ad]'); assert.equal(rows.length, 3, '등록 · 미등록 · 광고 외');
    assert.match(d.getElementById('aTable').textContent, /광고 외 \/ 직접/); assert.match(d.getElementById('aHook').textContent, /2건/);
    d.getElementById('aId').value = '1202-1234 5678900009'; d.getElementById('aName').value = 'Rótulas GDL'; d.getElementById('aMatch').value = 'vi el anuncio R09';
    d.getElementById('aSave').click(); await tick();
    const post = calls.filter((c) => c.method === 'POST' && c.u.endsWith('/api/meta-leads/ads')).pop();
    assert.deepEqual(post.body, { name: 'Rótulas GDL', match_text: 'vi el anuncio R09', memo: '', active: true, ad_id: '120212345678900009' });
    d.querySelector(`#aTable button[data-reg="${AD2}"]`).click(); await tick();
    const reg = calls.filter((c) => c.method === 'POST' && c.u.endsWith('/api/meta-leads/ads')).pop();
    assert.deepEqual(reg.body, { ad_id: AD2, name: 'Taller MTY' }, '미등록 광고 — Meta 광고 제목을 이름 칸에 미리 채움');
    d.querySelector(`#aTable tr[data-ad="${AD1}"] td`).dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await tick(150);
    const det = d.getElementById('aDetail').textContent;
    assert.match(det, /Amortiguadores MTY — 문의 1건/); assert.match(det, /2026-10-20 09:15/); assert.match(det, /7771234567/); assert.match(det, /versa 2018 horquillas/); assert.match(det, /Con gusto/);
    d.querySelector(`#aTable button[data-edit="${AD1}"]`).click(); await tick();
    assert.equal(d.getElementById('aId').disabled, true); assert.equal(d.getElementById('aName').value, 'Amortiguadores MTY'); assert.equal(d.getElementById('aSave').textContent, '저장');
    d.getElementById('aCancel').click();
    d.querySelector('#aHook #aSub').click(); await tick();
    assert.ok(calls.some((c) => c.u.endsWith('/api/meta-leads/ads/subscribe') && c.method === 'POST'));
    d.getElementById('aToList').click(); await tick();
    assert.equal(d.getElementById('fAd').value, AD1); assert.ok(d.getElementById('p-list').classList.contains('on'));
  });
  await t.test('C3. 한 건 — 광고 직접 지정 · 자동값 표시', async () => {
    d.querySelector('#lTable tr[data-id="1"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await tick(150);
    assert.match(d.getElementById('eAd').options[0].textContent, /자동: Amortiguadores MTY/); assert.equal(d.getElementById('eAd').value, '');
    assert.match(d.getElementById('eAdHint').textContent, /Meta 광고 기록/);
    d.getElementById('eAd').value = AD2; d.getElementById('eSave').click(); await tick(150);
    assert.equal(calls.filter((c) => c.method === 'PATCH').pop().body.ad_id, AD2);
  });
});
