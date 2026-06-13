import { query } from '../db.js';
import { authGuard, requirePage } from '../middleware/authGuard.js';

function r2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
const SRC_LABEL = { sales_edit: '매출 수정', sales_delete: '매출 삭제', import_cost: '수입 부대비용' };

/**
 * 정산차액(수입원가 정산차액) 집계 — 비현금 손익 조정.
 * 두 원천을 통합:
 *   1) cogs_adjustments  (kind='variance')        : 매출 수정/삭제(마감월)  source=sales_edit|sales_delete
 *   2) import_cost_adjustments (variance_expense)  : 수입 부대비용(마감월)   source=import_cost
 * 인식 시점 = 조정이 기록된 달(created_at). 현금흐름과는 분리.
 */
export default async function settlementVarianceRoutes(app) {
  app.get('/api/settlement/variances', { preHandler: [authGuard, requirePage('settlement')] }, async (req) => {
    const year = req.query.year ? String(req.query.year) : null;
    const yArg = year ? [year] : [];

    // 통합 행 (UNION) — sales 측
    const salesRows = (await query(
      `SELECT ca.id, to_char(ca.created_at,'YYYY-MM-DD') AS booked_date, to_char(ca.created_at,'YYYY-MM') AS ym,
              ca.source, ca.diff_mxn AS amount, ca.sales_invoice_id AS ref_id,
              s.sat_no, c.name AS customer_name, p.code AS product_code, p.name AS product_name
         FROM cogs_adjustments ca
         LEFT JOIN sales_invoices s ON s.id=ca.sales_invoice_id
         LEFT JOIN customers c ON c.id=s.customer_id
         LEFT JOIN products p ON p.id=ca.product_id
        WHERE ca.kind='variance' AND ${year ? `to_char(ca.created_at,'YYYY')=$1` : 'TRUE'}
        ORDER BY ca.created_at DESC`, yArg)).rows;

    // 수입 부대비용 측
    const importRows = (await query(
      `SELECT ica.id, to_char(ica.created_at,'YYYY-MM-DD') AS booked_date, to_char(ica.created_at,'YYYY-MM') AS ym,
              'import_cost' AS source, ica.variance_expense_mxn AS amount, ica.doc_id AS ref_id,
              ica.closed_month, p.code AS product_code, p.name AS product_name
         FROM import_cost_adjustments ica
         LEFT JOIN products p ON p.id=ica.product_id
        WHERE ica.variance_expense_mxn <> 0 AND ${year ? `to_char(ica.created_at,'YYYY')=$1` : 'TRUE'}
        ORDER BY ica.created_at DESC`, yArg)).rows;

    const items = [
      ...salesRows.map((r) => ({
        id: 's' + r.id, booked_date: r.booked_date, ym: r.ym, source: r.source, source_label: SRC_LABEL[r.source] || r.source,
        amount: r2(r.amount), ref: r.sat_no || (r.ref_id ? '인보이스 #' + r.ref_id : '—'),
        customer: r.customer_name || null, product: r.product_code ? (r.product_code + (r.product_name ? ' · ' + r.product_name : '')) : null,
      })),
      ...importRows.map((r) => ({
        id: 'i' + r.id, booked_date: r.booked_date, ym: r.ym, source: r.source, source_label: SRC_LABEL.import_cost,
        amount: r2(r.amount), ref: r.ref_id ? '부대비용 #' + r.ref_id : '—',
        customer: null, product: r.product_code ? (r.product_code + (r.product_name ? ' · ' + r.product_name : '')) : null,
        closed_month: r.closed_month,
      })),
    ].sort((a, b) => (a.booked_date < b.booked_date ? 1 : -1));

    // 원천별 합계
    const bySource = {};
    for (const it of items) { bySource[it.source] = r2((bySource[it.source] || 0) + it.amount); }
    // 월별 합계(원천별)
    const byMonthMap = {};
    for (const it of items) {
      const m = (byMonthMap[it.ym] ||= { ym: it.ym, sales_edit: 0, sales_delete: 0, import_cost: 0, total: 0 });
      m[it.source] = r2((m[it.source] || 0) + it.amount);
      m.total = r2(m.total + it.amount);
    }
    const byMonth = Object.values(byMonthMap).sort((a, b) => (a.ym < b.ym ? 1 : -1));
    const total = r2(items.reduce((s, it) => s + it.amount, 0));

    return {
      year, total,
      bySource: Object.keys(bySource).map((k) => ({ source: k, source_label: SRC_LABEL[k] || k, amount: bySource[k] })),
      byMonth, items,
      note: '정산차액은 비현금 손익(원가) 조정입니다. 통장 잔액/현금흐름에는 반영되지 않으며, 발생한 달의 손익에 인식됩니다.',
    };
  });
}
