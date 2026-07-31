// /api/purchases/incoming · /api/shortages/by-customer-month · by-sku 쿼리 실행 테스트
import pg from 'pg';
const pool = new pg.Pool({ connectionString: 'postgres://tester:tester@localhost:5432/refatest' });
const query = (t, p) => pool.query(t, p);
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ✅', n); } else { fail++; console.log('  ❌', n); } };

async function main() {
  // ① incoming: 선적 헤더
  const ships = (await query(
    `SELECT s.id, s.invoice_no, s.eta, s.status, s.note, s.created_at,
            COUNT(DISTINCT COALESCE(pr.code, pi.input_code)) FILTER (WHERE pi.id IS NOT NULL)::int AS sku_count,
            COALESCE(SUM(pi.qty),0)      AS total_qty,
            COALESCE(SUM(pi.cartons),0)  AS cartons,
            (SELECT COALESCE(array_agg(DISTINCT ip.order_no), '{}') FROM inbound_pallets ip WHERE ip.shipment_id=s.id) AS refs
       FROM inbound_shipments s
       LEFT JOIN inbound_pallet_items pi ON pi.shipment_id=s.id
       LEFT JOIN products pr ON pr.id=pi.product_id
      WHERE s.deleted_at IS NULL AND s.status IN ('incoming','receiving')
      GROUP BY s.id
      ORDER BY s.eta ASC NULLS LAST, s.id ASC`)).rows;
  ok(ships.length === 1 && Number(ships[0].total_qty) === 100 && ships[0].sku_count === 2, `선적 요약: 1건·2SKU·100개 (got ${ships.length}/${ships[0]?.sku_count}/${ships[0]?.total_qty})`);
  ok(ships[0].refs.includes('PO-2607-01'), `PO 참조 연결 (${ships[0].refs})`);

  // ② incoming: 선적별 SKU 라인
  const lines = (await query(
    `SELECT pi.shipment_id, COALESCE(pr.code, pi.input_code) AS sku, pr.name AS product_name,
            (pi.product_id IS NOT NULL) AS matched, pr.stock_qty,
            SUM(pi.qty) AS qty, SUM(pi.cartons)::int AS cartons
       FROM inbound_pallet_items pi
       JOIN inbound_shipments s ON s.id=pi.shipment_id
       LEFT JOIN products pr ON pr.id=pi.product_id
      WHERE s.deleted_at IS NULL AND s.status IN ('incoming','receiving')
      GROUP BY pi.shipment_id, COALESCE(pr.code, pi.input_code), pr.name, pi.product_id IS NOT NULL, pr.stock_qty
      ORDER BY sku`)).rows;
  ok(lines.length === 2 && Number(lines.find((l) => l.sku === 'CA0001').qty) === 80, 'SKU 드릴다운 라인 2건 (CA0001=80)');

  // ③ incoming: 미선적 잔량 = 발주 backorder(130+50) − 선적중(80+20) → CA0001: 130-80=50, CB0002: 50-20=30
  const unshipped = (await query(
    `WITH bo AS (
       SELECT l.product_id, SUM(l.qty - l.received_qty) AS backorder,
              MIN(p.order_date) AS first_order,
              array_agg(DISTINCT p.ref_no) AS refs
         FROM purchase_order_lines l
         JOIN purchase_orders p ON p.id=l.po_id
        WHERE p.deleted_at IS NULL AND p.status <> 'cancelled'
          AND l.product_id IS NOT NULL AND (l.qty - l.received_qty) > 0
        GROUP BY l.product_id),
     inc AS (
       SELECT pi.product_id, SUM(pi.qty) AS qty
         FROM inbound_pallet_items pi
         JOIN inbound_shipments s ON s.id=pi.shipment_id
        WHERE s.deleted_at IS NULL AND s.status IN ('incoming','receiving')
          AND pi.product_id IS NOT NULL
        GROUP BY pi.product_id)
     SELECT bo.product_id, pr.code AS sku, pr.name AS product_name, pr.stock_qty,
            bo.backorder, COALESCE(inc.qty,0) AS incoming_qty,
            GREATEST(bo.backorder - COALESCE(inc.qty,0), 0) AS unshipped_qty,
            bo.first_order, bo.refs
       FROM bo
       LEFT JOIN inc ON inc.product_id=bo.product_id
       JOIN products pr ON pr.id=bo.product_id
      WHERE bo.backorder - COALESCE(inc.qty,0) > 0
      ORDER BY unshipped_qty DESC, sku`)).rows;
  const ca = unshipped.find((u) => u.sku === 'CA0001'); const cb = unshipped.find((u) => u.sku === 'CB0002');
  ok(Number(ca?.unshipped_qty) === 50 && Number(cb?.unshipped_qty) === 30, `미선적 잔량 CA=50, CB=30 (got ${ca?.unshipped_qty}/${cb?.unshipped_qty})`);
  ok(ca.refs.length === 2, `CA0001 미선적: PO 2건 참조 (${ca.refs})`);

  // ④ by-customer-month 매트릭스 (해소 반영)
  const cm = (await query(
    `SELECT sh.customer_id, COALESCE(c.name,'(고객미상)') AS customer_name, c.code AS customer_code,
            to_char(sh.occurred_at,'YYYY-MM') AS ym,
            SUM(sh.shortage_qty)::numeric                    AS occurred_qty,
            SUM(sh.resolved_qty)::numeric                    AS resolved_qty,
            SUM(sh.shortage_qty - sh.resolved_qty)::numeric  AS remaining_qty,
            SUM(sh.shortage_amount_mxn)::numeric             AS occurred_amount_mxn,
            SUM(CASE WHEN sh.shortage_qty > 0
                     THEN sh.shortage_amount_mxn * (sh.shortage_qty - sh.resolved_qty) / sh.shortage_qty
                     ELSE 0 END)::numeric                    AS remaining_amount_mxn,
            COUNT(*)::int AS cnt
       FROM stock_shortages sh
       LEFT JOIN customers c ON c.id=sh.customer_id
      WHERE sh.status <> 'cancelled'
        AND to_char(sh.occurred_at,'YYYY') = $1
      GROUP BY sh.customer_id, c.name, c.code, to_char(sh.occurred_at,'YYYY-MM')
      ORDER BY customer_name, ym`, ['2026'])).rows;
  const may = cm.find((r) => r.ym === '2026-05' && Number(r.customer_id) === 1);
  ok(may && Number(may.occurred_qty) === 10 && Number(may.resolved_qty) === 10 && Number(may.remaining_qty) === 0,
    `고객1 5월: 발생10·해소10·잔여0 (got ${may?.occurred_qty}/${may?.resolved_qty}/${may?.remaining_qty})`);
  const jun = cm.find((r) => r.ym === '2026-06' && Number(r.customer_id) === 1);
  ok(jun && Number(jun.remaining_qty) === 10, `고객1 6월: 잔여 10 (5-2해소 + 7미해소) (got ${jun?.remaining_qty})`);

  // ⑤ by-sku (잔여 기준)
  const bySku = (await query(
    `SELECT sh.product_id, p.code AS ctr_code, p.name AS product_name, p.stock_qty,
            SUM(sh.shortage_qty - sh.resolved_qty)::numeric AS total_shortage,
            SUM(CASE WHEN sh.shortage_qty > 0
                     THEN sh.shortage_amount_mxn * (sh.shortage_qty - sh.resolved_qty) / sh.shortage_qty
                     ELSE 0 END)::numeric AS total_amount_mxn,
            COUNT(*)::int AS cnt,
            MIN(sh.occurred_at) AS first_at, MAX(sh.occurred_at) AS last_at
       FROM stock_shortages sh JOIN products p ON p.id=sh.product_id
      WHERE sh.status='open' AND (sh.shortage_qty - sh.resolved_qty) > 0
      GROUP BY sh.product_id, p.code, p.name, p.stock_qty
      ORDER BY total_shortage DESC`)).rows;
  ok(bySku.every((r) => Number(r.total_shortage) > 0), 'by-sku: 잔여>0만 노출');
  const skuA = bySku.find((r) => r.ctr_code === 'CA0001');
  ok(skuA && Number(skuA.total_shortage) === 3.5, `CA0001 잔여 합 3.5 (s2잔여3 + s5잔여0.5) (got ${skuA?.total_shortage})`);

  // ⑥ 요약 카드 쿼리
  const sm = (await query(
    `SELECT
       COUNT(DISTINCT product_id) FILTER (WHERE status='open' AND shortage_qty - resolved_qty > 0)::int AS open_sku,
       COALESCE(SUM(shortage_qty - resolved_qty) FILTER (WHERE status='open'),0)::numeric AS open_qty,
       COUNT(DISTINCT product_id) FILTER (WHERE resolved_qty > 0 AND status <> 'cancelled')::int AS ordered_sku,
       COALESCE(SUM(resolved_qty) FILTER (WHERE status <> 'cancelled'),0)::numeric AS ordered_qty
     FROM stock_shortages`)).rows[0];
  ok(Number(sm.ordered_qty) === 12.75, `해소 누적 12.75 (10+2+0.75) (got ${sm.ordered_qty})`);

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
