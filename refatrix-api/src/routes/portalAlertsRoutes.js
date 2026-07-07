import { query } from '../db.js';
import { authGuard } from '../middleware/authGuard.js';

// =====================================================================
// Refatrix ERP · portalAlertsRoutes.js  (포털 통합 알림 폴링)
//
//   목적: 포털 홈에서 각각 25초마다 돌던 3개의 폴링
//         (견적삭제 / 기기승인 / 포장완료)을 1개 엔드포인트로 통합.
//         → 디렉터 화면 기준 요청 건수 3분의 1, 폴링 주기 완화(프런트 120초)와
//           탭 숨김 시 정지까지 더해져 상시 DB 부하가 크게 줄어듭니다.
//
//   원칙(격리·무해): 읽기 전용. 재고·매출·단계에 아무 영향 없음.
//   기존 3개 엔드포인트(/api/quotes/delete-pending,
//   /api/devices/pending, /api/warehouse/sales/packing-ready)는 그대로 유지
//   (승인 직후 개별 새로고침·수동조회에서 계속 사용). 이 파일은 순수 집계용 미러.
//
//   역할별 반환:
//     · director        → delete + device + packing
//     · sales_support   → packing
//     · 그 외           → 모두 빈 배열
//   응답 형태(프런트가 기존 render 함수에 그대로 흘려보냄):
//     { delete:{items:[...]}, device:{items:[...]}, packing:{items:[...]} }
// =====================================================================

function d10(d) { if (!d) return null; if (d instanceof Date) return d.toISOString().slice(0, 10); return String(d).slice(0, 10); }

// ── 견적 삭제 대기 (원본: quoteRoutes.js /api/quotes/delete-pending 와 동일 SQL·매핑) ──
async function deletePendingItems() {
  const rows = (await query(
    `SELECT q.id, q.quote_no, q.quote_date, q.total_mxn, q.total_qty, q.sku_count, q.del_reason, q.del_requested_at,
            c.name AS customer_name, q.customer_id, q.guest_name, u.name AS requested_by_name
       FROM quotes q LEFT JOIN customers c ON c.id=q.customer_id LEFT JOIN users u ON u.id=q.del_requested_by
      WHERE q.status='delete_pending' AND q.deleted_at IS NULL
      ORDER BY q.del_requested_at DESC`)).rows;
  return rows.map((r) => ({
    id: r.id, quote_no: r.quote_no, quote_date: d10(r.quote_date),
    total_mxn: Number(r.total_mxn), total_qty: Number(r.total_qty), sku_count: r.sku_count,
    del_reason: r.del_reason, del_requested_at: r.del_requested_at ? d10(r.del_requested_at) : null,
    party_name: r.customer_id == null ? (r.guest_name || '불특정 고객') : r.customer_name,
    requested_by_name: r.requested_by_name,
  }));
}

// ── 기기 승인 대기 (원본: deviceRoutes.js /api/devices/pending 와 동일 SQL) ──
async function devicePendingItems() {
  const rows = (await query(
    `SELECT d.id, d.user_id, u.name, u.dept, d.label, d.created_at, d.last_seen
       FROM devices d JOIN users u ON u.id=d.user_id
      WHERE d.status='pending' ORDER BY d.created_at`)).rows;
  return rows; // 프런트 renderDevApprList 는 {id,name,dept,label} 사용
}

// ── 포장완료 대기 (원본: warehouseRoutes.js /api/warehouse/sales/packing-ready 와 동일 로직) ──
//   packableLines() 는 창고모듈 내부 헬퍼의 충실한 복제본입니다.
//   (창고 격리 원칙 상 상호 의존을 만들지 않기 위해 미러로 둠 — 로직 변경 시 두 곳 동기화)
async function packableLines(quoteId) {
  const rows = (await query(
    `SELECT l.line_no, l.ctr_code, l.syd_codes, l.qty, l.product_id, l.reserved_qty,
            p.ean, p.rack_location, p.scode, p.stock_qty
       FROM quote_lines l LEFT JOIN products p ON p.id=l.product_id
      WHERE l.quote_id=$1 ORDER BY l.line_no, l.id`, [quoteId])).rows;
  const out = [];
  for (const l of rows) {
    if (!l.product_id) continue;
    const qty = Number(l.qty) || 0;
    const physical = l.stock_qty != null ? Number(l.stock_qty) : 0;
    const fulfill = Math.max(0, Math.min(Number(l.reserved_qty) || 0, physical));
    if (fulfill < qty) continue;
    out.push({ product_id: Number(l.product_id), required: qty });
  }
  return out;
}

async function packingReadyItems() {
  const cands = (await query(
    `SELECT q.id, q.quote_no, q.total_mxn,
            COALESCE(c.name, q.guest_name, '\u2014') AS customer_name
       FROM quotes q LEFT JOIN customers c ON c.id=q.customer_id
      WHERE q.deleted_at IS NULL
        AND q.packing_printed_at IS NOT NULL
        AND q.status NOT IN ('converted','cancelled','expired','delete_pending')
        AND NOT EXISTS (SELECT 1 FROM quote_packing_docs pd WHERE pd.quote_id=q.id)
      ORDER BY q.packing_printed_at`)).rows;
  const out = [];
  for (const q of cands) {
    const lines = await packableLines(q.id);
    if (!lines.length) continue;
    const scanned = {};
    (await query(`SELECT product_id, SUM(qty)::int AS s FROM packing_box_line WHERE quote_id=$1 GROUP BY product_id`, [q.id]))
      .rows.forEach((r) => { scanned[Number(r.product_id)] = Number(r.s) || 0; });
    const complete = lines.every((l) => (scanned[l.product_id] || 0) >= l.required);
    if (!complete) continue;
    const boxes = (await query(`SELECT id FROM packing_box WHERE quote_id=$1`, [q.id])).rows;
    if (!boxes.length) continue;
    out.push({ quote_id: Number(q.id), quote_no: q.quote_no || ('#' + q.id), customer_name: q.customer_name,
               sku_count: lines.length, total_qty: lines.reduce((a, l) => a + l.required, 0),
               total_mxn: Number(q.total_mxn) || 0 });
  }
  return out;
}

// ── 마케팅 지출계획 수정 요청 대기(0124) — 담당자 변경 → 디렉터 반영 필요 ──
//    승인건에 담당자가 저장한 "수정 요청"(pending_revision). 디렉터가 수정안을
//    승인해야 자금계획(예정 지출)에 반영되므로 즉시 알림 대상.
//    0124 미적용(컬럼 없음) 배포 순서에도 안전하도록 전체를 try로 감쌈.
function r2a(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
async function mktRevisionItems() {
  try {
    const rows = (await query(
      `SELECT p.id, p.title, p.category, p.pending_revision, p.revision_at,
              rv.name AS revision_by_name,
              COALESCE(la.total_amount,0) AS current_total
         FROM marketing_spend_plans p
         LEFT JOIN users rv ON rv.id=p.revision_by
         LEFT JOIN (SELECT plan_id, COALESCE(SUM(amount),0) AS total_amount
                      FROM marketing_spend_lines GROUP BY plan_id) la ON la.plan_id=p.id
        WHERE p.pending_revision IS NOT NULL AND p.deleted_at IS NULL
        ORDER BY p.revision_at DESC NULLS LAST, p.id DESC`)).rows;
    return rows.map((r) => {
      // 수정안 총액: payload.items[].lines[].amount 합계(구조 이상 시 null)
      let revTotal = null;
      try {
        let rp = r.pending_revision;
        if (typeof rp === 'string') rp = JSON.parse(rp);
        if (rp && Array.isArray(rp.items)) {
          revTotal = 0;
          for (const it of rp.items) for (const l of (it.lines || [])) revTotal += Number(l.amount) || 0;
          revTotal = r2a(revTotal);
        }
      } catch (_) { revTotal = null; }
      return {
        id: Number(r.id), title: r.title, category: r.category,
        revision_at: r.revision_at ? new Date(r.revision_at).toISOString() : null,
        revision_by_name: r.revision_by_name || null,
        current_total: r2a(r.current_total),
        revision_total: revTotal,
      };
    });
  } catch (_) { return []; } // 0124 미적용 또는 테이블 미생성
}

export default async function portalAlertsRoutes(app) {
  // 통합 폴링: 포털 홈에서 120초마다 1회. 역할에 따라 필요한 것만 조회.
  app.get('/api/portal/alerts', { preHandler: [authGuard] }, async (req) => {
    const role = req.ctx.perm.role;
    const isDirector = role === 'director';
    const isSalesSupport = role === 'sales_support';

    const out = { delete: { items: [] }, device: { items: [] }, packing: { items: [] }, mktrev: { items: [] } };

    // 디렉터: 삭제 + 기기 (기존 checkDeleteApprovals/checkDeviceApprovals 가 디렉터 전용이었던 것과 동일)
    //         + 마케팅 지출계획 수정 요청(0124)
    if (isDirector) {
      out.delete.items = await deletePendingItems();
      out.device.items = await devicePendingItems();
      out.mktrev.items = await mktRevisionItems();
    }
    // 포장완료: 디렉터 또는 영업지원 (기존 __packAud 와 동일)
    if (isDirector || isSalesSupport) {
      out.packing.items = await packingReadyItems();
    }
    return out;
  });
}
