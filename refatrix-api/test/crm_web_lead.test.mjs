// 웹 카달록 가입 신청(리드) 수신 · 팝업 · 처리 — 0210
//
//   순수 로직(필드 읽기)은 DB 없이, 수신·처리는 TEST_PG_URL 이 있을 때 실제 라우트로.
//   실행: TEST_PG_URL=postgres://... node --test test/crm_web_lead.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const API = join(HERE, '..');
const REPO = join(API, '..');
const read = (p) => readFileSync(p, 'utf8');

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;

const { mapLead, missingLeadFields, LEAD_REQUIRED } = await import('../src/crmInbound.js');

// ── A. 본문 읽기 ─────────────────────────────────────────────────────
test('A1. 계약서 이름 그대로 읽는다', () => {
  const m = mapLead({ crmLeadCode: 'WEB-128', empresa: 'REFACCIONARIA HEBRY', nombre: 'Adrian',
    apellido: 'Lira', telefono: '8113843028', correo: 'a@b.com', rfc: 'CQR1603288MA',
    ciudad: 'Monterrey', estado: 'Nuevo León' });
  assert.equal(m.crmLeadCode, 'WEB-128');
  assert.equal(m.empresa, 'REFACCIONARIA HEBRY');
  assert.equal(m.rfc, 'CQR1603288MA');
  assert.equal(m.ciudad, 'Monterrey');
});

test('A2. 이름이 달라도 알아본다 (company·email·phone·customerCode)', () => {
  const m = mapLead({ customerCode: 'WEB-9', company: 'ACME', name: 'Juan',
    phone: '81', email: 'j@a.com', RFC: 'X' });
  assert.equal(m.crmLeadCode, 'WEB-9');
  assert.equal(m.empresa, 'ACME');
  assert.equal(m.telefono, '81');
  assert.equal(m.correo, 'j@a.com');
  assert.equal(m.rfc, 'X');
});

test('A3. 한 겹 감싼 본문도 푼다', () => {
  const m = mapLead({ cliente: { empresa: 'ACME', razon_social: 'no' } });
  assert.equal(m.empresa, 'ACME');
});

// ── B. 필수값 ────────────────────────────────────────────────────────
test('B1. 필수는 회사명·이름·전화·이메일·RFC 다섯', () => {
  assert.deepEqual([...LEAD_REQUIRED].sort(), ['correo', 'empresa', 'nombre', 'rfc', 'telefono']);
  assert.deepEqual(missingLeadFields(mapLead({ empresa: 'A', nombre: 'B' })).sort(),
    ['correo', 'rfc', 'telefono']);
});

test('B2. 신규고객 등록과 달리 회사명을 요구하고 상업정보는 보지 않는다', () => {
  // 가입 화면에서 고객이 할인율을 스스로 정하지 않는다 — 그건 영업사원이 통화로 파악한다.
  assert.ok(LEAD_REQUIRED.includes('empresa'));
  const m = mapLead({ empresa: 'A', nombre: 'B', telefono: '1', correo: 'c@d.com', rfc: 'X',
    discountPercent: 50, paymentDays: 90 });
  assert.equal('discountPercent' in m, false, '고객이 스스로 정한 할인율을 읽어들이면 안 된다');
  assert.deepEqual(missingLeadFields(m), []);
});

// ── C. 소스 계약 ─────────────────────────────────────────────────────
test('C1. 서버가 리드 라우트를 등록한다', () => {
  const s = read(join(API, 'src/server.js'));
  assert.ok(s.includes("import crmLeadRoutes from './routes/crmLeadRoutes.js'"));
  assert.ok(s.includes('app.register(crmLeadRoutes)'));
});

test('C2. 리드는 고객을 만들지 않는다', () => {
  // 상업정보가 하나도 없는 고객이 승인 대기함에 쌓이면 그 함이 쓸모없어진다.
  const s = read(join(API, 'src/routes/crmLeadRoutes.js'));
  assert.equal(/INSERT INTO customers/.test(s), false,
    '리드 수신이 고객을 만들면 승인 대기함이 상업정보 없는 행으로 찬다');
});

test('C3. 전 화면 팝업이 nav 에 있고 폴러가 켜진다', () => {
  const n = read(join(REPO, 'refatrix-nav.js'));
  assert.ok(n.includes('rnavLeadModal'));
  assert.ok(n.includes('/api/portal/web-lead-alert'));
  assert.ok(/startWebLeadAlert\(\);/.test(n), '부팅에서 폴러를 시작하지 않으면 팝업이 영영 안 뜬다');
  assert.ok(n.includes("custLeads:{file:'refatrix-customers.html'"), '네비에 없으면 입구 없는 탭이 된다');
});

test('C4. 팝업 버튼 네 가지가 다 있다', () => {
  const n = read(join(REPO, 'refatrix-nav.js'));
  assert.ok(n.includes('__rnavLeadClaim'), '내가 맡겠습니다');
  assert.ok(n.includes('__rnavLeadDrop'), '보류 · 대상 아님');
  assert.ok(n.includes('__rnavLeadGo'), '고객 등록 화면으로');
  assert.ok(n.includes('__rnavLeadDismiss'), '임시로 닫기');
});

test('C5. 고객 화면에 누적 이력 탭이 있다', () => {
  const h = read(join(REPO, 'refatrix-customers.html'));
  assert.ok(h.includes('data-tab="leads"'));
  assert.ok(h.includes("id=\"tab-leads\""));
  assert.ok(h.includes('/api/crm-leads'));
  assert.ok(h.includes("'leads'"), '해시 딥링크 목록에 leads 가 있어야 한다');
  assert.ok(h.includes('leadToCustomer'), '가입 정보를 들고 고객 등록으로 넘어갈 수 있어야 한다');
});

test('C6. 알림 대상은 관리 화면에서 사람 단위로 고른다', () => {
  const g = read(join(REPO, 'refatrix-integrations.html'));
  assert.ok(g.includes('boxNotify'));
  assert.ok(g.includes('/api/crm-leads/notify-targets'));
  assert.ok(g.includes("CUR.key==='crm_web_lead'"), '다른 연동에서는 이 설정이 보이면 안 된다');
});

test('C7. 팝업은 고객이 보낸 값을 전부 편다', () => {
  // 우리가 모르는 필드를 CRM 이 더해도 화면에서 잃어버리면 안 된다.
  const n = read(join(REPO, 'refatrix-nav.js'));
  assert.ok(/Object\.keys\(p\)\.forEach/.test(n), 'payload 를 통째로 훑어야 새 필드도 보인다');
  const h = read(join(REPO, 'refatrix-customers.html'));
  assert.ok(/Object\.keys\(p\)\.forEach/.test(h));
});

test('C8. 고객 등록이 리드를 자동으로 닫는다', () => {
  // 사람이 「이미 등록했음」 을 따로 눌러야 하면 반드시 빠뜨리고, 그러면 같은 신청이
  // 팝업에 남아 다른 사람이 또 전화한다. 등록이 곧 처리 완료다.
  const c = read(join(API, 'src/routes/customerRoutes.js'));
  assert.ok(/b\.lead_id/.test(c), '등록 API 가 lead_id 를 받아야 한다');
  assert.ok(/UPDATE crm_web_leads[\s\S]{0,200}status='done'/.test(c));
  assert.ok(/lead_linked/.test(c), '응답으로 알려 줘야 화면이 목록을 맞출 수 있다');
  const f = read(join(REPO, 'refatrix-custform.js'));
  assert.ok(/b\.lead_id\s*=\s*leadId/.test(f), '폼이 lead_id 를 실어 보내야 한다');
  assert.ok(/setRegBoxes\(false\);\s*\n\s*leadId=null/.test(f),
    '수정 모드에서는 리드 연결을 버려야 엉뚱한 고객에 붙지 않는다');
  const h = read(join(REPO, 'refatrix-customers.html'));
  assert.ok(/RefCustForm\.newCustomer\(opts\)/.test(h), 'showForm 이 opts 를 신규 등록에 넘겨야 한다');
  assert.ok(/showForm\(null,\{lead_id:/.test(h));
});

test('C9. 폴백 키 규칙은 한 곳에만 있고 화면이 그걸 읽는다', () => {
  // 서버는 다른 연동의 키를 받아 주는데 화면은 「401 로 거절됩니다」 라고 경고하고 있었다.
  // 규칙이 두 군데 있으면 반드시 이렇게 엇갈린다.
  const i = read(join(API, 'src/integrations.js'));
  assert.ok(/export const INBOUND_KEY_FALLBACK/.test(i));
  assert.ok(/key_fallback_from/.test(i), '화면이 볼 수 있게 내려 줘야 한다');
  const l = read(join(API, 'src/routes/crmLeadRoutes.js'));
  assert.ok(/INBOUND_KEY_FALLBACK\[LEAD_KEY\]/.test(l), '수신부도 같은 표를 봐야 한다');
  const g = read(join(REPO, 'refatrix-integrations.html'));
  assert.ok(/key_fallback_from/.test(g), '화면이 폴백을 보고 문구를 갈라야 한다');
});

// ── D. 실제 수신·처리 (DB) ───────────────────────────────────────────
const dbTest = PG ? test : test.skip;

dbTest('수신 → 팝업 대상 → 담당 지정 → 보류 (실 DB)', async (t) => {
  const { query, pool } = await import('../src/db.js');
  const { invalidateEndpointCache } = await import('../src/integrations.js');
  const Fastify = (await import('fastify')).default;
  const crmLeadRoutes = (await import('../src/routes/crmLeadRoutes.js')).default;

  const app = Fastify({ logger: false });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, function (request, body, done) {
    if (body === undefined || body === null || String(body).trim() === '') { done(null, {}); return; }
    try { done(null, JSON.parse(body)); } catch (err) { err.statusCode = 400; done(err, undefined); }
  });
  app.register(crmLeadRoutes);
  await app.ready();

  const TAG = 'WL' + String(Date.now()).slice(-6);
  const KEY = 'rfx_test_' + 'c'.repeat(48);
  await query(`UPDATE integration_endpoints SET auth_token_test=$1, auth_token_prod=NULL, enabled=true
                WHERE key='crm_web_lead'`, [KEY]);
  invalidateEndpointCache();

  // 로그인 토큰 대신 authGuard 를 우회할 수 없으므로, 관리 API 는 DB 로 확인한다.
  const code = 'WEB-' + TAG;
  const post = (payload, headers = {}) => app.inject({
    method: 'POST', url: '/api/integrations/crm/customer-lead',
    headers: { 'content-type': 'application/json', ...headers }, payload });

  t.after(async () => {
    await query(`DELETE FROM crm_web_leads WHERE crm_lead_code=$1`, [code]);
    await pool.end();
  });

  await t.test('키가 없으면 401 — 리드가 생기지 않는다', async () => {
    const r = await post({ empresa: 'A', nombre: 'B', telefono: '1', correo: 'c@d.com', rfc: 'X', crmLeadCode: code });
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().codigoError, 'ERR_API_KEY');
    assert.equal((await query(`SELECT count(*)::int n FROM crm_web_leads WHERE crm_lead_code=$1`, [code])).rows[0].n, 0);
  });

  await t.test('필수가 빠지면 400 + 어떤 필드인지 알려준다', async () => {
    const r = await post({ nombre: 'B' }, { 'x-api-key': KEY });
    assert.equal(r.statusCode, 400);
    assert.match(r.json().mensaje, /empresa/);
    assert.match(r.json().mensaje, /rfc/);
  });

  let leadId = null;
  await t.test('정상 수신 → 고객은 생기지 않고 리드만 쌓인다', async () => {
    const before = (await query(`SELECT count(*)::int n FROM customers`)).rows[0].n;
    const r = await post({
      crmLeadCode: code, empresa: 'REFACCIONARIA ' + TAG, nombre: 'Adrian', apellido: 'Lira',
      telefono: '8113843028', correo: 'lead' + TAG + '@ejemplo.com', rfc: 'CQR160328MA1',
      ciudad: 'Monterrey', estado: 'Nuevo León', mensaje: 'Quiero ver precios',
      campoNuevoDelCrm: 'valor inesperado',      // 우리가 모르는 필드
    }, { 'x-api-key': KEY });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().codigoError, '0');
    leadId = r.json().leadId;
    assert.ok(leadId);

    const after = (await query(`SELECT count(*)::int n FROM customers`)).rows[0].n;
    assert.equal(after, before, '리드 수신이 고객을 만들면 안 된다');

    const row = (await query(`SELECT * FROM crm_web_leads WHERE id=$1`, [leadId])).rows[0];
    assert.equal(row.status, 'new');
    assert.equal(row.empresa, 'REFACCIONARIA ' + TAG);
    assert.equal(row.auth_in, 'header');
    assert.equal(row.payload.campoNuevoDelCrm, 'valor inesperado',
      '모르는 필드도 원문 그대로 남아야 팝업에서 보여 줄 수 있다');
  });

  await t.test('같은 신청을 다시 보내도 알림이 두 번 생기지 않는다(멱등)', async () => {
    const r = await post({ crmLeadCode: code, empresa: 'REFACCIONARIA ' + TAG + ' SA', nombre: 'Adrian',
      telefono: '8113843028', correo: 'lead' + TAG + '@ejemplo.com', rfc: 'CQR160328MA1' },
      { 'x-api-key': KEY });
    assert.equal(r.statusCode, 200);
    const n = (await query(`SELECT count(*)::int n FROM crm_web_leads WHERE crm_lead_code=$1`, [code])).rows[0].n;
    assert.equal(n, 1, '고객이 폼을 두 번 눌러도 팝업이 두 번 뜨면 안 된다');
    const row = (await query(`SELECT empresa FROM crm_web_leads WHERE crm_lead_code=$1`, [code])).rows[0];
    assert.match(row.empresa, /SA$/, '재전송분으로 내용은 갱신된다');
  });

  await t.test('키는 쿼리스트링·본문으로도 받는다', async () => {
    const q = await app.inject({ method: 'POST',
      url: '/api/integrations/crm/customer-lead?apiKey=' + KEY,
      headers: { 'content-type': 'application/json' },
      payload: { crmLeadCode: code, empresa: 'A', nombre: 'B', telefono: '1', correo: 'c@d.com', rfc: 'X' } });
    assert.equal(q.statusCode, 200);
  });

  await t.test('전용 키가 없으면 신규고객 등록 수신의 키를 그대로 받는다 (폴백)', async () => {
    // 상대에게 창구마다 다른 키를 요구하면 연동만 늦어진다. 화면 안내도 이 동작과 같아야 한다.
    const REG = 'rfx_test_' + 'd'.repeat(48);
    await query(`UPDATE integration_endpoints SET auth_token_test=NULL, auth_token_prod=NULL
                  WHERE key='crm_web_lead'`);
    await query(`UPDATE integration_endpoints SET auth_token_test=$1
                  WHERE key='crm_customer_registration'`, [REG]);
    invalidateEndpointCache();

    const ok = await post({ crmLeadCode: code, empresa: 'A', nombre: 'B',
      telefono: '1', correo: 'c@d.com', rfc: 'X' }, { 'x-api-key': REG });
    assert.equal(ok.statusCode, 200, '등록 수신용 키로도 받아 줘야 한다');

    const bad = await post({ crmLeadCode: code, empresa: 'A', nombre: 'B',
      telefono: '1', correo: 'c@d.com', rfc: 'X' }, { 'x-api-key': 'z'.repeat(57) });
    assert.equal(bad.statusCode, 401, '아무 키나 받으면 안 된다');

    // 전용 키를 발급하면 그때부터는 이 창구만 그 키를 요구한다.
    await query(`UPDATE integration_endpoints SET auth_token_test=$1 WHERE key='crm_web_lead'`, [KEY]);
    invalidateEndpointCache();
    const now = await post({ crmLeadCode: code, empresa: 'A', nombre: 'B',
      telefono: '1', correo: 'c@d.com', rfc: 'X' }, { 'x-api-key': REG });
    assert.equal(now.statusCode, 401, '전용 키가 생기면 폴백은 더 이상 쓰이지 않는다');
  });

  await t.test('이력에 우리 API 키가 남지 않는다', async () => {
    await post({ apiKey: KEY, crmLeadCode: code, empresa: 'A', nombre: 'B',
      telefono: '1', correo: 'c@d.com', rfc: 'X' });
    const rows = (await query(`SELECT payload FROM crm_web_leads WHERE crm_lead_code=$1`, [code])).rows;
    assert.equal(JSON.stringify(rows).includes(KEY), false);
  });
});
