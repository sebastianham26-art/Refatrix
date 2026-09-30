// =====================================================================
// Refatrix ERP · reservationRoutes.js  (2026-09-30)
//   GET /api/reservations          — 지금 살아 있는 견적 재고예약(줄 단위) + 제품별 합계 + KPI
//       ?released=48               — 최근 N시간(상한 168h) 안에 **만료로 풀린** 예약도 함께
//
//   읽기 전용. 예약을 만들거나 푸는 일은 하지 않는다(견적 저장·만료 스위퍼의 몫).
//   가시성은 견적 목록(/api/quotes)과 같다 — 디렉터·영업지원 = 전체,
//   그 외 = 자기 팀 고객 견적 + 본인이 만든 불특정 견적.
//   단, 제품별 「전체 예약·가용」 합계는 팀과 무관한 **회사 전체** 숫자다(가용재고는 하나뿐이니까).
// =====================================================================
import { query } from '../db.js';
import { authGuard, requirePageAny } from '../middleware/authGuard.js';
import { teamArr } from '../teams.js';
import { ACTIVE_RESERVATION_SQL, shapeRow, groupByProduct, summarize, releasedHours } from '../reservations.js';

const LINE_COLS = `
  ql.id AS line_id, ql.line_no, ql.product_id, ql.ctr_code, ql.product_name, ql.qty, ql.reserved_qty, ql.line_subtotal,
  q.id AS quote_id, q.quote_no, q.status, q.origin, q.external_quote_no, q.created_at,
  q.reserve_expires_at, q.packing_printed_at, q.customer_id, q.guest_name,
  c.name AS customer_name, c.team_id,
  uc.name AS creator_name, uc.login_id AS creator_login_id,
  ua.name AS assignee_name,
  p.code AS product_code`;

const LINE_FROM = `
  FROM quote_lines ql
  JOIN quotes q ON q.id = ql.quote_id
  JOIN products p ON p.id = ql.product_id
  LEFT JOIN customers c ON c.id = q.customer_id
  LEFT JOIN users uc ON uc.id = q.created_by
  LEFT JOIN users ua ON ua.id = q.assigned_to`;

/** 견적 목록과 같은 팀 가시성 조건(없으면 null) */
function visibilityClause(perm, args) {
  const ta = teamArr(perm);
  if (!ta) return null;
  args.push(ta); const ti = args.length;
  args.push(perm.userId); const ui = args.length;
  return `(c.team_id = ANY($${ti}) OR (q.customer_id IS NULL AND q.created_by = $${ui}))`;
}

export default async function reservationRoutes(app) {
  app.get('/api/reservations', { preHandler: [authGuard, requirePageAny(['quote', 'sales'])] }, async (req) => {
    const perm = req.ctx.perm;
    const now = new Date();

    // ① 살아 있는 예약 — 곧 풀리는 순. 포장지시(시간 무관)는 맨 뒤.
    const aArgs = [];
    const aConds = [`ql.product_id IS NOT NULL`, `ql.reserved_qty > 0`, ACTIVE_RESERVATION_SQL];
    const av = visibilityClause(perm, aArgs); if (av) aConds.push(av);
    const activeRows = (await query(
      `SELECT ${LINE_COLS} ${LINE_FROM}
        WHERE ${aConds.join(' AND ')}
        ORDER BY (q.packing_printed_at IS NOT NULL), q.reserve_expires_at ASC NULLS LAST, q.id, ql.line_no, ql.id`, aArgs)).rows;
    const items = activeRows.map((r) => shapeRow(r, now));

    // ② 최근 만료로 풀린 예약(선택). 만료 스위퍼는 reserved_qty 를 지우지 않으므로 풀린 수량이 그대로 남아 있다.
    const hours = releasedHours(req.query.released);
    let released = [];
    if (hours) {
      const rArgs = [hours];
      const rConds = [`ql.product_id IS NOT NULL`, `ql.reserved_qty > 0`,
        `q.deleted_at IS NULL`, `q.packing_printed_at IS NULL`,
        `q.status IN ('draft','confirmed','expired')`,
        `q.reserve_expires_at <= now()`,
        `q.reserve_expires_at > now() - ($1::int * interval '1 hour')`];
      const rv = visibilityClause(perm, rArgs); if (rv) rConds.push(rv);
      released = (await query(
        `SELECT ${LINE_COLS} ${LINE_FROM}
          WHERE ${rConds.join(' AND ')}
          ORDER BY q.reserve_expires_at DESC, q.id, ql.line_no, ql.id`, rArgs)).rows.map((r) => shapeRow(r, now));
    }

    // ③ 제품별 현재고 · 회사 전체 예약 — 보이는 제품만
    const pids = [...new Set(items.map((i) => i.product_id))];
    let stockRows = [];
    if (pids.length) {
      stockRows = (await query(
        `SELECT p.id AS product_id, p.stock_qty,
                COALESCE((SELECT SUM(ql.reserved_qty)
                            FROM quote_lines ql JOIN quotes q ON q.id = ql.quote_id
                           WHERE ql.product_id = p.id AND ${ACTIVE_RESERVATION_SQL}), 0) AS reserved_all
           FROM products p WHERE p.id = ANY($1)`, [pids])).rows;
    }

    return {
      now: now.toISOString(),
      scope: teamArr(perm) ? 'team' : 'all',
      summary: summarize(items),
      items,
      products: groupByProduct(items, stockRows).map(({ items: _drop, ...g }) => g),
      released_hours: hours,
      released,
    };
  });
}
