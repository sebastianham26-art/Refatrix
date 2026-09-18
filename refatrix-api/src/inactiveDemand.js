// =====================================================================
// Refatrix ERP · inactiveDemand.js
// 판매중단(비활성) SKU 에 **중단 이후** 들어온 견적요청 — 「판매재개 판단용 수요」.
//
// 왜 필요한가
//   0179 는 비활성 SKU 를 새 견적에서 **거절(409)** 했다. 거절은 아무것도 남기지
//   않는다 — 고객이 그 부품을 계속 찾고 있다는 사실이 ERP 어디에도 안 남았고,
//   판매재개 여부는 감으로 판단할 수밖에 없었다.
//   이제 견적은 **접수하되 확정만 잠근다**(quote_lines.issue='inactive').
//   그 줄들을 SKU 별로 모은 것이 여기서 말하는 「수요」다.
//
// 무엇을 세는가 (판정 기준 — 화면끼리 숫자가 어긋나지 않게 여기 한 곳에서만 정한다)
//   · 대상 SKU = 지금 **비활성**인 제품(삭제되지 않은 것).
//   · 기준 시각(since) = 마지막 **판매중단 전환 시각**
//        product_status_log.action='deactivate' 의 최신 changed_at,
//        (이력이 없으면) products.status_changed_at.
//   · 세는 줄 = 그 SKU 가 담긴 견적 줄 중
//        ⓐ 견적이 **기준 시각 이후에 만들어졌다**(quotes.created_at >= since), 또는
//        ⓑ 그 줄에 issue='inactive' 가 붙어 있다(수신 창구·화면 공통 표시).
//     ⓑ 를 같이 보는 이유: 기준 시각이 없는 옛 데이터(0179 이전 전환)도 놓치지 않기 위해서다.
//   · 제외 = 삭제된 견적, 취소된 견적, 가격표(pricelist) 기록.
//     취소를 세면 "요청이 있었다"가 아니라 "요청을 거둬들였다"까지 수요로 잡힌다.
//
// 기준 시각을 쓰는 이유: 중단 **이전**에 팔리던 시절의 견적까지 세면 그건 과거 판매이력이지
// 「지금도 찾는다」는 신호가 아니다. 판매재개 판단에 쓰려면 중단 이후만 세야 한다.
// =====================================================================
import { query } from './db.js';

const n = (v) => (v == null ? 0 : Number(v));

// 비활성 SKU + 그 SKU 의 「판매중단 시각」 — 아래 두 쿼리가 공유한다.
const INACTIVE_CTE = `
  WITH inact AS (
    SELECT p.id AS product_id, p.code, p.name, p.inactive_reason,
           COALESCE(
             (SELECT max(l.changed_at) FROM product_status_log l
               WHERE l.product_id = p.id AND l.action = 'deactivate'),
             p.status_changed_at
           ) AS since_at
      FROM products p
     WHERE p.deleted_at IS NULL AND p.is_active = FALSE
  )`;

// 견적 줄이 「중단 이후 요청」인지 — 두 쿼리에서 같은 문장을 쓴다.
const AFTER_STOP = `
      q.deleted_at IS NULL
  AND q.status NOT IN ('cancelled','pricelist')
  AND ( (i.since_at IS NOT NULL AND q.created_at >= i.since_at)
        OR ql.issue = 'inactive' )`;

/**
 * SKU 별 요약 — 제품 목록 배지·판매재개 판단 화면용.
 * productIds 를 주면 그 SKU 만(목록 한 페이지), 안 주면 비활성 SKU 전체.
 * 반환: [{ product_id, code, name, inactive_reason, since_at, req_n, req_qty, cust_n, first_at, last_at }]
 */
export async function demandSummary({ productIds = null, exec = query } = {}) {
  const ids = Array.isArray(productIds)
    ? productIds.map(Number).filter((x) => Number.isFinite(x) && x > 0) : null;
  if (ids && !ids.length) return [];
  const args = [];
  let filter = '';
  if (ids) { args.push(ids); filter = ` AND i.product_id = ANY($${args.length}::bigint[])`; }
  const sql = `${INACTIVE_CTE}
    SELECT i.product_id, i.code, i.name, i.inactive_reason, i.since_at,
           COUNT(DISTINCT q.id)::int                       AS req_n,
           COALESCE(SUM(ql.qty), 0)                        AS req_qty,
           COUNT(DISTINCT q.customer_id)::int              AS cust_n,
           MIN(q.created_at)                               AS first_at,
           MAX(q.created_at)                               AS last_at
      FROM inact i
      JOIN quote_lines ql ON ql.product_id = i.product_id
      JOIN quotes q       ON q.id = ql.quote_id
     WHERE ${AFTER_STOP}${filter}
     GROUP BY i.product_id, i.code, i.name, i.inactive_reason, i.since_at
     ORDER BY COUNT(DISTINCT q.id) DESC, MAX(q.created_at) DESC`;
  const rows = (await exec(sql, args)).rows;
  return rows.map((r) => ({
    product_id: Number(r.product_id), code: r.code, name: r.name,
    inactive_reason: r.inactive_reason || null,
    since_at: r.since_at || null,
    req_n: n(r.req_n), req_qty: n(r.req_qty), cust_n: n(r.cust_n),
    first_at: r.first_at || null, last_at: r.last_at || null,
  }));
}

/**
 * 한 SKU 의 요청 내역(견적 1건 = 1줄) — 드릴다운·엑셀용.
 * 반환: [{ quote_id, quote_no, quote_date, created_at, customer, qty, status, origin, creator }]
 */
export async function demandRows(productId, exec = query) {
  const id = Number(productId);
  if (!Number.isFinite(id) || id <= 0) return { since_at: null, items: [] };
  const head = (await exec(`${INACTIVE_CTE} SELECT * FROM inact WHERE product_id=$1`, [id])).rows[0];
  if (!head) return { since_at: null, items: [] };   // 활성 SKU 이거나 삭제됨
  const rows = (await exec(`${INACTIVE_CTE}
    SELECT q.id, q.quote_no, q.external_quote_no, q.quote_date::text AS quote_date, q.created_at,
           q.status, q.origin, q.invoice_id,
           COALESCE(NULLIF(cu.name,''), NULLIF(q.guest_name,'')) AS customer,
           cu.id AS customer_id, u.name AS creator,
           SUM(ql.qty) AS qty, MAX(ql.issue) AS issue
      FROM inact i
      JOIN quote_lines ql ON ql.product_id = i.product_id
      JOIN quotes q       ON q.id = ql.quote_id
      LEFT JOIN customers cu ON cu.id = q.customer_id
      LEFT JOIN users u      ON u.id = q.created_by
     WHERE i.product_id = $1 AND ${AFTER_STOP}
     GROUP BY q.id, cu.name, cu.id, u.name
     ORDER BY q.created_at DESC, q.id DESC`, [id])).rows;
  return {
    since_at: head.since_at || null,
    code: head.code, name: head.name, inactive_reason: head.inactive_reason || null,
    items: rows.map((r) => ({
      quote_id: Number(r.id), quote_no: r.quote_no || null,
      external_quote_no: r.external_quote_no || null,
      quote_date: r.quote_date ? String(r.quote_date).slice(0, 10) : null,
      created_at: r.created_at, status: r.status,
      // 출처: 포털(웹카달록) 수신인지 ERP 화면에서 만든 것인지 — 수요의 성격이 다르다.
      origin: r.origin === 'crm' ? 'web' : 'erp',
      customer: r.customer || null,
      customer_id: r.customer_id ? Number(r.customer_id) : null,
      creator: r.creator || null,
      qty: n(r.qty), issue: r.issue || null,
    })),
  };
}

export default { demandSummary, demandRows };
