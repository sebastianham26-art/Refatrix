// =====================================================================
// 2026-09-29 · 전송 이력 「실패 건 재전송」 — POST /api/crm-sync/retry-failed
// 실행: DATABASE_URL=postgres://.../빈DB node --test --experimental-test-module-mocks test/crm_retry_failed.test.mjs
// =====================================================================
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONN = process.env.DATABASE_URL || '';
const skip = !CONN;

const STUB = `
DROP TABLE IF EXISTS crm_customer_outbox, customers, audit_log;
CREATE TABLE customers (id BIGSERIAL PRIMARY KEY, code TEXT, name TEXT);
CREATE TABLE audit_log (id BIGSERIAL PRIMARY KEY, user_id BIGINT, action TEXT, target TEXT, detail JSONB);
CREATE TABLE crm_customer_outbox (
  id BIGSERIAL PRIMARY KEY, customer_id BIGINT, entity TEXT, entity_id BIGINT, entity_label TEXT,
  endpoint_key TEXT, op TEXT NOT NULL DEFAULT 'upsert', origin TEXT, rfc TEXT, payload JSONB,
  status TEXT NOT NULL, attempts INT DEFAULT 0, next_attempt_at TIMESTAMPTZ DEFAULT now(),
  last_error TEXT, http_status INT, codigo_error TEXT, created_at TIMESTAMPTZ DEFAULT now(), sent_at TIMESTAMPTZ,
  response JSONB, env TEXT, url TEXT, request_method TEXT);
INSERT INTO customers (id, code, name) VALUES (1,'C001','ALFA'),(2,'C002','BETA'),(3,'C003','GAMA');
INSERT INTO crm_customer_outbox (id, customer_id, entity, entity_id, endpoint_key, op, status, attempts, last_error, entity_label) VALUES
 -- 고객: 1 은 실패만 → 재전송 · 2 는 실패 뒤 새 값이 이미 나감 → 제외 · 3 은 건너뜀 → 대상 아님
 (1, 1, 'customer', 1, 'customer_commercial', 'upsert', 'failed', 6, 'HTTP 500', NULL),
 (2, 2, 'customer', 2, 'customer_commercial', 'upsert', 'failed', 6, 'timeout', NULL),
 (3, 2, 'customer', 2, 'customer_commercial', 'upsert', 'sent',   1, NULL, NULL),
 (4, 3, 'customer', 3, 'customer_commercial', 'upsert', 'skipped',1, 'ERR_VALIDATION', NULL),
 -- 제품: 회차 10(옛)·11(최신) — 최신 회차의 실패 묶음만
 (5, NULL, 'product', 10, 'product', 'upsert', 'failed', 6, 'HTTP 502', 'ENV-10 · 1/2'),
 (6, NULL, 'product', 11, 'product', 'upsert', 'failed', 6, 'HTTP 502', 'ENV-11 · 1/2'),
 (7, NULL, 'product', 11, 'product', 'upsert', 'sent',   1, NULL,       'ENV-11 · 2/2'),
 -- 오더: 같은 오더의 더 나중 단계가 대기 중이면 옛 단계는 다시 보내지 않는다
 (8, NULL, 'order', 77, 'order_status', 'upsert', 'failed', 6, 'HTTP 500', 'COT-77 · 접수'),
 (9, NULL, 'order', 77, 'order_status', 'upsert', 'pending',0, NULL,       'COT-77 · 출고');
SELECT setval('crm_customer_outbox_id_seq', 100);
`;

let app = null, pool = null, drains = 0;
async function boot() {
  if (app) return app;
  const pg = (await import('pg')).default;
  pool = new pg.Pool({ connectionString: CONN });
  await pool.query(STUB);
  mock.module(resolve(HERE, '../src/middleware/authGuard.js'), { namedExports: {
    authGuard: async (req) => { req.ctx = { perm: { role: 'director', userId: 1, pageAccess: {} }, isRegistered: true }; },
    requirePage: () => async () => {}, requirePageAny: () => async () => {}, requirePageEdit: () => async () => {},
    requirePageEditAny: () => async () => {}, requireDirector: (r, p, d) => d() } });
  // 실제 전송은 하지 않는다 — 적재(대기로 되돌림)까지만 본다.
  mock.module(resolve(HERE, '../src/crmSync.js'), { namedExports: {
    crmTableReady: async () => true, crmStatus: () => ({}), MAX_ATTEMPTS: 6,
    enqueueCustomerSync: async () => ({ ok: true }), scheduleDrain: () => {},
    drainOutbox: async () => { drains++; return { drained: 0, sent: 0, failed: 0, held: 0 }; } } });
  const Fastify = (await import('fastify')).default;
  app = Fastify();
  app.register((await import('../src/routes/crmSyncRoutes.js')).default);
  await app.ready();
  return app;
}
const status = async (id) => (await pool.query('SELECT status, attempts, last_error FROM crm_customer_outbox WHERE id=$1', [id])).rows[0];

test('DB ① 미리 세기(dry_run) — 옛 값·건너뜀은 빼고 센다, 아무것도 바꾸지 않는다', { skip }, async () => {
  const a = await boot();
  const r = (await a.inject({ method: 'POST', url: '/api/crm-sync/retry-failed',
    payload: { endpoint: 'customer_commercial', dry_run: true } })).json();
  assert.equal(r.count, 1); assert.equal(r.superseded, 1); assert.deepEqual(r.sample, ['C001 ALFA']);
  assert.equal((await status(1)).status, 'failed');
});

test('DB ② 고객 — 실패 1건만 대기로 되돌리고 시도 횟수를 초기화', { skip }, async () => {
  const a = await boot();
  const r = (await a.inject({ method: 'POST', url: '/api/crm-sync/retry-failed',
    payload: { endpoint: 'customer_commercial' } })).json();
  assert.equal(r.queued, 1); assert.equal(r.superseded, 1);
  assert.deepEqual(await status(1), { status: 'pending', attempts: 0, last_error: null });
  assert.equal((await status(2)).status, 'failed', '뒤에 새 값이 나간 건은 그대로');
  assert.equal((await status(4)).status, 'skipped', '건너뜀은 대상 아님');
  assert.ok(drains > 0, '바로 전송을 시도한다');
  const au = (await pool.query(`SELECT detail FROM audit_log ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.equal(au.detail.op, 'crm_retry_failed');
});

test('DB ③ 제품 — 최신 전송 회차의 실패 묶음만 · 다른 연동은 건드리지 않음', { skip }, async () => {
  const a = await boot();
  const r = (await a.inject({ method: 'POST', url: '/api/crm-sync/retry-failed', payload: { endpoint: 'product' } })).json();
  assert.equal(r.queued, 1); assert.equal(r.superseded, 1);
  assert.equal((await status(6)).status, 'pending');
  assert.equal((await status(5)).status, 'failed');
  assert.equal((await status(8)).status, 'failed', '오더 연동은 그대로');
});

test('DB ④ 오더 — 같은 오더의 더 나중 단계가 있으면 옛 단계는 제외 · 회차 범위(run_id) 적용', { skip }, async () => {
  const a = await boot();
  const r = (await a.inject({ method: 'POST', url: '/api/crm-sync/retry-failed', payload: { endpoint: 'order_status' } })).json();
  assert.equal(r.queued, 0); assert.equal(r.superseded, 1);
  await pool.query(`UPDATE crm_customer_outbox SET status='failed' WHERE id=6`);
  const r2 = (await a.inject({ method: 'POST', url: '/api/crm-sync/retry-failed',
    payload: { endpoint: 'product', run_id: '10', dry_run: true } })).json();
  assert.equal(r2.count, 0, '회차 10 은 옛 회차라 0'); assert.equal(r2.superseded, 1);
});


test('DB ⑤ 실패·대기 내려받기 — 범위·사유 묶음·원문 포함, 완료/건너뜀 제외', { skip }, async () => {
  const a = await boot();
  await pool.query(`UPDATE crm_customer_outbox SET payload='{"ctrCode":"CE0001","existencia":0}', response='{"codigoError":"ERR_X","mensaje":"bad"}',
                      http_status=400, codigo_error='ERR_X' WHERE id=5`);
  const r = (await a.inject({ method: 'GET', url: '/api/crm-sync/export?endpoint=product' })).json();
  assert.equal(r.ok, true);
  assert.deepEqual(r.items.map((x) => [x.id, x.status]).sort(), [[5, 'failed'], [6, 'failed']].sort());
  assert.equal(r.counts.failed, 2); assert.equal(r.counts.pending, 0);
  const it5 = r.items.find((x) => x.id === 5);
  assert.equal(it5.payload.existencia, 0); assert.equal(it5.response.codigoError, 'ERR_X'); assert.equal(it5.reference, 'ENV-10 · 1/2');
  assert.ok(r.groups.length >= 1 && r.groups[0].count >= 1);
  // 오더: 대기 + 실패 둘 다
  const o = (await a.inject({ method: 'GET', url: '/api/crm-sync/export?endpoint=order_status' })).json();
  assert.deepEqual(o.items.map((x) => x.status).sort(), ['failed', 'pending']);
  // 회차 범위
  const s1 = (await a.inject({ method: 'GET', url: '/api/crm-sync/export?endpoint=product&run_id=11' })).json();
  assert.deepEqual(s1.items.map((x) => x.id), [6]);
  const au = (await pool.query(`SELECT detail FROM audit_log ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.equal(au.detail.op, 'crm_sync_export');
});

test('화면 — 실패·대기 엑셀 버튼 · 스페인어 머리글 · 같은 범위', () => {
  const html = readFileSync(resolve(HERE, '../../refatrix-integrations.html'), 'utf8');
  assert.match(html, /id="btnExportOpen"/);
  assert.match(html, /\/api\/crm-sync\/export\?/);
  assert.match(html, /'Cuerpo enviado \(JSON\)'/);
  assert.match(html, /function exportOpen\(\)[\s\S]*scopeBody\(\)/);
  assert.match(html, /build 20261006xl/);
});

test('화면 — 버튼 · 목록과 같은 범위로 요청 · 빌드 토큰', () => {
  const html = readFileSync(resolve(HERE, '../../refatrix-integrations.html'), 'utf8');
  assert.match(html, /id="btnRetryFailed"[^>]*>실패 건 재전송</);
  assert.match(html, /\/api\/crm-sync\/retry-failed/);
  assert.match(html, /function scopeBody\(\)/);
  assert.match(html, /build 20260929(rf|dl|promo)|build 20261006(ex|xl)/);
});

test.after(async () => { if (app) await app.close(); if (pool) await pool.end(); });
