// =====================================================================
// Refatrix ERP · productStatus.js
// 제품(SKU) 활성/비활성 — "이 SKU 가 지금 무엇에 걸려 있나" 조회.
//
// 비활성 = 신규 사용 차단(견적 라인 추가·오퍼시트 생성 등). 과거 기록은 불변 —
// 매출·매출총이익(P&L)·원가 내역은 비활성 이후에도 그대로 보인다.
//
// 여기서 모으는 "미결 항목"의 기준은 각 화면이 이미 쓰는 기준과 동일하게 맞췄다
// (견적 open = draft/confirmed, backorder = v_backorder 조건, 미수금 = pendingItems.js 식 등).
// 새 판단 기준을 만들지 않는다 — 화면끼리 숫자가 어긋나면 안 되므로.
// =====================================================================
import { query } from './db.js';

const n = (v) => (v == null ? 0 : Number(v));
const PARTY_PURCHASE = '(구매·발주)';
const PARTY_INBOUND = '(수입·입고)';
const PARTY_INTERNAL = '(사내)';
const PARTY_NONE = '(고객 미지정)';

// 견적 1건의 진행 단계 — quotes 의 시각 컬럼으로 결정(quoteStage 화면과 같은 순서).
function quoteStage(r) {
  if (r.shipped_at) return '출고완료·인보이스 대기';
  if (r.packed_at) return '포장완료·출고 대기';
  if (r.packing_printed_at) return '포장 진행중';
  if (r.status === 'confirmed') return '수주확정';
  return '견적';
}

// 버킷 정의(표시 순서 = 업무 흐름 순서).
// info:true 인 버킷은 "미결 건수"에 세지 않고 참고 정보로만 보여준다.
export const BUCKETS = [
  { key: 'quote', label: '견적·수주확정·포장' },
  { key: 'invoice', label: '인보이스 미결(승인대기·SAT 미발행)' },
  { key: 'ar', label: '수금 미완(미수금)' },
  { key: 'shortage', label: '부족분 미해소' },
  { key: 'offer', label: '오퍼시트 진행중' },
  { key: 'devreq', label: '제품개발요청 진행중' },
  { key: 'po', label: '발주 미입고(Backorder)' },
  { key: 'inbound', label: '수입 입고 진행중' },
  { key: 'batch', label: '수입원가 미승인' },
  { key: 'stock', label: '보유 재고', info: true },
];
const BUCKET_LABEL = Object.fromEntries(BUCKETS.map((b) => [b.key, b.label]));
const BUCKET_INFO = new Set(BUCKETS.filter((b) => b.info).map((b) => b.key));

// ---------------------------------------------------------------------
// 한 SKU 의 미결 항목 전체 — 버킷별 + 업체별 두 가지 형태로 반환.
// exec 는 트랜잭션 client.query 를 넣을 수 있게 주입식.
// ---------------------------------------------------------------------
export async function productOpenItems(productId, exec = query) {
  const id = Number(productId);
  const rows = [];
  const push = (bucket, party, o) => {
    rows.push({
      bucket,
      bucket_label: BUCKET_LABEL[bucket] || bucket,
      info: BUCKET_INFO.has(bucket),
      party: String(party || '').trim() || PARTY_NONE,
      ...o,
    });
  };

  // ① 견적 / 수주확정 / 포장 / 출고 — 미결(draft·confirmed) 견적에 이 SKU 가 담긴 것.
  //    quoteRoutes 의 open 기준(status IN ('draft','confirmed') AND deleted_at IS NULL)과 동일.
  const q1 = (await exec(
    `SELECT q.id, q.quote_no, q.status, q.quote_date::text AS quote_date, q.reserve_expires_at,
            q.packing_printed_at, q.packed_at, q.shipped_at, q.invoice_id,
            COALESCE(NULLIF(cu.name,''), NULLIF(q.guest_name,'')) AS party,
            SUM(ql.qty) AS qty, SUM(ql.reserved_qty) AS reserved_qty
       FROM quote_lines ql
       JOIN quotes q ON q.id = ql.quote_id
       LEFT JOIN customers cu ON cu.id = q.customer_id
      WHERE ql.product_id = $1
        AND q.deleted_at IS NULL
        AND q.status IN ('draft','confirmed')
      GROUP BY q.id, cu.name
      ORDER BY q.quote_date DESC NULLS LAST, q.id DESC`, [id])).rows;
  for (const r of q1) {
    push('quote', r.party, {
      ref: r.quote_no || `Q#${r.id}`,
      ref_id: Number(r.id),
      stage: quoteStage(r),
      qty: n(r.qty),
      reserved_qty: n(r.reserved_qty),
      date: r.quote_date ? String(r.quote_date).slice(0, 10) : null,
      link: 'refatrix-quotelist.html',
    });
  }

  // ② 인보이스 미결 — 수정/삭제 승인대기 또는 SAT 번호 미발행(TMP-).
  const q2 = (await exec(
    `SELECT si.id, si.sat_no, si.inv_date::text AS inv_date, si.status, si.total_mxn,
            cu.name AS party, SUM(sil.qty) AS qty
       FROM sales_invoice_lines sil
       JOIN sales_invoices si ON si.id = sil.invoice_id
       LEFT JOIN customers cu ON cu.id = si.customer_id
      WHERE sil.product_id = $1
        AND si.deleted_at IS NULL AND si.status <> 'deleted'
        AND (si.status IN ('edit_pending','delete_pending')
             OR si.sat_no IS NULL OR si.sat_no = '' OR si.sat_no LIKE 'TMP-%')
      GROUP BY si.id, cu.name
      ORDER BY si.inv_date DESC NULLS LAST, si.id DESC`, [id])).rows;
  for (const r of q2) {
    const pend = r.status === 'edit_pending' ? '수정 승인대기'
      : r.status === 'delete_pending' ? '삭제 승인대기' : 'SAT 미발행';
    push('invoice', r.party, {
      ref: r.sat_no || `INV#${r.id}`,
      ref_id: Number(r.id),
      stage: pend,
      qty: n(r.qty),
      amount: n(r.total_mxn),
      date: r.inv_date ? String(r.inv_date).slice(0, 10) : null,
      link: 'refatrix-sales.html',
    });
  }

  // ③ 수금 미완 — pendingItems.js 의 미수 판정식과 동일(총액 − 배분입금 > 0.005).
  //    기일 도래 여부와 무관하게 "아직 돈이 안 들어온 인보이스" 전부.
  const q3 = (await exec(
    `SELECT si.id, si.sat_no, si.inv_date::text AS inv_date, si.due_date::text AS due_date, si.total_mxn,
            COALESCE(pa.paid,0) AS paid, cu.name AS party, SUM(sil.qty) AS qty
       FROM sales_invoice_lines sil
       JOIN sales_invoices si ON si.id = sil.invoice_id
       LEFT JOIN customers cu ON cu.id = si.customer_id
       LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid
                    FROM sales_payment_allocations GROUP BY invoice_id) pa
              ON pa.invoice_id = si.id
      WHERE sil.product_id = $1
        AND si.deleted_at IS NULL AND si.status <> 'deleted'
        AND COALESCE(pa.paid,0) < si.total_mxn - 0.005
      GROUP BY si.id, cu.name, pa.paid
      ORDER BY si.due_date ASC NULLS LAST, si.id`, [id])).rows;
  for (const r of q3) {
    push('ar', r.party, {
      ref: r.sat_no || `INV#${r.id}`,
      ref_id: Number(r.id),
      stage: '미수',
      qty: n(r.qty),
      amount: Math.round((n(r.total_mxn) - n(r.paid)) * 100) / 100,
      date: r.due_date ? String(r.due_date).slice(0, 10) : (r.inv_date ? String(r.inv_date).slice(0, 10) : null),
      link: 'refatrix-finance.html',
    });
  }

  // ④ 부족분 미해소 — 0156 이후 잔량(shortage_qty − resolved_qty) 기준.
  const q4 = (await exec(
    `SELECT sh.id, sh.occurred_at::text AS occurred_at, sh.shortage_qty, sh.resolved_qty, cu.name AS party
       FROM stock_shortages sh
       LEFT JOIN customers cu ON cu.id = sh.customer_id
      WHERE sh.product_id = $1 AND sh.status = 'open'
        AND (sh.shortage_qty - COALESCE(sh.resolved_qty,0)) > 0
      ORDER BY sh.occurred_at DESC, sh.id DESC`, [id])).rows;
  for (const r of q4) {
    push('shortage', r.party, {
      ref: `부족 #${r.id}`,
      ref_id: Number(r.id),
      stage: '미해소',
      qty: n(r.shortage_qty) - n(r.resolved_qty),
      date: r.occurred_at ? String(r.occurred_at).slice(0, 10) : null,
      link: 'refatrix-shortage.html',
    });
  }

  // ⑤ 오퍼시트 — 취소가 아닌 시트(생성됨/발송됨)에 이 SKU 가 담긴 것.
  //    비활성(중단)된 시트는 이력에서 숨기지 않고 '중단' 으로 표시한다(무슨 일이 있었는지 보이게).
  const q5 = (await exec(
    `SELECT os.id, os.offer_no, os.status, os.disabled_at, os.created_at::date::text AS created_at, os.sent_at,
            cu.name AS party, SUM(oi.offer_qty) AS qty
       FROM offer_sheet_items oi
       JOIN offer_sheets os ON os.id = oi.offer_sheet_id
       LEFT JOIN customers cu ON cu.id = os.customer_id
      WHERE oi.product_id = $1 AND os.deleted_at IS NULL AND os.status <> 'cancelled'
      GROUP BY os.id, cu.name
      ORDER BY os.created_at DESC`, [id])).rows;
  for (const r of q5) {
    push('offer', r.party, {
      ref: r.offer_no || `OS#${r.id}`,
      ref_id: Number(r.id),
      stage: r.disabled_at ? '중단(비활성)' : (r.status === 'sent' ? '발송됨' : '발송 대기'),
      qty: n(r.qty),
      date: r.created_at ? String(r.created_at).slice(0, 10) : null,
      link: 'refatrix-shortage.html',
    });
  }

  // ⑥ 제품개발요청 — 이 SKU 로 연결된 진행중 요청(devRequestRoutes 의 진행중 기준과 동일).
  const q6 = (await exec(
    `SELECT d.id, d.input_code, d.status, d.requested_at::text AS requested_at, d.requested_qty, cu.name AS party
       FROM product_dev_requests d
       LEFT JOIN customers cu ON cu.id = d.customer_id
      WHERE d.result_product_id = $1 AND d.deleted_at IS NULL
        AND d.status IN ('received','reviewed','factory_requested')
      ORDER BY d.requested_at DESC, d.id DESC`, [id])).rows;
  const DEV_LABEL = { received: '오더 접수', reviewed: '검토완료', factory_requested: '공장 개발요청' };
  for (const r of q6) {
    push('devreq', r.party, {
      ref: r.input_code || `DEV#${r.id}`,
      ref_id: Number(r.id),
      stage: DEV_LABEL[r.status] || r.status,
      qty: n(r.requested_qty),
      date: r.requested_at ? String(r.requested_at).slice(0, 10) : null,
      link: 'refatrix-devrequest.html',
    });
  }

  // ⑦ 발주 미입고 — v_backorder 와 동일 조건(취소·삭제 PO 제외, 잔량 > 0).
  const q7 = (await exec(
    `SELECT po.id, po.ref_no, po.order_date::text AS order_date, po.status,
            SUM(l.qty - l.received_qty) AS remain
       FROM purchase_order_lines l
       JOIN purchase_orders po ON po.id = l.po_id
      WHERE l.product_id = $1 AND po.deleted_at IS NULL AND po.status <> 'cancelled'
        AND (l.qty - l.received_qty) > 0
      GROUP BY po.id
      ORDER BY po.order_date ASC NULLS LAST, po.id`, [id])).rows;
  for (const r of q7) {
    push('po', PARTY_PURCHASE, {
      ref: r.ref_no || `PO#${r.id}`,
      ref_id: Number(r.id),
      stage: r.status === 'shipped' ? '선적됨·미입고' : '발주·미입고',
      qty: n(r.remain),
      date: r.order_date ? String(r.order_date).slice(0, 10) : null,
      link: 'refatrix-purchase.html',
    });
  }

  // ⑧ 수입 입고 진행중 — v_incoming_stock 과 동일 조건(incoming·receiving).
  const q8 = (await exec(
    `SELECT s.id, s.invoice_no, s.eta::text AS eta, s.status, SUM(pi.qty) AS qty
       FROM inbound_pallet_items pi
       JOIN inbound_shipments s ON s.id = pi.shipment_id
      WHERE pi.product_id = $1 AND s.deleted_at IS NULL
        AND s.status IN ('incoming','receiving')
      GROUP BY s.id
      ORDER BY s.eta ASC NULLS LAST, s.id`, [id])).rows;
  for (const r of q8) {
    push('inbound', PARTY_INBOUND, {
      ref: r.invoice_no || `SHP#${r.id}`,
      ref_id: Number(r.id),
      stage: r.status === 'receiving' ? '하차·검수중' : '입항 대기',
      qty: n(r.qty),
      date: r.eta ? String(r.eta).slice(0, 10) : null,
      link: 'refatrix-inbound.html',
    });
  }

  // ⑨ 수입원가 미승인 배치 — 승인 전이라 평균원가·재고에 아직 반영 전.
  const q9 = (await exec(
    `SELECT b.id, b.batch_no, b.import_date::text AS import_date, b.status, SUM(il.qty) AS qty
       FROM import_lines il
       JOIN import_batches b ON b.id = il.batch_id
      WHERE il.product_id = $1 AND b.deleted_at IS NULL
        AND b.status IN ('draft','pending')
      GROUP BY b.id
      ORDER BY b.import_date ASC NULLS LAST, b.id`, [id])).rows;
  for (const r of q9) {
    push('batch', PARTY_INBOUND, {
      ref: r.batch_no || `BAT#${r.id}`,
      ref_id: Number(r.id),
      stage: r.status === 'pending' ? '승인 대기' : '작성중',
      qty: n(r.qty),
      date: r.import_date ? String(r.import_date).slice(0, 10) : null,
      link: 'refatrix-import.html',
    });
  }

  // ⑩ 보유 재고(참고) — 미결 건수에는 안 세지만 판매중단/재개 판단에 필요.
  const pr = (await exec(
    `SELECT p.id, p.code, p.name, p.stock_qty, p.is_active, p.inactive_reason,
            p.status_changed_at::text AS status_changed_at, COALESCE(ps.qty,0) AS prestock_qty
       FROM products p
       LEFT JOIN inbound_prestock ps ON ps.product_id = p.id
      WHERE p.id = $1 AND p.deleted_at IS NULL`, [id])).rows[0];
  if (!pr) return null;
  if (n(pr.stock_qty) !== 0) {
    push('stock', PARTY_INTERNAL, {
      ref: '창고 재고', ref_id: null, stage: '보유중', qty: n(pr.stock_qty),
      date: null, link: 'refatrix-stock.html',
    });
  }
  if (n(pr.prestock_qty) > 0) {
    push('stock', PARTY_INTERNAL, {
      ref: '입고 마감분(원가 승인 전)', ref_id: null, stage: '가등록', qty: n(pr.prestock_qty),
      date: null, link: 'refatrix-import.html',
    });
  }

  // ── 집계 ──────────────────────────────────────────────────────────
  const summary = {};
  for (const b of BUCKETS) summary[b.key] = { label: b.label, info: !!b.info, n: 0, qty: 0 };
  for (const r of rows) { summary[r.bucket].n += 1; summary[r.bucket].qty += n(r.qty); }
  const openTotal = rows.filter((r) => !r.info).length;

  // 업체별 그룹 — "각 업체별로 항목을 정리해서 본다"는 요구가 이 형태.
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.party)) map.set(r.party, []);
    map.get(r.party).push(r);
  }
  const parties = [...map.entries()].map(([party, items]) => ({
    party,
    n: items.filter((x) => !x.info).length,
    info_n: items.filter((x) => x.info).length,
    items,
  })).sort((a, b) => (b.n - a.n) || a.party.localeCompare(b.party, 'ko'));

  return {
    product: {
      id: Number(pr.id), code: pr.code, name: pr.name,
      stock_qty: n(pr.stock_qty), is_active: pr.is_active !== false,
      inactive_reason: pr.inactive_reason || null,
      status_changed_at: pr.status_changed_at || null,
    },
    rows, parties, summary, open_total: openTotal,
    buckets: BUCKETS,
  };
}
