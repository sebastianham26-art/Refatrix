import { query } from '../db.js';
import { authGuard } from '../middleware/authGuard.js';
import { visibleTeamIds } from '../teams.js';
import { fieldVisible } from '../permissions.js';
import { monthsHorizon, currentYm } from './../salesTarget.js';

function r2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

// 포털: 프로세스 지도 배지 + 성과 위젯을 한 번에.
// 권한(pages)·역할(role)·팀 가시성에 맞는 수치만 계산해 반환.
export default async function portalRoutes(app) {
  app.get('/api/portal/summary', { preHandler: [authGuard] }, async (req) => {
    const perm = req.ctx.perm;
    const role = perm.role;
    const pages = new Set(Object.keys(perm.pages || {}));
    const isDirector = role === 'director';
    const can = (k) => isDirector || pages.has(k);
    const vis = visibleTeamIds(perm);              // null=전체(디렉터), []=없음

    const out = { role, name: perm.name, badges: {}, perf: null, pipeline: null, pages: [...pages], isDirector };

    // ---------- 배지 ----------
    // 디렉터: 승인 대기들
    if (isDirector) {
      const t = (await query(`SELECT COUNT(*) AS n FROM target_team_status WHERE status='submitted'`)).rows[0];
      out.badges.target_approvals = Number(t.n);
      const m = (await query(`SELECT COUNT(*) AS n FROM marketing_plan_status WHERE id=1 AND status='submitted'`)).rows[0];
      out.badges.marketing_approvals = Number(m.n);
      const s = (await query(`SELECT COUNT(*) AS n FROM sales_change_requests WHERE status='pending'`)).rows[0];
      out.badges.sales_change_approvals = Number(s.n);
      const d = (await query(`SELECT COUNT(*) AS n FROM customer_directives WHERE status<>'done'`)).rows[0];
      out.badges.directives_open_all = Number(d.n);
    }

    // 영업(또는 파이프라인 권한자): 내 팀 미읽음 지시, 정체 고객
    if (can('pipeline')) {
      let p1 = `SELECT COUNT(*) AS n FROM customer_directives d JOIN customers c ON c.id=d.customer_id WHERE d.status='open' AND c.deleted_at IS NULL`;
      let p2 = `SELECT COUNT(*) AS n FROM customers c WHERE c.deleted_at IS NULL AND c.stage_since IS NOT NULL
                  AND c.stage_id IN (SELECT id FROM stages WHERE sort_order < 60)
                  AND CURRENT_DATE - c.stage_since >= 30`;
      const params = [];
      if (vis !== null) { params.push(vis.length ? vis : [-1]); p1 += ` AND c.team_id = ANY($1)`; p2 += ` AND c.team_id = ANY($1)`; }
      out.badges.directives_unread = Number((await query(p1, params)).rows[0].n);
      out.badges.stalled_customers = Number((await query(p2, params)).rows[0].n);
    }

    // 목표: 반려된 내 팀(영업) / 제출대기(미제출 팀 수, 디렉터 참고)
    if (can('targets')) {
      let q1 = `SELECT COUNT(*) AS n FROM target_team_status s JOIN sales_teams t ON t.id=s.team_id WHERE s.status='rejected'`;
      const params = [];
      if (vis !== null) { params.push(vis.length ? vis : [-1]); q1 += ` AND s.team_id = ANY($1)`; }
      out.badges.target_rejected = Number((await query(q1, params)).rows[0].n);
    }

    // 마케팅: 반려 + 예산초과 월 수
    if (can('marketing') && (isDirector || role === 'marketing')) {
      const st = (await query(`SELECT status FROM marketing_plan_status WHERE id=1`)).rows[0];
      out.badges.marketing_rejected = st && st.status === 'rejected' ? 1 : 0;
      const months = monthsHorizon(currentYm(), 12);
      const bud = (await query(`SELECT ym, amount FROM marketing_budget_months WHERE ym = ANY($1)`, [months])).rows;
      const budBy = {}; for (const b of bud) budBy[b.ym] = Number(b.amount);
      const al = (await query(`SELECT ym, SUM(qty*unit_budget) AS s FROM marketing_alloc WHERE ym = ANY($1) GROUP BY ym`, [months])).rows;
      let over = 0; for (const a of al) if (Number(a.s) > (budBy[a.ym] || 0)) over++;
      out.badges.marketing_over_months = over;
    }

    // 수금: 연체 AR 고객 수(팀 가시성)
    if (can('sales') || can('customers')) {
      let q = `SELECT COUNT(DISTINCT i.customer_id) AS n
                 FROM sales_invoices i
                 JOIN customers c ON c.id=i.customer_id
                 LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM sales_payment_allocations GROUP BY invoice_id) p ON p.invoice_id=i.id
                WHERE i.status='posted' AND i.due_date < CURRENT_DATE AND (i.total_mxn - COALESCE(p.paid,0)) > 0.01 AND c.deleted_at IS NULL`;
      const params = [];
      if (vis !== null) { params.push(vis.length ? vis : [-1]); q += ` AND c.team_id = ANY($1)`; }
      out.badges.overdue_customers = Number((await query(q, params)).rows[0].n);
    }

    // ---------- 성과 위젯: 올해 목표 vs 실적(팀 가시성) ----------
    if (can('targets') || can('sales')) {
      const year = new Date().getUTCFullYear();
      const yStart = `${year}-01`, yEnd = `${year}-12`;
      let tq = `SELECT COALESCE(SUM(m.amount),0) AS s FROM target_customer_months m JOIN customers c ON c.id=m.customer_id
                 WHERE m.ym BETWEEN $1 AND $2 AND c.deleted_at IS NULL`;
      let aq = `SELECT COALESCE(SUM(i.total_mxn),0) AS s FROM sales_invoices i JOIN customers c ON c.id=i.customer_id
                 WHERE i.status='posted' AND to_char(i.inv_date,'YYYY-MM') BETWEEN $1 AND $2 AND c.deleted_at IS NULL`;
      const params = [yStart, yEnd];
      if (vis !== null) { params.push(vis.length ? vis : [-1]); tq += ` AND c.team_id = ANY($3)`; aq += ` AND c.team_id = ANY($3)`; }
      const target = Number((await query(tq, params)).rows[0].s);
      const actual = Number((await query(aq, params)).rows[0].s);
      const rate = target > 0 ? r2(actual / target * 100) : null;
      out.perf = fieldVisible(perm, 'sales_amount')
        ? { year, target: r2(target), actual: r2(actual), rate, locked: false }
        : { year, rate, locked: true };
    }

    // ---------- 파이프라인 요약: 단계별 고객 수(팀 가시성) ----------
    if (can('pipeline')) {
      let q = `SELECT s.name, s.sort_order, COUNT(c.id) AS n
                 FROM stages s LEFT JOIN customers c ON c.stage_id=s.id AND c.deleted_at IS NULL`;
      const params = [];
      if (vis !== null) { params.push(vis.length ? vis : [-1]); q += ` AND c.team_id = ANY($1)`; }
      q += ` WHERE s.deleted_at IS NULL GROUP BY s.id, s.name, s.sort_order ORDER BY s.sort_order`;
      out.pipeline = (await query(q, params)).rows.map((r) => ({ name: r.name, count: Number(r.n) }));
    }

    return out;
  });
}
