// =====================================================================
// 0278 · CRM 고객가입 — 광고 유입(GOOGLE · FACEBOOK)은 들어오는 대로 받는다
//   실행: TEST_PG_URL=postgres://... node --test test/crm_origin_web_signup.test.mjs
//
//   디렉터 지시(2026-10-16):
//     "CUS_Origin 이 GOOGLE·FACEBOOK 이면 보내오는 것만 데이타를 받고, ERP 가 꼭 필요하다고
//      규정한 항목이 없어도 회원가입을 받아줘. 고객팀 07_Pagina · 할인률 10%"
//     "RFC 가 없을 수 있어 … 고객구분을 MECANICO 로 저장" · "CRM 수신 전부 사후승인으로"
//
//   A. 순수 규칙 — 유입경로 판정 · 매핑
//   B. 실 DB — 필수 면제 · 팀/할인/구분 · **10%가 실효로 사는지** · 멱등 3축 · 사후승인 · 일반 경로 회귀
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PG = process.env.TEST_PG_URL || '';
if (!PG) console.log('[skip] TEST_PG_URL 없음 — B 구간 생략');
if (PG) process.env.DATABASE_URL = PG;
const dbTest = PG ? test : test.skip;

const CI = await import('../src/crmInbound.js');

// ── A. 순수 규칙 ─────────────────────────────────────────────────────
test('A1. GOOGLE · FACEBOOK 은 표기가 흔들려도 같은 유입으로 본다', () => {
  for (const v of ['GOOGLE', 'google', ' Google ', 'Google Ads', 'GOOGLE_ADS', 'google-ads']) {
    assert.equal(CI.normalizeOrigin(v), 'GOOGLE', v);
    assert.equal(CI.isOpenOrigin(v), true, v);
  }
  for (const v of ['FACEBOOK', 'facebook', 'Facebook Ads', 'FB', 'fb', 'Meta', 'meta ads']) {
    assert.equal(CI.normalizeOrigin(v), 'FACEBOOK', v);
    assert.equal(CI.isOpenOrigin(v), true, v);
  }
});

test('A2. 그 밖의 유입경로는 면제 대상이 아니다 — 목록을 넓히지 않는다', () => {
  for (const v of ['INSTAGRAM', 'referido', 'WEB', 'tiktok', '', null, undefined, 0, {}]) {
    assert.equal(CI.isOpenOrigin(v), false, String(v));
  }
  // 빈 값이 면제로 새면 **모든 수신이 무검사**가 된다 — 가장 위험한 실수다.
  assert.equal(CI.isOpenOrigin(''), false);
  assert.equal(CI.isOpenOrigin(null), false);
});

test('A3. CUS_Origin 을 표기 차이·중첩 본문에서도 읽어 낸다', () => {
  assert.equal(CI.mapInbound({ CUS_Origin: 'GOOGLE' }).origin, 'GOOGLE');
  assert.equal(CI.mapInbound({ cus_origin: 'facebook' }).origin, 'facebook');
  assert.equal(CI.mapInbound({ cusOrigin: 'Google Ads' }).origin, 'Google Ads');
  assert.equal(CI.mapInbound({ cliente: { CUS_Origin: 'GOOGLE' } }).origin, 'GOOGLE');
  assert.equal(CI.mapInbound({ origen: 'FACEBOOK' }).origin, 'FACEBOOK');
  assert.equal(CI.mapInbound({}).origin, null);
});

test('A4. 면제 목록은 한 곳에만 있다', () => {
  assert.deepEqual(CI.OPEN_ORIGINS, ['GOOGLE', 'FACEBOOK']);
  // 라우트가 문자열을 또 들고 있으면 유입경로를 하나 늘릴 때 한쪽만 고치게 된다.
  const r = readFileSync(new URL('../src/routes/crmInboundRoutes.js', import.meta.url), 'utf8');
  assert.equal(/'GOOGLE'|"GOOGLE"/.test(r), false, '판정은 isOpenOrigin 한 곳에서만');
  assert.equal(/'FACEBOOK'|"FACEBOOK"/.test(r), false);
});

// ── B. 실 DB ─────────────────────────────────────────────────────────
dbTest('B. 실 서버 + PostgreSQL', async (t) => {
  const { query, pool } = await import('../src/db.js');
  const { invalidateEndpointCache } = await import('../src/integrations.js');
  const Fastify = (await import('fastify')).default;
  const crmInboundRoutes = (await import('../src/routes/crmInboundRoutes.js')).default;

  const app = Fastify({ logger: false });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, function (request, body, done) {
    if (body === undefined || body === null || String(body).trim() === '') { done(null, {}); return; }
    try { done(null, JSON.parse(body)); } catch (err) { err.statusCode = 400; done(err, undefined); }
  });
  app.register(crmInboundRoutes);
  await app.ready();

  const KEY = 'rfx_test_' + 'a'.repeat(48);
  await query(`UPDATE integration_endpoints SET auth_token_test=$1, auth_token_prod=NULL, enabled=true
                WHERE key='crm_customer_registration'`, [KEY]);
  invalidateEndpointCache();

  const SFX = Date.now().toString(36).slice(-5).toUpperCase();
  const post = (payload) => app.inject({
    method: 'POST', url: '/api/integrations/crm/customer-registration',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY }, payload,
  });
  const byCode = async (code) => (await query(
    `SELECT * FROM customers WHERE code=$1`, [code])).rows[0];
  const made = [];
  const mk = async (payload) => {
    const r = await post(payload);
    const j = r.json();
    if (j.erpCustomerCode) made.push(j.erpCustomerCode);
    return { r, j };
  };

  t.after(async () => {
    // 공용 시험 DB 를 더럽히지 않는다 — customer_merge 가 customers 를 통째로 지운다.
    const ids = (await query(`SELECT id FROM customers WHERE code = ANY($1::text[])`, [made])).rows.map((x) => x.id);
    if (ids.length) {
      // 지우는 순서가 곧 외래키 순서다(자식 먼저). crm_inbound_log 도 customers 를 참조한다.
      await query(`DELETE FROM crm_inbound_log WHERE customer_id = ANY($1::bigint[])`, [ids]).catch(() => {});
      await query(`DELETE FROM customer_registration_events WHERE customer_id = ANY($1::bigint[])`, [ids]);
      await query(`DELETE FROM crm_customer_outbox WHERE customer_id = ANY($1::bigint[])`, [ids]).catch(() => {});
      await query(`DELETE FROM customers WHERE id = ANY($1::bigint[])`, [ids]);
    }
    await app.close();
    await pool.end();
  });

  await t.test('B1. GOOGLE — RFC·성·전화·이메일이 하나도 없어도 가입된다', async () => {
    const { r, j } = await mk({ CUS_Origin: 'GOOGLE', nombre: `AD${SFX}` });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(j.codigoError, '0', JSON.stringify(j));
    const c = await byCode(j.erpCustomerCode);
    assert.ok(c, '고객이 만들어져야 한다');
    assert.equal(c.rfc, null, 'RFC 는 없어도 된다');
    assert.ok(String(c.code).startsWith('P-'), '웹 유입은 P- 채번');
  });

  await t.test('B2. 팀 07_Pagina · 할인 10% · 고객구분 MECANICO', async () => {
    const { j } = await mk({ CUS_Origin: 'FACEBOOK', nombre: `AD2${SFX}`, correo: `a2${SFX}@x.mx` });
    const c = await byCode(j.erpCustomerCode);
    const team = (await query(`SELECT name FROM sales_teams WHERE id=$1`, [c.team_id])).rows[0];
    assert.equal(team?.name, '07_Pagina');
    assert.equal(c.customer_type, 'MECANICO');
    assert.equal(Number(c.discount_agreed), 10, '약정 할인이 10% 여야 한다');
  });

  await t.test('B3. ★ 10% 가 **실효**로 산다 — 서류 관문에 깎이지 않는다', async () => {
    // 0235/0247 트리거는 서류가 없으면 discount 를 0 으로 깎는다. 광고 유입에서는
    //   Constancia 를 받을 일이 없으므로 doc_gate 를 끄지 않으면 10% 가 무효가 된다.
    const { j } = await mk({ CUS_Origin: 'google', nombre: `AD3${SFX}`, correo: `a3${SFX}@x.mx` });
    const c = await byCode(j.erpCustomerCode);
    assert.equal(c.doc_gate, false, '광고 유입은 서류 관문 대상이 아니다');
    assert.equal(Number(c.discount), 10, '실효 할인이 10% 여야 한다 — 0 이면 지시가 무효다');
  });

  await t.test('B4. CRM 이 다른 할인율을 보내도 10% 로 고정한다', async () => {
    const { j } = await mk({ CUS_Origin: 'GOOGLE', nombre: `AD4${SFX}`, correo: `a4${SFX}@x.mx`, descuento: 35 });
    const c = await byCode(j.erpCustomerCode);
    assert.equal(Number(c.discount), 10, '우리가 정한 10% 가 이긴다');
    // 보내온 값은 버리지 않고 이력에 남긴다 — 나중에 왜 35가 아닌지 답할 수 있어야 한다.
    const ev = (await query(
      `SELECT snapshot FROM customer_registration_events WHERE customer_id=$1 AND action='submit'`, [c.id])).rows[0];
    assert.equal(ev.snapshot.applied.sent_discount, 35);
    assert.equal(ev.snapshot.applied.discount, 10);
    assert.equal(ev.snapshot.cus_origin, 'GOOGLE');
    assert.equal(ev.snapshot.open_origin, true);
  });

  await t.test('B5. 이름이 하나도 없어도 사람이 알아볼 이름을 남긴다', async () => {
    const { j } = await mk({ CUS_Origin: 'FACEBOOK', correo: `noname${SFX}@x.mx` });
    const c = await byCode(j.erpCustomerCode);
    assert.ok(String(c.name || '').trim().length > 0, 'customers.name 은 NOT NULL 이다');
    assert.ok(c.name.includes(`noname${SFX}`), '남은 단서(이메일)로 채운다');
  });

  await t.test('B6. 멱등 — RFC 가 없으면 CRM 코드로, 그것도 없으면 이메일로 같은 고객을 찾는다', async () => {
    // ① CRM 코드
    const code1 = `WEB-${SFX}-1`;
    const a = await mk({ CUS_Origin: 'GOOGLE', nombre: `DUP${SFX}`, codigoCliente: code1 });
    const b = await mk({ CUS_Origin: 'GOOGLE', nombre: `DUP${SFX} 다시`, codigoCliente: code1 });
    assert.equal(b.j.erpCustomerCode, a.j.erpCustomerCode, '같은 CRM 코드는 한 고객이다');

    // ② 이메일(코드도 RFC 도 없을 때)
    const mail = `same${SFX}@x.mx`;
    const c1 = await mk({ CUS_Origin: 'FACEBOOK', nombre: `MAIL${SFX}`, correo: mail });
    const c2 = await mk({ CUS_Origin: 'FACEBOOK', nombre: `MAIL${SFX} 다시`, correo: mail });
    assert.equal(c2.j.erpCustomerCode, c1.j.erpCustomerCode, '같은 이메일은 한 고객이다');

    // ③ 아무 축도 없으면 — 막지 않고 새로 만든다(가입을 잃지 않는 쪽)
    const n1 = await mk({ CUS_Origin: 'GOOGLE', nombre: `NOKEY${SFX}` });
    const n2 = await mk({ CUS_Origin: 'GOOGLE', nombre: `NOKEY${SFX}` });
    assert.notEqual(n2.j.erpCustomerCode, n1.j.erpCustomerCode,
      '식별할 단서가 없으면 합칠 근거도 없다 — 사람이 병합한다');
  });

  await t.test('B7. RFC 를 보내면 형식은 그대로 엄격히 본다', async () => {
    const bad = await post({ CUS_Origin: 'GOOGLE', nombre: `BAD${SFX}`, rfc: 'NOTANRFC' });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().codigoError, 'ERR_RFC_INVALID',
      '깨진 RFC 를 받아 두면 나중에 팩투라가 막힌다');
    const ok = await mk({ CUS_Origin: 'GOOGLE', nombre: `GOODRFC${SFX}`, rfc: 'AIAC8310204A0' });
    assert.equal(ok.r.statusCode, 200, ok.r.body);
    const c = await byCode(ok.j.erpCustomerCode);
    assert.equal(c.rfc, 'AIAC8310204A0');
    assert.ok(c.rfc_claimed_at, 'RFC 를 넣었으면 선점 시각이 찍힌다');
  });

  await t.test('B8. 0267 · CRM 수신 고객은 등록 즉시 활성 + 사후승인 대기', async () => {
    const { j } = await mk({ CUS_Origin: 'GOOGLE', nombre: `ACT${SFX}`, correo: `act${SFX}@x.mx` });
    const c = await byCode(j.erpCustomerCode);
    assert.equal(c.approval_status, 'approved', '예전에는 pending 이라 견적에 쓸 수 없었다');
    assert.equal(c.ratified_at, null, '사후승인 목록에는 남아야 한다');
    assert.equal(c.approved_by, null, '아무도 승인하지 않았다');
    assert.equal(j.estatus, 'aprobado', '상대에게도 사실대로 — 「승인 대기」라고 하면 안 된다');
  });

  await t.test('B9. 일반 경로(유입경로 없음)는 전과 똑같이 엄격하다', async () => {
    const miss = await post({ nombre: `PLAIN${SFX}` });
    assert.equal(miss.statusCode, 400);
    assert.equal(miss.json().codigoError, 'ERR_REQUIRED_FIELD');
    const msg = miss.json().mensaje;
    for (const f of ['rfc', 'apellido', 'telefono', 'correo']) assert.ok(msg.includes(f), f);

    // 면제 대상이 아닌 유입경로도 마찬가지다.
    const ig = await post({ CUS_Origin: 'INSTAGRAM', nombre: `IG${SFX}` });
    assert.equal(ig.statusCode, 400);
    assert.equal(ig.json().codigoError, 'ERR_REQUIRED_FIELD');
  });

  await t.test('B10. 일반 경로가 다 갖추면 종전대로 등록되고, 유입경로도 보존된다', async () => {
    const { r, j } = await mk({
      CUS_Origin: 'INSTAGRAM', rfc: 'FEL990715AB1', nombre: 'Felipe', apellido: 'Lopez',
      telefono: '8112345678', correo: `fel${SFX}@x.mx`, descuento: 12, tipo: 'B',
    });
    assert.equal(r.statusCode, 200, r.body);
    const c = await byCode(j.erpCustomerCode);
    assert.equal(c.crm_origin, 'INSTAGRAM', '면제 대상이 아니어도 유입경로는 기록한다');
    assert.equal(c.customer_type, 'B', '보내온 고객구분을 덮어쓰지 않는다');
    assert.equal(Number(c.discount_agreed), 12, '보내온 할인율을 그대로');
    assert.equal(c.doc_gate, true, '일반 경로는 서류 관문 대상 그대로');
    assert.equal(Number(c.discount), 0, '서류가 없으니 실효는 0 — 기존 동작');
  });

  await t.test('B11. 유입경로 원문을 가두지 않고 그대로 담는다', async () => {
    const { j } = await mk({ CUS_Origin: 'Google Ads', nombre: `RAW${SFX}`, correo: `raw${SFX}@x.mx` });
    const c = await byCode(j.erpCustomerCode);
    assert.equal(c.crm_origin, 'Google Ads', '대문자로 바꾸거나 목록으로 가두지 않는다');
    assert.equal(Number(c.discount), 10, '그래도 판정은 GOOGLE 로 된다');
  });
});
