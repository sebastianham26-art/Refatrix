// =====================================================================
// Refatrix ERP · reservations.js  (2026-09-30 · 디렉터 지시)
//   견적 재고예약 현황 — 「누가 · 언제 · 어떤 제품을 · 몇 개 · 어떤 견적으로 잡았고 · 언제 풀리나」
//
//   예약 규칙은 새로 만들지 않는다. 이미 돌고 있는 규칙을 **그대로 읽기만** 한다.
//     · 예약 수량      = quote_lines.reserved_qty (quoteBuild.assignReservations 가 선착순으로 배분)
//     · 살아 있는 예약 = status IN ('draft','confirmed') AND deleted_at IS NULL
//                        AND (reserve_expires_at > now() OR packing_printed_at IS NOT NULL)
//       ↳ 가용재고 계산(quoteBuild · finderRoutes · stockCountRoutes …)과 **한 글자도 다르지 않게**.
//         여기가 달라지면 「화면엔 예약 없음, 견적엔 가용 0」 같은 거짓말이 생긴다.
//     · 풀리는 시각    = reserve_expires_at (quoteExpiry.reserveExpiresAt — 근무시간 기산 + 24h)
//     · 포장지시서 인쇄(packing_printed_at) 후에는 **시간으로 풀리지 않는다** — 출고·매출전환까지 유지.
//
//   이 파일은 DB 를 모른다(순수 함수) — 시험에서 시각을 마음대로 넣어 볼 수 있게.
// =====================================================================
import { RESERVE_HOURS } from './quoteExpiry.js';

export const SOON_MIN = 120;          // 2시간 이내 해제 = 「곧 풀림」(빨강)
export const TODAY_MIN = 6 * 60;      // 6시간 이내 = 주의(노랑)
export const RELEASED_MAX_H = 168;    // 「최근 해제」 조회 상한(7일)

/** 이 SQL 조각이 「살아 있는 예약」의 정의다. alias q 기준. */
export const ACTIVE_RESERVATION_SQL =
  `q.status IN ('draft','confirmed') AND q.deleted_at IS NULL
   AND (q.reserve_expires_at > now() OR q.packing_printed_at IS NOT NULL)`;

const num = (v) => (v == null || v === '' ? 0 : Number(v) || 0);
const iso = (v) => {
  if (v == null || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d) ? null : d.toISOString();
};

/**
 * 예약 한 줄의 상태.
 *   hold     포장지시서 인쇄됨 — 시간으로 안 풀림(출고·전환까지)
 *   active   만료 전 — releases_at 에 풀림
 *   released 이미 풀림(만료)
 */
export function reservationState(row, now = new Date()) {
  const t = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (row.packing_printed_at) {
    return { state: 'hold', releases_at: null, remaining_min: null, urgency: 'hold' };
  }
  const exp = iso(row.reserve_expires_at);
  if (!exp) return { state: 'released', releases_at: null, remaining_min: null, urgency: 'released' };
  const left = Math.floor((new Date(exp).getTime() - t) / 60000);
  if (left <= 0 || row.status === 'expired') {
    return { state: 'released', releases_at: exp, remaining_min: Math.min(0, left), urgency: 'released' };
  }
  const urgency = left <= SOON_MIN ? 'soon' : left <= TODAY_MIN ? 'today' : 'later';
  return { state: 'active', releases_at: exp, remaining_min: left, urgency };
}

/**
 * 「누가」 예약했나.
 *   · 화면에서 만든 견적 → 작성자(users.name, 로그인ID)
 *   · 웹카달록(origin='crm') → 고객이 직접 넣은 것. 작성자가 없으니 「웹카달록」 + 지정된 담당자.
 */
export function reservedBy(row) {
  if (row.origin === 'crm') {
    return {
      kind: 'catalog',
      label: '웹카달록',
      sub: row.assignee_name ? `담당 ${row.assignee_name}` : '담당 미지정',
    };
  }
  const name = String(row.creator_name || '').trim();
  const lid = String(row.creator_login_id || '').trim();
  return { kind: 'user', label: name || lid || '(작성자 없음)', sub: name && lid ? lid : '' };
}

/** 24시간 카운트가 시작된 시각 — 만료시각 − 24h. 접수시각과 다르면 근무시간 밖 접수. */
export function reserveStart(row) {
  const exp = iso(row.reserve_expires_at);
  if (!exp) return null;
  return new Date(new Date(exp).getTime() - RESERVE_HOURS * 3600000).toISOString();
}

/** DB 행(견적 줄 1개) → 화면 행 */
export function shapeRow(row, now = new Date()) {
  const qty = num(row.qty);
  const reserved = num(row.reserved_qty);
  const sub = num(row.line_subtotal);
  const st = reservationState(row, now);
  const start = reserveStart(row);
  const created = iso(row.created_at);
  return {
    line_id: Number(row.line_id),
    quote_id: Number(row.quote_id),
    quote_no: row.quote_no || `Q#${row.quote_id}`,
    external_quote_no: row.external_quote_no || null,
    quote_status: row.status,
    origin: row.origin === 'crm' ? 'catalog' : 'internal',
    customer_id: row.customer_id != null ? Number(row.customer_id) : null,
    party_name: row.customer_id == null ? (row.guest_name || '불특정 고객') : (row.customer_name || '-'),
    by: reservedBy(row),
    reserved_at: created,                                        // 견적 접수(= 예약) 시각
    count_from: start,                                           // 24h 기산 시각
    offhours: !!(created && start && !row.packing_printed_at && Math.abs(new Date(start) - new Date(created)) > 60000),
    packing_printed_at: iso(row.packing_printed_at),
    product_id: Number(row.product_id),
    product_code: row.product_code || row.ctr_code || '',
    product_name: row.product_name || '',
    qty,
    reserved_qty: reserved,
    partial: reserved < qty,                                     // 요청보다 적게 잡힘(재고 부족분은 예약 안 됨)
    reserved_sub: qty > 0 ? Math.round((sub * reserved / qty) * 100) / 100 : 0,   // 예약분 금액(IVA 제외)
    ...st,
  };
}

/** 제품별 묶음 — 현재고 · 전체 예약(팀 구분 없이) · 가용 */
export function groupByProduct(items, stockRows = []) {
  const stock = new Map(stockRows.map((s) => [Number(s.product_id), s]));
  const by = new Map();
  for (const it of items) {
    let g = by.get(it.product_id);
    if (!g) {
      const s = stock.get(it.product_id) || {};
      const phys = num(s.stock_qty);
      const all = num(s.reserved_all);
      g = {
        product_id: it.product_id, product_code: it.product_code, product_name: it.product_name,
        stock_qty: phys, reserved_all: all, available: Math.max(0, phys - all),
        reserved_qty: 0, quotes: 0, next_release: null, items: [],
      };
      by.set(it.product_id, g);
    }
    g.items.push(it);
    g.reserved_qty += it.reserved_qty;
    g.quotes += 1;
    if (it.state === 'active' && it.releases_at && (!g.next_release || it.releases_at < g.next_release)) {
      g.next_release = it.releases_at;
    }
  }
  return [...by.values()].sort((a, b) => b.reserved_qty - a.reserved_qty || a.product_code.localeCompare(b.product_code));
}

/** 위 KPI 카드 */
export function summarize(items) {
  const quotes = new Set(); const skus = new Set();
  let qty = 0, sub = 0, soon = 0, hold = 0;
  const soonQuotes = new Set(), holdQuotes = new Set();
  for (const it of items) {
    quotes.add(it.quote_id); skus.add(it.product_id);
    qty += it.reserved_qty; sub += it.reserved_sub;
    if (it.urgency === 'soon') soonQuotes.add(it.quote_id);
    if (it.urgency === 'hold') holdQuotes.add(it.quote_id);
  }
  soon = soonQuotes.size; hold = holdQuotes.size;
  return { quotes: quotes.size, skus: skus.size, qty, sub: Math.round(sub * 100) / 100, soon_quotes: soon, hold_quotes: hold };
}

/** ?released= 파라미터 → 시간(0 = 안 봄, 상한 7일) */
export function releasedHours(v) {
  const h = Math.floor(Number(v));
  if (!Number.isFinite(h) || h <= 0) return 0;
  return Math.min(h, RELEASED_MAX_H);
}
