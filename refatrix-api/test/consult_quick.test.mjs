// =====================================================================
// 📱 원클릭 빠른 미팅 녹음 — 실 PostgreSQL + 실 라우트(app.inject) (2026-11-20 · 0333)
//   ① quick:true 는 업체명 없이 만들어진다 → '(업체 미입력)' + info_pending
//   ② 일반 등록은 예전처럼 업체명 필수(회귀)
//   ③ 직함(contact_title) 저장 · 목록에 contact_title/info_pending
//   ④ 업체명 PATCH → info_pending 해제 · 기존 고객 선택(customer_id)도 해제
//   ⑤ 자리표시자를 업체명으로 PATCH 하면 거절 · 빈 업체명 거절
//   ⑥ 나중에 연락처·직함만 넣으면 info_pending 유지
//   ⑦ 0333 미적용 DB(컬럼 없음) — 빠른 등록·목록이 깨지지 않는다(예전 컬럼만 사용)
//   ⑧ 권한 — 다른 영업사원은 남의 빠른 녹음을 고칠 수 없다(404)
//   실행: TEST_PG_URL=postgres://... node --test test/consult_quick.test.mjs
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL;
const SKIP = !PG;
if (SKIP) console.log('[skip] TEST_PG_URL 없음 — 검증 생략');
if (PG) process.env.DATABASE_URL = PG;

let query, pool, consultRoutes, mod, Fastify, jwt, app;
const tok = {};
const ID = {};
const TAG = 'CSQK';

async function boot() {
  ({ query, pool } = await import('../src/db.js'));
  mod = await import('../src/routes/consultRoutes.js');
  consultRoutes = mod.default;
  Fastify = (await import('fastify')).default;
  jwt = (await import('@fastify/jwt')).default;

  await query(`DELETE FROM sales_consult_recordings WHERE consult_id IN (SELECT id FROM sales_consults WHERE created_by IN (SELECT id FROM users WHERE login_id LIKE 'csqk%'))`);
  await query(`DELETE FROM sales_consults WHERE created_by IN (SELECT id FROM users WHERE login_id LIKE 'csqk%')`);
  await query(`DELETE FROM user_page_access WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'csqk%')`);
  await query(`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'csqk%')`);
  await query(`DELETE FROM users WHERE login_id LIKE 'csqk%'`);
  await query(`DELETE FROM customers WHERE name LIKE '${TAG}%' AND id NOT IN (SELECT customer_id FROM sales_consults WHERE customer_id IS NOT NULL)`).catch(() => {});

  const mkUser = async (name, role, login) => Number((await query(
    `INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,'x',$3) RETURNING id`, [name, role, login])).rows[0].id);
  ID.dir = await mkUser(`${TAG}디렉터`, 'director', 'csqk_dir');
  ID.rep = await mkUser(`${TAG}영업A`, 'sales', 'csqk_rep');
  ID.rep2 = await mkUser(`${TAG}영업B`, 'sales', 'csqk_rep2');
  for (const u of [ID.rep, ID.rep2]) {
    await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access)
                 VALUES ($1,'pipeline','anywhere','edit') ON CONFLICT DO NOTHING`, [u]);
  }
  try {
    ID.cust = Number((await query(`INSERT INTO customers (code, name) VALUES ($1, $2) RETURNING id`, [`${TAG}-C1`, `${TAG} Refaccionaria Águila`])).rows[0].id);
  } catch (e) { ID.cust = null; console.log('[note] customers insert skipped:', e.message); }

  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret', sign: { expiresIn: '6h' } });
  await app.register(consultRoutes);
  await app.ready();
  tok.dir = app.jwt.sign({ sub: ID.dir, role: 'director' }, { expiresIn: '6h' });
  tok.rep = app.jwt.sign({ sub: ID.rep, role: 'sales' }, { expiresIn: '6h' });
  tok.rep2 = app.jwt.sign({ sub: ID.rep2, role: 'sales' }, { expiresIn: '6h' });
}
const H = (who) => ({ authorization: 'Bearer ' + tok[who] });
const post = (who, url, body) => app.inject({ method: 'POST', url, payload: body, headers: H(who) });
const patch = (who, url, body) => app.inject({ method: 'PATCH', url, payload: body, headers: H(who) });
const get = (who, url) => app.inject({ method: 'GET', url, headers: H(who) });
const row = async (id) => (await query(`SELECT * FROM sales_consults WHERE id=$1`, [id])).rows[0];
const listItem = async (who, id) => (await get(who, '/api/consults')).json().items.find((x) => x.id === id);

test('boot', { skip: SKIP }, async () => { await boot(); mod.resetQuickColsCache(); });

test('① quick:true — 업체명 없이 바로 만들어지고 info_pending · 위치 저장', { skip: SKIP }, async () => {
  const r = await post('rep', '/api/consults', { quick: true, geo_lat: 25.68, geo_lng: -100.31, geo_accuracy: 14 });
  assert.equal(r.statusCode, 200, r.body);
  const d = r.json();
  assert.ok(d.id > 0);
  assert.equal(d.company_name, mod.QUICK_PLACEHOLDER);
  assert.equal(d.info_pending, true);
  ID.q1 = d.id;
  const x = await row(d.id);
  assert.equal(x.company_name, '(업체 미입력)');
  assert.equal(x.info_pending, true);
  assert.equal(Number(x.geo_lat), 25.68);
  assert.equal(Number(x.created_by), ID.rep);
  const it = await listItem('rep', d.id);
  assert.equal(it.info_pending, true, '목록에 정보 입력 필요 표시');
  assert.equal(it.contact_title, null);
});

test('② 일반 등록은 여전히 업체명 필수 (회귀)', { skip: SKIP }, async () => {
  const r = await post('rep', '/api/consults', { company_name: '' });
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().error, 'company_required');
  const r2 = await post('rep', '/api/consults', { company_name: mod.QUICK_PLACEHOLDER });
  assert.equal(r2.statusCode, 400, '자리표시자 문자열을 업체명으로 보내도 일반 등록은 거절');
  const ok = await post('rep', '/api/consults', { company_name: `${TAG} Normal`, contact_name: 'Juan', contact_title: 'Compras' });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().info_pending, false);
  const x = await row(ok.json().id);
  assert.equal(x.info_pending, false);
  assert.equal(x.contact_title, 'Compras');
});

test('③ quick 에 입력해 둔 값이 있으면 함께 저장 (업체명 있으면 pending 아님)', { skip: SKIP }, async () => {
  const r = await post('rep', '/api/consults', { quick: true, company_name: `${TAG} Rápida`, contact_name: 'Ana', contact_title: 'Dueña', wa_phone: '8112345678' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().info_pending, false);
  const it = await listItem('rep', r.json().id);
  assert.equal(it.company_name, `${TAG} Rápida`);
  assert.equal(it.contact_title, 'Dueña');
  assert.equal(it.wa_phone, '8112345678');
});

test('⑥ 나중에 대상자·직함·연락처만 넣으면 여전히 정보 입력 필요', { skip: SKIP }, async () => {
  const r = await patch('rep', `/api/consults/${ID.q1}`, { contact_name: 'Pedro', contact_title: 'Gerente', wa_phone: '81 2222 3333' });
  assert.equal(r.statusCode, 200, r.body);
  const x = await row(ID.q1);
  assert.equal(x.contact_name, 'Pedro');
  assert.equal(x.contact_title, 'Gerente');
  assert.equal(x.info_pending, true);
});

test('⑤ 자리표시자·빈 업체명 PATCH 는 거절', { skip: SKIP }, async () => {
  const a = await patch('rep', `/api/consults/${ID.q1}`, { company_name: mod.QUICK_PLACEHOLDER });
  assert.equal(a.statusCode, 400);
  const b = await patch('rep', `/api/consults/${ID.q1}`, { company_name: '  ' });
  assert.equal(b.statusCode, 400);
  assert.equal((await row(ID.q1)).info_pending, true);
});

test('⑧ 다른 영업사원은 남의 빠른 녹음을 고칠 수 없다', { skip: SKIP }, async () => {
  const r = await patch('rep2', `/api/consults/${ID.q1}`, { company_name: 'X' });
  assert.equal(r.statusCode, 404);
  assert.equal((await listItem('rep2', ID.q1)), undefined, '목록에도 안 보인다');
});

test('④ 업체명을 넣으면 정보 입력 필요 해제 · 고객 선택만으로도 해제', { skip: SKIP }, async () => {
  const r = await patch('rep', `/api/consults/${ID.q1}`, { company_name: `${TAG} Llantera Sur` });
  assert.equal(r.statusCode, 200, r.body);
  const x = await row(ID.q1);
  assert.equal(x.company_name, `${TAG} Llantera Sur`);
  assert.equal(x.info_pending, false);
  assert.equal((await listItem('dir', ID.q1)).info_pending, false, '디렉터 목록에서도 해제');

  if (ID.cust) {
    const q2 = (await post('rep', '/api/consults', { quick: 1 })).json().id;
    const p = await patch('rep', `/api/consults/${q2}`, { customer_id: ID.cust });
    assert.equal(p.statusCode, 200, p.body);
    const y = await row(q2);
    assert.equal(Number(y.customer_id), ID.cust);
    assert.equal(y.info_pending, false);
  }
});

test('④-b AI 요약 프롬프트에는 자리표시자가 업체명으로 들어가지 않는다', { skip: SKIP }, async () => {
  const q3 = (await post('rep', '/api/consults', { quick: true })).json().id;
  const rec = Number((await query(
    `INSERT INTO sales_consult_recordings (consult_id, mode, mime, status, transcript, created_by)
     VALUES ($1,'full','audio/webm','summarizing','Hola, necesito balatas para Versa.',$2) RETURNING id`, [q3, ID.rep])).rows[0].id);
  const prompts = [];
  const orig = { ...mod.consultAiApi };
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';
  mod.consultAiApi.summarize = async (p) => { prompts.push(p); return { ok: true, text: JSON.stringify({ resumen: 'ok', bullets: [], action_items: [], products: [] }) }; };
  try {
    const r = (await query(`SELECT * FROM sales_consult_recordings WHERE id=$1`, [rec])).rows[0];
    await mod.processOne(r);
  } finally { Object.assign(mod.consultAiApi, orig); }
  assert.ok(prompts.length >= 1, '요약 호출됨');
  assert.ok(!prompts[0].includes('(업체 미입력)'), '자리표시자가 프롬프트에 없다');
  assert.match(prompts[0], /업체명: 미상/);
  const st = (await query(`SELECT status FROM sales_consult_recordings WHERE id=$1`, [rec])).rows[0].status;
  assert.equal(st, 'done');
});

test('⑦ 0333 미적용 DB — 빠른 등록·목록이 깨지지 않는다', { skip: SKIP }, async () => {
  await query(`ALTER TABLE sales_consults RENAME COLUMN info_pending TO info_pending_x`);
  mod.resetQuickColsCache();
  try {
    const r = await post('rep', '/api/consults', { quick: true, contact_title: '무시됨' });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().company_name, mod.QUICK_PLACEHOLDER);
    const l = await get('rep', '/api/consults');
    assert.equal(l.statusCode, 200, l.body);
    const it = l.json().items.find((x) => x.id === r.json().id);
    assert.ok(it, '목록에 보인다');
    assert.equal(it.info_pending, false, '컬럼이 없으면 false — 화면은 자리표시자로 판단');
    const p = await patch('rep', `/api/consults/${r.json().id}`, { company_name: `${TAG} Pre`, contact_title: 'x' });
    assert.equal(p.statusCode, 200, p.body);
    const n = await post('rep', '/api/consults', { company_name: `${TAG} Pre2` });
    assert.equal(n.statusCode, 200, n.body);
  } finally {
    await query(`ALTER TABLE sales_consults RENAME COLUMN info_pending_x TO info_pending`);
    mod.resetQuickColsCache();
  }
  assert.equal(await mod.hasQuickCols(), true, '되돌리면 다시 인식');
});

test('zz 정리', { skip: SKIP }, async () => {
  for (const k of ['__refatrixConsultRecScheduler', '__refatrixConsultPartSweeper']) {
    if (globalThis[k]) { clearInterval(globalThis[k]); globalThis[k] = null; }
  }
  await query(`DELETE FROM sales_consults WHERE created_by IN (SELECT id FROM users WHERE login_id LIKE 'csqk%')`);
  await query(`DELETE FROM customers WHERE name LIKE '${TAG}%'`).catch(() => {});
  await app.close();
  await pool.end();
});
