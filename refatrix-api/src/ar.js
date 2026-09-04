// 담당고객 오픈 인보이스(미수/연체) 계산 — 순수 함수(단위 테스트 가능)
// node-pg는 NUMERIC을 문자열로 반환하므로 모든 금액 Number() 변환.

export function r2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

// ── 완납(반제 완료) 판정 공통 허용치 ──────────────────────────────────────────
// 화면 금액은 toLocaleString(maximumFractionDigits:0) 으로 **정수 페소 반올림**해 보여준다.
// 그래서 판정 기준도 같은 눈금(0.5 페소 미만 = 화면상 0)에 맞춘다.
// 이 값보다 작게 남은 잔액은 IVA 16% 센타보 반올림 잔여이지 미수가 아니다.
// (2026-08-27 세션 결정 · 2026-09-02 현재 main 에 재적용)
export const AR_PAID_EPS = 0.5;
export function arIsPaid(outstanding) { return Number(outstanding || 0) < AR_PAID_EPS; }
export function arIsOpen(outstanding) { return !arIsPaid(outstanding); }

// ── 인보이스 「완납일」 조인 (2026-08-31 정의 · 2026-09-04 이 파일로 이동) ─────
//   잔액이 0이 된 날 = 마지막 반제일 이므로 배분들의 MAX(반제일)을 쓴다.
//   반제일: 현금 반제 → sales_payments.pay_date / NC(비현금) → notas_credito 적용·승인·작성일 순.
//   has_nc: NC 반제가 섞였으면 true — 현금 100%가 아님을 화면에서 「NC」 칩으로 드러내기 위함.
//   ※ 미수 인보이스에도 값이 들어온다(마지막 부분수금일). 완납 판정(AR_PAID_EPS)을 반드시 함께 볼 것.
//   원래 financeRoutes.js 에 있던 상수. 수금/정산 화면과 고객 화면이 **같은 정의**를 쓰도록
//   여기로 옮기고 양쪽에서 import 한다(정의가 갈라지면 두 화면 숫자가 어긋난다).
export const AR_SETTLED_SQL = `LEFT JOIN (
           SELECT al.invoice_id,
                  MAX(COALESCE(p.pay_date, nc.applied_at::date, nc.approved_at::date, nc.created_at::date)) AS settled_dt,
                  BOOL_OR(al.kind = 'nota_credito') AS has_nc
             FROM sales_payment_allocations al
             LEFT JOIN sales_payments p ON p.id = al.payment_id
             LEFT JOIN notas_credito nc ON nc.id = al.nc_id
            GROUP BY al.invoice_id
         )`;

function d10(v) { if (!v) return null; if (v instanceof Date) return v.toISOString().slice(0, 10); return String(v).slice(0, 10); }

// 한 인보이스의 미수/연체 상태.
//  inv: { total, paid, due_date }, todayStr: 'YYYY-MM-DD'
//  반환: { total, paid, outstanding, open, overdue, overdue_days, days_to_due }
export function arInvoiceStatus(inv, todayStr) {
  const total = r2(Number(inv.total) || 0);
  const paid = r2(Number(inv.paid) || 0);
  const outstanding = r2(total - paid);
  const open = arIsOpen(outstanding);
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

// 입금증(증빙) data URL 검증 — 순수 함수(단위 테스트 가능).
//  허용: image/*  또는 application/pdf, base64 인코딩만.
//  반환: { ok:true, mime, bytes } 또는 { ok:false, error }
export function validateReceiptDataUrl(dataUrl, maxBytes = 8 * 1024 * 1024) {
  if (typeof dataUrl !== 'string' || !dataUrl) return { ok: false, error: 'empty' };
  const m = dataUrl.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!m) return { ok: false, error: 'bad_format' };
  const mime = m[1].toLowerCase();
  if (!(mime.startsWith('image/') || mime === 'application/pdf')) return { ok: false, error: 'bad_mime' };
  const b64 = m[2].replace(/\s+/g, '');
  if (!b64) return { ok: false, error: 'empty_data' };
  const bytes = Math.floor((b64.length * 3) / 4);
  if (bytes > maxBytes) return { ok: false, error: 'too_large' };
  return { ok: true, mime, bytes };
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
