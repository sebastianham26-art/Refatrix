import { query } from '../db.js';
import { authGuard, requirePage } from '../middleware/authGuard.js';
import { bizMinutes } from '../businessHours.js';

// =====================================================================
// Refatrix ERP · warehouseRoutes.js  (창고 모듈)
//   출고-1a: 포장지시 목록(포장 대기) + 드릴다운(포장할 품목).
//   · 권한: 'warehouse' 페이지(창고담당) + 디렉터 바이패스.
//   · 읽기 전용 — 재고·매출·단계에 아무 영향 없음(격리).
//   · 포장 대기 = 포장지시서 출력됨(packing_printed_at) + 미전환(invoice 없음).
//   · 드릴다운 = 즉시재고(in_stock) 라인만 (부족/개발 제외 — 견적 convert-preview와 동일 기준).
//     라인 = 즉시충당(min(reserved_qty, 현재고) >= qty)인 것만. 컬럼: CTR·SYD·EAN-13·수량·랙.
// =====================================================================
export default async function warehouseRoutes(app) {
  const num = (v) => (v == null ? null : Number(v));
  // 현재가 업무시간인가(월~금 07:30~17:00, UTC-6) — 클라가 실시간 틱을 켤지 판단용
  function inBusinessNow() {
    const mx = new Date(Date.now() - 6 * 3600000); // MX 벽시계를 UTC 필드로
    const dow = mx.getUTCDay(); if (dow < 1 || dow > 5) return false;
    const m = mx.getUTCHours() * 60 + mx.getUTCMinutes();
    return m >= 450 && m < 1020; // 07:30 ~ 17:00
  }

  // ---------- 포장 대기 목록 (오더목록처럼) ----------
  app.get('/api/warehouse/packing-queue', { preHandler: [authGuard, requirePage('warehouse')] }, async () => {
    const rows = (await query(
      `SELECT q.id, q.quote_no, q.customer_id, q.guest_name,
              c.name AS customer_name,
              q.packing_printed_at, q.packing_due_at,
              q.total_qty, q.sku_count, q.total_mxn
         FROM quotes q
         LEFT JOIN customers c ON c.id = q.customer_id
        WHERE q.packing_printed_at IS NOT NULL
          AND q.invoice_id IS NULL
          AND q.status NOT IN ('converted','cancelled')
          AND q.deleted_at IS NULL
        ORDER BY q.packing_printed_at ASC, q.id ASC`)).rows;

    const now = new Date();
    const items = rows.map((r) => ({
      quote_id: Number(r.id),
      quote_no: r.quote_no || null,
      customer: r.customer_name || r.guest_name || '—',
      is_guest: r.customer_id == null,
      printed_at: r.packing_printed_at,
      due_at: r.packing_due_at,
      overdue: r.packing_due_at ? (now.getTime() > new Date(r.packing_due_at).getTime()) : false,
      elapsed_biz_sec: r.packing_printed_at ? Math.floor(bizMinutes(r.packing_printed_at, now) * 60) : 0,
      total_qty: num(r.total_qty),
      sku_count: r.sku_count != null ? Number(r.sku_count) : null,
    }));
    return { count: items.length, in_business: inBusinessNow(), items };
  });

  // ---------- 드릴다운: 포장할 품목 (즉시재고 라인만) ----------
  app.get('/api/warehouse/packing-queue/:id', { preHandler: [authGuard, requirePage('warehouse')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const q = (await query(
      `SELECT q.id, q.quote_no, q.customer_id, q.guest_name, c.name AS customer_name,
              q.packing_printed_at, q.packing_due_at, q.status, q.invoice_id
         FROM quotes q LEFT JOIN customers c ON c.id=q.customer_id
        WHERE q.id=$1 AND q.deleted_at IS NULL`, [id])).rows[0];
    if (!q) return reply.code(404).send({ error: 'not_found' });

    const lines = (await query(
      `SELECT l.line_no, l.ctr_code, l.syd_codes, l.qty, l.product_id, l.reserved_qty,
              p.ean, p.rack_location, p.scode, p.stock_qty
         FROM quote_lines l
         LEFT JOIN products p ON p.id = l.product_id
        WHERE l.quote_id = $1
        ORDER BY l.line_no, l.id`, [id])).rows;

    const items = [];
    let totalPieces = 0;
    for (const l of lines) {
      if (!l.product_id) continue;                       // 미등록(개발) 제외
      const qty = Number(l.qty) || 0;
      const physical = l.stock_qty != null ? Number(l.stock_qty) : 0;
      const fulfill = Math.max(0, Math.min(Number(l.reserved_qty) || 0, physical));
      if (fulfill < qty) continue;                        // 부족 라인 제외(즉시재고만)
      const syd = (l.syd_codes && String(l.syd_codes).trim()) || (l.scode && String(l.scode).trim()) || '';
      items.push({
        ctr_code: l.ctr_code || '',
        syd_code: syd,
        ean: l.ean || '',
        qty,
        rack_location: l.rack_location || '',
      });
      totalPieces += qty;
    }

    return {
      quote_id: Number(q.id),
      quote_no: q.quote_no || null,
      customer: q.customer_name || q.guest_name || '—',
      printed_at: q.packing_printed_at,
      due_at: q.packing_due_at,
      elapsed_biz_sec: q.packing_printed_at ? Math.floor(bizMinutes(q.packing_printed_at, new Date()) * 60) : 0,
      in_business: inBusinessNow(),
      sku_count: items.length,
      total_pieces: totalPieces,
      items,
    };
  });
}
