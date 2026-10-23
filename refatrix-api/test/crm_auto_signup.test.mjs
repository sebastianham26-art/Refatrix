// =====================================================================
// 20261022 · CRM 웹 가입 — 구글·페이스북 가입은 **완전 자동**
//   실행: TEST_PG_URL=postgres://... node --test test/crm_auto_signup.test.mjs
//
//   디렉터 지시(2026-10-22):
//     "CRM에서 구글이나 페이스북 이메일로 가입을 요청하면 ERP로 넘어올 때 ERP에서 자동으로
//      10% 할인을 승인해주도록. 사후승인도 필요없고, constancia 및 외상 정보 올리는 것도
//      필요없이 그냥 회원가입이 자동으로 되도록"
//
//   디렉터 확정(같은 날): "CUS_Origin 으로 보내는 게 있으면 이게 10% 자동할인 고객"
//
//   A. 순수 규칙 — 판정은 CUS_Origin 하나 · provider·gmail 도메인은 근거가 아니다
//   B. 실 DB — 신규고객 등록 창구: 사후승인 생략 · 외상 0 · 응답에 10% · CRM 전송 적재
//   C. 실 DB — 웹 가입 신청 창구: 구글·페이스북이면 리드가 아니라 바로 고객
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PG = process.env.TEST_PG_URL || '';
if (!PG) console.log('[skip] TEST_PG_URL 없음 — B·C 구간 생략');
if (PG) process.env.DATABASE_URL = PG;
const dbTest = PG ? test : test.skip;

const CI = await import('../src/crmInbound.js');

// ── A. 순수 규칙 ─────────────────────────────────────────────────────
test('A1. 판정은 CUS_Origin 하나 — GOOGLE·FACEBOOK 이면 자동 가입', () => {
  for (const body of [
    { CUS_Origin: 'GOOGLE' }, { CUS_Origin: 'google' }, { CUS_Origin: 'Facebook Ads' },
    { cus_origin: 'FB' }, { cliente: { CUS_Origin: 'GOOGLE' } },
  ]) {
    assert.equal(CI.isOpenSignup(CI.mapInbound(body)), true, JSON.stringify(body));
  }
});

test('A2. ★ CUS_Origin 이 없거나 비었으면 provider 가 구글이어도 대상이 아니다', () => {
  for (const body of [
    {}, { provider: 'google' }, { providerId: 'google.com' }, { proveedor: 'facebook' },
    { CUS_Origin: '' }, { CUS_Origin: '   ' }, { CUS_Origin: null },
  ]) {
    assert.equal(CI.isOpenSignup(CI.mapInbound(body)), false, JSON.stringify(body));
  }
});

test('A2b. ★ 20261023 · CUS_Origin 이 오면 값과 무관하게 대상 — CRM 실측값 "WEB" 포함', () => {
  for (const body of [
    { cus_origin: 'WEB' }, { CUS_Origin: 'WEB' }, { CUS_Origin: 'INSTAGRAM' }, { CUS_Origin: 'portal' },
  ]) {
    assert.equal(CI.isOpenSignup(CI.mapInbound(body)), true, JSON.stringify(body));
  }
});

test('A3. ★ gmail 주소만으로는 자동 가입이 아니다 — 일반 고객 다수가 gmail 을 쓴다', () => {
  const m = CI.mapInbound({ correo: 'taller@gmail.com', nombre: 'X' });
  assert.equal(CI.isOpenSignup(m), false);
});

test('A4. 매핑에 가입 계정 필드가 없다 — 판정 근거가 두 개로 갈리지 않게', () => {
  assert.equal('signupProvider' in CI.mapInbound({ CUS_Origin: 'GOOGLE' }), false);
});

test('A5. 판정은 isOpenSignup 한 곳 — 두 라우트가 그걸 쓴다', () => {
  const reg = readFileSync(new URL('../src/routes/crmInboundRoutes.js', import.meta.url), 'utf8');
  const lead = readFileSync(new URL('../src/routes/crmLeadRoutes.js', import.meta.url), 'utf8');
  assert.ok(reg.includes('isOpenSignup(m)'));
  assert.ok(lead.includes('isOpenSignup(mapInbound(raw))'));
  assert.ok(lead.includes('registerInbound('), '리드 창구는 등록 규칙을 다시 쓰지 않고 부른다');
  assert.equal(/'GOOGLE'|"GOOGLE"|'FACEBOOK'|"FACEBOOK"/.test(reg + lead), false);
  // 웹 가입 신청 창구가 customers 에 직접 쓰지 않는다(0210 원칙) — 고객은 등록 규칙이 만든다.
  assert.equal(/INSERT INTO customers/.test(lead), false);
});

// ── B·C. 실 DB ───────────────────────────────────────────────────────
dbTest('B·C. 실 서버 + PostgreSQL', async (t) => {
  const { query, pool } = await import('../src/db.js');
  const { invalidateEndpointCache } = await import('../src/integrations.js');
  const Fastify = (await import('fastify')).default;
  const crmInboundRoutes = (await import('../src/routes/crmInboundRoutes.js')).default;
  const crmLeadRoutes = (await import('../src/routes/crmLeadRoutes.js')).default;

  const app = Fastify({ logger: false });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, function (request, body, done) {
    if (body === undefined || body === null || String(body).trim() === '') { done(null, {}); return; }
    try { done(null, JSON.parse(body)); } catch (err) { err.statusCode = 400; done(err, undefined); }
  });
  app.register(crmInboundRoutes);
  app.register(crmLeadRoutes);
  await app.ready();

  const KEY = 'rfx_test_' + 'b'.repeat(48);
  await query(`UPDATE integration_endpoints SET auth_token_test=$1, auth_token_prod=NULL, enabled=true
                WHERE key='crm_customer_registration'`, [KEY]);
  // 웹 가입 신청 창구는 전용 키가 없으면 등록 창구의 키를 받는다(INBOUND_KEY_FALLBACK).
  await query(`UPDATE integration_endpoints SET auth_token_test=NULL, auth_token_prod=NULL, enabled=true
                WHERE key='crm_web_lead'`);
  invalidateEndpointCache();

  const SFX = Date.now().toString(36).slice(-5).toUpperCase();
  const post = (url, payload) => app.inject({
    method: 'POST', url, headers: { 'content-type': 'application/json', 'x-api-key': KEY }, payload,
  });
  const REG = '/api/integrations/crm/customer-registration';
  const LEAD = '/api/integrations/crm/customer-lead';
  const byCode = async (code) => (await query(`SELECT * FROM customers WHERE code=$1`, [code])).rows[0];
  const made = []; const leads = [];
  const mk = async (url, payload) => {
    const r = await post(url, payload);
    const j = r.json();
    if (j.erpCustomerCode) made.push(j.erpCustomerCode);
    if (j.leadId) leads.push(j.leadId);
    return { r, j };
  };

  t.after(async () => {
    if (leads.length) await query(`DELETE FROM crm_web_leads WHERE id = ANY($1::bigint[])`, [leads]).catch(() => {});
    await query(`DELETE FROM crm_web_leads WHERE nombre LIKE $1 OR empresa LIKE $1`, [`%${SFX}%`]).catch(() => {});
    const ids = (await query(`SELECT id FROM customers WHERE code = ANY($1::text[])`, [made])).rows.map((x) => x.id);
    if (ids.length) {
      await query(`DELETE FROM crm_web_leads WHERE customer_id = ANY($1::bigint[])`, [ids]).catch(() => {});
      await query(`DELETE FROM crm_inbound_log WHERE customer_id = ANY($1::bigint[])`, [ids]).catch(() => {});
      await query(`DELETE FROM customer_registration_events WHERE customer_id = ANY($1::bigint[])`, [ids]);
      await query(`DELETE FROM crm_customer_outbox WHERE customer_id = ANY($1::bigint[])`, [ids]).catch(() => {});
      await query(`DELETE FROM customers WHERE id = ANY($1::bigint[])`, [ids]);
    }
    await app.close();
    await pool.end();
  });

  await t.test('B1. CUS_Origin GOOGLE — 이메일만 와도 즉시 활성 · 10% 실효 · 사후승인 없음', async () => {
    const { r, j } = await mk(REG, { CUS_Origin: 'GOOGLE', correo: `g1${SFX}@gmail.com`, nombre: `G1${SFX}` });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(j.codigoError, '0');
    assert.equal(j.estatus, 'aprobado');
    const c = await byCode(j.erpCustomerCode);
    assert.equal(c.approval_status, 'approved');
    assert.equal(Number(c.discount), 10, '실효 10% — 서류 관문에 깎이지 않는다');
    assert.equal(c.doc_gate, false, 'Constancia·주소증빙 불필요');
    assert.ok(c.ratified_at, '★ 사후승인 목록에 쌓이지 않는다');
    assert.equal(c.ratified_by, null, '사람이 확인한 게 아니다 — 비워 둔다');
    assert.ok(String(c.ratified_note || '').includes('자동 가입'), '왜 닫혔는지 남긴다');
  });

  await t.test('B2. 사후승인 대기 목록 조건(ratified_at IS NULL)에 걸리지 않는다', async () => {
    const { j } = await mk(REG, { CUS_Origin: 'FACEBOOK', correo: `f2${SFX}@x.mx` });
    const c = await byCode(j.erpCustomerCode);
    const n = (await query(
      `SELECT count(*)::int AS n FROM customers c
        WHERE c.id=$1 AND c.deleted_at IS NULL AND c.ratified_at IS NULL
          AND COALESCE(c.approval_status,'approved') <> 'rejected'`, [c.id])).rows[0].n;
    assert.equal(n, 0);
  });

  await t.test('B3. ★ 외상은 열리지 않는다 — CRM 이 paymentDays 를 보내도 0(현금)', async () => {
    const { j } = await mk(REG, { CUS_Origin: 'GOOGLE', correo: `g3${SFX}@x.mx`, paymentDays: 30, descuento: 25 });
    const c = await byCode(j.erpCustomerCode);
    assert.equal(Number(c.credit_days), 0, '서류 관문이 꺼져 있어 30 을 받으면 그대로 외상이 된다');
    assert.equal(Number(c.discount), 10, '보낸 25% 가 아니라 10%');
    assert.equal(j.paymentDays, 0);
  });

  await t.test('B4. 응답에 조건을 실어 준다 — 카달록이 바로 10% 를 쓴다', async () => {
    const { j } = await mk(REG, { CUS_Origin: 'GOOGLE', correo: `g4${SFX}@x.mx` });
    assert.equal(j.discountPercent, 10);
    assert.equal(j.registroAutomatico, true);
    assert.equal(j.mensaje, 'Cliente registrado y activo en el ERP.');
  });

  await t.test('B5. CRM 전송 적재 — RFC 있으면 대기, 없으면 rfc_missing 으로 기록', async () => {
    const withRfc = await mk(REG, { CUS_Origin: 'GOOGLE', correo: `g5${SFX}@x.mx`, rfc: 'AIAC8310204A0' });
    const c1 = await byCode(withRfc.j.erpCustomerCode);
    const o1 = (await query(`SELECT * FROM crm_customer_outbox WHERE customer_id=$1 ORDER BY id DESC LIMIT 1`, [c1.id])).rows[0];
    assert.ok(o1, '사후승인 버튼이 하던 전송을 등록이 대신한다');
    assert.equal(o1.origin, 'crm_auto_signup');
    assert.notEqual(o1.status, 'skipped');
    assert.equal(Number(o1.payload.discountPercent), 10);
    assert.equal(o1.payload.estatus, 'aprobado');

    const noRfc = await mk(REG, { CUS_Origin: 'GOOGLE', correo: `g5b${SFX}@x.mx` });
    const c2 = await byCode(noRfc.j.erpCustomerCode);
    const o2 = (await query(`SELECT * FROM crm_customer_outbox WHERE customer_id=$1 ORDER BY id DESC LIMIT 1`, [c2.id])).rows[0];
    assert.equal(o2.status, 'skipped');
    assert.equal(o2.last_error, 'rfc_missing');
  });

  await t.test('B6. 이력에 유입경로·자동 확인을 박제한다', async () => {
    const { j } = await mk(REG, { CUS_Origin: 'Facebook', correo: `f6${SFX}@x.mx` });
    const c = await byCode(j.erpCustomerCode);
    const ev = (await query(
      `SELECT reason, snapshot FROM customer_registration_events WHERE customer_id=$1 AND action='submit'`, [c.id])).rows[0];
    assert.equal(ev.snapshot.cus_origin, 'Facebook');
    assert.equal(ev.snapshot.auto_ratified, true);
    assert.ok(ev.reason.includes('자동 가입'));
  });

  await t.test('B7. 회귀 — 일반 경로(gmail 이라도)는 필수 검사 · 사후승인 그대로', async () => {
    const miss = await post(REG, { nombre: `PLAIN${SFX}`, correo: `plain${SFX}@gmail.com` });
    assert.equal(miss.statusCode, 400);
    assert.equal(miss.json().codigoError, 'ERR_REQUIRED_FIELD');
    const { r, j } = await mk(REG, { rfc: 'FEL990715AB1', nombre: 'Felipe', apellido: `L${SFX}`,
      telefono: '8112345678', correo: `fel${SFX}@gmail.com`, descuento: 12, paymentDays: 30 });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(j.discountPercent, undefined, '일반 경로 응답은 예전 그대로');
    const c = await byCode(j.erpCustomerCode);
    assert.equal(c.ratified_at, null, '일반 경로는 사후승인 대기');
    assert.equal(c.doc_gate, true);
    assert.equal(Number(c.discount), 0, '서류 전이라 실효 0 — 기존 동작');
    assert.equal(Number(c.credit_days_agreed), 30, '보낸 외상일은 약정값으로 보존');
  });

  await t.test('C1. 웹 가입 신청 창구로 와도 CUS_Origin GOOGLE 이면 바로 고객 — 리드 필수 5개를 안 본다', async () => {
    const { r, j } = await mk(LEAD, { CUS_Origin: 'GOOGLE', nombre: `LG${SFX}`, correo: `lg${SFX}@gmail.com`,
      empresa: `Taller LG${SFX}`, crmLeadCode: `WEB-${SFX}-1` });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(j.codigoError, '0');
    assert.ok(String(j.erpCustomerCode).startsWith('P-'), '리드가 아니라 고객 코드가 나온다');
    assert.equal(j.discountPercent, 10);
    const c = await byCode(j.erpCustomerCode);
    assert.ok(c.ratified_at);
    assert.equal(Number(c.discount), 10);
    assert.ok(String(c.memo).includes(`Taller LG${SFX}`), '회사명(empresa)을 잃지 않는다');
    // 리드 목록에는 「자동 가입됨」(닫힌 상태)으로 한 줄 — 팝업 대상이 아니다.
    const l = (await query(`SELECT * FROM crm_web_leads WHERE id=$1`, [j.leadId])).rows[0];
    assert.equal(l.status, 'done');
    assert.equal(Number(l.customer_id), Number(c.id));
  });

  await t.test('C2. 같은 신청을 다시 보내도 고객·리드가 둘이 되지 않는다', async () => {
    const a = await mk(LEAD, { CUS_Origin: 'Facebook', nombre: `LF${SFX}`, correo: `lf${SFX}@x.mx`, crmLeadCode: `WEB-${SFX}-2` });
    const b = await mk(LEAD, { CUS_Origin: 'Facebook', nombre: `LF${SFX}`, correo: `lf${SFX}@x.mx`, crmLeadCode: `WEB-${SFX}-2` });
    assert.equal(b.j.erpCustomerCode, a.j.erpCustomerCode);
    assert.equal(b.j.leadId, a.j.leadId);
  });

  await t.test('C3. 수신 이력 — 리드 창구엔 「넘김」, 등록 창구엔 실제 등록이 남는다', async () => {
    const { j } = await mk(LEAD, { CUS_Origin: 'GOOGLE', correo: `lg3${SFX}@x.mx`, crmLeadCode: `WEB-${SFX}-3` });
    const rows = (await query(
      `SELECT endpoint_key, result, mensaje FROM crm_inbound_log WHERE erp_code=$1 ORDER BY id`, [j.erpCustomerCode])).rows;
    assert.ok(rows.some((x) => x.endpoint_key === 'crm_customer_registration' && x.result === 'created'));
    assert.ok(rows.some((x) => x.endpoint_key === 'crm_web_lead' && x.mensaje.includes('자동 가입')));
  });

  await t.test('C3b. CUS_Origin 없이 provider 만 구글이면 일반 경로 — 자동 가입 아님', async () => {
    const r = await post(REG, { provider: 'google', nombre: `PV${SFX}`, correo: `pv${SFX}@gmail.com` });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().codigoError, 'ERR_REQUIRED_FIELD');
  });

  await t.test('C3c. ★ 운영 실측 본문(LEAD-11 형태 · cus_origin WEB)이 바로 고객이 된다', async () => {
    const { r, j } = await mk(LEAD, { rfc: 'RERS710711F1A', ciudad: 'Tuxtla', correo: `real${SFX}@gmail.com`,
      estado: 'Chiapas', nombre: 'Sergio', empresa: `Sergio Reyes ${SFX}`, mensaje: 'Estoy interesado',
      apellido: 'Reyes', telefono: '+529610000000', cus_origin: 'WEB', crmLeadCode: `WEB-${SFX}-R` });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(j.estatus, 'aprobado');
    assert.equal(j.discountPercent, 10);
    const c = await byCode(j.erpCustomerCode);
    assert.ok(c.ratified_at, '승인 없이');
    assert.equal(Number(c.discount), 10, '바로 10%');
    const o = (await query(`SELECT status, payload FROM crm_customer_outbox WHERE customer_id=$1 ORDER BY id DESC LIMIT 1`, [c.id])).rows[0];
    assert.notEqual(o.status, 'skipped', 'RFC 가 있으니 CRM 에 aprobado·10% 가 나간다(카달록 가격 공개)');
    assert.equal(o.payload.estatus, 'aprobado');
  });

  await t.test('C3d. 이미 쌓인 리드를 디렉터가 자동 가입으로 전환한다', async () => {
    // 옛 규칙 시절 리드처럼 직접 넣는다(수신 창구를 타면 이제 바로 고객이 되므로).
    const lid = Number((await query(
      `INSERT INTO crm_web_leads (crm_lead_code, empresa, nombre, correo, rfc, payload, status)
       VALUES ($1,$2,'Luis',$3,'GOCL8110193N1',$4::jsonb,'new') RETURNING id`,
      [`WEB-${SFX}-OLD`, `Luis ${SFX}`, `old${SFX}@gmail.com`,
       JSON.stringify({ cus_origin: 'WEB', nombre: 'Luis', empresa: `Luis ${SFX}`, correo: `old${SFX}@gmail.com`,
         rfc: 'GOCL8110193N1', crmLeadCode: `WEB-${SFX}-OLD` })])).rows[0].id);
    leads.push(lid);
    const TAG = `ast_${SFX}_`;
    const dirId = Number((await query(
      `INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,'director','x',$2) RETURNING id`,
      [`${TAG}디렉터`, `${TAG}dir`.toLowerCase()])).rows[0].id);
    const jwt = (await import('@fastify/jwt')).default;
    const app2 = Fastify({ logger: false });
    await app2.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret' });
    app2.register(crmLeadRoutes);
    await app2.ready();
    const tok = app2.jwt.sign({ sub: dirId });
    // 디렉터가 아니면 막혀야 한다.
    const anon = await app2.inject({ method: 'POST', url: `/api/crm-leads/${lid}/auto-register` });
    assert.equal(anon.statusCode, 401);
    const res = await app2.inject({ method: 'POST', url: `/api/crm-leads/${lid}/auto-register`,
      headers: { authorization: 'Bearer ' + tok } });
    // 일괄 전환: 방금 닫혔으니 다시 잡히지 않는다(멱등).
    const bulk = await app2.inject({ method: 'POST', url: '/api/crm-leads/auto-register-open',
      headers: { authorization: 'Bearer ' + tok } });
    await app2.close();
    assert.equal(bulk.statusCode, 200, bulk.body);
    assert.equal(bulk.json().results.some((x) => x.lead_id === lid), false, '이미 전환된 리드는 다시 안 잡힌다');
    await query(`UPDATE crm_web_leads SET closed_by=NULL WHERE id=$1`, [lid]);
    await query(`DELETE FROM audit_log WHERE user_id=$1`, [dirId]).catch(() => {});
    t.after(async () => { await query(`DELETE FROM users WHERE id=$1`, [dirId]).catch(() => {}); });
    assert.equal(res.statusCode, 200, res.body);
    const out = res.json();
    assert.ok(String(out.customer_code).startsWith('P-'));
    made.push(out.customer_code);
    const l = (await query(`SELECT status, customer_id FROM crm_web_leads WHERE id=$1`, [lid])).rows[0];
    assert.equal(l.status, 'done');
    const c = await byCode(out.customer_code);
    assert.equal(Number(c.discount), 10);
    assert.ok(c.ratified_at);
  });

  await t.test('C4. 회귀 — 일반 웹 가입 신청은 예전대로 리드(고객 미생성)', async () => {
    const before = (await query(`SELECT count(*)::int AS n FROM customers`)).rows[0].n;
    const r = await post(LEAD, { empresa: `Ref ${SFX}`, nombre: `N${SFX}`, telefono: '8110000000',
      correo: `n${SFX}@gmail.com`, rfc: 'FEL990715AB1', crmLeadCode: `WEB-${SFX}-4` });
    assert.equal(r.statusCode, 200, r.body);
    const j = r.json();
    if (j.leadId) leads.push(j.leadId);
    assert.equal(j.erpCustomerCode, undefined);
    const after = (await query(`SELECT count(*)::int AS n FROM customers`)).rows[0].n;
    assert.equal(after, before, '일반 신청은 사람이 판단해 고객으로 옮긴다(0210)');
    const l = (await query(`SELECT status FROM crm_web_leads WHERE id=$1`, [j.leadId])).rows[0];
    assert.equal(l.status, 'new');
  });
});
