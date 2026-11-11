// =====================================================================
// wa_erp_media.test.mjs — 1111 · 광고 WhatsApp 을 ERP 번호(8128806680)로 받기
//   ① 손님 사진 · 음성 · PDF 보기(웹훅 → 미리 저장 · 저장본 · 30일 지남 410)
//   ② 직원이 사진 · PDF 보내기(업로드 1회 · 보낸 파일도 다시 봄 · 형식 · 크기 · 24시간 창 409)
//   ③ Meta 광고 문의 화면 — 대화에 파일(mid) · 창 상태 · 답장(글 · 파일) · 다른 문의 파일은 못 봄
//   ④ 새 메시지 알림(pulse) — 새 메시지 수 · 답장 기다림 · 사내 번호 제외
//   ⑤ 8128806680 은 손님 전화로 안 잡힘
//   실행: TEST_PG_URL=postgres://... node --test test/wa_erp_media.test.mjs
// =====================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-wa-media';
process.env.META_LEADS_WA_DELAY_MS = '0';

test('⑤ 8128806680(ERP 번호)은 손님 전화로 안 잡힘', async () => {
  const { extractLead } = await import('../src/metaLeadExtract.js');
  assert.equal(extractLead('escríbanos al 81 2880 6680 para cotizar').phone || null, null);
  assert.equal(extractLead('mi cel 8123456789').phone, '8123456789');
});

test('실제 서버 + PostgreSQL', { skip: !PG && 'TEST_PG_URL 없음' }, async (t) => {
  const { query, pool } = await import('../src/db.js');
  after(async () => { await pool.end().catch(() => {}); setTimeout(() => process.exit(process.exitCode || 0), 300); });
  const keep = { ...process.env };
  Object.assign(process.env, { WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_ID: '1', WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'verify-me-123', WHATSAPP_APP_SECRET: 'sec', DAILY_SUMMARY_WA_TO: '528119990000' });
  t.after(() => { process.env = keep; });
  const P = await import('../src/waPromo.js');
  const M = await import('../src/waMedia.js');

  const calls = []; let seq = 0;
  const ok = (kind) => async (a) => { calls.push({ kind, ...a }); return { ok: true, message_id: `wamid.M${++seq}` }; };
  P.setPromoApi({ text: ok('text'), image: ok('image'), document: ok('document'), buttons: ok('buttons'),
    upload: async (buf, o) => { calls.push({ kind: 'upload', size: buf.length, ...o }); return { ok: true, id: `UP${++seq}` }; } });
  t.after(() => P.setPromoApi(null));
  const JPG = Buffer.from('ffd8ffe000104a4649460001', 'hex');
  const fetched = [];
  M.setMediaFetcher(async (id) => { fetched.push(id); if (id === 'M-OLD') return { ok: false, error: 'media_expired' };
    return { ok: true, mime: id.startsWith('M-PDF') ? 'application/pdf' : (id.startsWith('M-AUD') ? 'audio/ogg' : 'image/jpeg'), bytes: Buffer.concat([JPG, Buffer.from(id)]) }; });
  t.after(() => M.setMediaFetcher(null));

  const { buildApp } = await import('../src/server.js');
  const app = buildApp(); await app.ready(); t.after(() => app.close());
  await query(`DELETE FROM wa_campaign_sends; DELETE FROM wa_messages; DELETE FROM wa_inbound; DELETE FROM wa_media_cache; DELETE FROM meta_threads WHERE thread_id LIKE 'wa:%'`);
  const one = async (sql, a) => (await query(sql, a)).rows[0];
  const SFX = Date.now().toString(36).slice(-5);
  const dir = await one(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,'director','x',$2) RETURNING id`, [`WM Dir ${SFX}`, `wmdir${SFX}`]);
  const rep = await one(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,'sales','x',$2) RETURNING id`, [`WM Rep ${SFX}`, `wmrep${SFX}`]);
  const D = { authorization: 'Bearer ' + app.jwt.sign({ sub: Number(dir.id), role: 'director' }) };
  const Rp = { authorization: 'Bearer ' + app.jwt.sign({ sub: Number(rep.id), role: 'sales' }) };
  const call = (h, method, url, payload) => app.inject({ method, url, payload, headers: h });
  const hook = async (msgs) => {
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages',
      value: { contacts: msgs.map((m) => ({ wa_id: m.from, profile: { name: 'Cliente ' + m.from.slice(-2) } })), messages: msgs } }] }] });
    const r = await app.inject({ method: 'POST', url: '/api/wa/webhook', payload: raw,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', 'sec').update(raw).digest('hex') } });
    assert.equal(r.statusCode, 200, r.body); await P.flushPromo(); await new Promise((r2) => setTimeout(r2, 80));
  };
  let wid = 0; const ts = () => String(Math.floor(Date.now() / 1000));
  const C = '528112345601'; const C2 = '528112345602';
  const msgId = async (payload) => Number((await one(`SELECT id FROM wa_messages WHERE payload=$1`, [payload])).id);

  let pulse0;
  await t.test('④-0 알림 기준점', async () => {
    const r = await call(D, 'GET', '/api/wa-promo/inbox/pulse'); assert.equal(r.statusCode, 200, r.body);
    pulse0 = r.json(); assert.equal(pulse0.new, 0);
  });

  await t.test('① 손님 사진 · PDF · 음성 → 미리 저장 · 대화에 media · 파일 보기 · 30일 지남 410 · 권한', async () => {
    await hook([
      { from: C, id: `wamid.X${++wid}`, timestamp: ts(), type: 'text', text: { body: 'Hola, busco amortiguadores para Aveo 2015' } },
      { from: C, id: `wamid.X${++wid}`, timestamp: ts(), type: 'image', image: { id: 'M-IMG1', mime_type: 'image/jpeg' } },
      { from: C, id: `wamid.X${++wid}`, timestamp: ts(), type: 'document', document: { id: 'M-PDF1', filename: 'cotizacion.pdf', mime_type: 'application/pdf' } },
      { from: C, id: `wamid.X${++wid}`, timestamp: ts(), type: 'audio', audio: { id: 'M-AUD1' } },
      { from: C2, id: `wamid.X${++wid}`, timestamp: ts(), type: 'image', image: { id: 'M-OLD', caption: 'la pieza' } },
    ]);
    assert.ok(fetched.includes('M-IMG1') && fetched.includes('M-PDF1'), '받자마자 미리 받기');
    assert.equal((await one(`SELECT count(*)::int n FROM wa_media_cache WHERE media_id IN ('M-IMG1','M-PDF1','M-AUD1')`)).n, 3);
    assert.equal((await one(`SELECT body FROM wa_messages WHERE payload='M-PDF1'`)).body, 'cotizacion.pdf', 'PDF 이름 남김');
    const conv = (await call(D, 'GET', `/api/wa-promo/conversations/${C}`)).json();
    assert.deepEqual(conv.items.map((x) => x.media), [false, true, true, true]);
    const n0 = fetched.length;
    const img = await call(D, 'GET', `/api/wa-promo/media/${await msgId('M-IMG1')}`);
    assert.equal(img.statusCode, 200); assert.match(img.headers['content-type'], /image\/jpeg/);
    assert.ok(img.rawPayload.subarray(0, 4).equals(JPG.subarray(0, 4)));
    const pdf = await call(D, 'GET', `/api/wa-promo/media/${await msgId('M-PDF1')}`);
    assert.match(pdf.headers['content-type'], /application\/pdf/); assert.match(pdf.headers['content-disposition'], /cotizacion\.pdf/);
    assert.equal(fetched.length, n0, '저장본에서 — Meta 에 다시 안 감');
    const old = await call(D, 'GET', `/api/wa-promo/media/${await msgId('M-OLD')}`);
    assert.equal(old.statusCode, 410); assert.equal(old.json().error, 'media_expired');
    const txtId = Number((await one(`SELECT id FROM wa_messages WHERE phone=$1 AND kind='text'`, [C])).id);
    assert.equal((await call(D, 'GET', `/api/wa-promo/media/${txtId}`)).statusCode, 404, '글 메시지는 파일 없음');
    assert.equal((await call(Rp, 'GET', `/api/wa-promo/media/${await msgId('M-IMG1')}`)).statusCode, 403, 'WhatsApp 마케팅 권한 없음');
  });

  await t.test('② 직원이 사진 · PDF 보내기 — 업로드 · 보낸 파일 다시 보기 · 형식 · 크기 · 창 닫힘 409', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    calls.length = 0;
    const a = await call(D, 'POST', `/api/wa-promo/conversations/${C}/media`, { mime: 'image/png', name: 'catalogo.png', caption: 'Este es el kit', data_b64: png.toString('base64') });
    assert.equal(a.statusCode, 200, a.body);
    assert.deepEqual(calls.map((c) => c.kind), ['upload', 'image']);
    assert.equal(calls[1].caption, 'Este es el kit'); assert.equal(calls[1].to, C);
    const out = await one(`SELECT * FROM wa_messages WHERE direction='out' AND kind='image' ORDER BY id DESC LIMIT 1`);
    assert.equal(out.source, 'manual'); assert.equal(out.payload, a.json().media_id); assert.equal(out.body, 'Este es el kit'); assert.equal(Number(out.sent_by), Number(dir.id));
    const back = await call(D, 'GET', `/api/wa-promo/media/${out.id}`);
    assert.equal(back.statusCode, 200); assert.ok(back.rawPayload.equals(png), '보낸 파일 그대로');
    calls.length = 0;
    const pdfBuf = Buffer.from('%PDF-1.4 test');
    const b = await call(D, 'POST', `/api/wa-promo/conversations/${C}/media`, { mime: 'application/pdf', name: 'Cotización CTR.pdf', caption: '', data_b64: 'data:application/pdf;base64,' + pdfBuf.toString('base64') });
    assert.equal(b.statusCode, 200, b.body);
    assert.equal(calls[1].kind, 'document'); assert.equal(calls[1].filename, 'Cotización CTR.pdf');
    assert.equal((await one(`SELECT body FROM wa_messages WHERE direction='out' AND kind='document' ORDER BY id DESC LIMIT 1`)).body, 'Cotización CTR.pdf');
    assert.equal((await call(D, 'POST', `/api/wa-promo/conversations/${C}/media`, { mime: 'image/webp', name: 'x.webp', data_b64: png.toString('base64') })).json().error, 'bad_media_type');
    const big = Buffer.alloc(5 * 1024 * 1024 + 10, 1).toString('base64');
    assert.equal((await call(D, 'POST', `/api/wa-promo/conversations/${C}/media`, { mime: 'image/jpeg', name: 'big.jpg', data_b64: big })).json().error, 'image_too_large');
    await query(`UPDATE wa_inbound SET last_at = now() - interval '30 hours' WHERE wa_from=$1`, [C2]);
    const c = await call(D, 'POST', `/api/wa-promo/conversations/${C2}/media`, { mime: 'image/png', name: 'a.png', data_b64: png.toString('base64') });
    assert.equal(c.statusCode, 409); assert.equal(c.json().error, 'window_closed');
    assert.equal((await call(Rp, 'POST', `/api/wa-promo/conversations/${C}/media`, { mime: 'image/png', name: 'a.png', data_b64: png.toString('base64') })).statusCode, 403);
  });

  await t.test('③ Meta 광고 문의 화면 — 파일(mid) · 창 상태 · 답장(글 · 파일) · 다른 문의 파일 404', async () => {
    const { upsertWaThread } = await import('../src/metaLeads.js');
    await upsertWaThread(C); await upsertWaThread(C2);
    const th = await one(`SELECT id FROM meta_threads WHERE thread_id=$1`, ['wa:' + C]);
    const th2 = await one(`SELECT id FROM meta_threads WHERE thread_id=$1`, ['wa:' + C2]);
    assert.ok(th && th2);
    const d = (await call(D, 'GET', `/api/meta-leads/${th.id}`)).json();
    const med = d.messages.filter((m) => m.mid);
    assert.deepEqual(med.map((m) => m.mk), ['image', 'document', 'audio', 'image', 'document']);
    assert.equal(med[1].text, 'cotizacion.pdf');
    assert.equal(med[0].text, '(imagen)', '캡션 없는 사진 = 포털 · AI 용 표시');
    assert.equal(d.wa.window_open, true); assert.equal(d.wa.reply_ready, true); assert.equal(d.wa.phone, C);
    const f = await call(D, 'GET', `/api/meta-leads/${th.id}/wa-media/${med[0].mid}`);
    assert.equal(f.statusCode, 200); assert.match(f.headers['content-type'], /image/);
    assert.equal((await call(D, 'GET', `/api/meta-leads/${th2.id}/wa-media/${med[0].mid}`)).statusCode, 404, '다른 문의의 파일');
    calls.length = 0;
    const r = await call(D, 'POST', `/api/meta-leads/${th.id}/whatsapp`, { text: 'Claro, ¿qué año es su Aveo?' });
    assert.equal(r.statusCode, 200, r.body); assert.equal(calls[0].kind, 'text');
    assert.ok(r.json().messages.some((m) => m.me && m.text === 'Claro, ¿qué año es su Aveo?'));
    assert.equal((await one(`SELECT status FROM meta_threads WHERE id=$1`, [th.id])).status, 'contactado');
    const pdf = await call(D, 'POST', `/api/meta-leads/${th.id}/whatsapp-media`, { mime: 'application/pdf', name: 'lista.pdf', data_b64: Buffer.from('%PDF').toString('base64') });
    assert.equal(pdf.statusCode, 200, pdf.body); assert.ok(pdf.json().messages.some((m) => m.me && m.mk === 'document'));
    const d2 = (await call(D, 'GET', `/api/meta-leads/${th2.id}`)).json();
    assert.equal(d2.wa.window_open, false, '30시간 전 = 창 닫힘 → 화면은 📞 전화');
    const cl = await call(D, 'POST', `/api/meta-leads/${th2.id}/whatsapp`, { text: 'hola' });
    assert.equal(cl.statusCode, 409); assert.equal(cl.json().error, 'window_closed');
  });

  await t.test('④ 새 메시지 알림 — 새 메시지 수 · 마지막 · 답장 기다림 · 사내 번호 제외', async () => {
    const p1 = (await call(D, 'GET', `/api/wa-promo/inbox/pulse?after=${pulse0.last_id}`)).json();
    assert.equal(p1.new, 5); assert.ok(p1.last_id > pulse0.last_id);
    const w1 = p1.waiting;                     // C 는 우리가 답함 · C2 는 손님 말이 마지막
    assert.equal(w1, 1);
    await hook([{ from: '528119990000', id: `wamid.X${++wid}`, timestamp: ts(), type: 'text', text: { body: 'resumen' } },
      { from: '528112345603', id: `wamid.X${++wid}`, timestamp: ts(), type: 'text', text: { body: 'Precio de rótula Tsuru?' } }]);
    const p2 = (await call(D, 'GET', `/api/wa-promo/inbox/pulse?after=${p1.last_id}`)).json();
    assert.equal(p2.new, 1, '사내 번호(알림 수신)는 안 셈');
    assert.equal(p2.latest[0].phone, '528112345603'); assert.equal(p2.latest[0].body, 'Precio de rótula Tsuru?'); assert.match(p2.latest[0].name, /Cliente 03/);
    assert.equal(p2.waiting, 2);
    const p3 = (await call(D, 'GET', `/api/wa-promo/inbox/pulse?after=${p2.last_id}`)).json();
    assert.equal(p3.new, 0);
    assert.equal((await call(Rp, 'GET', '/api/wa-promo/inbox/pulse')).statusCode, 403);
  });
});
