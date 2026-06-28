import { query } from '../db.js';
import { authGuard, requireDirector } from '../middleware/authGuard.js';
import { ORDER_WINDOW_DAYS, ORDER_WAIT_STATUSES } from '../processWindow.js';
import { bizMinutes } from '../businessHours.js';

const hoursBetween = (a, b) => (new Date(b) - new Date(a)) / 3600000;
const daysBetween = (a, b) => (new Date(String(b).slice(0, 10) + 'T00:00:00Z') - new Date(String(a).slice(0, 10) + 'T00:00:00Z')) / 86400000;
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
      `SELECT q.id, q.quote_no, q.status, q.created_at,
              COALESCE((SELECT MIN(occurred_at) FROM audit_log WHERE action='print' AND target='packing_print' AND detail->>'quote_id' = q.id::text), q.packing_printed_at) AS packing_printed_at,
              c.name AS customer_name,
              pd.uploaded_at AS packed_at,
              si.id AS invoice_id, si.created_at AS inv_created_at, si.inv_date::text AS inv_date, si.due_date::text AS due_date, si.credit_days,
              si.total_mxn, si.sat_no, si.sat_entered_at,
              (SELECT COALESCE(SUM(spa.amount),0) FROM sales_payment_allocations spa WHERE spa.invoice_id=si.id) AS paid_amount,
              (SELECT MAX(sp.pay_date)::text FROM sales_payment_allocations spa
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

    const nowMs = Date.now();
    const stageOut = (state, value, kpiVal, isDays) => {
      // state: done|wip|none|expired ; value: 소요(done) 또는 경과(wip)
      let over = false;
      if ((state === 'done' || state === 'wip') && value != null && kpiVal != null) over = value > kpiVal;
      return { state, value: value == null ? null : (isDays ? Math.round(value) : round1(value)), over };
    };

    const today = new Date(nowMs - 6 * 3600000).toISOString().slice(0, 10); // MX(UTC-6) 오늘
    const abandonCutoff = nowMs - ORDER_WINDOW_DAYS * 86400000;
    for (const r of rows) {
      const st = String(r.status || '');
      const printed = !!r.packing_printed_at;
      const createdMs = new Date(r.created_at).getTime();
      // 오더확정: 인쇄=done / 미인쇄+대기상태(draft·confirmed·expired)+30일내=wip / 30일초과=abandoned(포기) / 그 외 상태=none
      let oState, orderH;
      if (printed) { oState = 'done'; orderH = hoursBetween(r.created_at, r.packing_printed_at); }
      else if (!ORDER_WAIT_STATUSES.includes(st)) { oState = 'none'; orderH = null; }
      else if (createdMs < abandonCutoff) { oState = 'abandoned'; orderH = hoursBetween(r.created_at, nowMs); }
      else { oState = 'wip'; orderH = hoursBetween(r.created_at, nowMs); }
      // 피킹/포장: 미인쇄=none / 전환됨=none(SLA 일치) / 포장완료=done / 그 외=wip (업무시간+실 병기)
      let pState, packBh, packWall = null;
      if (!printed) { pState = 'none'; packBh = null; }
      else if (r.packed_at) { pState = 'done'; packBh = bizMinutes(r.packing_printed_at, r.packed_at) / 60; packWall = hoursBetween(r.packing_printed_at, r.packed_at); }
      else if (st === 'converted') { pState = 'none'; packBh = null; }
      else { pState = 'wip'; packBh = bizMinutes(r.packing_printed_at, nowMs) / 60; packWall = hoursBetween(r.packing_printed_at, nowMs); }
      // SAT: 인보이스 없음=none / 실SAT번호=done / 그 외(없음·빈값·TMP)=wip (SLA 일치)
      const satRealNo = r.invoice_id && r.sat_no && String(r.sat_no) !== '' && !String(r.sat_no).startsWith('TMP-');
      let sState, satH;
      if (!r.invoice_id) { sState = 'none'; satH = null; }
      else if (satRealNo) { sState = 'done'; satH = r.sat_entered_at ? hoursBetween(r.inv_created_at, r.sat_entered_at) : null; }
      else { sState = 'wip'; satH = hoursBetween(r.inv_created_at, nowMs); }
      // 수금: SLA 일치 — 실SAT+만기일 있는 인보이스만 수금단계. 완납=done / 미완납=wip / 그 전=none
      const fullyPaid = r.invoice_id && Number(r.paid_amount) >= Number(r.total_mxn || 0) && Number(r.total_mxn || 0) > 0 && r.last_pay_date;
      const creditDays = r.credit_days != null ? Number(r.credit_days) : null;
      const inCollect = satRealNo && r.due_date != null;
      let cState, collectDays;
      if (!inCollect) { cState = 'none'; collectDays = null; }
      else if (fullyPaid) { cState = 'done'; collectDays = Math.max(0, daysBetween(String(r.inv_date), String(r.last_pay_date))); }
      else { cState = 'wip'; collectDays = Math.max(0, daysBetween(String(r.inv_date), today)); }

      // 달성%(그래프) — 완료 단계만
      const aOrder = oState === 'done' ? pct(kpi.order, orderH) : null;
      const aPack = pState === 'done' ? pct(kpi.packing, packBh) : null;
      const aSat = sState === 'done' ? pct(kpi.sat, satH) : null;
      const aCollect = (cState === 'done' && creditDays != null) ? (collectDays > 0 ? (creditDays / collectDays) * 100 : 200) : null;

      // 그룹 누적(완료만)
      let key, label;
      if (group === 'customer') { key = r.customer_name || '(미지정)'; label = key; }
      else if (group === 'month') { const d = new Date(r.created_at); key = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); label = (d.getUTCMonth() + 1) + '월'; }
      else { const wi = weekIndex(r.created_at); key = 'w' + wi; label = (wi + 1) + '주'; }
      const g = ensure(key, label);
      [aOrder, aPack, aSat, aCollect].forEach((v, i) => { if (v != null) { g.sums[i] += v; g.counts[i] += 1; } });

      const so = stageOut(oState, orderH, kpi.order, false);
      const sp = stageOut(pState, packBh, kpi.packing, false);
      const ss = stageOut(sState, satH, kpi.sat, false);
      const sc = stageOut(cState, collectDays, creditDays, true);
      orders.push({
        quote_no: r.quote_no || ('#' + r.id),
        customer: r.customer_name || '-',
        created_at: r.created_at,
        order_h: so.value, order_state: so.state, order_over: so.over, order_pct: round1(aOrder),
        packing_h: sp.value, packing_state: sp.state, packing_over: sp.over, packing_pct: round1(aPack), packing_wall_h: round1(packWall),
        sat_h: ss.value, sat_state: ss.state, sat_over: ss.over, sat_pct: round1(aSat),
        collect_days: sc.value, collect_state: sc.state, collect_over: sc.over, credit_days: creditDays, collect_pct: round1(aCollect),
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
