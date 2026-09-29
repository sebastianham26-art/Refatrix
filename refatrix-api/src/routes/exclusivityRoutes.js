// =====================================================================
// 고객 독점 정책 화면용 API — 0235 (2026-09-29)
//   GET /api/customers/:id/exclusivity  고객 상세 배지 · 이력 · 서류 관문
//   GET /api/exclusivity/check          견적·매출 화면: 이 고객을 누가 팔 수 있나
//   GET /api/sellers                    판매 영업사원 드롭다운
//   POST /api/exclusivity/recompute     (디렉터) 전체 재계산
// =====================================================================
import { query } from '../db.js';
import { authGuard, requirePageAny, requireDirector } from '../middleware/authGuard.js';
import { canViewTeam } from '../teams.js';
import { statusFor, resolveSeller, sweepAll, exclusivityReady, RFC_DAYS, RENEW_MONTHS } from '../exclusivity.js';

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

  app.post('/api/exclusivity/recompute', { preHandler: [authGuard, requireDirector] }, async () => {
    const n = await sweepAll(app.log);
    return { ok: true, customers: n };
  });
}
