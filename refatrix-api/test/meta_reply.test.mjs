// =====================================================================
// meta_reply.test.mjs — 0331 · 「💬 답장 필요」 · 「● 새 메시지」
//   A. 대화 → 손님 마지막 · 우리 사람 답장 마지막 · 그 뒤 손님 메시지 수(자동 응답 · Meta 기록 · 봇 안내문은 답장 아님)
//   B. 실제 서버 + PostgreSQL: 계산 저장 · 목록 표시/필터 · 열면 새 메시지 지움 · Messenger 웹훅 메시지 합침 · WhatsApp ERP 자동응답 = 봇
//      · 내 할당 「답장 필요」(대화함이어도 · 맡은 날과 관계없이) · 탭 숫자 · 판매/제외는 표시 안 함
//   실행: TEST_PG_URL=postgres://... node --test test/meta_reply.test.mjs
// =====================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-meta-reply';
process.env.META_ASSIGN_WORKER = '0'; process.env.META_REPLY_WORKER = '0'; process.env.META_LEADS_WA_LIVE = '0';
const at = (m) => new Date(Date.now() - (600 - m) * 60000).toISOString();

test('A. 답장 필요 계산', async () => {
  const { replyStateOf } = await import('../src/metaReply.js');
  let s = replyStateOf([{ at: at(0), me: false, text: 'precio horquilla' }, { at: at(0.2), me: true, kind: 'auto', text: 'Meta_0001 Hola' }]);
  assert.equal(s.pending_n, 1, '자동 응답만 = 답장 필요'); assert.equal(s.last_out, null);
  s = replyStateOf([{ at: at(0), me: false, text: 'hola' }, { at: at(5), me: true, text: 'Claro, ¿qué año?' }]);
  assert.equal(s.pending_n, 0); assert.ok(s.last_out);
  s = replyStateOf([{ at: at(0), me: false, text: 'hola' }, { at: at(5), me: true, text: 'Claro' }, { at: at(60), me: false, text: '2018' }, { at: at(61), me: false, text: 'versa' }, { at: at(62), kind: 'event', me: true, text: 'x' }]);
  assert.equal(s.pending_n, 2, '우리 답 뒤 손님 2건');
  s = replyStateOf([{ at: at(0), me: false, text: 'hola' }, { at: at(5), me: true, bot: true, text: 'Gracias por escribir' }]);
  assert.equal(s.pending_n, 1, 'ERP 봇 = 답장 아님');
});

test('A2. 1119g · 받은편지함 작업 기록(담당 지정 · 완료 · 라벨) = Meta 기록 — 대화 · 답장 아님', async () => {
  const { isMetaEvent, markMetaKinds } = await import('../src/leadPortal.js');
  const { replyStateOf } = await import('../src/metaReply.js');
  for (const t of ['Luis Oscar Guzmán Palomino asignó esta conversación a Luis Oscar Guzmán Palomino.', 'Se asignó a María', 'Ana marcó esta conversación como lista.', 'Juan agregó la etiqueta Prioridad', 'Oscar assigned this conversation to Ana'])
    assert.equal(isMetaEvent(t), true, t);
  for (const t of ['¿Podrías confirmar el modelo exacto de la camioneta Kia?', 'Te asigno el pedido mañana', 'Ya le asigné un asesor a tu pedido', 'marca la etiqueta del producto'])
    assert.equal(isMetaEvent(t), false, t);
  const ms = markMetaKinds([{ at: at(0), me: false, text: 'tendrás válvulas de cabeza' }, { at: at(100), me: true, text: 'Luis Oscar Guzmán Palomino asignó esta conversación a Luis Oscar Guzmán Palomino.' }]);
  assert.equal(ms[1].kind, 'event');
  assert.equal(replyStateOf(ms).pending_n, 1, '담당 지정 기록은 답장이 아님 → 답장 필요');
});

test('B. 실제 서버 + PostgreSQL', { skip: !PG && 'TEST_PG_URL 없음' }, async (t) => {
  const { query, pool } = await import('../src/db.js');
  after(async () => { await pool.end().catch(() => {}); setTimeout(() => process.exit(process.exitCode || 0), 300); });
  const { buildApp } = await import('../src/server.js');
  const app = buildApp(); await app.ready(); t.after(() => app.close());
  const R = await import('../src/metaReply.js'); R.resetReplyReady();
  const one = async (sql, a) => (await query(sql, a)).rows[0];
  await query(`DELETE FROM meta_lead_seen; DELETE FROM meta_lead_notes; DELETE FROM meta_assignments; DELETE FROM meta_assign_members; DELETE FROM meta_ad_touches; DELETE FROM meta_threads;
               DELETE FROM meta_page_messages WHERE psid LIKE 'rp%'; DELETE FROM wa_messages WHERE phone = '528110000088';`);
  const SFX = Date.now().toString(36).slice(-5);
  const mk = async (name, role, page) => { const u = await one(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,'x',$3) RETURNING id`, [`${name} ${SFX}`, role, `${name.toLowerCase()}${SFX}`]);
    if (page) await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access) VALUES ($1,$2,'anywhere','view')`, [u.id, page]);
    return { id: Number(u.id), h: { authorization: 'Bearer ' + app.jwt.sign({ sub: Number(u.id), role }) } }; };
  const dir = await mk('RDir', 'director'); const ana = await mk('RAna', 'sales', 'quote');
  const call = (u, method, url, payload) => app.inject({ method, url, payload, headers: u.h });
  const th = async (n, msgs, { platform = 'messenger', status = 'nuevo', uid = null } = {}) => Number((await one(
    `INSERT INTO meta_threads (platform, thread_id, user_id, name, first_at, last_at, last_in_at, messages, customer_text, in_count, msg_count, status)
     VALUES ($1,$2,$3,$4,$5,$6,$6,$7::jsonb,'x',1,$8,$9) RETURNING id`,
    [platform, (platform === 'whatsapp' ? 'wa:' : 'rt') + (uid || n), uid || 'rp' + n, 'Cliente ' + n, msgs[0].at, msgs[msgs.length - 1].at, JSON.stringify(msgs), msgs.length, status])).id);
  const T1 = await th(1, [{ at: at(0), me: false, text: 'precio' }, { at: at(5), me: true, text: 'Claro, ¿qué año?' }, { at: at(500), me: false, text: '2018 versa' }]);   // 손님이 나중에 답함
  const T2 = await th(2, [{ at: at(0), me: false, text: 'precio' }, { at: at(5), me: true, text: 'Claro' }]);                                                      // 우리가 마지막
  const T3 = await th(3, [{ at: at(0), me: false, text: 'hola' }, { at: at(5), me: true, text: 'Claro' }]);                                                        // 웹훅으로 손님 답이 옴
  const T4 = await th(4, [{ at: at(0), me: false, text: 'ya compré' }], { status: 'venta' });                                                                     // 판매 = 표시 안 함
  const T5 = await th(5, [{ at: at(0), me: false, text: 'hola' }, { at: at(1), me: true, text: 'Gracias por escribir a Refatrix' }], { platform: 'whatsapp', uid: '528110000088' });
  await query(`INSERT INTO meta_page_messages (psid, mid, direction, source, text, at) VALUES ('rp3','m.rp3a','in','customer','¿y el precio?', now() - interval '3 minutes')`);
  await query(`INSERT INTO wa_messages (direction, phone, kind, body, source, ok, at) VALUES ('out','528110000088','text','Gracias por escribir a Refatrix','autoreply',true,$1)`, [at(1)]);

  await t.test('B1. 계산 · 목록 표시 · 필터 · 판매 제외 · ERP 봇은 답장 아님', async () => {
    const r = await R.refreshReplyState(); assert.ok(r.updated >= 5);
    const items = (await call(dir, 'GET', '/api/meta-leads/list')).json().items;
    const by = new Map(items.map((x) => [x.id, x]));
    assert.equal(by.get(T1).need_reply, true); assert.equal(by.get(T1).reply_pending_n, 1); assert.equal(by.get(T1).unread, true);
    assert.equal(by.get(T2).need_reply, false);
    assert.equal(by.get(T3).need_reply, true, 'Messenger 웹훅 메시지 합침');
    assert.equal(by.get(T4).need_reply, false, '판매는 표시 안 함');
    assert.equal(by.get(T5).need_reply, true, 'WhatsApp ERP 자동응답 = 봇');
    const need = (await call(dir, 'GET', '/api/meta-leads/list?need=1')).json().items.map((x) => x.id).sort();
    assert.deepEqual(need, [T1, T3, T5].sort());
  });
  await t.test('B2. 열면 「새 메시지」 지움(사람마다) · 우리가 답하면 「답장 필요」 지움', async () => {
    await call(dir, 'GET', `/api/meta-leads/${T1}`);
    let by = new Map((await call(dir, 'GET', '/api/meta-leads/list')).json().items.map((x) => [x.id, x]));
    assert.equal(by.get(T1).unread, false); assert.equal(by.get(T1).need_reply, true, '열기만 하면 답장 필요는 그대로');
    await query(`INSERT INTO meta_page_messages (psid, mid, direction, source, text, at) VALUES ('rp1','m.rp1b','out','staff','Sí, tenemos para Versa 2018', now())`);
    await R.refreshReplyState({ ids: [T1] });
    by = new Map((await call(dir, 'GET', '/api/meta-leads/list')).json().items.map((x) => [x.id, x]));
    assert.equal(by.get(T1).need_reply, false, 'Business Suite 답장(에코) 반영');
  });
  await t.test('B3. 내 할당 「답장 필요」 — 대화함이어도 · 맡은 날 관계없이 · 탭 숫자', async () => {
    await call(dir, 'PUT', '/api/meta-assign/config', { mode: 'target', members: [{ user_id: ana.id, daily_target: 5 }] });
    for (const id of [T2, T3, T5]) await call(dir, 'POST', `/api/meta-leads/${id}/assign`, { user_id: ana.id });
    await query(`UPDATE meta_assignments SET day = day - 3, done_at = now(), done_how='reply' WHERE thread_id = $1`, [T3]);   // 사흘 전에 맡아 대화함
    const m = (await call(ana, 'GET', '/api/meta-assign/mine?scope=need')).json().items;
    assert.deepEqual(m.map((x) => x.id).sort(), [T3, T5].sort());
    assert.ok(m.every((x) => x.need_reply === true));
    const c = (await call(ana, 'GET', '/api/meta-assign/config')).json();
    assert.equal(c.me.need_n, 2); assert.equal(c.me.unread_n, 2);
    const today = (await call(ana, 'GET', '/api/meta-assign/mine?scope=open')).json().items;
    assert.equal(today[0].need_reply, true, '답장 필요가 맨 위');
    const all = (await call(dir, 'GET', '/api/meta-assign/list?state=need')).json().items;
    assert.ok(all.every((x) => x.need_reply === true));
  });
});
