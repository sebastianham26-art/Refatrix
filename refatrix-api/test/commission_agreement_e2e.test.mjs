// =====================================================================
// 커미션 조건 합의(0251) — 순수 로직 + 실 PostgreSQL 종단
//   · 문서 생성(스페인어)·버전 해시 · 본인 PIN 합의 · 이력 · 조건 변경 → 재합의 필요
//   · 현황판(디렉터) · 스냅샷 열람 권한 · 기록 수정·삭제 불가
//   실행: TEST_PG_URL=postgres://... node --test test/commission_agreement_e2e.test.mjs
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
// db.js 가 import 시점에 DATABASE_URL 을 읽으므로, 먼저 설정한 뒤 동적 import
if (process.env.TEST_PG_URL) process.env.DATABASE_URL = process.env.TEST_PG_URL;
const { buildTerms, termsHash, buildDoc, summaryKo, statusOf, deviceLabel, RULES_VERSION, validateSalarySteps, fechaEs, rangoEs } = await import('../src/routes/commissionAgreementRoutes.js');

// ── 순수 ──
const OSC = {
  type: 'empleado',
  periods: [{ start_date: '2026-10-01', end_date: null, basis: 'collection', rate: '4.000', match_on: 'payment' }],
  bonus: { enabled: true, basis: 'revenue', start_month: '2026-10', end_month: '2027-03',
    tiers: [{ min_rate: 0, amount: 0 }, { min_rate: 100, amount: 6000 }, { min_rate: 120, amount: 10000 }],
    targets: { '2026-10': 350000, '2026-11': 385000 } },
};

test('조건 정규화·해시 — 순서/타입이 달라도 같은 해시, 조건이 바뀌면 다른 해시', () => {
  const a = buildTerms(OSC);
  const b = buildTerms({ ...OSC, periods: [{ ...OSC.periods[0], rate: 4 }], bonus: { ...OSC.bonus, tiers: [...OSC.bonus.tiers].reverse() } });
  assert.equal(termsHash(a), termsHash(b));
  assert.equal(termsHash(a).length, 12);
  const c = buildTerms({ ...OSC, periods: [{ ...OSC.periods[0], rate: 5 }] });
  assert.notEqual(termsHash(a), termsHash(c));
  assert.equal(a.rules, RULES_VERSION);
  // 매출 기준에는 payment 판정이 붙지 않는다
  assert.equal(buildTerms({ type: 'empleado', periods: [{ start_date: '2026-01-01', basis: 'revenue', rate: 3, match_on: 'payment' }] }).periods[0].match_on, 'invoice');
});

test('문서 — 직원(수금일 4% + 성과급) / 커미셔너(CFDI 문구)', () => {
  const d = buildDoc(buildTerms(OSC), { name: 'oscar', team: '01_Monterrey_01' });
  const txt = JSON.stringify(d);
  assert.match(txt, /4% del monto cobrado sin IVA/);
  assert.match(txt, /cobrada al 100%/);
  assert.ok(d.sections.find((s) => s.key === 'bonus'));
  assert.deepEqual(d.sections.find((s) => s.key === 'bonus').table.rows[0], ['Menos de 100%', 'Sin bono']);
  assert.match(txt, /\$6,000\.00/);
  assert.doesNotMatch(txt, /CFDI/, '직원은 커미션 인보이스 문구 없음');
  assert.match(d.declaration, /y mi bono/);
  assert.equal(d.who.type, 'Empleado');
  const com = buildDoc(buildTerms({ type: 'comisionista', periods: [{ start_date: '2026-06-01', basis: 'collection', rate: 5 }], custRates: [{ customer_name: 'LUEMI', rate: 6 }] }));
  const t2 = JSON.stringify(com);
  assert.match(t2, /CFDI/);
  assert.match(t2, /facturas emitidas en el periodo/);
  assert.match(t2, /LUEMI\*\* 6%/);
  assert.ok(!com.sections.find((s) => s.key === 'bonus'));
});

test('요약·상태·기기', () => {
  assert.equal(summaryKo(buildTerms(OSC)), '수금(수금일) 4% · 2026-10-01~ · 성과급 100%↑6k/120%↑10k');
  assert.equal(statusOf('abc', null), 'pending');
  assert.equal(statusOf('abc', { version_hash: 'abc' }), 'agreed');
  assert.equal(statusOf('abc', { version_hash: 'old' }), 'changed');
  assert.equal(deviceLabel('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36'), 'Chrome / Android');
});


test('고정급여 단계(0254) — 검증·날짜 표기·문서·해시', () => {
  assert.equal(fechaEs('2026-10-01'), '1 oct 2026');
  assert.equal(rangoEs('2026-11-16', '2027-02-28'), 'Del 16 nov 2026 al 28 feb 2027');
  const v = validateSalarySteps([{ start_date: '2026-11-16', amount: 40000 }, { start_date: '2026-10-01', amount: '45000' }, { start_date: '2027-03-01', amount: 25000, note: 'final' }]);
  assert.equal(v.ok, true);
  assert.deepEqual(v.steps.map((x) => [x.start_date, x.end_date, x.amount]), [['2026-10-01', '2026-11-15', 45000], ['2026-11-16', '2027-02-28', 40000], ['2027-03-01', null, 25000]]);
  assert.equal(validateSalarySteps([{ start_date: '2026-10-01', end_date: '2026-12-01', amount: 1 }, { start_date: '2026-11-01', amount: 1 }]).error, 'overlap');
  assert.equal(validateSalarySteps([{ start_date: '2026-10-01', amount: '' }]).error, 'bad_amount');
  assert.equal(validateSalarySteps([{ start_date: '10/01/2026', amount: 1 }]).error, 'bad_start');
  assert.equal(validateSalarySteps([]).ok, true, '빈 목록 = 단계표 삭제');
  const base = buildTerms(OSC);
  const withSal = buildTerms({ ...OSC, salary: v.steps });
  assert.ok(!('salary' in base), '단계표 없는 사람은 키 없음 → 기존 버전 유지');
  assert.notEqual(termsHash(base), termsHash(withSal));
  const d = buildDoc(withSal, { name: 'oscar' });
  assert.equal(d.title, 'Acuerdo de sueldo fijo y comisión');
  const sal = d.sections[0];
  assert.equal(sal.key, 'salary');
  assert.deepEqual(sal.table.rows[0], ['Del 1 oct 2026 al 15 nov 2026', '$45,000.00', '']);
  assert.deepEqual(sal.table.rows[2], ['Desde 1 mar 2027', '$25,000.00', 'final']);
  assert.match(d.declaration, /mi sueldo fijo, mi comisión y mi bono/);
  assert.match(summaryKo(withSal), /고정급 3단계$/);
  // 성과급 월도 날짜 범위로
  const bonus = d.sections.find((x) => x.key === 'bonus');
  assert.deepEqual(bonus.table2.rows[0], ['Del 1 oct 2026 al 31 oct 2026', '$350,000.00']);
  assert.match(bonus.items[2], /Del 1 oct 2026 al 31 mar 2027/);
  assert.deepEqual(d.sections.find((x) => x.key === 'commission').table.rows[0][0], 'Desde 1 oct 2026');
});

// ── 종단 ──
const PG = process.env.TEST_PG_URL;
const SKIP = !PG;
if (PG) process.env.DATABASE_URL = PG;
let query, app, hashPin;
const ID = {}; const tok = {};
const TAG = 'AGRTEST';

test('boot', { skip: SKIP }, async () => {
  ({ query } = await import('../src/db.js'));
  ({ hashPin } = await import('../src/auth.js'));
  const routes = (await import('../src/routes/commissionAgreementRoutes.js')).default;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const U = `(SELECT id FROM users WHERE login_id LIKE 'agrtest%')`;
  await query(`ALTER TABLE commission_agreements DISABLE TRIGGER trg_comm_agree_immutable`);
  await query(`DELETE FROM commission_agreements WHERE user_id IN ${U}`);
  await query(`ALTER TABLE commission_agreements ENABLE TRIGGER trg_comm_agree_immutable`);
  await query(`DELETE FROM bonus_payouts WHERE user_id IN ${U}`);
  await query(`DELETE FROM commission_salary_steps WHERE user_id IN ${U}`);
  await query(`DELETE FROM commission_contracts WHERE user_id IN ${U} OR uploaded_by IN ${U}`);
  await query(`DELETE FROM bonus_tiers WHERE user_id IN ${U}`);
  await query(`DELETE FROM bonus_targets WHERE user_id IN ${U}`);
  await query(`DELETE FROM bonus_plans WHERE user_id IN ${U}`);
  await query(`DELETE FROM commission_agent_periods WHERE user_id IN ${U}`);
  await query(`DELETE FROM commission_agents WHERE user_id IN ${U}`);
  await query(`DELETE FROM user_page_access WHERE user_id IN ${U}`);
  await query(`DELETE FROM audit_log WHERE user_id IN ${U}`);
  await query(`DELETE FROM users WHERE login_id LIKE 'agrtest%'`);
  const mk = async (name, role, login, pin) => Number((await query(
    `INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,$3,$4) RETURNING id`, [name, role, hashPin(pin), login])).rows[0].id);
  ID.dir = await mk(`${TAG}디렉터`, 'director', 'agrtest_dir', '9999');
  ID.com = await mk(`${TAG}커미셔너`, 'sales', 'agrtest_com', '1234');
  ID.emp = await mk(`${TAG}직원`, 'sales', 'agrtest_emp', '5678');
  ID.none = await mk(`${TAG}비대상`, 'sales', 'agrtest_none', '1111');
  ID.fin = await mk(`${TAG}재무`, 'treasury', 'agrtest_fin', '2222');
  await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access) VALUES ($1,'guiacom','anywhere','view')`, [ID.com]);
  for (const [u, rate, m] of [[ID.com, 5, 'invoice'], [ID.emp, 4, 'payment']]) {
    await query(`INSERT INTO commission_agents (user_id, default_rate, active, created_by, updated_by) VALUES ($1,$2,true,$3,$3)`, [u, rate, ID.dir]);
    await query(`INSERT INTO commission_agent_periods (user_id, start_date, basis, rate, match_on) VALUES ($1,'2026-10-01','collection',$2,$3)`, [u, rate, m]);
  }
  await query(`INSERT INTO bonus_plans (user_id, enabled, basis, start_month, end_month, include_overdue, partial_credit) VALUES ($1,true,'revenue','2026-10','2026-12',true,false)`, [ID.emp]);
  for (const [r, a] of [[0, 0], [100, 6000], [120, 10000]]) await query(`INSERT INTO bonus_tiers (user_id, min_rate, amount) VALUES ($1,$2,$3)`, [ID.emp, r, a]);
  for (const [m, a] of [['2026-10', 350000], ['2026-11', 385000], ['2026-12', 300000]]) await query(`INSERT INTO bonus_targets (user_id, month, revenue_target) VALUES ($1,$2,$3)`, [ID.emp, m, a]);

  app = Fastify({ trustProxy: true });
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret' });
  await app.register(routes);
  await app.ready();
  for (const k of ['dir', 'com', 'emp', 'none', 'fin']) tok[k] = app.jwt.sign({ sub: ID[k] });
});

const get = (w, url) => app.inject({ method: 'GET', url, headers: { authorization: 'Bearer ' + tok[w] } });
const post = (w, url, body) => app.inject({ method: 'POST', url, payload: body, headers: { authorization: 'Bearer ' + tok[w], 'user-agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/129.0 Mobile', 'x-forwarded-for': '189.203.1.2' } });

test('① 본인 문서 — 커미셔너/직원 구분, 미합의 상태', { skip: SKIP }, async () => {
  const c = (await get('com', '/api/commission/agreement/me')).json();
  assert.equal(c.is_agent, true);
  assert.equal(c.status, 'pending');
  assert.equal(c.doc.who.type, 'Comisionista (externo)');
  assert.match(JSON.stringify(c.doc), /CFDI/);
  const e = (await get('emp', '/api/commission/agreement/me')).json();
  assert.equal(e.doc.who.type, 'Empleado');
  assert.ok(e.doc.sections.find((s) => s.key === 'bonus'));
  const n = (await get('none', '/api/commission/agreement/me')).json();
  assert.equal(n.is_agent, false);
});

test('② PIN 합의 — 틀린 PIN 403 · 체크 없음 400 · 옛 버전 409 · 정상 200', { skip: SKIP }, async () => {
  const me = (await get('com', '/api/commission/agreement/me')).json();
  assert.equal((await post('com', '/api/commission/agreement/me', { pin: '0000', version: me.version, agree: true })).statusCode, 403);
  assert.equal((await post('com', '/api/commission/agreement/me', { pin: '1234', version: me.version })).statusCode, 400);
  assert.equal((await post('com', '/api/commission/agreement/me', { pin: '1234', version: 'deadbeef0000', agree: true })).statusCode, 409);
  // 남의 PIN 으로는 안 된다(디렉터 PIN 9999)
  assert.equal((await post('com', '/api/commission/agreement/me', { pin: '9999', version: me.version, agree: true })).statusCode, 403);
  const ok = await post('com', '/api/commission/agreement/me', { pin: '1234', version: me.version, agree: true });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().device, 'Chrome / Android');
  const after = (await get('com', '/api/commission/agreement/me')).json();
  assert.equal(after.status, 'agreed');
  assert.equal(after.history.length, 1);
  assert.equal(after.history[0].current, true);
  const row = (await query(`SELECT ip, agent_type, terms->>'type' AS t FROM commission_agreements WHERE user_id=$1`, [ID.com])).rows[0];
  assert.equal(row.ip, '189.203.1.2');
  assert.equal(row.agent_type, 'comisionista');
  // 감사로그 — 성공 1건(create) + 실패(denied) 기록이 실제로 남는다
  const al = (await query(`SELECT action, result FROM audit_log WHERE user_id=$1 AND target LIKE 'commission_agreement:%'`, [ID.com])).rows;
  assert.ok(al.some((x) => x.action === 'create' && x.result === 'success'));
  assert.ok(al.some((x) => x.result === 'denied'));
  // 비대상은 합의 불가
  assert.equal((await post('none', '/api/commission/agreement/me', { pin: '1111', version: 'x', agree: true })).statusCode, 403);
});

test('③ 조건 변경 → 재합의 필요 → 다시 합의하면 이력 2건', { skip: SKIP }, async () => {
  await query(`UPDATE commission_agent_periods SET rate=6 WHERE user_id=$1`, [ID.com]);
  const me = (await get('com', '/api/commission/agreement/me')).json();
  assert.equal(me.status, 'changed');
  assert.equal(me.history[0].current, false);
  const r = await post('com', '/api/commission/agreement/me', { pin: '1234', version: me.version, agree: true });
  assert.equal(r.statusCode, 200);
  const again = (await get('com', '/api/commission/agreement/me')).json();
  assert.equal(again.status, 'agreed');
  assert.equal(again.history.length, 2);
  assert.match(JSON.stringify(again.doc), /6% del valor sin IVA/);
});

test('④ 현황판 — 디렉터만 · 상태별 집계', { skip: SKIP }, async () => {
  assert.equal((await get('com', '/api/commission/agreement/board')).statusCode, 403);
  const b = (await get('dir', '/api/commission/agreement/board')).json();
  const mine = b.items.filter((x) => [ID.com, ID.emp].includes(x.user_id));
  assert.equal(mine.length, 2);
  assert.equal(mine.find((x) => x.user_id === ID.com).status, 'agreed');
  assert.equal(mine.find((x) => x.user_id === ID.emp).status, 'pending');
  assert.equal(mine.find((x) => x.user_id === ID.emp).summary, '수금(수금일) 4% · 2026-10-01~ · 성과급 100%↑6k/120%↑10k');
  const pv = (await get('dir', `/api/commission/agreement/preview/${ID.emp}`)).json();
  assert.equal(pv.status, 'pending');
});

test('⑤ 스냅샷 — 합의 당시 문서 그대로 · 본인·디렉터만 · 수정/삭제 불가', { skip: SKIP }, async () => {
  const first = (await query(`SELECT id FROM commission_agreements WHERE user_id=$1 ORDER BY id LIMIT 1`, [ID.com])).rows[0].id;
  const d = (await get('com', `/api/commission/agreement/doc/${first}`)).json();
  assert.match(JSON.stringify(d.doc), /5% del valor sin IVA/, '조건이 6%로 바뀌어도 당시 문서는 5%');
  assert.equal(d.ip, null, '본인에게는 IP 비표시');
  assert.equal((await get('dir', `/api/commission/agreement/doc/${first}`)).json().ip, '189.203.1.2');
  assert.equal((await get('emp', `/api/commission/agreement/doc/${first}`)).statusCode, 403);
  await assert.rejects(query(`UPDATE commission_agreements SET version_hash='x' WHERE id=$1`, [first]), /수정·삭제할 수 없습니다/);
  await assert.rejects(query(`DELETE FROM commission_agreements WHERE id=$1`, [first]), /수정·삭제할 수 없습니다/);
});

test('⑥ PIN 오입력 5회 → 429', { skip: SKIP }, async () => {
  const me = (await get('emp', '/api/commission/agreement/me')).json();
  for (let i = 0; i < 5; i++) assert.equal((await post('emp', '/api/commission/agreement/me', { pin: '0000', version: me.version, agree: true })).statusCode, 403);
  assert.equal((await post('emp', '/api/commission/agreement/me', { pin: '5678', version: me.version, agree: true })).statusCode, 429);
});


test('⑦ 고정급여 단계 저장(디렉터) → 문서에 표시 · 재합의 필요 · 다른 사람 버전 불변', { skip: SKIP }, async () => {
  const before = (await get('com', '/api/commission/agreement/me')).json();
  const empBefore = (await get('emp', '/api/commission/agreement/me')).json();
  // 영업사원은 저장 불가
  assert.equal((await post('emp', `/api/commission/salary/${ID.emp}`, { steps: [] })).statusCode, 403);
  const bad = await post('dir', `/api/commission/salary/${ID.emp}`, { steps: [{ start_date: '2026-10-01', end_date: '2026-12-01', amount: 1 }, { start_date: '2026-11-01', amount: 1 }] });
  assert.equal(bad.statusCode, 400);
  const r = await post('dir', `/api/commission/salary/${ID.emp}`, { steps: [
    { start_date: '2026-10-01', amount: 45000 }, { start_date: '2026-11-16', amount: 40000 }, { start_date: '2027-03-01', amount: 25000 } ] });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().steps[0].end_date, '2026-11-15');
  const list = (await get('dir', '/api/commission/salary')).json();
  assert.equal(list.by_user[ID.emp].length, 3);
  assert.equal((await get('emp', '/api/commission/salary')).statusCode, 403);
  const after = (await get('emp', '/api/commission/agreement/me')).json();
  assert.notEqual(after.version, empBefore.version);
  assert.equal(after.doc.sections[0].key, 'salary');
  assert.equal(after.doc.sections[0].table.rows[1][0], 'Del 16 nov 2026 al 28 feb 2027');
  // 다른 사람(커미셔너)의 버전은 그대로
  assert.equal((await get('com', '/api/commission/agreement/me')).json().version, before.version);
  // 합의 → 스냅샷에 단계표 포함
  const { _resetPinFails } = await import('../src/routes/commissionAgreementRoutes.js');
  _resetPinFails();
  const ok = await post('emp', '/api/commission/agreement/me', { pin: '5678', version: after.version, agree: true });
  assert.equal(ok.statusCode, 200, ok.body);
  const snap = (await get('emp', `/api/commission/agreement/doc/${ok.json().id}`)).json();
  assert.equal(snap.terms.salary.length, 3);
  // 금액 하나 바꾸면 재합의 필요
  await post('dir', `/api/commission/salary/${ID.emp}`, { steps: [
    { start_date: '2026-10-01', amount: 45000 }, { start_date: '2026-11-16', amount: 38000 }, { start_date: '2027-03-01', amount: 25000 } ] });
  assert.equal((await get('emp', '/api/commission/agreement/me')).json().status, 'changed');
  // 단계표 삭제(빈 목록) → 문서에서 빠짐
  await post('dir', `/api/commission/salary/${ID.emp}`, { steps: [] });
  const gone = (await get('emp', '/api/commission/agreement/me')).json();
  assert.ok(!gone.doc.sections.find((x) => x.key === 'salary'));
});


test('⑧ 계약서 — 디렉터만 올림 · 본인과 디렉터만 열람 · 삭제는 본인 화면에서만 사라짐', { skip: SKIP }, async () => {
  const pdf = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n% contrato emp\n%%EOF').toString('base64');
  const pdf2 = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n% contrato com\n%%EOF').toString('base64');
  const up = (who, uid, body) => app.inject({ method: 'POST', url: `/api/commission/contracts/${uid}`, payload: body, headers: { authorization: 'Bearer ' + tok[who] } });
  assert.equal((await up('emp', ID.emp, { file_name: 'c.pdf', data_url: pdf })).statusCode, 403, '본인도 올릴 수 없음');
  assert.equal((await up('fin', ID.emp, { file_name: 'c.pdf', data_url: pdf })).statusCode, 403, '재무도 올릴 수 없음');
  assert.equal((await up('dir', ID.emp, { file_name: 'c.exe', data_url: pdf })).json().error, 'bad_type');
  assert.equal((await up('dir', ID.emp, { file_name: 'c.pdf', data_url: 'data:application/pdf;base64,' + Buffer.from('MZ fake').toString('base64') })).json().error, 'bad_content');
  const big = 'data:application/pdf;base64,' + Buffer.concat([Buffer.from('%PDF'), Buffer.alloc(15 * 1024 * 1024)]).toString('base64');
  const bigR = await up('dir', ID.emp, { file_name: 'big.pdf', data_url: big });
  assert.equal(bigR.statusCode, 400); assert.equal(bigR.json().error, 'too_large');
  const ok = await up('dir', ID.emp, { file_name: 'Contrato Oscar.pdf', data_url: pdf, title: 'Contrato de comisión 2026', signed_date: '2026-10-01' });
  assert.equal(ok.statusCode, 200, ok.body);
  const cid = ok.json().item.id;
  assert.equal(ok.json().item.signed_date, '2026-10-01');
  assert.equal((await up('dir', ID.emp, { file_name: 'again.pdf', data_url: pdf })).statusCode, 409, '같은 파일 중복');
  const cid2 = (await up('dir', ID.com, { file_name: 'com.pdf', data_url: pdf2 })).json().item.id;

  // 목록: 본인은 user_id 를 바꿔도 자기 것만
  const mine = (await get('emp', `/api/commission/contracts?user_id=${ID.com}`)).json();
  assert.equal(mine.user_id, ID.emp);
  assert.deepEqual(mine.items.map((x) => x.id), [cid]);
  assert.equal(mine.can_upload, false);
  assert.equal((await get('emp', '/api/commission/agreement/me')).json().contracts.length, 1);
  // 파일: 본인 200 · 다른 대상자 403 · 재무 403 · 디렉터 200
  const f = await get('emp', `/api/commission/contracts/file/${cid}`);
  assert.equal(f.statusCode, 200);
  assert.equal(f.headers['content-type'], 'application/pdf');
  assert.match(f.body, /contrato emp/);
  assert.match(f.headers['cache-control'], /no-store/);
  assert.equal((await get('com', `/api/commission/contracts/file/${cid}`)).statusCode, 403);
  assert.equal((await get('emp', `/api/commission/contracts/file/${cid2}`)).statusCode, 403);
  assert.equal((await get('fin', `/api/commission/contracts/file/${cid}`)).statusCode, 403);
  assert.equal((await get('dir', `/api/commission/contracts/file/${cid}`)).statusCode, 200);
  // 열람 기록
  const logs = (await query(`SELECT COUNT(*)::int n FROM audit_log WHERE target=$1 AND action='export'`, [`commission_contract:${cid}`])).rows[0].n;
  assert.ok(logs >= 2);
  // 현황판: 디렉터에게만 건수
  const bd = (await get('dir', '/api/commission/agreement/board')).json();
  assert.equal(bd.is_director, true);
  assert.equal(bd.items.find((x) => x.user_id === ID.emp).contracts, 1);
  const bf = (await get('fin', '/api/commission/agreement/board')).json();
  assert.equal(bf.items.find((x) => x.user_id === ID.emp).contracts, undefined);
  // 삭제: 디렉터만 · 소프트 삭제
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/commission/contracts/${cid}`, headers: { authorization: 'Bearer ' + tok.emp } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/commission/contracts/${cid}`, headers: { authorization: 'Bearer ' + tok.dir } })).statusCode, 200);
  assert.equal((await get('emp', '/api/commission/contracts')).json().items.length, 0);
  assert.equal((await get('emp', `/api/commission/contracts/file/${cid}`)).statusCode, 404);
  assert.equal((await query(`SELECT COUNT(*)::int n FROM commission_contracts WHERE id=$1 AND deleted_at IS NOT NULL`, [cid])).rows[0].n, 1, '기록은 남음');
});

test('teardown', { skip: SKIP }, async () => {
  await app.close();
  const { pool } = await import('../src/db.js');
  await pool.end();
});
