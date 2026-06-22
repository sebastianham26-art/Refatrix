// 현금흐름 집계 · 계획/실적 분리 · 연체 계산 (순수 함수)
// 입력 거래(txn) 형태(필요 필드만):
//  { direction:'in'|'out', status:'plan'|'actual', amount_mxn, txn_date:'YYYY-MM-DD',
//    plan_amount_mxn, plan_date:'YYYY-MM-DD', kind, recurring_rule_id }
// 모든 금액은 MXN 환산 기준으로 들어온다고 가정(라우트에서 환산).

function pad2(n) { return String(n).padStart(2, '0'); }

// 월 키 'YYYY-MM'
export function monthKey(dateStr) { return String(dateStr).slice(0, 7); }

// ISO 주 키 'IYYY-Www' (월요일 시작)
export function weekKey(dateStr) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = (dt.getUTCDay() + 6) % 7; // 월=0..일=6
  dt.setUTCDate(dt.getUTCDate() - day + 3); // 그 주 목요일
  const firstThu = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((dt - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${dt.getUTCFullYear()}-W${pad2(week)}`;
}

export function bucketKey(dateStr, granularity) {
  return granularity === 'week' ? weekKey(dateStr) : monthKey(dateStr);
}

// 실제/예정 현금흐름을 기간 버킷으로 집계 + 누적잔고
// opts: { granularity:'month'|'week', includePlan:boolean, openingBalance:number }
// 반환: [{ period, inflow, outflow, net, cumulative }]
export function aggregateCashflow(txns, opts = {}) {
  const gran = opts.granularity === 'week' ? 'week' : 'month';
  const includePlan = !!opts.includePlan;
  const map = new Map();
  for (const t of txns) {
    if (!includePlan && t.status !== 'actual') continue;
    const date = t.status === 'actual' ? t.txn_date : (t.plan_date || t.txn_date);
    const amt = Number(t.amount_mxn) || 0;
    const key = bucketKey(date, gran);
    if (!map.has(key)) map.set(key, { period: key, inflow: 0, outflow: 0, net: 0 });
    const row = map.get(key);
    if (t.direction === 'in') row.inflow += amt; else row.outflow += amt;
    row.net = row.inflow - row.outflow;
  }
  const rows = [...map.values()].sort((a, b) => (a.period < b.period ? -1 : 1));
  let cum = Number(opts.openingBalance) || 0;
  for (const r of rows) {
    r.inflow = round2(r.inflow); r.outflow = round2(r.outflow); r.net = round2(r.net);
    cum += r.net; r.cumulative = round2(cum);
  }
  return rows;
}

// 계획 vs 실적: 수입/지출 각각, 기간별 계획합·실적합
// 계획 = 계획시점(plan_date)·계획금액(plan_amount_mxn). 실적 = 실제시점(txn_date)·실제금액(amount_mxn).
// 예정(plan)거래는 계획에만, 실제(actual)거래는 실적+계획 양쪽(원래 계획 시점/금액으로 계획선에) 반영.
// filter: 'all'|'recurring'|'other'
export function planVsActual(txns, opts = {}) {
  const gran = opts.granularity === 'week' ? 'week' : 'month';
  const filter = opts.filter || 'all';
  const inc = (t) => filter === 'all' ? true : filter === 'recurring' ? !!t.recurring_rule_id : !t.recurring_rule_id;
  const periods = new Set();
  const plan = { in: new Map(), out: new Map() };
  const actual = { in: new Map(), out: new Map() };
  const add = (mp, key, v) => { mp.set(key, round2((mp.get(key) || 0) + v)); periods.add(key); };
  for (const t of txns) {
    if (!inc(t)) continue;
    const dir = t.direction === 'in' ? 'in' : 'out';
    // 계획선: 계획이 실제로 있었던 것만(계획 없이 바로 실적 등록한 건 계획 0)
    const planDate = t.plan_date || t.txn_date;
    const planAmt = t.plan_amount_mxn != null ? Number(t.plan_amount_mxn) : 0;
    if (planAmt) add(plan[dir], bucketKey(planDate, gran), planAmt);
    // 실적선: 실제 전환된 것만
    if (t.status === 'actual') add(actual[dir], bucketKey(t.txn_date, gran), Number(t.amount_mxn) || 0);
  }
  const keys = [...periods].sort();
  const series = (mp) => keys.map((k) => ({ period: k, value: round2(mp.get(k) || 0) }));
  return {
    periods: keys,
    income: { plan: series(plan.in), actual: series(actual.in) },
    expense: { plan: series(plan.out), actual: series(actual.out) },
  };
}

// 연체 계산: 입금예정일(due_date)이 오늘 지났고 미수금(outstanding>0)이 남은 인보이스
// invoices: [{ id, customer_id, customer_name, due_date, total, paid }]
// today: 'YYYY-MM-DD'
export function computeOverdue(invoices, today) {
  const t = parseYMD(today);
  const out = [];
  for (const inv of invoices) {
    const outstanding = round2(Number(inv.total) - Number(inv.paid || 0));
    if (outstanding <= 0.009) continue;
    if (!inv.due_date) continue;
    const due = parseYMD(String(inv.due_date).slice(0, 10));
    if (due >= t) continue; // 아직 예정일 안 지남
    const days = Math.floor((t - due) / 86400000);
    out.push({ ...inv, outstanding, overdue_days: days, severity: severityOf(days) });
  }
  out.sort((a, b) => b.overdue_days - a.overdue_days);
  return out;
}

// 과거 늦은 입금 이력: 입금일이 인보이스 예정일보다 뒤인 기록
// payments: [{ invoice_id, customer_id, customer_name, due_date, pay_date, amount }]
export function latePaymentHistory(payments) {
  const out = [];
  for (const p of payments) {
    if (!p.due_date || !p.pay_date) continue;
    const due = parseYMD(String(p.due_date).slice(0, 10));
    const pay = parseYMD(String(p.pay_date).slice(0, 10));
    const days = Math.floor((pay - due) / 86400000);
    if (days > 0) out.push({ ...p, late_days: days, severity: severityOf(days) });
  }
  out.sort((a, b) => b.late_days - a.late_days);
  return out;
}

export function severityOf(days) {
  if (days >= 31) return 'high';
  if (days >= 8) return 'mid';
  return 'low';
}

// 월별 상세: 실적 섹션 + 예정 섹션(처리됨/미처리/경과) — '오늘' 기준.
// txns: 그 달 관련 거래. 각 거래는 { id, direction, status, txn_date, amount_mxn, plan_date, plan_amount_mxn, category_code, category_name, memo, sales_invoice_id, recurring_rule_id }
// monthStr: 'YYYY-MM', today: 'YYYY-MM-DD'
// 분류:
//  - 실적 섹션 = status==='actual' 이고 txn_date가 그 달.
//  - 예정 섹션 = plan_date(없으면 txn_date)가 그 달인 모든 거래.
//      · processed = 그 항목이 지금 actual (계획이 실적화됨)
//      · pending   = 아직 plan. 예정일(plan_date)이 오늘 지났으면 overdue, 아니면 upcoming
export function monthBreakdown(txns, monthStr, today) {
  const inMonth = (d) => d && String(d).slice(0, 7) === monthStr;
  const t0 = today;
  const actualItems = [];
  const planItems = [];
  for (const t of txns) {
    const hasPlan = t.plan_amount_mxn != null; // 계획이 실제로 있었던 거래만 예정 섹션에
    const planDate = t.plan_date ? String(t.plan_date).slice(0, 10) : String(t.txn_date).slice(0, 10);
    const planAmt = t.plan_amount_mxn != null ? Number(t.plan_amount_mxn) : 0;
    // 실적 섹션
    if (t.status === 'actual' && inMonth(t.txn_date)) {
      actualItems.push({ ...t, _amt: Number(t.amount_mxn) || 0, _date: String(t.txn_date).slice(0, 10) });
    }
    // 예정 섹션: 계획이 있고, 계획일이 그 달
    if (hasPlan && inMonth(planDate)) {
      let state;
      if (t.status === 'actual') state = 'processed';
      else state = (planDate < t0) ? 'overdue' : 'upcoming';
      planItems.push({ ...t, _planDate: planDate, _planAmt: planAmt,
        _actualAmt: t.status === 'actual' ? (Number(t.amount_mxn) || 0) : 0, _state: state });
    }
  }
  actualItems.sort((a, b) => (a._date < b._date ? -1 : 1));
  planItems.sort((a, b) => (a._planDate < b._planDate ? -1 : 1));
  const sum = (arr, dir, f) => round2(arr.filter((x) => x.direction === dir).reduce((s, x) => s + f(x), 0));
  // 실적 소계
  const actualSub = { in: sum(actualItems, 'in', (x) => x._amt), out: sum(actualItems, 'out', (x) => x._amt) };
  actualSub.net = round2(actualSub.in - actualSub.out);
  // 예정 요약(계획 기준): 계획총액 / 처리(실적화)액 / 남은예정 / 그중 경과
  const planSummary = { in: planAggr(planItems, 'in'), out: planAggr(planItems, 'out') };
  return { month: monthStr, today: t0, actual: { items: actualItems, subtotal: actualSub }, plan: { items: planItems, summary: planSummary } };
}

// 계정과목별 계획 vs 실적 (수입/지출 분리). 막대 비교용.
// 계획 = plan 값(예정 시점·금액). 실적 = 실제 전환된 거래의 실제 금액.
// period 필터: from/to (YYYY-MM-DD) 선택 — 계획은 plan_date 기준, 실적은 txn_date 기준.
// filter: 'all'|'recurring'|'other'
export function planVsActualByCategory(txns, opts = {}) {
  const filter = opts.filter || 'all';
  const inc = (t) => filter === 'all' ? true : filter === 'recurring' ? !!t.recurring_rule_id : !t.recurring_rule_id;
  const from = opts.from || null, to = opts.to || null;
  const inRange = (d) => (!from || d >= from) && (!to || d <= to);
  const grp = { in: new Map(), out: new Map() };
  const key = (t) => (t.category_code || '기타') + '|' + (t.category_name || t.category_code || '기타');
  for (const t of txns) {
    if (!inc(t)) continue;
    const dir = t.direction === 'in' ? 'in' : 'out';
    const planDate = t.plan_date || t.txn_date;
    const planAmt = t.plan_amount_mxn != null ? Number(t.plan_amount_mxn) : 0;
    const k = key(t);
    if (!grp[dir].has(k)) grp[dir].set(k, { code: (t.category_code || '기타'), name: (t.category_name || t.category_code || '기타'), plan: 0, actual: 0, memos: [] });
    const row = grp[dir].get(k);
    if (planAmt && inRange(planDate)) row.plan = round2(row.plan + planAmt);
    if (t.status === 'actual' && inRange(t.txn_date)) row.actual = round2(row.actual + (Number(t.amount_mxn) || 0));
    // 메모 수집(빈 메모·고정비 자동메모 접두 제거, 기간 내 거래만)
    const memoDate = t.status === 'actual' ? t.txn_date : planDate;
    if (inRange(memoDate) && t.memo) {
      const m = String(t.memo).replace(/^\[고정비\]\s*/, '').trim();
      if (m && !row.memos.includes(m)) row.memos.push(m);
    }
  }
  const toRows = (mp) => [...mp.values()].map((r) => ({
    code: r.code, name: r.name, plan: round2(r.plan), actual: round2(r.actual),
    diff: round2(r.actual - r.plan), rate: r.plan > 0 ? Math.round((r.actual / r.plan) * 100) : (r.actual > 0 ? null : 0),
    memo: r.memos.join(', '),
  })).filter((r) => r.plan !== 0 || r.actual !== 0).sort((a, b) => b.plan - a.plan || b.actual - a.actual);
  const total = (rows) => {
    const plan = round2(rows.reduce((s, r) => s + r.plan, 0));
    const actual = round2(rows.reduce((s, r) => s + r.actual, 0));
    return { plan, actual, diff: round2(actual - plan), rate: plan > 0 ? Math.round((actual / plan) * 100) : (actual > 0 ? null : 0) };
  };
  const income = toRows(grp.in), expense = toRows(grp.out);
  return { filter, from, to, income: { rows: income, total: total(income) }, expense: { rows: expense, total: total(expense) } };
}

function planAggr(items, dir) {
  const xs = items.filter((x) => x.direction === dir);
  const planned = round2(xs.reduce((s, x) => s + x._planAmt, 0));
  const processed = round2(xs.filter((x) => x._state === 'processed').reduce((s, x) => s + x._actualAmt, 0));
  const remaining = round2(xs.filter((x) => x._state !== 'processed').reduce((s, x) => s + x._planAmt, 0));
  const overdue = round2(xs.filter((x) => x._state === 'overdue').reduce((s, x) => s + x._planAmt, 0));
  return { planned, processed, remaining, overdue };
}

function parseYMD(s) { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
export { round2 };

// 현금흐름 달력용 AR(수금예정)/AP(지급예정) 일자별 집계 (순수 함수)
//   invoices : 전사 미수 인보이스 [{ id, customer_name, sat_no, due_date:'YYYY-MM-DD', outstanding }]
//   planOut  : 권한계좌의 예정 지출 거래 [{ id, plan_date|txn_date, amount_mxn, account_name, category_name, memo }]
//   month    : 'YYYY-MM'
// 반환: { ar: { [date]: {sum, items[]} }, ap: { [date]: {sum, items[]} } }
export function calendarArApByDay(invoices, planOut, month) {
  const ar = {}; const ap = {};
  for (const iv of invoices || []) {
    const d = String(iv.due_date).slice(0, 10);
    if (d.slice(0, 7) !== month) continue;
    const out = Number(iv.outstanding);
    if (!(out > 0)) continue;
    if (!ar[d]) ar[d] = { sum: 0, items: [] };
    ar[d].sum = round2(ar[d].sum + out);
    ar[d].items.push({ id: iv.id, customer_name: iv.customer_name, sat_no: iv.sat_no, amount_mxn: round2(out) });
  }
  for (const t of planOut || []) {
    const d = String(t.plan_date || t.txn_date).slice(0, 10);
    if (d.slice(0, 7) !== month) continue;
    const amt = Number(t.amount_mxn) || 0;
    if (!ap[d]) ap[d] = { sum: 0, items: [] };
    ap[d].sum = round2(ap[d].sum + amt);
    ap[d].items.push({ id: t.id, account_name: t.account_name || null, category_name: t.category_name || null, memo: t.memo || null, amount_mxn: round2(amt) });
  }
  return { ar, ap };
}
