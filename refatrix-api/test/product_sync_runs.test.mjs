// 20260924 · 전송 단위(실행 1회)별 성과 — 어제 전송과 오늘 전송을 섞지 않는다.
//
//   실행: TEST_PG_URL=postgres://... node --test --test-concurrency=1 test/product_sync_runs.test.mjs
//   ⚠ 다른 제품 스위트와 같은 표를 쓴다 — 직렬로.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;

const { runView } = await import('../src/productSync.js');

test('runView — 진행 중: 경과는 지금까지, 성공률은 중지 제외 대상 기준', () => {
  const t0 = Date.parse('2026-09-24T21:10:00Z');
  const v = runView({
    id: '10', envio_id: 'CAT-2026-09-24-2', fecha_corte: '2026-09-24', mode: 'full', origin: 'manual',
    total_productos: '100', total_lotes: '100', batch_size: '500',
    created_at: new Date(t0).toISOString(), last_sent_at: new Date(t0 + 60000).toISOString(),
    pending: '40', retrying: '3', sent: '55', failed: '5', skipped: '0', stopped: '0',
  }, t0 + 120000);
  assert.equal(v.state, 'running');
  assert.equal(v.elapsed_sec, 120, '진행 중이면 지금까지');
  assert.equal(v.per_min, 28);                 // 55건 / 2분
  assert.equal(v.success_pct, 55);
  assert.equal(v.progress_pct, 60);
  assert.equal(v.retrying, 3);
});

test('runView — 중지된 실행: 성공률에서 중지 건을 뺀다, 소요는 마지막 전송까지', () => {
  const t0 = Date.parse('2026-09-24T17:03:00Z');
  const v = runView({
    id: 9, envio_id: 'CAT-2026-09-24', fecha_corte: '2026-09-24', mode: 'full', origin: 'auto',
    total_productos: 1000, total_lotes: 1000, batch_size: 500,
    created_at: new Date(t0).toISOString(), last_sent_at: new Date(t0 + 600000).toISOString(),
    pending: 0, retrying: 0, sent: 580, failed: 20, skipped: 400, stopped: 400,
  }, t0 + 99999999);
  assert.equal(v.state, 'stopped');
  assert.equal(v.elapsed_sec, 600, '끝난 실행의 소요는 지금이 아니라 마지막 전송까지');
  assert.equal(v.success_pct, 96.7);           // 580 / (1000 − 400)
  assert.equal(v.progress_pct, 100);
});

test('runView — 완료/실패 있음/전송 전', () => {
  const base = { id: 1, envio_id: 'X', fecha_corte: '2026-09-23', total_lotes: 10, total_productos: 10, created_at: '2026-09-23T12:00:00Z' };
  assert.equal(runView({ ...base, sent: 10, last_sent_at: '2026-09-23T12:00:05Z' }).state, 'done');
  assert.equal(runView({ ...base, sent: 9, failed: 1, last_sent_at: '2026-09-23T12:00:05Z' }).state, 'done_errors');
  const z = runView({ ...base, total_lotes: 0 });
  assert.equal(z.success_pct, null);
  assert.equal(z.per_min, null);
});

const dbTest = PG ? test : test.skip;

dbTest('listRuns · runErrors — 실행마다 따로 센다 (실 PostgreSQL)', async () => {
  const { query } = await import('../src/db.js');
  const { listRuns, runErrors, CANCEL_NOTE } = await import('../src/productSync.js');
  await query(`DELETE FROM crm_customer_outbox WHERE entity='product'`);
  await query(`DELETE FROM product_sync_runs`);
  const mk = async (envio, day, n) => Number((await query(
    `INSERT INTO product_sync_runs (envio_id, fecha_corte, mode, origin, total_productos, total_lotes, batch_size, created_at)
     VALUES ($1,$2,'full','manual',$3,$3,500, ($2::date + time '10:00') AT TIME ZONE 'America/Mexico_City') RETURNING id`,
    [envio, day, n])).rows[0].id);
  const put = async (runId, status, extra = {}) => query(
    `INSERT INTO crm_customer_outbox (customer_id, entity, entity_id, entity_label, endpoint_key, op, origin, payload, status,
                                      attempts, http_status, last_error, sent_at, created_at)
     VALUES (NULL,'product',$1,$2,'product','upsert','product_full','{}',$3,$4,$5,$6,$7, now())`,
    [runId, extra.label || 'x', status, extra.attempts || 0, extra.http || null, extra.err || null, extra.sent_at || null]);

  const yest = await mk('CAT-2026-09-23', '2026-09-23', 5);
  const today = await mk('CAT-2026-09-24', '2026-09-24', 6);
  for (let i = 0; i < 5; i++) await put(yest, 'sent', { sent_at: '2026-09-23T16:00:0' + i + 'Z' });
  await put(today, 'sent', { sent_at: new Date().toISOString() });
  await put(today, 'sent', { sent_at: new Date().toISOString() });
  await put(today, 'failed', { attempts: 6, http: 400, err: 'JSON de solicitud no valido', label: 'CAT · 3/6 · CA0001' });
  await put(today, 'pending', { attempts: 2, http: 400, err: 'No existe prefijo de clase CC', label: 'CAT · 4/6 · CC0001' });
  await put(today, 'pending');
  await put(today, 'skipped', { err: CANCEL_NOTE });

  const runs = await listRuns({ limit: 5 });
  const y = runs.find((r) => r.id === yest), t = runs.find((r) => r.id === today);
  assert.equal(runs[0].id, today, '최신 실행이 먼저');
  assert.deepEqual([y.sent, y.failed, y.pending, y.state], [5, 0, 0, 'done'], '어제 실행은 어제 것만');
  assert.deepEqual([t.sent, t.failed, t.pending, t.retrying, t.stopped], [2, 1, 2, 1, 1], '오늘 실행은 오늘 것만');
  assert.equal(t.state, 'running');
  assert.equal(t.success_pct, 40);               // 2 / (6 − 1)
  assert.equal(y.elapsed_sec >= 0, true);

  const errs = await runErrors(today);
  assert.equal(errs.length, 2, '실패 확정 + 재시도 대기만 (정상 대기·중지는 제외)');
  assert.ok(errs.some((e) => e.status === 'failed' && /JSON/.test(e.reason) && e.http_status === 400));
  assert.ok(errs.some((e) => e.status === 'pending' && /prefijo/.test(e.reason) && e.example === 'CAT · 4/6 · CC0001'));
  assert.equal((await runErrors(yest)).length, 0);

  await query(`DELETE FROM crm_customer_outbox WHERE entity='product'`);
  await query(`DELETE FROM product_sync_runs`);
});

test.after(async () => {
  if (PG) { const { pool } = await import('../src/db.js'); await pool.end().catch(() => {}); }
});
