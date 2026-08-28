// =====================================================================
// Refatrix ERP · 성과급(Bono) + 목표 대비 진척
//   커미션(율 기반)과 분리된 축. 이 파일은 commissionRoutes.js 에서 호출해 라우트를 등록한다.
//
//   핵심 규칙
//    · 매출목표 = 디렉터가 월별로 직접 입력(수동, ex-IVA).
//    · 수금목표 = 저장하지 않고 산출한다.
//        만기일 = 인보이스 due_date (없으면 inv_date + credit_days)
//        당월 만기도래액 = Σ subtotal(ex-IVA) WHERE 만기일 ∈ 그 달
//        연체 이월분     = Σ 미수잔액(ex-IVA) WHERE 만기일 < 월초 AND 월초 시점 미수
//        수금목표 = 당월 만기도래액 + (옵션) 연체 이월분
//      → 영업사원이 손댈 수 없는 값이라 목표 조작 여지가 없다.
//      → 미래 월은 아직 발행되지 않은 매출의 만기가 빠져 있어 잠정치(provisional).
//    · 달성률 = 실적 ÷ 목표. 성과급은 달성률 구간별 정액(계단식), 가장 높은 충족 구간 하나만.
//    · 모든 금액은 IVA 제외(ex-IVA). 수금액은 (충당액 × subtotal/total)로 ex-IVA 환산.
// =====================================================================
import { query, withTx } from '../db.js';
import { authGuard, requirePage, requireDirector } from '../middleware/authGuard.js';
import { round2 } from '../permissions.js';
import { logEvent } from '../audit.js';

export const SEE_ALL_ROLES = ['director', 'treasury', 'socio'];
export const canSeeAll = (perm) => SEE_ALL_ROLES.includes(perm.role);

// ── 날짜 유틸 (순수·벽시계 무관) ──────────────────────────────────────
export const ymOf = (d) => (d ? String(d).slice(0, 7) : null);
export const monthStart = (ym) => `${ym}-01`;
export function daysInMonth(ym) {
  const [y, m] = String(ym).split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
export function monthEnd(ym) { return `${ym}-${String(daysInMonth(ym)).padStart(2, '0')}`; }
export function addMonth(ym, n) {
  const [y, m] = String(ym).split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
export function monthRange(from, to) {
  if (!/^\d{4}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}$/.test(to || '')) return [];
  const out = [];
  let m = from;
  for (let i = 0; i < 240 && m <= to; i++) { out.push(m); m = addMonth(m, 1); }
  return out;
}
// 월 경과율 (오늘이 그 달이면 경과일/총일수, 지난 달=1, 미래=0)
export function elapsedRatio(ym, today) {
  if (!ym || !today) return 1;
  const cur = ymOf(today);
  if (ym < cur) return 1;
  if (ym > cur) return 0;
  return Number(today.slice(8, 10)) / daysInMonth(ym);
}

// ── 구간 판정 ────────────────────────────────────────────────────────
// 달성률이 하한 이상인 구간 중 가장 높은 것 하나. 최저 구간 미만이면 null.
export function pickTier(tiers, rate) {
  if (rate == null || !Array.isArray(tiers) || !tiers.length) return null;
  const sorted = [...tiers].map((t) => ({ min_rate: Number(t.min_rate), amount: Number(t.amount) }))
    .sort((a, b) => b.min_rate - a.min_rate);
  return sorted.find((t) => Number(rate) + 1e-9 >= t.min_rate) || null;
}
// 아직 도달하지 못한 다음 구간(더 채우면 오를 구간)
export function nextTier(tiers, rate) {
  if (!Array.isArray(tiers) || !tiers.length) return null;
  const sorted = [...tiers].map((t) => ({ min_rate: Number(t.min_rate), amount: Number(t.amount) }))
    .sort((a, b) => a.min_rate - b.min_rate);
  const r = rate == null ? -1 : Number(rate);
  return sorted.find((t) => t.min_rate > r + 1e-9) || null;
}

// ── 성과급 정책 검증 (순수) ──────────────────────────────────────────
export function validateBonusPlan(input) {
  const b = input || {};
  const enabled = b.enabled !== false;
  if (!enabled) return { ok: true, plan: { enabled: false, basis: 'revenue', start_month: b.start_month || '2026-01', end_month: null, include_overdue: true, partial_credit: true }, targets: {}, tiers: [] };

  const basis = b.basis === 'collection' ? 'collection' : (b.basis === 'revenue' ? 'revenue' : null);
  if (!basis) return { ok: false, error: 'bad_basis', note: '목표 기준은 매출(revenue) 또는 수금(collection)이어야 합니다.' };
  const start = String(b.start_month || '');
  if (!/^\d{4}-\d{2}$/.test(start)) return { ok: false, error: 'bad_start_month', note: '적용 시작월(YYYY-MM)을 지정하세요.' };
  const end = b.end_month ? String(b.end_month) : null;
  if (end !== null && !/^\d{4}-\d{2}$/.test(end)) return { ok: false, error: 'bad_end_month', note: '적용 종료월 형식이 올바르지 않습니다.' };
  if (end !== null && end < start) return { ok: false, error: 'end_before_start', note: `적용 종료월(${end})이 시작월(${start})보다 빠릅니다.` };

  const rawTiers = Array.isArray(b.tiers) ? b.tiers : [];
  if (!rawTiers.length) return { ok: false, error: 'no_tiers', note: '달성률 구간을 최소 한 개 지정해야 합니다.' };
  const tiers = [];
  for (const t of rawTiers) {
    const min = Number(t.min_rate);
    const amt = Number(t.amount);
    if (!(min >= 0)) return { ok: false, error: 'bad_tier_rate', note: '달성률 하한(%)은 0 이상이어야 합니다.' };
    if (!(amt >= 0)) return { ok: false, error: 'bad_tier_amount', note: '성과급 금액은 0 이상이어야 합니다.' };
    if (tiers.some((x) => Math.abs(x.min_rate - min) < 1e-9)) return { ok: false, error: 'dup_tier', note: `달성률 ${min}% 구간이 중복됩니다.` };
    tiers.push({ min_rate: round2(min), amount: round2(amt) });
  }
  tiers.sort((a, b2) => a.min_rate - b2.min_rate);

  const months = end ? monthRange(start, end) : null;
  const targets = {};
  const rawT = (b.targets && typeof b.targets === 'object') ? b.targets : {};
  for (const [m, v] of Object.entries(rawT)) {
    if (!/^\d{4}-\d{2}$/.test(m)) return { ok: false, error: 'bad_target_month', note: `목표 월 형식이 올바르지 않습니다: ${m}` };
    if (m < start || (end && m > end)) continue;             // 적용기간 밖은 버린다
    const n = Number(v);
    if (!(n >= 0)) return { ok: false, error: 'bad_target', note: `${m} 목표금액이 올바르지 않습니다.` };
    targets[m] = round2(n);
  }
  if (basis === 'revenue' && months) {
    const missing = months.filter((m) => !(targets[m] > 0));
    if (missing.length) return { ok: false, error: 'missing_targets', note: `매출 기준이면 모든 월에 목표금액이 필요합니다. 비어 있는 월: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ' 외' : ''}` };
  }

  return {
    ok: true,
    plan: {
      enabled: true, basis, start_month: start, end_month: end,
      include_overdue: b.include_overdue !== false,
      partial_credit: b.partial_credit !== false,
      note: b.note != null ? String(b.note).slice(0, 500) : null,
    },
    targets, tiers,
  };
}

// ── 성과 집계 (순수) ─────────────────────────────────────────────────
// invoices: [{id,sat_no,inv_date,due_date,subtotal,total,customer_id,customer_name,customer_code,
//             credit_days,basis,rate,payout_paid,payout_amount}]
// allocs  : [{invoice_id,pay_date,amount}]  (수금 충당 내역 · 총액 기준)
// plan/tiers/targets: 성과급 정책. plan=null 이면 성과급 없음.
// months  : 집계할 월 배열, today: 'YYYY-MM-DD'
export function buildPerf(opts) {
  const { invoices = [], allocs = [], plan = null, tiers = [], targets = {}, months = [], today = null, customerId = null } = opts || {};
  const curYm = today ? ymOf(today) : null;
  const sum = (arr) => arr.reduce((s, x) => s + (Number(x) || 0), 0);

  const payBy = {};
  for (const a of allocs) {
    (payBy[a.invoice_id] ||= []).push({ date: String(a.pay_date).slice(0, 10), amount: Number(a.amount) || 0 });
  }
  for (const k of Object.keys(payBy)) payBy[k].sort((x, y) => x.date.localeCompare(y.date));

  const inv = invoices.map((i) => {
    const subtotal = Number(i.subtotal) || 0;
    const total = Number(i.total) || 0;
    const ratio = total > 0 ? subtotal / total : 1;          // ex-IVA 환산비
    const pays = payBy[i.id] || [];
    let cum = 0, fullyPaidDate = null;
    for (const p of pays) {
      cum += p.amount;
      if (!fullyPaidDate && total > 0 && cum + 0.01 >= total) fullyPaidDate = p.date;
    }
    return {
      ...i, subtotal, total, ratio, pays, paidTotal: cum, fullyPaidDate,
      dueDate: i.due_date ? String(i.due_date).slice(0, 10) : null,
      invDate: String(i.inv_date).slice(0, 10),
    };
  });

  const partial = !plan || plan.partial_credit !== false;
  const inclOver = !plan || plan.include_overdue !== false;
  const pick = (list) => (customerId ? list.filter((i) => Number(i.customer_id) === Number(customerId)) : list);

  const revIn = (m, list = inv) => round2(sum(pick(list).filter((i) => ymOf(i.invDate) === m).map((i) => i.subtotal)));
  const colIn = (m, list = inv) => round2(partial
    ? sum(pick(list).map((i) => i.pays.filter((p) => ymOf(p.date) === m).reduce((s, p) => s + p.amount, 0) * i.ratio))
    : sum(pick(list).filter((i) => i.fullyPaidDate && ymOf(i.fullyPaidDate) === m).map((i) => i.subtotal)));
  const dueIn = (m, list = inv) => round2(sum(pick(list).filter((i) => i.dueDate && ymOf(i.dueDate) === m).map((i) => i.subtotal)));
  const carryTo = (m, list = inv) => {
    const st = monthStart(m);
    return round2(sum(pick(list).filter((i) => i.dueDate && i.dueDate < st).map((i) => {
      const before = i.pays.filter((p) => p.date < st).reduce((s, p) => s + p.amount, 0);
      return Math.max(0, i.subtotal - before * i.ratio);
    })));
  };
  // 수금목표: 미래 월은 연체 이월을 더하지 않는다(그 시점에 확정됨)
  const colTarget = (m) => round2(dueIn(m) + ((inclOver && (!curYm || m <= curYm)) ? carryTo(m) : 0));
  const revTarget = (m) => round2(Number(targets[m] || 0));

  // 인보이스 1건이 그 달에 인식하는 커미션 (지급된 건은 지급 시점 금액으로 동결)
  const comOfInv = (i, m) => {
    if (!i.basis) return 0;
    const rate = Number(i.rate) || 0;
    const amt = (i.payout_paid === true && i.payout_amount != null) ? Number(i.payout_amount) : round2(i.subtotal * rate / 100);
    if (i.basis === 'revenue') return ymOf(i.invDate) === m ? amt : 0;
    return (i.fullyPaidDate && ymOf(i.fullyPaidDate) === m) ? amt : 0;
  };
  const comIn = (m, list = inv) => round2(sum(pick(list).map((i) => comOfInv(i, m))));

  const inPlan = (m) => !!plan && plan.enabled !== false && m >= plan.start_month && (!plan.end_month || m <= plan.end_month);
  const bonusOf = (m) => {
    if (!inPlan(m)) return { in_plan: false, basis: plan ? plan.basis : null, target: 0, actual: 0, rate: null, amount: 0, tier: null };
    const basis = plan.basis;
    const target = basis === 'revenue' ? revTarget(m) : colTarget(m);
    const actual = basis === 'revenue' ? revIn(m) : colIn(m);
    const rate = target > 0 ? round2(actual / target * 100) : null;
    const t = pickTier(tiers, rate);
    return { in_plan: true, basis, target, actual, rate, amount: t ? round2(t.amount) : 0, tier: t ? t.min_rate : null };
  };

  const rows = months.map((m) => {
    const rT = revTarget(m), rA = revIn(m), cT = colTarget(m), cA = colIn(m);
    const b = bonusOf(m);
    return {
      month: m,
      provisional: !!(curYm && m > curYm),                 // 미래 월 = 수금목표 잠정
      in_progress: !!(curYm && m === curYm),               // 진행중(확정 전)
      revenue: { target: rT, actual: rA, rate: rT > 0 ? round2(rA / rT * 100) : null },
      collection: { target: cT, actual: cA, due: dueIn(m), carry: (inclOver && (!curYm || m <= curYm)) ? carryTo(m) : 0, rate: cT > 0 ? round2(cA / cT * 100) : null },
      commission: comIn(m),
      bonus: b,
      total: round2(comIn(m) + b.amount),
    };
  });

  // 기간 합계 · 고객별 · 인보이스별
  const from = months[0] || null, to = months[months.length - 1] || null;
  const inRangeDate = (d) => !!d && from && to && ymOf(d) >= from && ymOf(d) <= to;
  const rangeInv = pick(inv).filter((i) => inRangeDate(i.invDate) || i.pays.some((p) => inRangeDate(p.date)));

  const custBy = {};
  for (const i of pick(inv)) {
    const g = (custBy[i.customer_id] ||= {
      customer_id: i.customer_id, customer_name: i.customer_name, customer_code: i.customer_code,
      credit_days: i.credit_days, sales: 0, collected: 0, due: 0, open: 0, late: 0, commission: 0, invoice_count: 0,
    });
    if (inRangeDate(i.invDate)) { g.sales = round2(g.sales + i.subtotal); g.invoice_count++; }
    if (i.dueDate && inRangeDate(i.dueDate)) g.due = round2(g.due + i.subtotal);
    const colHere = partial
      ? i.pays.filter((p) => inRangeDate(p.date)).reduce((s, p) => s + p.amount, 0) * i.ratio
      : (i.fullyPaidDate && inRangeDate(i.fullyPaidDate) ? i.subtotal : 0);
    g.collected = round2(g.collected + colHere);
    for (const m of months) g.commission = round2(g.commission + comOfInv(i, m));
    // 미수잔액 = 기간 종료월 말 시점 잔액 / 연체 = 오늘 기준 만기 지난 미수
    const endLimit = to ? monthEnd(to) : null;
    const paidByEnd = endLimit ? i.pays.filter((p) => p.date <= endLimit).reduce((s, p) => s + p.amount, 0) : i.paidTotal;
    const openAmt = (!endLimit || i.invDate <= endLimit) ? Math.max(0, i.subtotal - paidByEnd * i.ratio) : 0;
    g.open = round2(g.open + openAmt);
    if (today && i.dueDate && i.dueDate < today) {
      g.late = round2(g.late + Math.max(0, i.subtotal - i.paidTotal * i.ratio));
    }
  }
  const customers = Object.values(custBy)
    .filter((g) => g.sales || g.collected || g.open || g.due)
    .sort((a, b) => b.sales - a.sales);

  const invoiceRows = rangeInv.map((i) => {
    let status = 'open', lateDays = 0;
    if (i.fullyPaidDate) {
      status = (i.dueDate && i.fullyPaidDate > i.dueDate) ? 'paid_late' : 'paid';
      if (status === 'paid_late') lateDays = Math.round((Date.parse(i.fullyPaidDate) - Date.parse(i.dueDate)) / 864e5);
    } else if (today && i.dueDate && i.dueDate < today) {
      status = 'overdue';
      lateDays = Math.round((Date.parse(today) - Date.parse(i.dueDate)) / 864e5);
    } else if (today && i.dueDate) {
      status = 'due_soon';
      lateDays = -Math.round((Date.parse(i.dueDate) - Date.parse(today)) / 864e5);
    }
    let com = 0;
    for (const m of months) com = round2(com + comOfInv(i, m));
    return {
      invoice_id: i.id, sat_no: i.sat_no, customer_name: i.customer_name, customer_code: i.customer_code,
      inv_date: i.invDate, due_date: i.dueDate, credit_days: i.credit_days,
      subtotal: i.subtotal, paid_amount: round2(i.paidTotal * i.ratio), paid_date: i.fullyPaidDate,
      basis: i.basis || null, rate: i.rate != null ? Number(i.rate) : null,
      commission: com, status, late_days: lateDays,
      open_amount: round2(Math.max(0, i.subtotal - i.paidTotal * i.ratio)),
    };
  }).sort((a, b) => a.inv_date.localeCompare(b.inv_date) || a.invoice_id - b.invoice_id);

  const totals = {
    revenue_target: round2(sum(rows.map((r) => r.revenue.target))),
    revenue: round2(sum(rows.map((r) => r.revenue.actual))),
    collection_target: round2(sum(rows.map((r) => r.collection.target))),
    collection: round2(sum(rows.map((r) => r.collection.actual))),
    commission: round2(sum(rows.map((r) => r.commission))),
    bonus: round2(sum(rows.map((r) => r.bonus.amount))),
    open: round2(sum(customers.map((c) => c.open))),
    late: round2(sum(customers.map((c) => c.late))),
  };
  totals.total = round2(totals.commission + totals.bonus);

  return { months: rows, customers, invoices: invoiceRows, totals };
}

// ── SQL ──────────────────────────────────────────────────────────────
// 인보이스 발행일이 속하는 커미션 기간(기준·율). commissionRoutes.js 와 같은 규칙.
const PERIOD_LATERAL = `
    LEFT JOIN LATERAL (
      SELECT cap.basis, cap.rate
        FROM commission_agent_periods cap
       WHERE cap.user_id = i.owner_id
         AND i.inv_date >= cap.start_date
         AND (cap.end_date IS NULL OR i.inv_date <= cap.end_date)
       ORDER BY cap.start_date DESC
       LIMIT 1
    ) per ON true`;

const AGENT_INVOICES_SQL = `
  SELECT i.id, i.sat_no,
         to_char(i.inv_date,'YYYY-MM-DD') AS inv_date,
         to_char(COALESCE(i.due_date, i.inv_date + COALESCE(i.credit_days,0)),'YYYY-MM-DD') AS due_date,
         i.subtotal_mxn AS subtotal, i.total_mxn AS total,
         COALESCE(i.credit_days, c.credit_days, 0) AS credit_days,
         c.id AS customer_id, c.name AS customer_name, c.code AS customer_code,
         per.basis, COALESCE(ccr.rate, per.rate) AS rate,
         cp.paid AS payout_paid, cp.amount AS payout_amount
    FROM sales_invoices i
    JOIN customers c ON c.id=i.customer_id
    LEFT JOIN commission_customer_rates ccr ON ccr.user_id=i.owner_id AND ccr.customer_id=i.customer_id${PERIOD_LATERAL}
    LEFT JOIN commission_payouts cp ON cp.invoice_id=i.id
   WHERE i.status <> 'deleted' AND i.owner_id=$1
   ORDER BY i.inv_date, i.id`;

const AGENT_ALLOCS_SQL = `
  SELECT spa.invoice_id, to_char(sp.pay_date,'YYYY-MM-DD') AS pay_date, spa.amount
    FROM sales_payment_allocations spa
    JOIN sales_payments sp ON sp.id=spa.payment_id
    JOIN sales_invoices i ON i.id=spa.invoice_id
   WHERE i.owner_id=$1 AND i.status <> 'deleted'`;

// 성과급 정책 로드 (테이블 없으면 null — 마이그레이션 전에도 화면이 죽지 않게)
export async function loadBonusPlan(userId) {
  try {
    const p = (await query(
      `SELECT user_id, enabled, basis, start_month, end_month, include_overdue, partial_credit, note
         FROM bonus_plans WHERE user_id=$1`, [userId])).rows[0];
    if (!p) return { plan: null, tiers: [], targets: {}, migrated: true };
    const tiers = (await query(`SELECT min_rate, amount FROM bonus_tiers WHERE user_id=$1 ORDER BY min_rate`, [userId])).rows
      .map((t) => ({ min_rate: Number(t.min_rate), amount: Number(t.amount) }));
    const trows = (await query(`SELECT month, revenue_target FROM bonus_targets WHERE user_id=$1 ORDER BY month`, [userId])).rows;
    const targets = {};
    for (const t of trows) targets[t.month] = Number(t.revenue_target);
    return {
      plan: {
        user_id: p.user_id, enabled: p.enabled === true, basis: p.basis,
        start_month: p.start_month, end_month: p.end_month || null,
        include_overdue: p.include_overdue === true, partial_credit: p.partial_credit === true,
        note: p.note || null,
      },
      tiers, targets, migrated: true,
    };
  } catch (e) {
    if (e && e.code === '42P01') return { plan: null, tiers: [], targets: {}, migrated: false };
    throw e;
  }
}

export async function loadAgentData(agentId) {
  const invoices = (await query(AGENT_INVOICES_SQL, [agentId])).rows.map((r) => ({
    id: Number(r.id), sat_no: r.sat_no, inv_date: r.inv_date, due_date: r.due_date,
    subtotal: Number(r.subtotal), total: Number(r.total), credit_days: Number(r.credit_days || 0),
    customer_id: Number(r.customer_id), customer_name: r.customer_name, customer_code: r.customer_code,
    basis: r.basis || null, rate: r.rate != null ? Number(r.rate) : null,
    payout_paid: r.payout_paid === true, payout_amount: r.payout_amount != null ? Number(r.payout_amount) : null,
  }));
  const allocs = (await query(AGENT_ALLOCS_SQL, [agentId])).rows.map((r) => ({
    invoice_id: Number(r.invoice_id), pay_date: r.pay_date, amount: Number(r.amount),
  }));
  return { invoices, allocs };
}

const todayStr = () => new Date().toISOString().slice(0, 10);

// ── 월 확정 시 성과급 스냅샷 (commissionRoutes 의 batches confirm 에서 호출) ──
// 그 달 성과급을 계산해 bonus_payouts 에 동결 저장. 테이블 없으면 조용히 건너뛴다.
export async function snapshotBonusForMonth(ym, byUserId) {
  let plans;
  try {
    plans = (await query(
      `SELECT bp.user_id FROM bonus_plans bp
         JOIN commission_agents ca ON ca.user_id=bp.user_id AND ca.active=true
        WHERE bp.enabled=true AND bp.start_month <= $1 AND (bp.end_month IS NULL OR bp.end_month >= $1)`, [ym])).rows;
  } catch (e) {
    if (e && e.code === '42P01') return { skipped: true, count: 0 };
    throw e;
  }
  let count = 0;
  for (const p of plans) {
    const uid = Number(p.user_id);
    const { plan, tiers, targets } = await loadBonusPlan(uid);
    if (!plan || !plan.enabled) continue;
    const { invoices, allocs } = await loadAgentData(uid);
    const perf = buildPerf({ invoices, allocs, plan, tiers, targets, months: [ym], today: todayStr() });
    const row = perf.months[0];
    if (!row || !row.bonus.in_plan) continue;
    const exists = (await query(`SELECT id, paid FROM bonus_payouts WHERE user_id=$1 AND settle_ym=$2`, [uid, ym])).rows[0];
    if (exists && exists.paid === true) continue;            // 지급된 건은 동결 유지
    await query(
      `INSERT INTO bonus_payouts (user_id, settle_ym, basis, target_amount, actual_amount, achieved_rate, tier_min_rate, amount, confirmed_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
       ON CONFLICT (user_id, settle_ym) DO UPDATE SET
         basis=$3, target_amount=$4, actual_amount=$5, achieved_rate=$6, tier_min_rate=$7, amount=$8,
         updated_by=$9, updated_at=now()`,
      [uid, ym, row.bonus.basis, row.bonus.target, row.bonus.actual, row.bonus.rate, row.bonus.tier, row.bonus.amount, byUserId]);
    count++;
  }
  return { skipped: false, count };
}

// ── 확정·미지급 성과급 1건 (지급 전표에서 사용) ──
export async function payableBonus(agentId, settleYm) {
  try {
    const r = (await query(
      `SELECT id, amount, achieved_rate, target_amount, actual_amount, basis
         FROM bonus_payouts WHERE user_id=$1 AND settle_ym=$2 AND paid=false AND amount > 0`,
      [agentId, settleYm])).rows[0];
    if (!r) return null;
    return {
      id: Number(r.id), amount: round2(Number(r.amount)), basis: r.basis,
      achieved_rate: r.achieved_rate != null ? Number(r.achieved_rate) : null,
      target_amount: Number(r.target_amount), actual_amount: Number(r.actual_amount),
    };
  } catch (e) {
    if (e && e.code === '42P01') return null;
    throw e;
  }
}

export async function markBonusPaid(cx, bonusId, payDate, paymentId, byUserId) {
  await cx.query(
    `UPDATE bonus_payouts SET paid=true, paid_date=$2, payment_id=$3, updated_by=$4, updated_at=now()
      WHERE id=$1 AND paid=false`, [bonusId, payDate, paymentId, byUserId]);
}

// ── 라우트 등록 ──────────────────────────────────────────────────────
export function registerBonusRoutes(app) {
  // 열람 대상 영업사원 결정: 영업사원=본인 강제 / 전체열람자=지정한 사원
  const resolveAgent = (req) => {
    const perm = req.ctx.perm;
    if (!canSeeAll(perm)) return Number(perm.userId);
    const q = Number(req.query.agent_id || 0);
    return q > 0 ? q : 0;
  };

  // ── 성과급 정책 목록 (전체열람자) — 설정 모달용 ──
  app.get('/api/commission/bonus/plans', { preHandler: [authGuard, requirePage('commission')] }, async (req, reply) => {
    if (!canSeeAll(req.ctx.perm)) return reply.code(403).send({ error: 'forbidden' });
    let rows, tiers, targets;
    try {
      rows = (await query(
        `SELECT u.id AS user_id, u.name, t.name AS team_name,
                bp.enabled, bp.basis, bp.start_month, bp.end_month, bp.include_overdue, bp.partial_credit, bp.note
           FROM users u
           LEFT JOIN sales_teams t ON t.id=u.team_id
           LEFT JOIN bonus_plans bp ON bp.user_id=u.id
           JOIN commission_agents ca ON ca.user_id=u.id AND ca.active=true
          WHERE u.deleted_at IS NULL
          ORDER BY t.sort_order NULLS LAST, u.name`)).rows;
      tiers = (await query(`SELECT user_id, min_rate, amount FROM bonus_tiers ORDER BY user_id, min_rate`)).rows;
      targets = (await query(`SELECT user_id, month, revenue_target FROM bonus_targets ORDER BY user_id, month`)).rows;
    } catch (e) {
      if (e && e.code === '42P01') return { items: [], not_migrated: true, note: '성과급 테이블이 없습니다. 서버에서 npm run migrate (0190)을 실행하세요.' };
      throw e;
    }
    const tby = {}, gby = {};
    for (const t of tiers) (tby[t.user_id] ||= []).push({ min_rate: Number(t.min_rate), amount: Number(t.amount) });
    for (const g of targets) (gby[g.user_id] ||= {})[g.month] = Number(g.revenue_target);
    return {
      items: rows.map((r) => ({
        user_id: Number(r.user_id), name: r.name, team_name: r.team_name,
        enabled: r.enabled === true, basis: r.basis || 'revenue',
        start_month: r.start_month || null, end_month: r.end_month || null,
        include_overdue: r.enabled == null ? true : r.include_overdue === true,
        partial_credit: r.enabled == null ? true : r.partial_credit === true,
        note: r.note || null,
        has_plan: r.enabled != null,
        tiers: tby[r.user_id] || [], targets: gby[r.user_id] || {},
      })),
    };
  });

  // ── 성과급 정책 저장 (디렉터) — 정책·목표·구간을 통째 교체 ──
  app.post('/api/commission/bonus/plans/:uid', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const uid = Number(req.params.uid);
    if (!uid) return reply.code(400).send({ error: 'user_required' });
    const v = validateBonusPlan(req.body || {});
    if (!v.ok) return reply.code(400).send({ error: v.error, note: v.note });
    const dir = req.ctx.perm.userId;
    try {
      await withTx(async (cx) => {
        await cx.query(
          `INSERT INTO bonus_plans (user_id, enabled, basis, start_month, end_month, include_overdue, partial_credit, note, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
           ON CONFLICT (user_id) DO UPDATE SET
             enabled=$2, basis=$3, start_month=$4, end_month=$5, include_overdue=$6, partial_credit=$7, note=$8,
             updated_by=$9, updated_at=now()`,
          [uid, v.plan.enabled, v.plan.basis, v.plan.start_month, v.plan.end_month,
            v.plan.include_overdue, v.plan.partial_credit, v.plan.note || null, dir]);
        await cx.query(`DELETE FROM bonus_tiers WHERE user_id=$1`, [uid]);
        for (const t of v.tiers) {
          await cx.query(`INSERT INTO bonus_tiers (user_id, min_rate, amount) VALUES ($1,$2,$3)`, [uid, t.min_rate, t.amount]);
        }
        await cx.query(`DELETE FROM bonus_targets WHERE user_id=$1`, [uid]);
        for (const [m, amt] of Object.entries(v.targets)) {
          await cx.query(
            `INSERT INTO bonus_targets (user_id, month, revenue_target, updated_by) VALUES ($1,$2,$3,$4)`,
            [uid, m, amt, dir]);
        }
      });
    } catch (e) {
      if (e && e.code === '42P01') return reply.code(503).send({ error: 'bonus_not_migrated', note: '성과급 테이블이 없습니다. npm run migrate (0190)을 실행하세요.' });
      throw e;
    }
    await logEvent({ userId: dir, action: 'update', target: `bonus_plan:${uid}`, detail: { enabled: v.plan.enabled, basis: v.plan.basis, tiers: v.tiers.length } });
    return { ok: true, plan: v.plan, tiers: v.tiers, targets: v.targets };
  });

  // ── 이번 달(또는 지정 월) 진척 — 매출목표 대비 매출 / 수금목표 대비 수금 + 기대 보상 ──
  app.get('/api/commission/progress', { preHandler: [authGuard, requirePage('commission')] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const today = /^\d{4}-\d{2}-\d{2}$/.test(req.query.today || '') ? req.query.today : todayStr();
    const ym = /^\d{4}-\d{2}$/.test(req.query.ym || '') ? req.query.ym : ymOf(today);
    const agentId = resolveAgent(req);
    if (!agentId) return { agent_id: null, ym, today, need_agent: true };

    const { plan, tiers, targets, migrated } = await loadBonusPlan(agentId);
    const { invoices, allocs } = await loadAgentData(agentId);
    const perf = buildPerf({ invoices, allocs, plan, tiers, targets, months: [ym], today });
    const row = perf.months[0];
    const el = elapsedRatio(ym, today);
    const proj = (a) => (el > 0 ? round2(a / el) : a);

    const bonusProjRate = row.bonus.in_plan && row.bonus.target > 0
      ? round2(proj(row.bonus.actual) / row.bonus.target * 100) : null;
    const projTier = pickTier(tiers, bonusProjRate);
    const nt = row.bonus.in_plan ? nextTier(tiers, row.bonus.rate) : null;

    // 오늘 날짜가 속한 커미션 기간(기준·율) — 화면 배지용
    let comPeriod = null;
    try {
      const p = (await query(
        `SELECT basis, rate FROM commission_agent_periods
          WHERE user_id=$1 AND $2::date >= start_date AND (end_date IS NULL OR $2::date <= end_date)
          ORDER BY start_date DESC LIMIT 1`, [agentId, today])).rows[0];
      if (p) comPeriod = { basis: p.basis, rate: Number(p.rate) };
    } catch (e) { if (!(e && e.code === '42P01')) throw e; }

    return {
      agent_id: agentId, ym, today, elapsed: round2(el * 100), bonus_migrated: migrated,
      revenue: { ...row.revenue, projected: proj(row.revenue.actual), gap: round2(row.revenue.target - row.revenue.actual) },
      collection: { ...row.collection, projected: proj(row.collection.actual), gap: round2(row.collection.target - row.collection.actual) },
      commission: { amount: row.commission, basis: comPeriod ? comPeriod.basis : null, rate: comPeriod ? comPeriod.rate : null },
      bonus: {
        enabled: !!(plan && plan.enabled), in_plan: row.bonus.in_plan, basis: row.bonus.basis,
        target: row.bonus.target, actual: row.bonus.actual, rate: row.bonus.rate,
        amount: row.bonus.amount, tier: row.bonus.tier,
        projected_rate: bonusProjRate, projected_amount: projTier ? round2(projTier.amount) : 0,
        next_tier: nt ? { min_rate: nt.min_rate, amount: round2(nt.amount), need: round2(Math.max(0, row.bonus.target * nt.min_rate / 100 - row.bonus.actual)) } : null,
        tiers,
        plan: plan ? { start_month: plan.start_month, end_month: plan.end_month, include_overdue: plan.include_overdue, partial_credit: plan.partial_credit } : null,
      },
      total_expected: round2(row.commission + row.bonus.amount),
    };
  });

  // ── 실적 조회 — view=month(월별 정산) | customer(고객별) | invoice(인보이스별) ──
  app.get('/api/commission/performance', { preHandler: [authGuard, requirePage('commission')] }, async (req, reply) => {
    const today = /^\d{4}-\d{2}-\d{2}$/.test(req.query.today || '') ? req.query.today : todayStr();
    const curYm = ymOf(today);
    const agentId = resolveAgent(req);
    if (!agentId) return { agent_id: null, need_agent: true, months: [], customers: [], invoices: [], totals: null };

    let from = /^\d{4}-\d{2}$/.test(req.query.from || '') ? req.query.from : addMonth(curYm, -3);
    let to = /^\d{4}-\d{2}$/.test(req.query.to || '') ? req.query.to : curYm;
    if (from > to) from = to;
    if (monthRange(from, to).length > 36) from = addMonth(to, -35);   // 상한 36개월
    const customerId = Number(req.query.customer_id || 0) || null;

    const { plan, tiers, targets, migrated } = await loadBonusPlan(agentId);
    const { invoices, allocs } = await loadAgentData(agentId);
    const months = monthRange(from, to);
    const perf = buildPerf({ invoices, allocs, plan, tiers, targets, months, today, customerId });

    // 확정된 성과급 스냅샷(있으면 그 값이 진실 — 확정 후 동결)
    let snap = {};
    try {
      const rows = (await query(
        `SELECT settle_ym, target_amount, actual_amount, achieved_rate, amount, paid, to_char(paid_date,'YYYY-MM-DD') AS paid_date
           FROM bonus_payouts WHERE user_id=$1`, [agentId])).rows;
      for (const r of rows) {
        snap[r.settle_ym] = {
          target: Number(r.target_amount), actual: Number(r.actual_amount),
          rate: r.achieved_rate != null ? Number(r.achieved_rate) : null,
          amount: Number(r.amount), paid: r.paid === true, paid_date: r.paid_date || null,
        };
      }
    } catch (e) { if (!(e && e.code === '42P01')) throw e; }

    const monthsOut = perf.months.map((r) => {
      const s = snap[r.month];
      return {
        ...r,
        bonus: s ? { ...r.bonus, target: s.target, actual: s.actual, rate: s.rate, amount: s.amount, confirmed: true, paid: s.paid, paid_date: s.paid_date }
          : { ...r.bonus, confirmed: false, paid: false, paid_date: null },
        total: round2(r.commission + (s ? s.amount : r.bonus.amount)),
      };
    });

    const customerList = customerId ? perf.customers : perf.customers;
    return {
      agent_id: agentId, from, to, today, customer_id: customerId, bonus_migrated: migrated,
      bonus_enabled: !!(plan && plan.enabled),
      months: monthsOut,
      customers: customerList,
      invoices: perf.invoices,
      totals: { ...perf.totals, bonus: round2(monthsOut.reduce((s, r) => s + Number(r.bonus.amount || 0), 0)) },
    };
  });

  // ── 내 성과급 조건 (영업사원 본인) ──
  app.get('/api/commission/my-bonus', { preHandler: [authGuard, requirePage('commission')] }, async (req) => {
    const uid = Number(req.ctx.perm.userId);
    const { plan, tiers, targets, migrated } = await loadBonusPlan(uid);
    return { migrated, plan, tiers, targets };
  });
}

export default registerBonusRoutes;
