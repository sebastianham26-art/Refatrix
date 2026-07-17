// build cs-20260717a
// 고객별 누적 판매(전체 누적) 공용 모듈
//   · 현장재고조사 「기존 판매품목 점검」 체크리스트
//   · 견적(수주관리) 「이 고객 누적 구매 품목」 사이드패널
//   두 화면이 같은 숫자를 쓰도록 집계·정렬·소진계산을 여기 한 곳에 둔다.
//
// 기준(디렉터 확정 2026-07-17):
//   · 기간   = 전체 누적 (기간 토글 없음)
//   · 소스   = 게시(status='posted') · 미삭제(deleted_at IS NULL) 인보이스 라인  ← 제품목록 sold_qty 와 동일 정의
//   · 기본   = 누적수량 상위 30개, 「전체 보기」 시 전량
//   · 소진량 = 누적판매(A) − 현장재고(B), 항상 전체 누적 기준(직전 조사 대비 아님)
import { query } from './db.js';

export const SOLD_DEFAULT_LIMIT = 30;

// node-pg 는 BIGINT/NUMERIC 을 문자열로 반환 → 전부 Number() 정규화
const num = (v) => (v == null ? null : Number(v));
const d10 = (d) => (!d ? null : (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)));

export function soldRow(r) {
  const sold = Number(r.sold_qty) || 0;
  const days = Number(r.order_days) || 0;
  return {
    product_id: Number(r.product_id),
    ctr_code: r.ctr_code,
    scode: r.scode || null,
    name: r.name || null,
    app: r.app || null,
    stock_qty: num(r.stock_qty),
    sold_qty: sold,
    last_sold_at: d10(r.last_sold_at),
    order_days: days,
    // 평균 주문수량 = 누적수량 ÷ 주문일수 (견적 사이드패널 「+ 추가」 기본 수량 제안)
    avg_order_qty: days > 0 ? Math.max(1, Math.round(sold / days)) : Math.max(1, Math.round(sold)),
  };
}

// ── 고객 누적 판매 목록 ───────────────────────────────────────────────
//  opts: { all:boolean, q:string, limit:number }
//  반환: { items, total, shown, all }   total = 이 고객이 산 SKU 총 종수(검색 조건 반영)
export async function customerSoldItems(customerId, opts = {}, exec = query) {
  const cid = Number(customerId);
  if (!cid) return { items: [], total: 0, shown: 0, all: false };
  const all = !!opts.all;
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : SOLD_DEFAULT_LIMIT;
  const q = String(opts.q == null ? '' : opts.q).trim();

  const params = [cid];
  let search = '';
  if (q) {
    params.push(`%${q}%`);
    const n = params.length;
    search = ` AND (p.code ILIKE $${n} OR p.scode ILIKE $${n} OR p.name ILIKE $${n} OR p.app ILIKE $${n})`;
  }
  const base = `FROM sales_invoice_lines sil
                JOIN sales_invoices si ON si.id = sil.invoice_id
                JOIN products p ON p.id = sil.product_id AND p.deleted_at IS NULL
               WHERE si.customer_id = $1 AND si.status = 'posted' AND si.deleted_at IS NULL${search}`;

  const tr = (await exec(`SELECT COUNT(*) AS n FROM (
                            SELECT sil.product_id ${base} GROUP BY sil.product_id
                          ) t`, params)).rows[0];
  const total = Number(tr && tr.n) || 0;

  const sel = `SELECT p.id AS product_id, p.code AS ctr_code, p.scode, p.name, p.app, p.stock_qty,
                      SUM(sil.qty) AS sold_qty,
                      MAX(si.inv_date) AS last_sold_at,
                      COUNT(DISTINCT si.inv_date) AS order_days
                 ${base}
                 GROUP BY p.id, p.code, p.scode, p.name, p.app, p.stock_qty
                 ORDER BY SUM(sil.qty) DESC, p.code`;
  const rows = all
    ? (await exec(sel, params)).rows
    : (await exec(`${sel} LIMIT $${params.length + 1}`, params.concat([limit]))).rows;

  return { items: rows.map(soldRow), total, shown: rows.length, all };
}

// ── 단일 SKU 누적판매 스냅샷 (조사 줄 저장/완료 시 동결) ──────────────
export async function soldSnapFor(customerId, productId, exec = query) {
  const cid = Number(customerId), pid = Number(productId);
  if (!cid || !pid) return { sold: null, last: null };
  const r = (await exec(
    `SELECT COALESCE(SUM(sil.qty),0) AS q, MAX(si.inv_date) AS last_sold_at
       FROM sales_invoice_lines sil
       JOIN sales_invoices si ON si.id = sil.invoice_id
      WHERE si.customer_id = $1 AND sil.product_id = $2
        AND si.status = 'posted' AND si.deleted_at IS NULL`, [cid, pid])).rows[0];
  return { sold: r ? Number(r.q) || 0 : 0, last: r ? d10(r.last_sold_at) : null };
}

// ── 이 고객이 구매한 SKU 총 종수 (미점검 건수 산출용) ─────────────────
export async function customerSoldSkuCount(customerId, exec = query) {
  const cid = Number(customerId);
  if (!cid) return 0;
  const r = (await exec(
    `SELECT COUNT(*) AS n FROM (
       SELECT sil.product_id
         FROM sales_invoice_lines sil
         JOIN sales_invoices si ON si.id = sil.invoice_id
         JOIN products p ON p.id = sil.product_id AND p.deleted_at IS NULL
        WHERE si.customer_id = $1 AND si.status = 'posted' AND si.deleted_at IS NULL
        GROUP BY sil.product_id
     ) t`, [cid])).rows[0];
  return Number(r && r.n) || 0;
}

// ── 소진 계산(순수 함수) ──────────────────────────────────────────────
//  A = 누적판매(우리 → 고객), B = 현장재고(고객 창고 실물 관측)
//  소진량 = A − B  = 고객창고에서 출고되어 엔드커스터머에게 팔린 수량
//  status: todo(미점검) / gone(완전소진 B=0) / partial(부분소진) / kept(미소진 A=B)
//          / anomaly(이상 — B>A, 타사 경로 구매 또는 조사 오차)
export function sellThrough(soldQty, observedQty) {
  const a = Number(soldQty) || 0;
  if (observedQty == null || observedQty === '') return { status: 'todo', sold_out: null, pct: null };
  const b = Number(observedQty) || 0;
  if (b > a) return { status: 'anomaly', sold_out: null, pct: null };
  const d = a - b;
  const pct = a > 0 ? Math.round((d / a) * 1000) / 10 : null;
  if (d === 0) return { status: 'kept', sold_out: 0, pct };
  return { status: b === 0 ? 'gone' : 'partial', sold_out: d, pct };
}

// ── 보충 제안 정렬(순수 함수): 소진율 내림차순 → 소진량 내림차순 → CTR ──
//  "몇 개가 고객창고에서 나갔는지 눈에 보이게" — 다 팔린 품목이 항상 맨 위.
export function replenishSort(rows) {
  return rows.slice().sort((x, y) => {
    const px = x.sell_pct == null ? -1 : Number(x.sell_pct);
    const py = y.sell_pct == null ? -1 : Number(y.sell_pct);
    if (py !== px) return py - px;
    const dx = Number(x.sold_out) || 0, dy = Number(y.sold_out) || 0;
    if (dy !== dx) return dy - dx;
    return String(x.ctr_code || '').localeCompare(String(y.ctr_code || ''));
  });
}
