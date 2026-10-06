// =====================================================================
// wa_webhook.test.mjs — WhatsApp 웹훅(0253): 도착·읽음·실패 사유 + 24시간 창 (2026-10-06)
//   A. 순수 규칙(서명 · 오류 설명)
//   B. 실제 서버 + PostgreSQL(TEST_PG_URL): 등록 확인 · 서명 · 상태 순서 · 창 밖 실패 재오픈 ·
//      수신(521 → 52) · 창 닫힘이면 이미지 템플릿부터 · 일일자금 원장/수신자 화면 데이터
// =====================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-wa-webhook';
const H = await import('../src/waWebhook.js');

const SECRET = 'app-secret-for-test';
const sign = (raw, secret = SECRET) => 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
const statusBody = (id, status, extra = {}) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp',
    statuses: [{ id, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '5218110005311', ...extra }] } }] }],
});
const inboundBody = (from, tsSec) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp',
    contacts: [{ wa_id: from }], messages: [{ from, id: 'wamid.IN1', timestamp: String(tsSec), type: 'text', text: { body: 'hola' } }] } }] }],
});

test('A1. 서명 검증 — 맞는 서명만 통과', () => {
  const raw = JSON.stringify({ a: 1, ñ: 'é' });
  assert.equal(H.verifySignature(raw, sign(raw), SECRET), true);
  assert.equal(H.verifySignature(raw, sign(raw, 'other'), SECRET), false);
  assert.equal(H.verifySignature(raw + ' ', sign(raw), SECRET), false, '본문이 바뀌면 실패');
  assert.equal(H.verifySignature(raw, 'sha256=zz', SECRET), false);
  assert.equal(H.verifySignature(raw, sign(raw), ''), false, '앱 시크릿 없으면 실패');
});

test('A2. 오류 코드 설명', () => {
  assert.match(H.explainWaError(131047), /24시간 창 밖/);
  assert.match(H.explainWaError(131042), /결제/);
  assert.equal(H.explainWaError(999999, 'Some title'), 'Some title');
  assert.ok(H.WINDOW_CODES.has(131047) && H.WINDOW_CODES.has(470));
});

test('B. 실제 서버 + PostgreSQL', { skip: !PG && 'TEST_PG_URL 없음' }, async (t) => {
  const { query, pool } = await import('../src/db.js');
  after(async () => { await pool.end().catch(() => {}); setTimeout(() => process.exit(process.exitCode || 0), 300); });
  const keep = { ...process.env };
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'verify-me-123';
  process.env.WHATSAPP_APP_SECRET = SECRET;
  process.env.WHATSAPP_TOKEN = 't'; process.env.WHATSAPP_PHONE_ID = '1';
  t.after(() => { process.env = keep; });

  const { buildApp } = await import('../src/server.js');
  const app = buildApp(); await app.ready();
  t.after(() => app.close());
  const post = (obj, sig) => { const raw = JSON.stringify(obj);
    return app.inject({ method: 'POST', url: '/api/wa/webhook', payload: raw,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig === undefined ? sign(raw) : sig } }); };

  await query(`DELETE FROM wa_message_status; DELETE FROM wa_inbound; DELETE FROM treasury_wa_sends; DELETE FROM treasury_wa_recipients;`);
  const one = async (sql, a) => (await query(sql, a)).rows[0];
  const dir = (await one(`SELECT id FROM users WHERE login_id='whdir'`)) || await one(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ('WH Director','director','x','whdir') RETURNING id`);
  const D = 'Bearer ' + app.jwt.sign({ sub: Number(dir.id), role: 'director' });

  await t.test('B1. Meta 등록 확인(hub.challenge)', async () => {
    const ok = await app.inject({ method: 'GET', url: '/api/wa/webhook?hub.mode=subscribe&hub.verify_token=verify-me-123&hub.challenge=4242' });
    assert.equal(ok.statusCode, 200); assert.equal(ok.body, '4242');
    const bad = await app.inject({ method: 'GET', url: '/api/wa/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1' });
    assert.equal(bad.statusCode, 403);
  });

  await t.test('B2. 서명이 틀리면 버린다', async () => {
    assert.equal((await post(statusBody('wamid.FAKE', 'read'), 'sha256=' + '0'.repeat(64))).statusCode, 401);
    assert.equal((await post(statusBody('wamid.FAKE', 'read'), '')).statusCode, 401);
    assert.equal((await query(`SELECT count(*)::int n FROM wa_message_status`)).rows[0].n, 0);
  });

  await t.test('B3. 상태 순서 — 늦게 온 「도착」이 「읽음」을 덮지 않는다 · 번호는 52 로', async () => {
    assert.equal((await post(statusBody('wamid.A', 'sent'))).statusCode, 200);
    await post(statusBody('wamid.A', 'read'));
    await post(statusBody('wamid.A', 'delivered'));
    const r = await one(`SELECT * FROM wa_message_status WHERE message_id='wamid.A'`);
    assert.equal(r.status, 'read'); assert.ok(r.read_at && r.delivered_at && r.sent_at);
    assert.equal(r.recipient, '528110005311');
  });

  // 일일자금 수신자 + 「접수 성공」 기록(이미지)
  const rc = await one(`INSERT INTO treasury_wa_recipients (name, phone, lang) VALUES ('Seba','528110005311','ko') RETURNING id`);
  await query(`INSERT INTO treasury_wa_sends (kind, period, recipient_id, to_masked, status, message_id, attempts, sent_at)
               VALUES ('daily','2026-10-05',$1,'528****5311','sent_image','wamid.T1',1,now())`, [rc.id]);

  await t.test('B4. 창 밖 실패(131047) → 사유 기록 + 일일자금 원장 재오픈(재시도 가능)', async () => {
    await post(statusBody('wamid.T1', 'sent'));
    await post(statusBody('wamid.T1', 'failed', { errors: [{ code: 131047, title: 'Re-engagement message',
      error_data: { details: 'Message failed to send because more than 24 hours have passed' } }] }));
    const m = await one(`SELECT * FROM wa_message_status WHERE message_id='wamid.T1'`);
    assert.equal(m.status, 'failed'); assert.equal(m.error_code, 131047);
    const s = await one(`SELECT * FROM treasury_wa_sends WHERE message_id='wamid.T1'`);
    assert.equal(s.status, 'failed'); assert.equal(s.sent_at, null, '재시도되도록 성공 표시 해제');
    assert.match(s.error, /24시간 창 밖/);
  });

  await t.test('B5. 다른 실패(131042)는 원장을 재오픈하지 않고 사유만', async () => {
    await query(`UPDATE treasury_wa_sends SET status='sent_image', sent_at=now(), message_id='wamid.T2', error=NULL WHERE recipient_id=$1`, [rc.id]);
    await post(statusBody('wamid.T2', 'failed', { errors: [{ code: 131042, title: 'Business eligibility payment issue' }] }));
    const s = await one(`SELECT * FROM treasury_wa_sends WHERE recipient_id=$1`, [rc.id]);
    assert.notEqual(s.sent_at, null); assert.equal(s.status, 'sent_image');
  });

  await t.test('B6. 원장 API — 실제 전달 상태와 사유(한국어)', async () => {
    const st = (await app.inject({ method: 'GET', url: '/api/treasury/wa/status', headers: { authorization: D } })).json();
    assert.equal(st.webhook.configured, true); assert.ok(st.webhook.last_event_at);
    const row = st.recent.find((x) => x.recipient_id === Number(rc.id));
    assert.equal(row.dlv_status, 'failed'); assert.equal(row.dlv_code, 131042); assert.match(row.dlv_reason, /결제/);
  });

  await t.test('B7. 수신 메시지 → 24시간 창(웹훅은 521… 로 보냄 → 52… 로 맞춤)', async () => {
    let rl = (await app.inject({ method: 'GET', url: '/api/treasury/recipients', headers: { authorization: D } })).json();
    assert.equal(rl.items[0].window_open, false, '받은 메시지 없음 → 닫힘');
    assert.equal((await H.windowState('5218110005311')).open, false);
    await post(inboundBody('5218110005311', Math.floor(Date.now() / 1000) - 60));
    const i = await one(`SELECT * FROM wa_inbound WHERE wa_from='528110005311'`);
    assert.equal(i.last_type, 'text'); assert.equal(i.msg_count, 1);
    rl = (await app.inject({ method: 'GET', url: '/api/treasury/recipients', headers: { authorization: D } })).json();
    assert.equal(rl.items[0].window_open, true); assert.ok(rl.items[0].inbound_at);
    // 오래된 메시지가 늦게 와도 마지막 시각을 되돌리지 않음
    await post(inboundBody('5218110005311', Math.floor(Date.now() / 1000) - 3 * 86400));
    assert.equal((await H.windowState('528110005311')).open, true);
    await query(`UPDATE wa_inbound SET last_at = now() - interval '25 hours'`);
    assert.equal((await H.windowState('528110005311')).open, false, '25시간 지나면 닫힘');
  });

  await t.test('B8. 창이 닫혀 있으면 이미지 템플릿부터(자유 이미지는 접수 후 실패하므로)', async () => {
    const T = await import('../src/treasuryDaily.js');
    process.env.TREASURY_WA_IMAGE_TEMPLATE = 'resumen_caja_img';
    const calls = [];
    const imgApi = {
      upload: async () => ({ ok: true, id: 'MID' }),
      image: async (a) => { calls.push('image:' + a.to); return { ok: true, message_id: 'wamid.IMG' }; },
      imageTemplate: async (a) => { calls.push('tpl:' + a.name); return { ok: true, message_id: 'wamid.TPL' }; },
    };
    const sender = async () => { calls.push('text'); return { ok: true, mode: 'text', message_id: 'wamid.TXT' }; };
    const rcpt = { id: rc.id, phone: '528110005311' };
    await query(`DELETE FROM treasury_wa_sends`);
    const r1 = await T.sendOne({ kind: 'daily', period: '2026-10-05', rcpt, text: 't', headline: 'h', png: Buffer.from('x'), force: true, sender, imgApi });
    assert.equal(r1.status, 'sent_image_template'); assert.deepEqual(calls, ['tpl:resumen_caja_img']);
    // 창이 열리면 예전처럼 자유 이미지
    await query(`UPDATE wa_inbound SET last_at = now()`); calls.length = 0;
    const r2 = await T.sendOne({ kind: 'daily', period: '2026-10-04', rcpt, text: 't', headline: 'h', png: Buffer.from('x'), force: true, sender, imgApi });
    assert.equal(r2.status, 'sent_image'); assert.deepEqual(calls, ['image:528110005311']);
    // 웹훅 미설정이면(창을 모름) 기존 동작 그대로
    delete process.env.WHATSAPP_APP_SECRET; await query(`UPDATE wa_inbound SET last_at = now() - interval '3 days'`); calls.length = 0;
    const r3 = await T.sendOne({ kind: 'daily', period: '2026-10-03', rcpt, text: 't', headline: 'h', png: Buffer.from('x'), force: true, sender, imgApi });
    assert.equal(r3.status, 'sent_image'); assert.deepEqual(calls, ['image:528110005311']);
    process.env.WHATSAPP_APP_SECRET = SECRET; delete process.env.TREASURY_WA_IMAGE_TEMPLATE;
  });

  await t.test('B9. 웹훅 설정 정보(디렉터)', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/wa/webhook/info', headers: { authorization: D } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().callback_url, 'https://refatrix-production.up.railway.app/api/wa/webhook');
    assert.equal((await app.inject({ method: 'GET', url: '/api/wa/webhook/info' })).statusCode, 401);
  });

  await query(`DELETE FROM wa_message_status; DELETE FROM wa_inbound; DELETE FROM treasury_wa_sends; DELETE FROM treasury_wa_recipients;`);
});
