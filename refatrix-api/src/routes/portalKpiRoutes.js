import { query } from '../db.js';
import { authGuard } from '../middleware/authGuard.js';
import { fieldVisible } from '../permissions.js';

function r2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
function prevYm(ym, n) { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 1 - n, 1)).toISOString().slice(0, 7); }

// 전사 월 매출목표 (monthly_targets 우선, 없으면 고객월목표 합)
async function companyTarget(ym) {
  const r = (await query(`SELECT COALESCE(amount,0) AS a FROM monthly_targets WHERE ym=$1`, [ym])).rows[0];
  let t = r ? Number(r.a) : 0;
  if (!t) t = Number((await query(`SELECT COALESCE(SUM(amount),0) AS a FROM target_customer_months WHERE ym=$1`, [ym])).rows[0].a);
  return t;
}
// 전사 월 매출실적 (ex-IVA 소계, posted)
async function companyActual(ym) {
  return Number((await query(
    `SELECT COALESCE(SUM(i.subtotal_mxn),0) AS a FROM sales_invoices i
       JOIN customers c ON c.id=i.customer_id
      WHERE i.status='posted' AND to_char(i.inv_date,'YYYY-MM')=$1 AND c.deleted_at IS NULL`, [ym])).rows[0].a);
}

/**
 * 포털 공통 KPI — 모든 사용자 동일(전사 기준).
 *  · 당월 매출목표 대비 실적 진행률
 *  · 최근 12개월 월별 목표 vs 실적
 * 금액(MXN)은 sales_amount 권한자에게만 노출, 진행률(%)은 모두에게.
 */
export default async function portalKpiRoutes(app) {
  app.get('/api/portal/kpi', { preHandler: [authGuard] }, async (req) => {
    const perm = req.ctx.perm;
    const seeAmount = fieldVisible(perm, 'sales_amount');
    const months = Math.min(Math.max(Number(req.query.months) || 12, 1), 24);
    const thisYm = new Date().toISOString().slice(0, 7);

    // 최근 N개월(과거→현재)
    const yms = [];
    for (let i = months - 1; i >= 0; i--) yms.push(prevYm(thisYm, i));

    const series = [];
    for (const ym of yms) {
      const target = await companyTarget(ym);
      const actual = await companyActual(ym);
      const progress = target > 0 ? r2(actual / target * 100) : null;
      series.push({
        ym,
        target: seeAmount ? r2(target) : null,
        actual: seeAmount ? r2(actual) : null,
        progress,
      });
    }
    const cur = series[series.length - 1];
    const curTarget = await companyTarget(thisYm);
    const curActual = await companyActual(thisYm);

    return {
      seeAmount,
      month: {
        ym: thisYm,
        target: seeAmount ? r2(curTarget) : null,
        actual: seeAmount ? r2(curActual) : null,
        progress: curTarget > 0 ? r2(curActual / curTarget * 100) : null,
        remaining: seeAmount && curTarget > 0 ? r2(Math.max(curTarget - curActual, 0)) : null,
      },
      series,
      note: '전사 기준 · 매출 실적은 IVA 제외 소계, 등록(posted) 인보이스 기준입니다.',
    };
  });
}
