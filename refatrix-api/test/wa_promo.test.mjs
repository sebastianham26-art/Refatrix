// =====================================================================
// wa_promo.test.mjs — WhatsApp 마케팅 (0260 · 2026-10-07)
//   A. 순수 규칙 — 글자 정리 · 규칙 고르기(동의/수신거부 오인 방지) · 받은 메시지 해석
//   B. 실제 서버 + PostgreSQL(TEST_PG_URL): 연락처(1건·엑셀 미리보기/저장·권한) · 동의 요청(1회·상한·창 열림이면 버튼) ·
//      웹훅 받은 메시지(저장·중복·버튼 동의·BAJA·상담 요청·그 밖의 말·쿨다운·미등록 번호) ·
//      정기 발송(동의자만·메모 조건·이미지 1회 업로드·창 열림이면 일반 이미지·실패 재시도 상한·상한 공유) ·
//      받은 메시지함·직접 답장(창 닫힘 409)·엑셀 원자료 · 발송 수정/취소/시험 · 자동응답 CRUD
//   실행: TEST_PG_URL=postgres://... node --test test/wa_promo.test.mjs
// =====================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-wa-promo';
const P = await import('../src/waPromo.js');

const RULES = [
  { id: 1, sort: 10, keywords: ['si quiero', 'si', 'sí', 'acepto'], action: 'consent_yes', reply: 'ok', active: true },
  { id: 2, sort: 20, keywords: ['no gracias', 'no', 'baja', 'stop', 'cancelar'], action: 'consent_no', reply: 'bye', active: true },
  { id: 3, sort: 30, keywords: ['quiero cotizar', 'cotizar', 'precio'], action: 'lead', reply: 'asesor', active: true },
  { id: 9, sort: 900, keywords: [], is_fallback: true, action: 'none', reply: 'hola', active: true },
];
test('A1. 규칙 고르기 — 동의는 정확히 같을 때만 · 수신거부 긴 말은 문장 어디서나 · 나머지는 단어', () => {
  const r = (t) => P.pickRule(RULES, t).id;
  assert.equal(r('Sí, quiero'), 1); assert.equal(r('SI'), 1); assert.equal(r('acepto!'), 1);
  assert.equal(r('no acepto'), 9, '「no acepto」 는 동의 아님');
  assert.equal(r('si pero cuanto cuesta'), 9, '긴 문장의 si 는 동의 아님');
  assert.equal(r('No, gracias'), 2); assert.equal(r('no'), 2); assert.equal(r('BAJA por favor'), 2); assert.equal(r('quiero darme de baja'), 2);
  assert.equal(r('no tengo ese modelo'), 9, '짧은 「no」 는 그 말만 왔을 때');
  assert.equal(r('Quiero cotizar'), 3); assert.equal(r('el precio de la rótula?'), 3);
  assert.equal(r(''), 9);
  assert.equal(P.pickRule(RULES.map((x) => (x.id === 1 ? { ...x, active: false } : x)), 'si').id, 9, '꺼진 규칙은 건너뜀');
});
test('A2. 받은 메시지 해석 · 글자 정리 · 한 줄', () => {
  assert.deepEqual(P.parseInbound({ type: 'text', text: { body: 'hola' } }), { kind: 'text', body: 'hola', payload: null });
  assert.deepEqual(P.parseInbound({ type: 'button', button: { text: 'Sí, quiero', payload: 'Sí, quiero' } }), { kind: 'button', body: 'Sí, quiero', payload: 'Sí, quiero' });
  assert.equal(P.parseInbound({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'b1', title: 'Quiero cotizar' } } }).body, 'Quiero cotizar');
  assert.equal(P.parseInbound({ type: 'image', image: { id: 'M1', caption: 'mi pieza' } }).body, 'mi pieza');
  assert.equal(P.normText('  ¡Sí,   QUIERO! '), 'si quiero');
  assert.equal(P.oneLine('a\nb\tc'), 'a b c');
});

test('B. 실제 서버 + PostgreSQL', { skip: !PG && 'TEST_PG_URL 없음' }, async (t) => {
  const { query, pool } = await import('../src/db.js');
  after(async () => { await pool.end().catch(() => {}); setTimeout(() => process.exit(process.exitCode || 0), 300); });
  const keep = { ...process.env };
  process.env.WHATSAPP_TOKEN = 't'; process.env.WHATSAPP_PHONE_ID = '1';
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'verify-me-123'; process.env.WHATSAPP_APP_SECRET = 'sec';
  delete process.env.PROMO_WA_DAILY_CAP; delete process.env.PROMO_WA_ENABLED;
  t.after(() => { process.env = keep; });

  // 발송 스텁
  const calls = []; let seq = 0; let failImage = false; let uploads = 0;
  const ok = (kind) => async (a) => { calls.push({ kind, ...a }); return { ok: true, message_id: `wamid.P${++seq}` }; };
  P.setPromoApi({
    text: ok('text'), buttons: ok('buttons'), bare: ok('bare'),
    upload: async () => { uploads++; return { ok: true, id: `MEDIA${uploads}` }; },
    image: ok('image'),
    imageTemplate: async (a) => { calls.push({ kind: 'imageTemplate', ...a }); return failImage ? { ok: false, error: 'boom' } : { ok: true, message_id: `wamid.P${++seq}` }; },
  });
  t.after(() => P.setPromoApi(null));

  const { buildApp } = await import('../src/server.js');
  const app = buildApp(); await app.ready();
  t.after(() => app.close());

  await query(`DELETE FROM wa_campaign_sends; DELETE FROM wa_messages; DELETE FROM wa_campaigns; DELETE FROM wa_images; DELETE FROM wa_contacts; DELETE FROM wa_inbound; DELETE FROM wa_message_status;`);
  const one = async (sql, a) => (await query(sql, a)).rows[0];
  const SFX = Date.now().toString(36).slice(-5);
  const dir = await one(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,'director','x',$2) RETURNING id`, [`WP Dir ${SFX}`, `wpdir${SFX}`]);
  const rep = await one(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,'sales','x',$2) RETURNING id`, [`WP Rep ${SFX}`, `wprep${SFX}`]);
  const D = { authorization: 'Bearer ' + app.jwt.sign({ sub: Number(dir.id), role: 'director' }) };
  const Rp = { authorization: 'Bearer ' + app.jwt.sign({ sub: Number(rep.id), role: 'sales' }) };
  const call = (h, method, url, payload) => app.inject({ method, url, payload, headers: h });
  const hook = async (msgs) => {
    const body = { object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: { messages: msgs } }] }] };
    const raw = JSON.stringify(body);
    const r = await app.inject({ method: 'POST', url: '/api/wa/webhook', payload: raw,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', 'sec').update(raw).digest('hex') } });
    assert.equal(r.statusCode, 200, r.body); await P.flushPromo(); return r;
  };
  let wid = 0; const ts = () => String(Math.floor(Date.now() / 1000));
  const txt = (from, body) => ({ from, id: `wamid.IN${++wid}`, timestamp: ts(), type: 'text', text: { body } });
  const btn = (from, text) => ({ from, id: `wamid.IN${++wid}`, timestamp: ts(), type: 'button', button: { text, payload: text } });
  const contact = async (phone) => one(`SELECT * FROM wa_contacts WHERE phone=$1 AND deleted_at IS NULL`, [phone]);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

  await t.test('B1. 연락처 — 1건 추가 · 형식/중복 오류 · 엑셀 미리보기→저장 · 권한', async () => {
    assert.equal((await call(D, 'POST', '/api/wa-promo/contacts', { name: 'Juan', phone: '12' })).statusCode, 400);
    const a = await call(D, 'POST', '/api/wa-promo/contacts', { name: 'Juan Pérez', phone: '5218110000001', memo: 'Expo Monterrey' });
    assert.equal(a.statusCode, 200, a.body); assert.equal(a.json().phone, '528110000001');
    assert.equal((await call(D, 'POST', '/api/wa-promo/contacts', { name: 'X', phone: '8110000001' })).statusCode, 409);
    const rows = [{ name: 'María', phone: '8110000002', memo: 'Expo Monterrey' }, { name: 'Taller Garza', phone: '81 1000 0003', memo: 'Mérida' },
      { name: 'Dup', phone: '8110000002' }, { name: 'Bad', phone: '123' }, { name: 'Juan otra vez', phone: '8110000001' }, { name: '', phone: '8110000009' },
      { name: 'Pedro', phone: '8110000004' }];
    const dry = (await call(D, 'POST', '/api/wa-promo/contacts/bulk', { rows, dry_run: true })).json();
    assert.deepEqual(dry.summary, { total: 7, new: 3, exists: 1, dup_in_file: 1, bad_phone: 1, no_name: 1 });
    assert.equal((await query(`SELECT count(*)::int n FROM wa_contacts`)).rows[0].n, 1, '미리보기는 저장 안 함');
    const sv = (await call(D, 'POST', '/api/wa-promo/contacts/bulk', { rows, dry_run: false })).json();
    assert.equal(sv.added, 3);
    const l = (await call(D, 'GET', '/api/wa-promo/contacts')).json();
    assert.equal(l.counts.total, 4); assert.equal(l.counts.unknown, 4);
    assert.equal((await call(Rp, 'GET', '/api/wa-promo/contacts')).statusCode, 403, '영업은 못 본다');
    // 2026-10-13 · 디렉터 · 소시오 전용 — 마케팅 화면 권한(edit)이 있어도 다른 역할은 403, 소시오는 화면 권한 없이도 연다
    const mk = await one(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,'marketing','x',$2) RETURNING id`, [`WP Mkt ${SFX}`, `wpmkt${SFX}`]);
    await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access) VALUES ($1,'marketing','anywhere','edit')`, [mk.id]);
    const Mk = { authorization: 'Bearer ' + app.jwt.sign({ sub: Number(mk.id), role: 'marketing' }) };
    const rm = await call(Mk, 'GET', '/api/wa-promo/contacts');
    assert.equal(rm.statusCode, 403, '마케팅 권한(edit)만으로는 안 됨'); assert.equal(rm.json().error, 'forbidden'); assert.equal(rm.json().page, 'wapromo');
    // 2026-10-16 · 관리자 화면에서 사용자별 wapromo 권한 — 열람 = 읽기만 · 수정 = 쓰기까지
    await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access) VALUES ($1,'wapromo','anywhere','view')`, [mk.id]);
    assert.equal((await call(Mk, 'GET', '/api/wa-promo/contacts')).statusCode, 200, 'wapromo 열람 → 목록');
    assert.equal((await call(Mk, 'GET', '/api/wa-promo/images')).statusCode, 200);
    const rv = await call(Mk, 'POST', '/api/wa-promo/contacts', { name: 'X', phone: '8110000077' });
    assert.equal(rv.statusCode, 403); assert.equal(rv.json().error, 'read_only', '열람은 쓰기 불가');
    assert.equal((await call(Mk, 'DELETE', '/api/wa-promo/images/999999')).statusCode, 403);
    await query(`UPDATE user_page_access SET access='edit' WHERE user_id=$1 AND page_key='wapromo'`, [mk.id]);
    const re = await call(Mk, 'POST', '/api/wa-promo/contacts', { name: 'Mkt alta', phone: '8110000077' });
    assert.ok(re.statusCode < 300, 'wapromo 수정 → 쓰기 ' + re.statusCode);
    await query(`UPDATE wa_contacts SET deleted_at=now() WHERE phone LIKE '%8110000077'`);
    await query(`UPDATE user_page_access SET device_req='blocked' WHERE user_id=$1 AND page_key='wapromo'`, [mk.id]);
    assert.equal((await call(Mk, 'GET', '/api/wa-promo/contacts')).statusCode, 403, '차단');
    const so = await one(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,'socio','x',$2) RETURNING id`, [`WP Socio ${SFX}`, `wpsoc${SFX}`]);
    const So = { authorization: 'Bearer ' + app.jwt.sign({ sub: Number(so.id), role: 'socio' }) };
    assert.equal((await call(So, 'GET', '/api/wa-promo/contacts')).statusCode, 200, '소시오는 연다');
    assert.equal((await call(So, 'GET', '/api/wa-promo/status')).statusCode, 200);
  });

  await t.test('B2. 동의 요청 — 미확인만 1회 · 하루 상한 · 창 열린 사람은 무료 버튼 메시지', async () => {
    process.env.PROMO_WA_DAILY_CAP = '3';
    await query(`INSERT INTO wa_inbound (wa_from, last_at, last_type, msg_count) VALUES ('528110000004', now(), 'text', 1)`);   // Pedro 창 열림
    const q1 = (await call(D, 'POST', '/api/wa-promo/consent/ask', {})).json();
    assert.equal(q1.queued, 4);
    assert.equal((await call(D, 'POST', '/api/wa-promo/consent/ask', {})).json().queued, 0, '이미 대기열이면 다시 안 넣음');
    calls.length = 0;
    await P.runPromoJob({});
    assert.equal(calls.length, 3, '상한 3');
    assert.ok(calls.filter((c) => c.kind === 'bare').every((c) => c.name === 'promo_consentimiento' && c.lang === 'es_MX'));
    const pedro = calls.find((c) => c.to === '528110000004');
    assert.ok(!pedro || pedro.kind === 'buttons', '창 열린 사람은 버튼 메시지');
    const left = (await call(D, 'GET', '/api/wa-promo/contacts')).json().counts;
    assert.equal(left.asked, 3); assert.equal(left.queued, 1);
    calls.length = 0; await P.runPromoJob({});
    assert.equal(calls.length, 0, '오늘 상한 다 씀');
    process.env.PROMO_WA_DAILY_CAP = '150';
    await P.runPromoJob({});
    assert.equal(calls.length, 1);
    if (calls[0].to === '528110000004') assert.equal(calls[0].kind, 'buttons');
    assert.equal((await contact('528110000004')).consent, 'asked');
    assert.equal((await query(`SELECT count(*)::int n FROM wa_messages WHERE source='consent' AND ok`)).rows[0].n, 4);
    calls.length = 0; await P.runPromoJob({});
    assert.equal(calls.length, 0, '한 사람에게 한 번만');
  });

  await t.test('B3. 받은 메시지 — 저장 · 중복 무시 · 「Sí, quiero」 동의 · BAJA 거부 · 상담 요청 · 그 밖의 말 · 쿨다운 · 미등록', async () => {
    calls.length = 0;
    const m1 = btn('5218110000001', 'Sí, quiero');
    await hook([m1]);
    let c = await contact('528110000001');
    assert.equal(c.consent, 'yes'); assert.equal(c.consent_via, 'button'); assert.equal(c.inbox_state, 'none', '동의 버튼은 미처리함에 안 쌓임');
    assert.equal(calls.length, 1); assert.equal(calls[0].kind, 'text'); assert.match(calls[0].text, /Recibirá nuestras promociones/);
    await hook([m1]);   // Meta 재전송
    assert.equal((await query(`SELECT count(*)::int n FROM wa_messages WHERE direction='in' AND phone='528110000001'`)).rows[0].n, 1, '같은 wamid 는 한 번만');
    assert.equal(calls.length, 1);
    await hook([txt('5218110000002', 'Sí, quiero')]);
    assert.equal((await contact('528110000002')).consent, 'yes');
    await hook([txt('5218110000003', 'Me pueden dar de BAJA por favor')]);
    assert.equal((await contact('528110000003')).consent, 'no');
    calls.length = 0;
    await hook([txt('5218110000002', 'Quiero cotizar amortiguadores')]);
    c = await contact('528110000002');
    assert.equal(c.lead, true); assert.equal(c.inbox_state, 'open'); assert.equal(c.consent, 'yes');
    assert.match(calls[0].text, /asesor/);
    calls.length = 0;
    await hook([txt('5218110000004', 'no acepto eso, cuánto cuesta el envío')]);
    assert.equal((await contact('528110000004')).consent, 'asked', '문장 속 「acepto」 로 동의 안 됨');
    assert.equal(calls.length, 1); assert.equal(calls[0].kind, 'buttons'); assert.deepEqual(calls[0].buttons, ['Quiero cotizar', 'Ver catálogo', 'Hablar con asesor']);
    await hook([txt('5218110000004', 'hola otra vez')]);
    assert.equal(calls.length, 1, '같은 자동응답은 6시간에 한 번');
    assert.equal((await contact('528110000004')).inbox_state, 'open');
    calls.length = 0;
    await hook([txt('5218119999999', 'hola soy del equipo')]);
    assert.equal(calls.length, 0, '등록 안 된 번호는 저장만');
    assert.equal((await query(`SELECT count(*)::int n FROM wa_messages WHERE phone='528119999999'`)).rows[0].n, 1);
  });

  let camp;
  await t.test('B4. 정기 발송 — 동의자만 · 이미지 1회 업로드 · 창 열림이면 일반 이미지 · 메모 조건 · 실패 2회 상한', async () => {
    // 동의: 0001(창 열림 — 방금 버튼), 0002(창 열림). 0003 거부, 0004 응답 대기. 0001 의 창을 닫는다.
    await query(`UPDATE wa_inbound SET last_at = now() - interval '2 days' WHERE wa_from='528110000001'`);
    assert.equal((await call(D, 'POST', '/api/wa-promo/campaigns', { send_at: '2026-10-14T10:00', caption: 'x' })).statusCode, 400, '이미지 필수');
    assert.equal((await call(D, 'POST', '/api/wa-promo/campaigns', { send_at: '2026-10-14', caption: 'x', image_b64: png.toString('base64'), image_mime: 'image/png' })).statusCode, 400);
    assert.equal((await call(D, 'POST', '/api/wa-promo/campaigns', { send_at: '2026-10-14T10:00', caption: 'x', image_b64: 'AAAA', image_mime: 'image/gif' })).statusCode, 400);
    const r = await call(D, 'POST', '/api/wa-promo/campaigns', { send_at: '2020-01-01T10:00', caption: 'Amortiguadores CTR\nVersa · 15%', image_b64: png.toString('base64'), image_mime: 'image/png', image_name: 'a.png' });
    assert.equal(r.statusCode, 200, r.body); camp = r.json(); assert.equal(camp.past, true); assert.equal(camp.audience, 2);
    calls.length = 0; uploads = 0;
    await P.runPromoJob({});
    assert.equal(uploads, 1, '이미지는 한 번만 올림');
    const it = calls.find((c) => c.kind === 'imageTemplate'); const im = calls.find((c) => c.kind === 'image');
    assert.equal(it.to, '528110000001'); assert.equal(it.name, 'promo_imagen'); assert.equal(it.param, 'Amortiguadores CTR Versa · 15%', '템플릿 변수는 한 줄');
    assert.equal(im.to, '528110000002'); assert.equal(im.caption, 'Amortiguadores CTR\nVersa · 15%');
    assert.equal(calls.filter((c) => ['image', 'imageTemplate'].includes(c.kind)).length, 2, '거부·응답 대기에게는 안 감');
    assert.equal((await one(`SELECT status FROM wa_campaigns WHERE id=$1`, [camp.id])).status, 'done');
    const st = (await call(D, 'GET', '/api/wa-promo/campaigns?from=2019-12-30&to=2020-01-05')).json().items[0];
    assert.equal(st.stats.sent, 2); assert.equal(st.target_n, 2);
    const img = await call(D, 'GET', `/api/wa-promo/campaigns/${camp.id}/image`);
    assert.equal(img.statusCode, 200); assert.equal(img.headers['content-type'], 'image/png');
    // 메모 조건 + 실패 재시도 상한
    failImage = true; calls.length = 0;
    const r2 = (await call(D, 'POST', '/api/wa-promo/campaigns', { send_at: '2020-01-02T09:00', caption: 'solo Monterrey', memo_filter: 'Monterrey', image_b64: png.toString('base64'), image_mime: 'image/png' })).json();
    assert.equal(r2.audience, 2);
    await P.runPromoJob({}); await P.runPromoJob({}); await P.runPromoJob({});
    const s2 = (await query(`SELECT contact_id, status, attempts FROM wa_campaign_sends WHERE campaign_id=$1 ORDER BY contact_id`, [r2.id])).rows;
    const tmplFails = s2.filter((x) => x.status === 'failed');
    assert.ok(tmplFails.every((x) => Number(x.attempts) === 2), '실패는 2번까지만');
    assert.equal((await one(`SELECT status FROM wa_campaigns WHERE id=$1`, [r2.id])).status, 'done');
    failImage = false;
  });

  await t.test('B5. 받은 메시지함 · 대화 · 직접 답장(창 닫힘 409) · 담당·처리 · 미등록→등록 · 엑셀 원자료', async () => {
    const l = (await call(D, 'GET', '/api/wa-promo/conversations?state=open')).json();
    assert.ok(l.items.some((x) => x.phone === '528110000002' && x.lead));
    assert.ok(!l.items.some((x) => x.phone === '528110000001'), '동의 버튼만 누른 사람은 미처리 아님');
    const cv = (await call(D, 'GET', '/api/wa-promo/conversations/8110000002')).json();
    assert.equal(cv.window.open, true);
    assert.ok(cv.items.some((m) => m.direction === 'out' && m.source === 'campaign'));
    assert.ok(cv.items.some((m) => m.direction === 'in' && /cotizar/.test(m.body)));
    calls.length = 0;
    const rp = await call(D, 'POST', '/api/wa-promo/conversations/8110000002/reply', { text: 'Claro, ¿qué año es su Versa?' });
    assert.equal(rp.statusCode, 200, rp.body); assert.equal(calls[0].kind, 'text');
    assert.equal((await call(D, 'POST', '/api/wa-promo/conversations/8110000001/reply', { text: 'hola' })).statusCode, 409, '창 닫힘');
    const ct = await contact('528110000002');
    await call(D, 'PATCH', `/api/wa-promo/contacts/${ct.id}`, { assigned_to: Number(rep.id), inbox_state: 'done', note: 'Versa 2017' });
    assert.equal((await contact('528110000002')).inbox_state, 'done');
    // 사람이 답장한 뒤 2시간은 「그 밖의 말」 자동응답 없음
    await query(`UPDATE wa_contacts SET inbox_state='open' WHERE id=$1`, [ct.id]);
    calls.length = 0; await hook([txt('5218110000002', 'Es 2017')]);
    assert.equal(calls.length, 0);
    const un = (await call(D, 'GET', '/api/wa-promo/conversations?state=unregistered')).json();
    assert.equal(un.items.length, 1); assert.equal(un.items[0].phone, '528119999999');
    assert.equal((await call(D, 'POST', '/api/wa-promo/conversations/528119999999/contact', { name: 'Equipo' })).statusCode, 200);
    assert.equal((await query(`SELECT count(*)::int n FROM wa_messages WHERE phone='528119999999' AND contact_id IS NULL`)).rows[0].n, 0);
    const ex = (await call(D, 'GET', '/api/wa-promo/messages/export')).json();
    assert.ok(ex.items.length >= 10); assert.ok(ex.items.every((x) => x.at_mx && x.direction && x.phone));
  });

  await t.test('B6. 발송 수정 · 취소 · 시험 발송 · 영업 확인 동의 · 자동응답 CRUD · 상태', async () => {
    const r = (await call(D, 'POST', '/api/wa-promo/campaigns', { send_at: '2099-01-01T10:00', caption: 'futuro', image_b64: png.toString('base64'), image_mime: 'image/png' })).json();
    assert.equal(r.past, false);
    assert.equal((await call(D, 'PATCH', `/api/wa-promo/campaigns/${r.id}`, { caption: 'futuro 2', send_at: '2099-01-02T11:30' })).statusCode, 200);
    const c = await one(`SELECT caption, to_char(send_at AT TIME ZONE 'America/Mexico_City','YYYY-MM-DD HH24:MI') t FROM wa_campaigns WHERE id=$1`, [r.id]);
    assert.equal(c.caption, 'futuro 2'); assert.equal(c.t, '2099-01-02 11:30');
    calls.length = 0; uploads = 0;
    const ts1 = await call(D, 'POST', `/api/wa-promo/campaigns/${r.id}/test`, { phone: '8112223333' });
    assert.equal(ts1.statusCode, 200, ts1.body); assert.equal(calls[0].to, '528112223333'); assert.equal(uploads, 1);
    assert.equal((await query(`SELECT count(*)::int n FROM wa_messages WHERE source='test'`)).rows[0].n, 1);
    assert.equal((await call(D, 'DELETE', `/api/wa-promo/campaigns/${r.id}`)).statusCode, 200);
    assert.equal((await call(D, 'PATCH', `/api/wa-promo/campaigns/${r.id}`, { caption: 'x' })).statusCode, 409);
    const p = await contact('528110000004');
    const s = await call(D, 'PATCH', `/api/wa-promo/contacts/${p.id}`, { consent: 'yes' });
    assert.equal(s.json().consent, 'yes'); assert.equal(s.json().consent_via, 'sales');
    assert.equal((await call(D, 'PATCH', `/api/wa-promo/contacts/${p.id}`, { consent: 'asked' })).statusCode, 400);
    const out = await contact('528110000003');   // B3 에서 BAJA 로 본인 수신거부
    assert.equal((await call(D, 'PATCH', `/api/wa-promo/contacts/${out.id}`, { consent: 'yes' })).statusCode, 409, '본인 수신거부는 사람이 못 되돌림');
    assert.equal((await call(D, 'POST', '/api/wa-promo/autoreplies', { keywords: '', reply: 'x' })).statusCode, 400);
    assert.equal((await call(D, 'POST', '/api/wa-promo/autoreplies', { is_fallback: true, reply: 'x' })).statusCode, 409, '「그 밖의 말」 규칙은 하나');
    const nr = (await call(D, 'POST', '/api/wa-promo/autoreplies', { sort: 50, keywords: 'horario, dirección', reply: 'L-V 8-18', buttons: 'Quiero cotizar, Ver catálogo, BAJA, extra', action: 'none' })).json();
    assert.deepEqual(nr.keywords, ['horario', 'dirección']); assert.equal(nr.buttons.length, 3);
    calls.length = 0; await hook([txt('5218110000004', '¿Cuál es su horario?')]);
    assert.equal(calls[0].kind, 'buttons'); assert.equal(calls[0].text, 'L-V 8-18');
    const stt = (await call(D, 'GET', '/api/wa-promo/status')).json();
    assert.equal(stt.cap, 150); assert.ok(stt.sent_today >= 6); assert.equal(stt.consent_template, 'promo_consentimiento'); assert.equal(stt.webhook, true);
    assert.equal((await call(Rp, 'POST', '/api/wa-promo/campaigns', {})).statusCode, 403);
  });

  await t.test('B7. 고른 사람에게만(0261) — 동의자만 대상 · 지금 보내기 · 지난 이미지 다시 쓰기 · 동의자 없으면 400', async () => {
    const ids = async (...phones) => (await query(`SELECT id FROM wa_contacts WHERE deleted_at IS NULL AND phone = ANY($1::text[]) ORDER BY id`, [phones])).rows.map((r) => Number(r.id));
    const [c1, c2, c3] = await ids('528110000001', '528110000002', '528110000003');   // ✅ ✅ ⛔
    const eq = await one(`SELECT id FROM wa_contacts WHERE phone='528119999999'`);          // ❓
    // 동의자 없음
    const bad = await call(D, 'POST', '/api/wa-promo/campaigns', { send_now: true, caption: 'x', image_b64: png.toString('base64'), image_mime: 'image/png', contact_ids: [c3, Number(eq.id)] });
    assert.equal(bad.statusCode, 400); assert.equal(bad.json().error, 'no_consented'); assert.equal(bad.json().picked.no, 1); assert.equal(bad.json().picked.unknown, 1);
    // 지난 이미지 목록 → 다시 쓰기 + 지금 보내기 + 섞어서 고르기(✅ 1명 · ⛔ 1명 · ❓ 1명)
    const ri = (await call(D, 'GET', '/api/wa-promo/campaigns/recent-images')).json();
    assert.ok(ri.items.length >= 1);
    const r = await call(D, 'POST', '/api/wa-promo/campaigns', { send_now: true, caption: 'Solo para usted', from_campaign_id: ri.items[0].id, contact_ids: [c1, c3, Number(eq.id)] });
    assert.equal(r.statusCode, 200, r.body);
    const k = r.json(); assert.equal(k.past, true); assert.equal(k.audience, 1); assert.deepEqual([k.picked.selected, k.picked.yes, k.picked.no, k.picked.unknown], [3, 1, 1, 1]);
    const row = await one(`SELECT target_ids, memo_filter, octet_length(image) n FROM wa_campaigns WHERE id=$1`, [k.id]);
    assert.deepEqual(row.target_ids.map(Number), [c1], '저장되는 대상은 동의자만'); assert.equal(row.memo_filter, null); assert.ok(Number(row.n) > 0);
    calls.length = 0;
    await P.runPromoJob({});
    const sends = calls.filter((c) => ['image', 'imageTemplate'].includes(c.kind));
    assert.equal(sends.length, 1); assert.equal(sends[0].to, '528110000001', '고른 동의자 한 명에게만');
    assert.equal((await one(`SELECT status FROM wa_campaigns WHERE id=$1`, [k.id])).status, 'done');
    // 2명 예약 → 목록에 「고른 N명」
    const r2 = (await call(D, 'POST', '/api/wa-promo/campaigns', { send_at: '2099-02-01T10:00', caption: 'dos', image_b64: png.toString('base64'), image_mime: 'image/png', contact_ids: [c1, c2] })).json();
    assert.equal(r2.audience, 2); assert.equal(r2.past, false);
    const lst = (await call(D, 'GET', '/api/wa-promo/campaigns?from=2099-02-01&to=2099-02-01')).json().items;
    assert.equal(lst[0].target_sel, 2);
    assert.equal((await call(D, 'POST', '/api/wa-promo/campaigns', { send_now: true, caption: 'x', image_b64: png.toString('base64'), image_mime: 'image/png', contact_ids: [] })).statusCode, 400);
    await call(D, 'DELETE', `/api/wa-promo/campaigns/${r2.id}`);
  });

  await t.test('B8. 0281 이미지 뱅크 — 올리기 · 같은 파일 중복 · 썸네일 · 목록(사용 횟수) · 뱅크 이미지로 예약 · 직접 올린 이미지도 뱅크로 · 이력 · 옮기기/삭제 · 권한 · 기존 발송 옮겨 담기', async () => {
    const { readFileSync } = await import('node:fs');
    const v = (tag) => Buffer.concat([png, Buffer.from(tag)]).toString('base64');
    const thumb = Buffer.from('fakejpegthumb').toString('base64');
    // 권한: 영업 403
    assert.equal((await call(Rp, 'GET', '/api/wa-promo/images')).statusCode, 403);
    // 올리기 + 중복
    const a = (await call(D, 'POST', '/api/wa-promo/images', { name: 'versa.png', mime: 'image/png', image_b64: v('A'), thumb_b64: thumb, width: 1080, height: 1080, folder: '2026-11 Versa' })).json();
    assert.ok(a.id); assert.equal(a.duplicate, false);
    const a2 = (await call(D, 'POST', '/api/wa-promo/images', { name: 'otro_nombre.png', mime: 'image/png', image_b64: v('A') })).json();
    assert.deepEqual(a2, { id: a.id, duplicate: true }, '같은 파일은 한 번만');
    const b = (await call(D, 'POST', '/api/wa-promo/images', { name: 'aveo.png', mime: 'image/png', image_b64: v('B') })).json();
    assert.equal((await call(D, 'POST', '/api/wa-promo/images', { name: 'x.gif', mime: 'image/gif', image_b64: v('C') })).json().error, 'bad_image_type');
    // 썸네일(있으면 썸네일 · 없으면 원본) · 원본
    const th = await call(D, 'GET', `/api/wa-promo/images/${a.id}/thumb`); assert.equal(th.headers['content-type'], 'image/jpeg'); assert.equal(th.rawPayload.toString(), 'fakejpegthumb');
    assert.equal((await call(D, 'GET', `/api/wa-promo/images/${b.id}/thumb`)).headers['content-type'], 'image/png');
    assert.equal((await call(D, 'GET', `/api/wa-promo/images/${a.id}/file`)).rawPayload.length, png.length + 1);
    // 뱅크 이미지로 예약 → 목록에 사용 1회 · 이력
    const c1 = (await call(D, 'POST', '/api/wa-promo/campaigns', { send_at: '2099-03-02T10:00', caption: 'Horquillas Versa', image_id: a.id })).json();
    assert.ok(c1.id);
    const crow = await one(`SELECT image_id, octet_length(image) n, image_name FROM wa_campaigns WHERE id=$1`, [c1.id]);
    assert.equal(Number(crow.image_id), a.id); assert.equal(Number(crow.n), png.length + 1, '발송은 자기 사본'); assert.equal(crow.image_name, 'versa.png');
    // 직접 올린 이미지 → 뱅크에도(폴더 「발송에서 올림」) · 같은 파일이면 있던 것과 이어짐
    const c2 = (await call(D, 'POST', '/api/wa-promo/campaigns', { send_at: '2099-03-05T10:00', caption: 'Aveo', image_b64: v('B'), image_mime: 'image/png', image_name: 'aveo_copia.png' })).json();
    assert.equal(Number((await one(`SELECT image_id FROM wa_campaigns WHERE id=$1`, [c2.id])).image_id), b.id);
    const c3 = (await call(D, 'POST', '/api/wa-promo/campaigns', { send_at: '2099-03-09T10:00', caption: 'Nueva', image_b64: v('N'), image_mime: 'image/png', image_name: 'nueva.png' })).json();
    const nid = Number((await one(`SELECT image_id FROM wa_campaigns WHERE id=$1`, [c3.id])).image_id);
    let L = (await call(D, 'GET', '/api/wa-promo/images')).json();
    const byId = (id) => L.items.find((x) => x.id === id);
    assert.equal(byId(nid).folder, '발송에서 올림'); assert.equal(byId(nid).name, 'nueva.png');
    assert.equal(byId(a.id).uses, 1); assert.equal(byId(a.id).last_used_mx, '2099-03-02T10:00'); assert.equal(byId(a.id).has_thumb, true); assert.equal(byId(a.id).width, 1080);
    assert.ok(L.folders.some((f) => f.folder === '2026-11 Versa' && f.n === 1));
    // 이력: 같은 이미지 두 번 → 날짜 내림차순 · 취소한 것은 사용 횟수에서 빠짐
    const c4 = (await call(D, 'POST', '/api/wa-promo/campaigns', { send_at: '2099-04-01T10:00', caption: 'Versa otra vez', from_campaign_id: c1.id })).json();
    assert.equal(Number((await one(`SELECT image_id FROM wa_campaigns WHERE id=$1`, [c4.id])).image_id), a.id, '지난 발송 다시 쓰기도 같은 뱅크 이미지');
    const h = (await call(D, 'GET', `/api/wa-promo/images/${a.id}/history`)).json().items;
    assert.deepEqual(h.map((x) => x.send_at_mx), ['2099-04-01T10:00', '2099-03-02T10:00']);
    await call(D, 'DELETE', `/api/wa-promo/campaigns/${c4.id}`);
    L = (await call(D, 'GET', '/api/wa-promo/images')).json(); assert.equal(byId(a.id).uses, 1);
    // 발송 목록에 image_id
    assert.equal((await call(D, 'GET', '/api/wa-promo/campaigns?from=2099-03-02&to=2099-03-02')).json().items[0].image_id, a.id);
    // 수정: 뱅크 이미지로 바꾸기
    assert.equal((await call(D, 'PATCH', `/api/wa-promo/campaigns/${c3.id}`, { image_id: b.id })).statusCode, 200);
    assert.equal(Number((await one(`SELECT image_id FROM wa_campaigns WHERE id=$1`, [c3.id])).image_id), b.id);
    // 이름 · 폴더 · 여러 장 옮기기 · 검색
    assert.equal((await call(D, 'PATCH', `/api/wa-promo/images/${b.id}`, { name: 'aveo_final.png', folder: 'Aveo' })).statusCode, 200);
    assert.equal((await call(D, 'POST', '/api/wa-promo/images/bulk', { ids: [a.id, b.id], action: 'move', folder: 'Promo noviembre' })).json().updated, 2);
    L = (await call(D, 'GET', '/api/wa-promo/images?folder=' + encodeURIComponent('Promo noviembre'))).json(); assert.equal(L.items.length, 2);
    assert.equal((await call(D, 'GET', '/api/wa-promo/images?q=aveo_final')).json().items.length, 1);
    // 삭제(소프트) — 예약은 그대로 · 같은 파일을 다시 올리면 새로 저장
    assert.equal((await call(D, 'POST', '/api/wa-promo/images/bulk', { ids: [a.id], action: 'delete' })).json().updated, 1);
    assert.equal((await call(D, 'GET', '/api/wa-promo/images')).json().items.some((x) => x.id === a.id), false);
    assert.equal((await one(`SELECT status FROM wa_campaigns WHERE id=$1`, [c1.id])).status, 'scheduled', '예약은 그대로');
    assert.equal((await call(D, 'POST', '/api/wa-promo/campaigns', { send_at: '2099-05-01T10:00', caption: 'x', image_id: a.id })).json().error, 'image_source_not_found');
    const a3 = (await call(D, 'POST', '/api/wa-promo/images', { name: 'versa.png', mime: 'image/png', image_b64: v('A') })).json(); assert.equal(a3.duplicate, false); assert.notEqual(a3.id, a.id);
    // 0281 옮겨 담기 — image_id 없는 옛 발송(마이그레이션 다시 실행 · 멱등)
    const old = await one(`INSERT INTO wa_campaigns (send_at, caption, image, image_mime, image_name) VALUES (now() + interval '400 days', 'viejo', $1, 'image/png', 'viejo.png') RETURNING id`, [Buffer.concat([png, Buffer.from('OLD')])]);
    const sql = readFileSync(new URL('../migrations/0281_wa_image_bank.sql', import.meta.url), 'utf-8');
    await query(sql); await query(sql);
    const oi = await one(`SELECT c.image_id, i.folder, i.name FROM wa_campaigns c JOIN wa_images i ON i.id = c.image_id WHERE c.id=$1`, [old.id]);
    assert.equal(oi.folder, '지난 발송'); assert.equal(oi.name, 'viejo.png');
    assert.equal(Number((await one(`SELECT count(*) n FROM wa_images WHERE hash = md5($1::bytea) AND deleted_at IS NULL`, [Buffer.concat([png, Buffer.from('OLD')])])).n), 1, '두 번 실행해도 하나');
    for (const id of [c1.id, c2.id, c3.id, old.id]) await call(D, 'DELETE', `/api/wa-promo/campaigns/${id}`);
  });
});
