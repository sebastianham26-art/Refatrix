import { query } from '../db.js';
import { authGuard, requireDirector } from '../middleware/authGuard.js';

// ---- 업무시간 계산 (UTC-6 Nuevo León, 월~금 07:30~17:00, 서머타임 없음) ----
const TZ_OFFSET_MIN = -6 * 60;
const OPEN_MIN = 7 * 60 + 30;   // 07:30
const CLOSE_MIN = 17 * 60;      // 17:00
function bizMinutes(start, end) {
  const s = new Date(start), e = new Date(end);
  if (!(s instanceof Date) || isNaN(s) || isNaN(e) || e <= s) return 0;
  const toMx = (d) => new Date(d.getTime() + TZ_OFFSET_MIN * 60000); // MX 벽시계를 UTC 필드로
  let cur = toMx(s);
  const end2 = toMx(e);
  let total = 0;
  let guard = 0;
  while (cur < end2 && guard++ < 4000) {
    const dow = cur.getUTCDay(); // 0=일 ... 6=토
    const dayStart = new Date(cur); dayStart.setUTCHours(0, 0, 0, 0);
    if (dow >= 1 && dow <= 5) {
      const openT = new Date(dayStart.getTime() + OPEN_MIN * 60000);
      const closeT = new Date(dayStart.getTime() + CLOSE_MIN * 60000);
      const segS = cur > openT ? cur : openT;
      const segE = end2 < closeT ? end2 : closeT;
      if (segE > segS) total += (segE - segS) / 60000;
    }
    cur = new Date(dayStart.getTime() + 24 * 3600000);
  }
  return total;
}
const hoursBetween = (a, b) => (new Date(b) - new Date(a)) / 3600000;
const daysBetween = (a, b) => (new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000;
const num = (v) => (v == null ? null : Number(v));
const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

async function getKpi() {
  const r = (await query(`SELECT order_hours, packing_hours, sat_hours FROM process_sla_kpi WHERE id=1`)).rows[0]
    || { order_hours: 48, packing_hours: 6, sat_hours: 3 };
  return { order: Number(r.order_hours), packing: Number(r.packing_hours), sat: Number(r.sat_hours) };
}

export default async function processKpiRoutes(app) {
  // ---- KPI 조회 (디렉터) ----
  app.get('/api/process/kpi', { preHandler: [authGuard, requireDirector] }, async () => {
    const k = await getKpi();
    return { order_hours: k.order, packing_hours: k.packing, sat_hours: k.sat };
  });

  // ---- KPI 저장 (디렉터) ----
  app.put('/api/process/kpi', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const b = req.body || {};
    const oh = Number(b.order_hours), ph = Number(b.packing_hours), sh = Number(b.sat_hours);
    for (const v of [oh, ph, sh]) {
      if (!isFinite(v) || v <= 0) return reply.code(400).send({ error: 'invalid_kpi' });
    }
    await query(
      `UPDATE process_sla_kpi SET order_hours=$1, packing_hours=$2, sat_hours=$3, updated_by=$4, updated_at=now() WHERE id=1`,
      [oh, ph, sh, req.ctx.perm.userId]);
    return { ok: true, order_hours: oh, packing_hours: ph, sat_hours: sh };
  });

  // ---- 프로세스 분석 (디렉터) ----
  // GET /api/process/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD&group=week|month|customer
  app.get('/api/process/analytics', { preHandler: [authGuard, requireDirector] }, async (req) => {
    const q = req.query || {};
    const from = String(q.from || '').slice(0, 10);
    const to = String(q.to || '').slice(0, 10);
    const group = ['week', 'month', 'customer'].includes(q.group) ? q.group : 'week';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return { error: 'bad_range', kpi: await getKpi() };
    }
    const kpi = await getKpi();

    // 견적(오더) 기준 한 행 = 4단계 (quotes.invoice_id 로 인보이스 연결)
    const rows = (await query(
      `SELECT q.id, q.quote_no, q.created_at, q.packing_printed_at,
              c.name AS customer_name,
              pd.uploaded_at AS packed_at,
              si.id AS invoice_id, si.created_at AS inv_created_at, si.inv_date, si.credit_days,
              si.total_mxn, si.sat_no, si.sat_entered_at,
              (SELECT COALESCE(SUM(spa.amount),0) FROM sales_payment_allocations spa WHERE spa.invoice_id=si.id) AS paid_amount,
              (SELECT MAX(sp.pay_date) FROM sales_payment_allocations spa
                 JOIN sales_payments sp ON sp.id=spa.payment_id WHERE spa.invoice_id=si.id) AS last_pay_date
         FROM quotes q
         JOIN customers c ON c.id = q.customer_id
         LEFT JOIN quote_packing_docs pd ON pd.quote_id = q.id
         LEFT JOIN sales_invoices si ON si.id = q.invoice_id AND si.deleted_at IS NULL
        WHERE q.created_at >= $1::date AND q.created_at < ($2::date + INTERVAL '1 day')
        ORDER BY q.created_at DESC`,
      [from, to])).rows;

    const fromMs = new Date(from + 'T00:00:00Z').getTime();
    const weekIndex = (d) => Math.floor((new Date(d).getTime() - fromMs) / (7 * 86400000));
    const pct = (kpiH, actualH) => (actualH && actualH > 0 ? (kpiH / actualH) * 100 : null);

    const orders = [];
    const groups = new Map(); // key -> {label, sums:[4], counts:[4]}
    const ensure = (key, label) => {
      if (!groups.has(key)) groups.set(key, { label, sums: [0, 0, 0, 0], counts: [0, 0, 0, 0] });
      return groups.get(key);
    };

    for (const r of rows) {
      // 단계별 실제 소요 + 달성%
      const orderH = r.packing_printed_at ? hoursBetween(r.created_at, r.packing_printed_at) : null;
      const packBh = (r.packing_printed_at && r.packed_at) ? bizMinutes(r.packing_printed_at, r.packed_at) / 60 : null;
      const satReal = r.invoice_id && r.sat_entered_at && r.sat_no && !String(r.sat_no).startsWith('TMP-');
      const satH = satReal ? hoursBetween(r.inv_created_at, r.sat_entered_at) : null;
      const fullyPaid = r.invoice_id && Number(r.paid_amount) >= Number(r.total_mxn || 0) && Number(r.total_mxn || 0) > 0 && r.last_pay_date;
      const collectDays = fullyPaid ? Math.max(0, daysBetween(String(r.inv_date), String(r.last_pay_date))) : null;
      const creditDays = r.credit_days != null ? Number(r.credit_days) : null;

      const aOrder = pct(kpi.order, orderH);
      const aPack = pct(kpi.packing, packBh);
      const aSat = pct(kpi.sat, satH);
      const aCollect = (fullyPaid && creditDays != null)
        ? (collectDays > 0 ? (creditDays / collectDays) * 100 : 200) : null; // 같은날 완납=초과달성

      // 그룹 누적
      let key, label;
      if (group === 'customer') { key = r.customer_name || '(미지정)'; label = key; }
      else if (group === 'month') { const d = new Date(r.created_at); key = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); label = (d.getUTCMonth() + 1) + '월'; }
      else { const wi = weekIndex(r.created_at); key = 'w' + wi; label = (wi + 1) + '주'; }
      const g = ensure(key, label);
      [aOrder, aPack, aSat, aCollect].forEach((v, i) => { if (v != null) { g.sums[i] += v; g.counts[i] += 1; } });

      orders.push({
        quote_no: r.quote_no || ('#' + r.id),
        customer: r.customer_name || '-',
        created_at: r.created_at,
        order_h: round1(orderH), order_pct: round1(aOrder),
        packing_h: round1(packBh), packing_pct: round1(aPack),
        sat_h: round1(satH), sat_pct: round1(aSat),
        collect_days: collectDays != null ? Math.round(collectDays) : null,
        credit_days: creditDays, collect_pct: round1(aCollect),
        sat_pending: !!(r.invoice_id && !satReal),
        collect_pending: !!(r.invoice_id && !fullyPaid),
      });
    }

    const lines = [...groups.values()]
      .map((g) => ({
        label: g.label,
        points: g.sums.map((s, i) => (g.counts[i] ? Math.round((s / g.counts[i]) * 10) / 10 : null)),
        n: g.counts,
      }))
      .sort((a, b) => String(a.label).localeCompare(String(b.label), 'ko', { numeric: true }));

    return { kpi: { order_hours: kpi.order, packing_hours: kpi.packing, sat_hours: kpi.sat }, group, from, to, stages: ['오더확정', '피킹/포장', 'SAT 발행', '수금'], lines, orders };
  });
}
