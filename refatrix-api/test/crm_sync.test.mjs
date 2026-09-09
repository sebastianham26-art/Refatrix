// ERP → CRM 고객 동기화 — 아웃박스/전송 계약 테스트
//
//   순수 로직(성공 판정·본문·백오프)은 DB 없이 돌고,
//   적재·전송·재시도는 TEST_PG_URL 이 있을 때만 실제 PostgreSQL + 모의 CRM 서버로 돈다.
//
//   실행: TEST_PG_URL=postgres://... node --test test/crm_sync.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;
process.env.CRM_SYNC_ENABLED = '1';
process.env.CRM_SYNC_TIMEOUT_MS = '2000';

// 모의 CRM — 시나리오를 테스트에서 바꿔 가며 쓴다.
let scenario = { status: 200, body: { codigoError: '0', mensaje: 'Cliente Actualizado correctamente' }, delayMs: 0 };
const received = [];
const crm = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    received.push({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
    const send = () => {
      res.writeHead(scenario.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(scenario.body));
    };
    if (scenario.delayMs) setTimeout(send, scenario.delayMs); else send();
  });
});
await new Promise((r) => crm.listen(0, '127.0.0.1', r));
process.env.CRM_SYNC_URL = `http://127.0.0.1:${crm.address().port}/api/integrations/erp/customer-commercial`;

const { buildPayload, isSuccess, nextDelaySec, MAX_ATTEMPTS, crmEstatus } = await import('../src/crmSync.js');
const { validatePatch, publicEndpoint, activeUrl } = await import('../src/integrations.js');

// ── ① 순수 로직 ────────────────────────────────────────────────
test('본문은 계약의 5개 필드만 담는다(estatus 포함)', () => {
  const p = buildPayload('upsert',
    { rfc: ' FEL990715AB1 ', discount: '12.50', credit_days: 30, approval_status: 'approved' }, 'admin');
  assert.deepEqual(p, { rfc: 'FEL990715AB1', discountPercent: 12.5, paymentDays: 30,
    transactionUser: 'admin', estatus: 'aprobado' });
  assert.deepEqual(Object.keys(p).sort(),
    ['discountPercent', 'estatus', 'paymentDays', 'rfc', 'transactionUser']);
});

// 승인 상태를 안 보내면 ERP 에서 승인을 끝내도 CRM 고객이 「Aprobación pendiente」 로
//   영원히 남는다 — P-0001 에서 실제로 그렇게 됐다.
test('승인 전송은 estatus=aprobado 를 함께 보낸다', () => {
  const p = buildPayload('upsert', { rfc: 'X', discount: 30, credit_days: 45, approval_status: 'approved' }, 'admin');
  assert.equal(p.estatus, 'aprobado');
});

test('승인 대기 고객을 밀어도 aprobado 라고 하지 않는다', () => {
  // 전체 동기화(scope=all)에는 승인 대기 고객이 섞일 수 있다. 그때 승인됐다고 알리면
  // CRM 이 잘못된 상태를 갖게 되고, 그건 상태를 안 보내는 것보다 나쁘다.
  assert.equal(buildPayload('upsert', { rfc: 'X', approval_status: 'pending' }, 'admin').estatus, 'pendiente');
  assert.equal(crmEstatus('rejected'), 'rechazado');
});

test('approval_status 가 없던 레거시 행은 aprobado 로 본다', () => {
  // 0185 이전 고객에는 이 컬럼 값이 없다. 그 고객들은 이미 거래 중이므로 승인된 것으로 본다.
  assert.equal(buildPayload('upsert', { rfc: 'X' }, 'admin').estatus, 'aprobado');
  assert.equal(crmEstatus(null), 'aprobado');
  assert.equal(crmEstatus(''), 'aprobado');
});

test('삭제·반려 본문에는 상태가 섞이지 않는다', () => {
  const del = buildPayload('delete', { rfc: 'X', approval_status: 'approved' }, 'admin');
  assert.equal('estatus' in del, false, '삭제는 상태를 말할 자리가 아니다');
  assert.equal(buildPayload('reject', { rfc: 'X', approval_status: 'rejected' }, 'admin', '사유').estatus, 'rechazado');
});

// ── 0213 · CRM 에 없는 고객 → 등록 창구로 폴백 ─────────────────
test('create 본문에는 신원(상호·연락처·ERP 코드)이 들어간다', () => {
  // 상거래정보만으로는 CRM 에 고객을 만들 수 없다.
  const p = buildPayload('create', { rfc: 'ABC010203XY1', code: 'C-0042', name: 'ACME SA',
    contact: 'a@b.com', phone: '81', ship_address: 'Monterrey',
    discount: 15, credit_days: 45, approval_status: 'approved' }, 'admin');
  assert.equal(p.rfc, 'ABC010203XY1');
  assert.equal(p.nombre, 'ACME SA');
  assert.equal(p.erpCustomerCode, 'C-0042');
  assert.equal(p.discountPercent, 15);
  assert.equal(p.estatus, 'aprobado');
});

test('create 본문은 빈 선택 항목을 아예 빼고 보낸다', () => {
  // null 을 보내면 상대가 그 값으로 덮어쓸 수 있다 — 없는 것과 "비우라"는 다른 말이다.
  const p = buildPayload('create', { rfc: 'X', name: 'N', discount: 0, credit_days: 0 }, 'admin');
  assert.equal('telefono' in p, false);
  assert.equal('correo' in p, false);
  assert.equal('direccion' in p, false);
  assert.equal('erpCustomerCode' in p, false);
});

test('폴백은 자기 자신을 가리킬 수 없다', () => {
  // 그러면 같은 실패로 끝없이 새 전송이 쌓인다.
  assert.equal(validatePatch({ fallback_key: 'customer_commercial' },
    { key: 'customer_commercial', direction: 'out' }), 'fallback_self');
  assert.equal(validatePatch({ fallback_key: 'customer_create' },
    { key: 'customer_commercial', direction: 'out' }), null);
});

test('폴백 규칙은 등록부(데이터)에 있고 코드에 박히지 않는다', () => {
  // 상대가 오류코드를 바꾸거나 창구를 합치면 화면에서 고칠 수 있어야 한다.
  const src = readFileSync(new URL('../src/crmSync.js', import.meta.url), 'utf8');
  assert.ok(/ep\.fallback_key/.test(src) && /ep\.fallback_codes/.test(src));
  assert.ok(/if \(row\.fallback_of\) return null;/.test(src), '폴백의 폴백은 없어야 무한 연쇄가 안 생긴다');
  assert.ok(/if \(row\.op !== 'upsert'\) return null;/.test(src), '삭제·반려는 폴백 대상이 아니다');
  assert.ok(/!target \|\| !target\.enabled \|\| !activeUrl\(target\)/.test(src),
    '대상 창구가 준비 안 됐으면 조용히 예전대로 닫혀야 한다');
  const g = readFileSync(new URL('../../refatrix-integrations.html', import.meta.url), 'utf8');
  assert.ok(/fFallbackKey/.test(g), '화면에서 대체 창구를 고를 수 있어야 한다');
});

// ── 0214 · API 키를 다른 창구에서 물려받는다 ────────────────────
test('키를 자기 자신에게서 물려받을 수는 없다', () => {
  assert.equal(validatePatch({ auth_from: 'customer_create' },
    { key: 'customer_create', direction: 'out' }), 'auth_from_self');
  assert.equal(validatePatch({ auth_from: 'customer_commercial' },
    { key: 'customer_create', direction: 'out' }), null);
  assert.equal(validatePatch({ auth_from: '' }, { key: 'customer_create', direction: 'out' }), null,
    '빈 값(물려받지 않음)은 언제나 허용된다');
});

test('물려받은 키도 값으로는 내려가지 않는다 — 출처만 알려 준다', () => {
  // 화면은 「어디 키를 쓰는지」만 알면 된다. 값이 한 번이라도 응답에 실리면
  // 브라우저 개발자도구·로그·캡처 어디로든 샌다.
  const pub = publicEndpoint({ key: 'customer_create', category: 'customer', label: '신규 등록',
    env: 'test', url_test: 'https://crm/x', auth_from: 'customer_commercial',
    auth_token_test: 'borrowed-secret', token_borrowed_from: 'customer_commercial',
    token_borrowed_label: '고객 상거래정보', timeout_ms: 10000 });
  assert.equal(pub.has_token, true);
  assert.equal(pub.auth_from, 'customer_commercial');
  assert.equal(pub.token_borrowed_from, 'customer_commercial');
  assert.equal(JSON.stringify(pub).includes('borrowed-secret'), false, '키 값이 응답에 실리면 안 된다');
});

test('키 물려받기 규칙도 한 곳(등록부)에 있고 화면이 그걸 읽는다', () => {
  // 이 프로젝트에서 두 번 사고가 났다 — 규칙이 코드와 화면에 따로 있으면 반드시 엇갈린다.
  const src = readFileSync(new URL('../src/integrations.js', import.meta.url), 'utf8');
  assert.ok(/_depth < 3/.test(src), '사슬이 꼬여도 멈춰야 한다');
  assert.ok(/String\(ep\.auth_from\) !== String\(key\)/.test(src), '자기 자신에게서 물려받으면 안 된다');
  assert.ok(/&& !activeToken\(ep\)/.test(src), '자기 키가 있으면 그걸 써야 한다');
  const g = readFileSync(new URL('../../refatrix-integrations.html', import.meta.url), 'utf8');
  assert.ok(/fAuthFrom/.test(g), '화면에서 물려받을 창구를 고를 수 있어야 한다');
  assert.ok(/token_borrowed_label|token_borrowed_from/.test(g),
    '화면은 서버가 준 사실을 보여줘야 한다 — 스스로 추측하면 어긋난다');
});

test('시험 전송도 실전과 같은 본문 조립기를 쓴다', () => {
  // 예전에는 integrationRoutes 가 본문을 따로 만들었다 — 계약이 바뀌면
  // 「테스트는 되는데 실전은 안 되는」 상태가 된다.
  const src = readFileSync(new URL('../src/routes/integrationRoutes.js', import.meta.url), 'utf8');
  assert.ok(/buildPayload\(op, c,/.test(src), '연결 테스트가 buildPayload 를 써야 한다');
  assert.equal(/discountPercent:\s*Number\(c\.discount/.test(src), false, '본문을 따로 조립하면 안 된다');
});

test('삭제 본문은 rfc + transactionUser 만 보낸다', () => {
  assert.deepEqual(buildPayload('delete', { rfc: 'ABC010101AAA', discount: 9, credit_days: 5 }, 'oscar'),
    { rfc: 'ABC010101AAA', transactionUser: 'oscar' });
});

test('할인·외상일이 비어 있어도 0 으로 보낸다(널을 보내지 않는다)', () => {
  const p = buildPayload('upsert', { rfc: 'X', discount: null, credit_days: null }, 'admin');
  assert.equal(p.discountPercent, 0);
  assert.equal(p.paymentDays, 0);
});

test('성공 판정: 2xx + codigoError "0" 만 성공', () => {
  assert.equal(isSuccess(200, { codigoError: '0', mensaje: 'Cliente Actualizado correctamente' }), true);
  assert.equal(isSuccess(200, { codigoError: '7', mensaje: 'RFC no encontrado' }), false);
  assert.equal(isSuccess(500, { codigoError: '0' }), false);
  assert.equal(isSuccess(204, null), true, '본문 없는 2xx 는 성공으로 본다');
  assert.equal(isSuccess(200, { mensaje: 'ok' }), true, 'codigoError 가 없으면 2xx 만으로 판정');
});

test('백오프는 단조 증가하고 시도 한도가 있다', () => {
  const d = [1, 2, 3, 4, 5, 6].map(nextDelaySec);
  for (let i = 1; i < d.length; i++) assert.ok(d[i] > d[i - 1], '재시도 간격이 늘어나야 한다');
  assert.equal(MAX_ATTEMPTS, 6);
});

// ── ①-b 연동 등록부(순수 로직) ─────────────────────────────────
test('사용 중인 서버에 따라 테스트/운영 URL 이 갈린다', () => {
  const ep = { env: 'test', url_test: 'http://t/x', url_prod: 'https://p/x' };
  assert.equal(activeUrl(ep), 'http://t/x');
  assert.equal(activeUrl({ ...ep, env: 'prod' }), 'https://p/x');
});

test('토큰은 화면으로 값이 나가지 않는다(has_token 만)', () => {
  const pub = publicEndpoint({ key: 'k', category: 'customer', label: 'L', enabled: true, env: 'test',
    url_test: 'http://t/x', auth_token: 'secret-token', auth_header: 'Authorization',
    method_upsert: 'POST', method_delete: 'DELETE', ok_code: '0', user_field: 'login_id', timeout_ms: 10000 });
  assert.equal(pub.has_token, true);
  assert.equal(JSON.stringify(pub).includes('secret-token'), false, '토큰 값이 응답에 실리면 안 된다');
  assert.equal(pub.secure, false, 'http 는 secure=false 로 표시된다');
});

test('설정 검증: 잘못된 URL·메서드·환경·타임아웃을 막는다', () => {
  assert.equal(validatePatch({ url_test: 'ftp://x' }), 'url_invalid');
  assert.equal(validatePatch({ method_upsert: 'FETCH' }), 'method_invalid');
  assert.equal(validatePatch({ env: 'stage' }), 'env_invalid');
  assert.equal(validatePatch({ timeout_ms: 100 }), 'timeout_invalid');
  assert.equal(validatePatch({ user_field: 'email' }), 'user_field_invalid');
  assert.equal(validatePatch({ env: 'prod', url_prod: '' }), 'url_prod_required');
  assert.equal(validatePatch({ env: 'prod', url_prod: 'https://crm/x', method_upsert: 'PUT', timeout_ms: 8000 }), null);
});

// ── ② 실제 DB + 모의 CRM ───────────────────────────────────────
const dbTest = PG ? test : test.skip;

dbTest('적재 → 전송 → 재시도 → 삭제 (실 DB)', async (t) => {
  const { query } = await import('../src/db.js');
  const { enqueueCustomerSync, drainOutbox } = await import('../src/crmSync.js');
  const { saveEndpoint, invalidateEndpointCache, getEndpoint } = await import('../src/integrations.js');

  // 등록부의 고객 연동을 모의 CRM 으로 켜 둔다(관리자 화면이 하는 일과 같은 경로).
  // 적재 직후 예약된 백그라운드 드레인과 겹치면 busy 가 나온다 — 테스트에서는 잠깐 기다렸다 다시 시도한다.
  const drainNow = async (opts = { limit: 10 }) => {
    for (let i = 0; i < 20; i++) {
      const o = await drainOutbox(opts);
      if (!o.busy) return o;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('drain busy timeout');
  };
  const setEp = async (patch) => {
    const r = await saveEndpoint('customer_commercial', patch, null);
    assert.ok(!r.error, '설정 저장 실패: ' + r.error);
    invalidateEndpointCache();
  };
  await setEp({ enabled: true, env: 'test', url_test: process.env.CRM_SYNC_URL, timeout_ms: 2000 });

  const uid = (await query(
    `INSERT INTO users (name, role, pin_hash, login_id) VALUES ('디렉터테스트','director','x','dir_test') RETURNING id`)).rows[0].id;
  const mk = async (code, rfc) => (await query(
    `INSERT INTO customers (code, name, rfc, discount, credit_days, approval_status, created_by)
     VALUES ($1,$2,$3,15,45,'approved',$4) RETURNING id`, [code, 'Cliente ' + code, rfc, uid])).rows[0].id;

  const c1 = await mk('T-CRM-1', 'FEL990715AB1');
  const c2 = await mk('T-CRM-2', null);
  const c3 = await mk('T-CRM-3', 'GAR850101XY9');  // RFC 는 있지만 한 번도 전송된 적 없는 고객

  await t.test('승인 적재 → 즉시 전송되고 sent 로 닫힌다', async () => {
    received.length = 0;
    scenario = { status: 200, body: { codigoError: '0', mensaje: 'Cliente Actualizado correctamente' }, delayMs: 0 };
    const en = await enqueueCustomerSync(c1, 'upsert', { origin: 'registration_approve', actorUserId: uid });
    assert.equal(en.status, 'pending');
    const out = await drainNow();
    assert.equal(out.sent, 1, '한 건이 전송돼야 한다');
    const row = (await query(`SELECT * FROM crm_customer_outbox WHERE id=$1`, [en.id])).rows[0];
    assert.equal(row.status, 'sent');
    assert.equal(row.codigo_error, '0');
    assert.equal(Number(row.http_status), 200);
    assert.ok(row.sent_at);
    assert.equal(received[0].method, 'POST');
    // CRM 이 실제로 받는 본문 — 승인 상태까지 포함해 그대로 못 박는다.
    assert.deepEqual(received[0].body,
      { rfc: 'FEL990715AB1', discountPercent: 15, paymentDays: 45,
        transactionUser: 'dir_test', estatus: 'aprobado' });
  });

  await t.test('RFC 가 없으면 보내지 않고 skipped 로 남는다', async () => {
    received.length = 0;
    const en = await enqueueCustomerSync(c2, 'upsert', { origin: 'registration_approve', actorUserId: uid });
    assert.equal(en.status, 'skipped');
    assert.equal(en.note, 'rfc_missing');
    await drainNow();
    assert.equal(received.length, 0, 'RFC 없는 건은 네트워크로 나가면 안 된다');
  });

  await t.test('CRM 이 오류코드를 주면 pending 으로 남고 다음 시도가 예약된다', async () => {
    scenario = { status: 200, body: { codigoError: '7', mensaje: 'RFC no encontrado' }, delayMs: 0 };
    const en = await enqueueCustomerSync(c1, 'upsert', { origin: 'change_approve', actorUserId: uid });
    const out = await drainNow();
    assert.equal(out.failed, 1);
    const row = (await query(`SELECT * FROM crm_customer_outbox WHERE id=$1`, [en.id])).rows[0];
    assert.equal(row.status, 'pending', '한 번 실패로 버리지 않는다');
    assert.equal(Number(row.attempts), 1);
    assert.equal(row.codigo_error, '7');
    assert.ok(new Date(row.next_attempt_at).getTime() > Date.now(), '다음 시도 시각이 미래여야 한다');
    assert.match(String(row.last_error), /RFC no encontrado/);
  });

  await t.test('한도까지 실패하면 failed 로 닫히고 화면에 남는다', async () => {
    const en = (await query(
      `SELECT id FROM crm_customer_outbox WHERE customer_id=$1 AND status='pending' ORDER BY id DESC LIMIT 1`,
      [c1])).rows[0];
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) {
      await query(`UPDATE crm_customer_outbox SET next_attempt_at=now() WHERE id=$1`, [en.id]);
      await drainNow();
    }
    const row = (await query(`SELECT status, attempts FROM crm_customer_outbox WHERE id=$1`, [en.id])).rows[0];
    assert.equal(row.status, 'failed');
    assert.equal(Number(row.attempts), MAX_ATTEMPTS);
  });

  await t.test('타임아웃도 실패로 기록된다(승인은 막지 않는다)', async () => {
    scenario = { status: 200, body: { codigoError: '0' }, delayMs: 2500 }; // > CRM_SYNC_TIMEOUT_MS
    const en = await enqueueCustomerSync(c1, 'upsert', { origin: 'director_edit', actorUserId: uid });
    await drainNow();
    const row = (await query(`SELECT status, last_error FROM crm_customer_outbox WHERE id=$1`, [en.id])).rows[0];
    assert.equal(row.status, 'pending');
    assert.equal(row.last_error, 'timeout');
    await query(`UPDATE crm_customer_outbox SET status='failed' WHERE id=$1`, [en.id]);
  });

  await t.test('삭제는 DELETE + rfc 쿼리로 나가고, 보낸 적 없는 고객은 skipped', async () => {
    received.length = 0;
    scenario = { status: 200, body: { codigoError: '0', mensaje: 'Cliente Eliminado correctamente' }, delayMs: 0 };
    // 한 번도 CRM 에 보낸 적 없는 고객의 baja 는 알릴 것이 없다.
    const skip = await enqueueCustomerSync(c3, 'delete', { origin: 'customer_delete', actorUserId: uid });
    assert.equal(skip.status, 'skipped');
    assert.equal(skip.note, 'never_sent');
    // RFC 자체가 없으면 그 이유가 먼저 잡힌다.
    const noRfc = await enqueueCustomerSync(c2, 'delete', { origin: 'customer_delete', actorUserId: uid });
    assert.equal(noRfc.note, 'rfc_missing');

    const del = await enqueueCustomerSync(c1, 'delete', { origin: 'customer_delete', actorUserId: uid });
    assert.equal(del.status, 'pending');
    await drainNow();
    const row = (await query(`SELECT status FROM crm_customer_outbox WHERE id=$1`, [del.id])).rows[0];
    assert.equal(row.status, 'sent');
    const req = received[received.length - 1];
    assert.equal(req.method, 'DELETE');
    assert.match(req.url, /rfc=FEL990715AB1/);
    assert.deepEqual(req.body, { rfc: 'FEL990715AB1', transactionUser: 'dir_test' });
  });

  await t.test('연동이 꺼져 있으면 시도 횟수를 쓰지 않고 대기로 남는다', async () => {
    received.length = 0;
    await setEp({ enabled: false });
    const en = await enqueueCustomerSync(c1, 'upsert', { origin: 'director_edit', actorUserId: uid });
    const out = await drainNow();
    assert.equal(received.length, 0, '꺼진 연동은 네트워크로 나가면 안 된다');
    assert.equal(out.held, 1);
    const row = (await query(`SELECT status, attempts FROM crm_customer_outbox WHERE id=$1`, [en.id])).rows[0];
    assert.equal(row.status, 'pending');
    assert.equal(Number(row.attempts), 0, '꺼진 동안의 대기는 재시도 한도를 깎지 않는다');

    // 다시 켜면 밀린 건이 그대로 나간다.
    scenario = { status: 200, body: { codigoError: '0', mensaje: 'ok' }, delayMs: 0 };
    await setEp({ enabled: true });
    await drainNow();
    const after = (await query(`SELECT status FROM crm_customer_outbox WHERE id=$1`, [en.id])).rows[0];
    assert.equal(after.status, 'sent');
  });

  await t.test('운영 서버로 전환하면 그 주소로 나가고 이력에 환경이 남는다', async () => {
    received.length = 0;
    await setEp({ env: 'prod', url_prod: process.env.CRM_SYNC_URL + '?srv=prod' });
    const ep = await getEndpoint('customer_commercial');
    assert.equal(ep.env, 'prod');
    const en = await enqueueCustomerSync(c1, 'upsert', { origin: 'change_approve', actorUserId: uid });
    await drainNow();
    const row = (await query(`SELECT status, env, url, request_method FROM crm_customer_outbox WHERE id=$1`, [en.id])).rows[0];
    assert.equal(row.status, 'sent');
    assert.equal(row.env, 'prod');
    assert.match(String(row.url), /srv=prod/);
    assert.equal(row.request_method, 'POST');
    assert.match(received[received.length - 1].url, /srv=prod/);
    await setEp({ env: 'test' });
  });

  await query(`DELETE FROM crm_customer_outbox WHERE customer_id IN ($1,$2,$3)`, [c1, c2, c3]);
  await query(`DELETE FROM customers WHERE id IN ($1,$2,$3)`, [c1, c2, c3]);
  await query(`DELETE FROM users WHERE id=$1`, [uid]);
});

// ── 0214-b · 실제로 키가 물려져 나가는가 (실 DB) ────────────────
dbTest('자기 키가 없으면 물려받고, 발급하면 자기 것을 쓴다 (실 DB)', async (t) => {
  const { query } = await import('../src/db.js');
  const { getEndpoint, listEndpoints, publicEndpoint, invalidateEndpointCache } =
    await import('../src/integrations.js');

  const SRC = 'customer_commercial';
  const DST = 'customer_create';
  const before = (await query(
    `SELECT key, auth_token_test, auth_from FROM integration_endpoints WHERE key IN ($1,$2)`,
    [SRC, DST])).rows;
  const orig = Object.fromEntries(before.map((r) => [r.key, r]));

  const restore = async () => {
    for (const r of before) {
      await query(`UPDATE integration_endpoints SET auth_token_test=$2, auth_from=$3 WHERE key=$1`,
        [r.key, r.auth_token_test, r.auth_from]);
    }
    invalidateEndpointCache();
  };
  t.after(restore);

  await query(`UPDATE integration_endpoints SET env='test', auth_token_test=$2 WHERE key=$1`,
    [SRC, 'src-key-0214']);
  await query(`UPDATE integration_endpoints SET env='test', auth_token_test=NULL, auth_token=NULL,
                      auth_from=$2 WHERE key=$1`, [DST, SRC]);
  invalidateEndpointCache();

  await t.test('자기 키가 없으면 지정한 창구의 키를 쓴다', async () => {
    const ep = await getEndpoint(DST);
    assert.equal(ep.auth_token_test, 'src-key-0214');
    assert.equal(ep.token_borrowed_from, SRC);
    const pub = publicEndpoint(ep);
    assert.equal(pub.has_token, true);
    assert.equal(JSON.stringify(pub).includes('src-key-0214'), false);
  });

  await t.test('목록과 상세가 같은 말을 한다', async () => {
    // 목록은 「키 있음」인데 상세는 「없음」이면 디렉터는 어느 쪽을 믿어야 할지 알 수 없다.
    const inList = (await listEndpoints()).find((e) => e.key === DST);
    assert.equal(publicEndpoint(inList).has_token, true);
    assert.equal(publicEndpoint(inList).token_borrowed_from, SRC);
  });

  await t.test('자기 키를 발급하면 물려받기가 멈춘다', async () => {
    await query(`UPDATE integration_endpoints SET auth_token_test=$2 WHERE key=$1`, [DST, 'own-key-0214']);
    invalidateEndpointCache();
    const ep = await getEndpoint(DST);
    assert.equal(ep.auth_token_test, 'own-key-0214', '분리하고 싶으면 발급만 하면 된다');
    assert.equal(ep.token_borrowed_from, undefined);
  });

  await t.test('출처 창구의 키가 비면 물려받을 것이 없다(조용히 인증 없이 나가지 않게 화면이 알린다)', async () => {
    await query(`UPDATE integration_endpoints SET auth_token_test=NULL WHERE key IN ($1,$2)`, [SRC, DST]);
    invalidateEndpointCache();
    const pub = publicEndpoint(await getEndpoint(DST));
    assert.equal(pub.has_token, false);
    assert.equal(pub.auth_from, SRC, '지정은 남아 있어야 키를 채우면 바로 돈다');
  });

  assert.ok(orig[DST], 'customer_create 창구가 0213 으로 등록돼 있어야 한다');
});

test.after(() => { crm.close(); });
