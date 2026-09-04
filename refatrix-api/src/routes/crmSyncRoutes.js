// CRM 전송 이력 — 디렉터 전용.
//   전송이 실패했는데 아무도 모르는 상황을 막는 화면의 뒷단이다.
//   조회 · 재전송 · 수동 전송 · 즉시 드레인. 연동 설정·계약서는 integrationRoutes.js.
import { query } from '../db.js';
import { authGuard, requireDirector } from '../middleware/authGuard.js';
import { crmTableReady, drainOutbox, enqueueCustomerSync, crmStatus, MAX_ATTEMPTS } from '../crmSync.js';

// 0203 인증 추적 컬럼(있을 때만 조회에 싣는다)
let hasAuthCols = false;
let authProbe = 0;
async function authCols() {
  if (hasAuthCols) return true;
  if (Date.now() - authProbe < 30000) return false;
  authProbe = Date.now();
  try {
    const r = await query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name='crm_customer_outbox' AND column_name='auth_sent' LIMIT 1`);
    hasAuthCols = r.rows.length > 0;
  } catch (_) { hasAuthCols = false; }
  return hasAuthCols;
}

// 0201 이전 DB(엔드포인트 컬럼 없음)에서도 조회가 죽지 않게 확인한다.
//   없을 때만 30초마다 다시 본다 — 서버 기동 후 migrate 해도 재시작 없이 반영되도록.
let hasEpCols = false;
let epProbe = 0;
async function epCols() {
  if (hasEpCols) return true;
  if (Date.now() - epProbe < 30000) return false;
  epProbe = Date.now();
  try {
    const r = await query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name='crm_customer_outbox' AND column_name='endpoint_key' LIMIT 1`);
    hasEpCols = r.rows.length > 0;
  } catch (_) { hasEpCols = false; }
  return hasEpCols;
}

export default async function crmSyncRoutes(app) {
  const guard = { preHandler: [authGuard, requireDirector] };

  async function ready(reply) {
    if (await crmTableReady()) return true;
    reply.code(503).send({ error: 'migration_required', note: '0200_crm_customer_outbox 마이그레이션이 필요합니다.' });
    return false;
  }

  // 요약(전체 · 연동별)
  app.get('/api/crm-sync/summary', guard, async () => {
    const engine = crmStatus();
    if (!(await crmTableReady())) return { engine, migrated: false, counts: {}, by_endpoint: {}, oldest_pending: null };
    const ep = await epCols();
    const keyExpr = ep ? `COALESCE(endpoint_key,'customer_commercial')` : `'customer_commercial'`;
    const rows = (await query(
      `SELECT ${keyExpr} AS k, status, count(*)::int AS n FROM crm_customer_outbox GROUP BY 1,2`)).rows;
    const counts = { pending: 0, sent: 0, failed: 0, skipped: 0 };
    const byEp = {};
    for (const r of rows) {
      counts[r.status] = (counts[r.status] || 0) + Number(r.n);
      byEp[r.k] = byEp[r.k] || { pending: 0, sent: 0, failed: 0, skipped: 0 };
      byEp[r.k][r.status] = Number(r.n);
    }
    const oldest = (await query(
      `SELECT min(created_at) AS t FROM crm_customer_outbox WHERE status='pending'`)).rows[0];
    return { engine, migrated: true, counts, by_endpoint: byEp, oldest_pending: oldest.t || null };
  });

  // 목록 — status(open|pending|sent|failed|skipped|all) · endpoint · q 검색
  app.get('/api/crm-sync', guard, async (req, reply) => {
    if (!(await ready(reply))) return;
    const ep = await epCols();
    const au = await authCols();
    const st = String(req.query.status || 'open');
    const key = String(req.query.endpoint || '').trim();
    const q = String(req.query.q || '').trim();
    const limit = Math.min(Number(req.query.limit || 100), 300);
    const where = [];
    const params = [];
    if (st === 'open') where.push(`o.status IN ('pending','failed')`);
    else if (['pending', 'sent', 'failed', 'skipped'].includes(st)) { params.push(st); where.push(`o.status=$${params.length}`); }
    if (key && ep) { params.push(key); where.push(`COALESCE(o.endpoint_key,'customer_commercial')=$${params.length}`); }
    if (q) {
      params.push(`%${q}%`);
      const i = params.length;
      where.push(`(c.code ILIKE $${i} OR c.name ILIKE $${i} OR o.rfc ILIKE $${i}${ep ? ` OR o.entity_label ILIKE $${i}` : ''})`);
    }
    params.push(limit);
    const authSel = au ? `o.auth_sent, o.auth_header,` : `NULL::boolean AS auth_sent, NULL::text AS auth_header,`;
    const extra = ep
      ? `COALESCE(o.endpoint_key,'customer_commercial') AS endpoint_key, o.entity, o.entity_id, o.entity_label, o.env, o.url, o.request_method,`
      : `'customer_commercial' AS endpoint_key, 'customer' AS entity, o.customer_id AS entity_id,
         NULL::text AS entity_label, NULL::text AS env, NULL::text AS url, NULL::text AS request_method,`;
    const rows = (await query(
      `SELECT o.id, o.customer_id, ${extra} ${authSel}
              o.op, o.origin, o.rfc, o.payload, o.status, o.attempts,
              o.next_attempt_at, o.http_status, o.codigo_error, o.last_error, o.response,
              o.created_at, o.sent_at,
              c.code AS customer_code, c.name AS customer_name,
              u.name AS acted_by_name
         FROM crm_customer_outbox o
         LEFT JOIN customers c ON c.id=o.customer_id
         LEFT JOIN users u ON u.id=o.acted_by
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY o.id DESC LIMIT $${params.length}`, params)).rows;
    return {
      max_attempts: MAX_ATTEMPTS,
      items: rows.map((r) => ({
        id: Number(r.id),
        endpoint_key: r.endpoint_key, entity: r.entity,
        entity_id: r.entity_id == null ? null : Number(r.entity_id),
        customer_id: r.customer_id == null ? null : Number(r.customer_id),
        customer_code: r.customer_code, customer_name: r.customer_name || r.entity_label,
        op: r.op, origin: r.origin, rfc: r.rfc, payload: r.payload,
        status: r.status, attempts: Number(r.attempts),
        next_attempt_at: r.next_attempt_at,
        http_status: r.http_status == null ? null : Number(r.http_status),
        codigo_error: r.codigo_error, last_error: r.last_error, response: r.response,
        env: r.env, url: r.url, request_method: r.request_method,
        auth_sent: r.auth_sent, auth_header: r.auth_header,
        created_at: r.created_at, sent_at: r.sent_at, acted_by_name: r.acted_by_name,
      })),
    };
  });

  // 고객별 최근 전송 이력(고객 상세에서 쓸 수 있게 열어 둔다)
  app.get('/api/crm-sync/customers/:id', guard, async (req, reply) => {
    if (!(await ready(reply))) return;
    const rows = (await query(
      `SELECT id, op, origin, status, attempts, http_status, codigo_error, last_error, created_at, sent_at
         FROM crm_customer_outbox WHERE customer_id=$1 ORDER BY id DESC LIMIT 20`,
      [Number(req.params.id)])).rows;
    return { items: rows };
  });

  // 재전송 — failed/skipped 건을 다시 대기로 되돌린다(시도횟수 초기화).
  app.post('/api/crm-sync/:id/retry', guard, async (req, reply) => {
    if (!(await ready(reply))) return;
    const id = Number(req.params.id);
    const row = (await query(`SELECT id, status FROM crm_customer_outbox WHERE id=$1`, [id])).rows[0];
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (row.status === 'sent') return reply.code(409).send({ error: 'already_sent' });
    await query(
      `UPDATE crm_customer_outbox
          SET status='pending', attempts=0, next_attempt_at=now(), last_error=NULL WHERE id=$1`, [id]);
    // 마침 워커가 돌고 있으면(busy) 잠깐 기다렸다 한 번 더 — 화면에 "안 나갔다"고 잘못 뜨는 것을 막는다.
    let out = await drainOutbox({ app, limit: 5 });
    if (out.busy) {
      await new Promise((r) => setTimeout(r, 400));
      out = await drainOutbox({ app, limit: 5 });
    }
    const after = (await query(`SELECT status, last_error, http_status FROM crm_customer_outbox WHERE id=$1`, [id])).rows[0];
    return { ok: true, id, result: after, drain: out };
  });

  // 특정 고객을 지금 상태 그대로 다시 보낸다(초기 이관·수동 대조용).
  app.post('/api/crm-sync/customers/:id/resend', guard, async (req, reply) => {
    if (!(await ready(reply))) return;
    const id = Number(req.params.id);
    const c = (await query(`SELECT id FROM customers WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!c) return reply.code(404).send({ error: 'not_found' });
    const r = await enqueueCustomerSync(id, 'upsert', { origin: 'manual_resend', actorUserId: req.ctx.perm.userId, app });
    return { ok: !!r.ok, ...r };
  });

  // 대기분 즉시 밀기
  app.post('/api/crm-sync/drain', guard, async (_req, reply) => {
    if (!(await ready(reply))) return;
    const out = await drainOutbox({ app, limit: 50 });
    return { ok: true, ...out };
  });
}
