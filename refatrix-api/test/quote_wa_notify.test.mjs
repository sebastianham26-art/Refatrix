// =====================================================================
// quote_wa_notify.test.mjs — 견적·매출 추적: 신규 견적 WhatsApp 알림 (0256 · 2026-10-07)
//   A. 순수 규칙 — 문구(한국어/스페인어) · 한 줄 헤드라인 · 팀 범위
//   B. 실제 서버 + PostgreSQL(TEST_PG_URL): 수신자 CRUD · 견적 저장 → 즉시 발송(내용 검증) ·
//      팀 범위 · 등록 이전 견적 제외 · 실패 재시도 상한 · 동시 발송 1회 · 창 닫힘 → 템플릿 신호 ·
//      웹훅 131047 재오픈 · 복제 · 가용재고 견적 제외 · 원장/미리보기/수동발송 API · 권한
//   실행: TEST_PG_URL=postgres://... node --test test/quote_wa_notify.test.mjs
// =====================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-quote-wa';
const N = await import('../src/quoteWaNotify.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const QT = {
  id: 1, quote_no: 'Q26-0100', quote_date: '2026-10-07', status: 'draft', origin: null, customer_po_no: 'OC-77',
  customer_name: 'REFACCIONARIA SUR', team_id: 2, team_name: '02_Merida', creator_name: 'Oscar',
  subtotal: 12000, total: 13920, sku: 5, qty: 40,
  cls: { ok: 3, short: 1, dev: 1, ok_qty: 30, short_qty: 8, dev_qty: 2, ok_sub: 10000, short_sub: 2000 },
};

test('A1. 문구 — 견적번호 · 고객 · SKU · 총수량 · 수주현황 3분류 · 견적액(IVA 제외/포함)', () => {
  const ko = N.buildQuoteText(QT, 'ko');
  for (const s of ['Q26-0100', 'REFACCIONARIA SUR', '02_Merida', 'OC-77', 'Oscar', 'SKU *5*', '총수량 *40* 개',
    '즉시매출가능 3 SKU · 30 개 · $10,000.00', '재고부족 1 SKU · 8 개 · $2,000.00', '개발필요 1 SKU · 2 개',
    '$12,000.00 (IVA 제외)', '$13,920.00 (IVA 포함)']) assert.ok(ko.includes(s), `ko: ${s}\n${ko}`);
  const es = N.buildQuoteText({ ...QT, origin: 'crm' }, 'es');
  for (const s of ['Nueva cotización', 'Cliente', 'Disponible 3 SKU', 'Falta stock 1', 'Por desarrollar 1', 'sin IVA', 'con IVA', 'Solicitud del portal'])
    assert.ok(es.includes(s), `es: ${s}`);
});

test('A2. 템플릿용 한 줄 — 줄바꿈 없음 · 핵심 값 포함 · 길이 제한', () => {
  const h = N.buildQuoteHeadline({ ...QT, customer_name: 'A\nB'.repeat(400) }, 'ko');
  assert.ok(!/[\n\t]/.test(h)); assert.ok(h.length <= 950);
  const h2 = N.buildQuoteHeadline(QT, 'ko');
  assert.match(h2, /Q26-0100 · REFACCIONARIA SUR · SKU 5 · 총수량 40 · 즉시매출가능 3 \/ 재고부족 1 \/ 개발필요 1 · 견적액 \$12,000\.00/);
});

test('A3. 팀 범위 — 비어 있으면 전체, 있으면 그 팀만(팀 없는 견적은 제외)', () => {
  assert.equal(N.recipientCovers({ team_ids: null }, QT), true);
  assert.equal(N.recipientCovers({ team_ids: [] }, QT), true);
  assert.equal(N.recipientCovers({ team_ids: ['2'] }, QT), true);
  assert.equal(N.recipientCovers({ team_ids: [1] }, QT), false);
  assert.equal(N.recipientCovers({ team_ids: [1] }, { ...QT, team_id: null }), false);
});

test('B. 실제 서버 + PostgreSQL', { skip: !PG && 'TEST_PG_URL 없음' }, async (t) => {
  const { query, pool } = await import('../src/db.js');
  after(async () => { await pool.end().catch(() => {}); setTimeout(() => process.exit(process.exitCode || 0), 300); });
  const keep = { ...process.env };
  process.env.WHATSAPP_TOKEN = 't'; process.env.WHATSAPP_PHONE_ID = '1';
  delete process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN; delete process.env.WHATSAPP_APP_SECRET;
  process.env.QUOTE_WA_TEMPLATE = 'nueva_cotizacion';
  t.after(() => { process.env = keep; });

  // 발송 스텁 — 실제 Meta 호출 없이 무엇이 나갔는지 기록
  const sent = []; let mode = 'ok'; let seq = 0;
  N.setQuoteWaSender(async (a) => {
    sent.push(a);
    if (mode === 'fail') return { ok: false, error: 'boom' };
    if (mode === 'slow') await wait(200);
    return { ok: true, mode: a.windowOpen === false ? 'template' : 'text', message_id: `wamid.Q${++seq}` };
  });
  t.after(() => N.setQuoteWaSender(null));

  const { buildApp } = await import('../src/server.js');
  const app = buildApp(); await app.ready();
  t.after(() => app.close());

  const SFX = Date.now().toString(36).slice(-5).toUpperCase();
  const one = async (sql, a) => (await query(sql, a)).rows[0];
  await query(`DELETE FROM quote_wa_sends; DELETE FROM quote_wa_recipients; DELETE FROM wa_message_status; DELETE FROM wa_inbound;`);
  await query(`UPDATE quotes SET created_at = created_at - interval '2 days' WHERE created_at > now() - interval '1 day'`);   // 이전 실행분은 줍기 창 밖으로
  const dir = await one(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,'director','x',$2) RETURNING id`, [`QW Dir ${SFX}`, `qwdir${SFX}`.toLowerCase()]);
  const rep = await one(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,'sales','x',$2) RETURNING id`, [`QW Rep ${SFX}`, `qwrep${SFX}`.toLowerCase()]);
  const D = { authorization: 'Bearer ' + app.jwt.sign({ sub: Number(dir.id), role: 'director' }) };
  const R = { authorization: 'Bearer ' + app.jwt.sign({ sub: Number(rep.id), role: 'sales' }) };
  const call = (h, method, url, payload) => app.inject({ method, url, payload, headers: h });
  const teams = (await query(`SELECT id, name FROM sales_teams WHERE deleted_at IS NULL ORDER BY sort_order, id`)).rows.map((x) => ({ id: Number(x.id), name: x.name }));
  assert.ok(teams.length >= 2, '영업팀 2개(0030)');
  const [T1, T2] = teams;
  const cust = await one(`INSERT INTO customers (name, code, discount, team_id, created_by) VALUES ($1,$2,10,$3,$4) RETURNING id`,
    [`QW Cliente ${SFX}`, `QW-${SFX}`, T2.id, dir.id]);
  const pOk = await one(`INSERT INTO products (code, name, list_price, stock_qty, is_active) VALUES ($1,'OK part',100,50,true) RETURNING id`, [`QWOK${SFX}`]);
  const pSh = await one(`INSERT INTO products (code, name, list_price, stock_qty, is_active) VALUES ($1,'Short part',200,0,true) RETURNING id`, [`QWSH${SFX}`]);
  const newQuote = async (h = D) => {
    const r = await call(h, 'POST', '/api/quotes', { customer_id: Number(cust.id),
      lines: [{ product_id: Number(pOk.id), qty: 3 }, { product_id: Number(pSh.id), qty: 5 }, { code: `NOPE${SFX}`, qty: 2 }] });
    assert.equal(r.statusCode, 200, r.body); return r.json();
  };
  const ledger = async (qid) => (await query(`SELECT s.*, r.name FROM quote_wa_sends s JOIN quote_wa_recipients r ON r.id=s.recipient_id WHERE quote_id=$1 ORDER BY recipient_id`, [qid])).rows;

  let rAll, rT1;
  await t.test('B1. 수신자 — 번호 정규화(521→52) · 형식/중복 오류 · 팀 범위 · 디렉터 전용', async () => {
    assert.equal((await call(D, 'POST', '/api/quote-wa/recipients', { name: 'X', phone: '12' })).statusCode, 400);
    assert.equal((await call(D, 'POST', '/api/quote-wa/recipients', { name: '', phone: '8110005311' })).statusCode, 400);
    const a = await call(D, 'POST', '/api/quote-wa/recipients', { name: 'Seba', phone: '5218110005311', lang: 'ko' });
    assert.equal(a.statusCode, 200, a.body); rAll = a.json();
    assert.equal(rAll.phone, '528110005311'); assert.deepEqual(rAll.team_ids, []);
    assert.equal((await call(D, 'POST', '/api/quote-wa/recipients', { name: 'dup', phone: '8110005311' })).statusCode, 409);
    const b = await call(D, 'POST', '/api/quote-wa/recipients', { name: 'Monterrey', phone: '8110009999', lang: 'es', team_ids: [T1.id, T1.id] });
    rT1 = b.json(); assert.deepEqual(rT1.team_ids, [T1.id]);
    const l = (await call(D, 'GET', '/api/quote-wa/recipients')).json();
    assert.equal(l.items.length, 2); assert.equal(l.teams.length, teams.length); assert.equal(l.items[0].window_open, null, '웹훅 미설정 → null');
    assert.equal((await call(R, 'GET', '/api/quote-wa/recipients')).statusCode, 403);
    assert.equal((await call(R, 'POST', '/api/quote-wa/send', {})).statusCode, 403);
  });

  let q1;
  await t.test('B2. 견적 저장 → 바로 발송 — 내용이 견적·수주현황과 일치 · 팀 밖 수신자는 안 받음', async () => {
    sent.length = 0;
    q1 = await newQuote();
    await wait(900);
    assert.equal(sent.length, 1, '전체 범위 1명만(T1 수신자는 T2 고객 견적 제외)');
    const m = sent[0];
    assert.equal(m.to, '528110005311'); assert.equal(m.templateName, 'nueva_cotizacion'); assert.equal(m.windowOpen, null);
    // 금액 기대값은 ERP 가 실제로 저장한 줄 금액에서(할인 규칙은 견적 저장 로직 소관)
    const ln = (await query(`SELECT product_id, line_subtotal FROM quote_lines WHERE quote_id=$1`, [q1.id])).rows;
    const sub = (pid) => Number(ln.find((x) => Number(x.product_id) === Number(pid)).line_subtotal);
    const hq = await one(`SELECT subtotal_mxn, total_mxn FROM quotes WHERE id=$1`, [q1.id]);
    const $ = (v) => '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const tName = (await one(`SELECT name FROM sales_teams WHERE id=$1`, [T2.id])).name;
    for (const s of [q1.quote_no, `QW Cliente ${SFX}`, tName, 'SKU *3*', '총수량 *10* 개',
      `즉시매출가능 1 SKU · 3 개 · ${$(sub(pOk.id))}`, `재고부족 1 SKU · 5 개 · ${$(sub(pSh.id))}`, '개발필요 1 SKU · 2 개',
      `${$(hq.subtotal_mxn)} (IVA 제외)`, `${$(hq.total_mxn)} (IVA 포함)`])
      assert.ok(m.text.includes(s), `${s}\n${m.text}`);
    assert.ok(!/\n/.test(m.headline));
    const lg = await ledger(q1.id);
    assert.equal(lg.length, 1); assert.equal(lg[0].status, 'sent_text'); assert.ok(lg[0].sent_at); assert.equal(Number(lg[0].attempts), 1);
    // 줍기가 다시 돌아도 또 보내지 않는다
    await N.runQuoteNotifyJob({});
    assert.equal(sent.length, 1);
  });

  await t.test('B3. 수신자 등록 이전 견적은 보내지 않는다(등록 순간 옛 견적 폭주 방지)', async () => {
    sent.length = 0;
    const late = (await call(D, 'POST', '/api/quote-wa/recipients', { name: 'Late', phone: '8110001234' })).json();
    const r = await N.runQuoteNotifyJob({});
    assert.equal(sent.length, 0, JSON.stringify(r));
    assert.equal((await ledger(q1.id)).length, 1);
    await call(D, 'DELETE', `/api/quote-wa/recipients/${late.id}`);
  });

  await t.test('B4. 팀 범위 변경(T2 포함) → 그 뒤 견적은 두 명 모두', async () => {
    sent.length = 0;
    const p = await call(D, 'PATCH', `/api/quote-wa/recipients/${rT1.id}`, { team_ids: [T1.id, T2.id] });
    assert.deepEqual(p.json().team_ids.sort(), [T1.id, T2.id].sort());
    const q2 = await newQuote(); await wait(900);
    assert.equal(sent.length, 2);
    const es = sent.find((x) => x.to === '528110009999');
    assert.ok(es.text.includes('Nueva cotización') && es.text.includes(q2.quote_no), '스페인어 수신자');
  });

  await t.test('B5. 실패 → 줍기가 다시 시도, 3회에서 멈춤', async () => {
    sent.length = 0; mode = 'fail';
    await call(D, 'PATCH', `/api/quote-wa/recipients/${rT1.id}`, { active: false });
    const q3 = await newQuote(); await wait(900);
    let lg = await ledger(q3.id);
    assert.equal(lg[0].status, 'failed'); assert.equal(Number(lg[0].attempts), 1); assert.match(lg[0].error, /boom/);
    await N.runQuoteNotifyJob({}); await N.runQuoteNotifyJob({}); await N.runQuoteNotifyJob({});
    lg = await ledger(q3.id);
    assert.equal(Number(lg[0].attempts), 3, '상한 3회'); assert.equal(sent.length, 3);
    mode = 'ok';
    // 수동 재발송은 상한 무시
    const s = await call(D, 'POST', '/api/quote-wa/send', { quote_id: q3.id });
    assert.equal(s.statusCode, 200, s.body); assert.equal(s.json().results[0].ok, true);
    lg = await ledger(q3.id); assert.ok(lg[0].sent_at); assert.equal(lg[0].status, 'sent_text');
    await call(D, 'PATCH', `/api/quote-wa/recipients/${rT1.id}`, { active: true });
  });

  await t.test('B6. 즉시 발송과 줍기가 겹쳐도 1번만 나간다(원장 잠금)', async () => {
    mode = 'slow'; sent.length = 0;
    await call(D, 'PATCH', `/api/quote-wa/recipients/${rT1.id}`, { active: false });
    const q4 = await newQuote();
    await Promise.all([N.notifyQuote(q4.id), N.notifyQuote(q4.id), N.runQuoteNotifyJob({})]);
    await wait(900);
    assert.equal(sent.length, 1, '한 사람에게 한 번');
    mode = 'ok';
    await call(D, 'PATCH', `/api/quote-wa/recipients/${rT1.id}`, { active: true });
  });

  await t.test('B7. 웹훅이 24시간 창 닫힘을 알면 템플릿부터(windowOpen=false) · 131047 실패는 원장을 다시 연다', async () => {
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'verify-me-123'; process.env.WHATSAPP_APP_SECRET = 'sec';
    await call(D, 'PATCH', `/api/quote-wa/recipients/${rT1.id}`, { active: false });
    sent.length = 0;
    const q5 = await newQuote(); await wait(900);
    assert.equal(sent.length, 1); assert.equal(sent[0].windowOpen, false);
    let lg = await ledger(q5.id); assert.equal(lg[0].status, 'sent_template');
    // 웹훅: 그 메시지가 창 밖으로 실패
    const body = { object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: {
      statuses: [{ id: lg[0].message_id, status: 'failed', timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '5218110005311',
        errors: [{ code: 131047, title: 'Re-engagement message' }] }] } }] }] };
    const raw = JSON.stringify(body);
    const sig = 'sha256=' + crypto.createHmac('sha256', 'sec').update(raw).digest('hex');
    const w = await app.inject({ method: 'POST', url: '/api/wa/webhook', payload: raw, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig } });
    assert.equal(w.statusCode, 200, w.body);
    lg = await ledger(q5.id); assert.equal(lg[0].sent_at, null); assert.equal(lg[0].status, 'failed'); assert.match(lg[0].error, /131047/);
    // 원장 API 에 실제 전달 실패 사유
    const st = (await call(D, 'GET', '/api/quote-wa/status')).json();
    const row = st.recent.find((x) => x.quote_id === Number(q5.id));
    assert.equal(row.dlv_status, 'failed'); assert.match(row.dlv_reason, /24시간/); assert.equal(st.webhook, true);
    // 수신 창 열림 → 줍기 재시도는 텍스트로
    await query(`INSERT INTO wa_inbound (wa_from, last_at, last_type, msg_count) VALUES ('528110005311', now(), 'text', 1)
                 ON CONFLICT (wa_from) DO UPDATE SET last_at = now()`);
    sent.length = 0;
    await N.runQuoteNotifyJob({});
    assert.equal(sent.length, 1); assert.equal(sent[0].windowOpen, true);
    lg = await ledger(q5.id); assert.ok(lg[0].sent_at);
    const rl = (await call(D, 'GET', '/api/quote-wa/recipients')).json();
    assert.equal(rl.items.find((x) => x.id === rAll.id).window_open, true);
    delete process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN; delete process.env.WHATSAPP_APP_SECRET;
    await call(D, 'PATCH', `/api/quote-wa/recipients/${rT1.id}`, { active: true });
  });

  await t.test('B8. 복제도 신규 견적 · 가용재고 견적·삭제 견적은 제외', async () => {
    await call(D, 'PATCH', `/api/quote-wa/recipients/${rT1.id}`, { active: false });
    sent.length = 0;
    const c = await call(D, 'POST', `/api/quotes/${q1.id}/clone`, {});
    assert.equal(c.statusCode, 200, c.body); await wait(900);
    assert.equal(sent.length, 1); assert.ok(sent[0].text.includes(c.json().quote_no));
    sent.length = 0;
    const pl = await one(`INSERT INTO quotes (quote_no, customer_id, quote_date, status, subtotal_mxn, iva_mxn, total_mxn, total_qty, sku_count, created_by)
                          VALUES ($1,$2,CURRENT_DATE,'pricelist',0,0,0,0,0,$3) RETURNING id`, [`PL-${SFX}`, cust.id, dir.id]);
    const del = await one(`INSERT INTO quotes (quote_no, customer_id, quote_date, status, subtotal_mxn, iva_mxn, total_mxn, total_qty, sku_count, created_by, deleted_at)
                           VALUES ($1,$2,CURRENT_DATE,'draft',0,0,0,0,0,$3, now()) RETURNING id`, [`DL-${SFX}`, cust.id, dir.id]);
    assert.equal((await N.notifyQuote(Number(pl.id))).skipped, 'not_notifiable');
    assert.equal((await N.notifyQuote(Number(del.id))).skipped, 'not_notifiable');
    await N.runQuoteNotifyJob({});
    assert.equal(sent.length, 0);
    await call(D, 'PATCH', `/api/quote-wa/recipients/${rT1.id}`, { active: true });
  });

  await t.test('B9. 미리보기 · 꺼짐 스위치 · 수신자 삭제', async () => {
    const pv = await call(D, 'GET', `/api/quote-wa/preview?quote_id=${q1.id}&lang=es`);
    assert.equal(pv.statusCode, 200); assert.ok(pv.json().text.includes('Nueva cotización') && pv.json().text.includes(q1.quote_no));
    const pl = (await call(D, 'GET', '/api/quote-wa/preview')).json();
    assert.ok(pl.quote_no, '견적 미지정 → 가장 최근');
    process.env.QUOTE_WA_ENABLED = '0'; sent.length = 0;
    await newQuote(); await wait(900); await N.runQuoteNotifyJob({});
    assert.equal(sent.length, 0, 'QUOTE_WA_ENABLED=0');
    assert.equal((await call(D, 'GET', '/api/quote-wa/status')).json().enabled, false);
    delete process.env.QUOTE_WA_ENABLED;
    assert.equal((await call(D, 'DELETE', `/api/quote-wa/recipients/${rT1.id}`)).statusCode, 200);
    assert.equal((await call(D, 'GET', '/api/quote-wa/recipients')).json().items.length, 1);
  });
});
