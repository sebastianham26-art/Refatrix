// =====================================================================
// 고객 독점 정책 화면용 API — 0235 (2026-09-29)
//   GET /api/customers/:id/exclusivity  고객 상세 배지 · 이력 · 서류 관문
//   GET /api/exclusivity/check          견적·매출 화면: 이 고객을 누가 팔 수 있나
//   GET /api/sellers                    판매 영업사원 드롭다운
//   POST /api/exclusivity/recompute     (디렉터) 전체 재계산
//   POST /api/customers/:id/terms-override  (디렉터 PIN) 서류 관문 예외 — 0247
// =====================================================================
import { query } from '../db.js';
import { authGuard, requirePageAny, requireDirector } from '../middleware/authGuard.js';
import { canViewTeam } from '../teams.js';
import { statusFor, resolveSeller, sweepAll, exclusivityReady, RFC_DAYS, RENEW_MONTHS } from '../exclusivity.js';
import { verifyPin } from '../auth.js';
import { enqueueCustomerSync } from '../crmSync.js';
import { logEvent } from '../audit.js';

async function overrideReady() {
  const r = await query(`SELECT 1 FROM information_schema.columns WHERE table_name='customers' AND column_name='discount_override'`);
  return r.rows.length > 0;
}

const PAGES = ['customers', 'quote', 'sales'];

export default async function exclusivityRoutes(app) {
  app.get('/api/customers/:id/exclusivity', { preHandler: [authGuard, requirePageAny(PAGES)] }, async (req, reply) => {
    const id = Number(req.params.id);
    const c = (await query(`SELECT id, team_id, owner_id FROM customers WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!c) return reply.code(404).send({ error: 'not_found' });
    const st = await statusFor(id);
    if (!st) return reply.code(404).send({ error: 'not_found' });
    if (!st.ready) return { ready: false, note: 'migrate(0235) 필요' };
    // 남의 팀 고객이면(본인 담당·본인 독점이 아니면) 독점권자·만료일만(선점 확인과 같은 공개 범위). 할인·외상 조건은 숨긴다.
    const mine = Number(c.owner_id) === Number(req.ctx.perm.userId) || (st.current && Number(st.current.agent_id) === Number(req.ctx.perm.userId));
    if (!canViewTeam(req.ctx.perm, c.team_id) && !mine) {
      return { ready: true, policy: st.policy, open: st.open,
        current: st.current ? { kind: st.current.kind, agent_name: st.current.agent_name, ends_on: st.current.ends_on } : null };
    }
    return { ...st, rules: { rfc_days: RFC_DAYS, renew_months: RENEW_MONTHS } };
  });

  app.get('/api/exclusivity/check', { preHandler: [authGuard, requirePageAny(PAGES)] }, async (req, reply) => {
    const customerId = Number(req.query.customer_id);
    if (!customerId) return reply.code(400).send({ error: 'customer_required' });
    if (!(await exclusivityReady())) return { ready: false, can_sell: true, locked: false };
    const r = await resolveSeller(query, { customerId, requestedSeller: Number(req.query.seller_id) || null, perm: req.ctx.perm });
    if (r.error === 'customer_not_found') return reply.code(404).send({ error: 'not_found' });
    return {
      ready: true,
      can_sell: r.ok || r.error === 'seller_required',
      locked: !!r.locked,                      // 독점 중 → 판매자 고정
      open: !!r.open || r.error === 'seller_required',
      holder: r.holder || null,
      seller_id: r.ok ? r.seller_id : null,
      error: r.ok ? null : r.error,
      note: r.note || null,
    };
  });

  app.get('/api/sellers', { preHandler: [authGuard, requirePageAny(PAGES)] }, async () => {
    // 영업 + 디렉터 + 커미션 대상(커미셔너). 퇴사자 제외.
    const rows = (await query(
      `SELECT u.id, u.name, u.role, u.team_id
         FROM users u
        WHERE u.deleted_at IS NULL
          AND (u.role IN ('sales','director')
               OR EXISTS (SELECT 1 FROM commission_agents ca WHERE ca.user_id=u.id AND ca.active))
        ORDER BY u.name`)).rows;
    return { items: rows.map((u) => ({ id: Number(u.id), name: u.name, role: u.role, team_id: u.team_id == null ? null : Number(u.team_id) })) };
  });

  // ── 0247 · 서류 관문 디렉터 PIN 승인 예외 ─────────────────────────────
  //   body: { discount?: bool, credit?: bool, pin, reason }  — 보낸 항목만 바꾼다.
  //   켜면 서류가 없어도 약정 할인·외상일이 실효값이 되고 CRM 에도 그 값이 나간다.
  //   끄면 즉시 서류 기준으로 돌아간다(끌 때도 PIN 필요 — 조건이 바뀌는 건 같다).
  app.post('/api/customers/:id/terms-override', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    if (!(await overrideReady())) return reply.code(503).send({ error: 'migration_required', note: 'migrate(0247) 필요' });
    const me = (await query(`SELECT pin_hash FROM users WHERE id=$1 AND deleted_at IS NULL`, [req.ctx.perm.userId])).rows[0];
    if (!me || !verifyPin(String(b.pin || ''), me.pin_hash)) return reply.code(403).send({ error: 'bad_pin', note: 'PIN이 올바르지 않습니다.' });
    const hasD = typeof b.discount === 'boolean', hasC = typeof b.credit === 'boolean';
    if (!hasD && !hasC) return reply.code(400).send({ error: 'nothing_to_change' });
    const reason = String(b.reason || '').trim();
    const turningOn = (hasD && b.discount) || (hasC && b.credit);
    if (turningOn && !reason) return reply.code(400).send({ error: 'reason_required', note: '승인 사유를 입력하세요.' });
    const before = (await query(
      `SELECT id, doc_gate, approval_status, discount, credit_days, discount_override, credit_override
         FROM customers WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!before) return reply.code(404).send({ error: 'not_found' });
    if (!before.doc_gate) return reply.code(409).send({ error: 'not_gated', note: '서류 관문 대상 고객이 아닙니다(등록된 조건이 그대로 적용 중).' });
    const nd = hasD ? b.discount : before.discount_override;
    const nc = hasC ? b.credit : before.credit_override;
    const after = (await query(
      `UPDATE customers SET discount_override=$1, credit_override=$2,
              terms_override_by=$3, terms_override_at=now(), terms_override_reason=$4, updated_by=$3
        WHERE id=$5 RETURNING discount, credit_days, approval_status`,
      [nd, nc, req.ctx.perm.userId, reason || null, id])).rows[0];
    try {
      await query(
        `INSERT INTO customer_registration_events (customer_id, action, reason, snapshot, acted_by)
         VALUES ($1,'terms_override',$2,$3,$4)`,
        [id, reason || null, JSON.stringify({
          discount_override: nd, credit_override: nc,
          discount: { before: Number(before.discount), after: Number(after.discount) },
          credit_days: { before: Number(before.credit_days), after: Number(after.credit_days) } }), req.ctx.perm.userId]);
    } catch (_) { /* 이력 실패가 승인을 막지 않음 */ }
    try { await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `customer:${id}`, detail: { terms_override: true, discount_override: nd, credit_override: nc } }); } catch (_) {}
    // → CRM 재전송: 실효 할인·외상일이 바뀌었으면. 승인 대기 고객은 승인 때 나간다.
    let crm = null;
    const changed = Number(before.discount) !== Number(after.discount) || Number(before.credit_days) !== Number(after.credit_days);
    if (changed && String(after.approval_status || 'approved') !== 'pending') {
      crm = await enqueueCustomerSync(id, 'upsert', { origin: 'terms_override', actorUserId: req.ctx.perm.userId, app });
    }
    return { ok: true, discount_override: nd, credit_override: nc,
      discount: Number(after.discount), credit_days: Number(after.credit_days), crm_queued: !!(crm && crm.ok !== false) };
  });

  app.post('/api/exclusivity/recompute', { preHandler: [authGuard, requireDirector] }, async () => {
    const n = await sweepAll(app.log);
    return { ok: true, customers: n };
  });
}
