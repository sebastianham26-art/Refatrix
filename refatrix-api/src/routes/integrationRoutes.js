// 연동 관리(디렉터 전용) — URL·계약서·인증을 화면에서 고치고, 연결을 시험한다.
//   전송 이력 조회·재전송은 crmSyncRoutes.js.
import { query } from '../db.js';
import { authGuard, requireDirector } from '../middleware/authGuard.js';
import {
  endpointsReady, listEndpoints, getEndpoint, publicEndpoint,
  saveEndpoint, createEndpoint, activeUrl, invalidateEndpointCache,
  activeToken,
} from '../integrations.js';
import { sendPayload, isSuccess, crmStatus } from '../crmSync.js';

const ERR_NOTE = {
  env_invalid: '환경은 test 또는 prod 만 됩니다.',
  method_invalid: '메서드는 POST · PUT · PATCH · DELETE · GET 중 하나여야 합니다.',
  user_field_invalid: 'transactionUser 필드는 login_id · name · role 중 하나여야 합니다.',
  timeout_invalid: '타임아웃은 1000~60000ms 범위여야 합니다.',
  url_invalid: 'URL 은 http:// 또는 https:// 로 시작해야 합니다.',
  url_prod_required: '운영으로 전환하려면 운영 URL 을 먼저 입력하세요.',
  key_invalid: '연동 키는 영문 소문자·숫자·밑줄 3~40자입니다.',
  key_taken: '이미 같은 키의 연동이 있습니다.',
};

export default async function integrationRoutes(app) {
  const guard = { preHandler: [authGuard, requireDirector] };

  async function ready(reply) {
    if (await endpointsReady()) return true;
    reply.code(503).send({ error: 'migration_required', note: '0201_integration_endpoints 마이그레이션이 필요합니다.' });
    return false;
  }

  // 목록 — 카테고리별 정리 + 연동별 전송 집계
  app.get('/api/integrations', guard, async () => {
    const eps = (await listEndpoints()).map(publicEndpoint);
    let counts = {};
    try {
      const rows = (await query(
        `SELECT COALESCE(endpoint_key,'customer_commercial') AS k, status, count(*)::int AS n
           FROM crm_customer_outbox GROUP BY 1,2`)).rows;
      for (const r of rows) {
        counts[r.k] = counts[r.k] || { pending: 0, sent: 0, failed: 0, skipped: 0 };
        counts[r.k][r.status] = Number(r.n);
      }
    } catch (_) { counts = {}; }
    return {
      migrated: await endpointsReady(),
      engine: crmStatus(),
      items: eps.map((e) => ({ ...e, counts: counts[e.key] || { pending: 0, sent: 0, failed: 0, skipped: 0 } })),
    };
  });

  // 단건(계약서 포함) + 설정 변경 이력
  app.get('/api/integrations/:key', guard, async (req, reply) => {
    const ep = await getEndpoint(req.params.key);
    if (!ep) return reply.code(404).send({ error: 'not_found' });
    let changes = [];
    try {
      changes = (await query(
        `SELECT c.changes, c.changed_at, u.name AS changed_by_name
           FROM integration_endpoint_changes c
           LEFT JOIN integration_endpoints e ON e.id=c.endpoint_id
           LEFT JOIN users u ON u.id=c.changed_by
          WHERE e.key=$1 ORDER BY c.changed_at DESC LIMIT 30`, [req.params.key])).rows;
    } catch (_) { changes = []; }
    return { endpoint: publicEndpoint(ep), changes };
  });

  // 설정·계약서 저장
  app.put('/api/integrations/:key', guard, async (req, reply) => {
    if (!(await ready(reply))) return;
    const r = await saveEndpoint(req.params.key, req.body || {}, req.ctx.perm.userId);
    if (r.error) return reply.code(r.error === 'not_found' ? 404 : 400).send({ error: r.error, note: ERR_NOTE[r.error] || null });
    const ep = await getEndpoint(req.params.key);
    return { ok: true, unchanged: !!r.unchanged, changes: r.changes || {}, endpoint: publicEndpoint(ep) };
  });

  // 새 연동 등록(예: 제품 외 추가 계약)
  app.post('/api/integrations', guard, async (req, reply) => {
    if (!(await ready(reply))) return;
    const r = await createEndpoint(req.body || {}, req.ctx.perm.userId);
    if (r.error) return reply.code(400).send({ error: r.error, note: r.note || ERR_NOTE[r.error] || null });
    return { ok: true, endpoint: publicEndpoint({ ...r.endpoint, source: 'db' }) };
  });

  /**
   * 연결 테스트 — 지금 저장된 설정 그대로 1건 쏘고 요청·응답 원문을 돌려준다.
   *   아웃박스에 남기지 않는다(이력을 시험 건으로 더럽히지 않기 위해).
   *   body: { op?: 'upsert'|'delete', customer_id?, payload? }
   *     customer_id 를 주면 그 고객의 실제 값으로, 없으면 계약서의 요청 예시로 보낸다.
   */
  app.post('/api/integrations/:key/test', guard, async (req, reply) => {
    const ep = await getEndpoint(req.params.key);
    if (!ep) return reply.code(404).send({ error: 'not_found' });
    if (!activeUrl(ep)) {
      return reply.code(400).send({ error: 'url_missing', note: (ep.env === 'prod' ? '운영' : '테스트') + ' URL 이 비어 있습니다.' });
    }
    const b = req.body || {};
    const op = b.op === 'delete' ? 'delete' : 'upsert';
    let payload = b.payload;
    let usedCustomer = null;

    // 테스트에 쓸 고객: id 로 지정하거나, 코드·상호·RFC 로 찾는다.
    //   아무것도 안 주면 고객 연동에 한해 **가장 최근 승인된 RFC 보유 고객**을 자동으로 고른다.
    //   (매번 예시 JSON 을 손으로 채우게 하지 않기 위해서다. 실제 값으로 시험하는 편이 계약 검증에도 낫다)
    if (!payload && (ep.category === 'customer' || b.customer_id || b.customer_query)) {
      let c = null;
      if (b.customer_id) {
        c = (await query(
          `SELECT id, code, name, rfc, discount, credit_days FROM customers WHERE id=$1`, [Number(b.customer_id)])).rows[0];
        if (!c) return reply.code(404).send({ error: 'customer_not_found' });
      } else if (String(b.customer_query || '').trim()) {
        const q = `%${String(b.customer_query).trim()}%`;
        c = (await query(
          `SELECT id, code, name, rfc, discount, credit_days FROM customers
            WHERE deleted_at IS NULL AND (code ILIKE $1 OR name ILIKE $1 OR rfc ILIKE $1)
            ORDER BY (rfc IS NULL), id DESC LIMIT 1`, [q])).rows[0];
        if (!c) return reply.code(404).send({ error: 'customer_not_found', note: '그 조건으로 고객을 찾지 못했습니다.' });
      } else {
        c = (await query(
          `SELECT id, code, name, rfc, discount, credit_days FROM customers
            WHERE deleted_at IS NULL AND rfc IS NOT NULL AND btrim(rfc) <> ''
              AND COALESCE(approval_status,'approved')='approved'
            ORDER BY id DESC LIMIT 1`)).rows[0];
      }
      if (c) {
        if (!String(c.rfc || '').trim()) {
          return reply.code(400).send({ error: 'rfc_missing', note: `${c.code || ''} ${c.name || ''} 은(는) RFC 가 없어 시험 전송할 수 없습니다.` });
        }
        const u = (await query(`SELECT login_id, name, role FROM users WHERE id=$1`, [req.ctx.perm.userId])).rows[0] || {};
        const f = ['login_id', 'name', 'role'].includes(ep.user_field) ? ep.user_field : 'login_id';
        payload = op === 'delete'
          ? { rfc: String(c.rfc).trim(), transactionUser: String(u[f] || 'erp') }
          : { rfc: String(c.rfc).trim(), discountPercent: Number(c.discount || 0), paymentDays: Number(c.credit_days || 0), transactionUser: String(u[f] || 'erp') };
        usedCustomer = { id: Number(c.id), code: c.code, name: c.name };
      }
    }

    // 고객 연동이 아니거나(제품 등) 고객을 못 고른 경우 → 계약서의 요청 예시로 보낸다.
    if (!payload) {
      const sample = (ep.contract && ep.contract.sample_request) || '';
      try { payload = sample ? JSON.parse(sample) : null; } catch (_) {
        return reply.code(400).send({ error: 'sample_invalid', note: '계약서의 「요청 예시」가 올바른 JSON 이 아닙니다.' });
      }
      if (!payload) {
        return reply.code(400).send({ error: 'payload_required',
          note: '보낼 본문이 없습니다. 테스트할 고객을 입력하거나, 계약서 탭의 「요청 예시」를 채우세요(필드표가 있으면 「필드표로 예시 만들기」로 자동 생성됩니다).' });
      }
    }

    const r = await sendPayload(ep, op, payload);
    const ok = !r.error && isSuccess(r.httpStatus, r.body, ep.ok_code);
    return {
      ok,
      request: { method: r.method, url: r.url, env: ep.env, payload, auth: !!activeToken(ep), customer: usedCustomer },
      response: r.error ? { error: r.error } : { http_status: r.httpStatus, body: r.body, ms: r.ms },
      verdict: ok ? 'CRM 이 성공(codigoError=' + (ep.ok_code) + ')으로 응답했습니다.'
        : (r.error ? '연결하지 못했습니다: ' + r.error
          : 'CRM 이 성공코드를 주지 않았습니다 — 계약서의 오류코드 표와 대조하세요.'),
    };
  });

  // 캐시 즉시 반영(설정을 바꾸고 바로 시험할 때)
  app.post('/api/integrations/:key/refresh', guard, async (req) => {
    invalidateEndpointCache(req.params.key);
    const ep = await getEndpoint(req.params.key);
    return { ok: true, endpoint: publicEndpoint(ep) };
  });
}
