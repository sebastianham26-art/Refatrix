// =====================================================================
// Refatrix ERP · quoteSummary.js — 견적·매출 추적 기간 요약(상단 KPI 7칸) 계산
//   2026-10-07 · quoteRoutes.js 에서 옮김(계산식 그대로). 화면 카드(/api/quotes/summary)와
//   신규 견적 WhatsApp 알림의 「당월 요약」이 **같은 함수**를 쓴다 — 숫자가 갈리지 않게.
//   금액은 전부 IVA 제외. 매출총이익 두 칸(gp)은 원가 정보 — 호출부가 받는 사람을 거른다.
// =====================================================================
import { query } from './db.js';
import { fobCostBasis } from './priceMaster.js';

export async function computeQuoteSummary({ yms = [], all = false, scope = null } = {}, q = query) {
  const args = []; const conds = [`q.deleted_at IS NULL`, `q.status IN ('draft','confirmed','converted','expired')`];
  if (!all) {
    if (!yms.length) return { period: [], empty: true };
    args.push([...new Set(yms)]); conds.push(`to_char(q.quote_date, 'YYYY-MM') = ANY($${args.length}::text[])`);
  }
  // scope: null = 전체 · {teamIds, userId} = 화면 권한(팀 고객 + 본인이 만든 고객 미지정 견적)
  //        · {teamIds, guestByCreatorTeam:true} = WhatsApp 수신자 팀 범위(고객 미지정 견적은 작성자 팀)
  if (scope && Array.isArray(scope.teamIds)) {
    args.push(scope.teamIds); const ti = args.length;
    if (scope.guestByCreatorTeam) {
      conds.push(`(c.team_id = ANY($${ti}) OR (q.customer_id IS NULL AND q.created_by IN (SELECT id FROM users WHERE team_id = ANY($${ti}))))`);
    } else {
      args.push(scope.userId); const ui = args.length;
      conds.push(`(c.team_id = ANY($${ti}) OR (q.customer_id IS NULL AND q.created_by = $${ui}))`);
    }
  }
  const gpDir = true;   // 원가가 들어간다 — 호출하는 쪽이 디렉터 · 소시오(또는 디렉터가 지정한 수신자)로 거른다
  let basis = null;
  if (gpDir) basis = await fobCostBasis();
  args.push(gpDir && basis && basis.fx > 0 ? basis.fx : 0); const fxI = args.length;
  const FOBP = `NULLIF(to_jsonb(p) ->> 'fob_usd', '')::numeric`;
  const FOBOK = `(COALESCE(${FOBP}, 0) > 0 AND $${fxI}::numeric > 0)`;
  const r = (await q(
    `WITH qs AS MATERIALIZED (
       SELECT q.id, q.status, q.subtotal_mxn, q.total_qty, q.invoice_id
         FROM quotes q LEFT JOIN customers c ON c.id = q.customer_id
        WHERE ${conds.join(' AND ')}
     ), inv AS MATERIALIZED (
       SELECT DISTINCT i.id FROM qs JOIN sales_invoices i ON i.id = qs.invoice_id
        WHERE qs.status = 'converted' AND i.status <> 'deleted'
     ), sl AS MATERIALIZED (
       SELECT sl.product_id, sl.qty, sl.line_amount_mxn AS amt, COALESCE(sl.cogs_mxn, sl.qty * sl.applied_unit_cost, 0) AS sc,
              ${FOBP} AS fob, ${FOBOK} AS fobok
         FROM sales_invoice_lines sl JOIN inv ON inv.id = sl.invoice_id LEFT JOIN products p ON p.id = sl.product_id
     ), sh AS MATERIALIZED (
       SELECT ss.product_id, ss.shortage_qty AS qty, ss.shortage_amount_mxn / 1.16 AS amt, qs.status AS qst,
              COALESCE(p.avg_cost, 0) AS avg_cost, ${FOBP} AS fob, ${FOBOK} AS fobok
         FROM stock_shortages ss
         JOIN qs ON (ss.source_quote_id = qs.id
                     OR (ss.source_quote_id IS NULL AND qs.invoice_id IS NOT NULL AND ss.sales_invoice_id = qs.invoice_id))
         LEFT JOIN products p ON p.id = ss.product_id
        WHERE ss.status <> 'cancelled'
     ), qsku AS MATERIALIZED (
       SELECT COALESCE(ql.product_id::text, 'X:' || regexp_replace(upper(COALESCE(ql.input_code,'')), '[^A-Z0-9]', '', 'g')) AS k
         FROM quote_lines ql JOIN qs ON qs.id = ql.quote_id
     ), op AS MATERIALIZED (
       SELECT GREATEST(ql.qty - COALESCE(ql.reserved_qty, 0), 0) AS sq,
              GREATEST(ql.qty - COALESCE(ql.reserved_qty, 0), 0)::numeric / NULLIF(ql.qty, 0) * ql.line_subtotal AS samt
         FROM quote_lines ql JOIN qs ON qs.id = ql.quote_id
        WHERE qs.status IN ('draft','confirmed') AND ql.product_id IS NOT NULL
     )
     SELECT
       (SELECT COUNT(*) FROM qs)::int                                             AS q_n,
       (SELECT COALESCE(SUM(subtotal_mxn), 0) FROM qs)                            AS q_amt,
       (SELECT COALESCE(SUM(total_qty), 0) FROM qs)                               AS q_qty,
       (SELECT COUNT(DISTINCT k) FROM qsku WHERE k <> 'X:')::int                  AS q_sku,
       (SELECT COUNT(*) FROM qsku)::int                                           AS q_lines,
       (SELECT COUNT(*) FROM qs WHERE status IN ('draft','confirmed'))::int       AS q_open,
       (SELECT COUNT(*) FROM qs WHERE status = 'converted')::int                  AS q_conv,
       (SELECT COUNT(*) FROM qs WHERE status = 'expired')::int                    AS q_exp,
       (SELECT COUNT(*) FROM inv)::int                                            AS s_inv,
       (SELECT COALESCE(SUM(amt), 0) FROM sl)                                     AS s_amt,
       (SELECT COALESCE(SUM(qty), 0) FROM sl)                                     AS s_qty,
       (SELECT COUNT(DISTINCT product_id) FROM sl)::int                           AS s_sku,
       (SELECT COALESCE(SUM(amt) FILTER (WHERE sc > 0), 0) FROM sl)               AS s_a_rev,
       (SELECT COALESCE(SUM(sc)  FILTER (WHERE sc > 0), 0) FROM sl)               AS s_a_cost,
       (SELECT COALESCE(SUM(amt) FILTER (WHERE sc <= 0 AND fobok), 0) FROM sl)    AS s_f_rev,
       (SELECT COALESCE(SUM(qty * fob) FILTER (WHERE sc <= 0 AND fobok), 0) FROM sl) AS s_f_usd,
       (SELECT COUNT(*) FILTER (WHERE sc <= 0 AND fobok) FROM sl)::int            AS s_f_n,
       (SELECT COUNT(*) FILTER (WHERE sc <= 0 AND NOT fobok) FROM sl)::int        AS s_no_n,
       (SELECT COUNT(*) FROM sh)::int                                             AS l_n,
       (SELECT COALESCE(SUM(amt), 0) FROM sh)                                     AS l_amt,
       (SELECT COALESCE(SUM(qty), 0) FROM sh)                                     AS l_qty,
       (SELECT COUNT(DISTINCT product_id) FROM sh)::int                           AS l_sku,
       (SELECT COALESCE(SUM(amt) FILTER (WHERE qst = 'converted'), 0) FROM sh)    AS l_conv_amt,
       (SELECT COALESCE(SUM(amt) FILTER (WHERE qst = 'expired'), 0) FROM sh)      AS l_exp_amt,
       (SELECT COALESCE(SUM(amt) FILTER (WHERE avg_cost > 0), 0) FROM sh)         AS l_a_rev,
       (SELECT COALESCE(SUM(qty * avg_cost) FILTER (WHERE avg_cost > 0), 0) FROM sh) AS l_a_cost,
       (SELECT COALESCE(SUM(amt) FILTER (WHERE avg_cost <= 0 AND fobok), 0) FROM sh) AS l_f_rev,
       (SELECT COALESCE(SUM(qty * fob) FILTER (WHERE avg_cost <= 0 AND fobok), 0) FROM sh) AS l_f_usd,
       (SELECT COUNT(*) FILTER (WHERE avg_cost <= 0 AND fobok) FROM sh)::int      AS l_f_n,
       (SELECT COUNT(*) FILTER (WHERE avg_cost <= 0 AND NOT fobok) FROM sh)::int  AS l_no_n,
       (SELECT COALESCE(SUM(samt), 0) FROM op)                                    AS o_amt,
       (SELECT COALESCE(SUM(sq), 0) FROM op)                                      AS o_qty`, args)).rows[0];
  const N = (k) => Number(r[k] || 0);
  const r2 = (x) => Math.round(x * 100) / 100;
  const out = {
    period: all ? 'all' : [...new Set(yms)].sort(),
    basis: 'ex_iva',
    quotes: { n: N('q_n'), amt: r2(N('q_amt')), qty: N('q_qty'), sku: N('q_sku'), lines: N('q_lines'), open: N('q_open'), converted: N('q_conv'), expired: N('q_exp') },
    sales: { invoices: N('s_inv'), amt: r2(N('s_amt')), qty: N('s_qty'), sku: N('s_sku'),
      rate: N('q_amt') > 0 ? Math.round(N('s_amt') / N('q_amt') * 1000) / 10 : null },
    lost: { n: N('l_n'), amt: r2(N('l_amt')), qty: N('l_qty'), sku: N('l_sku'),
      converted_amt: r2(N('l_conv_amt')), expired_amt: r2(N('l_exp_amt')),
      open_short_amt: r2(N('o_amt')), open_short_qty: N('o_qty') },
  };
  if (gpDir) {
    const unit = basis && basis.fx > 0 ? basis.fx * (1 + basis.oh_rate) : 0;    // FOB 1달러당 원가(MXN)
    const g = (p) => {
      const rev = N(p + 'a_rev') + N(p + 'f_rev');
      const cost = N(p + 'a_cost') + N(p + 'f_usd') * unit;
      return { gp: r2(rev - cost), rev: r2(rev), cost: r2(cost), pct: rev > 0 ? Math.round((rev - cost) / rev * 1000) / 10 : null,
        est: N(p + 'f_n'), nocost: N(p + 'no_n') };
    };
    out.gp = { sales: g('s_'), lost: g('l_'), ...(unit ? { fx: basis.fx, oh_rate: basis.oh_rate } : {}) };
  }
  return out;
}
