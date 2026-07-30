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

// 일 키 'YYYY-MM-DD'
export function dayKey(dateStr) { return String(dateStr).slice(0, 10); }

export function bucketKey(dateStr, granularity) {
  return granularity === 'week' ? weekKey(dateStr) : granularity === 'day' ? dayKey(dateStr) : monthKey(dateStr);
}

// 실제/예정 현금흐름을 기간 버킷으로 집계 + 누적잔고
// opts: { granularity:'month'|'week', includePlan:boolean, openingBalance:number }
// 반환: [{ period, inflow, outflow, net, cumulative }]
export function aggregateCashflow(txns, opts = {}) {
  const gran = (opts.granularity === 'week' || opts.granularity === 'day') ? opts.granularity : 'month';
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
    if (!grp[dir].has(k)) grp[dir].set(k, { code: (t.category_code || '기타'), name: (t.category_name || t.category_code || '기타'), plan: 0, actual: 0, memos: [], items: [] });
    const row = grp[dir].get(k);
    if (planAmt && inRange(planDate)) row.plan = round2(row.plan + planAmt);
    if (t.status === 'actual' && inRange(t.txn_date)) row.actual = round2(row.actual + (Number(t.amount_mxn) || 0));
    // 메모 수집(빈 메모·고정비 자동메모 접두 제거, 기간 내 거래만)
    const memoDate = t.status === 'actual' ? t.txn_date : planDate;
    if (inRange(memoDate) && t.memo) {
      const m = String(t.memo).replace(/^\[고정비\]\s*/, '').trim();
      if (m && !row.memos.includes(m)) row.memos.push(m);
    }
    // 드릴다운용 개별 내역(기간 내 거래 전부 — 메모 없는 거래 포함)
    if (inRange(memoDate)) {
      row.items.push({
        date: String(memoDate).slice(0, 10),
        status: t.status === 'actual' ? 'actual' : 'plan',
        plan: planAmt ? round2(planAmt) : null,
        actual: t.status === 'actual' ? round2(Number(t.amount_mxn) || 0) : null,
        memo: t.memo ? String(t.memo).trim() : '',
        recurring: !!t.recurring_rule_id,
      });
    }
  }
  const toRows = (mp) => [...mp.values()].map((r) => ({
    code: r.code, name: r.name, plan: round2(r.plan), actual: round2(r.actual),
    diff: round2(r.actual - r.plan), rate: r.plan > 0 ? Math.round((r.actual / r.plan) * 100) : (r.actual > 0 ? null : 0),
    memo: r.memos.join(', '),
    items: r.items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
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
export function calendarArApByDay(invoices, planOut, month, realizedOut, planIn, today) {
  const ar = {}; const ap = {};
  // 이월(carry): '오늘이 속한 달'을 볼 때, 오늘보다 과거인 미실현 AR/AP는 원래 날짜 칸이 아니라
  // 오늘 하나의 '이월' 버킷으로 합산한다(과거 달 포함). 데이터의 날짜는 불변 — 표시·예상잔고 계산만 이동.
  const doCarry = !!(today && String(today).slice(0, 7) === month);
  const carry = doCarry ? { date: today, ar_sum: 0, ap_sum: 0, items: [] } : null;
  const overdueDays = (d) => Math.max(1, Math.round((Date.parse(today) - Date.parse(d)) / 86400000));
  for (const iv of invoices || []) {
    const d = String(iv.due_date).slice(0, 10);
    const total = Number(iv.total != null ? iv.total : iv.total_mxn) || 0;
    const collected = Number(iv.collected) || 0;
    const out = iv.outstanding != null ? Number(iv.outstanding) : round2(total - collected);
    if (doCarry && d < today && out > 0.009) {
      carry.ar_sum = round2(carry.ar_sum + out);
      carry.items.push({ src: 'ar', orig_date: d, overdue_days: overdueDays(d), id: iv.id,
        customer_name: iv.customer_name, sat_no: iv.sat_no, amount_mxn: round2(out),
        total_mxn: round2(total), collected_mxn: round2(collected),
        state: collected > 0.009 ? 'partial' : 'pending', manual: false });
      continue;
    }
    if (d.slice(0, 7) !== month) continue;
    // 상태: pending=미수금(색상) / partial=일부수금(회색) / paid=완납(회색+배지)
    let state;
    if (out <= 0.009) state = 'paid';
    else if (collected > 0.009) state = 'partial';
    else state = 'pending';
    if (!ar[d]) ar[d] = { sum: 0, items: [] };
    ar[d].sum = round2(ar[d].sum + Math.max(0, out)); // 예상잔고엔 미수(remaining)만 반영
    ar[d].items.push({ id: iv.id, customer_name: iv.customer_name, sat_no: iv.sat_no,
      amount_mxn: round2(Math.max(0, out)), total_mxn: round2(total), collected_mxn: round2(collected), state });
  }
  // 수동 예정 수입(인보이스 없는 plan·in): AR에 합류 — 달력 표시 + 예상잔고 반영.
  // (표·워터폴·하단 예정 섹션에는 이미 포함되던 것을 달력/예상잔고에도 대칭화)
  for (const t of planIn || []) {
    const d = String(t.plan_date || t.txn_date).slice(0, 10);
    const amtC = Number(t.amount_mxn) || 0;
    if (doCarry && d < today && amtC > 0) {
      carry.ar_sum = round2(carry.ar_sum + amtC);
      carry.items.push({ src: 'ar', orig_date: d, overdue_days: overdueDays(d), id: t.id,
        customer_name: (t.memo || t.category_name || t.account_name || '예정 수입'), sat_no: null,
        amount_mxn: round2(amtC), total_mxn: round2(amtC), collected_mxn: 0, state: 'pending', manual: true });
      continue;
    }
    if (d.slice(0, 7) !== month) continue;
    const amt = amtC;
    if (!ar[d]) ar[d] = { sum: 0, items: [] };
    ar[d].sum = round2(ar[d].sum + amt);
    ar[d].items.push({ id: t.id, customer_name: (t.memo || t.category_name || t.account_name || '예정 수입'),
      sat_no: null, amount_mxn: round2(amt), total_mxn: round2(amt), collected_mxn: 0, state: 'pending', manual: true });
  }
  for (const t of planOut || []) {
    const d = String(t.plan_date || t.txn_date).slice(0, 10);
    const amtC = Number(t.amount_mxn) || 0;
    if (doCarry && d < today && amtC > 0) {
      carry.ap_sum = round2(carry.ap_sum + amtC);
      carry.items.push({ src: 'ap', orig_date: d, overdue_days: overdueDays(d), id: t.id,
        account_name: t.account_name || null, category_name: t.category_name || null,
        memo: t.memo || null, amount_mxn: round2(amtC), state: 'pending' });
      continue;
    }
    if (d.slice(0, 7) !== month) continue;
    const amt = amtC;
    if (!ap[d]) ap[d] = { sum: 0, items: [] };
    ap[d].sum = round2(ap[d].sum + amt); // 예정 지급(pending)만 예상잔고에 반영
    ap[d].items.push({ id: t.id, account_name: t.account_name || null, category_name: t.category_name || null, memo: t.memo || null, amount_mxn: round2(amt), state: 'pending' });
  }
  // 실적화된(지급완료) 예정지출: 계획일 자리에 회색+배지로 노출. 잔고(sum)엔 넣지 않음(실적으로 이미 반영됨 → 이중계산 방지).
  for (const t of realizedOut || []) {
    const d = String(t.plan_date || t.txn_date).slice(0, 10);
    if (d.slice(0, 7) !== month) continue;
    const amt = Number(t.amount_mxn) || 0;
    if (!ap[d]) ap[d] = { sum: 0, items: [] };
    ap[d].items.push({ id: t.id, account_name: t.account_name || null, category_name: t.category_name || null, memo: t.memo || null, amount_mxn: round2(amt), state: 'paid' });
  }
  let carryOut = null;
  if (carry && (carry.ar_sum > 0 || carry.ap_sum > 0)) {
    carry.items.sort((a, b) => (a.orig_date < b.orig_date ? -1 : a.orig_date > b.orig_date ? 1 : 0));
    carryOut = { ...carry, net: round2(carry.ar_sum - carry.ap_sum) };
  }
  return { ar, ap, carry: carryOut };
}

// 예상 월초(미래 달) 보정 — monthStart 이전 유효일(plan_date||txn_date)의 '미실현 예정' 순액.
// planIn: 수동 예정수입(인보이스 미연결) / planOut: 예정지출 / hidden: 보완분(예정만 집계).
// 인보이스 AR(만기<monthStart 미수 잔액 합)은 SQL로 별도 집계해 호출부에서 더한다.
// 의미는 calendarArApByDay와 동일(amount_mxn·유효일) — 예상잔고가 전월 '예상' 말잔고와 연속되게 한다.
export function planNetBefore(planIn, planOut, hidden, monthStart) {
  let net = 0;
  for (const t of planIn || []) {
    const d = String(t.plan_date || t.txn_date).slice(0, 10);
    if (d < monthStart) net += Number(t.amount_mxn) || 0;
  }
  for (const t of planOut || []) {
    const d = String(t.plan_date || t.txn_date).slice(0, 10);
    if (d < monthStart) net -= Number(t.amount_mxn) || 0;
  }
  for (const t of hidden || []) {
    if (t.status === 'actual') continue;
    const d = String(t.plan_date || t.txn_date).slice(0, 10);
    if (d < monthStart) net += (t.direction === 'in' ? 1 : -1) * (Number(t.amount_mxn) || 0);
  }
  return round2(net);
}

// ===== 계정별 월 예산 예측 (2026-07-28) — 순수 함수 =====
// 선택한 월에 "지출될 돈 / 들어올 돈"을 미리 집계한다. 그룹핑 2종: 계정과목별(기본) + 은행계좌별(by_account).
//  txns        : loadCashTxns 결과(권한 필터 완료) — plan/actual 혼재. 계획이 있는 거래만 집계.
//                (account_id/account_name 포함 — 계좌별 그룹핑·내역 병기에 사용)
//  projections : 아직 [생성]되지 않은 고정비 회차 자동전개
//                [{ direction, category_code, category_name, account_id, account_name, date:'YYYY-MM-DD', amount_mxn, rule_name }]
//  arInvoices  : 미수 인보이스(그 달 만기 + 이번 달 조회 시 지난 만기 이월) [{ due_date, outstanding, customer_name, sat_no }]
//  monthStr    : 'YYYY-MM' / today: 'YYYY-MM-DD'
// 행 의미: planned=계획총액 · processed=실적화 금액 · remaining=미처리 예정 잔액(그중 overdue=경과)
//          projected=미생성 고정비 자동전개 · expected=processed+remaining+projected (그 달 예상 현금 흐름액)
// 이중계상 방지: 인보이스 연계 수금계획(sales_invoice_id)은 제외하고 AR(미수 인보이스) 행으로만 잡는다.
// AR 은 입금계좌가 확정되지 않으므로 계좌별 뷰에서도 전용 행('__AR__')으로 분리(계좌미지정 계획과 섞지 않음).
// 내역 item 은 date/state/memo/amount 에 더해 category_name·account_name 을 항상 포함
//  → 계정과목별 뷰에서는 계좌를, 계좌별 뷰에서는 계정과목을 병기할 수 있다.
export function monthForecastByCategory(txns, projections, arInvoices, monthStr, today) {
  const inMonth = (d) => d && String(d).slice(0, 7) === monthStr;
  // keyOf: 엔트리 → { code, name } (그룹 키). 두 그룹핑을 같은 로직으로 만든다.
  const build = (keyOf) => {
    const groups = { in: new Map(), out: new Map() };
    const grp = (dir, code, name) => {
      const key = code || '(미지정)';
      const m = groups[dir === 'in' ? 'in' : 'out'];
      if (!m.has(key)) {
        m.set(key, { group_code: code || null, group_name: name || code || '(미지정)', n: 0,
          planned: 0, processed: 0, remaining: 0, overdue: 0, projected: 0, expected: 0, items: [] });
      }
      return m.get(key);
    };
    for (const t of txns || []) {
      if (t.status !== 'plan' && t.plan_amount_mxn == null) continue;      // 계획이 있는 거래만
      if (t.direction === 'in' && t.sales_invoice_id) continue;            // 인보이스 수금계획은 AR 행으로 (이중계상 방지)
      const planDate = String(t.plan_date || t.txn_date).slice(0, 10);
      if (!inMonth(planDate)) continue;
      const planAmt = t.plan_amount_mxn != null ? Number(t.plan_amount_mxn) : (Number(t.amount_mxn) || 0);
      const amt = Number(t.amount_mxn) || 0;
      const k = keyOf({ kind: 'txn', category_code: t.category_code, category_name: t.category_name, account_id: t.account_id, account_name: t.account_name });
      const g = grp(t.direction, k.code, k.name);
      g.n += 1; g.planned += planAmt;
      const base = { date: planDate, memo: t.memo || '', category_name: t.category_name || t.category_code || null, account_name: t.account_name || null };
      if (t.status === 'actual') {
        g.processed += amt;
        g.items.push({ ...base, amount: round2(amt), state: 'processed' });
      } else {
        const od = planDate < today;
        g.remaining += amt; if (od) g.overdue += amt;
        g.items.push({ ...base, amount: round2(amt), state: od ? 'overdue' : 'upcoming' });
      }
    }
    for (const p of projections || []) {
      if (!inMonth(p.date)) continue;
      const a = Number(p.amount_mxn) || 0;
      const k = keyOf({ kind: 'proj', category_code: p.category_code, category_name: p.category_name, account_id: p.account_id, account_name: p.account_name });
      const g = grp(p.direction, k.code, k.name);
      g.n += 1; g.projected += a; g.planned += a;
      g.items.push({ date: String(p.date).slice(0, 10),
        memo: `[고정비] ${p.rule_name || ''}${p.rule_id ? ` (규칙#${p.rule_id})` : ''}`.trim(),   // 규칙# = 어느 규칙의 자동전개인지 추적용
        category_name: p.category_name || p.category_code || null, account_name: p.account_name || null,
        amount: round2(a), state: 'projected' });
    }
    // AR: 미수 인보이스 잔액 → 수입 쪽 전용 행 (완납=outstanding 0은 자동 제외). 두 뷰 모두 '__AR__' 고정.
    for (const x of arInvoices || []) {
      const a = Number(x.outstanding) || 0;
      if (a <= 0) continue;
      const due = String(x.due_date).slice(0, 10);
      const k = keyOf({ kind: 'ar' });
      const g = grp('in', k.code, k.name);
      const od = due < today;
      g.n += 1; g.planned += a; g.remaining += a; if (od) g.overdue += a;
      g.items.push({ date: due, memo: `${x.customer_name || ''}${x.sat_no ? ' · ' + x.sat_no : ''}`,
        category_name: '매출 수금', account_name: null, amount: round2(a), state: od ? 'overdue' : 'upcoming' });
    }
    const finish = (m) => {
      const rows = [...m.values()].map((g) => {
        for (const kk of ['planned', 'processed', 'remaining', 'overdue', 'projected']) g[kk] = round2(g[kk]);
        g.expected = round2(g.processed + g.remaining + g.projected);
        g.items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
        return g;
      }).sort((a, b) => b.expected - a.expected || (a.group_name < b.group_name ? -1 : 1));
      const total = { n: 0, planned: 0, processed: 0, remaining: 0, overdue: 0, projected: 0, expected: 0 };
      for (const g of rows) { for (const kk of Object.keys(total)) total[kk] = round2(total[kk] + g[kk]); }
      return { rows, total };
    };
    const fin = finish(groups.in), fout = finish(groups.out);
    return { in: fin, out: fout, net: round2(fin.total.expected - fout.total.expected) };
  };
  // ① 계정과목별 (기본)
  const byCat = build((e) => e.kind === 'ar'
    ? { code: '__AR__', name: '매출 수금 (미수 인보이스)' }
    : { code: e.category_code, name: e.category_name || e.category_code });
  // ② 은행계좌별 — 계좌미지정(NULL)은 '(계좌 미지정)', AR 은 전용 행(입금계좌 미정)
  const byAcc = build((e) => e.kind === 'ar'
    ? { code: '__AR__', name: '매출 수금 (입금계좌 미정)' }
    : e.account_id != null
      ? { code: `acc:${e.account_id}`, name: e.account_name || `계좌#${e.account_id}` }
      : { code: null, name: '(계좌 미지정)' });
  // 하위호환: 기존 프런트가 쓰는 category_code/category_name 필드를 계정과목별 행에 유지
  for (const dir of ['in', 'out']) {
    for (const g of byCat[dir].rows) { g.category_code = g.group_code; g.category_name = g.group_name; }
    for (const g of byAcc[dir].rows) { g.account_code = g.group_code; g.account_name_row = g.group_name; }
  }
  return { month: monthStr, in: byCat.in, out: byCat.out, net: byCat.net,
    by_account: { in: byAcc.in, out: byAcc.out, net: byAcc.net } };
}

// ===== 은행계좌별 필요자금 (2026-07-28) — 순수 함수 =====
// 목적: "각 은행계좌별로 익월까지 자금이 얼마나 필요한가/남는가".
//   지출 반영 후 = 현재 잔고 − 이번 달 남은 지출 − 익월 지출 예정. 음수면 그만큼 이체/충전 필요.
//  accounts    : [{ id, name, currency, balance_mxn, can_detail }] — 권한 필터 완료(잔액 열람 계좌), MXN 환산 잔액.
//  txns        : loadCashTxns 결과. 미지급 예정(plan)만 사용. 인보이스 연계 수금계획은 제외(입금계좌 미확정).
//  projections : 미생성 고정비 자동전개 — 이번 달~익월 2개월치. (forecast와 동일 규칙으로 호출부에서 생성)
//  thisMonth/nextMonth: 'YYYY-MM' / today: 'YYYY-MM-DD'
// 윈도 규칙:
//  - '이번 달 남은'(out_this/in_this) = 유효일 < 익월 1일 인 모든 미지급 예정 — 지난 달 경과(이월)분 포함.
//    (이월 원칙과 동일: 안 낸 돈은 여전히 내야 할 돈. 자동전개는 이번 달 발생분만.)
//  - '익월'(out_next/in_next) = 유효일이 익월인 예정 + 익월 자동전개.
//  - 익월 이후 예정은 제외(이 뷰의 지평은 익월까지).
// 수입(in_*)은 '참고'(불확실) — 핵심 지표 after_out 은 지출만 반영, after_all 은 계좌지정 수입까지 반영.
// 계좌미지정(NULL) 예정은 unassigned 로 분리(회사 전체 합계에는 포함 — 어느 계좌든 결국 나갈 돈).
export function accountFundingPlan(accounts, txns, projections, thisMonth, nextMonth, today) {
  const nextMonthStart = nextMonth + '-01';
  const monthOf = (d) => String(d).slice(0, 7);
  const mk = (acc) => ({
    account_id: acc ? Number(acc.id) : null, name: acc ? acc.name : '(계좌 미지정)', currency: acc ? acc.currency : null,
    can_detail: acc ? acc.can_detail !== false : true,
    balance: acc ? round2(Number(acc.balance_mxn) || 0) : null,
    out_this: 0, out_next: 0, in_this: 0, in_next: 0, after_out: null, after_all: null, items: [],
  });
  const rows = new Map();
  for (const a of accounts || []) rows.set(Number(a.id), mk(a));
  const unk = mk(null);
  const put = (accId) => (accId != null && rows.has(Number(accId))) ? rows.get(Number(accId)) : unk;
  const add = (r, direction, win, amt, item) => {
    if (direction === 'out') { if (win === 'this') r.out_this += amt; else r.out_next += amt; }
    else { if (win === 'this') r.in_this += amt; else r.in_next += amt; }
    r.items.push(item);
  };
  for (const t of txns || []) {
    if (t.status !== 'plan') continue;                                   // 미지급/미수취 예정만 (실적은 잔고에 이미 반영)
    if (t.direction === 'in' && t.sales_invoice_id) continue;            // 인보이스 수금계획: 입금계좌 미확정 → AR 참고로만
    const d = String(t.plan_date || t.txn_date).slice(0, 10);
    let win = null;
    if (monthOf(d) === nextMonth) win = 'next';
    else if (d < nextMonthStart) win = 'this';                           // 이번 달 + 과거 경과(이월) 전부 '이번 달 남은'
    if (!win) continue;
    const amt = Number(t.amount_mxn) || 0;
    add(put(t.account_id), t.direction, win, amt, {
      date: d, win, direction: t.direction, memo: t.memo || '',
      category_name: t.category_name || t.category_code || null,
      amount: round2(amt), state: d < today ? 'overdue' : 'upcoming',
    });
  }
  for (const p of projections || []) {
    const d = String(p.date).slice(0, 10);
    let win = null;
    if (monthOf(d) === nextMonth) win = 'next';
    else if (monthOf(d) === thisMonth) win = 'this';
    else continue;
    const amt = Number(p.amount_mxn) || 0;
    add(put(p.account_id), p.direction, win, amt, {
      date: d, win, direction: p.direction,
      memo: `[고정비] ${p.rule_name || ''}${p.rule_id ? ` (규칙#${p.rule_id})` : ''}`.trim(),   // 규칙# = 어느 규칙의 자동전개인지 추적용
      category_name: p.category_name || p.category_code || null,
      amount: round2(amt), state: 'projected',
    });
  }
  const fin = (r) => {
    for (const k of ['out_this', 'out_next', 'in_this', 'in_next']) r[k] = round2(r[k]);
    if (r.balance != null) {
      r.end_this = round2(r.balance - r.out_this);                 // ★ 당월 말 남을 예정 (지출만 반영)
      r.after_out = round2(r.balance - r.out_this - r.out_next);   // ★ 익월 말 부족/여유
      r.after_all = round2(r.after_out + r.in_this + r.in_next);
    } else {
      r.end_this = null;
    }
    r.items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return r;
  };
  const list = [...rows.values()].map(fin);
  fin(unk);
  list.sort((a, b) => (a.after_out ?? Infinity) - (b.after_out ?? Infinity));   // 부족(음수 큰 순) 먼저
  const total = { balance: 0, out_this: 0, out_next: 0, in_this: 0, in_next: 0, after_out: 0, after_all: 0 };
  for (const r of list) {
    total.balance += r.balance || 0;
    total.out_this += r.out_this; total.out_next += r.out_next;
    total.in_this += r.in_this; total.in_next += r.in_next;
  }
  // 계좌미지정 예정도 회사 전체 필요자금에는 포함 (어느 계좌에서든 결국 집행됨)
  total.out_this = round2(total.out_this + unk.out_this); total.out_next = round2(total.out_next + unk.out_next);
  total.in_this = round2(total.in_this + unk.in_this); total.in_next = round2(total.in_next + unk.in_next);
  total.balance = round2(total.balance);
  total.end_this = round2(total.balance - total.out_this);
  total.after_out = round2(total.balance - total.out_this - total.out_next);
  total.after_all = round2(total.after_out + total.in_this + total.in_next);
  const hasUnk = (unk.out_this || unk.out_next || unk.in_this || unk.in_next) ? unk : null;
  return { this_month: thisMonth, next_month: nextMonth, rows: list, unassigned: hasUnk, total };
}
