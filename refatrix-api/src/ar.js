// 담당고객 오픈 인보이스(미수/연체) 계산 — 순수 함수(단위 테스트 가능)
// node-pg는 NUMERIC을 문자열로 반환하므로 모든 금액 Number() 변환.

export function r2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

function d10(v) { if (!v) return null; if (v instanceof Date) return v.toISOString().slice(0, 10); return String(v).slice(0, 10); }

// 한 인보이스의 미수/연체 상태.
//  inv: { total, paid, due_date }, todayStr: 'YYYY-MM-DD'
//  반환: { total, paid, outstanding, open, overdue, overdue_days, days_to_due }
export function arInvoiceStatus(inv, todayStr) {
  const total = r2(Number(inv.total) || 0);
  const paid = r2(Number(inv.paid) || 0);
  const outstanding = r2(total - paid);
  const open = outstanding > 0.005;
  const due = d10(inv.due_date);
  let overdue = false, overdue_days = null, days_to_due = null;
  if (due && todayStr) {
    const diff = Math.round((Date.parse(due + 'T00:00:00Z') - Date.parse(todayStr + 'T00:00:00Z')) / 86400000);
    // diff = 만기 − 오늘 (음수=이미 지남)
    if (open) {
      if (diff < 0) { overdue = true; overdue_days = -diff; }
      else { days_to_due = diff; } // D-n (만기까지 남은 일, 0=오늘 만기)
    }
  }
  return { total, paid, outstanding, open, overdue, overdue_days, days_to_due };
}

// 미수(open) 인보이스를 만기월(due_date 'YYYY-MM')로 버킷. 최신 만기월 먼저.
//  invoices: [{ due_date, outstanding, overdue }]
//  반환: [{ ym, count, outstanding, overdue }]   (overdue = 그 달의 연체 미수액 합)
export function bucketByDueMonth(invoices) {
  const map = {};
  for (const inv of invoices) {
    const due = d10(inv.due_date);
    const ym = due ? due.slice(0, 7) : '미정';
    if (!map[ym]) map[ym] = { ym, count: 0, outstanding: 0, overdue: 0 };
    const o = Number(inv.outstanding) || 0;
    map[ym].count += 1;
    map[ym].outstanding = r2(map[ym].outstanding + o);
    if (inv.overdue) map[ym].overdue = r2(map[ym].overdue + o);
  }
  return Object.values(map).sort((a, b) => (a.ym < b.ym ? 1 : a.ym > b.ym ? -1 : 0));
}

// 오픈 인보이스 요약(건수·총 미수·연체 미수).
export function arSummary(openInvoices) {
  return openInvoices.reduce((s, v) => {
    const o = Number(v.outstanding) || 0;
    s.open_count += 1; s.outstanding = r2(s.outstanding + o);
    if (v.overdue) s.overdue = r2(s.overdue + o);
    return s;
  }, { open_count: 0, outstanding: 0, overdue: 0 });
}
