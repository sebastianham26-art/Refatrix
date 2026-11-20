// =====================================================================
// 📱 빠른 녹음 → 영업활동 방문 기록 연동 — 실 PostgreSQL + 실 라우트 (2026-11-20 · 0333)
//   V1 위치 있는 빠른 녹음 → 방문 즉시 생성   V2 위치 없으면 보류 → 위치 PATCH 때 생성
//   V3 업체·대상자·직함·연락처 수정 → 방문에도   V4 AI 요약 완료 → 방문 녹음·[AI요약]·펜딩 (재처리 중복 없음)
//   V5 방문 리뷰·방문 목록에 보인다   V6 펜딩 완료 양방향   V7 상담 삭제 → 방문 삭제 · 방문만 삭제 → 안 살아남
//   V8 일반 상담은 방문을 만들지 않는다(회귀)   V9 타 영업사원 격리
//   실행: TEST_PG_URL=postgres://... node --test test/consult_quick_visit.test.mjs
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL;
const SKIP = !PG;
if (SKIP) console.log('[skip] TEST_PG_URL 없음 — 검증 생략');
if (PG) process.env.DATABASE_URL = PG;

let query, pool, mod, sync, app;
const tok = {}; const ID = {};
const TAG = 'CSQV';
const CLEAN = `SELECT id FROM users WHERE login_id LIKE 'csqv%'`;

async function clean() {
  await query(`DELETE FROM sales_visit_pendings WHERE visit_id IN (SELECT id FROM sales_visits WHERE created_by IN (${CLEAN}))`);
  await query(`DELETE FROM sales_visit_recordings WHERE visit_id IN (SELECT id FROM sales_visits WHERE created_by IN (${CLEAN}))`);
  await query(`DELETE FROM sales_consult_recordings WHERE consult_id IN (SELECT id FROM sales_consults WHERE created_by IN (${CLEAN}))`);
  await query(`DELETE FROM sales_consults WHERE created_by IN (${CLEAN})`);
  await query(`DELETE FROM sales_visits WHERE created_by IN (${CLEAN})`);
  await query(`DELETE FROM user_page_access WHERE user_id IN (${CLEAN})`);
  await query(`DELETE FROM audit_log WHERE user_id IN (${CLEAN})`);
  await query(`DELETE FROM users WHERE login_id LIKE 'csqv%'`);
}
async function boot() {
  ({ query, pool } = await import('../src/db.js'));
  mod = await import('../src/routes/consultRoutes.js');
  sync = await import('../src/consultVisitSync.js');
  const visitRoutes = (await import('../src/routes/visitRoutes.js')).default;
  const visitRecRoutes = (await import('../src/routes/visitRecRoutes.js')).default;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await clean();
  const mkUser = async (name, role, login) => Number((await query(
    `INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,'x',$3) RETURNING id`, [name, role, login])).rows[0].id);
  ID.dir = await mkUser(`${TAG}디렉터`, 'director', 'csqv_dir');
  ID.rep = await mkUser(`${TAG}영업A`, 'sales', 'csqv_rep');
  ID.rep2 = await mkUser(`${TAG}영업B`, 'sales', 'csqv_rep2');
  for (const u of [ID.rep, ID.rep2]) {
    await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access) VALUES ($1,'pipeline','anywhere','edit') ON CONFLICT DO NOTHING`, [u]);
  }
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret', sign: { expiresIn: '6h' } });
  await app.register(mod.default);
  await app.register(visitRoutes);
  await app.register(visitRecRoutes);
  await app.ready();
  for (const [k, role] of [['dir', 'director'], ['rep', 'sales'], ['rep2', 'sales']]) tok[k] = app.jwt.sign({ sub: ID[k], role }, { expiresIn: '6h' });
  sync.resetQuickColsCache();
}
const H = (w) => ({ authorization: 'Bearer ' + tok[w] });
const post = (w, url, body) => app.inject({ method: 'POST', url, payload: body, headers: H(w) });
const patch = (w, url, body) => app.inject({ method: 'PATCH', url, payload: body, headers: H(w) });
const del = (w, url) => app.inject({ method: 'DELETE', url, headers: H(w) });
const get = (w, url) => app.inject({ method: 'GET', url, headers: H(w) });
const visit = async (id) => (await query(`SELECT * FROM sales_visits WHERE id=$1`, [id])).rows[0];
const consult = async (id) => (await query(`SELECT * FROM sales_consults WHERE id=$1`, [id])).rows[0];

const SUMMARY = {
  resumen: 'Pidió cotización de amortiguadores para Versa.', insights: 'Compra a KYB hoy.',
  bullets: [{ category: 'precio', text: 'Quiere 10%' }],
  action_items: [{ content: 'Enviar cotización Versa', category: 'precio', due_date: '2026-11-25' },
    { content: 'Llevar muestra', category: 'producto', due_date: null }],
  products: ['CTR-1'], next_step: 'Llamar el lunes',
};
async function summarize(consultId) {
  const rec = Number((await query(
    `INSERT INTO sales_consult_recordings (consult_id, mode, mime, status, transcript, created_by, duration_sec)
     VALUES ($1,'full','audio/webm','summarizing','Hola, necesito amortiguadores.',$2, 300) RETURNING id`, [consultId, ID.rep])).rows[0].id);
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';
  const orig = mod.consultAiApi.summarize;
  mod.consultAiApi.summarize = async () => ({ ok: true, text: JSON.stringify(SUMMARY) });
  try { await mod.processOne((await query(`SELECT * FROM sales_consult_recordings WHERE id=$1`, [rec])).rows[0]); }
  finally { mod.consultAiApi.summarize = orig; }
  return rec;
}

test('boot', { skip: SKIP }, async () => { await boot(); });

test('V1 위치 있는 빠른 녹음 → 방문 기록 즉시 생성', { skip: SKIP }, async () => {
  const r = await post('rep', '/api/consults', { quick: true, geo_lat: 25.68, geo_lng: -100.31, geo_accuracy: 9 });
  assert.equal(r.statusCode, 200, r.body);
  const d = r.json();
  assert.ok(d.visit_id > 0, '방문 id 반환');
  ID.c1 = d.id; ID.v1 = d.visit_id;
  const v = await visit(d.visit_id);
  assert.equal(Number(v.created_by), ID.rep);
  assert.equal(Number(v.geo_lat), 25.68);
  assert.equal(v.place_name, '(업체 미입력)');
  assert.equal(v.deleted_at, null);
  assert.equal(Number((await consult(d.id)).visit_id), d.visit_id);
  assert.equal((await consult(d.id)).quick_rec, true);
});

test('V2 위치 없으면 방문 보류 → 위치 PATCH 때 생성', { skip: SKIP }, async () => {
  const r = await post('rep', '/api/consults', { quick: true });
  assert.equal(r.json().visit_id, null);
  ID.c2 = r.json().id;
  assert.equal((await consult(ID.c2)).visit_id, null);
  const p = await patch('rep', `/api/consults/${ID.c2}`, { geo_lat: 21.0, geo_lng: -89.6, geo_accuracy: 30 });
  assert.equal(p.statusCode, 200, p.body);
  assert.ok(p.json().visit_id > 0);
  const v = await visit(p.json().visit_id);
  assert.equal(Number(v.geo_lat), 21.0);
  // 다시 PATCH 해도 방문이 하나 더 생기지 않는다
  const p2 = await patch('rep', `/api/consults/${ID.c2}`, { contact_name: 'Luis' });
  assert.equal(p2.json().visit_id, p.json().visit_id);
  const n = (await query(`SELECT COUNT(*)::int n FROM sales_visits WHERE created_by=$1 AND deleted_at IS NULL`, [ID.rep])).rows[0].n;
  assert.equal(n, 2);
});

test('V3 업체·대상자·직함·연락처를 넣으면 방문에도 반영', { skip: SKIP }, async () => {
  const p = await patch('rep', `/api/consults/${ID.c1}`, {
    company_name: `${TAG} Refaccionaria Sur`, contact_name: 'Pedro', contact_title: 'Gerente', wa_phone: '8112345678', email: 'p@sur.mx' });
  assert.equal(p.statusCode, 200, p.body);
  const v = await visit(ID.v1);
  assert.equal(v.place_name, `${TAG} Refaccionaria Sur`);
  assert.equal(v.met_person, 'Pedro · Gerente');
  assert.equal(v.contact_phone, '8112345678');
  assert.equal(v.contact_email, 'p@sur.mx');
  assert.equal(Number(v.geo_lat), 25.68, '위치는 그대로');
});

test('V4 AI 요약 완료 → 방문 녹음(done)·[AI요약] 노트·펜딩 / 재처리해도 중복 없음', { skip: SKIP }, async () => {
  const rec = await summarize(ID.c1);
  const vr = (await query(`SELECT * FROM sales_visit_recordings WHERE visit_id=$1`, [ID.v1])).rows;
  assert.equal(vr.length, 1);
  assert.equal(vr[0].status, 'done');
  assert.equal(Number(vr[0].consult_rec_id), rec);
  assert.equal(vr[0].summary_json.resumen, SUMMARY.resumen);
  assert.equal(vr[0].audio_b64, null);
  const v = await visit(ID.v1);
  assert.match(v.talk_note, /\[AI요약\] Pidió cotización/);
  assert.match(v.talk_note, /다음: Llamar el lunes/);
  assert.match(v.insight_note, /\[AI요약\] Compra a KYB/);
  let vp = (await query(`SELECT * FROM sales_visit_pendings WHERE visit_id=$1 ORDER BY id`, [ID.v1])).rows;
  assert.equal(vp.length, 2);
  assert.equal(vp[0].content, 'Enviar cotización Versa');
  assert.ok(vp.every((p) => p.consult_pending_id != null));
  // 재처리(같은 녹음 다시 요약) — 방문 녹음·펜딩이 늘지 않는다
  await query(`UPDATE sales_consult_recordings SET status='summarizing' WHERE id=$1`, [rec]);
  const orig = mod.consultAiApi.summarize;
  mod.consultAiApi.summarize = async () => ({ ok: true, text: JSON.stringify(SUMMARY) });
  try { await mod.processOne((await query(`SELECT * FROM sales_consult_recordings WHERE id=$1`, [rec])).rows[0]); }
  finally { mod.consultAiApi.summarize = orig; }
  assert.equal((await query(`SELECT COUNT(*)::int n FROM sales_visit_recordings WHERE visit_id=$1`, [ID.v1])).rows[0].n, 1);
  vp = (await query(`SELECT * FROM sales_visit_pendings WHERE visit_id=$1`, [ID.v1])).rows;
  assert.equal(vp.length, 2, '펜딩 중복 없음');
  assert.equal(((await visit(ID.v1)).talk_note.match(/\[AI요약\]/g) || []).length, 1, 'AI 블록 하나');
});

test('V5 영업활동 방문 목록·방문 리뷰에 요약·펜딩이 보인다', { skip: SKIP }, async () => {
  const vd = (await query(`SELECT to_char(visit_date,'YYYY-MM-DD') d FROM sales_visits WHERE id=$1`, [ID.v1])).rows[0].d;
  const l = await get('rep', '/api/visits?dates=' + vd);
  assert.equal(l.statusCode, 200, l.body);
  const lv = (l.json().items || l.json().visits || []).find((x) => Number(x.id) === ID.v1);
  assert.ok(lv, '방문 목록에 있음');
  assert.equal(lv.rec_cnt, 1);
  assert.equal(lv.last_rec_status, 'done');
  const rv = await get('rep', '/api/visits/review');
  assert.equal(rv.statusCode, 200, rv.body);
  const all = JSON.stringify(rv.json());
  assert.ok(all.includes('Pidió cotización de amortiguadores'), '리뷰에 AI 요약');
  assert.ok(all.includes('Enviar cotización Versa'), '리뷰에 펜딩');
  const recs = await get('rep', `/api/visits/${ID.v1}/recordings`);
  assert.equal(recs.statusCode, 200, recs.body);
  assert.equal(recs.json().items[0].status, 'done');
});

test('V6 펜딩 완료 체크 — 고객상담 → 방문, 방문 → 고객상담', { skip: SKIP }, async () => {
  const cps = (await query(`SELECT id FROM sales_consult_pendings WHERE consult_id=$1 ORDER BY id`, [ID.c1])).rows.map((r) => Number(r.id));
  const a = await patch('rep', `/api/consults/pendings/${cps[0]}`, { done: true });
  assert.equal(a.statusCode, 200, a.body);
  const vpA = (await query(`SELECT done FROM sales_visit_pendings WHERE consult_pending_id=$1`, [cps[0]])).rows[0];
  assert.equal(vpA.done, true);
  const vpB = (await query(`SELECT id FROM sales_visit_pendings WHERE consult_pending_id=$1`, [cps[1]])).rows[0];
  const b = await patch('rep', `/api/visits/pendings/${vpB.id}`, { done: true });
  assert.equal(b.statusCode, 200, 'visit pending ' + b.body);
  assert.equal((await query(`SELECT done FROM sales_consult_pendings WHERE id=$1`, [cps[1]])).rows[0].done, true);
  // 되돌리기도 양방향
  await patch('rep', `/api/visits/pendings/${vpB.id}`, { done: false });
  assert.equal((await query(`SELECT done FROM sales_consult_pendings WHERE id=$1`, [cps[1]])).rows[0].done, false);
  // 상담에 수기 펜딩 추가 → 방문에도
  const add = await post('rep', `/api/consults/${ID.c1}/pendings`, { content: 'Visitar sucursal', category: 'relacion' });
  assert.equal(add.statusCode, 200, add.body);
  assert.ok((await query(`SELECT 1 FROM sales_visit_pendings WHERE consult_pending_id=$1`, [add.json().id])).rows.length);
});

test('V9 다른 영업사원은 그 방문 펜딩을 못 건드린다', { skip: SKIP }, async () => {
  const vp = (await query(`SELECT id FROM sales_visit_pendings WHERE visit_id=$1 LIMIT 1`, [ID.v1])).rows[0];
  const r = await patch('rep2', `/api/visits/pendings/${vp.id}`, { done: true });
  assert.equal(r.statusCode, 404);
});

test('V8 일반 상담(빠른 녹음 아님)은 위치가 있어도 방문을 만들지 않는다', { skip: SKIP }, async () => {
  const r = await post('rep', '/api/consults', { company_name: `${TAG} Normal`, geo_lat: 25.7, geo_lng: -100.3 });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().visit_id, null);
  assert.equal((await consult(r.json().id)).visit_id, null);
  const s = await sync.syncConsultVisit(r.json().id);
  assert.equal(s.skipped, 'not_quick');
});

test('V7 상담 삭제 → 짝 방문도 삭제 · 방문만 지우면 다시 살아나지 않는다', { skip: SKIP }, async () => {
  const d = await del('rep', `/api/consults/${ID.c2}`);
  assert.equal(d.statusCode, 200, d.body);
  const v2 = (await consult(ID.c2)).visit_id;
  assert.ok((await visit(v2)).deleted_at, '짝 방문 소프트 삭제');
  // c1 의 방문만 영업활동에서 삭제
  const dv = await del('rep', `/api/visits/${ID.v1}`);
  assert.ok([200, 204].includes(dv.statusCode), dv.body);
  const p = await patch('rep', `/api/consults/${ID.c1}`, { contact_name: 'Pedro L.' });
  assert.equal(p.statusCode, 200, p.body);
  assert.ok((await visit(ID.v1)).deleted_at, '되살리지 않음');
  assert.equal((await query(`SELECT COUNT(*)::int n FROM sales_visits WHERE created_by=$1 AND deleted_at IS NULL`, [ID.rep])).rows[0].n, 0, '새 방문도 안 만든다');
});

test('zz 정리', { skip: SKIP }, async () => {
  for (const k of ['__refatrixConsultRecScheduler', '__refatrixConsultPartSweeper', '__refatrixVisitRecScheduler', '__refatrixSalesBriefingScheduler']) {
    if (globalThis[k]) { clearInterval(globalThis[k]); globalThis[k] = null; }
  }
  await clean();
  await app.close();
  await pool.end();
});
